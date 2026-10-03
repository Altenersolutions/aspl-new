const { Reservation, StockBalance } = require("../models");
const mongoose = require("mongoose");
async function reservedQty(itemId, excludeKit) {
  const q = { materialItem: itemId, status: "ACTIVE", ...(excludeKit && { kit: { $ne: excludeKit } }) };
  return (await Reservation.find(q).lean()).reduce((t, r) => t + r.quantity, 0);
}
async function binQty(itemId) {
  const rows = await StockBalance.find({ materialItem: itemId, quantity: { $gt: 0 } }).populate("location", "type").lean();
  return rows.filter((r) => r.location && r.location.type === "BIN").reduce((t, r) => t + r.quantity, 0);
}
module.exports = { reservedQty, binQty };
