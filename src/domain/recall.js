const { MaterialItem, PartMaster, Supplier, Receipt, Installation, StockBalance, Handover, AuditLog } = require("../models");
const { MS } = require("./constants");
const { BusinessError, invalid } = require("./errors");
const materials = require("./materials");
const s = (v) => (v == null ? "" : String(v).trim());

async function find(c) {
  const q = {};
  if (s(c.partNumber)) { const p = await PartMaster.findOne({ partNumber: s(c.partNumber).toUpperCase() }); if (!p) return []; q.part = p._id; }
  if (s(c.batchNumber)) q.batchNumber = s(c.batchNumber);
  if (s(c.serialNumber)) q.serialNumber = s(c.serialNumber);
  if (s(c.invoiceNo)) q.invoiceNo = s(c.invoiceNo);
  if (s(c.supplierCode)) { const sup = await Supplier.findOne({ code: s(c.supplierCode).toUpperCase() }); if (!sup) return []; q.supplier = sup._id; }
  if (s(c.receiptNo)) { const r = await Receipt.findOne({ receiptNo: s(c.receiptNo) }); if (!r) return []; q.receipt = r._id; }
  if (!Object.keys(q).length) throw invalid("Give at least one search criterion (part, batch, serial, supplier, invoice or GRN).");
  return MaterialItem.find(q).lean();
}
async function query(c) {
  const items = await find(c);
  const rows = []; const vehicles = new Map(); let onHand = 0, installedQty = 0;
  for (const it of items) {
    const bal = await StockBalance.find({ materialItem: it._id, quantity: { $gt: 0 } }).populate("location", "locationCode type").lean();
    const inst = await Installation.find({ materialItem: it._id }).lean();
    const ho = await Handover.find({ materialItem: it._id, status: "PENDING" }).lean();
    const stock = bal.filter((b) => !["VEHICLE"].includes(b.location.type)).reduce((t, b) => t + b.quantity, 0);
    onHand += stock;
    inst.filter((i) => i.active).forEach((i) => { installedQty += i.quantity; vehicles.set(i.vehicleNumber, { vehicleNumber: i.vehicleNumber, active: true }); });
    inst.filter((i) => !i.active).forEach((i) => { if (!vehicles.has(i.vehicleNumber)) vehicles.set(i.vehicleNumber, { vehicleNumber: i.vehicleNumber, active: false }); });
    rows.push({ id: it._id, partNumber: it.partNumber, serialNumber: it.serialNumber, batchNumber: it.batchNumber, revision: it.partRevision, invoiceNo: it.invoiceNo, status: it.status, onHand: stock, locations: bal.map((b) => `${b.location.locationCode}:${b.quantity}`), installedOn: inst.filter((i) => i.active).map((i) => i.vehicleNumber), pendingHandovers: ho.length });
  }
  return { count: rows.length, onHand, installedQty, vehicles: [...vehicles.values()], items: rows };
}
async function quarantine(user, body) {
  if (!s(body.reason) || s(body.reason).length < 5) throw new BusinessError("OVERRIDE_REASON_REQUIRED", "A reason (min 5 characters) is required.", { status: 400 });
  if (body.confirm !== true) throw new BusinessError("OVERRIDE_CONFIRMATION_REQUIRED", "Quarantine must be explicitly confirmed.", { status: 400 });
  const items = await find(body.criteria || {});
  const results = [];
  for (const it of items) {
    try {
      const remarks = `RECALL: ${body.reason}`;
      if (it.status === MS.APPROVED) { await materials.inspect(user, { materialItemId: String(it._id), result: "HOLD", remarks }, "COMPONENT"); results.push({ id: it._id, outcome: "HELD" }); }
      else if (it.status === MS.PENDING_INCOMING_QC) { await materials.inspect(user, { materialItemId: String(it._id), result: "HOLD", remarks }, "INCOMING"); results.push({ id: it._id, outcome: "HELD" }); }
      else if (it.status === MS.INSTALLED) { await materials.inspect(user, { materialItemId: String(it._id), result: "HOLD", remarks }, "IN_PROCESS"); results.push({ id: it._id, outcome: "FLAGGED_INSTALLED", note: "Installed on a vehicle – inspect or remove it." }); }
      else results.push({ id: it._id, outcome: "SKIPPED", note: `status ${it.status}` });
    } catch (e) { results.push({ id: it._id, outcome: "ERROR", note: e.message }); }
  }
  await AuditLog.create({ user: user.id, userName: user.name, role: user.role, action: "RECALL_QUARANTINE", entityType: "Recall", entityLabel: JSON.stringify(body.criteria), reason: body.reason, after: { held: results.filter((r) => r.outcome === "HELD").length, flagged: results.filter((r) => r.outcome === "FLAGGED_INSTALLED").length, errors: results.filter((r) => r.outcome === "ERROR").length }, override: true });
  return { results, summary: await query(body.criteria) };
}
module.exports = { query, quarantine };
