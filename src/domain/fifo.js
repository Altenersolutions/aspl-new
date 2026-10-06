// FIFO: where a part is FIFO-applicable, the oldest eligible stock must be used first.
const { MaterialItem, PartMaster } = require("../models");
const { MS } = require("./constants");
const { BusinessError } = require("./errors");
const { P } = require("./permissions");
const ledger = require("./ledger");
const { rules } = require("./partRules");
const { reservedQty, binQty } = require("./reservations");

const free = async (it) => (await binQty(it._id)) - (await reservedQty(it._id));

// Oldest approved stock of the same part (and revision, if revision-controlled) that is older than `item` and still free in a bin.
async function olderEligible(item, part) {
  const r = rules(part); if (!r.fifo) return null;
  const q = { part: item.part, status: MS.APPROVED, _id: { $ne: item._id }, $or: [{ createdAt: { $lt: item.createdAt } }, { createdAt: item.createdAt, _id: { $lt: item._id } }] };
  if (r.revisionControlled && item.partRevision) q.partRevision = item.partRevision;
  for (const o of await MaterialItem.find(q).sort({ createdAt: 1, _id: 1 }).limit(50).lean()) {
    if (o.installedOn) continue;
    const f = await free(o); if (f <= 0) continue;
    const b = (await ledger.balancesOf(o._id)).find((x) => x.location.type === "BIN");
    return { id: o._id, serialNumber: o.serialNumber, batchNumber: o.batchNumber, revision: o.partRevision, receivedAt: o.createdAt, free: f, location: b && (b.location.path || b.location.locationCode) };
  }
  return null;
}
async function assertFifo(item, part) {
  const older = await olderEligible(item, part || (await PartMaster.findById(item.part)));
  if (!older) return;
  throw new BusinessError("FIFO_VIOLATION", `FIFO: older stock of ${item.partNumber} must be used first (${older.serialNumber || older.batchNumber} at ${older.location || "a bin"}, ${older.free} available).`, {
    overridable: true, overrideKind: "FIFO_OVERRIDE", overridePerm: P.FIFO_OVERRIDE, details: { suggested: older },
  });
}
// Oldest-first candidates able to supply `qty` (used by auto-select issue).
async function pickOldest(part, qty, revision) {
  const q = { part: part._id, status: MS.APPROVED, ...(revision && { partRevision: revision }) };
  const out = []; let need = qty;
  for (const it of await MaterialItem.find(q).sort({ createdAt: 1, _id: 1 }).lean()) {
    if (need <= 0) break; if (it.installedOn) continue;
    const f = await free(it); if (f <= 0) continue;
    const take = Math.min(f, need); out.push({ item: it, qty: take }); need -= take;
  }
  return { allocations: out, shortage: Math.max(0, need) };
}
module.exports = { olderEligible, assertFifo, pickOldest };
