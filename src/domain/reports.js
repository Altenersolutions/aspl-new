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
  const byVehicle = {};
  for (const i of installs) { const k = i.vehicleNumber; byVehicle[k] = byVehicle[k] || { vehicle: k, installed: 0, removed: 0 }; if (i.active) byVehicle[k].installed += i.quantity; else byVehicle[k].removed += i.quantity; }
  const onHand = balances.filter((b) => b.location.type !== "VEHICLE").reduce((t, b) => t + b.quantity, 0);
  const consumed = Object.values(byVehicle).reduce((t, v) => t + v.installed, 0);
  const allocation = { total: item.quantity, onHand, installedTotal: consumed, byVehicle: Object.values(byVehicle) };
  return { allocation, item, receipt: receipt && { receiptNo: receipt.receiptNo, invoiceNo: receipt.invoiceNo, createdAt: receipt.createdAt }, supplier: supplier && { code: supplier.code, name: supplier.name },
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

// Everything that happened to a vehicle/chassis, oldest first.
async function vehicleTimeline(ref) {
  const vehicle = await assembly.getVehicle(ref);
  const installs = await Installation.find({ vehicle: vehicle._id }).lean();
  const itemIds = installs.map((i) => i.materialItem);
  const [aud, qc, items, hos, txns, kits] = await Promise.all([
    AuditLog.find({ entityType: "Vehicle", entityId: String(vehicle._id) }).lean(),
    QCInspection.find({ $or: [{ vehicle: vehicle._id }, { materialItem: { $in: itemIds } }] }).populate("inspector", "name").lean(),
    MaterialItem.find({ _id: { $in: itemIds } }).lean(),
    Handover.find({ materialItem: { $in: itemIds } }).lean(),
    InventoryTransaction.find({ materialItem: { $in: itemIds }, transactionType: { $in: ["REWORK", "RETEST"] } }).lean(),
    require("../models").Kit.find({ vehicle: vehicle._id }).lean(),
  ]);
  const ev = []; const label = (x) => `${x.partNumber || ""} ${x.serialNumber || x.batchNumber || ""}`.trim();
  aud.forEach((a) => ev.push({ at: a.at, type: a.action, text: [a.action.replace(/_/g, " ").toLowerCase(), a.entityLabel, a.after && a.after.part ? `${a.after.part} ${a.after.serial || a.after.batch || ""}` : "", a.reason].filter(Boolean).join(" · "), user: a.userName, override: a.override }));
  qc.forEach((q) => ev.push({ at: q.createdAt, type: `QC_${q.inspectionType}`, text: `${q.inspectionType.toLowerCase()} QC ${q.result}${q.serialNumber || q.batchNumber ? " · " + (q.serialNumber || q.batchNumber) : ""}${q.remarks ? " · " + q.remarks : ""}`, user: q.inspector && q.inspector.name }));
  items.forEach((i) => ev.push({ at: i.createdAt, type: "RECEIVED", text: `component received: ${label(i)}${i.invoiceNo ? " · invoice " + i.invoiceNo : ""}`, user: "" }));
  hos.forEach((h) => { ev.push({ at: h.handedOverAt, type: "HANDOVER", text: `handover ${h.handoverId}: ${label(h)} × ${h.quantity} to ${h.toUserName}`, user: h.fromUserName }); if (h.acknowledgedAt) ev.push({ at: h.acknowledgedAt, type: "HANDOVER_ACK", text: `handover ${h.handoverId} acknowledged`, user: h.toUserName }); if (h.refusedAt) ev.push({ at: h.refusedAt, type: "HANDOVER_REFUSED", text: `handover ${h.handoverId} refused: ${h.refusalReason}`, user: h.toUserName }); });
  txns.forEach((t) => ev.push({ at: t.timestamp, type: t.transactionType, text: `${t.transactionType.toLowerCase()}: ${label(t)}${t.reason ? " · " + t.reason : ""}`, user: t.userName }));
  kits.forEach((k) => ev.push({ at: k.createdAt, type: "KIT", text: `kit ${k.kitId} ${k.status.toLowerCase()}`, user: k.createdByName }));
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { vehicle: { id: vehicle._id, vehicleNumber: vehicle.vehicleNumber, vin: vehicle.vin, model: vehicle.model, status: vehicle.status, bomRevision: vehicle.currentBOMRevision, lastAction: vehicle.lastAction, lastUpdatedByName: vehicle.lastUpdatedByName, lastUpdatedAt: vehicle.lastUpdatedAt }, events: ev };
}
module.exports.vehicleTimeline = vehicleTimeline;
