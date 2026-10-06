const M = require("../models");

// Entity types whose documents carry "Last Update" (last meaningful business action, who, when).
const STAMPED = { MaterialItem: "MaterialItem", Vehicle: "Vehicle", Part: "PartMaster", BOM: "BOM", Handover: "Handover", Location: "Location", GatePass: "GatePass", Kit: "Kit" };
const plainCtx = { create: (Model, data) => Model.create(data), set: (Model, id, patch) => Model.findByIdAndUpdate(id, { $set: patch }, { new: true }) };

function actorOf(user) { return { user: user && user.id, userName: (user && user.name) || "", role: (user && user.role) || "" }; }

// Writes the audit record AND stamps the entity's Last Update, so both always describe the same business action.
// Pass ctx=null outside a unit of work.
async function audit(ctx, user, entry) {
  ctx = ctx || plainCtx;
  const rec = await ctx.create(M.AuditLog, {
    ...actorOf(user), action: entry.action, entityType: entry.entityType, entityId: entry.entityId != null ? String(entry.entityId) : undefined,
    entityLabel: entry.entityLabel, where: entry.where, reason: entry.reason, before: entry.before, after: entry.after, reference: entry.reference, override: !!entry.override,
  });
  const model = STAMPED[entry.entityType];
  if (model && entry.entityId != null && /^[a-f\d]{24}$/i.test(String(entry.entityId)) && !entry.noStamp) {
    await ctx.set(M[model], entry.entityId, { lastAction: entry.action, lastUpdatedBy: user && user.id, lastUpdatedByName: (user && user.name) || "", lastUpdatedAt: new Date() });
  }
  return rec;
}

async function recordOverride(ctx, user, { kind, blockedCode, reason, originalValue, newValue, operation, referenceTransaction }) {
  return (ctx || plainCtx).create(M.OverrideRecord, { kind, blockedCode, reason, originalValue, newValue, operation, referenceTransaction, admin: user.id, adminName: user.name });
}
module.exports = { audit, recordOverride, actorOf, plainCtx };
