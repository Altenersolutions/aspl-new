// SCAN -> IDENTIFY -> DECIDE.  One entry point that recognises what a code is and tells
// the user what to do next. All rules live in the backend; the UI only renders this.
const { PartMaster, MaterialItem, Location, Vehicle, StockBalance, Handover, Installation, QCInspection } = require("../models");
const { MS } = require("./constants");
const codes = require("./codes");
const sm = require("./stateMachine");
const ledger = require("./ledger");
const { resolveDestination, locationPath } = require("./locations");
const assembly = require("./assembly");

const badgeFor = (status) => ({ APPROVED: "APPROVED", HOLD: "HOLD", REJECTED: "REJECTED" }[status] || status);

async function describeItem(item, context = {}) {
  const part = await PartMaster.findById(item.part).lean();
  const rows = await ledger.balancesOf(item._id);
  const balances = rows.map((r) => ({ location: r.location.locationCode, type: r.location.type, path: r.location.path || r.location.name, quantity: r.quantity }));
  const atReceiving = rows.some((r) => r.location.type === "RECEIVING");
  const atBin = rows.some((r) => r.location.type === "BIN");
  const actions = sm.allowedActions(item, { atReceiving, atBin });
  const out = { kind: "MATERIAL", item: { id: item._id, partNumber: item.partNumber, partRevision: item.partRevision, serialNumber: item.serialNumber, batchNumber: item.batchNumber, trackingType: item.trackingType, quantity: item.quantity, status: item.status, invoiceNo: item.invoiceNo, installedOn: item.installedOn, legacy: item.legacy, qrCode: item.qrCode },
    part: part && { id: part._id, partNumber: part.partNumber, partName: part.partName, description: part.description, category: part.category, unit: part.unit },
    badge: badgeFor(item.status), balances, allowedActions: actions, next: null };
  if (item.installedOn) { const v = await Vehicle.findById(item.installedOn).lean(); out.installedOnVehicle = v && v.vehicleNumber; }

  // What should the user do next?
  if (item.status === MS.PENDING_INCOMING_QC) out.next = { action: "INCOMING_QC", instruction: "Incoming QC inspection required before this material can be stored." };
  else if (item.status === MS.APPROVED && atReceiving) {
    const recQty = rows.filter((r) => r.location.type === "RECEIVING").reduce((t, r) => t + r.quantity, 0);
    try {
      const dest = await resolveDestination(part, recQty);
      out.next = { action: "PUT_AWAY", quantity: recQty, instruction: "PUT THIS MATERIAL IN:", destination: { code: dest.locationCode, path: dest.path || (await locationPath(dest)), qr: codes.locationPayload(dest) } };
    } catch (e) { out.next = { action: "PUT_AWAY", instruction: e.message, error: e.code }; }
  } else if (item.status === MS.APPROVED && atBin) out.next = { action: "AVAILABLE", instruction: "Stored and available. Choose Issue, Transfer, Handover or Install." };
  else if (item.status === MS.HOLD) out.next = { action: "RETEST", instruction: "On QC HOLD. Not available for issue or installation until re-tested." };
  else if (item.status === MS.REJECTED) out.next = { action: "REWORK_OR_RETURN", instruction: "REJECTED. Send to rework, return to supplier or scrap." };
  else if (item.status === MS.REWORK) out.next = { action: "REWORK_DONE", instruction: "In rework. Mark rework complete to send for re-test." };
  else if (item.status === MS.PENDING_RETEST || item.status === MS.QC_REQUIRED) out.next = { action: "RETEST", instruction: "Re-test required." };
  else if (item.status === MS.INSTALLED) out.next = { action: "INSTALLED", instruction: `Installed on ${out.installedOnVehicle || "a vehicle"}.` };
  else if (item.status === MS.LEGACY_UNVERIFIED) out.next = { action: "REQUALIFY", instruction: "Legacy stock with unverified tracking data. Run incoming QC to re-qualify." };

  // FIFO hint: older approved stock of the same part still sitting in a bin?
  if (item.status === MS.APPROVED && atBin) {
    const older = await MaterialItem.find({ part: item.part, status: MS.APPROVED, createdAt: { $lt: item.createdAt }, _id: { $ne: item._id } }).sort({ createdAt: 1 }).limit(5).lean();
    for (const o of older) {
      const ob = (await ledger.balancesOf(o._id)).filter((b) => b.location.type === "BIN");
      if (ob.length) { out.fifo = { message: "Older stock of this part is available - use it first (FIFO).", older: { id: o._id, serialNumber: o.serialNumber, batchNumber: o.batchNumber, location: ob[0].location.path || ob[0].location.locationCode, quantity: ob[0].quantity } }; break; }
    }
  }
  // context: scanning material while a vehicle is loaded in the Assembly screen
  if (context.vehicle) {
    const c = await assembly.check({ vehicle: context.vehicle, materialItemId: String(item._id), quantity: context.quantity || 1 }).catch((e) => ({ error: e.message }));
    out.installCheck = c;
  }
  return out;
}

async function scan(rawCode, context = {}) {
  const p = codes.parse(rawCode);
  if (p.kind === "EMPTY") return { kind: "UNKNOWN", message: "Nothing scanned." };

  if (p.kind === "LOCATION" || p.kind === "RAW") {
    const code = p.kind === "LOCATION" ? p.code : String(p.text).toUpperCase();
    const loc = await Location.findOne({ locationCode: code }).lean();
    if (loc) {
      const rows = await StockBalance.find({ location: loc._id, quantity: { $gt: 0 } }).populate("materialItem").lean();
      return { kind: "LOCATION", location: { id: loc._id, code: loc.locationCode, name: loc.name, type: loc.type, path: loc.path, capacity: loc.capacity, active: loc.active },
        contents: rows.map((r) => ({ itemId: r.materialItem._id, partNumber: r.materialItem.partNumber, serialNumber: r.materialItem.serialNumber, batchNumber: r.materialItem.batchNumber, status: r.materialItem.status, quantity: r.quantity })) };
    }
  }
  if (p.kind === "VEHICLE" || p.kind === "RAW") {
    const num = p.kind === "VEHICLE" ? p.number : String(p.text).toUpperCase();
    const v = await Vehicle.findOne({ $or: [{ vehicleNumber: num }, { vin: num }] });
    if (v) {
      const view = await assembly.vehicleView(v);
      return { kind: "VEHICLE", ...view, badge: v.status, next: { action: "ASSEMBLE", instruction: `Vehicle ${v.vehicleNumber} loaded on BOM ${v.currentBOMRevision}. Scan a component to install.` } };
    }
  }
  if (p.kind === "MATERIAL") {
    if (p.itemId && /^[a-f\d]{24}$/i.test(p.itemId)) { const it = await MaterialItem.findById(p.itemId); if (it) return describeItem(it, context); }
    const part = await PartMaster.findOne({ partNumber: p.partNumber });
    const q = part ? { part: part._id } : null;
    if (q && p.serial) q.serialNumber = p.serial; else if (q && p.batch) q.batchNumber = p.batch;
    const found = q ? await MaterialItem.find(q).limit(20) : [];
    if (found.length === 1) return describeItem(found[0], context);
    if (found.length > 1) return candidates(found);
  }
  if (p.kind === "RAW") {
    const text = String(p.text);
    let found = await MaterialItem.find({ serialNumber: text }).limit(20);
    if (found.length === 1) return describeItem(found[0], context);
    if (found.length > 1) return candidates(found);
    found = await MaterialItem.find({ batchNumber: text }).limit(20);
    if (found.length === 1) return describeItem(found[0], context);
    if (found.length > 1) return candidates(found);
    const part = await PartMaster.findOne({ partNumber: text.toUpperCase() });
    if (part) {
      const items = await MaterialItem.find({ part: part._id }).sort({ createdAt: -1 }).limit(20);
      if (items.length === 1) return describeItem(items[0], context);
      if (items.length > 1) return candidates(items, part);
      let dest = null; try { const d = await resolveDestination(part, 1); dest = { code: d.locationCode, path: d.path }; } catch {}
      return { kind: "PART", part: { id: part._id, partNumber: part.partNumber, partName: part.partName, description: part.description, category: part.category, trackingType: part.trackingType },
        badge: "NOT_RECEIVED", destination: dest, next: { action: "RECEIVE", instruction: "Known part with no stock on record. Receive it against a supplier invoice." } };
    }
  }
  return { kind: "UNKNOWN", message: `Unknown code: ${String(rawCode).slice(0, 80)}` };
}

async function candidates(items, part) {
  return { kind: "MATERIAL_CANDIDATES", message: "Several units match - pick one.", candidates: items.map((i) => ({ id: i._id, partNumber: i.partNumber, serialNumber: i.serialNumber, batchNumber: i.batchNumber, quantity: i.quantity, status: i.status })) };
}
module.exports = { scan, describeItem };
