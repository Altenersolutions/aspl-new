const express = require("express");
const { z } = require("zod");
const M = require("../models");
const C = require("../domain/constants");
const { wrap, requirePerm, validate } = require("../middleware/common");
const { P, DEFAULT_ROLES, ALL, invalidate, can, normalisePerms } = require("../domain/permissions");
const { rules, defaultsFor } = require("../domain/partRules");
const dev = require("../domain/devcomp");
const { plainCtx } = require("../domain/audit");
const { BusinessError, notFound, forbidden } = require("../domain/errors");
const { atomic } = require("../domain/uow");
const { audit } = require("../domain/audit");
const { locationPath } = require("../domain/locations");
const codes = require("../domain/codes");

const oid = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const str = (n = 200) => z.string().trim().max(n);
const rq = (n = 200) => z.string().trim().min(1).max(n);
const r = express.Router();
const adm = requirePerm(P.ADMIN_MASTER);
const engParts = requirePerm(P.ENG_PARTS, P.ENG_DEV);                   // creating/editing parts (development components additionally need ENG_DEV, checked inside)
const viewInv = requirePerm(P.INV_VIEW, P.ENG_VIEW, P.QC_VIEW, P.ASM_VIEW, P.VEH_VIEW, P.GP_VIEW); // read-only master data used on many screens
const viewEng = requirePerm(P.ENG_VIEW, P.INV_VIEW, P.ASM_VIEW, P.QC_VIEW);
const diff = (a, b) => { const before = {}, after = {}; Object.keys(b).forEach((k) => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { before[k] = a[k]; after[k] = b[k]; } }); return { before, after }; };

// ---------- SUPPLIERS ----------
const supplierBody = z.object({ code: rq(30), name: rq(150), contact: str().optional(), phone: str(40).optional(), email: str().optional(), gstin: str(30).optional(), address: str(400).optional(), active: z.boolean().optional() });
r.get("/suppliers", viewInv, wrap(async (req, res) => res.json(await M.Supplier.find().sort({ name: 1 }).lean())));
r.post("/suppliers", requirePerm(P.ADMIN_MASTER, P.RECEIVE), validate(supplierBody), wrap(async (req, res) => {
  const s = await atomic(async (ctx) => { const x = await ctx.create(M.Supplier, req.body); await audit(ctx, req.user, { action: "SUPPLIER_CREATED", entityType: "Supplier", entityId: x._id, entityLabel: x.code, after: req.body }); return x; });
  res.status(201).json(s);
}));
r.put("/suppliers/:id", adm, validate(supplierBody.partial()), wrap(async (req, res) => {
  const cur = await M.Supplier.findById(req.params.id); if (!cur) throw notFound("Supplier");
  const d = diff(cur.toObject(), req.body);
  await Object.assign(cur, req.body).save();
  await audit(null, req.user, { action: "SUPPLIER_UPDATED", entityType: "Supplier", entityId: cur._id, entityLabel: cur.code, ...d });
  res.json(cur);
}));

// ---------- LOCATIONS ----------
const locBody = z.object({ locationCode: rq(40), name: rq(120), type: z.enum(C.LOCATION_TYPES), parentCode: str(40).optional(), allowedCategories: z.array(z.enum(C.CATEGORIES)).optional(), allowedPartTypes: z.array(z.enum(C.TRACKING)).optional(), capacity: z.number().positive().nullable().optional(), active: z.boolean().optional() });
async function fillHierarchy(body) {
  const out = { ...body }; delete out.parentCode;
  let parent = null;
  if (body.parentCode) { parent = await M.Location.findOne({ locationCode: body.parentCode.toUpperCase() }); if (!parent) throw new BusinessError("UNKNOWN_LOCATION", `Parent ${body.parentCode} not found`, { status: 400 }); out.parentLocation = parent._id; out.store = parent.store; out.zone = parent.zone; out.rack = parent.rack; out.shelf = parent.shelf; }
  const lvl = { STORE: "store", ZONE: "zone", RACK: "rack", SHELF: "shelf", BIN: "bin" }[body.type];
  if (lvl) out[lvl] = body.name;
  return out;
}
r.get("/locations", viewInv, wrap(async (req, res) => { const q = {}; if (req.query.type) q.type = String(req.query.type); res.json(await M.Location.find(q).sort({ path: 1, locationCode: 1 }).lean()); }));
r.post("/locations", adm, validate(locBody), wrap(async (req, res) => {
  const data = await fillHierarchy(req.body); data.locationCode = data.locationCode.toUpperCase();
  const loc = await atomic(async (ctx) => {
    const l = await ctx.create(M.Location, data);
    const path = await locationPath(l); l.path = path; l.qrCode = codes.locationPayload(l);
    await ctx.set(M.Location, l._id, { path, qrCode: l.qrCode });
    await audit(ctx, req.user, { action: "LOCATION_CREATED", entityType: "Location", entityId: l._id, entityLabel: l.locationCode, after: data });
    return l;
  });
  res.status(201).json(loc);
}));
r.put("/locations/:id", adm, validate(locBody.partial().omit({ locationCode: true, type: true, parentCode: true })), wrap(async (req, res) => {
  const cur = await M.Location.findById(req.params.id); if (!cur) throw notFound("Location");
  const d = diff(cur.toObject(), req.body); await Object.assign(cur, req.body).save();
  await audit(null, req.user, { action: "LOCATION_UPDATED", entityType: "Location", entityId: cur._id, entityLabel: cur.locationCode, ...d });
  res.json(cur);
}));

// ---------- PARTS + REVISIONS ----------
// inventoryClass (GENERAL / PRODUCTION / DEVELOPMENT) = what kind of stock it is.  trackingType (SERIAL / BATCH / QUANTITY) = how it is counted.  They are independent.
const partBody = z.object({ partNumber: rq(60), partName: rq(200), description: str(1000).optional(), category: z.enum(C.CATEGORIES), subCategory: str(80).optional(), materialType: str(80).optional(), unit: str(20).optional(), trackingType: z.enum(C.TRACKING),
  inventoryClass: z.enum(C.INVENTORY_CLASSES).optional(), revisionControlled: z.boolean().optional(), qcRequired: z.boolean().optional(), fifoApplicable: z.boolean().optional(), bomControlled: z.boolean().optional(),
  defaultLocationCode: str(40).optional(), storageRule: z.object({ store: str(80).optional(), zone: str(80).optional(), rack: str(80).optional() }).optional(), supplierId: oid.optional(), vehicleCompatibility: z.array(z.enum(C.VEHICLE_TYPES)).optional(), currentRevision: str(40).optional(), minStock: z.number().min(0).optional(), active: z.boolean().optional() });
async function partData(b) {
  const d = { ...b }; delete d.defaultLocationCode; delete d.supplierId;
  if (b.defaultLocationCode !== undefined) { if (b.defaultLocationCode === "") d.defaultLocation = null; else { const l = await M.Location.findOne({ locationCode: b.defaultLocationCode.toUpperCase(), type: "BIN" }); if (!l) throw new BusinessError("UNKNOWN_LOCATION", "Default location must be an existing BIN", { status: 400 }); d.defaultLocation = l._id; } }
  if (b.supplierId) d.supplier = b.supplierId;
  return d;
}
const withRules = (p) => ({ ...p, rules: rules(p) });
r.get("/parts", viewInv, wrap(async (req, res) => {
  const q = {}; if (req.query.q) { const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); q.$or = [{ partNumber: rx }, { partName: rx }]; }
  if (req.query.class) q.inventoryClass = String(req.query.class).toUpperCase();
  res.json((await M.PartMaster.find(q).sort({ partNumber: 1 }).limit(1000).populate("defaultLocation", "locationCode path").lean()).map(withRules));
}));
r.get("/parts/:id", viewInv, wrap(async (req, res) => { const p = await M.PartMaster.findById(req.params.id).populate("defaultLocation", "locationCode path").lean(); if (!p) throw notFound("Part"); res.json({ ...withRules(p), revisions: await M.PartRevision.find({ part: p._id }).sort({ createdAt: 1 }).lean() }); }));
r.post("/parts", engParts, validate(partBody), wrap(async (req, res) => {
  const d = await partData(req.body); d.partNumber = d.partNumber.toUpperCase();
  const flags = defaultsFor(d); for (const k of Object.keys(flags)) if (d[k] === undefined) d[k] = flags[k];   // explicit database values for every flag
  const isDev = d.inventoryClass === "DEVELOPMENT";
  if (isDev && !(await can(req.user.role, P.ENG_DEV))) throw forbidden("Creating development components needs engineering.manage_development_components.");
  if (!isDev && !(await can(req.user.role, P.ENG_PARTS))) throw forbidden("Creating parts needs engineering.manage_parts.");
  dev.checkSub(d.inventoryClass, d.subCategory);
  if (isDev) d.devStatus = "DRAFT";
  const p = await atomic(async (ctx) => {
    const x = await ctx.create(M.PartMaster, d);
    await ctx.create(M.PartRevision, { part: x._id, revision: x.currentRevision, status: isDev ? "DRAFT" : "APPROVED", approvedBy: isDev ? undefined : req.user.id, approvedAt: isDev ? undefined : new Date(), changeReason: "Initial revision", effectiveDate: new Date() });
    await audit(ctx, req.user, { action: "PART_CREATED", entityType: "Part", entityId: x._id, entityLabel: x.partNumber, after: { inventoryClass: d.inventoryClass, trackingType: d.trackingType, category: d.category, subCategory: d.subCategory } });
    return x;
  });
  res.status(201).json(withRules(p.toObject()));
}));
r.put("/parts/:id", engParts, validate(partBody.partial().omit({ partNumber: true, currentRevision: true })), wrap(async (req, res) => {
  const cur = await M.PartMaster.findById(req.params.id); if (!cur) throw notFound("Part");
  const wasDev = rules(cur).isDevelopment, nowDev = (req.body.inventoryClass || rules(cur).inventoryClass) === "DEVELOPMENT";
  if ((wasDev || nowDev) && !(await can(req.user.role, P.ENG_DEV))) throw forbidden("Changing development components needs engineering.manage_development_components.");
  if (!wasDev && !nowDev && !(await can(req.user.role, P.ENG_PARTS))) throw forbidden("Changing parts needs engineering.manage_parts.");
  const changingKind = (req.body.inventoryClass && req.body.inventoryClass !== rules(cur).inventoryClass) || (req.body.trackingType && req.body.trackingType !== cur.trackingType);
  if (changingKind && (await M.MaterialItem.exists({ part: cur._id }))) throw new BusinessError("CLASS_LOCKED", "Inventory class and tracking type cannot change once stock of this part exists.");
  const d = await partData(req.body); if (nowDev && (req.body.subCategory !== undefined || !wasDev)) dev.checkSub("DEVELOPMENT", d.subCategory ?? cur.subCategory);
  if (!wasDev && nowDev) d.devStatus = "DRAFT";
  const before = {}, after = {}; Object.keys(d).forEach((k) => { if (JSON.stringify(cur[k]) !== JSON.stringify(d[k])) { before[k] = cur[k]; after[k] = d[k]; } });
  await atomic(async (ctx) => { await ctx.set(M.PartMaster, cur._id, d); await audit(ctx, req.user, { action: "PART_UPDATED", entityType: "Part", entityId: cur._id, entityLabel: cur.partNumber, before, after }); });
  res.json(withRules((await M.PartMaster.findById(cur._id)).toObject()));
}));
r.get("/parts/:id/revisions", viewEng, wrap(async (req, res) => res.json(await M.PartRevision.find({ part: req.params.id }).sort({ createdAt: 1 }).lean())));
r.post("/parts/:id/revisions", requirePerm(P.ENG_REV, P.ENG_DEV), validate(z.object({ revision: rq(40), drawingNumber: str(80).optional(), specification: str(1000).optional(), effectiveDate: str(40).optional(), changeReason: rq(500) })), wrap(async (req, res) => {
  const part = await M.PartMaster.findById(req.params.id); if (!part) throw notFound("Part");
  if (!(await can(req.user.role, rules(part).isDevelopment ? P.ENG_DEV : P.ENG_REV))) throw forbidden("You are not authorised to create revisions for this part.");
  const rev = await atomic(async (ctx) => { const x = await ctx.create(M.PartRevision, { ...req.body, part: part._id, status: "DRAFT" }); await audit(ctx, req.user, { action: "PART_REVISION_CREATED", entityType: "Part", entityId: part._id, entityLabel: `${part.partNumber} ${x.revision}`, reason: req.body.changeReason, after: req.body }); return x; });
  res.status(201).json(rev);
}));
r.post("/parts/:id/revisions/:rev/approve", requirePerm(P.ENG_APPROVE), validate(z.object({ makeCurrent: z.boolean().default(true) })), wrap(async (req, res) => {
  const part = await M.PartMaster.findById(req.params.id); const rev = await M.PartRevision.findOne({ part: req.params.id, revision: req.params.rev });
  if (!part || !rev) throw notFound("Revision");
  if (rev.status !== "DRAFT") throw new BusinessError("INVALID_STATE_TRANSITION", `Revision is ${rev.status}`);
  await atomic(async (ctx) => {
    await ctx.set(M.PartRevision, rev._id, { status: "APPROVED", approvedBy: req.user.id, approvedAt: new Date(), effectiveDate: rev.effectiveDate || new Date() });
    if (req.body.makeCurrent) await ctx.set(M.PartMaster, part._id, { currentRevision: rev.revision }); // previously received units KEEP their own revision
    await audit(ctx, req.user, { action: "PART_REVISION_APPROVED", entityType: "Part", entityId: part._id, entityLabel: `${part.partNumber} ${rev.revision}`, before: { currentRevision: part.currentRevision }, after: { currentRevision: req.body.makeCurrent ? rev.revision : part.currentRevision } });
  });
  res.json({ ok: true });
}));

// ---- development component lifecycle + image history ----
r.get("/dev-subcategories", (req, res) => res.json(C.DEV_SUBCATEGORIES));
r.post("/parts/:id/dev/submit", requirePerm(P.ENG_DEV), wrap(async (req, res) => res.json(await dev.submit(req.user, req.params.id))));
r.post("/parts/:id/dev/approve", requirePerm(P.ENG_APPROVE), wrap(async (req, res) => res.json(await dev.approve(req.user, req.params.id, req.body && req.body.note))));
r.post("/parts/:id/dev/reject", requirePerm(P.ENG_APPROVE), validate(z.object({ note: rq(500) })), wrap(async (req, res) => res.json(await dev.reject(req.user, req.params.id, req.body.note))));
r.post("/parts/:id/dev/activate", requirePerm(P.ENG_DEV), wrap(async (req, res) => res.json(await dev.activate(req.user, req.params.id))));
r.get("/parts/:id/images", viewEng, wrap(async (req, res) => res.json(await dev.images(req.params.id))));
r.post("/parts/:id/images", requirePerm(P.ENG_DEV), validate(z.object({ revision: str(40).optional(), name: rq(120), mime: z.string().max(40), dataBase64: z.string().max(1200000), caption: str(300).optional() })), wrap(async (req, res) => res.status(201).json(await dev.addImage(req.user, req.params.id, req.body))));

// ---------- BOM ----------
const bomItem = z.object({ partNumber: rq(60), requiredQuantity: z.number().int().positive(), requiredRevision: str(40).optional(), optional: z.boolean().optional(), installationPosition: str(120).optional() });
r.get("/bom", viewEng, wrap(async (req, res) => res.json(await M.BOM.find().sort({ vehicleModel: 1 }).lean())));
r.post("/bom", requirePerm(P.ENG_BOM), validate(z.object({ vehicleModel: rq(40), name: str(120).optional() })), wrap(async (req, res) => res.status(201).json(await M.BOM.create({ ...req.body, vehicleModel: req.body.vehicleModel.toUpperCase() }))));
r.get("/bom/:model/revisions", viewEng, wrap(async (req, res) => res.json(await M.BOMRevision.find({ vehicleModel: req.params.model.toUpperCase() }).sort({ createdAt: 1 }).populate("items.part", "partName").lean())));
r.post("/bom/:model/revisions", requirePerm(P.ENG_BOM), validate(z.object({ revision: rq(40), effectiveDate: str(40).optional(), changeReason: rq(500), items: z.array(bomItem).min(1).max(1000) })), wrap(async (req, res) => {
  const rev = await require("../domain/catalog").createBomRevision(req.user, req.params.model, req.body);
  res.status(201).json(rev);
}));
r.post("/bom/:model/revisions/:rev/approve", requirePerm(P.ENG_APPROVE), wrap(async (req, res) => {
  const bom = await M.BOM.findOne({ vehicleModel: req.params.model.toUpperCase() }); const rev = bom && (await M.BOMRevision.findOne({ bom: bom._id, revision: req.params.rev }));
  if (!rev) throw notFound("BOM revision");
  if (rev.status !== "DRAFT") throw new BusinessError("INVALID_STATE_TRANSITION", `BOM revision is ${rev.status}; approved revisions are immutable - create a new revision.`);
  await atomic(async (ctx) => {
    if (bom.currentRevision) { const prev = await M.BOMRevision.findOne({ bom: bom._id, revision: bom.currentRevision }); if (prev && prev.status === "APPROVED") await ctx.set(M.BOMRevision, prev._id, { status: "OBSOLETE" }); }
    await ctx.set(M.BOMRevision, rev._id, { status: "APPROVED", approvedBy: req.user.id, approvedAt: new Date() });
    await ctx.set(M.BOM, bom._id, { currentRevision: rev.revision });
    await audit(ctx, req.user, { action: "BOM_REVISION_APPROVED", entityType: "BOM", entityId: bom._id, entityLabel: `${bom.vehicleModel} ${rev.revision}`, before: { currentRevision: bom.currentRevision }, after: { currentRevision: rev.revision } });
  });
  res.json({ ok: true });
}));

// ---------- VEHICLES ----------
r.post("/vehicles", requirePerm(P.VEH_CREATE), validate(z.object({ vehicleNumber: rq(40), vin: str(40).optional(), model: rq(40), vehicleType: rq(40), project: str(100).optional(), bomRevision: str(40).optional() })), wrap(async (req, res) => {
  const model = req.body.model.toUpperCase();
  const bom = await M.BOM.findOne({ vehicleModel: model });
  const revName = req.body.bomRevision || (bom && bom.currentRevision);
  if (!bom || !revName) throw new BusinessError("NO_BOM", `No approved BOM revision for model ${model}.`, { status: 400 });
  const rev = await M.BOMRevision.findOne({ bom: bom._id, revision: revName });
  if (!rev || rev.status !== "APPROVED") throw new BusinessError("BOM_NOT_APPROVED", `BOM ${model} ${revName} is not an approved revision.`, { status: 400 });
  const v = await atomic(async (ctx) => {
    const x = await ctx.create(M.Vehicle, { vehicleNumber: req.body.vehicleNumber.toUpperCase(), vin: req.body.vin || undefined, model, vehicleType: req.body.vehicleType.toUpperCase(), project: req.body.project, currentBOMRevision: revName });
    const qr = codes.vehiclePayload(x); await ctx.set(M.Vehicle, x._id, { qrCode: qr }); x.qrCode = qr;
    await audit(ctx, req.user, { action: "VEHICLE_CREATED", entityType: "Vehicle", entityId: x._id, entityLabel: x.vehicleNumber, after: { model, bomRevision: revName } });
    return x;
  });
  res.status(201).json(v);
}));
r.post("/vehicles/:id/bom-revision", requirePerm(P.VEH_EDIT), validate(z.object({ revision: rq(40), reason: rq(500) })), wrap(async (req, res) => {
  const v = await M.Vehicle.findById(req.params.id); if (!v) throw notFound("Vehicle");
  const bom = await M.BOM.findOne({ vehicleModel: v.model }); const rev = bom && (await M.BOMRevision.findOne({ bom: bom._id, revision: req.body.revision }));
  if (!rev || !["APPROVED", "OBSOLETE"].includes(rev.status)) throw new BusinessError("BOM_NOT_APPROVED", "BOM revision must be approved.", { status: 400 });
  await atomic(async (ctx) => { await ctx.set(M.Vehicle, v._id, { currentBOMRevision: rev.revision }); await audit(ctx, req.user, { action: "VEHICLE_BOM_REVISION_CHANGED", entityType: "Vehicle", entityId: v._id, entityLabel: v.vehicleNumber, reason: req.body.reason, before: { revision: v.currentBOMRevision }, after: { revision: rev.revision } }); });
  res.json({ ok: true });
}));

// ---------- ROLES ----------
r.get("/roles", requirePerm(P.ADMIN_ROLES, P.ADMIN_PERMS), wrap(async (req, res) => {
  const stored = await M.Role.find().lean(); const names = new Set(stored.map((x) => x.name));
  const defaults = Object.entries(DEFAULT_ROLES).filter(([n]) => !names.has(n)).map(([name, permissions]) => ({ name, permissions, system: true, source: "default" }));
  res.json({ roles: [...stored, ...defaults], allPermissions: ALL });
}));
r.put("/roles/:name", requirePerm(P.ADMIN_PERMS), validate(z.object({ permissions: z.array(z.enum(ALL)) })), wrap(async (req, res) => {
  const name = req.params.name.toLowerCase();
  if (name === "admin") throw new BusinessError("PROTECTED", "The admin role cannot be edited.");
  const before = await M.Role.findOne({ name });
  await M.Role.updateOne({ name }, { $set: { permissions: req.body.permissions } }, { upsert: true });
  invalidate();
  await M.AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "ROLE_PERMISSIONS_CHANGED", entityType: "Role", entityId: name, entityLabel: name, before: { permissions: before ? before.permissions : DEFAULT_ROLES[name] }, after: { permissions: req.body.permissions } });
  res.json({ ok: true });
}));

// ---------- SETTINGS ----------
r.get("/settings", adm, wrap(async (req, res) => res.json(await M.Setting.find().lean())));
r.put("/settings/:key", adm, validate(z.object({ value: z.any() })), wrap(async (req, res) => {
  const cur = await M.Setting.findOne({ key: req.params.key });
  await M.Setting.updateOne({ key: req.params.key }, { $set: { value: req.body.value } }, { upsert: true });
  await M.AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "SETTING_CHANGED", entityType: "Setting", entityId: req.params.key, before: cur && cur.value, after: req.body.value });
  res.json({ ok: true });
}));
module.exports = r;
