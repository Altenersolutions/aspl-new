// Excel BOM import for ONE vehicle model.  Works when most lines have NO part number yet:
//   * a line with a part number  -> that part is used (created if it does not exist yet)
//   * a line without one         -> matched to an existing part by name, otherwise a PROVISIONAL part (TMP-xxxxx) is created
//   * re-importing the same sheet never creates duplicates (same name -> same part)
// Provisional parts are flagged (`provisional: true`) and can later be given their real number
// (POST /api/parts/:id/assign-number) - the BOM lines follow automatically.
const ExcelJS = require("exceljs");
const M = require("../models");
const C = require("./constants");
const { BusinessError, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { nextId } = require("./counters");
const { defaultsFor } = require("./partRules");

const s = (v) => (v == null ? "" : String(v).trim());
const key = (v) => s(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const normName = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// header synonyms (compared after key())
const HEAD = {
  partNumber: ["partno", "partnumber", "partid", "partcode", "pn", "itemcode", "itemno", "itemnumber", "materialcode"],
  name: ["description", "partname", "partdescription", "itemdescription", "itemname", "componentname", "component", "item", "part", "name", "material", "particulars"],
  qty: ["qty", "quantity", "qtyveh", "qtyperveh", "qtyperunit", "reqqty", "requiredqty", "requiredquantity", "nos", "noff", "count"],
  position: ["position", "installationposition", "assembly", "assy", "subassembly", "assemblyname", "usedin", "application", "location", "section"],
  mainSub: ["mainsub", "mainsa", "masa"],
  stage: ["stage", "station", "stagepart"],
  supplier: ["supplier", "vendor", "make", "manufacturer", "source"],
  spec: ["spec", "specification", "specs", "remarks"],
  unitCost: ["unitcost", "cost", "rate", "price", "unitprice"],
  category: ["category", "partcategory"],
};

function cellValue(c) {
  if (c == null) return "";
  if (typeof c === "object") {
    if (c instanceof Date) return c.toISOString().slice(0, 10);
    if (c.error) return "";                                   // #REF! etc.
    if (c.richText) return c.richText.map((r) => r.text).join("");
    if ("result" in c) return cellValue(c.result);            // formula
    if (c.text != null) return cellValue(c.text);             // hyperlink
    return "";
  }
  return c;
}

async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid("This is not a valid .xlsx file (save it as Excel Workbook and try again)."); }
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const arr = []; row.eachCell({ includeEmpty: true }, (cell, i) => { arr[i - 1] = cellValue(cell.value); }); rows.push(arr); });
    return { name: ws.name, rows };
  });
}

function pickSheet(sheets, model, wanted) {
  if (!sheets.length) throw invalid("The workbook has no sheets.");
  if (wanted) { const f = sheets.find((x) => x.name.trim().toLowerCase() === wanted.trim().toLowerCase()); if (!f) throw invalid(`Sheet "${wanted}" not found. Sheets in the file: ${sheets.map((x) => x.name).join(", ")}`); return f; }
  return sheets.find((x) => key(x.name) === key(model)) || sheets.find((x) => key(x.name).includes(key(model))) || sheets[0];
}

// rows = array of arrays. Walks the WHOLE sheet because real BOM sheets contain title banners, repeated header rows
// (e.g. a MECHANICAL part followed by an ELECTRICAL part), and numbered assembly rows above their parts.
//   hierarchical layout:  [1,"","","Head Light"]            <- assembly row (number in the first column)
//                         ["",1,"A","RH Head Light Bkt",..]  <- part row (number in the second column); assembly name becomes its position
const clean = (v) => (/^[-–—_.\s]*$/.test(s(v)) ? "" : s(v));
const isNum = (v) => /^\d+(\.\d+)?$/.test(s(v));
function matchHeader(r) {
  const cols = {}; let hits = 0;
  (r || []).forEach((h, ci) => { const k = key(h); if (!k) return; for (const [f, syn] of Object.entries(HEAD)) if (cols[f] == null && syn.includes(k)) { cols[f] = ci; hits++; break; } });
  return cols.name != null && hits >= 2 && (cols.qty != null || cols.partNumber != null || cols.position != null) ? cols : null;
}
function parseRows(rows) {
  const hierarchical = rows.filter((r) => r && isNum(r[1]) && /^[A-Za-z]$/.test(s(r[2])) && s(r[0]) === "").length >= 3;
  const warnings = []; const merged = new Map(); let map = null, firstHeader = null, group = "", hint = "", skipped = 0, headers = 0;
  rows.forEach((r, idx) => {
    r = r || []; const line = idx + 1; const vals = r.map(s).filter(Boolean);
    if (!vals.length) return;
    const h = matchHeader(r);
    if (h) { map = h; headers++; group = ""; if (!firstHeader) firstHeader = { row: line, columns: Object.fromEntries(Object.entries(h).map(([f, i]) => [f, i + 1])) }; return; }
    if (new Set(vals).size === 1 && /\bBOM\b|REVISION|LAST UPDATED/i.test(vals[0])) { // section banner
      if (/BOM|REVISION/i.test(vals[0]) && !/LAST UPDATED/i.test(vals[0])) { hint = /MECHANICAL/i.test(vals[0]) ? "MECHANICAL" : /ELECTRICAL/i.test(vals[0]) ? "ELECTRICAL" : ""; group = ""; map = null; }
      skipped++; return;
    }
    if (!map) { skipped++; return; }
    if (hierarchical && isNum(r[0]) && !s(r[1])) { group = s(r[map.name]) || s(r[2]) || s(r[3]); skipped++; return; } // assembly row
    const get = (f) => (map[f] == null ? "" : clean(r[map[f]]));
    const name = get("name"), pn = get("partNumber").toUpperCase();
    if (!name && !pn) { skipped++; return; }
    if (/^(total|grand total|sub ?total)\b/i.test(name)) { skipped++; return; }
    if (!name) warnings.push(`Row ${line}: part number ${pn} has no description - description set to the part number.`);
    const raw = get("qty"); let qty = raw === "" ? null : Number(raw);
    if (qty != null && (!Number.isFinite(qty) || qty <= 0)) { warnings.push(`Row ${line}: quantity "${raw}" is not valid - treated as 1.`); qty = null; }
    if (qty != null && !Number.isInteger(qty)) { warnings.push(`Row ${line}: quantity ${qty} rounded up to ${Math.ceil(qty)}.`); qty = Math.ceil(qty); }
    const specTxt = get("spec") && get("spec") !== name ? get("spec") : "";
    const k = pn || `${normName(name)}|${normName(specTxt)}`; // same name but different specification (M8 vs M10 bolt) = different part
    const cost = get("unitCost") === "" ? NaN : Number(get("unitCost").replace(/,/g, ""));
    const pos = hierarchical ? group : get("position");
    const cur = merged.get(k);
    if (cur) { cur.qty += qty == null ? 1 : qty; cur.qtyDefaulted = cur.qtyDefaulted && qty == null; if (pos && !cur.positions.includes(pos)) cur.positions.push(pos); cur.rows.push(line); }
    else merged.set(k, { partNumber: pn, name: name || pn, qty: qty == null ? 1 : qty, qtyDefaulted: qty == null, positions: pos ? [pos] : [], supplier: get("supplier"), spec: specTxt, unitCost: Number.isFinite(cost) ? cost : null, category: (get("category") || hint).toUpperCase(), rows: [line] });
  });
  if (!firstHeader) throw invalid("Could not find the header row. The sheet needs a column for the part description (e.g. DESCRIPTION / PART NAME) and ideally QTY.");
  const lines = [...merged.values()];
  if (!lines.length) throw invalid("No BOM lines found under the header row.");
  return { header: { ...firstHeader, sectionsFound: headers, layout: hierarchical ? "assemblies with numbered parts" : "flat list" }, lines, warnings, skippedRows: skipped, rawLines: lines.reduce((a, l) => a + l.rows.length, 0) };
}

// Same simple keyword rules as the presentation loader. Provisional parts are flagged so engineering can correct them.
const FAST = /\bbolt\b|\bnut\b|washer|screw|rivet|stud|circlip|split pin|cotter|grub|allen|\bclip\b|\bpin\b|shim|cable tie|lug\b/i;
const SERIAL = /motor|controller|vcu|bms|battery pack|charger|converter|hmi|\bccu\b|inverter|telematic|display/i;
const ELECTRONIC = /controller|vcu|hmi|\bccu\b|bms|\bpcb\b|board|sensor|display|telematic|gps|\bic\b/i;
const ELECTRICAL = /wire|wiring|harness|cable|relay|contactor|\bmcb\b|fuse|switch|connector|terminal|battery|charger|converter|inverter|motor|horn|light|lamp|indicator|\bfan\b/i;
function guess(l) {
  const t = `${l.name} ${l.spec}`;
  const category = C.CATEGORIES.includes(l.category) ? l.category : ELECTRONIC.test(t) ? "ELECTRONICS" : ELECTRICAL.test(t) ? "ELECTRICAL" : "MECHANICAL";
  const trackingType = FAST.test(t) ? "QUANTITY" : SERIAL.test(t) ? "SERIAL" : "BATCH";
  return { category, trackingType };
}

async function importBomExcel(user, model, meta, buffer, { sheet, dryRun } = {}) {
  model = s(model).toUpperCase(); if (!model) throw invalid("Vehicle model is required.");
  const sheets = await readWorkbook(buffer); const picked = pickSheet(sheets, model, sheet); const parsed = parseRows(picked.rows);
  let bom = await M.BOM.findOne({ vehicleModel: model });
  if (bom && (await M.BOMRevision.exists({ bom: bom._id, revision: meta.revision }))) throw new BusinessError("DUPLICATE_REVISION", `${model} already has a revision named ${meta.revision}. Use a new revision name (e.g. the next letter).`, { status: 409 });

  const existing = await M.PartMaster.find({}, "partNumber partName description trackingType").lean();
  const byNumber = new Map(existing.map((p) => [p.partNumber, p])); const byName = new Map();
  const nk = (name, spec) => `${normName(name)}|${normName(spec)}`;
  for (const p of existing) { const k = nk(p.partName, p.description); if (normName(p.partName) && !byName.has(k)) byName.set(k, p); }
  const suppliers = new Map((await M.Supplier.find({}, "name").lean()).map((x) => [normName(x.name), x._id]));

  const plan = parsed.lines.map((l) => {
    let part = null, how;
    if (l.partNumber) { part = byNumber.get(l.partNumber); how = part ? "EXISTING_ID" : "NEW_WITH_ID"; }
    else { part = byName.get(nk(l.name, l.spec)); how = part ? "EXISTING_BY_NAME" : "NEW_PROVISIONAL"; }
    return { l, part, how };
  });
  const count = (h) => plan.filter((p) => p.how === h).length;
  const summary = {
    model, revision: meta.revision, sheet: picked.name, sheetsInFile: sheets.map((x) => x.name), header: parsed.header,
    sourceRows: parsed.rawLines, bomLines: plan.length, mergedDuplicates: parsed.rawLines - plan.length,
    usedExistingById: count("EXISTING_ID"), usedExistingByName: count("EXISTING_BY_NAME"), createdWithGivenId: count("NEW_WITH_ID"), createdProvisional: count("NEW_PROVISIONAL"),
    quantityDefaultedTo1: plan.filter((p) => p.l.qtyDefaulted).length, warnings: parsed.warnings.slice(0, 50), dryRun: !!dryRun,
    preview: plan.slice(0, 15).map((p) => ({ partNumber: p.part ? p.part.partNumber : p.l.partNumber || "(new TMP-…)", name: p.l.name, qty: p.l.qty, how: p.how })),
  };
  if (dryRun) return summary;

  const compat = C.VEHICLE_TYPES.includes(model) ? [model] : [];
  const rev = await atomic(async (ctx) => {
    if (!bom) bom = await ctx.create(M.BOM, { vehicleModel: model, name: `${model} BOM` });
    const items = []; const seen = new Set();
    for (const { l, part, how } of plan) {
      let p = part;
      if (!p) {
        const g = guess(l); const provisional = how === "NEW_PROVISIONAL";
        const partNumber = provisional ? await nextId("tmpPart", "TMP", 5) : l.partNumber;
        const d = { partNumber, partName: l.name, description: l.spec || undefined, category: g.category, trackingType: g.trackingType, unit: "NOS", inventoryClass: "PRODUCTION", currentRevision: "REV-A",
          vehicleCompatibility: compat, unitCost: l.unitCost || undefined, supplier: l.supplier ? suppliers.get(normName(l.supplier)) : undefined, sourcing: l.supplier || undefined, provisional, minStock: 0 };
        Object.assign(d, defaultsFor(d));
        const created = await ctx.create(M.PartMaster, d);
        await ctx.create(M.PartRevision, { part: created._id, revision: "REV-A", status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), changeReason: `Created by BOM import (${model} ${meta.revision})`, effectiveDate: new Date() });
        await audit(ctx, user, { action: "PART_CREATED", entityType: "Part", entityId: created._id, entityLabel: partNumber, where: `BOM Excel import ${model}${provisional ? " (provisional number)" : ""}` });
        p = { _id: created._id, partNumber: created.partNumber, trackingType: created.trackingType };
        byName.set(nk(l.name, l.spec), p); byNumber.set(p.partNumber, p);
      }
      if (seen.has(String(p._id))) throw new BusinessError("DUPLICATE_BOM_ITEM", `${p.partNumber} resolves from two different rows (same part number and name used inconsistently). Fix the sheet.`, { status: 400 });
      seen.add(String(p._id));
      items.push({ part: p._id, partNumber: p.partNumber, requiredQuantity: l.qty, trackingType: p.trackingType, optional: false, installationPosition: l.positions.join("; ").slice(0, 400) || undefined });
    }
    const r = await ctx.create(M.BOMRevision, { bom: bom._id, vehicleModel: model, revision: meta.revision, effectiveDate: new Date(), changeReason: meta.changeReason, items, status: "DRAFT" });
    await audit(ctx, user, { action: "BOM_REVISION_CREATED", entityType: "BOM", entityId: bom._id, entityLabel: `${model} ${r.revision}`, reason: meta.changeReason, where: "Excel import", after: { items: items.length, provisionalParts: summary.createdProvisional } });
    return r;
  });
  return { ...summary, items: rev.items.length, status: rev.status };
}

// Give a provisional part its real number. Blocked once physical stock exists, because stock/QR labels carry the old number.
async function assignPartNumber(user, partId, newNumber) {
  const pn = s(newNumber).toUpperCase(); if (!pn || pn.length > 60) throw invalid("Enter the real part number.");
  const part = await M.PartMaster.findById(partId); if (!part) throw invalid("Unknown part.");
  if (!part.provisional) throw new BusinessError("NOT_PROVISIONAL", `${part.partNumber} is not a provisional number and cannot be renamed.`, { status: 400 });
  if (await M.PartMaster.exists({ partNumber: pn })) throw new BusinessError("DUPLICATE", `Part number ${pn} already exists.`, { status: 409 });
  if (await M.MaterialItem.exists({ part: part._id }) || await M.PurchaseOrder.exists({ "lines.part": part._id })) throw new BusinessError("PART_IN_USE", `${part.partNumber} already has stock or purchase orders, so its number can no longer be changed here.`, { status: 409 });
  const old = part.partNumber;
  await atomic(async (ctx) => {
    await ctx.set(M.PartMaster, part._id, { partNumber: pn, provisional: false });
    await M.BOMRevision.updateMany({ "items.part": part._id }, { $set: { "items.$[i].partNumber": pn } }, { arrayFilters: [{ "i.part": part._id }], ...(ctx.opt || {}) });
    ctx.onUndo(() => M.BOMRevision.collection.updateMany({ "items.part": part._id }, { $set: { "items.$[i].partNumber": old } }, { arrayFilters: [{ "i.part": part._id }] }));
    await audit(ctx, user, { action: "PART_NUMBER_ASSIGNED", entityType: "Part", entityId: part._id, entityLabel: pn, before: { partNumber: old }, after: { partNumber: pn } });
  });
  return { _id: part._id, partNumber: pn, previous: old };
}
module.exports = { readWorkbook, parseRows, importBomExcel, assignPartNumber, guess };
