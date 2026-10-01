// The ONLY place stock quantities change. Every movement = guarded balance update +
// immutable InventoryTransaction, inside the caller's unit of work.
const { StockBalance, InventoryTransaction } = require("../models");
const { BusinessError } = require("./errors");
const { nextId } = require("./counters");

async function post(ctx, user, m) {
  const { type, item, qty, from, to } = m;
  if (!(qty > 0)) throw new BusinessError("INVALID_QUANTITY", "Quantity must be greater than zero.", { status: 400 });
  if (item.trackingType === "SERIAL" && qty !== 1) throw new BusinessError("INVALID_QUANTITY", "Serialised units always move with quantity 1.", { status: 400 });
  if (!Number.isFinite(qty) || (item.trackingType === "SERIAL" && !Number.isInteger(qty))) throw new BusinessError("INVALID_QUANTITY", "Invalid quantity.", { status: 400 });

  const sameSpot = from && to && String(from) === String(to);
  if (from && !sameSpot) {
    const dec = await ctx.inc(StockBalance, { materialItem: item._id, location: from, quantity: { $gte: qty } }, -qty);
    if (!dec) {
      const cur = await StockBalance.findOne({ materialItem: item._id, location: from }).lean();
      throw new BusinessError("INSUFFICIENT_STOCK", `Only ${cur ? cur.quantity : 0} available at the source location; ${qty} requested. Negative stock is not allowed.`, { details: { available: cur ? cur.quantity : 0, requested: qty } });
    }
  }
  if (to && !sameSpot) await ctx.inc(StockBalance, { materialItem: item._id, location: to }, qty, { upsert: true, setOnInsert: { part: item.part } });

  const transactionId = await nextId("txn", "TXN", 7);
  return ctx.create(InventoryTransaction, {
    transactionId, transactionType: type,
    part: item.part, partNumber: item.partNumber, materialItem: item._id,
    serialNumber: item.serialNumber, batchNumber: item.batchNumber,
    quantity: qty, fromLocation: from, toLocation: to,
    fromStatus: m.fromStatus, toStatus: m.toStatus,
    vehicle: m.vehicle, user: user && user.id, userName: user && user.name,
    reason: m.reason, referenceType: m.refType, referenceId: m.refId ? String(m.refId) : undefined,
    override: !!m.override, timestamp: new Date(),
  });
}

// Zero-quantity ledger entry for status-only events (e.g. admin status override).
async function note(ctx, user, m) {
  const { item } = m;
  const transactionId = await nextId("txn", "TXN", 7);
  return ctx.create(InventoryTransaction, {
    transactionId, transactionType: m.type, part: item.part, partNumber: item.partNumber, materialItem: item._id,
    serialNumber: item.serialNumber, batchNumber: item.batchNumber, quantity: 0,
    fromStatus: m.fromStatus, toStatus: m.toStatus, vehicle: m.vehicle, user: user && user.id, userName: user && user.name,
    reason: m.reason, referenceType: m.refType, referenceId: m.refId ? String(m.refId) : undefined, override: !!m.override, timestamp: new Date(),
  });
}

const balancesOf = (itemId) => StockBalance.find({ materialItem: itemId, quantity: { $gt: 0 } }).populate("location").lean();
const totalQty = async (itemId) => (await StockBalance.find({ materialItem: itemId }).lean()).reduce((s, b) => s + b.quantity, 0);

module.exports = { post, note, balancesOf, totalQty };
