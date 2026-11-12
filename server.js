require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mqtt = require("mqtt");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================== KONFIGURASI LANTAI (cache) =====================
let floorConfig = {};

async function loadFloorConfig() {
  const [rows] = await db.query("SELECT * FROM FLOOR_CONFIG");
  floorConfig = {};
  for (const row of rows) {
    floorConfig[row.id_rak] = {
      cal_factor: row.cal_factor,
      warning_kg: row.warning_kg,
      danger_kg:  row.danger_kg,
      max_kg:     row.max_kg,
    };
  }
  console.log("[CONFIG] Floor config loaded:", floorConfig);
}

// ===================== MQTT CLIENT =====================
const MQTT_HOST     = process.env.MQTT_HOST     || "localhost";
const MQTT_PORT     = process.env.MQTT_PORT     || 1883;
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  rejectUnauthorized: true,
  reconnectPeriod: 3000,
});

mqttClient.on("connect", () => {
  console.log("[MQTT] Connected to broker");
  mqttClient.subscribe(["sensor/raw", "tare/result"], (err) => {
    if (err) console.error("[MQTT] Subscribe error:", err.message);
    else console.log("[MQTT] Subscribed to sensor/raw, tare/result");
  });

  // Kirim config dari database ke ESP32 supaya calFactor lokal sinkron
  for (const [idRak, cfg] of Object.entries(floorConfig)) {
    const payload = JSON.stringify({
      id_rak:     parseInt(idRak),
      cal_factor: cfg.cal_factor,
      warning_kg: cfg.warning_kg,
      danger_kg:  cfg.danger_kg,
      max_kg:     cfg.max_kg,
    });
    mqttClient.publish("config/update", payload);
    console.log(`[CONFIG] Sent config to ESP32 for rak ${idRak}:`, payload);
  }
});

mqttClient.on("error", (err) => {
  console.error("[MQTT] Error:", err.message);
});

mqttClient.on("reconnect", () => {
  console.log("[MQTT] Reconnecting...");
});

const NOISE_DEADBAND_KG = 0.005;

mqttClient.on("message", (topic, message) => {
  const payload = message.toString();

  // ---- sensor/raw → kalkulasi + emit ke dashboard + simpan DB ----
  if (topic === "sensor/raw") {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return; }

    const { raw1, raw2 } = parsed;
    if (!Number.isInteger(raw1) || !Number.isInteger(raw2)) return;

    const rawInputs = [
      { idRak: 1, raw: raw1 },
      { idRak: 2, raw: raw2 },
    ];

    const results = rawInputs.map(({ idRak, raw }) => {
      const cfg = floorConfig[idRak];
      if (!cfg) return null;
      let berat_kg = Math.abs(raw) / cfg.cal_factor;
      if (berat_kg < NOISE_DEADBAND_KG) berat_kg = 0;

      const status =
        berat_kg >= cfg.danger_kg  ? "BAHAYA"     :
        berat_kg >= cfg.warning_kg ? "WASPADA" : "AMAN";

      return { id_rak: idRak, berat_kg, status };
    }).filter(Boolean);

    // Kirim status kembali ke ESP32
    mqttClient.publish("sensor/status", JSON.stringify(results));

    // Emit ke dashboard
    io.emit("sensor-update", results);

    // Simpan ke DB secara async
    (async () => {
      const connection = await db.getConnection();
      try {
        const [operator] = await connection.query(
          "SELECT id_user FROM `operator` WHERE username = 'SYSTEM' LIMIT 1",
        );
        if (operator.length === 0) return;
        const idUser = operator[0].id_user;
        for (const r of results) {
          await connection.query(
            `INSERT INTO data_log (id_rak, id_user, berat_aktual_gram, status_beban)
             VALUES (?, ?, ?, ?)`,
            [r.id_rak, idUser, r.berat_kg * 1000, r.status],
          );
        }
      } catch (err) {
        console.error("[DB] Gagal simpan sensor:", err.message);
      } finally {
        connection.release();
      }
    })();
  }

  // ---- tare/result → emit ke dashboard ----
  if (topic === "tare/result") {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return; }

    const result = {
      id:          parsed.id,
      target:      parsed.target,
      status:      parsed.success ? "success" : "failed",
      message:     parsed.message || (parsed.success ? "Tare berhasil" : "Tare gagal"),
      completedAt: new Date().toISOString(),
    };

    io.emit("tare-result", result);
    console.log("[MQTT] Tare result:", result);
  }
});

// ===================== MIDDLEWARE =====================
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "smart-load-safety-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static("public"));

// ===================== AUTH MIDDLEWARE =====================
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ success: false, message: "Belum login" });
}

// ===================== AUTH ENDPOINTS =====================
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username dan password wajib diisi" });
  }
  try {
    const [rows] = await db.query(
      "SELECT id_user, username, password, role FROM `operator` WHERE username = ? LIMIT 1",
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: "Username atau password salah" });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Username atau password salah" });
    }
    req.session.user = { id: user.id_user, username: user.username, role: user.role };
    res.json({ success: true, user: { username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ success: true, user: req.session.user });
  } else {
    res.json({ success: false, user: null });
  }
});

app.get("/api/test", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS test");
    res.json({ success: true, message: "MySQL connected!", data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===================== CONFIG API =====================
app.get("/api/config", (req, res) => {
  res.json({ success: true, data: floorConfig });
});

app.put("/api/config/:idRak", requireAuth, async (req, res) => {
  const idRak = parseInt(req.params.idRak, 10);

  if (!floorConfig[idRak]) {
    return res.status(404).json({ success: false, message: "Lantai tidak ditemukan" });
  }

  const { cal_factor, warning_kg, danger_kg, max_kg } = req.body;

  if (
    typeof cal_factor  !== "number" || cal_factor  <= 0 ||
    typeof warning_kg  !== "number" || warning_kg  <= 0 ||
    typeof danger_kg   !== "number" || danger_kg   <= 0 ||
    typeof max_kg      !== "number" || max_kg      <= 0
  ) {
    return res.status(400).json({ success: false, message: "Semua nilai harus angka positif" });
  }

  if (!(warning_kg < danger_kg && danger_kg < max_kg)) {
    return res.status(400).json({
      success: false,
      message: "Urutan tidak valid: warning < danger < max harus terpenuhi",
    });
  }

  try {
    await db.query(
      `UPDATE FLOOR_CONFIG SET cal_factor=?, warning_kg=?, danger_kg=?, max_kg=? WHERE id_rak=?`,
      [cal_factor, warning_kg, danger_kg, max_kg, idRak],
    );

    floorConfig[idRak] = { cal_factor, warning_kg, danger_kg, max_kg };

    // Kirim config baru ke ESP32 via MQTT
    mqttClient.publish("config/update", JSON.stringify({ id_rak: idRak, ...floorConfig[idRak] }));

    io.emit("config-update", { id_rak: idRak, ...floorConfig[idRak] });

    res.json({ success: true, message: "Konfigurasi berhasil diperbarui", data: floorConfig[idRak] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== TARE API =====================
// Dashboard POST ke sini → server publish ke MQTT → ESP32 eksekusi
app.post("/api/tare", (req, res) => {
  const { target } = req.body;

  if (!["lantai1", "lantai2", "semua"].includes(target)) {
    return res.status(400).json({ success: false, message: "Target tare tidak valid" });
  }

  const command = {
    id:        Date.now(),
    target,
    createdAt: new Date().toISOString(),
  };

  // Publish perintah ke ESP32 via MQTT
  mqttClient.publish("command/tare", JSON.stringify(command));

  io.emit("tare-status", { id: command.id, target, status: "pending" });

  res.status(201).json({
    success: true,
    message: "Perintah tare berhasil dikirim",
    command,
  });
});

// ===================== HISTORY API =====================
app.get("/api/history", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_log AS id, id_rak, berat_aktual_gram, status_beban, timestamp_waktu AS created_at
       FROM data_log
       ORDER BY timestamp_waktu DESC
       LIMIT 50`
    );
    const data = rows.reverse().map((r) => ({
      id: r.id,
      id_rak: r.id_rak,
      berat_kg: parseFloat((r.berat_aktual_gram / 1000).toFixed(2)),
      status_beban: r.status_beban,
      created_at: r.created_at,
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===================== START SERVER =====================
loadFloorConfig()
  .then(() => {
    server.listen(3000, "0.0.0.0", () => {
      console.log("Server running on port 3000");
    });
  })
  .catch((err) => {
    console.error("[CONFIG] Gagal load floor config:", err.message);
    process.exit(1);
  });
