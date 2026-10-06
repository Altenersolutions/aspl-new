// One place that decides how a part behaves, from its inventory class (GENERAL / PRODUCTION / DEVELOPMENT) and any explicit flags.
const deriveClass = (p) => (p.inventoryClass || (p.category === "CONSUMABLE" ? "GENERAL" : p.category === "DEVELOPMENT" ? "DEVELOPMENT" : "PRODUCTION"));
function rules(p) {
  const cls = deriveClass(p), t = p.trackingType;
  return {
    inventoryClass: cls,
    qcRequired: p.qcRequired ?? cls === "PRODUCTION",                              // GENERAL / DEVELOPMENT skip incoming QC unless configured
    fifo: p.fifoApplicable ?? (cls === "PRODUCTION" || (cls === "GENERAL" && t === "BATCH")),
    bomControlled: p.bomControlled ?? cls === "PRODUCTION",                          // BOM + revision validation on installation
    revisionControlled: p.revisionControlled ?? cls !== "GENERAL",
    isDevelopment: cls === "DEVELOPMENT",
  };
}
// Values to store on a new part so the flags are explicit in the database.
const defaultsFor = (p) => { const r = rules(p); return { inventoryClass: r.inventoryClass, qcRequired: r.qcRequired, fifoApplicable: r.fifo, bomControlled: r.bomControlled, revisionControlled: r.revisionControlled }; };
module.exports = { rules, deriveClass, defaultsFor };
