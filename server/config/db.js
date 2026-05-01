const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "", 
      database: process.env.DB_NAME || "gco_appointments",
      waitForConnections: true,
      connectionLimit: 10
    });
  }
  return pool;
}

module.exports = { getPool };

async function initDb() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('student','counselor','admin') NOT NULL,
      is_active TINYINT(1) DEFAULT 1,
      email_verified TINYINT(1) DEFAULT 0,
      verification_token VARCHAR(128) NULL,
      verification_expires_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn(db, "users", "email_verified", "ALTER TABLE users ADD COLUMN email_verified TINYINT(1) DEFAULT 0");
  await ensureColumn(db, "users", "verification_token", "ALTER TABLE users ADD COLUMN verification_token VARCHAR(128) NULL");
  await ensureColumn(db, "users", "verification_expires_at", "ALTER TABLE users ADD COLUMN verification_expires_at DATETIME NULL");
  await ensureColumn(db, "users", "profile_picture", "ALTER TABLE users ADD COLUMN profile_picture VARCHAR(255) NULL");
  await ensureColumn(db, "users", "auth_provider", "ALTER TABLE users ADD COLUMN auth_provider VARCHAR(20) NULL");
  await ensureColumn(db, "users", "google_id", "ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL");
  await ensurePasswordHashNullable(db);

  await db.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      booking_code VARCHAR(25) UNIQUE,
      student_id INT NOT NULL,
      counselor_id INT NOT NULL,
      service_type VARCHAR(120) NOT NULL,
      reason TEXT,
      student_cancellation_reason TEXT NULL,
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      status ENUM('pending','accepted','declined','cancelled','reschedule_requested') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES users(id),
      FOREIGN KEY (counselor_id) REFERENCES users(id)
    )
  `);

  await ensureColumn(
    db,
    "appointments",
    "student_cancellation_reason",
    "ALTER TABLE appointments ADD COLUMN student_cancellation_reason TEXT NULL"
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      actor_id INT,
      action VARCHAR(200) NOT NULL,
      meta JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      appointment_id INT NULL,
      title VARCHAR(180) NOT NULL,
      message TEXT NOT NULL,
      type ENUM('info','success','warning','action') DEFAULT 'info',
      is_read TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (appointment_id) REFERENCES appointments(id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS import_mapping_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE,
      mapping_json JSON NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS counselor_unavailabilities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      counselor_id INT NOT NULL,
      unavailable_date DATE NOT NULL,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (counselor_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY unique_counselor_date (counselor_id, unavailable_date)
    )
  `);

  const [rows] = await db.query("SELECT COUNT(*) AS total FROM users");
  if (rows[0].total === 0) {
    const [s, c, a] = await Promise.all([
      bcrypt.hash("student123", 10),
      bcrypt.hash("counselor123", 10),
      bcrypt.hash("admin123", 10)
    ]);

    await db.query(
      `INSERT INTO users (full_name, email, password_hash, role, email_verified) VALUES
      ('Juan Dela Cruz', 'student@my.xu.edu.ph', ?, 'student', 1),
      ('Ma. Angela Reyes', 'counselor@xu.edu.ph', ?, 'counselor', 1),
      ('Help Desk Admin', 'admin@xu.edu.ph', ?, 'admin', 1)`,
      [s, c, a]
    );
  }

  await db.query("UPDATE users SET email_verified = 1 WHERE email IN ('student@my.xu.edu.ph','counselor@xu.edu.ph','admin@xu.edu.ph')");
  await db.query("UPDATE users SET verification_token = NULL, verification_expires_at = NULL WHERE email_verified = 1");
}

async function ensureColumn(db, tableName, columnName, addSql) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName]
  );
  if (rows[0].total === 0) await db.query(addSql);
}

async function ensurePasswordHashNullable(db) {
  const [rows] = await db.query(
    `SELECT IS_NULLABLE AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'password_hash'`
  );
  if (rows[0] && rows[0].n === "NO") {
    await db.query("ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL");
  }
}

module.exports = { getPool, initDb };
const db = getPool();

// 🔍 Find user by email (for Google login)
async function findUserByEmail(email) {
  const [rows] = await db.query("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [email]);
  return rows[0];
}

// 🔍 Find user by ID (for sessions)
async function findUserById(id) {
  const [rows] = await db.query(
    "SELECT * FROM users WHERE id = ?",
    [id]
  );
  return rows[0];
}

// ➕ Create user from Google OAuth (no password)
async function createUser({ email, name, role, google_id }) {
  if (!google_id) {
    throw new Error("OAuth user must include google_id");
  }
  const [result] = await db.query(
    `INSERT INTO users (full_name, email, role, auth_provider, google_id, email_verified)
     VALUES (?, ?, ?, 'google', ?, 1)`,
    [name, email, role, google_id]
  );

  return {
    id: result.insertId,
    email,
    full_name: name,
    name,
    role,
    google_id
  };
}

async function linkGoogleAccount(userId, googleId) {
  await db.query(
    `UPDATE users SET google_id = ?, auth_provider = 'google', email_verified = 1 WHERE id = ?`,
    [googleId, userId]
  );
}

module.exports.findUserByEmail = findUserByEmail;
module.exports.findUserById = findUserById;
module.exports.createUser = createUser;
module.exports.linkGoogleAccount = linkGoogleAccount;