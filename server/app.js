console.log("Running from:", __dirname);
require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const passport = require("passport");

const { initDb } = require("./config/db");
const { isGoogleOAuthConfigured, isGoogleOAuthEnabled } = require("./config/googleEnv");
require("./config/passport");

const authRoutes = require("./routes/auth");
const oauthRoutes = require("./routes/oauth");
const appointmentRoutes = require("./routes/appointments");
const adminRoutes = require("./routes/admin");
const counselorRoutes = require("./routes/counselor");
const utilityRoutes = require("./routes/utility");
const notificationRoutes = require("./routes/notifications");
const importRoutes = require("./routes/import");
const sheetsRoutes = require("./routes/sheets");

const app = express();
const PORT = process.env.PORT || 3000;

// Required for secure cookies behind reverse proxies (Render, Nginx, etc.)
app.set("trust proxy", 1);

const sessionName = process.env.SESSION_COOKIE_NAME || "gco.sid";
const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdn.jsdelivr.net", "https://www.gstatic.com"],
        "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "connect-src": ["'self'", "https://www.googleapis.com"]
      }
    }
  })
);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true
  })
);
app.use(express.json());
app.use(morgan("dev"));

app.use(
  session({
    name: sessionName,
    secret: process.env.SESSION_SECRET || "change_session_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: sessionMaxAgeMs,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.SESSION_COOKIE_SECURE === "true"
    }
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use(oauthRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "xu-gco-api" });
});

app.get("/", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/dashboard");
  res.sendFile(path.join(process.cwd(), "index.html"));
});

/** SPA: any /dashboard or /dashboard/role/section serves the same shell */
app.get(/^\/dashboard(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

/** Old Google setup page was removed; bookmarks still hit this URL. */
app.get("/oauth-setup.html", (_req, res) => {
  res.redirect(302, "/");
});

app.get("/auth/unauthorized", (_req, res) => {
  res.status(403).sendFile(path.join(process.cwd(), "unauthorized.html"));
});

app.get("/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) console.error("[auth] logout:", err.message);
    req.session.destroy((e) => {
      if (e) console.error("[auth] session destroy:", e.message);
      res.clearCookie(sessionName, { path: "/" });
      res.redirect("/");
    });
  });
});

app.use(
  express.static(process.cwd(), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    }
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/counselor", counselorRoutes);
app.use("/api/utility", utilityRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/import", importRoutes);
app.use("/api/sheets", sheetsRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

async function startServerWithRetry() {
  const maxRetries = Number(process.env.DB_CONNECT_RETRIES || 20);
  const retryDelayMs = Number(process.env.DB_CONNECT_RETRY_DELAY_MS || 3000);

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await initDb();
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        const bits = ["XU email + password (JWT)"];
        if (isGoogleOAuthEnabled()) {
          console.log("[routes] Optional Google OAuth: /auth/google/start?role=...");
          if (!isGoogleOAuthConfigured()) {
            console.warn("[auth] ENABLE_GOOGLE_OAUTH=true but GOOGLE_CLIENT_ID / SECRET are missing or placeholders.");
          } else bits.push("Google");
        }
        console.log(`[auth] Sign-in: ${bits.join(", ")}.`);
      });
      return;
    } catch (err) {
      const isLast = attempt === maxRetries;
      console.error(`DB init attempt ${attempt}/${maxRetries} failed:`, err.message);
      if (isLast) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

startServerWithRetry();
