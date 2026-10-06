// Prototype API surface, kept URL-compatible so the existing frontend keeps working.
// Hardened: authentication is enforced by the caller, writes are role-checked server-side,
// direct quantity edits are audited, and passwords/hashes are never returned.
const express = require("express");
const L = require("../models/legacy");
const { AuditLog } = require("../models");
const { wrap, requirePerm } = require("../middleware/common");
const { P, canAny } = require("../domain/permissions");
const gatepass = require("../domain/gatepass");
const { norm } = require("../domain/permissions");

const r = express.Router();
const ADD_ROLES = ["admin", "store", "store assistant", "purchase executive"];   // may create
const EDIT_ROLES = ["admin", "store"];                                           // may edit / delete (add-only roles cannot)
const READ_ONLY = ["viewer"];
const { cleanVehicles } = L;

// Permission gate (server-side): reading needs a stock/engineering view permission, writing needs an inventory or engineering write permission.
r.use(wrap(async (req, res, next) => {
  if (/^\/(gatepass|activity-log)/.test(req.path)) return next(); // these have their own, specific permissions below
  const read = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  const ok = await canAny(req.user.role, read ? [P.INV_VIEW, P.ENG_VIEW] : [P.RECEIVE, P.ADJUST, P.ENG_PARTS, P.ENG_BOM, P.ENG_DEV]);
  if (!ok) return res.status(403).json({ message: "You do not have permission to do this." });
  next();
}));

// Server-side write gate (legacy comment: two roles are add-only, never edit/delete).
r.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const role = norm(req.user && req.user.role);
  if (READ_ONLY.includes(role)) return res.status(403).json({ message: "Read-only role." });
  if (["PUT", "DELETE"].includes(req.method) && ["store assistant", "purchase executive"].includes(role)) return res.status(403).json({ message: "You may add records but not edit or delete them." });
  next();
});

const ok500 = (res) => res.status(500).json({ message: "Server error" });

function crud(Model, { list, create = "/", update, del, hasDupCheck = true }) {
  return { Model };
}

// ---- BOM / Dev / Con share one shape ----
function registerSimple(name, Model, { listAll }) {
  r.get(`/${name}`, wrap(async (req, res) => {
    const { catagory, vehicle } = req.query;
    const query = listAll ? (catagory ? { catagory: String(catagory) } : {}) : { catagory: catagory === undefined ? undefined : String(catagory) };
    if (query.catagory === undefined) delete query.catagory;
    if (vehicle) query.vehicles = String(vehicle).toUpperCase();
    res.json(await Model.find(query));
  }));
  r.post(`/${name}`, wrap(async (req, res) => {
    const { partId } = req.body;
    if (partId && (await Model.findOne({ partId: String(partId) }))) return res.status(409).json({ message: "Part ID already exists!" });
    const doc = new Model({ ...pick(req.body, Model), vehicles: cleanVehicles(req.body.vehicles) });
    await doc.save(); res.status(201).json(doc);
  }));
  r.put(`/${name}/:id`, wrap(async (req, res) => {
    const update = pick(req.body, Model);
    if (req.body.vehicles !== undefined) update.vehicles = cleanVehicles(req.body.vehicles);
    const doc = await Model.findByIdAndUpdate(req.params.id, update, { new: true });
    return doc ? res.json(doc) : res.status(404).json({ message: "parts not found" });
  }));
  r.delete(`/${name}`, wrap(async (req, res) => {
    const { _id } = req.query; if (!_id) return res.status(400).json({ message: "part ID is required" });
    const d = await Model.findOneAndDelete({ _id: String(_id) });
    return d ? res.json({ message: "part deleted" }) : res.status(404).json({ message: "part not found" });
  }));
}
// only fields declared in the schema (blocks operator injection / mass assignment of _id, __v)
function pick(body, Model) {
  const out = {}; const paths = Object.keys(Model.schema.paths).filter((p) => !["_id", "__v"].includes(p));
  for (const k of paths) if (body && body[k] !== undefined && typeof body[k] !== "object" || (body && Array.isArray(body[k]))) out[k] = body[k];
  return out;
}
registerSimple("bom", L.Bom, { listAll: true });
registerSimple("dev", L.Dev, { listAll: false });
registerSimple("con", L.Con, { listAll: false });

r.get("/bom-partid", wrap(async (req, res) => { const { partId } = req.query; if (!partId) return res.status(400).json({ message: "Missing partId parameter" }); res.json(await L.Bom.find({ partId: String(partId) })); }));
r.get("/dev-partid", wrap(async (req, res) => { const p = await L.Dev.findOne({ partId: String(req.query.partId) }); return p ? res.json(p) : res.status(404).json({ message: "Part not found" }); }));
r.get("/dev/next-temp-id", wrap(async (req, res) => { const c = await L.Counter.findOneAndUpdate({ name: "tempPartId" }, { $inc: { seq: 1 } }, { new: true, upsert: true }); res.json({ tempId: `TEMP-${String(c.seq).padStart(4, "0")}` }); }));

// ---- Parts (legacy stock list) ----
r.get("/getparts", wrap(async (req, res) => {
  const { catagory, vehicle } = req.query; const q = {};
  if (catagory && catagory !== "all") q.catagory = String(catagory);
  if (vehicle) q.vehicles = String(vehicle).toUpperCase();
  res.json(await L.Parts.find(q));
}));
r.get("/getpartsby-part-id", wrap(async (req, res) => res.json(await L.Parts.findOne({ partId: String(req.query.partId) }))));
r.post("/parts", wrap(async (req, res) => {
  const { partId } = req.body;
  if (partId && (await L.Parts.findOne({ partId: String(partId) }))) return res.status(409).json({ message: "Part ID already exists!" });
  const doc = new L.Parts({ ...pick(req.body, L.Parts), vehicles: cleanVehicles(req.body.vehicles) }); await doc.save(); res.status(201).json(doc);
}));

// Quantity edits on the legacy list are no longer silent: they need admin/store and are written to the audit trail.
async function auditedPartUpdate(req, res, filter, update) {
  const before = await L.Parts.findOne(filter).lean();
  if (!before) return res.status(404).json({ message: "Part not found" });
  const qtyChanging = update.quantity !== undefined && Number(update.quantity) !== Number(before.quantity);
  if (qtyChanging) {
    if (!EDIT_ROLES.includes(norm(req.user.role))) return res.status(403).json({ message: "Only Store/Admin may change stock quantity." });
    const n = Number(update.quantity);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Quantity cannot be negative." });
    update.quantity = n;
  }
  const doc = await L.Parts.findOneAndUpdate(filter, { $set: update }, { new: true });
  if (qtyChanging) await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "LEGACY_QUANTITY_EDIT", entityType: "LegacyPart", entityId: String(doc._id), entityLabel: doc.partId, reason: String(req.body.note || req.body.reason || "Edited through legacy Parts screen (no reason supplied)"), before: { quantity: before.quantity }, after: { quantity: doc.quantity } });
  res.json(doc);
}
r.put("/parts/:partId", wrap(async (req, res) => {
  const update = pick(req.body, L.Parts); if (req.body.vehicles !== undefined) update.vehicles = cleanVehicles(req.body.vehicles);
  await auditedPartUpdate(req, res, { partId: req.params.partId }, update);
}));
r.put("/parts-partid", wrap(async (req, res) => {
  const { partId } = req.query; if (!partId) return res.status(400).json({ message: "Missing partId query parameter" });
  if (req.body.quantity === undefined) return res.status(400).json({ message: "Missing quantity in request body" });
  await auditedPartUpdate(req, res, { partId: String(partId) }, { quantity: req.body.quantity });
}));
r.delete("/deleteparts", wrap(async (req, res) => {
  const { _id } = req.query; if (!_id) return res.status(400).json({ message: "part ID is required" });
  const d = await L.Parts.findOneAndDelete({ _id: String(_id) });
  if (d) await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "LEGACY_PART_DELETED", entityType: "LegacyPart", entityId: String(d._id), entityLabel: d.partId, before: d.toObject() });
  return d ? res.json({ message: "part deleted" }) : res.status(404).json({ message: "part not found" });
}));

// ---- Parts I/O ----
r.get("/getpartsIO", wrap(async (req, res) => res.json(await L.PartsIO.find())));
r.post("/partsIO", wrap(async (req, res) => { const d = new L.PartsIO(pick(req.body, L.PartsIO)); await d.save(); res.status(201).json(d); }));
r.put("/partsIO/:id", wrap(async (req, res) => { const d = await L.PartsIO.findByIdAndUpdate(req.params.id, pick(req.body, L.PartsIO), { new: true }); return d ? res.json({ updatedPartIO: d }) : res.status(404).json({ message: "PartsIO record not found" }); }));
r.put("/updatePartId", wrap(async (req, res) => {
  const { oldPartId, newPartId } = req.body;
  if (!oldPartId || !newPartId) return res.status(400).json({ message: "Both old and new Part IDs are required" });
  const u = await L.PartsIO.updateMany({ partId: String(oldPartId) }, { $set: { partId: String(newPartId) } });
  if (u.matchedCount === 0) return res.status(404).json({ message: "No matching parts found" });
  res.json({ message: "Part IDs updated successfully", updatedParts: u });
}));
r.delete("/deletepartsIO", wrap(async (req, res) => { const { _id } = req.query; if (!_id) return res.status(400).json({ message: "part ID is required" }); const d = await L.PartsIO.findOneAndDelete({ _id: String(_id) }); return d ? res.json({ message: "part deleted" }) : res.status(404).json({ message: "part not found" }); }));

// ---- Incoming (legacy). New receiving must use /api/receiving; this keeps old screens readable/editable.
r.get("/getIncomming", wrap(async (req, res) => { const q = req.query.vehicle ? { vehicles: String(req.query.vehicle).toUpperCase() } : {}; res.json(await L.Incomming.find(q)); }));
r.post("/Incomming", wrap(async (req, res) => {
  // The mandatory-invoice rule applies to legacy incoming records as well (server-side).
  if (!String(req.body.invoice || "").trim()) return res.status(400).json({ error: "INVOICE_REQUIRED", message: "Invoice number is mandatory before material can be received." });
  const d = new L.Incomming({ ...pick(req.body, L.Incomming), vehicles: cleanVehicles(req.body.vehicles) }); await d.save(); res.status(201).json(d);
}));
r.put("/Incomming/:id", wrap(async (req, res) => {
  const u = pick(req.body, L.Incomming); if (req.body.vehicles !== undefined) u.vehicles = cleanVehicles(req.body.vehicles);
  const d = await L.Incomming.findByIdAndUpdate(req.params.id, u, { new: true }); return d ? res.json({ updatedPartIO: d }) : res.status(404).json({ message: "PartsIO record not found" });
}));
r.delete("/deleteIncomming", wrap(async (req, res) => { const { _id } = req.query; if (!_id) return res.status(400).json({ message: "part ID is required" }); const d = await L.Incomming.findOneAndDelete({ _id: String(_id) }); return d ? res.json({ message: "part deleted" }) : res.status(404).json({ message: "part not found" }); }));

// ---- Notifications ----
r.get("/notifications", wrap(async (req, res) => { const { dept } = req.query; res.json(dept === "Admin" ? await L.Msg.find() : await L.Msg.find({ to: String(dept) })); }));
r.post("/notifications", wrap(async (req, res) => { const m = new L.Msg(pick(req.body, L.Msg)); await m.save(); res.status(201).json(m); }));

// ---- Gate pass (same InventoryGatePass collection, now under gatepass.* permissions) / legacy activity log (audit.view) ----
r.get("/gatepass/next-ref", requirePerm(P.GP_CREATE), wrap(async (req, res) => res.json({ refNo: await gatepass.nextRef() })));
r.get("/gatepass", requirePerm(P.GP_VIEW), wrap(async (req, res) => res.json(await L.GatePass.find().sort({ createdAt: -1 }))));
r.post("/gatepass", requirePerm(P.GP_CREATE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = (b.items || []).map((i) => ({ name: i.name, partNumber: i.partNumber, serialBatch: i.serialBatch, qty: String(i.qty ?? ""), uom: i.uom }));
  res.status(201).json(await gatepass.create(req.user, { date: b.date, supplier: b.supplier, dispatchMode: b.dispatchMode, returnable: !!b.returnable, returnDate: b.returnDate, remarks: b.remarks, issuedBy: b.issuedBy, receivedBy: b.receivedBy, items }));
}));
r.get("/activity-log", requirePerm(P.AUDIT), wrap(async (req, res) => res.json(await L.ActivityLog.find().sort({ createdAt: -1 }).limit(500))));

module.exports = r;
