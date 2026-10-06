// Capital assets register: list / summary / CSV import. Kept apart from stock on purpose.
const M = require("../models");
const { audit } = require("./audit");
const s = (v) => (v == null ? "" : String(v).trim());
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STATUSES = ["IN_USE", "IN_STORE", "UNDER_REPAIR", "DISPOSED"];

function filterOf(q = {}) {
  const f = {};
  if (s(q.area)) f.area = s(q.area);
  if (s(q.category)) f.category = s(q.category);
  if (s(q.status)) f.status = s(q.status);
  if (s(q.q)) { const rx = new RegExp(esc(s(q.q)), "i"); f.$or = [{ assetNo: rx }, { description: rx }, { make: rx }, { vendor: rx }, { invoiceNo: rx }, { remarks: rx }]; }
  return f;
}
async function list(q) {
  const f = filterOf(q); const limit = Math.min(Number(q.limit) || 2000, 5000);
  const [rows, total] = await Promise.all([M.CapitalAsset.find(f).sort({ areaCode: 1, assetNo: 1 }).limit(limit).lean(), M.CapitalAsset.countDocuments(f)]);
  return { rows, total };
}
// Totals for the page header + presentation: how many assets, by area and category, and how complete the register is.
async function summary() {
  const [t] = await M.CapitalAsset.aggregate([{ $group: { _id: null, records: { $sum: 1 }, units: { $sum: "$quantity" }, value: { $sum: { $ifNull: ["$totalAmount", 0] } },
    withValue: { $sum: { $cond: [{ $gt: ["$totalAmount", 0] }, 1, 0] } }, withInvoice: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$invoiceNo", ""] } }, 0] }, 1, 0] } },
    withDate: { $sum: { $cond: [{ $ifNull: ["$purchaseDate", false] }, 1, 0] } } } }]);
  const grp = (key) => M.CapitalAsset.aggregate([{ $group: { _id: `$${key}`, records: { $sum: 1 }, units: { $sum: "$quantity" }, value: { $sum: { $ifNull: ["$totalAmount", 0] } } } }, { $sort: { records: -1 } }]);
  const [byArea, byCategory, byStatus] = await Promise.all([grp("area"), grp("category"), grp("status")]);
  const pick = (r) => r.map((x) => ({ name: x._id || "(none)", records: x.records, units: x.units, value: x.value }));
  return { totals: t || { records: 0, units: 0, value: 0, withValue: 0, withInvoice: 0, withDate: 0 }, byArea: pick(byArea), byCategory: pick(byCategory), byStatus: pick(byStatus) };
}

// ---- CSV import. Accepts our own export AND the headings used in the Excel register ("ASSET NO", "Invoice/ Bill Ref  No", ...). parseCsv lower-cases and strips non-alphanumerics.
const COLS = {
  assetNo: ["assetno", "assetid", "assettag"], description: ["description", "assetname", "name"], category: ["category"], area: ["area"], location: ["location"],
  quantity: ["quantity", "qty"], make: ["make", "brand"], purchaseDate: ["purchasedate", "date"], invoiceNo: ["invoiceno", "invoicebillrefno", "invoice"],
  vendor: ["vendor", "fromvendor", "supplier"], remarks: ["remarks", "accessoriesremarks", "accessories"], totalAmount: ["totalamount", "totalamountincludegst", "amount", "cost"], status: ["status"],
};
const pickCol = (r, k) => { for (const h of COLS[k]) if (r[h] !== undefined && s(r[h]) !== "") return s(r[h]); return ""; };
function parseDate(v) {
  const t = s(v); if (!t) return undefined;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); } // day first (India)
  return null;
}
// One CSV row -> asset fields, or throws a readable message.
function mapRow(r) {
  const assetNo = pickCol(r, "assetNo"); if (!assetNo) throw new Error("Asset No is required");
  const description = pickCol(r, "description"); if (!description) throw new Error("Description is required");
  const q = pickCol(r, "quantity"); const quantity = q === "" ? 1 : Number(q); if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be a number");
  const dt = parseDate(pickCol(r, "purchaseDate")); if (dt === null) throw new Error("Date not understood (use YYYY-MM-DD or DD/MM/YYYY)");
  const am = pickCol(r, "totalAmount").replace(/[,₹\s]/g, ""); const totalAmount = am === "" ? undefined : Number(am); if (totalAmount !== undefined && !(totalAmount >= 0)) throw new Error("Amount must be a number");
  const st = pickCol(r, "status").toUpperCase().replace(/\s+/g, "_"); if (st && !STATUSES.includes(st)) throw new Error(`Status must be one of ${STATUSES.join("/")}`);
  const mm = assetNo.match(/^ASPL-([A-Z0-9]{2})-\d+/i);
  const area = pickCol(r, "area") || pickCol(r, "location");
  const out = { assetNo, description, quantity, category: pickCol(r, "category") || undefined, area: area || undefined, location: pickCol(r, "location") || area || undefined, areaCode: mm ? mm[1].toUpperCase() : undefined,
    make: /^n\/?a$/i.test(pickCol(r, "make")) ? undefined : pickCol(r, "make") || undefined, purchaseDate: dt, invoiceNo: pickCol(r, "invoiceNo") || undefined, vendor: pickCol(r, "vendor") || undefined,
    remarks: /^n\/?a$/i.test(pickCol(r, "remarks")) ? undefined : pickCol(r, "remarks") || undefined, totalAmount, status: st || undefined };
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}
async function importCsv(user, rows, dryRun) {
  const res = { created: 0, updated: 0, errors: [] }; const ops = []; const seen = new Set();
  for (const [i, r] of rows.entries()) {
    try {
      const a = mapRow(r); if (seen.has(a.assetNo)) throw new Error(`${a.assetNo} appears twice in the file`); seen.add(a.assetNo);
      ops.push(a);
    } catch (e) { res.errors.push({ row: i + 2, assetNo: s(pickCol(r, "assetNo")), message: e.message }); }
  }
  const existing = new Set((await M.CapitalAsset.find({ assetNo: { $in: ops.map((o) => o.assetNo) } }).select("assetNo").lean()).map((x) => x.assetNo));
  res.created = ops.filter((o) => !existing.has(o.assetNo)).length; res.updated = ops.length - res.created;
  if (!dryRun && ops.length) {
    await M.CapitalAsset.bulkWrite(ops.map((o) => ({ updateOne: { filter: { assetNo: o.assetNo }, update: { $set: o }, upsert: true } })));
    await audit(null, user, { action: "ASSETS_IMPORTED", entityType: "CapitalAsset", entityLabel: "CSV import", where: "CSV import", after: { created: res.created, updated: res.updated, errors: res.errors.length } });
  }
  return res;
}
module.exports = { list, summary, importCsv, mapRow, parseDate, STATUSES };
