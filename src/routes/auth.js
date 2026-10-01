const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const config = require("../config");
const { User } = require("../models");
const { wrap, validate, authenticate, requirePerm } = require("../middleware/common");
const { permissionsFor, P } = require("../domain/permissions");
const { BusinessError } = require("../domain/errors");
const { AuditLog } = require("../models");

const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 30), standardHeaders: true, legacyHeaders: false, message: { message: "Too many login attempts. Try again later." } });

const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const strongPw = z.string().min(8, "Password must be at least 8 characters").max(128);

async function verifyPassword(user, password) {
  if (user.passwordHash) return bcrypt.compare(password, user.passwordHash);
  if (user.password && safeEq(user.password, password)) { // legacy plaintext: upgrade transparently
    user.passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    user.password = undefined;
    await user.save();
    return true;
  }
  return false;
}
const sign = (u) => jwt.sign({ id: String(u._id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

const loginBody = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) });
const loginHandler = wrap(async (req, res) => {
  const { email, password } = req.body;
  let user = await User.findOne({ emailId: email });
  if (!user) user = await User.findOne({ emailId: new RegExp(`^${esc(email)}$`, "i") });
  // same message for unknown user / wrong password: no account enumeration
  if (!user || user.active === false || !(await verifyPassword(user, password))) return res.status(401).json({ message: "Invalid email or password" });
  user.lastLogin = new Date();
  await user.save();
  const token = sign(user);
  // `message`, `role`, `_id`, `token` keep the legacy frontend contract.
  res.json({ message: user.name, name: user.name, role: user.role, _id: user._id, token, permissions: await permissionsFor(user.role), mustChangePassword: !!user.mustChangePassword });
});

const router = express.Router();
router.post("/login", loginLimiter, validate(loginBody), loginHandler);

const authed = express.Router();
authed.get("/me", wrap(async (req, res) => res.json({ ...req.user, permissions: await permissionsFor(req.user.role) })));
authed.post("/change-password", validate(z.object({ currentPassword: z.string(), newPassword: strongPw })), wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!(await verifyPassword(user, req.body.currentPassword))) return res.status(401).json({ message: "Current password is incorrect" });
  user.passwordHash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
  user.password = undefined; user.mustChangePassword = false;
  await user.save();
  await AuditLog.create({ user: user._id, userName: user.name, role: user.role, action: "PASSWORD_CHANGED", entityType: "User", entityId: String(user._id), entityLabel: user.emailId });
  res.json({ message: "Password updated" });
}));

// user administration (admin only, permission checked server-side)
const roleStr = z.string().trim().min(2).max(40);
const userCreate = z.object({ name: z.string().trim().min(1).max(100), emailId: z.string().trim().email().max(200), role: roleStr, password: strongPw });
const userUpdate = z.object({ name: z.string().trim().min(1).max(100).optional(), emailId: z.string().trim().email().max(200).optional(), role: roleStr.optional(), active: z.boolean().optional(), password: strongPw.optional() }).strict();
const publicUser = (u) => ({ _id: u._id, name: u.name, emailId: u.emailId, role: u.role, active: u.active !== false, lastLogin: u.lastLogin });

async function activeAdminCount(excludeId) {
  const admins = await User.find({ role: /^admin$/i, active: { $ne: false }, ...(excludeId && { _id: { $ne: excludeId } }) }).countDocuments();
  return admins;
}
const adminOnly = requirePerm(P.ADMIN_USERS);
const users = express.Router();
users.get("/", adminOnly, wrap(async (req, res) => res.json((await User.find().sort({ name: 1 })).map(publicUser))));
users.get("/directory", wrap(async (req, res) => res.json((await User.find({ active: { $ne: false } }).select("name role").sort({ name: 1 }).lean())))); // for handover recipient picker
users.get("/:id", adminOnly, wrap(async (req, res) => { const u = await User.findById(req.params.id); return u ? res.json(publicUser(u)) : res.status(404).json({ message: "User not found" }); }));
users.post("/", adminOnly, validate(userCreate), wrap(async (req, res) => {
  const { name, emailId, role, password } = req.body;
  if (await User.exists({ emailId: new RegExp(`^${esc(emailId)}$`, "i") })) return res.status(409).json({ message: "user already exist" });
  const u = await User.create({ name, emailId, role, passwordHash: await bcrypt.hash(password, config.bcryptRounds) });
  await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "USER_CREATED", entityType: "User", entityId: String(u._id), entityLabel: emailId, after: { role } });
  res.status(201).json({ message: "user registered successfully!", user: publicUser(u) });
}));
users.put("/:id", adminOnly, validate(userUpdate), wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ message: "User not found" });
  const before = publicUser(u);
  const { password, ...rest } = req.body;
  const demoting = (rest.role && !/^admin$/i.test(rest.role)) || rest.active === false;
  if (demoting && /^admin$/i.test(u.role) && (await activeAdminCount(u._id)) === 0) throw new BusinessError("LAST_ADMIN", "At least one active administrator must remain.");
  Object.assign(u, rest);
  if (password) { u.passwordHash = await bcrypt.hash(password, config.bcryptRounds); u.password = undefined; }
  await u.save();
  await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "USER_UPDATED", entityType: "User", entityId: String(u._id), entityLabel: u.emailId, before, after: { ...publicUser(u), passwordChanged: !!password } });
  res.json(publicUser(u));
}));
users.delete("/:id", adminOnly, wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ message: "User not found" });
  if (String(u._id) === req.user.id) throw new BusinessError("SELF_DELETE", "You cannot delete your own account.");
  if (/^admin$/i.test(u.role) && (await activeAdminCount(u._id)) === 0) throw new BusinessError("LAST_ADMIN", "At least one active administrator must remain.");
  await u.deleteOne();
  await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "USER_DELETED", entityType: "User", entityId: String(u._id), entityLabel: u.emailId, before: publicUser(u) });
  res.json({ message: "User deleted" });
}));

// First-run bootstrap: only when NO users exist.
const bootstrap = wrap(async (req, res, next) => {
  if (req.method === "POST" && req.path === "/users" && (await User.estimatedDocumentCount()) === 0) {
    const r = userCreate.safeParse({ ...req.body, role: "admin" });
    if (!r.success) return res.status(400).json({ message: r.error.issues.map((i) => i.message).join("; ") });
    const u = await User.create({ name: r.data.name, emailId: r.data.emailId, role: "admin", passwordHash: await bcrypt.hash(r.data.password, config.bcryptRounds) });
    return res.status(201).json({ message: "First administrator created", user: publicUser(u) });
  }
  next();
});
module.exports = { router, authed, users, loginHandler, loginLimiter, loginBody, bootstrap };
