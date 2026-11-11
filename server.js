const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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
  const { lantai1, lantai2 } = req.body;

  if (
    typeof lantai1 !== "number" ||
    typeof lantai2 !== "number" ||
    !Number.isFinite(lantai1) ||
    !Number.isFinite(lantai2) ||
    lantai1 < 0 ||
    lantai2 < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Data berat tidak valid",
    });
  }

  const floors = [
    { idRak: 1, berat: lantai1, warning: 1.2, danger: 1.6 },
    { idRak: 2, berat: lantai2, warning: 0.6, danger: 0.8 },
  ];

  const results = floors.map((floor) => ({
    id_rak: floor.idRak,
    berat: floor.berat,
    status:
      floor.berat >= floor.danger
        ? "BAHAYA"
        : floor.berat >= floor.warning
          ? "PERINGATAN"
          : "AMAN",
  }));

  // Emit ke dashboard terlebih dahulu — tidak bergantung DB
  io.emit("sensor-update", results);

  // Simpan ke DB secara async (tidak memblok response)
  (async () => {
    const connection = await db.getConnection();
    try {
      const [operator] = await connection.query(
        "SELECT id_user FROM OPERATOR WHERE username = 'SYSTEM' LIMIT 1",
      );
      if (operator.length === 0) return;
      const idUser = operator[0].id_user;
      for (const r of results) {
        await connection.query(
          `INSERT INTO DATA_LOG (id_rak, id_user, berat_aktual_gram, status_beban)
           VALUES (?, ?, ?, ?)`,
          [r.id_rak, idUser, r.berat * 1000, r.status],
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
    message: "Data sensor berhasil disimpan",
    data: results,
  });
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

server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});
