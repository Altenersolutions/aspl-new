const { AuditLog, OverrideRecord } = require("../models");

function actorOf(user) {
  return { user: user && user.id, userName: (user && user.name) || "", role: (user && user.role) || "" };
}

// Always call inside the same unit of work as the change it describes.
async function audit(ctx, user, entry) {
  return ctx.create(AuditLog, {
    ...actorOf(user),
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId != null ? String(entry.entityId) : undefined,
    entityLabel: entry.entityLabel,
    where: entry.where,
    reason: entry.reason,
    before: entry.before,
    after: entry.after,
    reference: entry.reference,
    override: !!entry.override,
  });
}

async function recordOverride(ctx, user, { kind, blockedCode, reason, originalValue, newValue, operation, referenceTransaction }) {
  return ctx.create(OverrideRecord, {
    kind, blockedCode, reason, originalValue, newValue, operation, referenceTransaction,
    admin: user.id, adminName: user.name,
  });
}
module.exports = { audit, recordOverride, actorOf };
