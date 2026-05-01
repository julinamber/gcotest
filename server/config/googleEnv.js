/**
 * Optional Google OAuth (set ENABLE_GOOGLE_OAUTH=true and configure Client ID/secret).
 * Default: off — users sign in with XU email + password only.
 */
function isGoogleOAuthEnabled() {
  const v = String(process.env.ENABLE_GOOGLE_OAUTH || "false").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function isGoogleOAuthConfigured() {
  const id = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const secret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!id || !secret) return false;

  const idLower = id.toLowerCase();
  const secretLower = secret.toLowerCase();
  const placeholder =
    /your_google|your_google_client|client_id_here|secret_here|replace_me|changeme|example\.com|^xxx/i;
  if (placeholder.test(idLower) || placeholder.test(secretLower)) return false;

  return true;
}

module.exports = { isGoogleOAuthConfigured, isGoogleOAuthEnabled };
