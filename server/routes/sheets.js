const express = require("express");
const { google } = require("googleapis");
const bcrypt = require("bcryptjs");
const { getPool } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const CANONICAL_FIELDS = [
  "booking_code",
  "student_email",
  "student_name",
  "counselor_email",
  "counselor_name",
  "service_type",
  "appointment_date",
  "appointment_time",
  "status",
  "reason"
];

const HEADER_ALIASES = {
  booking_code: ["booking_code", "booking code", "bookingid", "booking id", "reference", "reference no", "reference number", "ref_no"],
  student_email: ["student_email", "student email", "student_mail", "email", "student e-mail"],
  student_name: ["student_name", "student name", "name", "full_name", "student full name"],
  counselor_email: ["counselor_email", "counselor email", "counsellor email", "advisor_email", "staff_email"],
  counselor_name: ["counselor_name", "counselor name", "counsellor name", "advisor_name"],
  service_type: ["service_type", "service type", "service", "concern_type", "session_type"],
  appointment_date: ["appointment_date", "appointment date", "date", "schedule_date"],
  appointment_time: ["appointment_time", "appointment time", "time", "schedule_time"],
  status: ["status", "booking_status", "appointment_status"],
  reason: ["reason", "concern", "notes", "remarks", "description"]
};

function normalizeHeader(v) {
  return String(v || "").trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
}

function autoSuggestMapping(headers) {
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  for (const field of CANONICAL_FIELDS) {
    const aliases = (HEADER_ALIASES[field] || []).map(normalizeHeader);
    const found = normalizedHeaders.find((h) => aliases.includes(h.norm));
    mapping[field] = found ? found.raw : "";
  }
  return mapping;
}

function parseDateToISO(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseTimeToHHMM(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw.slice(0, 5);
  const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!ampm) return null;
  let hour = Number(ampm[1]);
  const minute = Number(ampm[2]);
  const period = ampm[3].toUpperCase();
  if (hour === 12) hour = 0;
  if (period === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function roleFromEmail(email) {
  if (/@my\.xu\.edu\.ph$/i.test(email)) return "student";
  if (/@xu\.edu\.ph$/i.test(email)) return "counselor";
  return "student";
}

async function ensureUserByEmail(db, email, fallbackName) {
  const [rows] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
  if (rows[0]) return rows[0].id;
  const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(2) + Date.now(), 10);
  const role = roleFromEmail(email);
  const fullName = fallbackName || (role === "counselor" ? "Imported Counselor" : "Imported Student");
  const [result] = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, is_active, email_verified)
     VALUES (?, ?, ?, ?, 1, 1)`,
    [fullName, email.toLowerCase(), passwordHash, role]
  );
  return result.insertId;
}

async function getSheetsClient() {
  if (process.env.GOOGLE_API_KEY) {
    return google.sheets({ version: "v4", auth: process.env.GOOGLE_API_KEY });
  }
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  const creds = JSON.parse(json);
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key, [
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]);
  return google.sheets({ version: "v4", auth });
}

router.post("/sync", async (req, res) => {
  const { spreadsheetId, range } = req.body;
  if (!spreadsheetId || !range) return res.status(400).json({ message: "spreadsheetId and range are required." });

  const sheets = await getSheetsClient();
  if (!sheets) {
    return res.status(400).json({
      message: "Google Sheets credentials not configured. Set GOOGLE_API_KEY (public sheet) or GOOGLE_SERVICE_ACCOUNT_JSON (service account)."
    });
  }

  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = resp.data.values || [];
  if (values.length < 2) return res.json({ ok: true, imported: 0, skipped: 0, message: "No data rows found." });

  const headers = values[0].map((h) => String(h || "").trim());
  const mapping = autoSuggestMapping(headers);
  const rows = values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] ?? "";
    });
    return obj;
  });

  const valueFrom = (row, field) => (mapping[field] ? String(row[mapping[field]] || "").trim() : "");

  const db = getPool();
  let imported = 0;
  let skipped = 0;

  for (const r of rows) {
    const bookingCode = valueFrom(r, "booking_code");
    const studentEmail = valueFrom(r, "student_email").toLowerCase();
    const counselorEmail = valueFrom(r, "counselor_email").toLowerCase();
    const serviceType = valueFrom(r, "service_type") || "Imported Service";
    const appointmentDate = parseDateToISO(valueFrom(r, "appointment_date"));
    const appointmentTime = parseTimeToHHMM(valueFrom(r, "appointment_time"));
    const status = (valueFrom(r, "status") || "pending").toLowerCase();
    const reason = valueFrom(r, "reason") || null;
    const studentName = valueFrom(r, "student_name");
    const counselorName = valueFrom(r, "counselor_name");

    if (!studentEmail || !counselorEmail || !appointmentDate || !appointmentTime) {
      skipped += 1;
      continue;
    }

    const studentId = await ensureUserByEmail(db, studentEmail, studentName);
    const counselorId = await ensureUserByEmail(db, counselorEmail, counselorName);

    if (bookingCode) {
      const [existing] = await db.query("SELECT id FROM appointments WHERE booking_code = ? LIMIT 1", [bookingCode]);
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }
    }

    await db.query(
      `INSERT INTO appointments
       (booking_code, student_id, counselor_id, service_type, reason, appointment_date, appointment_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingCode || `GS-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 99)}`,
        studentId,
        counselorId,
        serviceType,
        reason,
        appointmentDate,
        appointmentTime,
        ["pending", "accepted", "declined", "cancelled", "reschedule_requested"].includes(status) ? status : "pending"
      ]
    );
    imported += 1;
  }

  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "google_sheets_sync",
    JSON.stringify({ spreadsheetId, range, imported, skipped })
  ]);

  res.json({ ok: true, imported, skipped, totalRows: rows.length });
});

module.exports = router;

