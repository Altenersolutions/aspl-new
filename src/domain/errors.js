// Business errors carry a machine-readable code so the UI can show a clear message
// and so admin overrides can be matched to the exact rule that was bypassed.
class BusinessError extends Error {
  constructor(code, message, { status = 409, details = {}, overridable = false, overrideKind = null } = {}) {
    super(message);
    this.name = "BusinessError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.overridable = overridable;
    this.overrideKind = overrideKind; // e.g. WRONG_LOCATION, BOM_MISMATCH, WRONG_VEHICLE
  }
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      details: this.details,
      overridable: this.overridable,
      overrideKind: this.overrideKind,
    };
  }
}
const notFound = (what, id) => new BusinessError("NOT_FOUND", `${what} not found${id ? `: ${id}` : ""}`, { status: 404 });
const forbidden = (msg = "You do not have permission to do this.") => new BusinessError("FORBIDDEN", msg, { status: 403 });
const invalid = (msg, details) => new BusinessError("VALIDATION", msg, { status: 400, details });
module.exports = { BusinessError, notFound, forbidden, invalid };
