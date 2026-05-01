const util = require("util");
const passport = require("passport");
const GoogleStrategyBase = require("passport-google-oauth20").Strategy;

const {
  findUserByEmail,
  createUser,
  findUserById,
  linkGoogleAccount
} = require("./db");
const { isAllowedGoogleDomain } = require("./roles");

/** Subclass so `prompt` (e.g. select_account) is forwarded to Google's authorize URL */
function GoogleStrategy(options, verify) {
  GoogleStrategyBase.call(this, options, verify);
}
util.inherits(GoogleStrategy, GoogleStrategyBase);
GoogleStrategy.prototype.authorizationParams = function (options) {
  const params = Object.assign({}, GoogleStrategyBase.prototype.authorizationParams.call(this, options));
  if (options.prompt) params.prompt = options.prompt;
  if (options.accessType) params.access_type = options.accessType;
  if (options.hd) params.hd = options.hd;
  return params;
};

const appBase = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      callbackURL: `${appBase}/auth/google/callback`
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const rawEmail = profile.emails?.[0]?.value;
        if (!rawEmail) {
          return done(null, false, { message: "Google did not return an email address." });
        }
        const email = String(rawEmail).trim().toLowerCase();
        const googleId = profile.id;
        const name = profile.displayName || email.split("@")[0];

        if (!isAllowedGoogleDomain(email)) {
          return done(null, false, { message: "Only @my.xu.edu.ph and @xu.edu.ph accounts are allowed." });
        }

        let user = await findUserByEmail(email);
        if (!user) {
          user = await createUser({ email, name, role: "student", google_id: googleId });
          user = await findUserById(user.id);
        } else {
          await linkGoogleAccount(user.id, googleId);
          user = await findUserById(user.id);
        }

        if (!user || !user.is_active) {
          return done(null, false, { message: "This account is inactive." });
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    done(null, user || false);
  } catch (err) {
    done(err, null);
  }
});
