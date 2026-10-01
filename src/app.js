const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { authenticate, errorHandler, wrap } = require("./middleware/common");
const auth = require("./routes/auth");
const workflows = require("./routes/workflows");
const master = require("./routes/master");
const legacyRoutes = require("./legacy/routes");
const legacyActivity = require("./legacy/activityLog");

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : { origin: !config.isProd }));
  app.use(express.json({ limit: "1mb" }));
  app.use(rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.RATE_LIMIT || 900), standardHeaders: true, legacyHeaders: false }));

  // ---- public ----
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  const loginBody = (req, res, next) => { const r = auth.loginBody.safeParse(req.body); if (!r.success) return res.status(400).json({ message: "email and password are required" }); req.body = r.data; next(); };
  app.post("/login", auth.loginLimiter, loginBody, auth.loginHandler);            // legacy path (existing frontend)
  app.post("/api/auth/login", auth.loginLimiter, loginBody, auth.loginHandler);
  app.use(auth.bootstrap); // POST /users allowed unauthenticated ONLY while zero users exist

  // static frontends (no auth needed for assets)
  const wmsDist = path.join(__dirname, "..", "..", "client", "dist");
  const legacyDist = path.join(__dirname, "..", "..", "legacy-ui");
  if (fs.existsSync(wmsDist)) {
    app.use("/wms", express.static(wmsDist));
    app.get(/^\/wms(\/.*)?$/, (req, res) => res.sendFile(path.join(wmsDist, "index.html")));
  }
  if (config.serveLegacy && fs.existsSync(legacyDist)) {
    app.use(express.static(legacyDist, { index: false }));
    // The legacy SPA shares URL names with its API (/users, /activity-log ...). Browser page loads
    // (Accept: text/html, no Authorization header) get the SPA; API calls carry a bearer token.
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.headers.authorization && !req.path.startsWith("/api") && (req.headers.accept || "").includes("text/html")) return res.sendFile(path.join(legacyDist, "index.html"));
      next();
    });
  }

  // ---- everything below needs a valid token ----
  app.use(authenticate);

  app.use("/api/auth", auth.authed);
  app.use("/users", legacyActivity, auth.users);      // legacy path
  app.use("/api/users", auth.users);
  app.use("/api", workflows);
  app.use("/api", master);
  app.use("/", legacyActivity, legacyRoutes);

  app.use((req, res) => res.status(404).json({ message: "Not found" }));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
