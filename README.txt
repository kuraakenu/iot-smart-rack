================================================================================
  SMART LOAD SAFETY MONITOR
  Sistem monitoring beban rak dua lantai berbasis IoT secara real-time
================================================================================

DESKRIPSI
---------
Smart Load Safety adalah sistem IoT untuk memantau beban rak secara real-time
menggunakan ESP32 + sensor HX711 (load cell). Data dikirim ke server Node.js
melalui MQTT (EMQX Cloud TLS), lalu disiarkan ke dashboard web via Socket.IO.

Setiap lantai memiliki tiga level status:
  - AMAN    : beban di bawah threshold warning
  - WASPADA : beban melewati threshold warning
  - BAHAYA  : beban melewati threshold danger → buzzer aktif

--------------------------------------------------------------------------------

TEKNOLOGI
---------
Backend / Server
  - Node.js + Express 5
  - Socket.IO 4        (push data real-time ke browser)
  - MQTT 5             (komunikasi dengan ESP32 via EMQX Cloud TLS)
  - MySQL 2 / mysql2   (penyimpanan konfigurasi & log data)
  - express-session    (autentikasi operator)
  - bcryptjs           (hashing password)
  - dotenv             (konfigurasi environment)

Frontend
  - HTML / Tailwind CSS (CDN)
  - ApexCharts          (gauge & line chart real-time)
  - Socket.IO client

Firmware (ESP32)
  - Arduino framework
  - HX711              (baca load cell)
  - PubSubClient       (MQTT)
  - ArduinoJson        (parse/serialize JSON)
  - LiquidCrystal_I2C  (LCD 20x4)

--------------------------------------------------------------------------------

STRUKTUR PROYEK
---------------
  server.js                  — Entry point server (Express + MQTT + Socket.IO)
  db.js                      — Pool koneksi MySQL
  public/
    index.html               — Dashboard web (Monitor, Historis, Tare, Config)
    css/                     — Stylesheet tambahan
    js/                      — Script frontend tambahan
  smart_load_safety.ino      — Firmware ESP32
  package.json
  .env                       — Variabel environment (tidak di-commit)

--------------------------------------------------------------------------------

SETUP & MENJALANKAN
-------------------
1. Clone / download proyek ini.

2. Install dependensi Node.js:
     npm install

3. Buat file .env di root proyek dan isi variabel berikut:
     DB_HOST=127.0.0.1
     DB_PORT=3306
     DB_USER=root
     DB_PASSWORD=your_password
     DB_NAME=smart-rack
     MQTT_HOST=your.emqx.host
     MQTT_PORT=8883
     MQTT_USERNAME=your_mqtt_user
     MQTT_PASSWORD=your_mqtt_password
     SESSION_SECRET=your_session_secret

4. Siapkan database MySQL dengan nama "smart-rack" dan buat tabel berikut:

   -- Konfigurasi per lantai
   CREATE TABLE FLOOR_CONFIG (
     id_rak      INT PRIMARY KEY,
     cal_factor  FLOAT NOT NULL,
     warning_kg  FLOAT NOT NULL,
     danger_kg   FLOAT NOT NULL,
     max_kg      FLOAT NOT NULL
   );

   -- Operator / user login
   CREATE TABLE operator (
     id_user   INT AUTO_INCREMENT PRIMARY KEY,
     username  VARCHAR(50) UNIQUE NOT NULL,
     password  VARCHAR(255) NOT NULL,   -- bcrypt hash
     role      VARCHAR(20) NOT NULL
   );

   -- Log data sensor
   CREATE TABLE data_log (
     id_log              INT AUTO_INCREMENT PRIMARY KEY,
     id_rak              INT NOT NULL,
     id_user             INT NOT NULL,
     berat_aktual_gram   FLOAT NOT NULL,
     status_beban        VARCHAR(20) NOT NULL,
     timestamp_waktu     DATETIME DEFAULT CURRENT_TIMESTAMP
   );

   -- Insert user SYSTEM (dipakai otomatis oleh server)
   INSERT INTO operator (username, password, role)
   VALUES ('SYSTEM', '$2a$10$...bcrypt_hash...', 'system');

   -- Insert konfigurasi awal
   INSERT INTO FLOOR_CONFIG VALUES (1, 52500, 1.2, 1.6, 2.0);
   INSERT INTO FLOOR_CONFIG VALUES (2, 52500, 0.6, 0.8, 1.0);

5. Jalankan server:
     npm start
   atau:
     node server.js

6. Buka browser ke:
     http://localhost:3000

--------------------------------------------------------------------------------

MQTT TOPICS
-----------
  sensor/raw      ESP32 → Server  : { "raw1": int, "raw2": int }
  sensor/status   Server → ESP32  : [{ id_rak, berat_kg, status }, ...]
  command/tare    Server → ESP32  : { id, target, createdAt }
  tare/result     ESP32 → Server  : { id, target, success, message }
  config/update   Server → ESP32  : { id_rak, cal_factor, warning_kg, danger_kg, max_kg }

--------------------------------------------------------------------------------

REST API
--------
  POST   /api/login           Login operator
  POST   /api/logout          Logout
  GET    /api/me              Cek sesi aktif
  GET    /api/config          Ambil konfigurasi semua lantai
  PUT    /api/config/:idRak   Update konfigurasi lantai (butuh login)
  POST   /api/tare            Kirim perintah tare ke ESP32
  GET    /api/history         Ambil 50 data log terbaru
  GET    /api/test            Cek koneksi database

--------------------------------------------------------------------------------

FITUR DASHBOARD
---------------
  Monitor      — Gauge real-time beban + status per lantai
  Historis     — Line chart tren berat + tabel log dengan filter lantai/status
  Tare         — Kirim perintah zero/tare ke sensor (lantai1 / lantai2 / semua)
  Konfigurasi  — Atur Cal Factor, threshold Warning/Danger/Max per lantai
                 (membutuhkan login operator)

--------------------------------------------------------------------------------

HARDWARE ESP32
--------------
  Pin  5  — LED Merah  Lantai 1
  Pin 18  — LED Kuning Lantai 1
  Pin 19  — LED Hijau  Lantai 1
  Pin  4  — LED Merah  Lantai 2
  Pin 16  — LED Kuning Lantai 2
  Pin 17  — LED Hijau  Lantai 2
  Pin 14  — HX711 DT   Lantai 1
  Pin 27  — HX711 SCK  Lantai 1
  Pin 12  — HX711 DT   Lantai 2
  Pin 13  — HX711 SCK  Lantai 2
  Pin 23  — Buzzer
  Pin 21  — Tombol (page LCD)
  Pin 25  — LCD SCL (I2C)
  Pin 26  — LCD SDA (I2C)

Kalibrasi via Serial Monitor (115200 baud):
  tare    — Nol-kan semua sensor
  kal1    — Kalibrasi Lantai 1 dengan beban 200 g
  kal2    — Kalibrasi Lantai 2 dengan beban 200 g
  <angka> — Set manual cal factor Lantai 2

================================================================================
