const { PartMaster, Supplier, Location, Receipt, MaterialItem, QCInspection, StockBalance, Vehicle, Handover } = require("../models");
const { MS } = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { nextId } = require("./counters");
const { audit } = require("./audit");
const ledger = require("./ledger");
const sm = require("./stateMachine");
const codes = require("./codes");
const { guarded, logOverride } = require("./overrides");
const { resolveDestination, rejectionReason, findSpecial, locationPath } = require("./locations");

const s = (v) => (v == null ? "" : String(v).trim());

async function getItem(id) {
  if (!/^[a-f\d]{24}$/i.test(String(id))) throw notFound("Material", id);
  const item = await MaterialItem.findById(id);
  if (!item) throw notFound("Material", id);
  return item;
}
async function getLocation(ref) {
  const r = s(ref);
  const loc = /^[a-f\d]{24}$/i.test(r) ? await Location.findById(r) : null;
  if (loc) return loc;
  const p = codes.parse(r);
  const code = p.kind === "LOCATION" ? p.code : r.toUpperCase();
  const byCode = await Location.findOne({ locationCode: code });
  if (!byCode) throw new BusinessError("UNKNOWN_LOCATION", `Unknown location: ${r}`, { status: 404 });
  return byCode;
}

// ---------- RECEIVING (invoice is mandatory; enforced here, not just in the UI) ----------
async function receive(user, body) {
  const invoiceNo = s(body.invoiceNo);
  if (!invoiceNo) throw new BusinessError("INVOICE_REQUIRED", "Invoice number is mandatory. Material cannot be received without an invoice.", { status: 400 });
  const supplier = await Supplier.findById(body.supplierId).catch(() => null);
  if (!supplier || !supplier.active) throw invalid("A valid, active supplier is required.");
  if (!Array.isArray(body.lines) || !body.lines.length) throw invalid("At least one line is required.");

  // resolve + validate every line before writing anything
  const prepared = [];
  const seenSerials = new Set();
  for (const [i, line] of body.lines.entries()) {
    const part = await PartMaster.findOne({ partNumber: s(line.partNumber).toUpperCase() });
    if (!part || !part.active) throw invalid(`Line ${i + 1}: unknown or inactive part ${line.partNumber}`);
    const qty = Number(line.quantity);
    if (!(qty > 0) || (part.trackingType !== "QUANTITY" && !Number.isInteger(qty))) throw invalid(`Line ${i + 1}: invalid quantity`);
    const rev = s(line.revision) || part.currentRevision;
    if (part.trackingType === "SERIAL") {
      const serials = (line.serialNumbers || []).map(s).filter(Boolean);
      if (serials.length !== qty) throw invalid(`Line ${i + 1}: ${part.partNumber} is serial tracked - provide exactly ${qty} serial number(s).`);
      for (const sn of serials) {
        if (seenSerials.has(`${part.partNumber}|${sn}`) || (await MaterialItem.exists({ part: part._id, serialNumber: sn })))
          throw new BusinessError("DUPLICATE_SERIAL", `Serial ${sn} already exists for ${part.partNumber}.`);
        seenSerials.add(`${part.partNumber}|${sn}`);
      }
      prepared.push({ part, rev, serials, qty });
    } else if (part.trackingType === "BATCH") {
      if (!s(line.batchNumber)) throw invalid(`Line ${i + 1}: ${part.partNumber} is batch tracked - a batch number is required.`);
      prepared.push({ part, rev, batch: s(line.batchNumber), qty });
    } else {
      prepared.push({ part, rev, batch: s(line.batchNumber) || null, qty }); // quantity-only: lot id is generated
    }
  }

  return atomic(async (ctx) => {
    const receiving = await findSpecial("RECEIVING");
    const receiptNo = await nextId("receipt", "GRN", 5);
    const receipt = await ctx.create(Receipt, {
      receiptNo, supplier: supplier._id, invoiceNo, invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : undefined,
      receivedBy: user.id, notes: s(body.notes), lines: [],
    });
    const created = [];
    let lineNo = 0;
    for (const p of prepared) {
      lineNo++;
      const units = p.part.trackingType === "SERIAL" ? p.serials.map((sn) => ({ serialNumber: sn, quantity: 1 }))
        : [{ batchNumber: p.batch || `LOT-${receiptNo}-${lineNo}`, quantity: p.qty }];
      const ids = [];
      for (const u of units) {
        const item = await ctx.create(MaterialItem, {
          part: p.part._id, partNumber: p.part.partNumber, partRevision: p.rev, trackingType: p.part.trackingType,
          ...u, status: MS.RECEIVED, receipt: receipt._id, supplier: supplier._id, invoiceNo,
        });
        await ctx.set(MaterialItem, item._id, { qrCode: codes.materialPayload(item, p.part) });
        item.qrCode = codes.materialPayload(item, p.part);
        const txn = await ledger.post(ctx, user, {
          type: "RECEIPT", item, qty: u.quantity, to: receiving._id, fromStatus: null, toStatus: MS.RECEIVED,
          reason: `Received against invoice ${invoiceNo}`, refType: "Receipt", refId: receiptNo,
        });
        sm.assertTransition(MS.RECEIVED, MS.PENDING_INCOMING_QC, "RECEIVE");
        await ctx.set(MaterialItem, item._id, { status: MS.PENDING_INCOMING_QC });
        ids.push(item._id);
        created.push({ id: item._id, partNumber: p.part.partNumber, serialNumber: u.serialNumber, batchNumber: u.batchNumber, quantity: u.quantity, qrCode: item.qrCode, transactionId: txn.transactionId });
      }
      receipt.lines.push({ part: p.part._id, materialItems: ids, quantity: p.qty });
    }
    await ctx.set(Receipt, receipt._id, { lines: receipt.lines });
    await audit(ctx, user, { action: "MATERIAL_RECEIPT", entityType: "Receipt", entityId: receipt._id, entityLabel: receiptNo, where: "RECEIVING", after: { invoiceNo, supplier: supplier.name, items: created.length } });
    return { receiptNo, receiptId: receipt._id, invoiceNo, items: created };
  });
}

// ---------- QC ----------
async function inspect(user, body, forcedType) {
  const type = forcedType || body.inspectionType;
  if (!["INCOMING", "COMPONENT", "IN_PROCESS", "FINAL", "RETEST"].includes(type)) throw invalid("Invalid inspection type.");
  if (!["PASS", "FAIL", "HOLD"].includes(body.result)) throw invalid("Result must be PASS, FAIL or HOLD.");
  if ((body.result === "FAIL" || body.result === "HOLD") && !s(body.remarks)) throw invalid("Remarks are required for FAIL / HOLD results.");

  // Vehicle-level in-process / final inspection (no material status change)
  if (!body.materialItemId && (type === "IN_PROCESS" || type === "FINAL")) {
    const vehicle = await Vehicle.findById(body.vehicleId).catch(() => null);
    if (!vehicle) throw invalid("materialItemId or vehicleId is required.");
    return atomic(async (ctx) => {
      const prev = await QCInspection.findOne({ vehicle: vehicle._id, inspectionType: type }).sort({ createdAt: -1 });
      const insp = await ctx.create(QCInspection, {
        inspectionId: await nextId("qc", "QC", 6), vehicle: vehicle._id, inspectionType: type, inspector: user.id,
        result: body.result, remarks: s(body.remarks), measurements: body.measurements || [], attachments: body.attachments || [],
        reworkRequired: !!body.reworkRequired, previousInspection: prev && prev._id,
      });
      if (type === "FINAL") {
        const to = body.result === "PASS" ? "RELEASED" : "FINAL_QC";
        if (body.result === "PASS" && vehicle.status !== "ASSEMBLED") throw new BusinessError("VEHICLE_NOT_COMPLETE", "Final QC PASS requires a fully assembled vehicle (all mandatory BOM items installed).");
        await ctx.set(Vehicle, vehicle._id, { status: to });
      }
      await audit(ctx, user, { action: `QC_${type}_${body.result}`, entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, reason: body.remarks, after: { inspectionId: insp.inspectionId } });
      return insp;
    });
  }

  const item = await getItem(body.materialItemId);
  const allowedFrom = sm.QC_ALLOWED[type];
  if (!allowedFrom.includes(item.status)) {
    throw new BusinessError("QC_NOT_ALLOWED", `${type} inspection is not allowed while material is ${item.status}.`, { details: { status: item.status, allowedFrom } });
  }
  const installed = item.status === MS.INSTALLED;
  const toStatus = installed ? MS.INSTALLED : sm.RESULT_TO_STATUS[body.result];
  if (!installed) sm.assertTransition(item.status, toStatus, "QC");

  return atomic(async (ctx) => {
    const prev = await QCInspection.findOne({ materialItem: item._id }).sort({ createdAt: -1 });
    const insp = await ctx.create(QCInspection, {
      inspectionId: await nextId("qc", "QC", 6), materialItem: item._id, part: item.part, serialNumber: item.serialNumber, batchNumber: item.batchNumber,
      inspectionType: type, inspector: user.id, result: body.result, remarks: s(body.remarks),
      measurements: body.measurements || [], attachments: body.attachments || [],
      reworkRequired: !!body.reworkRequired, previousInspection: prev && prev._id, quantity: item.quantity,
    });
    const fromStatus = item.status;
    if (!installed) {
      // Decide destination for each stock row of this item.
      const rows = await ledger.balancesOf(item._id);
      let targetType = null;
      if (toStatus === MS.HOLD) targetType = "QC_HOLD";
      if (toStatus === MS.REJECTED) targetType = "REJECT";
      if (toStatus === MS.APPROVED) targetType = "RECEIVING_IF_ISOLATED";
      const txnType = toStatus === MS.APPROVED ? "QC_APPROVAL" : toStatus === MS.HOLD ? "QC_HOLD" : "QC_REJECTION";
      let emitted = false;
      for (const row of rows) {
        let dest = row.location;
        const isolated = ["QC_HOLD", "REJECT", "REWORK", "SCRAP"].includes(row.location.type);
        if (targetType === "QC_HOLD" || targetType === "REJECT") dest = await findSpecial(targetType);
        else if (targetType === "RECEIVING_IF_ISOLATED" && isolated) dest = await findSpecial("RECEIVING");
        await ledger.post(ctx, user, { type: type === "RETEST" ? "RETEST" : txnType, item, qty: row.quantity, from: row.location._id, to: dest._id, fromStatus, toStatus, reason: `${type} inspection ${insp.inspectionId}: ${body.result}${body.remarks ? " - " + body.remarks : ""}`, refType: "QCInspection", refId: insp.inspectionId });
        emitted = true;
      }
      if (!emitted) await ledger.note(ctx, user, { type: txnType, item, fromStatus, toStatus, reason: `${type} inspection ${insp.inspectionId}`, refType: "QCInspection", refId: insp.inspectionId });
      await ctx.set(MaterialItem, item._id, { status: toStatus, lastQc: insp._id });
    } else {
      await ctx.set(MaterialItem, item._id, { lastQc: insp._id });
    }
    await audit(ctx, user, { action: `QC_${type}_${body.result}`, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.remarks, before: { status: fromStatus }, after: { status: toStatus, inspectionId: insp.inspectionId } });
    return { inspection: insp, status: toStatus };
  });
}

// Rework / return-to-supplier / scrap of rejected material.
async function disposition(user, body) {
  const item = await getItem(body.materialItemId);
  const action = body.action;
  const map = { REQUALIFY: MS.PENDING_INCOMING_QC, REWORK: MS.REWORK, RETURN_TO_SUPPLIER: MS.RETURNED_TO_SUPPLIER, SCRAP: MS.SCRAPPED, REWORK_DONE: MS.PENDING_RETEST };
  if (!map[action]) throw invalid("action must be REQUALIFY, REWORK, REWORK_DONE, RETURN_TO_SUPPLIER or SCRAP");
  if (!s(body.reason)) throw invalid("A reason is required.");
  const to = map[action];
  sm.assertTransition(item.status, to, action);
  return atomic(async (ctx) => {
    const rows = await ledger.balancesOf(item._id);
    const fromStatus = item.status;
    if (action === "REQUALIFY") { await ctx.set(MaterialItem, item._id, { status: to }); await audit(ctx, user, { action: "LEGACY_REQUALIFY", entityType: "MaterialItem", entityId: item._id, entityLabel: item.partNumber, reason: body.reason, before: { status: item.status }, after: { status: to } }); return { status: to }; }
    const txnType = action === "REWORK" || action === "REWORK_DONE" ? "REWORK" : action === "SCRAP" ? "SCRAP" : "RETURN";
    for (const row of rows) {
      let dest = null;
      if (action === "REWORK") dest = await findSpecial("REWORK");
      if (action === "SCRAP") dest = await findSpecial("SCRAP");
      if (action === "REWORK_DONE") dest = row.location; // stays in rework area until retest
      await ledger.post(ctx, user, { type: txnType, item, qty: row.quantity, from: row.location._id, to: dest && dest._id, fromStatus, toStatus: to, reason: body.reason, refType: "Disposition", refId: action });
    }
    await ctx.set(MaterialItem, item._id, { status: to });
    await audit(ctx, user, { action: `MATERIAL_${action}`, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.reason, before: { status: fromStatus }, after: { status: to } });
    return { status: to };
  });
}

// ---------- PUT-AWAY ----------
async function putAwayPlan(itemId) {
  const item = await getItem(itemId);
  const part = await PartMaster.findById(item.part);
  const receiving = await findSpecial("RECEIVING");
  const row = await StockBalance.findOne({ materialItem: item._id, location: receiving._id });
  const qty = row ? row.quantity : 0;
  const plan = { item, qty, needsPutAway: item.status === MS.APPROVED && qty > 0 };
  if (plan.needsPutAway) {
    const dest = await resolveDestination(part, qty);
    plan.destination = { id: dest._id, code: dest.locationCode, path: dest.path || (await locationPath(dest)), qr: codes.locationPayload(dest) };
  }
  return plan;
}

async function putAway(user, itemId, body) {
  const item = await getItem(itemId);
  sm.assertIssuable(item);
  const part = await PartMaster.findById(item.part);
  const receiving = await findSpecial("RECEIVING");
  const row = await StockBalance.findOne({ materialItem: item._id, location: receiving._id });
  const avail = row ? row.quantity : 0;
  const qty = body.quantity != null ? Number(body.quantity) : avail;
  if (!(qty > 0) || qty > avail) throw new BusinessError("INVALID_QUANTITY", `${avail} available for put-away; ${qty} requested.`, { status: 400 });
  if (!s(body.scannedLocation)) throw invalid("Scan the destination location.");
  const scanned = await getLocation(body.scannedLocation);
  const required = await resolveDestination(part, qty);

  const wrong = new BusinessError("WRONG_LOCATION", "WRONG LOCATION - material must be stored in the location assigned by the system.", {
    overridable: true, overrideKind: "WRONG_LOCATION",
    details: { required: { code: required.locationCode, path: required.path }, scanned: { code: scanned.locationCode, path: scanned.path } },
  });
  const usedOverride = await guarded(user, body.override, async () => {
    if (String(scanned._id) !== String(required._id)) throw wrong;
  });
  if (usedOverride) {
    if (scanned.type !== "BIN") throw new BusinessError("INVALID_LOCATION", "Stock can only be put away into a BIN location.", { status: 400 });
    const why = await rejectionReason(scanned, part, qty);
    if (why) throw new BusinessError("LOCATION_RULE_VIOLATION", `Even with override, this location cannot be used: ${why}.`);
  }
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "PUT_AWAY", item, qty, from: receiving._id, to: scanned._id, fromStatus: item.status, toStatus: item.status, reason: usedOverride ? `OVERRIDE: ${body.override.reason}` : "Put-away to system-assigned location", refType: "PutAway", override: !!usedOverride });
    await audit(ctx, user, { action: "PUT_AWAY", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, where: scanned.path, before: { location: receiving.locationCode }, after: { location: scanned.locationCode, quantity: qty }, reference: txn.transactionId, override: !!usedOverride });
    if (usedOverride) await logOverride(ctx, user, wrong, body.override, { operation: "PUT_AWAY", originalValue: { location: required.locationCode }, newValue: { location: scanned.locationCode }, referenceTransaction: txn.transactionId, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber });
    return { ok: true, message: "MATERIAL STORED", transaction: txn, from: receiving.path || receiving.name, to: scanned.path, overrideUsed: !!usedOverride };
  });
}

// ---------- ISSUE / RETURN / TRANSFER ----------
async function issue(user, body) {
  const item = await getItem(body.materialItemId);
  sm.assertIssuable(item);
  if (!s(body.purpose)) throw invalid("Purpose is required to issue material.");
  const from = await getLocation(body.fromLocation);
  if (from.type !== "BIN") throw new BusinessError("INVALID_SOURCE", "Material can only be issued from a storage bin. Put it away first.");
  const wip = await findSpecial("WIP");
  const qty = Number(body.quantity);
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "ISSUE", item, qty, from: from._id, to: wip._id, fromStatus: item.status, toStatus: item.status, reason: body.purpose, refType: "Issue" });
    await audit(ctx, user, { action: "MATERIAL_ISSUE", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.purpose, before: { location: from.locationCode }, after: { location: wip.locationCode, quantity: qty }, reference: txn.transactionId });
    return { ok: true, transaction: txn };
  });
}

async function returnStock(user, body) {
  const item = await getItem(body.materialItemId);
  sm.assertIssuable(item);
  if (!s(body.reason)) throw invalid("A reason is required.");
  const wip = await findSpecial("WIP");
  const receiving = await findSpecial("RECEIVING");
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "RETURN", item, qty: Number(body.quantity), from: wip._id, to: receiving._id, fromStatus: item.status, toStatus: item.status, reason: body.reason, refType: "Return" });
    await audit(ctx, user, { action: "MATERIAL_RETURN", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.reason, reference: txn.transactionId, after: { location: receiving.locationCode, quantity: Number(body.quantity) } });
    return { ok: true, transaction: txn, next: "PUT_AWAY" };
  });
}

async function transfer(user, body) {
  const item = await getItem(body.materialItemId);
  sm.assertIssuable(item);
  const part = await PartMaster.findById(item.part);
  const from = await getLocation(body.fromLocation);
  const to = await getLocation(body.toLocation);
  const qty = Number(body.quantity);
  if (from.type !== "BIN" && from.type !== "RECEIVING") throw new BusinessError("INVALID_SOURCE", "Transfers are between storage bins.");
  if (String(from._id) === String(to._id)) throw invalid("Source and destination are the same.");
  const bad = new BusinessError("WRONG_LOCATION", "Destination location does not accept this material.", { overridable: true, overrideKind: "WRONG_LOCATION", details: {} });
  const used = await guarded(user, body.override, async () => {
    const why = to.type !== "BIN" ? "Destination is not a storage bin" : await rejectionReason(to, part, qty);
    if (why) { bad.details = { reason: why, destination: to.path }; bad.message = `Wrong location: ${why}.`; throw bad; }
  });
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "TRANSFER", item, qty, from: from._id, to: to._id, fromStatus: item.status, toStatus: item.status, reason: s(body.reason) || "Stock transfer", refType: "Transfer", override: !!used });
    await audit(ctx, user, { action: "MATERIAL_TRANSFER", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.reason, before: { location: from.locationCode }, after: { location: to.locationCode, quantity: qty }, reference: txn.transactionId, override: !!used });
    if (used) await logOverride(ctx, user, bad, body.override, { operation: "TRANSFER", originalValue: { rule: bad.details }, newValue: { location: to.locationCode }, referenceTransaction: txn.transactionId, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber });
    return { ok: true, transaction: txn };
  });
}

// ---------- ADMIN CORRECTIONS (never silent) ----------
function needConfirm(body) {
  if (!s(body.reason) || s(body.reason).length < 5) throw new BusinessError("OVERRIDE_REASON_REQUIRED", "A reason (min 5 characters) is required.", { status: 400 });
  if (body.confirm !== true) throw new BusinessError("OVERRIDE_CONFIRMATION_REQUIRED", "This correction must be explicitly confirmed.", { status: 400 });
}
async function adjust(user, body) {
  needConfirm(body);
  const item = await getItem(body.materialItemId);
  const loc = await getLocation(body.location);
  const newQty = Number(body.newQuantity);
  if (!Number.isFinite(newQty) || newQty < 0) throw new BusinessError("INVALID_QUANTITY", "New quantity cannot be negative.", { status: 400 });
  if (item.trackingType === "SERIAL" && newQty > 1) throw new BusinessError("INVALID_QUANTITY", "A serialised unit can only be 0 or 1.", { status: 400 });
  const row = await StockBalance.findOne({ materialItem: item._id, location: loc._id });
  const cur = row ? row.quantity : 0;
  const delta = newQty - cur;
  if (delta === 0) throw invalid("New quantity equals current quantity.");
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "ADJUSTMENT", item, qty: Math.abs(delta), from: delta < 0 ? loc._id : null, to: delta > 0 ? loc._id : null, fromStatus: item.status, toStatus: item.status, reason: body.reason, refType: "Adjustment", override: true });
    await audit(ctx, user, { action: "INVENTORY_ADJUSTMENT", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, where: loc.path, reason: body.reason, before: { quantity: cur }, after: { quantity: newQty }, reference: txn.transactionId, override: true });
    return { ok: true, transaction: txn, before: cur, after: newQty };
  });
}

async function statusOverride(user, body) {
  needConfirm(body);
  const item = await getItem(body.materialItemId);
  if (!Object.values(MS).includes(body.toStatus)) throw invalid("Unknown status.");
  if (item.status === body.toStatus) throw invalid("Material already has that status.");
  if (item.status === MS.INSTALLED) throw new BusinessError("USE_REMOVAL", "Installed material must be removed from the vehicle first.");
  return atomic(async (ctx) => {
    const from = item.status;
    const txn = await ledger.note(ctx, user, { type: "ADJUSTMENT", item, fromStatus: from, toStatus: body.toStatus, reason: `STATUS OVERRIDE: ${body.reason}`, refType: "StatusOverride", override: true });
    await ctx.set(MaterialItem, item._id, { status: body.toStatus });
    await audit(ctx, user, { action: "STATUS_OVERRIDE", entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber, reason: body.reason, before: { status: from }, after: { status: body.toStatus }, reference: txn.transactionId, override: true });
    await logOverride(ctx, user, { overrideKind: "STATUS_OVERRIDE", code: "STATUS_OVERRIDE" }, { reason: body.reason }, { operation: "STATUS_OVERRIDE", originalValue: { status: from }, newValue: { status: body.toStatus }, referenceTransaction: txn.transactionId, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber });
    return { ok: true, status: body.toStatus };
  });
}

module.exports = { receive, inspect, disposition, putAwayPlan, putAway, issue, returnStock, transfer, adjust, statusOverride, getItem, getLocation };
