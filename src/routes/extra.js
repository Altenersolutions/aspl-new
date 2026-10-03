const express = require("express");
const { z } = require("zod");
const M = require("../models");
const { wrap, requirePerm, validate } = require("../middleware/common");
const { P } = require("../domain/permissions");
const { BusinessError, notFound, invalid } = require("../domain/errors");
const kitting = require("../domain/kitting");
const counts = require("../domain/cyclecount");
const recall = require("../domain/recall");
const quality = require("../domain/quality");
const insights = require("../domain/insights");
const catalog = require("../domain/catalog");
const reports = require("../domain/reports");
const { toCsv, parseCsv } = require("../domain/csv");
const { AuditLog } = require("../models");

const oid = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const str = (n = 200) => z.string().trim().max(n);
const rq = (n = 200) => z.string().trim().min(1).max(n);
const num = z.coerce.number().finite();
const r = express.Router();
const TYPES = ["INCOMING", "COMPONENT", "IN_PROCESS", "FINAL", "RETEST"];

// ---- search, alerts, analytics ----
r.get("/search", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await insights.search(req.query.q))));
r.get("/alerts", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await insights.alerts())));
r.get("/analytics", requirePerm(P.REPORTS), wrap(async (req, res) => res.json(await insights.analytics())));

// ---- purchase orders ----
r.get("/purchase-orders", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await M.PurchaseOrder.find(req.query.status ? { status: String(req.query.status) } : {}).sort({ createdAt: -1 }).limit(300).populate("supplier", "name code").lean())));
r.post("/purchase-orders", requirePerm(P.RECEIVE), validate(z.object({ poNo: str(40).optional(), supplierId: oid, expectedDate: str(40).optional(), notes: str(500).optional(), lines: z.array(z.object({ partNumber: rq(60), orderedQty: z.number().int().min(1) })).min(1).max(200) })), wrap(async (req, res) => res.status(201).json(await catalog.createPo(req.user, req.body))));
r.post("/purchase-orders/:id/cancel", requirePerm(P.RECEIVE), wrap(async (req, res) => { const po = await M.PurchaseOrder.findById(req.params.id); if (!po) throw notFound("PO"); if (po.status === "CLOSED") throw new BusinessError("PO_CLOSED", "PO is already closed."); po.status = "CANCELLED"; await po.save(); await AuditLog.create({ user: req.user.id, userName: req.user.name, role: req.user.role, action: "PO_CANCELLED", entityType: "PurchaseOrder", entityId: String(po._id), entityLabel: po.poNo }); res.json({ ok: true }); }));

// ---- QC templates ----
const tplBody = z.object({ parameters: z.array(z.object({ parameter: rq(80), kind: z.enum(["NUMERIC", "PASSFAIL", "TEXT"]).default("NUMERIC"), unit: str(20).optional(), min: num.nullable().optional(), max: num.nullable().optional(), mandatory: z.boolean().default(true) })).max(50) });
r.get("/parts/:id/qc-template", requirePerm(P.SCAN), wrap(async (req, res) => { const t = await M.QcTemplate.findOne({ part: req.params.id, inspectionType: String(req.query.type || "INCOMING") }).lean(); res.json(t || { parameters: [] }); }));
r.get("/materials/:id/qc-template", requirePerm(P.SCAN), wrap(async (req, res) => { const it = await M.MaterialItem.findById(req.params.id); if (!it) throw notFound("Material"); const t = await M.QcTemplate.findOne({ part: it.part, inspectionType: String(req.query.type || "INCOMING") }).lean(); res.json(t || { parameters: [] }); }));
r.put("/parts/:id/qc-template", requirePerm(P.ENGINEERING), validate(tplBody), wrap(async (req, res) => { const type = String(req.query.type || "INCOMING"); if (!TYPES.includes(type)) throw invalid("Bad inspection type"); res.json(await quality.setTemplate(req.user, req.params.id, type, req.body.parameters)); }));

// ---- NCR / CAPA ----
r.get("/ncr", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await M.Ncr.find(req.query.status ? { status: String(req.query.status) } : {}).sort({ createdAt: -1 }).limit(300).lean())));
r.put("/ncr/:id", requirePerm(P.QC), validate(z.object({ disposition: z.enum(["REWORK", "RETURN_TO_SUPPLIER", "SCRAP", "USE_AS_IS"]).optional(), rmaNo: str(60).optional(), capa: z.object({ rootCause: str(1000).optional(), correctiveAction: str(1000).optional(), preventiveAction: str(1000).optional(), owner: str(100).optional(), dueDate: str(40).optional() }).optional() })), wrap(async (req, res) => res.json(await quality.updateNcr(req.user, req.params.id, req.body))));
r.post("/ncr/:id/close", requirePerm(P.QC), wrap(async (req, res) => res.json(await quality.closeNcr(req.user, req.params.id))));

// ---- ECO ----
r.get("/eco", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await M.Eco.find().sort({ createdAt: -1 }).limit(300).lean())));
r.get("/eco/impact", requirePerm(P.SCAN), wrap(async (req, res) => { const p = await M.PartMaster.findOne({ partNumber: String(req.query.partNumber || "").toUpperCase() }); if (!p) throw notFound("Part"); res.json(await quality.impact(p, String(req.query.toRevision || ""))); }));
r.post("/eco", requirePerm(P.ENGINEERING), validate(z.object({ partNumber: rq(60), toRevision: rq(40), reason: rq(500), drawingNumber: str(80).optional(), specification: str(1000).optional() })), wrap(async (req, res) => res.status(201).json(await quality.createEco(req.user, req.body))));
r.post("/eco/:id/approve", requirePerm(P.BOM_APPROVE), wrap(async (req, res) => res.json(await quality.decideEco(req.user, req.params.id, true, req.body && req.body.note))));
r.post("/eco/:id/reject", requirePerm(P.BOM_APPROVE), validate(z.object({ note: rq(500) })), wrap(async (req, res) => res.json(await quality.decideEco(req.user, req.params.id, false, req.body.note))));

// ---- kits ----
r.get("/kits", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await M.Kit.find(req.query.status ? { status: String(req.query.status) } : {}).sort({ createdAt: -1 }).limit(300).lean())));
r.post("/kits", requirePerm(P.ISSUE), validate(z.object({ vehicle: rq(60), allowPartial: z.boolean().optional(), includeOptional: z.boolean().optional() })), wrap(async (req, res) => res.status(201).json(await kitting.create(req.user, req.body))));
r.get("/kits/:id", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await kitting.detail(req.params.id))));
r.post("/kits/:id/issue", requirePerm(P.ISSUE), wrap(async (req, res) => res.json(await kitting.issue(req.user, req.params.id))));
r.post("/kits/:id/cancel", requirePerm(P.ISSUE), validate(z.object({ reason: rq(300) })), wrap(async (req, res) => res.json(await kitting.cancel(req.user, req.params.id, req.body.reason))));

// ---- cycle counts ----
r.get("/counts", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await M.CycleCount.find().sort({ createdAt: -1 }).limit(200).lean())));
r.post("/counts", requirePerm(P.TRANSFER), validate(z.object({ location: rq(100) })), wrap(async (req, res) => res.status(201).json(await counts.start(req.user, req.body))));
r.get("/counts/:id", requirePerm(P.SCAN), wrap(async (req, res) => res.json(await counts.get(req.params.id))));
r.post("/counts/:id/submit", requirePerm(P.TRANSFER), validate(z.object({ counts: z.array(z.object({ materialItemId: oid, countedQty: num })).max(2000) })), wrap(async (req, res) => res.json(await counts.submit(req.user, req.params.id, req.body))));
r.post("/counts/:id/approve", requirePerm(P.ADJUST), validate(z.object({ reason: str(500).optional(), confirm: z.boolean() })), wrap(async (req, res) => res.json(await counts.approve(req.user, req.params.id, req.body))));
r.post("/counts/:id/cancel", requirePerm(P.TRANSFER), wrap(async (req, res) => res.json(await counts.cancel(req.user, req.params.id))));

// ---- recall ----
const crit = z.object({ partNumber: str(60).optional(), batchNumber: str(80).optional(), serialNumber: str(80).optional(), supplierCode: str(30).optional(), invoiceNo: str(100).optional(), receiptNo: str(40).optional() });
r.post("/recall/query", requirePerm(P.REPORTS), validate(crit), wrap(async (req, res) => res.json(await recall.query(req.body))));
r.post("/recall/quarantine", requirePerm(P.QC), validate(z.object({ criteria: crit, reason: str(500), confirm: z.boolean() })), wrap(async (req, res) => res.json(await recall.quarantine(req.user, req.body))));

// ---- build book ----
r.get("/traceability/vehicle/:id/build-book", requirePerm(P.REPORTS), wrap(async (req, res) => {
  const t = await reports.vehicleTrace(req.params.id);
  const parts = await M.PartMaster.find({ _id: { $in: t.installedComponents.map((i) => i.part) } }).select("partName").lean(); const nm = new Map(parts.map((p) => [String(p._id), p.partName]));
  res.json({ ...t, installedComponents: t.installedComponents.map((i) => ({ ...i, partName: nm.get(String(i.part)) })), generatedAt: new Date(), generatedBy: req.user.name });
}));

// ---- files (QC photos / drawings), stored in MongoDB so they survive ephemeral hosting ----
const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
r.post("/files", requirePerm(P.SCAN), validate(z.object({ name: rq(120), mime: z.string().max(60), dataBase64: z.string().max(1200000) })), wrap(async (req, res) => {
  if (!MIMES.includes(req.body.mime)) throw invalid("Only JPEG, PNG, WebP or PDF files are allowed.");
  const data = Buffer.from(req.body.dataBase64, "base64"); if (!data.length || data.length > 800 * 1024) throw invalid("File must be between 1 byte and 800 KB.");
  const f = await M.FileBlob.create({ name: req.body.name, mime: req.body.mime, size: data.length, data, uploadedBy: req.user.id });
  res.status(201).json({ id: f._id, name: f.name, url: `/api/files/${f._id}` });
}));
r.get("/files/:id", requirePerm(P.SCAN), wrap(async (req, res) => { const f = /^[a-f\d]{24}$/i.test(req.params.id) && (await M.FileBlob.findById(req.params.id)); if (!f) throw notFound("File"); res.set("Content-Type", f.mime).set("Content-Disposition", `inline; filename="${f.name.replace(/[^\w.\- ]/g, "_")}"`).set("X-Content-Type-Options", "nosniff").send(f.data); }));

// ---- CSV export / import ----
const EXPORTS = {
  stock: async () => [await reports.inventoryReport({}), [["Part", "partNumber"], ["Serial", "serialNumber"], ["Batch", "batchNumber"], ["Status", "status"], ["Location", "location"], ["Location path", "locationPath"], ["Quantity", "quantity"]]],
  transactions: async () => [await reports.transactions({ limit: 1000 }), [["Txn", "transactionId"], ["Type", "transactionType"], ["Part", "partNumber"], ["Serial", "serialNumber"], ["Batch", "batchNumber"], ["Qty", "quantity"], ["From", (t) => t.fromLocation && t.fromLocation.locationCode], ["To", (t) => t.toLocation && t.toLocation.locationCode], ["Vehicle", (t) => t.vehicle && t.vehicle.vehicleNumber], ["User", "userName"], ["Reason", "reason"], ["Override", "override"], ["When", "timestamp"]]],
  audit: async () => [await reports.auditTrail({ limit: 1000 }), [["When", "at"], ["User", "userName"], ["Role", "role"], ["Action", "action"], ["Entity", "entityType"], ["Label", "entityLabel"], ["Reason", "reason"], ["Before", "before"], ["After", "after"], ["Reference", "reference"], ["Override", "override"]]],
  parts: async () => [await M.PartMaster.find().sort({ partNumber: 1 }).populate("defaultLocation", "locationCode").lean(), [["partNumber", "partNumber"], ["partName", "partName"], ["description", "description"], ["category", "category"], ["subCategory", "subCategory"], ["unit", "unit"], ["trackingType", "trackingType"], ["defaultBin", (p) => p.defaultLocation && p.defaultLocation.locationCode], ["minStock", "minStock"], ["compatibility", (p) => (p.vehicleCompatibility || []).join(";")], ["revision", "currentRevision"]]],
  qc: async () => [await M.QCInspection.find().sort({ createdAt: -1 }).limit(1000).populate("inspector", "name").lean(), [["Inspection", "inspectionId"], ["Type", "inspectionType"], ["Result", "result"], ["Serial", "serialNumber"], ["Batch", "batchNumber"], ["Inspector", (q) => q.inspector && q.inspector.name], ["Remarks", "remarks"], ["Measurements", "measurements"], ["When", "inspectionDate"]]],
  installations: async () => [await M.Installation.find().sort({ installedAt: -1 }).limit(1000).lean(), [["Vehicle", "vehicleNumber"], ["Part", "partNumber"], ["Serial", "serialNumber"], ["Batch", "batchNumber"], ["Qty", "quantity"], ["Part rev", "partRevision"], ["BOM rev", "bomRevision"], ["Installed by", "installedByName"], ["Installed", "installedAt"], ["Removed", "removedAt"], ["Removal reason", "removalReason"], ["Override", "override"]]],
  ncr: async () => [await M.Ncr.find().sort({ createdAt: -1 }).lean(), [["NCR", "ncrNo"], ["Part", "partNumber"], ["Serial", "serialNumber"], ["Batch", "batchNumber"], ["Invoice", "invoiceNo"], ["Status", "status"], ["Disposition", "disposition"], ["RMA", "rmaNo"], ["Defect", "defect"], ["Root cause", (n) => n.capa && n.capa.rootCause], ["Corrective action", (n) => n.capa && n.capa.correctiveAction]]],
};
r.get("/export/:kind", requirePerm(P.REPORTS), wrap(async (req, res) => {
  const ex = EXPORTS[req.params.kind]; if (!ex) throw notFound("Export", req.params.kind);
  const [rows, cols] = await ex(); res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", `attachment; filename="${req.params.kind}-${new Date().toISOString().slice(0, 10)}.csv"`).send("\uFEFF" + toCsv(rows, cols));
}));
const csvBody = z.object({ csv: z.string().max(1200000), dryRun: z.boolean().optional() });
r.post("/import/parts", requirePerm(P.ENGINEERING), validate(csvBody), wrap(async (req, res) => res.json(await catalog.importParts(req.user, parseCsv(req.body.csv), !!req.body.dryRun))));
r.post("/import/bom", requirePerm(P.ENGINEERING), validate(csvBody.extend({ model: rq(40), revision: rq(40), changeReason: rq(500) })), wrap(async (req, res) => { const rev = await catalog.importBom(req.user, req.body.model, { revision: req.body.revision, changeReason: req.body.changeReason }, parseCsv(req.body.csv)); res.status(201).json({ ok: true, revision: rev.revision, items: rev.items.length, status: rev.status }); }));
r.post("/import/opening-stock", requirePerm(P.ADMIN_MASTER), validate(csvBody), wrap(async (req, res) => res.json(await catalog.importOpeningStock(req.user, parseCsv(req.body.csv), !!req.body.dryRun))));
module.exports = r;
