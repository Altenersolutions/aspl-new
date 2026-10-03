const { MaterialItem, InventoryTransaction, QCInspection, Installation, Handover, Vehicle, Receipt, StockBalance, PartMaster, AuditLog, Location, Supplier } = require("../models");
const { MS } = require("./constants");
const { notFound } = require("./errors");
const assembly = require("./assembly");

const isId = (v) => /^[a-f\d]{24}$/i.test(String(v));
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function materialTrace(item) {
  const [txns, qcs, installs, handovers, receipt, supplier, balances] = await Promise.all([
    InventoryTransaction.find({ materialItem: item._id }).sort({ timestamp: 1 }).populate("fromLocation toLocation", "locationCode path").populate("vehicle", "vehicleNumber").lean(),
    QCInspection.find({ materialItem: item._id }).sort({ createdAt: 1 }).populate("inspector", "name").lean(),
    Installation.find({ materialItem: item._id }).sort({ installedAt: 1 }).lean(),
    Handover.find({ materialItem: item._id }).sort({ handedOverAt: 1 }).lean(),
    item.receipt ? Receipt.findById(item.receipt).lean() : null,
    item.supplier ? Supplier.findById(item.supplier).lean() : null,
    StockBalance.find({ materialItem: item._id, quantity: { $gt: 0 } }).populate("location", "locationCode path type").lean(),
  ]);
  return { item, receipt: receipt && { receiptNo: receipt.receiptNo, invoiceNo: receipt.invoiceNo, createdAt: receipt.createdAt }, supplier: supplier && { code: supplier.code, name: supplier.name },
    currentLocations: balances.map((b) => ({ code: b.location.locationCode, path: b.location.path, type: b.location.type, quantity: b.quantity })), transactions: txns, qc: qcs, handovers, installations: installs };
}

async function componentTrace(idOrSerial) {
  let item = isId(idOrSerial) ? await MaterialItem.findById(idOrSerial) : null;
  if (!item) { const list = await MaterialItem.find({ $or: [{ serialNumber: idOrSerial }, { batchNumber: idOrSerial }] }); if (list.length > 1) return { multiple: list.map((i) => ({ id: i._id, partNumber: i.partNumber, serialNumber: i.serialNumber, batchNumber: i.batchNumber })) }; item = list[0]; }
  if (!item) throw notFound("Component", idOrSerial);
  return materialTrace(item);
}

async function vehicleTrace(ref) {
  const vehicle = await assembly.getVehicle(ref);
  const view = await assembly.vehicleView(vehicle);
  const history = await Installation.find({ vehicle: vehicle._id }).sort({ installedAt: 1 }).lean();
  const qc = await QCInspection.find({ $or: [{ vehicle: vehicle._id }, { materialItem: { $in: history.map((h) => h.materialItem) } }] }).sort({ createdAt: 1 }).populate("inspector", "name").lean();
  const txns = await InventoryTransaction.find({ vehicle: vehicle._id }).sort({ timestamp: 1 }).lean();
  return { vehicle, bomRevision: view.bomRevision, bomProgress: view.items, complete: view.complete, installedComponents: history, qc, transactions: txns };
}

async function materialSearch(q) {
  const term = String(q || "").trim();
  if (!term) return [];
  const rx = new RegExp(esc(term), "i");
  const parts = await PartMaster.find({ $or: [{ partNumber: rx }, { partName: rx }] }).select("_id").lean();
  const sup = await Supplier.find({ $or: [{ name: rx }, { code: rx }] }).select("_id").lean();
  return MaterialItem.find({ $or: [{ serialNumber: rx }, { batchNumber: rx }, { invoiceNo: rx }, { partNumber: rx }, { part: { $in: parts.map((p) => p._id) } }, { supplier: { $in: sup.map((s) => s._id) } }] }).limit(100).sort({ createdAt: -1 }).lean();
}

async function transactions({ type, part, user, from, to, limit = 200, skip = 0, serial, batch } = {}) {
  const q = {};
  if (type) q.transactionType = type;
  if (part) q.partNumber = String(part).toUpperCase();
  if (serial) q.serialNumber = serial; if (batch) q.batchNumber = batch;
  if (user) q.userName = new RegExp(esc(user), "i");
  if (from || to) q.timestamp = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
  if (arguments[1] === "count") return InventoryTransaction.countDocuments(q);
  return InventoryTransaction.find(q).sort({ timestamp: -1 }).skip(Number(skip)).limit(Math.min(Number(limit), 1000)).populate("fromLocation toLocation", "locationCode path").populate("vehicle", "vehicleNumber").lean();
}

async function auditTrail({ action, entityType, user, from, to, override, limit = 200, skip = 0 } = {}) {
  const q = {};
  if (action) q.action = new RegExp(esc(action), "i");
  if (entityType) q.entityType = entityType;
  if (user) q.userName = new RegExp(esc(user), "i");
  if (override === "true") q.override = true;
  if (from || to) q.at = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
  if (arguments[1] === "count") return AuditLog.countDocuments(q);
  return AuditLog.find(q).sort({ at: -1 }).skip(Number(skip)).limit(Math.min(Number(limit), 1000)).lean();
}

async function inventoryReport({ status, category, lowOnly } = {}) {
  const rows = await StockBalance.find({ quantity: { $gt: 0 } }).populate("materialItem").populate("location", "locationCode path type").lean();
  const out = rows.filter((r) => r.materialItem && (!status || r.materialItem.status === status)).map((r) => ({ itemId: r.materialItem._id, partNumber: r.materialItem.partNumber, serialNumber: r.materialItem.serialNumber, batchNumber: r.materialItem.batchNumber, status: r.materialItem.status, location: r.location.locationCode, locationPath: r.location.path, locationType: r.location.type, quantity: r.quantity, legacy: r.materialItem.legacy }));
  return out;
}

async function stockByPart() {
  const rows = await StockBalance.aggregate([{ $match: { quantity: { $gt: 0 } } }, { $lookup: { from: "wmsmaterialitems", localField: "materialItem", foreignField: "_id", as: "mi" } }, { $unwind: "$mi" }, { $lookup: { from: "wmslocations", localField: "location", foreignField: "_id", as: "loc" } }, { $unwind: "$loc" }, { $group: { _id: { part: "$mi.part", status: "$mi.status", ltype: "$loc.type" }, qty: { $sum: "$quantity" } } }]);
  return rows;
}

async function dashboard() {
  const balances = await StockBalance.find({ quantity: { $gt: 0 } }).populate("materialItem", "status part partNumber").populate("location", "type").lean();
  const sum = (fn) => balances.filter(fn).reduce((t, b) => t + b.quantity, 0);
  const onHand = (b) => ["BIN", "RECEIVING", "QC_HOLD", "REJECT", "REWORK", "WIP", "TRANSIT"].includes(b.location.type);
  const byPart = {};
  balances.filter((b) => b.materialItem && b.materialItem.status === MS.APPROVED && b.location.type === "BIN").forEach((b) => { byPart[b.materialItem.part] = (byPart[b.materialItem.part] || 0) + b.quantity; });
  const parts = await PartMaster.find({ active: true, minStock: { $gt: 0 } }).lean();
  const low = parts.filter((p) => (byPart[p._id] || 0) < p.minStock).map((p) => ({ partNumber: p.partNumber, partName: p.partName, onHand: byPart[p._id] || 0, minStock: p.minStock }));
  const cnt = (status) => MaterialItem.countDocuments({ status });
  const [pendingQc, hold, rejected, approved, rework, pendingHandovers, underAssembly, recentTxns, recentAudit, receiptsToday] = await Promise.all([
    cnt(MS.PENDING_INCOMING_QC), cnt(MS.HOLD), cnt(MS.REJECTED), cnt(MS.APPROVED), MaterialItem.countDocuments({ status: { $in: [MS.REWORK, MS.PENDING_RETEST, MS.QC_REQUIRED] } }),
    Handover.countDocuments({ status: "PENDING" }), Vehicle.countDocuments({ status: "UNDER_ASSEMBLY" }),
    InventoryTransaction.find().sort({ timestamp: -1 }).limit(8).lean(), AuditLog.find().sort({ at: -1 }).limit(8).lean(),
    Receipt.countDocuments({ status: { $ne: "CLOSED" } }),
  ]);
  const awaitingPutAway = balances.filter((b) => b.location.type === "RECEIVING" && b.materialItem.status === MS.APPROVED).length;
  return {
    kpis: {
      totalInventory: sum(onHand), openReceipts: receiptsToday, pendingIncomingQc: pendingQc, approved, hold, rejected,
      pendingHandovers, awaitingPutAway, lowStock: low.length, vehiclesUnderAssembly: underAssembly, reworkPending: rework,
    },
    lowStock: low, recentTransactions: recentTxns, recentAudit,
  };
}
module.exports = { materialTrace, componentTrace, vehicleTrace, materialSearch, transactions, auditTrail, inventoryReport, dashboard, stockByPart };
