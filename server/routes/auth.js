const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const { getPool } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const { isGoogleOAuthEnabled, isGoogleOAuthConfigured } = require("../config/googleEnv");
const { sendVerificationEmail } = require("../services/gmailService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

function allowPasswordLogin() {
  const v = String(process.env.ALLOW_PASSWORD_LOGIN || "true").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

router.get("/providers", (_req, res) => {
  res.json({
    password: allowPasswordLogin(),
    google: isGoogleOAuthEnabled() && isGoogleOAuthConfigured()
  });
});

function getRequiredDomainByRole(role) {
  if (role === "student") return "my.xu.edu.ph";
  if (role === "counselor" || role === "admin") return "xu.edu.ph";
  return null;
}

function matchesRoleDomain(email, role) {
  const required = getRequiredDomainByRole(role);
  if (!required) return false;
  return email.toLowerCase().endsWith(`@${required}`);
}

router.post("/login", async (req, res) => {
  if (!allowPasswordLogin()) {
    return res.status(403).json({
      message:
        "Password sign-in is disabled. Set ALLOW_PASSWORD_LOGIN=true in .env, or enable Microsoft / Google SSO in .env."
    });
  }
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ message: "Missing required fields" });
  if (role === "student") {
    return res.status(403).json({ message: "Student sign-in is Google-only. Use Continue with Google." });
  }
  if (!["counselor", "admin"].includes(role)) {
    return res.status(400).json({ message: "Invalid role for manual sign-in." });
  }
  if (!matchesRoleDomain(email, role)) {
    const required = getRequiredDomainByRole(role);
    return res.status(400).json({ message: `Invalid email domain for ${role}. Use @${required}.` });
  }

  const db = getPool();
  const [rows] = await db.query(
    "SELECT id, full_name, email, password_hash, role, is_active, email_verified FROM users WHERE email = ?",
    [email]
  );
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ message: "Invalid credentials" });
  if (user.role !== role) return res.status(403).json({ message: "Role mismatch for this account" });
  if (!user.email_verified) {
    return res.status(403).json({ message: "Please verify your email before logging in." });
  }
  if (!user.password_hash) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    user.id,
    "user_login",
    JSON.stringify({ email: user.email, role: user.role })
  ]);

  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.full_name, email: user.email },
    process.env.JWT_SECRET || "change_this_secret",
    { expiresIn: "8h" }
  );

  return res.json({
    token,
    user: { id: user.id, role: user.role, name: user.full_name, email: user.email }
  });
});

router.post("/signup", async (req, res) => {
  const { fullName, email, password, role } = req.body || {};
  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ message: "fullName, email, password, and role are required." });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = String(role).trim().toLowerCase();
  if (!["counselor", "admin"].includes(normalizedRole)) {
    return res.status(400).json({ message: "Only counselor/admin can sign up manually." });
  }
  if (!matchesRoleDomain(normalizedEmail, normalizedRole)) {
    return res.status(400).json({ message: "Counselor/Admin sign-up requires @xu.edu.ph email." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const db = getPool();
  const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
  if (existing.length) return res.status(409).json({ message: "Email already exists." });

  const passwordHash = await bcrypt.hash(password, 10);
  const verificationToken = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [out] = await db.query(
    `INSERT INTO users
      (full_name, email, password_hash, role, is_active, email_verified, verification_token, verification_expires_at, auth_provider)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'local')`,
    [String(fullName).trim(), normalizedEmail, passwordHash, normalizedRole, verificationToken, expiresAt]
  );

  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const verifyUrl = `${base}/api/auth/verify?token=${encodeURIComponent(verificationToken)}`;
  await sendVerificationEmail({ to: normalizedEmail, verifyUrl });

  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    out.insertId,
    "manual_signup_pending_verification",
    JSON.stringify({ email: normalizedEmail, role: normalizedRole })
  ]);

  return res.status(201).json({ ok: true, message: "Sign-up successful. Check your email to verify your account." });
});

router.get("/verify", async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).send("Missing verification token.");
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, email, verification_expires_at
     FROM users
     WHERE verification_token = ?
     LIMIT 1`,
    [token]
  );
  const user = rows[0];
  if (!user) return res.status(400).send("Invalid verification token.");
  const exp = new Date(user.verification_expires_at);
  if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
    return res.status(400).send("Verification token has expired.");
  }

  await db.query(
    "UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires_at = NULL WHERE id = ?",
    [user.id]
  );

  return res.redirect("/?verified=1");
});

router.get("/me", requireAuth, async (req, res) => {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT id, full_name, email, role, profile_picture, auth_provider, password_hash FROM users WHERE id = ? LIMIT 1",
    [req.user.id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json({
    id: user.id,
    name: user.full_name,
    email: user.email,
    role: user.role,
    profilePicture: user.profile_picture || "",
    authProvider: user.auth_provider || null,
    hasPassword: Boolean(user.password_hash)
  });
});

router.patch("/me/profile", requireAuth, async (req, res) => {
  const { fullName } = req.body;
  const db = getPool();
  await db.query(
    "UPDATE users SET full_name = COALESCE(?, full_name) WHERE id = ?",
    [fullName || null, req.user.id]
  );
  res.json({ ok: true });
});

router.post("/me/profile-picture", requireAuth, upload.single("profilePicture"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Image file is required." });
  const ext = path.extname(req.file.originalname || "").toLowerCase() || ".png";
  const safeExt = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? ext : ".png";
  const fileName = `user-${req.user.id}-${Date.now()}${safeExt}`;
  const uploadDir = path.join(process.cwd(), "assets", "uploads");
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, fileName), req.file.buffer);
  const relativePath = `assets/uploads/${fileName}`;

  const db = getPool();
  await db.query("UPDATE users SET profile_picture = ? WHERE id = ?", [relativePath, req.user.id]);
  res.json({ ok: true, profilePicture: relativePath });
});

router.patch("/me/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: "currentPassword and newPassword are required." });
  if (String(newPassword).length < 8) return res.status(400).json({ message: "New password must be at least 8 characters." });

  const db = getPool();
  const [rows] = await db.query(
    "SELECT password_hash, auth_provider FROM users WHERE id = ? LIMIT 1",
    [req.user.id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ message: "User not found." });
  if (!user.password_hash) {
    return res.status(400).json({
      message:
        "No password is set for this account. Sign in with Microsoft or Google (if enabled), or ask an administrator to set a password."
    });
  }
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Current password is incorrect." });

  const hash = await bcrypt.hash(newPassword, 10);
  await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
  res.json({ ok: true });
});

router.delete("/me", requireAuth, async (req, res) => {
  const db = getPool();
  await db.query("UPDATE users SET is_active = 0 WHERE id = ?", [req.user.id]);
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "user_deactivated_own_account",
    JSON.stringify({ userId: req.user.id })
  ]);
  res.json({ ok: true });
});

module.exports = router;
