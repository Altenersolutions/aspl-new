const { CycleCount, StockBalance, MaterialItem, Location } = require("../models");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { nextId } = require("./counters");
const { audit } = require("./audit");
const ledger = require("./ledger");
const { getLocation } = require("./materials");

async function start(user, body) {
  const loc = await getLocation(body.location);
  if (loc.type !== "BIN") throw new BusinessError("INVALID_LOCATION", "Cycle counts are done per storage bin.", { status: 400 });
  if (await CycleCount.exists({ location: loc._id, status: { $in: ["OPEN", "SUBMITTED"] } })) throw new BusinessError("COUNT_ALREADY_OPEN", `A count for ${loc.locationCode} is already in progress.`);
  const rows = await StockBalance.find({ location: loc._id, quantity: { $gt: 0 } }).populate("materialItem").lean();
  return atomic(async (ctx) => {
    const c = await ctx.create(CycleCount, { countId: await nextId("count", "CC", 5), location: loc._id, locationCode: loc.locationCode, startedBy: user.id, startedByName: user.name,
      lines: rows.map((r) => ({ materialItem: r.materialItem._id, partNumber: r.materialItem.partNumber, serialNumber: r.materialItem.serialNumber, batchNumber: r.materialItem.batchNumber, systemQty: r.quantity })) });
    await audit(ctx, user, { action: "CYCLE_COUNT_STARTED", entityType: "CycleCount", entityId: c._id, entityLabel: c.countId, where: loc.locationCode });
    return c;
  });
}
async function get(id) { const c = /^[a-f\d]{24}$/i.test(String(id)) ? await CycleCount.findById(id) : await CycleCount.findOne({ countId: String(id) }); if (!c) throw notFound("Cycle count", id); return c; }
async function submit(user, id, body) {
  const c = await get(id); if (c.status !== "OPEN") throw new BusinessError("COUNT_CLOSED", `Count is ${c.status}.`);
  const counts = new Map((body.counts || []).map((x) => [String(x.materialItemId), Number(x.countedQty)]));
  const lines = c.lines.map((l) => l.toObject());
  for (const l of lines) {
    const q = counts.get(String(l.materialItem));
    if (q === undefined || !Number.isFinite(q) || q < 0) throw invalid(`Counted quantity missing or invalid for ${l.partNumber} ${l.serialNumber || l.batchNumber}.`);
    l.countedQty = q; l.variance = q - l.systemQty;
  }
  return atomic(async (ctx) => {
    await ctx.set(CycleCount, c._id, { lines, status: "SUBMITTED", submittedAt: new Date() });
    await audit(ctx, user, { action: "CYCLE_COUNT_SUBMITTED", entityType: "CycleCount", entityId: c._id, entityLabel: c.countId, after: { variances: lines.filter((l) => l.variance).length } });
    return { ok: true, variances: lines.filter((l) => l.variance) };
  });
}
async function approve(user, id, body) {
  const c = await get(id); if (c.status !== "SUBMITTED") throw new BusinessError("COUNT_NOT_SUBMITTED", `Count is ${c.status}; it must be submitted first.`);
  if (!body.confirm) throw new BusinessError("OVERRIDE_CONFIRMATION_REQUIRED", "Approval must be confirmed.", { status: 400 });
  const variances = c.lines.filter((l) => l.variance);
  if (variances.length && (!body.reason || String(body.reason).trim().length < 5)) throw new BusinessError("OVERRIDE_REASON_REQUIRED", "A reason is required to post count adjustments.", { status: 400 });
  return atomic(async (ctx) => {
    let posted = 0;
    for (const l of variances) {
      const item = await MaterialItem.findById(l.materialItem);
      const row = await StockBalance.findOne({ materialItem: l.materialItem, location: c.location });
      const cur = row ? row.quantity : 0;
      if (cur !== l.systemQty) throw new BusinessError("COUNT_STALE", `Stock of ${l.partNumber} ${l.serialNumber || l.batchNumber} changed since the count started (${l.systemQty} → ${cur}). Cancel and recount this bin.`);
      await ledger.post(ctx, user, { type: "ADJUSTMENT", item, qty: Math.abs(l.variance), from: l.variance < 0 ? c.location : null, to: l.variance > 0 ? c.location : null, fromStatus: item.status, toStatus: item.status, reason: `Cycle count ${c.countId}: ${body.reason}`, refType: "CycleCount", refId: c.countId, override: true });
      posted++;
    }
    await ctx.set(CycleCount, c._id, { status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), approvalNote: body.reason });
    await audit(ctx, user, { action: "CYCLE_COUNT_APPROVED", entityType: "CycleCount", entityId: c._id, entityLabel: c.countId, where: c.locationCode, reason: body.reason, after: { adjustmentsPosted: posted }, override: posted > 0 });
    return { ok: true, adjustmentsPosted: posted };
  });
}
async function cancel(user, id) { const c = await get(id); if (!["OPEN", "SUBMITTED"].includes(c.status)) throw new BusinessError("COUNT_CLOSED", `Count is ${c.status}.`); return atomic(async (ctx) => { await ctx.set(CycleCount, c._id, { status: "CANCELLED" }); await audit(ctx, user, { action: "CYCLE_COUNT_CANCELLED", entityType: "CycleCount", entityId: c._id, entityLabel: c.countId }); return { ok: true }; }); }
module.exports = { start, get, submit, approve, cancel };
