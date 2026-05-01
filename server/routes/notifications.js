const express = require("express");
const { getPool } = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/my", async (req, res) => {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, appointment_id, title, message, type, is_read, created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.patch("/:id/read", async (req, res) => {
  const db = getPool();
  const notificationId = Number(req.params.id);
  const [rows] = await db.query("SELECT id FROM notifications WHERE id = ? AND user_id = ?", [notificationId, req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: "Notification not found" });
  await db.query("UPDATE notifications SET is_read = 1 WHERE id = ?", [notificationId]);
  res.json({ ok: true });
});

module.exports = router;
