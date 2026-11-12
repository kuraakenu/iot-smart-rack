-- =========================================================
-- SMART LOAD SAFETY — Database Schema
-- =========================================================
-- Jalankan file ini untuk inisialisasi DB dari nol.
-- Gunakan: mysql -u <user> -p <db_name> < schema.sql
-- =========================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

-- ---------------------------------------------------------
-- Tabel: rak
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS `rak` (
  `id_rak`           int(11)      NOT NULL AUTO_INCREMENT,
  `nama_rak`         varchar(100) NOT NULL,
  `batas_maksimal_kg` float       NOT NULL,
  PRIMARY KEY (`id_rak`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `rak` (`id_rak`, `nama_rak`, `batas_maksimal_kg`) VALUES
  (1, 'Lantai 1', 2),
  (2, 'Lantai 2', 1)
ON DUPLICATE KEY UPDATE `nama_rak` = VALUES(`nama_rak`), `batas_maksimal_kg` = VALUES(`batas_maksimal_kg`);

-- ---------------------------------------------------------
-- Tabel: operator
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS `operator` (
  `id_user`  int(11)      NOT NULL AUTO_INCREMENT,
  `username` varchar(50)  NOT NULL,
  `password` varchar(255) NOT NULL,
  `role`     varchar(20)  NOT NULL,
  PRIMARY KEY (`id_user`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `operator` (`id_user`, `username`, `password`, `role`) VALUES
  (1, 'SYSTEM', '-', 'SYSTEM'),
  (2, 'admin', '$2b$10$GXkMa4TnbTaitb4V9YOorOjmsfaTcjwtjvoiHNNqEI5nrjzcaP0aC', 'admin')
ON DUPLICATE KEY UPDATE `role` = VALUES(`role`);

-- ---------------------------------------------------------
-- Tabel: data_log
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS `data_log` (
  `id_log`            int(11)     NOT NULL AUTO_INCREMENT,
  `id_rak`            int(11)     NOT NULL,
  `id_user`           int(11)     NOT NULL,
  `timestamp_waktu`   datetime    DEFAULT current_timestamp(),
  `berat_aktual_gram` float       NOT NULL,
  `status_beban`      varchar(20) NOT NULL,
  PRIMARY KEY (`id_log`),
  KEY `id_rak` (`id_rak`),
  KEY `id_user` (`id_user`),
  CONSTRAINT `data_log_ibfk_1` FOREIGN KEY (`id_rak`)  REFERENCES `rak` (`id_rak`),
  CONSTRAINT `data_log_ibfk_2` FOREIGN KEY (`id_user`) REFERENCES `operator` (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------
-- Tabel: FLOOR_CONFIG  (tambahan baru)
-- Menyimpan konfigurasi per lantai:
--   cal_factor  : faktor konversi raw HX711 → kg
--   warning_kg  : batas bawah status PERINGATAN
--   danger_kg   : batas bawah status BAHAYA
--   max_kg      : kapasitas maksimal rak (batas fisik)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS `FLOOR_CONFIG` (
  `id_rak`     int(11) NOT NULL,
  `cal_factor` float   NOT NULL,
  `warning_kg` float   NOT NULL,
  `danger_kg`  float   NOT NULL,
  `max_kg`     float   NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
               ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_rak`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `FLOOR_CONFIG` (`id_rak`, `cal_factor`, `warning_kg`, `danger_kg`, `max_kg`) VALUES
  (1, 359.0, 1.2, 1.6, 2.0),
  (2, 491.0, 0.6, 0.8, 1.0)
ON DUPLICATE KEY UPDATE
  `cal_factor` = VALUES(`cal_factor`),
  `warning_kg` = VALUES(`warning_kg`),
  `danger_kg`  = VALUES(`danger_kg`),
  `max_kg`     = VALUES(`max_kg`);

COMMIT;
