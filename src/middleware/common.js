const jwt = require("jsonwebtoken");
const { ZodError } = require("zod");
const config = require("../config");
const { User } = require("../models");
const { BusinessError, forbidden } = require("../domain/errors");
const { can, permissionsFor, norm } = require("../domain/permissions");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Backend is authoritative: token proves identity only. Role/active flag are re-read from the DB.
const authenticate = wrap(async (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Authentication required" });
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret); } catch { return res.status(403).json({ message: "Invalid or expired token" }); }
  const user = await User.findById(payload.id).select("name role emailId active tokenVersion").lean();
  if (!user || user.active === false || (user.tokenVersion || 0) !== (payload.v || 0)) return res.status(403).json({ message: "Session expired or account disabled. Please sign in again." });
  req.user = { id: String(user._id), name: user.name, role: user.role, email: user.emailId };
  next();
});

const requirePerm = (...perms) => wrap(async (req, res, next) => {
  for (const p of perms) if (await can(req.user.role, p)) return next();
  throw forbidden();
});
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.map(norm).includes(norm(req.user && req.user.role))) return res.status(403).json({ message: "You do not have permission to do this." });
  next();
};

const validate = (schema, where = "body") => (req, res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return res.status(400).json({ error: "VALIDATION", message: r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), details: r.error.issues });
  req[where] = r.data;
  next();
};

function errorHandler(err, req, res, next) { // eslint-disable-line
  if (err instanceof BusinessError) return res.status(err.status).json(err.toJSON());
  if (err instanceof ZodError) return res.status(400).json({ error: "VALIDATION", message: err.message });
  if (err && err.name === "ValidationError") return res.status(400).json({ error: "VALIDATION", message: err.message });
  if (err && err.name === "CastError") return res.status(400).json({ error: "VALIDATION", message: `Invalid ${err.path}` });
  if (err && err.code === 11000) return res.status(409).json({ error: "DUPLICATE", message: "A record with the same unique value already exists.", details: err.keyValue });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "VALIDATION", message: "Malformed JSON" });
  console.error(err);
  res.status(500).json({ error: "SERVER_ERROR", message: "Server error" });
}
module.exports = { wrap, authenticate, requirePerm, requireRole, validate, errorHandler, permissionsFor };
