const express = require("express");
const passport = require("passport");
const { isGoogleOAuthConfigured, isGoogleOAuthEnabled } = require("../config/googleEnv");
const { findUserById } = require("../config/db");

const router = express.Router();

function normalizeRole(role) {
  if (role == null) return "";
  if (Buffer.isBuffer(role)) return role.toString().trim().toLowerCase();
  return String(role).trim().toLowerCase();
}

router.get("/auth/google", (_req, res) => res.redirect("/"));

router.get("/auth/google/start", (req, res, next) => {
  if (!isGoogleOAuthEnabled()) return res.redirect("/");
  if (!isGoogleOAuthConfigured()) return res.redirect("/");
  const role = String(req.query.role || "").toLowerCase();
  if (role !== "student") {
    return res.redirect("/auth/unauthorized?reason=google-student-only");
  }
  req.session.oauthIntentRole = role;
  const rawHd = process.env.GOOGLE_OAUTH_HOSTED_DOMAIN;
  let hd = null;
  if (rawHd === "") {
    hd = null;
  } else if (typeof rawHd === "string" && rawHd.trim()) {
    hd = rawHd.trim();
  } else {
    hd = null;
  }
  const authOpts = { scope: ["profile", "email"], prompt: "select_account" };
  if (hd) authOpts.hd = hd;
  req.session.save((err) => {
    if (err) {
      console.error("[oauth] failed to persist OAuth intent:", err.message);
      return next(err);
    }
    return passport.authenticate("google", authOpts)(req, res, next);
  });
});

router.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!isGoogleOAuthEnabled()) return res.redirect("/");
    next();
  },
  passport.authenticate("google", { failureRedirect: "/auth/unauthorized" }),
  async (req, res, next) => {
    try {
      const intent = req.session.oauthIntentRole;
      delete req.session.oauthIntentRole;

      if (!req.user?.id) {
        return res.redirect("/auth/unauthorized");
      }

      const row = await findUserById(req.user.id);
      if (!row) {
        return req.logout(() => res.redirect("/"));
      }

      const expectedRole = intent || normalizeRole(row.role);
      if (!expectedRole) {
        return req.logout(() => res.redirect("/"));
      }

      if (normalizeRole(row.role) !== normalizeRole(expectedRole)) {
        return req.logout(() => res.redirect("/auth/unauthorized?reason=mismatch"));
      }

      req.session.save((err) => {
        if (err) {
          console.error("[oauth] session save:", err.message);
          return next(err);
        }
        return res.redirect("/dashboard/student/dashboard");
      });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
