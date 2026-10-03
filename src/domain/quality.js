// NCR / CAPA, QC templates and engineering change orders.
const { Ncr, QcTemplate, Eco, PartMaster, PartRevision, MaterialItem, Installation, BOMRevision, Vehicle } = require("../models");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { nextId } = require("./counters");
const { audit } = require("./audit");
const s = (v) => (v == null ? "" : String(v).trim());

const specText = (p) => (p.kind === "PASSFAIL" ? "pass" : p.kind === "TEXT" ? "" : `${p.min != null ? p.min : "-∞"} … ${p.max != null ? p.max : "∞"}${p.unit ? " " + p.unit : ""}`);
// Evaluate submitted measurements against the part's template. Returns { measurements, failed[] }.
async function applyTemplate(partId, type, measurements = []) {
  const tpl = await QcTemplate.findOne({ part: partId, inspectionType: type }).lean();
  if (!tpl || !tpl.parameters.length) return { measurements, failed: [], template: null };
  const byName = new Map(measurements.map((m) => [m.parameter, m]));
  const out = [], failed = [];
  for (const p of tpl.parameters) {
    const m = byName.get(p.parameter);
    if (!m || m.value === undefined || String(m.value).trim() === "") { if (p.mandatory) throw new BusinessError("QC_MEASUREMENT_REQUIRED", `Measurement required: ${p.parameter}`, { status: 400, details: { parameter: p.parameter } }); continue; }
    let pass = true;
    if (p.kind === "NUMERIC") { const v = Number(m.value); pass = Number.isFinite(v) && (p.min == null || v >= p.min) && (p.max == null || v <= p.max); }
    else if (p.kind === "PASSFAIL") pass = /^(pass|ok|yes|true|1)$/i.test(String(m.value).trim());
    out.push({ parameter: p.parameter, value: String(m.value), unit: p.unit, spec: specText(p), pass });
    if (!pass) failed.push(p.parameter);
  }
  return { measurements: out, failed, template: tpl };
}
async function setTemplate(user, partId, type, parameters) {
  const part = await PartMaster.findById(partId); if (!part) throw notFound("Part", partId);
  for (const p of parameters) if (p.kind === "NUMERIC" && p.min != null && p.max != null && p.min > p.max) throw invalid(`${p.parameter}: min is greater than max`);
  return atomic(async (ctx) => {
    const prev = await QcTemplate.findOne({ part: part._id, inspectionType: type });
    if (!parameters.length) { if (prev) await QcTemplate.deleteOne({ _id: prev._id }); }
    else if (prev) await ctx.set(QcTemplate, prev._id, { parameters, updatedBy: user.id });
    else await ctx.create(QcTemplate, { part: part._id, inspectionType: type, parameters, updatedBy: user.id });
    await audit(ctx, user, { action: "QC_TEMPLATE_CHANGED", entityType: "Part", entityId: part._id, entityLabel: `${part.partNumber} ${type}`, before: prev && prev.parameters, after: parameters });
    return { ok: true };
  });
}

// NCR is raised inside the QC unit of work.
async function raiseNcr(ctx, user, item, insp, defect) {
  return ctx.create(Ncr, { ncrNo: await nextId("ncr", "NCR", 5), materialItem: item._id, part: item.part, partNumber: item.partNumber, serialNumber: item.serialNumber, batchNumber: item.batchNumber, supplier: item.supplier, invoiceNo: item.invoiceNo, inspectionId: insp.inspectionId, quantity: item.quantity, defect, raisedBy: user.id });
}
async function updateNcr(user, id, body) {
  const n = await Ncr.findById(id); if (!n) throw notFound("NCR", id);
  if (n.status === "CLOSED") throw new BusinessError("NCR_CLOSED", "NCR is closed.");
  const patch = {}; ["disposition", "rmaNo"].forEach((k) => body[k] !== undefined && (patch[k] = body[k]));
  if (body.capa) patch.capa = { ...(n.capa ? n.capa.toObject() : {}), ...body.capa };
  if (patch.disposition && n.status === "OPEN") patch.status = "DISPOSITIONED";
  return atomic(async (ctx) => { const u = await ctx.set(Ncr, n._id, patch); await audit(ctx, user, { action: "NCR_UPDATED", entityType: "NCR", entityId: n._id, entityLabel: n.ncrNo, before: { disposition: n.disposition, capa: n.capa }, after: patch }); return u; });
}
async function closeNcr(user, id) {
  const n = await Ncr.findById(id); if (!n) throw notFound("NCR", id);
  if (n.status === "CLOSED") throw new BusinessError("NCR_CLOSED", "NCR is already closed.");
  if (!n.disposition) throw new BusinessError("NCR_INCOMPLETE", "Set a disposition before closing.");
  if (!n.capa || !s(n.capa.rootCause) || !s(n.capa.correctiveAction)) throw new BusinessError("NCR_INCOMPLETE", "Root cause and corrective action are required to close an NCR.");
  if (n.disposition === "RETURN_TO_SUPPLIER" && !s(n.rmaNo)) throw new BusinessError("NCR_INCOMPLETE", "An RMA number is required for return-to-supplier.");
  return atomic(async (ctx) => { await ctx.set(Ncr, n._id, { status: "CLOSED", closedAt: new Date(), closedBy: user.id }); await audit(ctx, user, { action: "NCR_CLOSED", entityType: "NCR", entityId: n._id, entityLabel: n.ncrNo }); return { ok: true }; });
}

// ---- ECO ----
async function impact(part, toRevision) {
  const units = await MaterialItem.find({ part: part._id, status: { $nin: ["SCRAPPED", "RETURNED_TO_SUPPLIER"] } }).lean();
  const other = units.filter((u) => u.partRevision !== toRevision);
  const installs = await Installation.find({ part: part._id, active: true, partRevision: { $ne: toRevision } }).lean();
  const boms = await BOMRevision.find({ "items.part": part._id, status: { $in: ["APPROVED", "DRAFT"] } }).lean();
  const bomRefs = boms.filter((b) => b.items.some((i) => String(i.part) === String(part._id) && i.requiredRevision && i.requiredRevision !== toRevision)).map((b) => `${b.vehicleModel} ${b.revision}`);
  return { stockUnitsOnOtherRevisions: other.length, stockQtyOnOtherRevisions: other.reduce((t, u) => t + u.quantity, 0), installedVehicles: [...new Set(installs.map((i) => i.vehicleNumber))], bomRevisionsPinnedToOtherRevision: bomRefs };
}
async function createEco(user, body) {
  const part = await PartMaster.findOne({ partNumber: s(body.partNumber).toUpperCase() }); if (!part) throw notFound("Part", body.partNumber);
  if (await PartRevision.exists({ part: part._id, revision: body.toRevision })) throw new BusinessError("REVISION_EXISTS", `${part.partNumber} already has revision ${body.toRevision}.`);
  const imp = await impact(part, body.toRevision);
  return atomic(async (ctx) => {
    await ctx.create(PartRevision, { part: part._id, revision: body.toRevision, drawingNumber: body.drawingNumber, specification: body.specification, changeReason: body.reason, status: "DRAFT" });
    const eco = await ctx.create(Eco, { ecoNo: await nextId("eco", "ECO", 5), part: part._id, partNumber: part.partNumber, fromRevision: part.currentRevision, toRevision: body.toRevision, reason: body.reason, impact: imp, requestedBy: user.id });
    await audit(ctx, user, { action: "ECO_CREATED", entityType: "ECO", entityId: eco._id, entityLabel: eco.ecoNo, reason: body.reason, after: { part: part.partNumber, to: body.toRevision, impact: imp } });
    return eco;
  });
}
async function decideEco(user, id, approve, note) {
  const eco = await Eco.findById(id); if (!eco) throw notFound("ECO", id);
  if (eco.status !== "DRAFT") throw new BusinessError("INVALID_STATE_TRANSITION", `ECO is ${eco.status}.`);
  if (!approve && !s(note)) throw invalid("A reason is required to reject an ECO.");
  const part = await PartMaster.findById(eco.part); const rev = await PartRevision.findOne({ part: eco.part, revision: eco.toRevision });
  return atomic(async (ctx) => {
    if (approve) { await ctx.set(PartRevision, rev._id, { status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), effectiveDate: new Date() }); await ctx.set(PartMaster, part._id, { currentRevision: eco.toRevision }); }
    else await ctx.set(PartRevision, rev._id, { status: "OBSOLETE" });
    await ctx.set(Eco, eco._id, { status: approve ? "APPROVED" : "REJECTED", decidedBy: user.id, decidedAt: new Date(), decisionNote: note });
    await audit(ctx, user, { action: approve ? "ECO_APPROVED" : "ECO_REJECTED", entityType: "ECO", entityId: eco._id, entityLabel: eco.ecoNo, reason: note, before: { currentRevision: part.currentRevision }, after: { currentRevision: approve ? eco.toRevision : part.currentRevision } });
    return { ok: true };
  });
}
module.exports = { applyTemplate, setTemplate, raiseNcr, updateNcr, closeNcr, impact, createEco, decideEco };
