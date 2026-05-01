/**
 * Maps XU Google Workspace email to application role.
 * @my.xu.edu.ph → student
 * @xu.edu.ph → admin if email is listed in ADMIN_EMAILS, otherwise counselor
 */

function parseAdminEmailSet() {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function roleFromGoogleEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (e.endsWith("@my.xu.edu.ph")) return "student";
  if (e.endsWith("@xu.edu.ph")) {
    const admins = parseAdminEmailSet();
    if (admins.has(e)) return "admin";
    return "counselor";
  }
  return null;
}

function isAllowedGoogleDomain(email) {
  return roleFromGoogleEmail(email) !== null;
}

module.exports = { roleFromGoogleEmail, isAllowedGoogleDomain, parseAdminEmailSet };
