const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { parse } = require("csv-parse/sync");
const { getPool } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

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

function roleFromEmail(email) {
  if (/@my\.xu\.edu\.ph$/i.test(email)) return "student";
  if (/@xu\.edu\.ph$/i.test(email)) return "counselor";
  return "student";
}

function normalizeHeader(v) {
  return String(v || "").trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
}

function parseCsvBuffer(buffer) {
  const rows = parse(buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true });
  return rows.map((row) => {
    const cleaned = {};
    Object.keys(row).forEach((key) => {
      cleaned[String(key).replace(/^\uFEFF/, "").trim()] = row[key];
    });
    return cleaned;
  });
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

router.get("/mappings", async (_req, res) => {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT id, name, mapping_json, created_at, updated_at FROM import_mapping_profiles ORDER BY updated_at DESC"
  );
  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    mapping: typeof r.mapping_json === "string" ? JSON.parse(r.mapping_json) : r.mapping_json
  }));
  res.json(items);
});

router.post("/mappings", async (req, res) => {
  const { name, mapping } = req.body;
  if (!name || typeof mapping !== "object") return res.status(400).json({ message: "Name and mapping are required." });
  const db = getPool();
  await db.query(
    `INSERT INTO import_mapping_profiles (name, mapping_json, created_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE mapping_json = VALUES(mapping_json), created_by = VALUES(created_by)`,
    [String(name).trim(), JSON.stringify(mapping), req.user.id]
  );
  res.json({ ok: true });
});

router.post("/csv-preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "CSV file is required." });
  let records;
  try {
    records = parseCsvBuffer(req.file.buffer);
  } catch (_err) {
    return res.status(400).json({ message: "Invalid CSV format. Make sure it has a header row." });
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  const suggestedMapping = autoSuggestMapping(headers);
  res.json({
    headers,
    suggestedMapping,
    sampleRows: records.slice(0, 3)
  });
});

router.post("/appointments-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "CSV file is required." });

  let mapping = {};
  if (req.body.mapping) {
    try {
      mapping = JSON.parse(req.body.mapping);
    } catch (_err) {
      return res.status(400).json({ message: "Invalid mapping JSON." });
    }
  }

  let records;
  try {
    records = parseCsvBuffer(req.file.buffer);
  } catch (_err) {
    return res.status(400).json({ message: "Invalid CSV format. Make sure it has a header row." });
  }
  if (records.length === 0) return res.status(400).json({ message: "CSV has no data rows." });

  const headers = Object.keys(records[0]);
  const suggested = autoSuggestMapping(headers);
  const effectiveMapping = {};
  for (const key of CANONICAL_FIELDS) {
    effectiveMapping[key] = mapping[key] || suggested[key] || "";
  }

  const db = getPool();
  let imported = 0;
  let skipped = 0;

  for (const r of records) {
    const valueFrom = (field) => (effectiveMapping[field] ? String(r[effectiveMapping[field]] || "").trim() : "");
    const bookingCode = valueFrom("booking_code");
    const studentEmail = valueFrom("student_email").toLowerCase();
    const counselorEmail = valueFrom("counselor_email").toLowerCase();
    const serviceType = valueFrom("service_type") || "Imported Service";
    const appointmentDate = parseDateToISO(valueFrom("appointment_date"));
    const appointmentTime = parseTimeToHHMM(valueFrom("appointment_time"));
    const status = (valueFrom("status") || "pending").toLowerCase();
    const reason = valueFrom("reason") || null;
    const studentName = valueFrom("student_name");
    const counselorName = valueFrom("counselor_name");

    if (!studentEmail || !counselorEmail || !appointmentDate || !appointmentTime) {
      skipped += 1;
      continue;
    }

    const studentId = await ensureUserByEmail(db, studentEmail, studentName);
    const counselorId = await ensureUserByEmail(db, counselorEmail, counselorName);

    const [existing] = await db.query("SELECT id FROM appointments WHERE booking_code = ? LIMIT 1", [bookingCode]);
    if (existing.length > 0) {
      skipped += 1;
      continue;
    }

    await db.query(
      `INSERT INTO appointments
       (booking_code, student_id, counselor_id, service_type, reason, appointment_date, appointment_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingCode || `IMP-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 99)}`,
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
    "csv_import_appointments",
    JSON.stringify({ imported, skipped, mapping: effectiveMapping })
  ]);

  res.json({ ok: true, imported, skipped, totalRows: records.length, appliedMapping: effectiveMapping });
});

module.exports = router;
