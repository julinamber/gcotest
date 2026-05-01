/**
 * Session counts = appointments with status "accepted" (approved counseling sessions).
 */

function buildLast30DaysSeries(dayRows) {
  const map = {};
  for (const r of dayRows) {
    const key = String(r.d).slice(0, 10);
    map[key] = Number(r.cnt);
  }
  const out = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({
      date: iso,
      label: d.toLocaleDateString("en-PH", { month: "short", day: "numeric" }),
      sessions: map[iso] || 0
    });
  }
  return out;
}

function buildLast12MonthsSeries(monthRows) {
  const map = {};
  for (const r of monthRows) {
    map[r.ym] = Number(r.cnt);
  }
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({
      yearMonth: ym,
      label: d.toLocaleString("en-PH", { month: "short", year: "numeric" }),
      sessions: map[ym] || 0
    });
  }
  return out;
}

async function getCounselorSessionAnalytics(db, counselorId) {
  const id = Number(counselorId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [[weekRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEARWEEK(appointment_date, 1) = YEARWEEK(CURDATE(), 1)`,
    [id]
  );
  const [[monthRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEAR(appointment_date) = YEAR(CURDATE())
       AND MONTH(appointment_date) = MONTH(CURDATE())`,
    [id]
  );
  const [[yearRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEAR(appointment_date) = YEAR(CURDATE())`,
    [id]
  );

  const [dayRows] = await db.query(
    `SELECT DATE_FORMAT(appointment_date, '%Y-%m-%d') AS d, COUNT(*) AS cnt
     FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND appointment_date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
     GROUP BY DATE_FORMAT(appointment_date, '%Y-%m-%d')
     ORDER BY d ASC`,
    [id]
  );

  const [monthRows] = await db.query(
    `SELECT DATE_FORMAT(appointment_date, '%Y-%m') AS ym, COUNT(*) AS cnt
     FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND appointment_date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
     GROUP BY ym
     ORDER BY ym ASC`,
    [id]
  );

  const chart30Days = buildLast30DaysSeries(dayRows);
  const chart12Months = buildLast12MonthsSeries(monthRows);

  const w = Number(weekRow.c);
  const m = Number(monthRow.c);
  const y = Number(yearRow.c);

  return {
    counselorId: id,
    weekly: w,
    monthly: m,
    yearly: y,
    sessionsWeekly: w,
    sessionsMonthly: m,
    sessionsYearly: y,
    chart30Days,
    chart12Months
  };
}

module.exports = { getCounselorSessionAnalytics };
