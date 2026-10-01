// Legacy -> new architecture migration.  Additive and idempotent: legacy collections are never modified or dropped.
//   node src/scripts/migrateLegacy.js            (dry run, prints the plan)
//   node src/scripts/migrateLegacy.js --apply    (writes)
// Rules: no serial/batch numbers are invented. Migrated stock is MaterialItem{legacy:true,status:LEGACY_UNVERIFIED}
// held in LEGACY-STOCK and must be re-qualified through QC before it can be issued or installed.
const db = require("../db");
const M = require("../models");
const codes = require("../domain/codes");
const { ensureBaseData } = require("./baseData");
const { atomic } = require("../domain/uow");

const CAT = { EE: "ELECTRICAL", ELECTRICAL: "ELECTRICAL", ME: "MECHANICAL", MECHANICAL: "MECHANICAL", EC: "ELECTRONICS", ELECTRONICS: "ELECTRONICS" };
const mapCat = (c, fallback = "OTHER") => CAT[String(c || "").trim().toUpperCase()] || fallback;
const sanitize = (v) => String(v || "").trim();

async function run({ apply = false, log = console.log } = {}) {
  await ensureBaseData();
  const report = { parts: 0, partsSkipped: 0, stock: 0, suppliers: 0, boms: 0, bomItems: 0, incomingReviewed: 0, warnings: [] };
  const supplierCache = new Map();
  const supplierFor = async (name) => {
    const n = sanitize(name); if (!n) return null;
    const code = n.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 30) || "UNKNOWN";
    if (supplierCache.has(code)) return supplierCache.get(code);
    let s = await M.Supplier.findOne({ code });
    if (!s && apply) { s = await M.Supplier.create({ code, name: n }); report.suppliers++; } else if (!s) report.suppliers++;
    supplierCache.set(code, s); return s;
  };
  let legacyBin = await M.Location.findOne({ locationCode: "LEGACY-STOCK" });
  if (!legacyBin && apply) { legacyBin = await M.Location.create({ locationCode: "LEGACY-STOCK", name: "Legacy Stock (unverified)", type: "BIN", path: "Legacy Stock (unverified)" }); legacyBin.qrCode = codes.locationPayload(legacyBin); await legacyBin.save(); }

  async function ensurePart(doc, source, fallbackCat, tracking) {
    const partNumber = sanitize(doc.partId).toUpperCase();
    if (!partNumber) { report.warnings.push(`${source} ${doc._id}: no partId - skipped`); return null; }
    let p = await M.PartMaster.findOne({ partNumber });
    if (p) return p;
    report.parts++;
    if (!apply) return { _id: null, partNumber, trackingType: tracking };
    const sup = await supplierFor(doc.supplier);
    p = await M.PartMaster.create({ partNumber, partName: sanitize(doc.partName) || partNumber, description: sanitize(doc.specification), category: mapCat(doc.catagory, fallbackCat), subCategory: sanitize(doc.catagory), unit: sanitize(doc.SI) || "NOS", trackingType: tracking, supplier: sup && sup._id, vehicleCompatibility: doc.vehicles || [], legacy: { source, legacyId: String(doc._id) } });
    await M.PartRevision.create({ part: p._id, revision: p.currentRevision, status: "APPROVED", changeReason: "Migrated from legacy prototype", effectiveDate: new Date() });
    return p;
  }

  // 1. legacy Parts (stock list) -> PartMaster + unverified legacy stock
  for (const doc of await require("../models/legacy").Parts.find().lean()) {
    const p = await ensurePart(doc, "InventoryParts", "OTHER", "QUANTITY");
    if (!p) { report.partsSkipped++; continue; }
    const qty = Number(doc.quantity) || 0;
    if (qty > 0 && p._id) {
      if (await M.MaterialItem.exists({ part: p._id, legacy: true, "legacyNote": new RegExp(`^InventoryParts:${doc._id}`) })) continue;
      report.stock++;
      if (apply) await atomic(async (ctx) => {
        const item = await ctx.create(M.MaterialItem, { part: p._id, partNumber: p.partNumber, partRevision: p.currentRevision, trackingType: "QUANTITY", batchNumber: `LEGACY-${doc._id}`, quantity: qty, status: "LEGACY_UNVERIFIED", legacy: true, legacyNote: `InventoryParts:${doc._id} location="${sanitize(doc.location)}" - serial/batch unknown` });
        await ctx.create(M.StockBalance, { materialItem: item._id, part: p._id, location: legacyBin._id, quantity: qty });
        await ctx.create(M.InventoryTransaction, { transactionId: `MIG-${item._id}`, transactionType: "ADJUSTMENT", part: p._id, partNumber: p.partNumber, materialItem: item._id, batchNumber: item.batchNumber, quantity: qty, toLocation: legacyBin._id, toStatus: "LEGACY_UNVERIFIED", userName: "MIGRATION", reason: "Opening balance migrated from legacy Parts list", referenceType: "Migration", referenceId: String(doc._id) });
      });
    } else if (qty < 0) report.warnings.push(`Parts ${doc.partId}: negative legacy quantity ${qty} not migrated`);
  }
  // 2. Consumables and Development items -> PartMaster only (no stock rows existed)
  for (const doc of await require("../models/legacy").Con.find().lean()) await ensurePart(doc, "InventoryCon", "CONSUMABLE", "QUANTITY");
  for (const doc of await require("../models/legacy").Dev.find().lean()) await ensurePart(doc, "InventoryDev", "DEVELOPMENT", "QUANTITY");

  // 3. legacy BOM -> per-vehicle model BOM, revision LEGACY-A (DRAFT: engineering must approve before use)
  const legacyBom = await require("../models/legacy").Bom.find().lean();
  const byModel = {};
  for (const b of legacyBom) for (const v of b.vehicles || []) (byModel[v] = byModel[v] || []).push(b);
  for (const [model, rows] of Object.entries(byModel)) {
    let bom = await M.BOM.findOne({ vehicleModel: model });
    if (!bom && apply) bom = await M.BOM.create({ vehicleModel: model, name: `${model} BOM` }); report.boms += bom ? 0 : 1;
    if (bom && (await M.BOMRevision.exists({ bom: bom._id, revision: "LEGACY-A" }))) continue;
    const items = [];
    for (const b of rows) {
      const p = await ensurePart(b, "InventoryBom", "OTHER", "QUANTITY");
      if (!p || !p._id) { report.bomItems++; continue; }
      items.push({ part: p._id, partNumber: p.partNumber, requiredQuantity: Math.max(1, Math.round(Number(b.quantity) || 1)), trackingType: p.trackingType });
      report.bomItems++;
    }
    if (apply && items.length) await M.BOMRevision.create({ bom: bom._id, vehicleModel: model, revision: "LEGACY-A", status: "DRAFT", changeReason: "Migrated from legacy BOM list; review revisions and tracking types, then approve", items });
  }
  // 4. legacy Incoming: reported, not converted (no invoice-validated receipt; stock already counted in Parts).
  const inc = await require("../models/legacy").Incomming.find().lean();
  report.incomingReviewed = inc.length;
  const noInvoice = inc.filter((i) => !sanitize(i.invoice)).length;
  if (noInvoice) report.warnings.push(`${noInvoice} legacy Incoming records have no invoice number (kept as-is in legacy collection; not converted).`);
  log(JSON.stringify({ mode: apply ? "APPLIED" : "DRY-RUN", ...report }, null, 2));
  return report;
}
module.exports = { run };
if (require.main === module) db.connect().then(() => run({ apply: process.argv.includes("--apply") })).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
