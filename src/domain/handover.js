const { Handover, User, StockBalance } = require("../models");
const { BusinessError, notFound, invalid, forbidden } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const ledger = require("./ledger");
const sm = require("./stateMachine");
const { findSpecial } = require("./locations");
const { getItem, getLocation } = require("./materials");
const { nextId } = require("./counters");
const { can, P } = require("./permissions");
const s = (v) => (v == null ? "" : String(v).trim());

async function create(user, body) {
  const item = await getItem(body.materialItemId);
  sm.assertIssuable(item);
  if (!s(body.purpose)) throw invalid("Purpose is required.");
  const to = await User.findById(body.toUserId).catch(() => null);
  if (!to || to.active === false) throw invalid("Recipient not found.");
  if (String(to._id) === String(user.id)) throw invalid("You cannot hand material over to yourself.");
  const from = await getLocation(body.fromLocation);
  if (!["BIN", "WIP"].includes(from.type)) throw new BusinessError("INVALID_SOURCE", "Handover must originate from a storage bin or the WIP/issued area.");
  const qty = Number(body.quantity);
  const transit = await findSpecial("TRANSIT");
  return atomic(async (ctx) => {
    const handoverId = await nextId("handover", "HO", 6);
    const txn = await ledger.post(ctx, user, { type: "HANDOVER", item, qty, from: from._id, to: transit._id, fromStatus: item.status, toStatus: item.status, reason: `Handover ${handoverId} to ${to.name}: ${body.purpose}`, refType: "Handover", refId: handoverId });
    const h = await ctx.create(Handover, {
      handoverId, materialItem: item._id, part: item.part, partNumber: item.partNumber, serialNumber: item.serialNumber, batchNumber: item.batchNumber,
      quantity: qty, fromUser: user.id, toUser: to._id, fromUserName: user.name, toUserName: to.name, fromLocation: from._id,
      department: s(body.department), purpose: s(body.purpose), status: "PENDING",
    });
    await audit(ctx, user, { action: "HANDOVER_CREATED", entityType: "Handover", entityId: h._id, entityLabel: handoverId, reason: body.purpose, after: { to: to.name, quantity: qty, material: item.serialNumber || item.batchNumber }, reference: txn.transactionId });
    return h;
  });
}

async function load(id) {
  const h = /^[a-f\d]{24}$/i.test(String(id)) ? await Handover.findById(id) : await Handover.findOne({ handoverId: String(id) });
  if (!h) throw notFound("Handover", id);
  if (h.status !== "PENDING") throw new BusinessError("HANDOVER_CLOSED", `Handover is already ${h.status}.`);
  return h;
}
async function assertRecipient(user, h) {
  if (String(h.toUser) !== String(user.id) && !(await can(user.role, P.OVERRIDE))) throw forbidden("Only the intended recipient can respond to this handover.");
}

async function acknowledge(user, id, body = {}) {
  const h = await load(id); await assertRecipient(user, h);
  const item = await getItem(h.materialItem);
  const transit = await findSpecial("TRANSIT"); const wip = await findSpecial("WIP");
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "HANDOVER", item, qty: h.quantity, from: transit._id, to: wip._id, fromStatus: item.status, toStatus: item.status, reason: `Acknowledged handover ${h.handoverId}`, refType: "Handover", refId: h.handoverId });
    await ctx.set(Handover, h._id, { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgementNote: s(body.note) });
    await audit(ctx, user, { action: "HANDOVER_ACKNOWLEDGED", entityType: "Handover", entityId: h._id, entityLabel: h.handoverId, before: { status: "PENDING" }, after: { status: "ACKNOWLEDGED" }, reference: txn.transactionId });
    return { ok: true, status: "ACKNOWLEDGED", transaction: txn };
  });
}

async function refuse(user, id, body = {}) {
  if (!s(body.reason)) throw new BusinessError("REFUSAL_REASON_REQUIRED", "A reason is mandatory when refusing a handover.", { status: 400 });
  const h = await load(id); await assertRecipient(user, h);
  const item = await getItem(h.materialItem);
  const transit = await findSpecial("TRANSIT");
  return atomic(async (ctx) => {
    const txn = await ledger.post(ctx, user, { type: "RETURN", item, qty: h.quantity, from: transit._id, to: h.fromLocation, fromStatus: item.status, toStatus: item.status, reason: `Handover ${h.handoverId} refused: ${body.reason}`, refType: "Handover", refId: h.handoverId });
    await ctx.set(Handover, h._id, { status: "REFUSED", refusedAt: new Date(), refusalReason: s(body.reason) });
    await audit(ctx, user, { action: "HANDOVER_REFUSED", entityType: "Handover", entityId: h._id, entityLabel: h.handoverId, reason: body.reason, before: { status: "PENDING" }, after: { status: "REFUSED" }, reference: txn.transactionId });
    return { ok: true, status: "REFUSED", transaction: txn };
  });
}
module.exports = { create, acknowledge, refuse };
