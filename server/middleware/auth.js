const jwt = require("jsonwebtoken");

/** Passport session user (full DB row) → shape used by API handlers */
function mapSessionUser(row) {
  if (!row || row.id == null) return null;
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    name: row.full_name
  };
}

function attachUserFromSession(req) {
  const u = req.user;
  if (!u || typeof u !== "object" || u.id == null) return false;
  if ("full_name" in u) {
    req.user = mapSessionUser(u);
    return true;
  }
  if ("email" in u && "role" in u) {
    req.user = mapSessionUser({ ...u, full_name: u.full_name || u.name || "" });
    return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  if (attachUserFromSession(req)) {
    return next();
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Not authenticated" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "change_this_secret");
    return next();
  } catch (_err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole, mapSessionUser };
