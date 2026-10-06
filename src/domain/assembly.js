const { Vehicle, BOM, BOMRevision, PartMaster, MaterialItem, Installation, StockBalance, Location } = require("../models");
const { MS } = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const ledger = require("./ledger");
const sm = require("./stateMachine");
const { guarded, logOverride } = require("./overrides");
const { findSpecial } = require("./locations");
const { getItem } = require("./materials");
const { reservedQty, binQty } = require("./reservations");
const fifo = require("./fifo");
const { rules } = require("./partRules");
const { P } = require("./permissions");

const s = (v) => (v == null ? "" : String(v).trim());
const INSTALL_FROM_TYPES = ["BIN", "WIP", "RECEIVING"];

async function getVehicle(ref) {
  const r = s(ref);
  const v = (/^[a-f\d]{24}$/i.test(r) && (await Vehicle.findById(r))) || (await Vehicle.findOne({ vehicleNumber: r.toUpperCase().replace(/^VEH\|/, "") }));
  if (!v) throw notFound("Vehicle", r);
  return v;
}
async function getBomRevision(vehicle) {
  const bom = await BOM.findOne({ vehicleModel: vehicle.model });
  if (!bom) return null;
  return BOMRevision.findOne({ bom: bom._id, revision: vehicle.currentBOMRevision || bom.currentRevision });
}
async function installedQty(vehicleId, partId) {
  const rows = await Installation.find({ vehicle: vehicleId, part: partId, active: true }).lean();
  return rows.reduce((t, r) => t + r.quantity, 0);
}

async function vehicleView(vehicle) {
  const rev = await getBomRevision(vehicle);
  const installs = await Installation.find({ vehicle: vehicle._id, active: true }).lean();
  const items = [];
  for (const bi of (rev && rev.items) || []) {
    const part = await PartMaster.findById(bi.part).lean();
    const done = installs.filter((i) => String(i.part) === String(bi.part)).reduce((t, i) => t + i.quantity, 0);
    items.push({ partId: bi.part, partNumber: bi.partNumber || (part && part.partNumber), partName: part && part.partName, required: bi.requiredQuantity, installed: done, requiredRevision: bi.requiredRevision, optional: bi.optional, trackingType: bi.trackingType || (part && part.trackingType), position: bi.installationPosition });
  }
  const mandatory = items.filter((i) => !i.optional);
  return { vehicle, bomRevision: rev && { revision: rev.revision, status: rev.status }, items, complete: mandatory.length > 0 && mandatory.every((i) => i.installed >= i.required), installations: installs };
}

// Runs every check and reports all results (used by the UI pre-check and by install()).
async function evaluate(vehicle, item, qty, fromLoc) {
  const checks = [];
  const add = (check, ok, code, message, extra = {}) => checks.push({ check, ok, code: ok ? null : code, message, ...extra });
  const part = await PartMaster.findById(item.part);
  const rev = await getBomRevision(vehicle);
  const bomItem = rev && rev.items.find((i) => String(i.part) === String(item.part));
  const pr = part ? rules(part) : { bomControlled: true, revisionControlled: true, isDevelopment: false };

  add("VEHICLE_OPEN", !["SCRAPPED", "RELEASED"].includes(vehicle.status), "VEHICLE_CLOSED", `Vehicle ${vehicle.vehicleNumber} is ${vehicle.status} and cannot be modified.`);
  add("PART_VALID", !!(part && part.active), "PART_INVALID", "Part is unknown or inactive.");
  const status = item.status;
  add("STATUS_APPROVED", status === MS.APPROVED || status === MS.INSTALLED, // INSTALLED is judged by the ASSIGNMENT check below
    status === MS.REJECTED ? "MATERIAL_REJECTED" : status === MS.HOLD ? "MATERIAL_ON_HOLD" : status === MS.INSTALLED ? "ALREADY_INSTALLED" : "MATERIAL_NOT_APPROVED",
    status === MS.REJECTED ? "Material is REJECTED and cannot be installed." : status === MS.HOLD ? "Material is on QC HOLD and cannot be installed." : `Material status is ${status}; only APPROVED material can be installed.`);
  add("QUANTITY_VALID", qty > 0 && (item.trackingType !== "SERIAL" || qty === 1), "INVALID_QUANTITY", "Serialised components install one at a time.");

  if (pr.isDevelopment) add("DEV_ACTIVE", !part || (part.devStatus || "ACTIVE") === "ACTIVE", "DEV_NOT_ACTIVE", `${item.partNumber} is a development component in status ${part && part.devStatus}; it must be ACTIVE.`);
  // BOM / revision / compatibility rules apply to BOM-controlled (production) parts. GENERAL and DEVELOPMENT parts are not forced through them.
  const compat = !pr.bomControlled || !part || !part.vehicleCompatibility.length || part.vehicleCompatibility.includes(vehicle.vehicleType);
  add("VEHICLE_COMPATIBLE", compat, "INCOMPATIBLE_VEHICLE", `${item.partNumber} is not compatible with ${vehicle.vehicleType} vehicles.`, { overridable: true, overrideKind: "BOM_MISMATCH" });

  add("ON_BOM", !pr.bomControlled || !!bomItem, "BOM_MISMATCH", `BOM MISMATCH: ${item.partNumber} is not valid for ${vehicle.model} BOM ${vehicle.currentBOMRevision || (rev && rev.revision) || "(none)"}.`, { overridable: true, overrideKind: "BOM_MISMATCH" });
  if (bomItem && pr.bomControlled) {
    const revOk = !pr.revisionControlled || !bomItem.requiredRevision || bomItem.requiredRevision === item.partRevision;
    add("REVISION", revOk, "REVISION_MISMATCH", `REVISION MISMATCH: BOM ${rev.revision} requires ${item.partNumber} ${bomItem.requiredRevision}, this unit is ${item.partRevision}.`, { overridable: true, overrideKind: "BOM_MISMATCH" });
    const have = await installedQty(vehicle._id, item.part);
    add("QUANTITY_LIMIT", have + qty <= bomItem.requiredQuantity, "QUANTITY_EXCEEDED", `BOM requires ${bomItem.requiredQuantity} x ${item.partNumber}; ${have} already installed, adding ${qty} would exceed it.`, { overridable: true, overrideKind: "BOM_MISMATCH" });
  }

  // existing assignment (serial components)
  if (item.installedOn) {
    const same = String(item.installedOn) === String(vehicle._id);
    if (same) add("ASSIGNMENT", false, "DUPLICATE_INSTALLATION", `${item.serialNumber || item.batchNumber} is already installed on this vehicle.`);
    else {
      const other = await Vehicle.findById(item.installedOn).lean();
      add("ASSIGNMENT", false, "COMPONENT_ALREADY_ASSIGNED", `COMPONENT ALREADY ASSIGNED: currently installed on ${other ? other.vehicleNumber : "another vehicle"}. Installation on ${vehicle.vehicleNumber} is blocked.`, { overridable: true, overrideKind: "WRONG_VEHICLE", currentVehicle: other && other.vehicleNumber });
    }
  } else add("ASSIGNMENT", true);

  // physical availability + permitted location
  let bal = null;
  if (fromLoc) bal = await StockBalance.findOne({ materialItem: item._id, location: fromLoc._id });
  const okLoc = !!fromLoc && INSTALL_FROM_TYPES.includes(fromLoc.type);
  add("LOCATION_PERMITTED", okLoc || !!item.installedOn, "LOCATION_NOT_PERMITTED", `Material is in ${fromLoc ? fromLoc.locationCode + " (" + fromLoc.type + ")" : "no location"}, which is not a permitted source for installation.`);
  add("PHYSICALLY_AVAILABLE", !!item.installedOn || (!!bal && bal.quantity >= qty), "INSUFFICIENT_STOCK", `Only ${bal ? bal.quantity : 0} available at ${fromLoc ? fromLoc.locationCode : "the source"}; ${qty} needed.`);
  if (fromLoc && fromLoc.type === "BIN" && !item.installedOn) {
    const resv = await reservedQty(item._id); const free = (await binQty(item._id)) - resv;
    add("NOT_RESERVED", resv === 0 || free >= qty, "RESERVED_STOCK", `Only ${Math.max(0, free)} unit(s) are free; the rest is reserved for a kit. Use the kit instead.`, { overridable: true, overrideKind: "RESERVATION" });
  }
  if (fromLoc && fromLoc.type === "BIN" && !item.installedOn && part && rules(part).fifo) {
    const older = await fifo.olderEligible(item, part);
    add("FIFO", !older, "FIFO_VIOLATION", older ? `FIFO: older stock of ${item.partNumber} must be used first (${older.serialNumber || older.batchNumber} at ${older.location || "a bin"}).` : "", { overridable: true, overrideKind: "FIFO_OVERRIDE", overridePerm: P.FIFO_OVERRIDE, suggested: older });
  }
  return { checks, bomItem, bomRevision: rev, part };
}

const NON_OVERRIDABLE_FIRST = (checks) => checks.find((c) => !c.ok && !c.overridable);

async function pickSource(item, requested) {
  if (requested) return requested;
  const rows = (await ledger.balancesOf(item._id)).filter((r) => INSTALL_FROM_TYPES.includes(r.location.type));
  rows.sort((a, b) => b.quantity - a.quantity);
  return rows[0] ? rows[0].location : null;
}

async function check(body) {
  const vehicle = await getVehicle(body.vehicle);
  const item = await getItem(body.materialItemId);
  const qty = body.quantity != null ? Number(body.quantity) : 1;
  const from = body.fromLocation ? await Location.findOne({ locationCode: s(body.fromLocation).toUpperCase() }) : await pickSource(item);
  const r = await evaluate(vehicle, item, qty, from);
  return { ok: r.checks.every((c) => c.ok), checks: r.checks, source: from && from.locationCode };
}

async function install(user, body) {
  const vehicle = await getVehicle(body.vehicle);
  const item = await getItem(body.materialItemId);
  const qty = body.quantity != null ? Number(body.quantity) : 1;
  const from = body.fromLocation ? await Location.findOne({ locationCode: s(body.fromLocation).toUpperCase() }) : await pickSource(item);
  const { checks, bomItem, bomRevision } = await evaluate(vehicle, item, qty, from);

  const hard = NON_OVERRIDABLE_FIRST(checks);
  if (hard) throw new BusinessError(hard.code, hard.message, { details: { checks } });
  const failed = checks.filter((c) => !c.ok);
  let overrideErr = null; const overridesUsed = [];
  for (const f of failed) {
    const e = new BusinessError(f.code, f.message, { overridable: true, overrideKind: f.overrideKind, overridePerm: f.overridePerm, details: { checks, currentVehicle: f.currentVehicle } });
    const used = await guarded(user, body.override, async () => { throw e; });
    overridesUsed.push(e);
    overrideErr = overrideErr || e;
  }
  const overridden = overridesUsed.length > 0;

  return atomic(async (ctx) => {
    const vehicleLoc = await findSpecial("VEHICLE");
    const wip = await findSpecial("WIP");
    let sourceId = from && from._id;
    // Wrong-vehicle override: record a forced removal from the other vehicle first (history preserved).
    if (item.installedOn && String(item.installedOn) !== String(vehicle._id)) {
      const prevInst = await Installation.findOne({ materialItem: item._id, active: true });
      const rem = await ledger.post(ctx, user, { type: "REMOVAL", item, qty: prevInst.quantity, from: vehicleLoc._id, to: wip._id, fromStatus: MS.INSTALLED, toStatus: MS.INSTALLED, vehicle: prevInst.vehicle, reason: `FORCED REMOVAL (override) for reinstall on ${vehicle.vehicleNumber}: ${body.override.reason}`, refType: "Installation", refId: prevInst._id, override: true });
      await ctx.set(Installation, prevInst._id, { active: false, removedAt: new Date(), removedBy: user.id, removalReason: `Override: reinstalled on ${vehicle.vehicleNumber} - ${body.override.reason}`, removeTransaction: rem._id, removalDisposition: "FORCED_REINSTALL" });
      sourceId = wip._id;
      await ctx.set(MaterialItem, item._id, { installedOn: null });
    }
    const fromStatus = item.status === MS.INSTALLED ? MS.APPROVED : item.status;
    if (item.trackingType === "SERIAL") {
      if (item.status === MS.INSTALLED) await ctx.set(MaterialItem, item._id, { status: MS.APPROVED });
      sm.assertTransition(MS.APPROVED, MS.INSTALLED, "INSTALL");
    }
    const txn = await ledger.post(ctx, user, { type: "INSTALLATION", item, qty, from: sourceId, to: vehicleLoc._id, fromStatus, toStatus: item.trackingType === "SERIAL" ? MS.INSTALLED : fromStatus, vehicle: vehicle._id, reason: overridden ? `OVERRIDE: ${body.override.reason}` : `Installed on ${vehicle.vehicleNumber}`, refType: "Vehicle", refId: vehicle.vehicleNumber, override: overridden });
    if (item.trackingType === "SERIAL") await ctx.set(MaterialItem, item._id, { status: MS.INSTALLED, installedOn: vehicle._id });
    const inst = await ctx.create(Installation, {
      vehicle: vehicle._id, vehicleNumber: vehicle.vehicleNumber, materialItem: item._id, part: item.part, partNumber: item.partNumber,
      serialNumber: item.serialNumber, batchNumber: item.batchNumber, quantity: qty, partRevision: item.partRevision,
      bomRevision: bomRevision && bomRevision.revision, bomRequiredRevision: bomItem && bomItem.requiredRevision, installationPosition: bomItem && bomItem.installationPosition,
      installedBy: user.id, installedByName: user.name, installTransaction: txn._id, override: overridden,
    });
    if (vehicle.status === "PLANNED") { await ctx.set(Vehicle, vehicle._id, { status: "UNDER_ASSEMBLY" }); await audit(ctx, user, { action: "VEHICLE_STATUS_CHANGED", entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, before: { status: "PLANNED" }, after: { status: "UNDER_ASSEMBLY" }, reference: "first installation" }); }
    await audit(ctx, user, { action: "COMPONENT_INSTALLED", entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, where: vehicle.vehicleNumber, after: { part: item.partNumber, serial: item.serialNumber, batch: item.batchNumber, revision: item.partRevision, quantity: qty }, reference: txn.transactionId, override: overridden });
    for (const e of overridesUsed) await logOverride(ctx, user, e, body.override, { operation: "INSTALL", originalValue: { rule: e.code, message: e.message }, newValue: { vehicle: vehicle.vehicleNumber, part: item.partNumber, serial: item.serialNumber }, referenceTransaction: txn.transactionId, entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber });
    return { ok: true, message: "INSTALLED", transaction: txn, installation: inst, overrideUsed: overridden };
  }).then(async (r) => {
    // vehicle completeness (read after commit)
    const view = await vehicleView(await Vehicle.findById(vehicle._id));
    if (view.complete && view.vehicle.status === "UNDER_ASSEMBLY") { await Vehicle.updateOne({ _id: vehicle._id }, { status: "ASSEMBLED" }); await require("./audit").audit(null, user, { action: "VEHICLE_STATUS_CHANGED", entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, before: { status: "UNDER_ASSEMBLY" }, after: { status: "ASSEMBLED" }, reference: "all mandatory BOM items installed" }); }
    return { ...r, progress: view.items, vehicleComplete: view.complete };
  });
}

const DISPOSITIONS = { AVAILABLE: { status: MS.APPROVED, loc: "RECEIVING" }, QC_REQUIRED: { status: MS.QC_REQUIRED, loc: "QC_HOLD" }, HOLD: { status: MS.HOLD, loc: "QC_HOLD" }, REWORK: { status: MS.REWORK, loc: "REWORK" } };

async function remove(user, body) {
  if (!s(body.reason)) throw invalid("A reason is required to remove a component.");
  const d = DISPOSITIONS[body.disposition];
  if (!d) throw invalid("disposition must be one of AVAILABLE, QC_REQUIRED, HOLD, REWORK");
  const vehicle = await getVehicle(body.vehicle);
  const item = await getItem(body.materialItemId);
  const inst = await Installation.findOne({ vehicle: vehicle._id, materialItem: item._id, active: true });
  if (!inst) throw new BusinessError("NOT_INSTALLED", `${item.serialNumber || item.batchNumber} is not installed on ${vehicle.vehicleNumber}.`);
  const qty = body.quantity != null ? Number(body.quantity) : inst.quantity;
  if (!(qty > 0) || qty > inst.quantity) throw new BusinessError("INVALID_QUANTITY", `Installed quantity is ${inst.quantity}.`, { status: 400 });
  if (item.trackingType === "SERIAL" && qty !== 1) throw new BusinessError("INVALID_QUANTITY", "Serialised components are removed one at a time.", { status: 400 });

  const released = new BusinessError("VEHICLE_RELEASED", `Vehicle ${vehicle.vehicleNumber} is ${vehicle.status}. Removing components from a released vehicle requires an admin override.`, { overridable: true, overrideKind: "REMOVAL" });
  const used = await guarded(user, body.override, async () => { if (["RELEASED", "FINAL_QC"].includes(vehicle.status)) throw released; });

  return atomic(async (ctx) => {
    const vehicleLoc = await findSpecial("VEHICLE");
    const dest = await findSpecial(d.loc);
    const isSerial = item.trackingType === "SERIAL";
    const txn = await ledger.post(ctx, user, { type: "REMOVAL", item, qty, from: vehicleLoc._id, to: dest._id, fromStatus: item.status, toStatus: isSerial ? d.status : item.status, vehicle: vehicle._id, reason: body.reason, refType: "Installation", refId: inst._id, override: !!used });
    await ctx.set(Installation, inst._id, { active: false, removedAt: new Date(), removedBy: user.id, removalReason: body.reason, removeTransaction: txn._id, removalDisposition: body.disposition });
    if (qty < inst.quantity) {
      await ctx.create(Installation, { ...inst.toObject({ depopulate: true }), _id: undefined, quantity: inst.quantity - qty, splitFrom: inst._id, active: true, removedAt: undefined, removedBy: undefined, removalReason: undefined, removeTransaction: undefined, createdAt: undefined, updatedAt: undefined });
    }
    if (isSerial) { sm.assertTransition(item.status, d.status, "REMOVE"); await ctx.set(MaterialItem, item._id, { status: d.status, installedOn: null }); }
    if (["ASSEMBLED"].includes(vehicle.status)) { await ctx.set(Vehicle, vehicle._id, { status: "UNDER_ASSEMBLY" }); await audit(ctx, user, { action: "VEHICLE_STATUS_CHANGED", entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, before: { status: "ASSEMBLED" }, after: { status: "UNDER_ASSEMBLY" }, reference: "component removed" }); }
    await audit(ctx, user, { action: "COMPONENT_REMOVED", entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber, reason: body.reason, before: { installed: true, status: item.status }, after: { disposition: body.disposition, status: isSerial ? d.status : item.status, quantity: qty }, reference: txn.transactionId, override: !!used });
    if (used) await logOverride(ctx, user, released, body.override, { operation: "REMOVE", originalValue: { vehicleStatus: vehicle.status }, newValue: { removed: item.serialNumber || item.batchNumber }, referenceTransaction: txn.transactionId, entityType: "Vehicle", entityId: vehicle._id, entityLabel: vehicle.vehicleNumber });
    return { ok: true, transaction: txn, status: isSerial ? d.status : item.status, next: body.disposition === "AVAILABLE" ? "PUT_AWAY" : "QC" };
  });
}

module.exports = { getVehicle, getBomRevision, vehicleView, check, install, remove, evaluate };
