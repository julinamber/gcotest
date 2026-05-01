const nodemailer = require("nodemailer");

function getAllowedDomains() {
  const raw = String(process.env.NOTIFICATION_ALLOWED_DOMAINS || "my.xu.edu.ph,xu.edu.ph");
  return raw
    .split(/[,\s;]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isAllowedRecipient(email) {
  const normalized = normalizeEmailAddress(email);
  if (!normalized || !normalized.includes("@")) return false;
  const domain = normalized.split("@").pop();
  return getAllowedDomains().includes(domain);
}

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    port === 465;

  const hasAuth = Boolean(process.env.SMTP_USER) && Boolean(process.env.SMTP_PASS);
  const host = String(process.env.SMTP_HOST || "").toLowerCase();
  const requiresAuth = host.includes("gmail.com") || host.includes("googlemail.com");

  if (requiresAuth && !hasAuth) {
    console.error("[email] SMTP_USER / SMTP_PASS are required for Gmail SMTP.");
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
    ...(hasAuth
      ? {
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        }
      : {})
  });
}

async function sendAppointmentEmail({ to, subject, text, html }) {
  if (!to) return;
  if (!isAllowedRecipient(to)) {
    console.warn("[email] skipped non-XU recipient:", to);
    return;
  }
  const transporter = getTransporter();
  if (!transporter) {
    console.log("[email] stub (no SMTP_HOST):", { to, subject });
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || "noreply@xu.edu.ph",
      to,
      subject,
      text,
      ...(html ? { html } : {})
    });
  } catch (err) {
    console.error("[email] send failed:", err.message);
  }
}

async function sendVerificationEmail({ to, verifyUrl }) {
  const subject = "Verify your XU GCO account";
  const text = `Welcome to the XU GCO Appointment System.\n\nPlease verify your email by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours.`;
  await sendAppointmentEmail({ to, subject, text });
}

module.exports = { sendAppointmentEmail, sendVerificationEmail };
