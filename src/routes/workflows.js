const express = require("express");
const { z } = require("zod");
const QRCode = require("qrcode");
const M = require("../models");
const { wrap, requirePerm, validate } = require("../middleware/common");
const { P, can } = require("../domain/permissions");
const gatepass = require("../domain/gatepass");
const insights = require("../domain/insights");
const { forbidden } = require("../domain/errors");
const materials = require("../domain/materials");
const assembly = require("../domain/assembly");
const handover = require("../domain/handover");
const scanSvc = require("../domain/scan");
const reports = require("../domain/reports");
const codes = require("../domain/codes");
const ledger = require("../domain/ledger");
const { notFound, BusinessError } = require("../domain/errors");

const oid = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const str = (n = 200) => z.string().trim().max(n);
const req_ = (n = 200) => z.string().trim().min(1).max(n);
const num = z.coerce.number().finite();
const override = z.object({ reason: str(500), confirm: z.boolean() }).optional();
const r = express.Router();
const lim = (req, d = 500) => ({ skip: Math.max(0, parseInt(req.query.skip, 10) || 0), limit: Math.min(parseInt(req.query.limit, 10) || d, 1000) });
async function paged(req, res, Model, q, sort, populate = []) {
  const { skip, limit } = lim(req); res.set("X-Total-Count", String(await Model.countDocuments(q)));
  let cur = Model.find(q).sort(sort).skip(skip).limit(limit); populate.forEach((p) => (cur = cur.populate(...p))); return res.json(await cur.lean());
}

// ---------- SCAN ----------
r.post("/scan", requirePerm(P.SCAN), validate(z.object({ code: req_(500), context: z.object({ vehicle: str(60).optional(), quantity: num.optional() }).optional() })), wrap(async (req, res) => {
  res.json(await scanSvc.scan(req.body.code, req.body.context || {}));
}));
r.post("/locations/scan", requirePerm(P.SCAN), validate(z.object({ code: req_(200), expected: str(100).optional() })), wrap(async (req, res) => {
  const loc = await materials.getLocation(req.body.code);
  let match = null;
  if (req.body.expected) { const exp = await materials.getLocation(req.body.expected); match = String(exp._id) === String(loc._id); }
  res.json({ location: { id: loc._id, code: loc.locationCode, name: loc.name, type: loc.type, path: loc.path }, match, message: match === null ? undefined : match ? "CORRECT LOCATION" : "WRONG LOCATION" });
}));
r.get("/qr", wrap(async (req, res) => {
  const payload = String(req.query.payload || "").slice(0, 500);
  if (!payload) return res.status(400).json({ message: "payload required" });
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.type("image/svg+xml").send(svg);
}));

// QC outcome permissions: PASS needs qc.approve, FAIL needs qc.reject, HOLD needs qc.hold; re-tests also need qc.retest.
const qcGuard = (type) => wrap(async (req, res, next) => {
  const need = { PASS: P.QC_APPROVE, FAIL: P.QC_REJECT, HOLD: P.QC_HOLD }[req.body.result];
  if (!(await can(req.user.role, need))) throw forbidden(`Recording a ${req.body.result} result needs ${need}.`);
  if (type === "RETEST" && !(await can(req.user.role, P.QC_RETEST))) throw forbidden("Re-tests need qc.retest.");
  next();
});

// ---------- RECEIVING ----------
const receiveBody = z.object({
  supplierId: oid, invoiceNo: z.string().trim().max(100).default(""), invoiceDate: str(40).optional(), notes: str(500).optional(), poNumber: str(40).optional(), override,
  lines: z.array(z.object({ partNumber: req_(80), quantity: num, revision: str(40).optional(), batchNumber: str(80).optional(), serialNumbers: z.array(str(80)).max(5000).optional() })).min(1).max(200),
});
r.post("/receiving", requirePerm(P.RECEIVE), validate(receiveBody), wrap(async (req, res) => res.status(201).json(await materials.receive(req.user, req.body))));
r.get("/receiving", requirePerm(P.INV_VIEW), wrap(async (req, res) => paged(req, res, M.Receipt, {}, { createdAt: -1 }, [["supplier", "name code"], ["receivedBy", "name"]])));
r.get("/receiving/:id", requirePerm(P.INV_VIEW), wrap(async (req, res) => {
  const rc = await M.Receipt.findById(req.params.id).populate("supplier", "name code").lean();
  if (!rc) throw notFound("Receipt", req.params.id);
  const items = await M.MaterialItem.find({ receipt: rc._id }).lean();
  res.json({ ...rc, items });
}));
const qcBody = z.object({ materialItemId: oid.optional(), vehicleId: oid.optional(), result: z.enum(["PASS", "FAIL", "HOLD"]), remarks: str(1000).optional(), reworkRequired: z.boolean().optional(),
  measurements: z.array(z.object({ parameter: str(80), value: str(80), unit: str(20).optional(), spec: str(80).optional(), pass: z.boolean().optional() })).max(100).optional(),
  attachments: z.array(z.object({ name: str(120), url: str(500) })).max(20).optional() });
r.post("/receiving/:id/qc", requirePerm(P.QC_PERFORM), validate(qcBody.extend({ materialItemId: oid })), qcGuard("INCOMING"), wrap(async (req, res) => {
  const item = await M.MaterialItem.findById(req.body.materialItemId);
  if (!item || String(item.receipt) !== String(req.params.id)) throw notFound("Item in this receipt", req.body.materialItemId);
  res.json(await materials.inspect(req.user, req.body, "INCOMING"));
}));
for (const [path, type] of [["incoming", "INCOMING"], ["component", "COMPONENT"], ["in-process", "IN_PROCESS"], ["final", "FINAL"], ["retest", "RETEST"]]) {
  r.post(`/qc/${path}`, requirePerm(P.QC_PERFORM), validate(qcBody), qcGuard(type), wrap(async (req, res) => res.json(await materials.inspect(req.user, req.body, type))));
}
r.get("/qc", requirePerm(P.QC_HISTORY, P.QC_VIEW), wrap(async (req, res) => {
  const q = {}; if (req.query.materialItemId && /^[a-f\d]{24}$/i.test(req.query.materialItemId)) q.materialItem = req.query.materialItemId; if (req.query.type) q.inspectionType = String(req.query.type);
  return paged(req, res, M.QCInspection, q, { createdAt: -1 }, [["inspector", "name"], ["materialItem", "partNumber serialNumber batchNumber status"], ["vehicle", "vehicleNumber"]]);
}));
r.get("/qc/queue", requirePerm(P.QC_VIEW, P.INV_VIEW), wrap(async (req, res) => {
  const map = { incoming: ["PENDING_INCOMING_QC"], retest: ["HOLD", "PENDING_RETEST", "QC_REQUIRED"], rework: ["REJECTED", "REWORK"], component: ["APPROVED"] };
  const st = map[req.query.kind] || map.incoming;
  res.json(await M.MaterialItem.find({ status: { $in: st } }).sort({ createdAt: -1 }).limit(300).lean());
}));

// ---------- MATERIAL ----------
r.get("/materials", requirePerm(P.INV_VIEW, P.QC_VIEW, P.ASM_VIEW), wrap(async (req, res) => {
  if (req.query.q) return res.json(await reports.materialSearch(req.query.q));
  const q = {}; if (req.query.status) q.status = String(req.query.status);
  return paged(req, res, M.MaterialItem, q, { createdAt: -1 });
}));
r.get("/materials/awaiting-putaway", requirePerm(P.INV_VIEW), wrap(async (req, res) => {
  const rec = await M.Location.findOne({ type: "RECEIVING" });
  const rows = await M.StockBalance.find({ location: rec._id, quantity: { $gt: 0 } }).populate("materialItem").lean();
  res.json(rows.filter((x) => x.materialItem.status === "APPROVED").map((x) => ({ ...x.materialItem, quantityToPutAway: x.quantity })));
}));
r.get("/materials/:id", requirePerm(P.SCAN, P.INV_VIEW, P.QC_VIEW, P.ASM_VIEW), wrap(async (req, res) => res.json(await scanSvc.describeItem(await materials.getItem(req.params.id)))));
r.get("/materials/:id/put-away-plan", requirePerm(P.INV_VIEW, P.PUTAWAY), wrap(async (req, res) => { const p = await materials.putAwayPlan(req.params.id); res.json({ needsPutAway: p.needsPutAway, quantity: p.qty, destination: p.destination, status: p.item.status }); }));
r.post("/materials/:id/put-away", requirePerm(P.PUTAWAY), validate(z.object({ scannedLocation: req_(200), quantity: num.optional(), override })), wrap(async (req, res) => res.json(await materials.putAway(req.user, req.params.id, req.body))));
r.post("/materials/:id/disposition", requirePerm(P.QC_PERFORM), validate(z.object({ action: z.enum(["REQUALIFY", "REWORK", "REWORK_DONE", "RETURN_TO_SUPPLIER", "SCRAP"]), reason: req_(500) })), wrap(async (req, res) => res.json(await materials.disposition(req.user, { ...req.body, materialItemId: req.params.id }))));
r.post("/materials/:id/status-override", requirePerm(P.OVERRIDE), validate(z.object({ toStatus: req_(40), reason: req_(500), confirm: z.boolean() })), wrap(async (req, res) => res.json(await materials.statusOverride(req.user, { ...req.body, materialItemId: req.params.id }))));
r.get("/materials/:id/label", requirePerm(P.INV_VIEW), wrap(async (req, res) => { const it = await materials.getItem(req.params.id); res.json({ payload: it.qrCode || codes.materialPayload(it), partNumber: it.partNumber, serialNumber: it.serialNumber, batchNumber: it.batchNumber, revision: it.partRevision, quantity: it.quantity }); }));

// ---------- INVENTORY ----------
const qtyBody = { materialItemId: oid, quantity: num.refine((v) => v > 0, "quantity must be > 0") };
r.post("/inventory/issue", requirePerm(P.ISSUE), validate(z.object({ ...qtyBody, fromLocation: req_(100), purpose: req_(300), override })), wrap(async (req, res) => res.json(await materials.issue(req.user, req.body))));
r.post("/inventory/return", requirePerm(P.RETURN), validate(z.object({ ...qtyBody, reason: req_(300) })), wrap(async (req, res) => res.json(await materials.returnStock(req.user, req.body))));
r.post("/inventory/transfer", requirePerm(P.TRANSFER), validate(z.object({ ...qtyBody, fromLocation: req_(100), toLocation: req_(100), reason: str(300).optional(), override })), wrap(async (req, res) => res.json(await materials.transfer(req.user, req.body))));
r.post("/inventory/adjust", requirePerm(P.ADJUST), validate(z.object({ materialItemId: oid, location: req_(100), newQuantity: num, reason: req_(500), confirm: z.boolean() })), wrap(async (req, res) => res.json(await materials.adjust(req.user, req.body))));
r.get("/inventory/transactions", requirePerm(P.TXN_VIEW, P.REPORTS), wrap(async (req, res) => { res.set("X-Total-Count", String(await reports.transactions(req.query, "count"))); res.json(await reports.transactions(req.query)); }));
r.get("/inventory/stock", requirePerm(P.INV_VIEW), wrap(async (req, res) => { const all = await reports.inventoryReport(req.query); const { skip, limit } = lim(req); res.set("X-Total-Count", String(all.length)); res.json(all.slice(skip, skip + limit)); }));

// ---------- HANDOVER ----------
r.post("/handover", requirePerm(P.HO_CREATE), validate(z.object({ ...qtyBody, toUserId: oid, fromLocation: req_(100), purpose: req_(300), department: str(100).optional(), override })), wrap(async (req, res) => res.status(201).json(await handover.create(req.user, req.body))));
r.get("/handover", requirePerm(P.HO_VIEW), wrap(async (req, res) => {
  const q = {}; if (req.query.status) q.status = String(req.query.status);
  if (req.query.mine === "true") q.$or = [{ toUser: req.user.id }, { fromUser: req.user.id }];
  if (req.query.pendingForMe === "true") { q.toUser = req.user.id; q.status = "PENDING"; }
  res.json(await M.Handover.find(q).sort({ handedOverAt: -1 }).limit(300).lean());
}));
r.post("/handover/:id/acknowledge", requirePerm(P.HO_RESPOND), validate(z.object({ note: str(300).optional() })), wrap(async (req, res) => res.json(await handover.acknowledge(req.user, req.params.id, req.body))));
r.post("/handover/:id/refuse", requirePerm(P.HO_RESPOND), validate(z.object({ reason: z.string().trim().max(500).default("") })), wrap(async (req, res) => res.json(await handover.refuse(req.user, req.params.id, req.body))));

// ---------- VEHICLES / ASSEMBLY ----------
const vScan = wrap(async (req, res) => res.json(await scanSvc.scan(req.body.code || req.body.vehicle, {})));
r.post("/vehicles/scan", requirePerm(P.VEH_VIEW, P.ASM_VIEW), validate(z.object({ code: req_(100) })), wrap(async (req, res) => {
  const v = await assembly.getVehicle(req.body.code);
  res.json(await assembly.vehicleView(v));
}));
r.get("/vehicles", requirePerm(P.VEH_VIEW, P.ASM_VIEW), wrap(async (req, res) => { const q = req.query.status ? { status: String(req.query.status) } : {}; res.json(await M.Vehicle.find(q).sort({ createdAt: -1 }).limit(500).lean()); }));
r.get("/vehicles/:id", requirePerm(P.VEH_VIEW, P.ASM_VIEW), wrap(async (req, res) => res.json(await assembly.vehicleView(await assembly.getVehicle(req.params.id)))));
const instBody = { vehicle: req_(100), materialItemId: oid, quantity: num.optional(), fromLocation: str(100).optional() };
r.post("/vehicles/:id/check", requirePerm(P.ASM_VIEW, P.INSTALL), validate(z.object({ materialItemId: oid, quantity: num.optional(), fromLocation: str(100).optional() })), wrap(async (req, res) => res.json(await assembly.check({ ...req.body, vehicle: req.params.id }))));
r.post("/vehicles/:id/install", requirePerm(P.INSTALL), validate(z.object({ materialItemId: oid, quantity: num.optional(), fromLocation: str(100).optional(), override })), wrap(async (req, res) => res.json(await assembly.install(req.user, { ...req.body, vehicle: req.params.id }))));
r.post("/vehicles/:id/remove", requirePerm(P.REMOVE), validate(z.object({ materialItemId: oid, quantity: num.optional(), reason: req_(500), disposition: z.enum(["AVAILABLE", "QC_REQUIRED", "HOLD", "REWORK"]), override })), wrap(async (req, res) => res.json(await assembly.remove(req.user, { ...req.body, vehicle: req.params.id }))));
r.get("/installations", requirePerm(P.ASM_VIEW, P.VEH_TRACE), wrap(async (req, res) => { const q = {}; if (req.query.active) q.active = req.query.active === "true"; return paged(req, res, M.Installation, q, { installedAt: -1 }); }));

// ---------- TRACEABILITY / REPORTS ----------
r.get("/traceability/vehicle/:id", requirePerm(P.VEH_TRACE, P.REPORTS), wrap(async (req, res) => res.json(await reports.vehicleTrace(req.params.id))));
r.get("/traceability/component/:id", requirePerm(P.VEH_TRACE, P.REPORTS, P.INV_VIEW), wrap(async (req, res) => res.json(await reports.componentTrace(req.params.id))));
r.get("/traceability/serial/:serial", requirePerm(P.VEH_TRACE, P.REPORTS, P.INV_VIEW), wrap(async (req, res) => res.json(await reports.componentTrace(req.params.serial))));
r.get("/audit", requirePerm(P.AUDIT), wrap(async (req, res) => { res.set("X-Total-Count", String(await reports.auditTrail(req.query, "count"))); res.json(await reports.auditTrail(req.query)); }));
r.get("/overrides", requirePerm(P.AUDIT), wrap(async (req, res) => res.json(await M.OverrideRecord.find().sort({ at: -1 }).limit(300).lean())));
r.get("/dashboard", requirePerm(P.DASHBOARD), wrap(async (req, res) => res.json(await reports.dashboard())));

// ---------- FIFO issue, vehicle timeline, workbenches, gate passes ----------
r.post("/inventory/issue-fifo", requirePerm(P.ISSUE), validate(z.object({ partNumber: req_(60), quantity: num.refine((v) => v > 0, "quantity must be > 0"), purpose: req_(300), revision: str(40).optional() })), wrap(async (req, res) => res.json(await materials.issueFifo(req.user, req.body))));
r.get("/inventory/fifo-next", requirePerm(P.INV_VIEW), wrap(async (req, res) => {
  const part = await M.PartMaster.findOne({ partNumber: String(req.query.partNumber || "").toUpperCase() }); if (!part) throw notFound("Part", req.query.partNumber);
  const { allocations, shortage } = await require("../domain/fifo").pickOldest(part, Number(req.query.quantity) || 1, req.query.revision && String(req.query.revision));
  res.json({ partNumber: part.partNumber, shortage, allocations: allocations.map((a) => ({ itemId: a.item._id, serialNumber: a.item.serialNumber, batchNumber: a.item.batchNumber, revision: a.item.partRevision, quantity: a.qty, receivedAt: a.item.createdAt })) });
}));
r.get("/vehicles/:id/timeline", requirePerm(P.VEH_TRACE, P.VEH_VIEW, P.ASM_VIEW), wrap(async (req, res) => res.json(await reports.vehicleTimeline(req.params.id))));
r.get("/workbench/:kind", wrap(async (req, res, next) => {
  const need = { store: [P.INV_VIEW], qc: [P.QC_VIEW], assembly: [P.ASM_VIEW], engineering: [P.ENG_VIEW] }[req.params.kind];
  if (!need) throw notFound("Workbench", req.params.kind);
  for (const p of need) if (await can(req.user.role, p)) return res.json(await insights.workbench(req.params.kind, req.user));
  throw forbidden();
}));

const gpBody = z.object({ date: str(20).optional(), supplier: req_(200), dispatchMode: str(60).optional(), returnable: z.boolean().optional(), returnDate: str(20).optional(), remarks: str(1000).optional(), issuedBy: str(100).optional(), receivedBy: str(100).optional(),
  items: z.array(z.object({ name: str(200), partNumber: str(60).optional(), serialBatch: str(100).optional(), qty: z.union([z.string(), z.number()]).transform(String), uom: str(20).optional() })).min(1).max(100) });
r.get("/gatepasses", requirePerm(P.GP_VIEW), wrap(async (req, res) => res.json(await require("../models/legacy").GatePass.find().sort({ createdAt: -1 }).limit(500).lean())));
r.get("/gatepasses/next-ref", requirePerm(P.GP_CREATE), wrap(async (req, res) => res.json({ refNo: "assigned on save" })));
r.get("/gatepasses/:id", requirePerm(P.GP_VIEW), wrap(async (req, res) => res.json(await gatepass.load(req.params.id))));
r.post("/gatepasses", requirePerm(P.GP_CREATE), validate(gpBody), wrap(async (req, res) => res.status(201).json(await gatepass.create(req.user, req.body))));
r.post("/gatepasses/:id/print", requirePerm(P.GP_PRINT, P.GP_REPRINT), validate(z.object({ reason: str(300).optional() })), wrap(async (req, res) => res.json(await gatepass.print(req.user, req.params.id, req.body))));

module.exports = r;
