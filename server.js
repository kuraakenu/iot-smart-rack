const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================== KONFIGURASI LANTAI (cache) =====================
// Di-load dari tabel FLOOR_CONFIG saat startup.
// Struktur: floorConfig[id_rak] = { cal_factor, warning_kg, danger_kg, max_kg }
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

app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "smart-load-safety-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }, // 8 jam
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
  req.session.destroy(() => {
    res.json({ success: true });
  });
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

    res.json({
      success: true,
      message: "MySQL connected!",
      data: rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/api/sensor", async (req, res) => {
  const { raw1, raw2 } = req.body;

  if (
    !Number.isInteger(raw1) ||
    !Number.isInteger(raw2)
  ) {
    return res.status(400).json({
      success: false,
      message: "Data raw sensor tidak valid (harus integer)",
    });
  }

  const NOISE_DEADBAND_KG = 0.005;

  const rawInputs = [
    { idRak: 1, raw: raw1 },
    { idRak: 2, raw: raw2 },
  ];

  const results = rawInputs.map(({ idRak, raw }) => {
    const cfg = floorConfig[idRak];
    let berat_kg = Math.abs(raw) / cfg.cal_factor;
    if (berat_kg < NOISE_DEADBAND_KG) berat_kg = 0;

    const status =
      berat_kg >= cfg.danger_kg
        ? "BAHAYA"
        : berat_kg >= cfg.warning_kg
          ? "PERINGATAN"
          : "AMAN";

    return { id_rak: idRak, berat_kg, status };
  });

  // Emit ke dashboard terlebih dahulu — tidak bergantung DB
  io.emit("sensor-update", results);

  // Simpan ke DB secara async (tidak memblok response)
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

  res.json({
    success: true,
    message: "Data sensor berhasil diproses",
    data: results,
  });
});

// ===================== CONFIG API =====================

// GET /api/config — kembalikan semua konfigurasi lantai dari cache
app.get("/api/config", (req, res) => {
  res.json({ success: true, data: floorConfig });
});

// PUT /api/config/:idRak — update konfigurasi 1 lantai (butuh login)
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

    io.emit("config-update", { id_rak: idRak, ...floorConfig[idRak] });

    res.json({ success: true, message: "Konfigurasi berhasil diperbarui", data: floorConfig[idRak] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Menyimpan antrean perintah tare

// ===================== TARE COMMAND QUEUE =====================

let tareCommand = null;
let lastTareResult = null;
let tareTimeoutHandle = null;

const TARE_TIMEOUT_MS = 30000; // 30 detik auto-reset

function resetTareCommand(reason) {
  if (tareTimeoutHandle) {
    clearTimeout(tareTimeoutHandle);
    tareTimeoutHandle = null;
  }
  if (tareCommand) {
    console.log(`[TARE] Reset: ${reason}`);
    io.emit("tare-result", {
      id: tareCommand.id,
      target: tareCommand.target,
      status: "failed",
      message: reason,
      completedAt: new Date().toISOString(),
    });
  }
  tareCommand = null;
}

// 1. Dashboard membuat perintah Tare
app.post("/api/tare", (req, res) => {
  const { target } = req.body;

  if (!["lantai1", "lantai2", "semua"].includes(target)) {
    return res.status(400).json({
      success: false,
      message: "Target tare tidak valid",
    });
  }

  // Auto-reset jika perintah sebelumnya stuck
  if (tareCommand !== null) {
    resetTareCommand("Timeout: digantikan perintah baru");
  }

  tareCommand = {
    id: Date.now(),
    target,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  lastTareResult = null;

  // Auto-reset setelah 30 detik jika ESP32 tidak merespons
  tareTimeoutHandle = setTimeout(() => {
    resetTareCommand("Timeout: ESP32 tidak merespons dalam 30 detik");
  }, TARE_TIMEOUT_MS);

  io.emit("tare-status", {
    id: tareCommand.id,
    target,
    status: "pending",
  });

  res.status(201).json({
    success: true,
    message: "Perintah tare berhasil dibuat",
    command: tareCommand,
  });
});

// 2. ESP32 mengambil perintah
app.get("/api/command", (req, res) => {
  if (!tareCommand || tareCommand.status !== "pending") {
    return res.json({
      success: true,
      command: null,
    });
  }

  tareCommand.status = "processing";
  tareCommand.claimedAt = new Date().toISOString();

  const command = { ...tareCommand };

  io.emit("tare-status", {
    id: command.id,
    target: command.target,
    status: "processing",
  });

  res.json({
    success: true,
    command,
  });
});

// 3. ESP32 mengirim hasil eksekusi Tare
app.post("/api/command/result", (req, res) => {
  const { id, success, message } = req.body;

  if (!Number.isSafeInteger(id) || typeof success !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "Data konfirmasi tidak valid",
    });
  }

  if (
    !tareCommand ||
    tareCommand.id !== id ||
    tareCommand.status !== "processing"
  ) {
    return res.status(404).json({
      success: false,
      message: "Perintah tidak ditemukan atau sudah selesai",
    });
  }

  lastTareResult = {
    id,
    target: tareCommand.target,
    status: success ? "success" : "failed",
    message: message || (success ? "Tare berhasil" : "Tare gagal"),
    completedAt: new Date().toISOString(),
  };

  io.emit("tare-result", lastTareResult);

  if (tareTimeoutHandle) {
    clearTimeout(tareTimeoutHandle);
    tareTimeoutHandle = null;
  }
  tareCommand = null;

  res.json({
    success: true,
    message: "Konfirmasi tare diterima",
    result: lastTareResult,
  });
});

app.get("/api/history", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_log AS id, id_rak, berat_aktual_gram, status_beban, timestamp_waktu AS created_at
       FROM data_log
       ORDER BY timestamp_waktu DESC
       LIMIT 50`
    );
    // Balik urutan agar ascending (terlama → terbaru) untuk chart
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
