# Smart Load Safety Monitor

Sistem IoT untuk memantau beban rak dua lantai secara real-time menggunakan **ESP32 + HX711 (load cell)**. Data dikirim ke server Node.js via **MQTT (EMQX Cloud TLS)**, lalu diteruskan ke dashboard web melalui **Socket.IO**.

Setiap lantai memiliki tiga level status:
| Status | Kondisi |
|--------|---------|
| **AMAN** | Beban di bawah threshold warning |
| **WASPADA** | Beban melewati threshold warning |
| **BAHAYA** | Beban melewati threshold danger → buzzer aktif |

---

## Teknologi

### Backend
| Paket | Fungsi |
|-------|--------|
| Node.js + Express 5 | HTTP server & REST API |
| Socket.IO 4 | Push data real-time ke browser |
| mqtt 5 | Komunikasi dengan ESP32 via EMQX Cloud TLS |
| mysql2 | Penyimpanan konfigurasi & log data |
| express-session | Autentikasi operator |
| bcryptjs | Hashing password |
| dotenv | Konfigurasi environment |

### Frontend
- HTML + Tailwind CSS (CDN)
- ApexCharts (gauge radial & line chart real-time)
- Socket.IO client

### Firmware (ESP32)
- Arduino framework
- HX711 — baca load cell
- PubSubClient — MQTT
- ArduinoJson — parse/serialize JSON
- LiquidCrystal_I2C — LCD 20×4

---

## Struktur Proyek

```
smart-load-safety/
├── server.js              # Entry point: Express + MQTT + Socket.IO
├── db.js                  # Pool koneksi MySQL (mysql2)
├── package.json
├── .env                   # Variabel environment (tidak di-commit)
├── .envexample            # Template .env
├── public/
│   └── index.html         # Dashboard web (Monitor / Historis / Tare / Konfigurasi)
├── database/
│   └── schema.sql         # DDL lengkap semua tabel
└── smart_load_safety.ino  # Firmware ESP32
```

---

## Cara Menjalankan dari Awal

### Prasyarat
- **Node.js** v18+ — https://nodejs.org
- **MySQL** 8.0+ (atau MariaDB 10.6+)
- **Arduino IDE** 2.x (untuk flash ESP32)
- Akun **EMQX Cloud** (atau broker MQTT lain yang mendukung TLS port 8883)

---

### 1. Clone & Install Dependensi

```bash
git clone <repo-url>
cd smart-load-safety
npm install
```

---

### 2. Buat File `.env`

Salin template lalu isi nilainya:

```bash
cp .envexample .env
```

Isi `.env`:

```env
PORT=3000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_db_password
DB_NAME=smart-rack

MQTT_HOST=your.emqx.host
MQTT_PORT=8883
MQTT_USERNAME=your_mqtt_user
MQTT_PASSWORD=your_mqtt_password
```

---

### 3. Siapkan Database

Buat database terlebih dahulu:

```sql
CREATE DATABASE `smart-rack` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

Lalu jalankan schema (semua tabel + data awal):

```bash
mysql -u root -p smart-rack < database/schema.sql
```

Schema akan membuat 5 tabel sekaligus:
| Tabel | Isi |
|-------|-----|
| `rak` | Data lantai (id, nama, batas maks) |
| `operator` | User login (termasuk user SYSTEM & admin bawaan) |
| `data_log` | Log pembacaan sensor per lantai |
| `FLOOR_CONFIG` | Konfigurasi cal factor & threshold per lantai |
| `tare_log` | Riwayat perintah tare beserta siapa yang mengeksekusi |

> **User admin bawaan:** username `admin`, password `admin123`
> Ganti password setelah pertama login lewat query:
> ```sql
> UPDATE operator SET password = '$2b$10$...' WHERE username = 'admin';
> ```
> Hash bisa dibuat dengan: `node -e "const b=require('bcryptjs'); b.hash('password_baru',10).then(console.log)"`

---

### 4. Jalankan Server

```bash
npm start
```

Atau dengan auto-restart saat development (butuh nodemon):

```bash
npx nodemon server.js
```

Server berjalan di: **http://localhost:3000**

---

### 5. Flash Firmware ESP32

1. Buka `smart_load_safety.ino` di Arduino IDE
2. Install library yang dibutuhkan via Library Manager:
   - `HX711` by bogde
   - `PubSubClient` by Nick O'Leary
   - `ArduinoJson` by Benoit Blanchon
   - `LiquidCrystal_I2C` by Frank de Brabander
3. Edit bagian konfigurasi di baris atas file `.ino`:
   ```cpp
   const char* WIFI_SSID  = "nama_wifi";
   const char* WIFI_PASS  = "password_wifi";
   const char* MQTT_HOST  = "your.emqx.host";
   const char* MQTT_USER  = "your_mqtt_user";
   const char* MQTT_PASS  = "your_mqtt_password";
   ```
4. Pilih board **ESP32 Dev Module**, lalu Upload

---

### 6. Kalibrasi Sensor (Pertama Kali)

Kalibrasi bisa dilakukan dua cara:

**A. Lewat Dashboard Web** (direkomendasikan)
1. Buka tab **Konfigurasi**
2. Login sebagai operator
3. Letakkan beban **200 gram** di atas sensor yang akan dikalibrasi
4. Klik tombol **Kalibrasi** di sebelah Cal Factor lantai yang bersangkutan
5. Konfirmasi di dialog yang muncul
6. Cal Factor baru otomatis tersimpan ke database

**B. Lewat Serial Monitor Arduino IDE** (115200 baud)
```
tare   — Nol-kan semua sensor
kal1   — Kalibrasi Lantai 1 dengan beban 200 g
kal2   — Kalibrasi Lantai 2 dengan beban 200 g
```

---

## MQTT Topics

| Topic | Arah | Payload |
|-------|------|---------|
| `sensor/raw` | ESP32 → Server | `{ "raw1": int, "raw2": int }` |
| `sensor/status` | Server → ESP32 | `[{ id_rak, berat_kg, status }, ...]` |
| `command/tare` | Server → ESP32 | `{ id, target, createdAt }` |
| `tare/result` | ESP32 → Server | `{ id, target, success, message }` |
| `command/calibrate` | Server → ESP32 | `{ id, id_rak, ref_kg, createdAt }` |
| `calibrate/result` | ESP32 → Server | `{ id_rak, success, cal_factor, message }` |
| `config/update` | Server → ESP32 | `{ id_rak, cal_factor, warning_kg, danger_kg, max_kg }` |

---

## REST API

| Method | Endpoint | Auth | Keterangan |
|--------|----------|------|------------|
| `POST` | `/api/login` | — | Login operator |
| `POST` | `/api/logout` | — | Logout |
| `GET` | `/api/me` | — | Cek sesi aktif |
| `GET` | `/api/config` | — | Ambil konfigurasi semua lantai |
| `PUT` | `/api/config/:idRak` | Ya | Update konfigurasi lantai |
| `POST` | `/api/calibrate/:idRak` | Ya | Kirim perintah kalibrasi ke ESP32 |
| `POST` | `/api/tare` | Ya | Kirim perintah tare ke ESP32 |
| `GET` | `/api/tare/history` | — | Ambil 50 riwayat tare terbaru |
| `GET` | `/api/history` | — | Ambil 50 data log sensor terbaru |
| `GET` | `/api/test` | — | Cek koneksi database |

---

## Fitur Dashboard

| Tab | Fitur |
|-----|-------|
| **Monitor** | Gauge radial real-time beban + status per lantai. Label kapasitas mengikuti nilai `max_kg` di database |
| **Historis** | Line chart tren berat + tabel log dengan filter per lantai & status |
| **Tare** | Kirim perintah zero/tare (Lantai 1 / Lantai 2 / Semua). Riwayat tare tersimpan di database dengan info siapa yang mengeksekusi |
| **Konfigurasi** | Atur Cal Factor (+ tombol kalibrasi 200 g), threshold Warning/Danger/Max per lantai. Membutuhkan login |

---

## Pinout ESP32

| Pin | Fungsi |
|-----|--------|
| 4 | LED Merah Lantai 1 |
| 16 | LED Kuning Lantai 1 |
| 17 | LED Hijau Lantai 1 |
| 5 | LED Merah Lantai 2 |
| 18 | LED Kuning Lantai 2 |
| 19 | LED Hijau Lantai 2 |
| 12 | HX711 DT Lantai 1 |
| 13 | HX711 SCK Lantai 1 |
| 14 | HX711 DT Lantai 2 |
| 27 | HX711 SCK Lantai 2 |
| 23 | Buzzer |
| 21 | Tombol (ganti halaman LCD) |
| 25 | LCD SCL (I2C) |
| 26 | LCD SDA (I2C) |
