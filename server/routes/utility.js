const express = require("express");
const { getPool } = require("../config/db");

const router = express.Router();

router.get("/counselors", async (req, res) => {
  const { date } = req.query;
  const db = getPool();
  let query = `
    SELECT id, full_name AS name, email
    FROM users
    WHERE role = 'counselor' AND is_active = 1 AND email_verified = 1
  `;
  const params = [];
  if (date) {
    query += `
      AND id NOT IN (
        SELECT counselor_id FROM counselor_unavailabilities WHERE unavailable_date = ?
      )
    `;
    params.push(date);
  }
  query += ` ORDER BY full_name`;
  const [rows] = await db.query(query, params);
  res.json(rows);
});

module.exports = router;
