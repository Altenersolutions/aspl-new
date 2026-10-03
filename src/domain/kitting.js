// Kitting: reserve approved stock (FIFO, correct revision) for a vehicle's BOM, then issue the whole kit at once.
const { Kit, Reservation, MaterialItem, StockBalance, Vehicle, Installation, PartMaster } = require("../models");
const { MS } = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { nextId } = require("./counters");
const { audit } = require("./audit");
const ledger = require("./ledger");
const { findSpecial } = require("./locations");
const { getVehicle, getBomRevision } = require("./assembly");
const { reservedQty } = require("./reservations");

async function create(user, body) {
  const vehicle = await getVehicle(body.vehicle);
  if (["SCRAPPED", "RELEASED"].includes(vehicle.status)) throw new BusinessError("VEHICLE_CLOSED", `Vehicle is ${vehicle.status}.`);
  const rev = await getBomRevision(vehicle);
  if (!rev) throw new BusinessError("NO_BOM", "Vehicle has no BOM revision.");
  const openKits = await Kit.find({ vehicle: vehicle._id, status: { $in: ["READY", "PARTIAL"] } }).select("_id").lean();
  if (openKits.length) throw new BusinessError("KIT_ALREADY_OPEN", "This vehicle already has an open kit. Issue or cancel it first.");
  const installs = await Installation.find({ vehicle: vehicle._id, active: true }).lean();
  const plan = [];
  for (const bi of rev.items) {
    if (bi.optional && !body.includeOptional) continue;
    const done = installs.filter((i) => String(i.part) === String(bi.part)).reduce((t, i) => t + i.quantity, 0);
    let need = bi.requiredQuantity - done;
    if (need <= 0) continue;
    const items = await MaterialItem.find({ part: bi.part, status: MS.APPROVED, ...(bi.requiredRevision && { partRevision: bi.requiredRevision }), installedOn: { $in: [null, undefined] } }).sort({ createdAt: 1 }).lean();
    const allocs = []; let got = 0;
    for (const it of items) {
      if (need <= 0) break;
      const bal = await StockBalance.find({ materialItem: it._id, quantity: { $gt: 0 } }).populate("location", "type").lean();
      const inBins = bal.filter((b) => b.location.type === "BIN").reduce((t, b) => t + b.quantity, 0);
      const free = inBins - (await reservedQty(it._id));
      if (free <= 0) continue;
      const take = Math.min(free, need);
      allocs.push({ item: it, qty: take }); need -= take; got += take;
    }
    plan.push({ bi, allocs, reserved: got, shortage: Math.max(0, bi.requiredQuantity - done - got), required: bi.requiredQuantity - done });
  }
  if (!plan.length) throw new BusinessError("NOTHING_TO_KIT", "All BOM items are already installed.");
  const short = plan.some((p) => p.shortage > 0);
  if (short && !body.allowPartial) throw new BusinessError("KIT_SHORTAGE", "Not enough approved stock to complete the kit.", { details: { shortages: plan.filter((p) => p.shortage).map((p) => ({ part: p.bi.partNumber, required: p.required, available: p.reserved, shortage: p.shortage })) } });
  return atomic(async (ctx) => {
    const kitId = await nextId("kit", "KIT", 5);
    const kit = await ctx.create(Kit, { kitId, vehicle: vehicle._id, vehicleNumber: vehicle.vehicleNumber, bomRevision: rev.revision, status: short ? "PARTIAL" : "READY", createdBy: user.id, createdByName: user.name,
      lines: plan.map((p) => ({ part: p.bi.part, partNumber: p.bi.partNumber, required: p.required, reserved: p.reserved, shortage: p.shortage })) });
    for (const p of plan) for (const a of p.allocs) await ctx.create(Reservation, { kit: kit._id, materialItem: a.item._id, part: a.item.part, partNumber: a.item.partNumber, quantity: a.qty });
    await audit(ctx, user, { action: "KIT_CREATED", entityType: "Kit", entityId: kit._id, entityLabel: kitId, where: vehicle.vehicleNumber, after: { status: kit.status, lines: kit.lines.length } });
    return kit;
  });
}

async function detail(id) {
  const kit = /^[a-f\d]{24}$/i.test(String(id)) ? await Kit.findById(id) : await Kit.findOne({ kitId: String(id) });
  if (!kit) throw notFound("Kit", id);
  const res = await Reservation.find({ kit: kit._id }).populate("materialItem", "serialNumber batchNumber partRevision status").lean();
  const pick = [];
  for (const r of res) {
    const bal = await StockBalance.find({ materialItem: r.materialItem._id, quantity: { $gt: 0 } }).populate("location", "locationCode path type").lean();
    pick.push({ ...r, locations: bal.map((b) => ({ code: b.location.locationCode, path: b.location.path, type: b.location.type, quantity: b.quantity })) });
  }
  return { kit, pickList: pick };
}

async function issue(user, id) {
  const { kit } = await detail(id);
  if (kit.status === "ISSUED" || kit.status === "CANCELLED") throw new BusinessError("KIT_CLOSED", `Kit is ${kit.status}.`);
  const wip = await findSpecial("WIP");
  return atomic(async (ctx) => {
    const res = await Reservation.find({ kit: kit._id, status: "ACTIVE" });
    if (!res.length) throw new BusinessError("KIT_EMPTY", "Nothing is reserved on this kit.");
    for (const r of res) {
      const item = await MaterialItem.findById(r.materialItem);
      if (item.status !== MS.APPROVED) throw new BusinessError("MATERIAL_NOT_APPROVED", `${item.partNumber} ${item.serialNumber || item.batchNumber} is ${item.status}; recreate the kit.`);
      let left = r.quantity;
      const bal = (await StockBalance.find({ materialItem: item._id, quantity: { $gt: 0 } }).populate("location", "type").lean()).filter((b) => b.location.type === "BIN");
      for (const b of bal) {
        if (left <= 0) break; const take = Math.min(left, b.quantity);
        await ledger.post(ctx, user, { type: "ISSUE", item, qty: take, from: b.location._id, to: wip._id, fromStatus: item.status, toStatus: item.status, reason: `Kit ${kit.kitId} for ${kit.vehicleNumber}`, refType: "Kit", refId: kit.kitId });
        left -= take;
      }
      if (left > 0) throw new BusinessError("INSUFFICIENT_STOCK", `Stock for ${item.partNumber} is no longer in a bin (short by ${left}).`);
      await ctx.set(Reservation, r._id, { status: "ISSUED" });
    }
    await ctx.set(Kit, kit._id, { status: "ISSUED", issuedAt: new Date(), issuedBy: user.id });
    await audit(ctx, user, { action: "KIT_ISSUED", entityType: "Kit", entityId: kit._id, entityLabel: kit.kitId, where: kit.vehicleNumber, after: { reservations: res.length } });
    return { ok: true, status: "ISSUED" };
  });
}

async function cancel(user, id, reason) {
  if (!reason || !String(reason).trim()) throw invalid("A reason is required.");
  const { kit } = await detail(id);
  if (["ISSUED", "CANCELLED"].includes(kit.status)) throw new BusinessError("KIT_CLOSED", `Kit is ${kit.status}.`);
  return atomic(async (ctx) => {
    for (const r of await Reservation.find({ kit: kit._id, status: "ACTIVE" })) await ctx.set(Reservation, r._id, { status: "RELEASED" });
    await ctx.set(Kit, kit._id, { status: "CANCELLED" });
    await audit(ctx, user, { action: "KIT_CANCELLED", entityType: "Kit", entityId: kit._id, entityLabel: kit.kitId, reason });
    return { ok: true };
  });
}
module.exports = { create, detail, issue, cancel };
