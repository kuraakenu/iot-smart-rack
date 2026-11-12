// =========================================================================
// SMART LOAD SAFETY - ESP32 (2 Lantai) + MQTT (EMQX Cloud TLS)
// =========================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <HX711.h>
#include <math.h>

// ===================== KONFIGURASI JARINGAN =====================
const char* WIFI_SSID  = "Wokwi-GUEST";
const char* WIFI_PASS  = "";

// ===================== KONFIGURASI MQTT (EMQX Cloud) =====================
const char* MQTT_HOST  = "md032d82.ala.asia-southeast1.emqxsl.com";
const int   MQTT_PORT  = 8883;
const char* MQTT_USER  = "smartrack";
const char* MQTT_PASS  = "1234";
const char* CLIENT_ID  = "esp32-smartrack";

// ===================== PIN HARDWARE =====================
#define PIN_BUZZER   23
#define PIN_BUTTON   21
#define LCD_SDA      26
#define LCD_SCL      25
#define LCD_ADDR  0x27

// ===================== FALLBACK THRESHOLD LOKAL =====================
const float LT1_KUNING = 1.2, LT1_MERAH = 1.6, LT1_MAX = 2.0;
const float LT2_KUNING = 0.6, LT2_MERAH = 0.8, LT2_MAX = 1.0;

// ===================== KALIBRASI LOAD CELL (fallback lokal) =====================
float CAL_KANAN = 52500.0;
float CAL_KIRI  = 52500.0;
const float NOISE_DEADBAND_KG = 0.02;

// ===================== FILTER =====================
const float EMA_ALPHA = 0.8;

// ===================== STRUKTUR LANTAI =====================
struct Lantai {
  HX711   scale;
  uint8_t dt, sck;
  uint8_t ledG, ledY, ledR;
  float   kuning, merah, maxKg;
  float   calFactor;
  float   berat          = 0;
  float   beratFiltered  = 0;
  long    rawTerakhir    = 0;
  uint8_t status         = 0;    // 0=AMAN, 1=WASPADA, 2=BAHAYA
};

Lantai lt[2];
const char* STATUS_TXT[] = {"AMAN", "WASPADA", "BAHAYA"};

LiquidCrystal_I2C lcd(LCD_ADDR, 20, 4);
uint8_t page = 0;

// ===================== MQTT CLIENT =====================
WiFiClientSecure wifiClient;
PubSubClient     mqttClient(wifiClient);

// ===================== INTERVAL =====================
const uint32_t INTERVAL_SENSOR = 2000;
const uint32_t INTERVAL_UPDATE = 250;
const uint32_t INTERVAL_DEBUG  = 1000;

uint32_t lastSensor = 0;
uint32_t lastUpdate = 0;
uint32_t lastDebug  = 0;

// ===================== LOGIKA TOMBOL =====================
uint8_t btnMode    = 0;
bool    btnIdleUp  = HIGH;
bool    btnIdleDown = LOW;

bool isTombolDitekan() {
  if (btnMode == 1) return (digitalRead(PIN_BUTTON) == LOW);
  if (btnMode == 2) return (digitalRead(PIN_BUTTON) == HIGH);

  static uint32_t lastSwitch = 0;
  static bool fasePullup = true;

  if (millis() - lastSwitch >= 25) {
    if (fasePullup) {
      bool val = digitalRead(PIN_BUTTON);
      if (val != btnIdleUp && val == LOW) {
        btnMode = 1;
        pinMode(PIN_BUTTON, INPUT_PULLUP);
        return true;
      }
      pinMode(PIN_BUTTON, INPUT_PULLDOWN);
      fasePullup = false;
    } else {
      bool val = digitalRead(PIN_BUTTON);
      if (val != btnIdleDown && val == HIGH) {
        btnMode = 2;
        pinMode(PIN_BUTTON, INPUT_PULLDOWN);
        return true;
      }
      pinMode(PIN_BUTTON, INPUT_PULLUP);
      fasePullup = true;
    }
    lastSwitch = millis();
  }
  return false;
}

void cekTombol() {
  static bool    lastReading      = false;
  static bool    stablePressed    = false;
  static uint32_t lastDebounceTime = 0;

  bool pressedNow = isTombolDitekan();
  if (pressedNow != lastReading) lastDebounceTime = millis();
  lastReading = pressedNow;

  if ((millis() - lastDebounceTime) > 60) {
    if (pressedNow != stablePressed) {
      stablePressed = pressedNow;
      if (stablePressed) {
        page = !page;
        Serial.printf("[TOMBOL] Pindah ke Lantai %d\n", page + 1);
        tampilLCD();
      }
    }
  }
}

// ===================== SETUP LANTAI =====================
void setupLantai(Lantai &l, uint8_t dt, uint8_t sck,
                 uint8_t g, uint8_t y, uint8_t r,
                 float kuning, float merah, float maxKg, float cal) {
  l.dt = dt; l.sck = sck;
  l.ledG = g; l.ledY = y; l.ledR = r;
  l.kuning = kuning; l.merah = merah; l.maxKg = maxKg; l.calFactor = cal;
  pinMode(g, OUTPUT); pinMode(y, OUTPUT); pinMode(r, OUTPUT);
  l.scale.begin(dt, sck);
  l.scale.set_scale(cal);
  l.scale.wait_ready_timeout(1000);
  // auto tare dimatikan — gunakan perintah "tare"/"kal1"/"kal2" di Serial Monitor
}

// ===================== BACA SENSOR + FILTER EMA =====================
void bacaSensor(Lantai &l) {
  if (l.scale.is_ready()) {
    l.rawTerakhir = l.scale.get_value(3);
    float w = fabs((float)l.rawTerakhir) / l.calFactor;
    if (w > 50.0f) return;
    l.beratFiltered = (EMA_ALPHA * w) + ((1.0f - EMA_ALPHA) * l.beratFiltered);
    l.berat = (l.beratFiltered < NOISE_DEADBAND_KG) ? 0.0f : l.beratFiltered;
  }
}

// ===================== HITUNG STATUS LOKAL (fallback) =====================
void hitungStatusLokal(Lantai &l) {
  l.status = (l.berat >= l.merah) ? 2 : (l.berat >= l.kuning) ? 1 : 0;
}

// ===================== TERAPKAN STATUS KE HARDWARE =====================
void terapkanStatus() {
  for (auto &l : lt) {
    digitalWrite(l.ledG, l.status == 0);
    digitalWrite(l.ledY, l.status == 1);
    digitalWrite(l.ledR, l.status == 2);
  }
  digitalWrite(PIN_BUZZER, (lt[0].status == 2 || lt[1].status == 2));
}

// ===================== LCD =====================
void tampilLCD() {
  Lantai &l = lt[page];
  char buf[21];
  lcd.setCursor(0, 0); lcd.print(F("  SMART LOAD SAFETY "));
  snprintf(buf, sizeof(buf), "Lantai %d/2          ", page + 1);
  lcd.setCursor(0, 1); lcd.print(buf);
  char w[8];
  dtostrf(l.berat, 4, 2, w);
  snprintf(buf, sizeof(buf), "Beban %s/%.1fkg    ", w, l.maxKg);
  lcd.setCursor(0, 2); lcd.print(buf);
  snprintf(buf, sizeof(buf), "Status: %-12s", STATUS_TXT[l.status]);
  lcd.setCursor(0, 3); lcd.print(buf);
}

// ===================== KALIBRASI SERIAL =====================
void cekKalibrasiSerial() {
  if (!Serial.available()) return;
  String input = Serial.readStringUntil('\n');
  input.trim(); input.toLowerCase();

  if (input == "kal1") {
    long raw = labs(lt[0].scale.get_value(10));
    if (raw > 100) {
      CAL_KANAN = (float)raw / 0.20f;
      lt[0].calFactor = CAL_KANAN;
      lt[0].scale.set_scale(CAL_KANAN);
      lt[0].beratFiltered = 0.20f;
      Serial.printf(">>> [SUKSES] Lantai 1 dikalibrasi! CAL_KANAN = %.1f <<<\n", CAL_KANAN);
    } else {
      Serial.println(">>> [GAGAL] Letakkan beban 200g di Lantai 1 dulu! <<<");
    }
  } else if (input == "kal2") {
    long raw = labs(lt[1].scale.get_value(10));
    if (raw > 100) {
      CAL_KIRI = (float)raw / 0.20f;
      lt[1].calFactor = CAL_KIRI;
      lt[1].scale.set_scale(CAL_KIRI);
      lt[1].beratFiltered = 0.20f;
      Serial.printf(">>> [SUKSES] Lantai 2 dikalibrasi! CAL_KIRI = %.1f <<<\n", CAL_KIRI);
    } else {
      Serial.println(">>> [GAGAL] Letakkan beban 200g di Lantai 2 dulu! <<<");
    }
  } else if (input == "tare") {
    lt[0].scale.tare(15); lt[1].scale.tare(15);
    lt[0].berat = 0; lt[0].beratFiltered = 0;
    lt[1].berat = 0; lt[1].beratFiltered = 0;
    Serial.println(">>> [TARE] Lantai 1 & 2 di-nol-kan <<<");
  } else {
    float calBaru = input.toFloat();
    if (calBaru > 0) {
      CAL_KIRI = calBaru;
      lt[1].calFactor = calBaru;
      lt[1].scale.set_scale(calBaru);
      Serial.printf(">>> CAL_KIRI diubah ke: %.1f <<<\n", calBaru);
    }
  }
}

// ===================== MQTT: EKSEKUSI TARE =====================
void executeTare(const char* target) {
  Serial.printf("[TARE] Eksekusi: %s\n", target);
  lcd.setCursor(0, 1);

  if (strcmp(target, "lantai1") == 0 || strcmp(target, "semua") == 0) {
    lcd.print(F("  Tare Lantai 1...  "));
    lt[0].scale.tare(15);
    lt[0].berat = 0; lt[0].beratFiltered = 0; lt[0].status = 0;
    digitalWrite(lt[0].ledG, HIGH);
    digitalWrite(lt[0].ledY, LOW);
    digitalWrite(lt[0].ledR, LOW);
  }

  if (strcmp(target, "lantai2") == 0 || strcmp(target, "semua") == 0) {
    lcd.print(F("  Tare Lantai 2...  "));
    lt[1].scale.tare(15);
    lt[1].berat = 0; lt[1].beratFiltered = 0; lt[1].status = 0;
    digitalWrite(lt[1].ledG, HIGH);
    digitalWrite(lt[1].ledY, LOW);
    digitalWrite(lt[1].ledR, LOW);
  }

  delay(500);
  tampilLCD();
}

// ===================== MQTT: CALLBACK (pesan masuk) =====================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  // ---- sensor/status → update berat & status dari server ----
  if (strcmp(topic, "sensor/status") == 0) {
    StaticJsonDocument<256> doc;
    if (deserializeJson(doc, msg)) return;

    JsonArray arr = doc.as<JsonArray>();
    for (JsonObject item : arr) {
      int   idRak     = item["id_rak"].as<int>();
      float berat_kg  = item["berat_kg"].as<float>();
      const char* st  = item["status"];

      int idx = idRak - 1;
      if (idx < 0 || idx > 1) continue;

      lt[idx].berat = berat_kg;
      if      (strcmp(st, "BAHAYA")  == 0) lt[idx].status = 2;
      else if (strcmp(st, "WASPADA") == 0) lt[idx].status = 1;
      else                                  lt[idx].status = 0;
    }

    terapkanStatus();
    Serial.printf("[MQTT] Status: L1=%.3fkg(%s) L2=%.3fkg(%s)\n",
                  lt[0].berat, STATUS_TXT[lt[0].status],
                  lt[1].berat, STATUS_TXT[lt[1].status]);
  }

  // ---- command/tare → eksekusi tare lalu kirim hasil ----
  if (strcmp(topic, "command/tare") == 0) {
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, msg)) return;

    long        id     = doc["id"].as<long>();
    const char* target = doc["target"];

    Serial.printf("[MQTT] Perintah tare: id=%ld, target=%s\n", id, target);

    executeTare(target);

    // Kirim hasil tare kembali ke server
    StaticJsonDocument<128> result;
    result["id"]      = id;
    result["target"]  = target;
    result["success"] = true;
    result["message"] = "Tare berhasil";
    String resultStr;
    serializeJson(result, resultStr);
    mqttClient.publish("tare/result", resultStr.c_str());
  }

  // ---- config/update → update threshold lokal ----
  if (strcmp(topic, "config/update") == 0) {
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, msg)) return;

    int   idRak      = doc["id_rak"].as<int>();
    float warning_kg = doc["warning_kg"].as<float>();
    float danger_kg  = doc["danger_kg"].as<float>();
    float max_kg     = doc["max_kg"].as<float>();
    float cal_factor = doc["cal_factor"].as<float>();

    int idx = idRak - 1;
    if (idx < 0 || idx > 1) return;

    lt[idx].kuning    = warning_kg;
    lt[idx].merah     = danger_kg;
    lt[idx].maxKg     = max_kg;
    lt[idx].calFactor = cal_factor;
    lt[idx].scale.set_scale(cal_factor);

    Serial.printf("[MQTT] Config L%d diperbarui: w=%.2f d=%.2f m=%.2f cal=%.1f\n",
                  idRak, warning_kg, danger_kg, max_kg, cal_factor);
  }
}

// ===================== MQTT: RECONNECT =====================
void mqttReconnect() {
  if (mqttClient.connected()) return;
  Serial.print("[MQTT] Konek ke broker...");
  if (mqttClient.connect(CLIENT_ID, MQTT_USER, MQTT_PASS)) {
    Serial.println(" OK");
    mqttClient.subscribe("sensor/status");
    mqttClient.subscribe("command/tare");
    mqttClient.subscribe("config/update");
  } else {
    Serial.printf(" Gagal, rc=%d\n", mqttClient.state());
  }
}

// ===================== MQTT: KIRIM DATA SENSOR =====================
void sendSensorData() {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<64> doc;
  doc["raw1"] = lt[0].rawTerakhir;
  doc["raw2"] = lt[1].rawTerakhir;
  String body;
  serializeJson(doc, body);

  mqttClient.publish("sensor/raw", body.c_str());
  Serial.printf("[MQTT] Publish sensor/raw: raw1=%ld raw2=%ld\n",
                lt[0].rawTerakhir, lt[1].rawTerakhir);
}

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();
  lcd.clear();

  pinMode(PIN_BUTTON, INPUT_PULLUP);
  delay(20); btnIdleUp = digitalRead(PIN_BUTTON);
  pinMode(PIN_BUTTON, INPUT_PULLDOWN);
  delay(20); btnIdleDown = digitalRead(PIN_BUTTON);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  //                   DT   SCK  G   Y   R
  setupLantai(lt[0],   14,  27, 19, 18,  5, LT1_KUNING, LT1_MERAH, LT1_MAX, CAL_KANAN);
  setupLantai(lt[1],   12,  13, 17, 16,  4, LT2_KUNING, LT2_MERAH, LT2_MAX, CAL_KIRI);

  lcd.setCursor(0, 2); lcd.print(F("  Konek ke WiFi...  "));
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[WiFi] Terhubung: " + WiFi.localIP().toString());

  // EMQX Cloud pakai TLS — skip verifikasi sertifikat CA untuk simplisitas
  wifiClient.setInsecure();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(512);

  lcd.setCursor(0, 2); lcd.print(F("  Konek ke MQTT...  "));
  mqttReconnect();

  lcd.clear();
  tampilLCD();
}

// ===================== LOOP =====================
void loop() {
  uint32_t now = millis();

  // Jaga koneksi MQTT
  if (!mqttClient.connected()) {
    static uint32_t lastReconnect = 0;
    if (now - lastReconnect >= 5000) {
      lastReconnect = now;
      mqttReconnect();
    }
  }
  mqttClient.loop();

  cekTombol();
  cekKalibrasiSerial();

  if (now - lastUpdate >= INTERVAL_UPDATE) {
    lastUpdate = now;
    for (auto &l : lt) bacaSensor(l);
    tampilLCD();
  }

  if (now - lastSensor >= INTERVAL_SENSOR) {
    lastSensor = now;
    sendSensorData();
  }

  if (now - lastDebug >= INTERVAL_DEBUG) {
    lastDebug = now;
    Serial.printf("LT1: raw=%ld cal=%.0f berat=%.2fkg | LT2: raw=%ld cal=%.0f berat=%.2fkg\n",
                  lt[0].rawTerakhir, CAL_KANAN, lt[0].berat,
                  lt[1].rawTerakhir, CAL_KIRI,  lt[1].berat);
  }
}
