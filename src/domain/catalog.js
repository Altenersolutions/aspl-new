const M = require("../models");
const C = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { nextId } = require("./counters");
const codes = require("./codes");
const s = (v) => (v == null ? "" : String(v).trim());
const yes = (v) => /^(y|yes|true|1|optional)$/i.test(s(v));

async function createBomRevision(user, model, body) {
  const bom = await M.BOM.findOne({ vehicleModel: s(model).toUpperCase() }); if (!bom) throw notFound("BOM", model);
  const items = []; const seen = new Set();
  for (const it of body.items) {
    const part = await M.PartMaster.findOne({ partNumber: s(it.partNumber).toUpperCase() });
    if (!part) throw new BusinessError("UNKNOWN_PART", `Unknown part ${it.partNumber}`, { status: 400 });
    if (seen.has(part.partNumber)) throw new BusinessError("DUPLICATE_BOM_ITEM", `${part.partNumber} appears twice in the BOM.`, { status: 400 });
    seen.add(part.partNumber);
    items.push({ part: part._id, partNumber: part.partNumber, requiredQuantity: it.requiredQuantity, requiredRevision: it.requiredRevision || undefined, trackingType: part.trackingType, optional: !!it.optional, installationPosition: it.installationPosition });
  }
  return atomic(async (ctx) => {
    const rev = await ctx.create(M.BOMRevision, { bom: bom._id, vehicleModel: bom.vehicleModel, revision: body.revision, effectiveDate: body.effectiveDate, changeReason: body.changeReason, items, status: "DRAFT" });
    await audit(ctx, user, { action: "BOM_REVISION_CREATED", entityType: "BOM", entityId: bom._id, entityLabel: `${bom.vehicleModel} ${rev.revision}`, reason: body.changeReason, after: { items: items.length } });
    return rev;
  });
}

async function importParts(user, rows, dryRun) {
  const res = { created: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    const n = i + 2; const pn = s(r.partnumber).toUpperCase();
    try {
      if (!pn || !s(r.partname)) throw new Error("partNumber and partName are required");
      const cat = s(r.category).toUpperCase(), tr = s(r.trackingtype).toUpperCase();
      if (!C.CATEGORIES.includes(cat)) throw new Error(`category must be one of ${C.CATEGORIES.join("/")}`);
      if (!C.TRACKING.includes(tr)) throw new Error(`trackingType must be one of ${C.TRACKING.join("/")}`);
      if (await M.PartMaster.exists({ partNumber: pn })) { res.skipped++; continue; }
      const compat = s(r.compatibility).split(/[;|]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (compat.some((x) => !C.VEHICLE_TYPES.includes(x))) throw new Error(`compatibility must be from ${C.VEHICLE_TYPES.join("/")}`);
      let bin = null; if (s(r.defaultbin)) { bin = await M.Location.findOne({ locationCode: s(r.defaultbin).toUpperCase(), type: "BIN" }); if (!bin) throw new Error(`default bin ${r.defaultbin} not found`); }
      const min = s(r.minstock) ? Number(r.minstock) : 0; if (!Number.isFinite(min) || min < 0) throw new Error("minStock invalid");
      if (!dryRun) await atomic(async (ctx) => {
        const p = await ctx.create(M.PartMaster, { partNumber: pn, partName: s(r.partname), description: s(r.description), category: cat, subCategory: s(r.subcategory), unit: s(r.unit) || "NOS", trackingType: tr, defaultLocation: bin && bin._id, vehicleCompatibility: compat, minStock: min, currentRevision: s(r.revision) || "REV-A" });
        await ctx.create(M.PartRevision, { part: p._id, revision: p.currentRevision, status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), changeReason: "Imported", effectiveDate: new Date() });
        await audit(ctx, user, { action: "PART_CREATED", entityType: "Part", entityId: p._id, entityLabel: pn, where: "CSV import" });
      });
      res.created++;
    } catch (e) { res.errors.push({ row: n, partNumber: pn, message: e.message }); }
  }
  return res;
}

async function importBom(user, model, meta, rows) {
  const items = rows.map((r) => ({ partNumber: r.partnumber, requiredQuantity: Number(r.quantity), requiredRevision: s(r.requiredrevision) || undefined, optional: yes(r.optional), installationPosition: s(r.position) }));
  const bad = items.findIndex((i) => !i.partNumber || !(i.requiredQuantity >= 1) || !Number.isInteger(i.requiredQuantity));
  if (bad >= 0) throw invalid(`Row ${bad + 2}: partNumber and a whole-number quantity ≥ 1 are required.`);
  return createBomRevision(user, model, { ...meta, items });
}

async function legacyBin() {
  let b = await M.Location.findOne({ locationCode: "LEGACY-STOCK" });
  if (!b) { b = await M.Location.create({ locationCode: "LEGACY-STOCK", name: "Legacy Stock (unverified)", type: "BIN", path: "Legacy Stock (unverified)" }); b.qrCode = codes.locationPayload(b); await b.save(); }
  return b;
}
async function importOpeningStock(user, rows, dryRun) {
  const res = { created: 0, errors: [] }; const bin = dryRun ? null : await legacyBin(); let n = 0;
  for (const [i, r] of rows.entries()) {
    const pn = s(r.partnumber).toUpperCase();
    try {
      const part = await M.PartMaster.findOne({ partNumber: pn }); if (!part) throw new Error("unknown part - import parts first");
      const qty = Number(r.quantity || 1); if (!(qty > 0) || (part.trackingType !== "QUANTITY" && !Number.isInteger(qty))) throw new Error("invalid quantity");
      let serial, batch;
      if (part.trackingType === "SERIAL") { serial = s(r.serialnumber); if (!serial || qty !== 1) throw new Error("serial-tracked parts need one row per serial number, quantity 1"); if (await M.MaterialItem.exists({ part: part._id, serialNumber: serial })) throw new Error(`serial ${serial} already exists`); }
      else { batch = s(r.batchnumber); if (part.trackingType === "BATCH" && !batch) throw new Error("batch-tracked parts need a batchNumber"); batch = batch || `OPEN-${Date.now().toString(36)}-${++n}`; }
      if (!dryRun) await atomic(async (ctx) => {
        const it = await ctx.create(M.MaterialItem, { part: part._id, partNumber: part.partNumber, partRevision: s(r.revision) || part.currentRevision, trackingType: part.trackingType, serialNumber: serial, batchNumber: batch, quantity: qty, status: "LEGACY_UNVERIFIED", legacy: true, legacyNote: "Opening stock import - requires re-qualification" });
        await ctx.create(M.StockBalance, { materialItem: it._id, part: part._id, location: bin._id, quantity: qty });
        await ctx.create(M.InventoryTransaction, { transactionId: await nextId("txn", "TXN", 7), transactionType: "ADJUSTMENT", part: part._id, partNumber: part.partNumber, materialItem: it._id, serialNumber: serial, batchNumber: batch, quantity: qty, toLocation: bin._id, toStatus: "LEGACY_UNVERIFIED", user: user.id, userName: user.name, reason: "Opening stock import", referenceType: "Import" });
      });
      res.created++;
    } catch (e) { res.errors.push({ row: i + 2, partNumber: pn, message: e.message }); }
  }
  return res;
}

async function createPo(user, body) {
  const supplier = await M.Supplier.findById(body.supplierId).catch(() => null); if (!supplier) throw invalid("Unknown supplier.");
  const lines = [];
  for (const l of body.lines) { const p = await M.PartMaster.findOne({ partNumber: s(l.partNumber).toUpperCase() }); if (!p) throw invalid(`Unknown part ${l.partNumber}`); lines.push({ part: p._id, partNumber: p.partNumber, orderedQty: l.orderedQty, receivedQty: 0 }); }
  return atomic(async (ctx) => {
    const po = await ctx.create(M.PurchaseOrder, { poNo: s(body.poNo).toUpperCase() || (await nextId("po", "PO", 5)), supplier: supplier._id, lines, expectedDate: body.expectedDate ? new Date(body.expectedDate) : undefined, notes: body.notes, createdBy: user.id });
    await audit(ctx, user, { action: "PO_CREATED", entityType: "PurchaseOrder", entityId: po._id, entityLabel: po.poNo, after: { supplier: supplier.name, lines: lines.length } });
    return po;
  });
}
module.exports = { createBomRevision, importParts, importBom, importOpeningStock, createPo };
