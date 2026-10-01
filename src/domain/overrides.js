const { BusinessError, forbidden } = require("./errors");
const { can, P } = require("./permissions");
const { recordOverride, audit } = require("./audit");

// Sensitive-rule bypass. Only rules thrown with overridable=true can be bypassed, only by users
// with override.approve, and only with a written reason and explicit confirmation.
async function assertOverrideAllowed(user, err, override) {
  if (!err.overridable) return false;
  if (!override) return false;
  if (!(await can(user.role, P.OVERRIDE))) throw forbidden("Only an administrator can override this control.");
  if (!override.reason || String(override.reason).trim().length < 5) {
    throw new BusinessError("OVERRIDE_REASON_REQUIRED", "A reason (min 5 characters) is required for an admin override.", { status: 400 });
  }
  if (override.confirm !== true) {
    throw new BusinessError("OVERRIDE_CONFIRMATION_REQUIRED", "Override must be explicitly confirmed.", { status: 400 });
  }
  return true;
}

// Run `check()`. If it throws an overridable BusinessError and a valid override is supplied,
// continue and report that an override was used. Otherwise rethrow.
async function guarded(user, override, check) {
  try { await check(); return null; }
  catch (err) {
    if (!(err instanceof BusinessError)) throw err;
    if (await assertOverrideAllowed(user, err, override)) return err;
    throw err;
  }
}

// Persist the override bookkeeping once the transaction id is known.
async function logOverride(ctx, user, blockedErr, override, { operation, originalValue, newValue, referenceTransaction, entityType, entityId, entityLabel }) {
  await recordOverride(ctx, user, {
    kind: blockedErr.overrideKind, blockedCode: blockedErr.code, reason: override.reason,
    originalValue, newValue, operation, referenceTransaction,
  });
  await audit(ctx, user, {
    action: `OVERRIDE_${blockedErr.overrideKind}`, entityType, entityId, entityLabel,
    reason: override.reason, before: originalValue, after: newValue, reference: referenceTransaction, override: true,
  });
}
module.exports = { guarded, logOverride, assertOverrideAllowed };
