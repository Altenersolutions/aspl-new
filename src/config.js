require("dotenv").config();

const isProd = process.env.NODE_ENV === "production";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const config = {
  isProd,
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI || (isProd ? required("MONGO_URI") : "mongodb://127.0.0.1:27017/inventory"),
  // No hardcoded fallback: the server refuses to start without a secret.
  jwtSecret: process.env.JWT_SECRET || required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // Bootstrap admin is only created by the seed script / first-run when no users exist.
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || "",
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || "",
  serveLegacy: process.env.SERVE_LEGACY !== "false",
};

if (config.jwtSecret.length < 16) throw new Error("JWT_SECRET must be at least 16 characters");
module.exports = config;
