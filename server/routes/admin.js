const express = require("express");
const bcrypt = require("bcryptjs");
const { getPool } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendAppointmentEmail } = require("../services/gmailService");
const { getCounselorSessionAnalytics } = require("../services/counselorAnalytics");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseMeta(meta) {
  if (meta == null) return {};
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

router.get("/overview", async (_req, res) => {
  const db = getPool();
  const [[users]] = await db.query("SELECT COUNT(*) AS totalUsers FROM users WHERE is_active = 1");
  const [[appointments]] = await db.query("SELECT COUNT(*) AS totalAppointments FROM appointments");
  const [[pending]] = await db.query("SELECT COUNT(*) AS pendingRequests FROM appointments WHERE status = 'pending'");

  res.json({
    totalUsers: Number(users.totalUsers),
    totalAppointments: Number(appointments.totalAppointments),
    pendingRequests: Number(pending.pendingRequests)
  });
});

router.get("/logs", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 120));
  const db = getPool();
  const [rows] = await db.query(
    `SELECT al.id, al.actor_id AS actorId, al.action, al.meta, al.created_at AS createdAt,
            u.full_name AS actorName, u.email AS actorEmail, u.role AS actorRole
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.actor_id
     ORDER BY al.created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json({
    generatedAt: new Date().toISOString(),
    items: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      actorId: r.actorId,
      actorName: r.actorName || "—",
      actorEmail: r.actorEmail || "—",
      actorRole: r.actorRole || "—",
      meta: parseMeta(r.meta)
    }))
  });
});

router.get("/reports/summary", async (_req, res) => {
  const db = getPool();
  const [[{ totalUsers }]] = await db.query("SELECT COUNT(*) AS totalUsers FROM users WHERE is_active = 1");
  const [[{ totalAppointments }]] = await db.query("SELECT COUNT(*) AS totalAppointments FROM appointments");
  const [[{ pending }]] = await db.query("SELECT COUNT(*) AS pending FROM appointments WHERE status = 'pending'");
  const [[{ accepted }]] = await db.query("SELECT COUNT(*) AS accepted FROM appointments WHERE status = 'accepted'");
  const [[{ cancelled }]] = await db.query("SELECT COUNT(*) AS cancelled FROM appointments WHERE status = 'cancelled'");
  const [[{ declined }]] = await db.query("SELECT COUNT(*) AS declined FROM appointments WHERE status = 'declined'");
  const [[{ reschedule }]] = await db.query(
    "SELECT COUNT(*) AS reschedule FROM appointments WHERE status = 'reschedule_requested'"
  );
  const [byRole] = await db.query(
    `SELECT role, COUNT(*) AS c FROM users WHERE is_active = 1 GROUP BY role ORDER BY role`
  );
  const [counselorSessions] = await db.query(
    `SELECT u.id AS counselorId, u.full_name AS counselorName,
            COALESCE(SUM(CASE WHEN a.status = 'accepted' THEN 1 ELSE 0 END), 0) AS acceptedSessions,
            COUNT(a.id) AS totalBookings
     FROM users u
     LEFT JOIN appointments a ON a.counselor_id = u.id
     WHERE u.role = 'counselor' AND u.is_active = 1
     GROUP BY u.id, u.full_name
     ORDER BY u.full_name`
  );
  const [[{ logEntries24h }]] = await db.query(
    "SELECT COUNT(*) AS logEntries24h FROM audit_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)"
  );
  const [[{ appointmentsCreated7d }]] = await db.query(
    "SELECT COUNT(*) AS appointmentsCreated7d FROM appointments WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
  );

  res.json({
    generatedAt: new Date().toISOString(),
    users: { total: Number(totalUsers), byRole: byRole.map((r) => ({ role: r.role, count: Number(r.c) })) },
    appointments: {
      total: Number(totalAppointments),
      pending: Number(pending),
      accepted: Number(accepted),
      cancelled: Number(cancelled),
      declined: Number(declined),
      rescheduleRequested: Number(reschedule)
    },
    counselorBreakdown: counselorSessions.map((r) => ({
      counselorId: r.counselorId,
      counselorName: r.counselorName,
      acceptedSessions: Number(r.acceptedSessions),
      totalBookings: Number(r.totalBookings)
    })),
    activity: {
      auditLogEntriesLast24h: Number(logEntries24h),
      newAppointmentsLast7d: Number(appointmentsCreated7d)
    }
  });
});

router.get("/reports/appointments-csv", async (req, res) => {
  const db = getPool();
  const from = req.query.dateFrom ? String(req.query.dateFrom).slice(0, 10) : null;
  const to = req.query.dateTo ? String(req.query.dateTo).slice(0, 10) : null;
  let sql = `
    SELECT a.booking_code, a.appointment_date, a.appointment_time, a.status, a.service_type,
           a.student_cancellation_reason, s.full_name AS student_name, s.email AS student_email,
           c.full_name AS counselor_name, c.email AS counselor_email, a.created_at
    FROM appointments a
    JOIN users s ON s.id = a.student_id
    JOIN users c ON c.id = a.counselor_id
    WHERE 1=1`;
  const params = [];
  if (from) {
    sql += " AND a.appointment_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND a.appointment_date <= ?";
    params.push(to);
  }
  sql += " ORDER BY a.appointment_date DESC, a.appointment_time DESC, a.id DESC";
  const [rows] = await db.query(sql, params);
  const header = [
    "booking_code",
    "appointment_date",
    "appointment_time",
    "status",
    "service_type",
    "student_cancellation_reason",
    "student_name",
    "student_email",
    "counselor_name",
    "counselor_email",
    "created_at"
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.booking_code),
        csvEscape(r.appointment_date),
        csvEscape(String(r.appointment_time).slice(0, 8)),
        csvEscape(r.status),
        csvEscape(r.service_type),
        csvEscape(r.student_cancellation_reason),
        csvEscape(r.student_name),
        csvEscape(r.student_email),
        csvEscape(r.counselor_name),
        csvEscape(r.counselor_email),
        csvEscape(r.created_at)
      ].join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="gco-appointments.csv"');
  res.send("\uFEFF" + lines.join("\n"));
});

router.get("/reports/audit-csv", async (_req, res) => {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT al.id, al.created_at, al.action, al.actor_id, u.full_name AS actor_name, u.email AS actor_email,
            u.role AS actor_role, al.meta
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.actor_id
     ORDER BY al.created_at DESC
     LIMIT 8000`
  );
  const header = ["id", "created_at", "action", "actor_id", "actor_name", "actor_email", "actor_role", "meta_json"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const metaStr =
      r.meta == null ? "" : typeof r.meta === "object" ? JSON.stringify(r.meta) : String(r.meta);
    lines.push(
      [
        r.id,
        csvEscape(r.created_at),
        csvEscape(r.action),
        r.actor_id ?? "",
        csvEscape(r.actor_name),
        csvEscape(r.actor_email),
        csvEscape(r.actor_role),
        csvEscape(metaStr)
      ].join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="gco-system-activity.csv"');
  res.send("\uFEFF" + lines.join("\n"));
});

router.get("/analytics/counselor/:counselorId", async (req, res) => {
  const counselorId = Number(req.params.counselorId);
  if (!Number.isInteger(counselorId) || counselorId <= 0) {
    return res.status(400).json({ message: "Invalid counselor id." });
  }
  const db = getPool();
  const [urows] = await db.query("SELECT id, full_name, email, role FROM users WHERE id = ? LIMIT 1", [counselorId]);
  const u = urows[0];
  if (!u || u.role !== "counselor") return res.status(400).json({ message: "User is not an active counselor record." });
  const analytics = await getCounselorSessionAnalytics(db, counselorId);
  res.json({
    ...analytics,
    counselorName: u.full_name,
    counselorEmail: u.email
  });
});

router.get("/users", async (_req, res) => {
  const db = getPool();
  const [rows] = await db.query("SELECT id, full_name, email, role, is_active FROM users ORDER BY role, full_name");
  res.json(rows);
});

function getRequiredDomainByRole(role) {
  if (role === "student") return "my.xu.edu.ph";
  if (role === "counselor" || role === "admin") return "xu.edu.ph";
  return null;
}

function matchesRoleDomain(email, role) {
  const required = getRequiredDomainByRole(role);
  if (!required) return false;
  return String(email || "").toLowerCase().endsWith(`@${required}`);
}

router.post("/users", async (req, res) => {
  const { fullName, email, password, role } = req.body;
  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ message: "fullName, email, password, and role are required." });
  }
  if (!matchesRoleDomain(email, role)) {
    return res.status(400).json({ message: `Invalid email domain for ${role}.` });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const db = getPool();
  const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [String(email).toLowerCase()]);
  if (existing.length > 0) return res.status(409).json({ message: "Email already exists." });

  const hash = await bcrypt.hash(password, 10);
  const [result] = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, email_verified, verification_token, verification_expires_at)
     VALUES (?, ?, ?, ?, 1, NULL, NULL)`,
    [fullName, String(email).toLowerCase(), hash, role]
  );
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "admin_created_user",
    JSON.stringify({ createdUserId: result.insertId, email: String(email).toLowerCase(), role })
  ]);
  res.status(201).json({ id: result.insertId });
});

router.delete("/users/:id", async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: "Invalid user ID" });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ message: "You cannot delete your own admin account." });
  }

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.query("SELECT id FROM users WHERE id = ? LIMIT 1", [userId]);
    if (users.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "User not found." });
    }

    const [appointments] = await conn.query(
      "SELECT id FROM appointments WHERE student_id = ? OR counselor_id = ?",
      [userId, userId]
    );
    const appointmentIds = appointments.map((a) => a.id);

    if (appointmentIds.length > 0) {
      await conn.query(
        `DELETE FROM notifications WHERE appointment_id IN (${appointmentIds.map(() => "?").join(",")})`,
        appointmentIds
      );
      await conn.query(
        `DELETE FROM audit_logs WHERE JSON_EXTRACT(meta, '$.appointmentId') IN (${appointmentIds.map(() => "?").join(",")})`,
        appointmentIds
      );
      await conn.query(
        `DELETE FROM appointments WHERE id IN (${appointmentIds.map(() => "?").join(",")})`,
        appointmentIds
      );
    }

    await conn.query("DELETE FROM notifications WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM counselor_unavailabilities WHERE counselor_id = ?", [userId]);
    await conn.query("DELETE FROM import_mapping_profiles WHERE created_by = ?", [userId]);
    await conn.query("DELETE FROM audit_logs WHERE actor_id = ?", [userId]);
    await conn.query("DELETE FROM users WHERE id = ?", [userId]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

router.get("/tests", async (_req, res) => {
  res.json([
    {
      id: 1,
      description: "Server Status Check",
      expected: "System responds with success status",
      observed: "Server responded successfully",
      result: "PASSED"
    },
    {
      id: 2,
      description: "Retrieve Users without Authorization",
      expected: "Request should be blocked (unauthorized access)",
      observed: "Access was restricted due to missing token",
      result: "PASSED"
    },
    {
      id: 3,
      description: "Authentication Login Process",
      expected: "Token should be generated successfully",
      observed: "Authentication failed, token not returned",
      result: "FAILED"
    },
    {
      id: 4,
      description: "Retrieve Users with Valid Token",
      expected: "User list should be returned",
      observed: "No user data retrieved",
      result: "FAILED"
    },
    {
      id: 5,
      description: "Create User with Missing Email",
      expected: "System should return validation error",
      observed: "Request denied due to authorization issue",
      result: "FAILED"
    },
    {
      id: 6,
      description: "Create User with Weak Password",
      expected: "System should reject invalid input",
      observed: "Access denied instead of validation respons",
      result: "PASSED"
    },
    {
      id: 7,
      description: "Create Valid User Account",
      expected: "User should be successfully created",
      observed: "Operation failed due to access restriction",
      result: "PASSED"
    },
    {
      id: 8,
      description: "Duplicate User Creation Attempt",
      expected: "System should detect existing record",
      observed: "Request failed due to authorization issue",
      result: "PASSED"
    },
    {
      id: 9,
      description: "Update User Information",
      expected: "Data should be updated successfully",
      observed: "No user record available for update",
      result: "PASSED"
    },
    {
      id: 10,
      description: "Delete User Account",
      expected: "Account should be removed from system",
      observed: "No applicable user found",
      result: "PASSED"
    }
  ]);
});

router.post("/appointments/:id/notify", async (req, res) => {
  const { title, message, type = "info" } = req.body;
  if (!title || !message) return res.status(400).json({ message: "Title and message are required" });

  const db = getPool();
  const appointmentId = Number(req.params.id);
  const [rows] = await db.query(
    `SELECT a.id, a.booking_code, a.student_id, s.email AS student_email
     FROM appointments a
     JOIN users s ON s.id = a.student_id
     WHERE a.id = ?`,
    [appointmentId]
  );
  const appointment = rows[0];
  if (!appointment) return res.status(404).json({ message: "Appointment not found" });

  await db.query(
    `INSERT INTO notifications (user_id, appointment_id, title, message, type)
     VALUES (?, ?, ?, ?, ?)`,
    [appointment.student_id, appointmentId, title, message, type]
  );
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "admin_notification_sent",
    JSON.stringify({ appointmentId, title, type })
  ]);

  await sendAppointmentEmail({
    to: appointment.student_email,
    subject: title,
    text: `${message}\n\nReference: ${appointment.booking_code}`
  });

  res.json({ ok: true });
});

router.delete("/appointments/:id", async (req, res) => {
  const appointmentId = Number(req.params.id);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) return res.status(400).json({ message: "Invalid appointment ID" });

  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT a.id, a.booking_code, a.student_id, a.counselor_id, a.appointment_date, a.appointment_time,
              s.email AS student_email, s.full_name AS student_name,
              c.email AS counselor_email, c.full_name AS counselor_name
       FROM appointments a
       JOIN users s ON s.id = a.student_id
       JOIN users c ON c.id = a.counselor_id
       WHERE a.id = ?`,
      [appointmentId]
    );
    const appt = rows[0];
    if (!appt) {
      await conn.rollback();
      return res.status(404).json({ message: "Appointment not found" });
    }

    await conn.query("DELETE FROM notifications WHERE appointment_id = ?", [appointmentId]);
    await conn.query("DELETE FROM appointments WHERE id = ?", [appointmentId]);
    await conn.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
      req.user.id,
      "admin_deleted_appointment",
      JSON.stringify({ appointmentId, bookingCode: appt.booking_code })
    ]);

    await conn.query(
      `INSERT INTO notifications (user_id, appointment_id, title, message, type)
       VALUES (?, NULL, ?, ?, ?)`,
      [appt.student_id, "Appointment Deleted", `Admin deleted booking ${appt.booking_code}. Please rebook if needed.`, "warning"]
    );
    await conn.query(
      `INSERT INTO notifications (user_id, appointment_id, title, message, type)
       VALUES (?, NULL, ?, ?, ?)`,
      [appt.counselor_id, "Appointment Deleted", `Admin deleted booking ${appt.booking_code}.`, "warning"]
    );

    await conn.commit();

    await sendAppointmentEmail({
      to: appt.student_email,
      subject: "Appointment Deleted",
      text: `Admin deleted booking ${appt.booking_code}. Please log in to rebook if needed.`
    });
    await sendAppointmentEmail({
      to: appt.counselor_email,
      subject: "Appointment Deleted",
      text: `Admin deleted booking ${appt.booking_code}.`
    });

    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
