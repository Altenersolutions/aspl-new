const { Location, StockBalance, PartMaster } = require("../models");
const { BusinessError } = require("./errors");

async function locationPath(loc) {
  const names = [loc.name];
  let cur = loc;
  for (let i = 0; i < 8 && cur.parentLocation; i++) {
    cur = await Location.findById(cur.parentLocation).lean();
    if (!cur) break;
    names.unshift(cur.name);
  }
  return names.join(" > ");
}

async function usedCapacity(locationId, opt = {}) {
  const rows = await StockBalance.aggregate([{ $match: { location: locationId } }, { $group: { _id: null, q: { $sum: "$quantity" } } }]);
  return rows.length ? rows[0].q : 0;
}

// Does this location accept this part/quantity? Returns null if OK, else a reason string.
async function rejectionReason(loc, part, qty) {
  if (!loc.active) return "Location is inactive";
  if (loc.allowedCategories && loc.allowedCategories.length && !loc.allowedCategories.includes(part.category))
    return `Location does not accept category ${part.category}`;
  if (loc.allowedPartTypes && loc.allowedPartTypes.length && !loc.allowedPartTypes.includes(part.trackingType))
    return `Location does not accept ${part.trackingType} tracked parts`;
  if (loc.capacity != null) {
    const used = await usedCapacity(loc._id);
    if (used + qty > loc.capacity) return `Location capacity exceeded (${used}/${loc.capacity})`;
  }
  return null;
}

// Storage rules come from the database: part default location -> part storage rule -> location rules.
async function resolveDestination(part, qty = 1) {
  const bins = async (q) => Location.find({ type: "BIN", active: true, ...q }).sort({ locationCode: 1 });
  const tried = [];
  if (part.defaultLocation) {
    const d = await Location.findById(part.defaultLocation);
    if (d) {
      const why = await rejectionReason(d, part, qty);
      if (!why) return d;
      tried.push(`${d.locationCode}: ${why}`);
    }
  }
  const rule = part.storageRule || {};
  const q = {};
  if (rule.store) q.store = rule.store;
  if (rule.zone) q.zone = rule.zone;
  if (rule.rack) q.rack = rule.rack;
  if (Object.keys(q).length) {
    for (const b of await bins(q)) { const why = await rejectionReason(b, part, qty); if (!why) return b; tried.push(`${b.locationCode}: ${why}`); }
  }
  for (const b of await bins({ allowedCategories: part.category })) {
    const why = await rejectionReason(b, part, qty); if (!why) return b; tried.push(`${b.locationCode}: ${why}`);
  }
  throw new BusinessError("NO_STORAGE_LOCATION", `No storage location is configured for ${part.partNumber}. Ask an administrator to set a default location or storage rule.`, { details: { tried } });
}

async function findSpecial(type) {
  const l = await Location.findOne({ type, active: true }).sort({ locationCode: 1 });
  if (!l) throw new BusinessError("SPECIAL_LOCATION_MISSING", `No active ${type} location configured. Run the seed or add one in Admin > Locations.`, { status: 500 });
  return l;
}

module.exports = { locationPath, resolveDestination, rejectionReason, findSpecial, usedCapacity };
