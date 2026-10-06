// Loads the REAL BOM (BOM.xlsx -> src/data/bom.json) and the REAL capital assets register (src/data/assets.json),
// plus clearly-marked DEMO stock so every screen has something to show in a presentation.
//
//   npm run load:presentation -- --dry-run      builds + validates everything, writes nothing (no database needed)
//   npm run load:presentation                   loads into the database in MONGO_URI (use a TEST database, see README)
//   npm run load:presentation -- --force        run again on a database that already has parts (existing records are skipped)
//   npm run load:presentation -- --no-demo-stock  real BOM + assets only
//   npm run load:presentation -- --wipe-demo    removes ONLY the demo stock (receipts whose invoice starts with DEMO-)
//
// Real data   : parts, BOMs (REV-A, approved), capital assets - taken from your Excel files, nothing invented.
// Demo data   : receipts / stock quantities / QC results / NCRs / sample vehicles - invented, invoice numbers start with DEMO-.
const mongoose = require("mongoose");
const codes = require("../domain/codes");
const M = require("../models");
const { defaultsFor } = require("../domain/partRules");
const bom = require("../data/bom.json");
const assetData = require("../data/assets.json");

const args = new Set(process.argv.slice(2));
const OID = () => new mongoose.Types.ObjectId();
const DAY = 86400000;

// deterministic pseudo random, so the same demo comes out every time
function rngFrom(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pad = (n, w) => String(n).padStart(w, "0");

/* ---------------- storage locations ---------------- */
const ELC = ["ELECTRICAL", "ELECTRONICS"], MEC = ["MECHANICAL", "CONSUMABLE"];
const TREE = [
  ["ES", "Electrical Store", "STORE", null], ["ES-Z1", "Electrical Zone 1", "ZONE", "ES"],
  ["ES-Z1-CONN", "Connector & Terminal Rack", "RACK", "ES-Z1"], ["E-08", "E-08", "BIN", "ES-Z1-CONN", ELC],
  ["ES-Z1-RELAY", "Relay & Switch Rack", "RACK", "ES-Z1"], ["E-12", "E-12", "BIN", "ES-Z1-RELAY", ["ELECTRICAL"]],
  ["ES-Z1-CTRL", "Controller Rack", "RACK", "ES-Z1"], ["E-20", "E-20", "BIN", "ES-Z1-CTRL", ELC],
  ["ES-Z1-HARN", "Harness & Cable Rack", "RACK", "ES-Z1"], ["E-30", "E-30", "BIN", "ES-Z1-HARN", ["ELECTRICAL"]],
  ["ES-Z1-BATT", "Battery & Power Rack", "RACK", "ES-Z1"], ["E-40", "E-40", "BIN", "ES-Z1-BATT", ELC],
  ["ES-Z1-COMP", "Electronic Components Rack", "RACK", "ES-Z1"], ["E-50", "E-50", "BIN", "ES-Z1-COMP", ELC],
  ["MS", "Mechanical Store", "STORE", null], ["MS-Z1", "Mechanical Zone 1", "ZONE", "MS"],
  ["MS-Z1-BODY", "Chassis & Body Rack", "RACK", "MS-Z1"], ["M-01", "M-01", "BIN", "MS-Z1-BODY", MEC],
  ["MS-Z1-WHL", "Wheels & Brakes Rack", "RACK", "MS-Z1"], ["M-02", "M-02", "BIN", "MS-Z1-WHL", MEC],
  ["MS-Z1-FAST", "Fastener Rack", "RACK", "MS-Z1"], ["M-04", "M-04", "BIN", "MS-Z1-FAST", MEC],
  ["MS-Z1-MISC", "General Mechanical Rack", "RACK", "MS-Z1"], ["M-05", "M-05", "BIN", "MS-Z1-MISC", MEC],
];
function buildLocations(existing) {
  const byCode = new Map(); const docs = [];
  for (const [code, name, type, parentCode, cats] of TREE) {
    if (existing.has(code)) { byCode.set(code, existing.get(code)); continue; }
    const parent = parentCode ? byCode.get(parentCode) : null;
    const d = { _id: OID(), locationCode: code, name, type, active: true, ...(cats ? { allowedCategories: cats } : {}) };
    if (parent) Object.assign(d, { parentLocation: parent._id, store: parent.store, zone: parent.zone, rack: parent.rack, shelf: parent.shelf, path: `${parent.path} > ${name}` }); else d.path = name;
    d[{ STORE: "store", ZONE: "zone", RACK: "rack", SHELF: "shelf", BIN: "bin" }[type]] = name;
    d.qrCode = codes.locationPayload(d); docs.push(d); byCode.set(code, d);
  }
  return { docs, byCode };
}
const FAST = /\bbolt\b|\bnut\b|washer|screw|rivet|stud|circlip|split pin|cotter|grub|allen|hex|clamp|\bclip\b|bush|spacer|\bpin\b|shim/i;
function binFor(p) {
  const t = `${p.description} ${p.spec}`.toLowerCase();
  if (p.category === "MECHANICAL") {
    if (/wheel|tyre|tire|rim|drum|brake|break|hub|axle/.test(t)) return "M-02";
    if (FAST.test(t)) return "M-04";
    if (/chassis|arm|bracket|bkt|panel|door|seat|frp|glass|window|cabin|body|fork|container|mount|plate|bumper|mirror/.test(t)) return "M-01";
    return "M-05";
  }
  if (p.category === "ELECTRONICS") return /controller|vcu|hmi|ccu|bms|board/.test(t) ? "E-20" : "E-50";
  if (/relay|contactor|mcb|switch|fuse/.test(t)) return "E-12";
  if (/harness|wire|wiring|cable/.test(t)) return "E-30";
  if (/battery|charger|converter|inverter|dc-dc|motor|fan/.test(t)) return "E-40";
  return "E-08";
}

/* ---------------- suppliers ---------------- */
function supplierCode(name, used) {
  let base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8) || "SUP"; let c = base, i = 2; while (used.has(c)) c = base.slice(0, 6) + i++; used.add(c); return c;
}

/* ---------------- main builder (pure: no database access, so --dry-run can validate it) ---------------- */
function build(ctx) {
  const { existingParts, existingLocs, special, users, counters, withDemoStock } = ctx;
  const out = { locations: [], suppliers: [], parts: [], revisions: [], boms: [], bomRevs: [], vehicles: [], receipts: [], items: [], balances: [], txns: [], qcs: [], ncrs: [] };
  const L = buildLocations(existingLocs); out.locations = L.docs;

  // suppliers named in the BOM + three generic ones
  const used = new Set(ctx.existingSupplierCodes); const sup = new Map();
  const mk = (name, extra = {}) => { if (sup.has(name)) return sup.get(name); const d = { _id: OID(), code: supplierCode(name, used), name, active: true, ...extra }; out.suppliers.push(d); sup.set(name, d); return d; };
  for (const n of new Set(bom.parts.map((p) => p.supplier).filter(Boolean))) mk(n);
  const LOCAL = mk("Local Market (various)"), INHOUSE = mk("In-house Fabrication"), GENERAL = mk("General Supplier (to be assigned)");
  const supplierOf = (p) => (p.supplier ? sup.get(p.supplier) : p.sourcing === "Inhouse" ? INHOUSE : p.sourcing === "Local" ? LOCAL : GENERAL);

  // parts + REV-A revision
  const partDoc = new Map();
  for (const p of bom.parts) {
    if (existingParts.has(p.partNumber)) continue;
    const bin = L.byCode.get(binFor(p));
    const d = { _id: OID(), partNumber: p.partNumber, partName: p.description, description: p.spec || undefined, category: p.category, unit: "NOS", trackingType: p.trackingType,
      defaultLocation: bin._id, supplier: supplierOf(p)._id, vehicleCompatibility: p.vehicles, inventoryClass: "PRODUCTION", currentRevision: "REV-A",
      minStock: p.trackingType === "QUANTITY" ? 50 : p.trackingType === "BATCH" ? 10 : 2, unitCost: p.unitCost || undefined, sourcing: p.sourcing || p.resource || undefined, active: true };
    Object.assign(d, defaultsFor(d));
    out.parts.push(d); partDoc.set(p.partNumber, d);
    out.revisions.push({ _id: OID(), part: d._id, revision: "REV-A", status: "APPROVED", approvedAt: new Date(), changeReason: "Initial revision (BOM load)", effectiveDate: new Date() });
  }

  // BOMs (REV-A, DRAFT until the BOM is finalized and approved in the app)
  const partId = ctx.partIdByNumber; // existing parts (--force re-runs)
  for (const model of ["BUZZ", "LITE", "RETROFIT"]) {
    if (ctx.existingBoms.has(model)) continue;
    const b = { _id: OID(), vehicleModel: model, name: `${model} BOM`, currentRevision: "REV-A" }; out.boms.push(b);
    const items = bom.boms[model].map((r) => { const pd = partDoc.get(r.partNumber) || partId.get(r.partNumber); return { part: pd._id, partNumber: r.partNumber, requiredQuantity: r.requiredQuantity, trackingType: (pd.trackingType) || bom.parts.find((x) => x.partNumber === r.partNumber).trackingType, optional: false, installationPosition: r.installationPosition }; });
    out.bomRevs.push({ _id: OID(), bom: b._id, vehicleModel: model, revision: "REV-A", effectiveDate: new Date(), status: "DRAFT", changeReason: "Loaded from BOM.xlsx (DRAFT - BOM not finalized; approve when final)", items });
    if (!ctx.existingVehicles.has(model)) {
      const vs = model === "BUZZ" ? [["BUZZ-0001", "UNDER_ASSEMBLY"], ["BUZZ-0002", "PLANNED"]] : model === "LITE" ? [["LITE-0001", "UNDER_ASSEMBLY"], ["LITE-0002", "PLANNED"]] : [["RETRO-0001", "PLANNED"]];
      for (const [num, st] of vs) { const v = { _id: OID(), vehicleNumber: num, model, vehicleType: model, project: "Pilot", currentBOMRevision: "REV-A", status: st }; v.qrCode = codes.vehiclePayload(v); out.vehicles.push(v); }
    }
  }

  /* ---- DEMO stock ---- */
  if (withDemoStock) {
    const rnd = rngFrom(20261006); const now = Date.now();
    const store = users.store, qc = users.qc;
    let grn = counters.receipt, txnN = counters.txn, qcN = counters.qc, ncrN = counters.ncr;
    const nextTxn = () => `TXN-${pad(++txnN, 7)}`;
    const stocked = out.parts.filter(() => rnd() > 0.12); // ~12% of parts have no stock at all (shows shortages against the BOM)
    const bySupplier = new Map(); for (const pd of stocked) { const sp = bom.parts.find((x) => x.partNumber === pd.partNumber); const s = supplierOf(sp); (bySupplier.get(s._id) || bySupplier.set(s._id, { s, parts: [] }).get(s._id)).parts.push(pd); }
    let invSeq = 0;
    for (const { s, parts } of bySupplier.values()) {
      for (let at = 0; at < parts.length; at += 25) {
        const chunk = parts.slice(at, at + 25); const when = now - Math.floor(5 + rnd() * 55) * DAY;
        const receiptNo = `GRN-${pad(++grn, 5)}`; const invoiceNo = `DEMO-INV-${s.code}-${pad(++invSeq, 3)}`;
        const receipt = { _id: OID(), receiptNo, supplier: s._id, invoiceNo, invoiceDate: new Date(when), status: "CLOSED", receivedBy: store.id, notes: "DEMO DATA - not a real receipt", lines: [], createdAt: new Date(when) };
        let line = 0;
        for (const pd of chunk) {
          line++; const low = rnd() < 0.10;
          const units = pd.trackingType === "SERIAL" ? (low ? 1 : 2 + Math.floor(rnd() * 4))
            : [pd.trackingType === "QUANTITY" ? (low ? 10 + Math.floor(rnd() * 30) : 60 + Math.floor(rnd() * 340)) : (low ? 2 + Math.floor(rnd() * 6) : 15 + Math.floor(rnd() * 65))];
          const list = pd.trackingType === "SERIAL" ? Array.from({ length: units }, (_, k) => ({ serialNumber: `SN-${pd.partNumber}-${pad(k + 1, 3)}`, quantity: 1 })) : [{ batchNumber: `LOT-${receiptNo}-${line}`, quantity: units[0] }];
          const ids = [];
          for (const u of list) {
            const roll = rnd(); const status = roll < 0.80 || roll >= 0.97 ? "APPROVED" : roll < 0.88 ? "PENDING_INCOMING_QC" : roll < 0.94 ? "HOLD" : "REJECTED";
            const it = { _id: OID(), part: pd._id, partNumber: pd.partNumber, partRevision: "REV-A", trackingType: pd.trackingType, ...u, status, receipt: receipt._id, supplier: s._id, invoiceNo, legacy: false, createdAt: new Date(when) };
            it.qrCode = codes.materialPayload(it, pd); ids.push(it._id);
            const tx = (type, from, to, fs, ts, reason, refType, refId, dt) => out.txns.push({ _id: OID(), transactionId: nextTxn(), transactionType: type, part: pd._id, partNumber: pd.partNumber, materialItem: it._id, serialNumber: it.serialNumber, batchNumber: it.batchNumber, quantity: u.quantity, fromLocation: from, toLocation: to, fromStatus: fs, toStatus: ts, user: (type.startsWith("QC") ? qc : store).id, userName: (type.startsWith("QC") ? qc : store).name, reason, referenceType: refType, referenceId: refId, timestamp: new Date(dt), createdAt: new Date(dt) });
            tx("RECEIPT", undefined, special.RECEIVING, null, "RECEIVED", `Received against invoice ${invoiceNo}`, "Receipt", receiptNo, when);
            let at_ = special.RECEIVING;
            if (status !== "PENDING_INCOMING_QC") {
              const result = status === "HOLD" ? "HOLD" : status === "REJECTED" ? "FAIL" : "PASS"; const inspectionId = `QC-${pad(++qcN, 6)}`;
              const q = { _id: OID(), inspectionId, materialItem: it._id, part: pd._id, serialNumber: it.serialNumber, batchNumber: it.batchNumber, inspectionType: "INCOMING", inspector: qc.id, inspectionDate: new Date(when + DAY), result, remarks: result === "PASS" ? "Visual and dimensional check OK (demo)" : result === "HOLD" ? "Awaiting supplier clarification (demo)" : "Damaged on arrival (demo)", quantity: u.quantity, reworkRequired: false, createdAt: new Date(when + DAY) };
              out.qcs.push(q); it.lastQc = q._id;
              const dest = status === "HOLD" ? special.QC_HOLD : status === "REJECTED" ? special.REJECT : special.RECEIVING;
              tx(status === "HOLD" ? "QC_HOLD" : status === "REJECTED" ? "QC_REJECTION" : "QC_APPROVAL", special.RECEIVING, dest, "PENDING_INCOMING_QC", status === "APPROVED" ? "APPROVED" : status, `INCOMING inspection ${inspectionId}: ${result}`, "QCInspection", inspectionId, when + DAY);
              at_ = dest;
              if (status === "REJECTED") out.ncrs.push({ _id: OID(), ncrNo: `NCR-${pad(++ncrN, 5)}`, materialItem: it._id, part: pd._id, partNumber: pd.partNumber, serialNumber: it.serialNumber, batchNumber: it.batchNumber, supplier: s._id, invoiceNo, inspectionId, quantity: u.quantity, defect: "Damaged on arrival (demo)", status: "OPEN", createdAt: new Date(when + DAY) });
              if (status === "APPROVED") { at_ = pd.defaultLocation; tx("PUT_AWAY", special.RECEIVING, pd.defaultLocation, "APPROVED", "APPROVED", "Put-away", "PutAway", receiptNo, when + DAY + 3600000); }
            }
            if (status === "APPROVED") it.status = "APPROVED";
            out.items.push(it); out.balances.push({ _id: OID(), materialItem: it._id, part: pd._id, location: at_, quantity: u.quantity, createdAt: new Date(when) });
          }
          receipt.lines.push({ part: pd._id, materialItems: ids, quantity: list.reduce((a, b) => a + b.quantity, 0) });
        }
        out.receipts.push(receipt);
      }
    }
    out.counterEnd = { receipt: grn, txn: txnN, qc: qcN, ncr: ncrN };
  }
  return out;
}

/* ---------------- assets ---------------- */
function buildAssets() {
  return assetData.assets.map((a) => { const d = { ...a }; delete d.sourceRow; if (d.purchaseDate) d.purchaseDate = new Date(d.purchaseDate + "T00:00:00Z"); else delete d.purchaseDate; if (d.totalAmount == null) delete d.totalAmount; d.status = "IN_USE"; return d; });
}

/* ---------------- validation (no database needed) ---------------- */
function validateAll(out, assets) {
  const pairs = [[M.Location, out.locations], [M.Supplier, out.suppliers], [M.PartMaster, out.parts], [M.PartRevision, out.revisions], [M.BOM, out.boms], [M.BOMRevision, out.bomRevs], [M.Vehicle, out.vehicles],
    [M.Receipt, out.receipts], [M.MaterialItem, out.items], [M.StockBalance, out.balances], [M.InventoryTransaction, out.txns], [M.QCInspection, out.qcs], [M.Ncr, out.ncrs], [M.CapitalAsset, assets]];
  const errors = [];
  for (const [Model, docs] of pairs) for (const d of docs) { const e = new Model(d).validateSync(); if (e) errors.push(`${Model.modelName}: ${Object.values(e.errors).map((x) => x.message).join("; ")} (${d.partNumber || d.assetNo || d.code || d.locationCode || d.vehicleNumber || d.receiptNo || d.transactionId || d._id})`); }
  // uniqueness the database would enforce
  const dup = (arr, f, what) => { const s = new Set(); for (const x of arr) { const k = f(x); if (s.has(k)) errors.push(`duplicate ${what}: ${k}`); s.add(k); } };
  dup(out.parts, (x) => x.partNumber, "partNumber"); dup(out.suppliers, (x) => x.code, "supplier code"); dup(out.items.filter((x) => x.serialNumber), (x) => `${x.partNumber}|${x.serialNumber}`, "serial"); dup(out.txns, (x) => x.transactionId, "transaction id"); dup(assets, (x) => x.assetNo, "assetNo");
  for (const bomRev of out.bomRevs) dup(bomRev.items, (x) => x.partNumber, `BOM item in ${bomRev.vehicleModel}`);
  return errors;
}

function summarize(out, assets) {
  const n = (a) => a.length; const st = {}; out.items.forEach((i) => (st[i.status] = (st[i.status] || 0) + 1));
  console.log(`  locations ${n(out.locations)} · suppliers ${n(out.suppliers)} · parts ${n(out.parts)} · BOMs ${n(out.boms)} (${out.bomRevs.map((b) => `${b.vehicleModel} ${b.items.length} lines`).join(", ")}) · vehicles ${n(out.vehicles)}`);
  console.log(`  DEMO stock: receipts ${n(out.receipts)} · stock items ${n(out.items)} ${JSON.stringify(st)} · transactions ${n(out.txns)} · QC records ${n(out.qcs)} · NCRs ${n(out.ncrs)}`);
  console.log(`  capital assets ${n(assets)}`);
}

/* ---------------- run ---------------- */
async function wipeDemo() {
  const receipts = await M.Receipt.find({ invoiceNo: /^DEMO-/ }).select("_id").lean(); const rid = receipts.map((r) => r._id);
  const items = await M.MaterialItem.find({ receipt: { $in: rid } }).select("_id").lean(); const iid = items.map((i) => i._id);
  const del = async (Model, filter) => (await Model.collection.deleteMany(filter)).deletedCount; // raw deletes: the ledger/QC collections are append-only for the app
  console.log("Removed demo data:", JSON.stringify({ transactions: await del(M.InventoryTransaction, { materialItem: { $in: iid } }), qc: await del(M.QCInspection, { materialItem: { $in: iid } }), ncr: await del(M.Ncr, { materialItem: { $in: iid } }),
    balances: await del(M.StockBalance, { materialItem: { $in: iid } }), items: await del(M.MaterialItem, { _id: { $in: iid } }), receipts: await del(M.Receipt, { _id: { $in: rid } }) }));
}

async function main() {
  const withDemoStock = !args.has("--no-demo-stock");
  if (args.has("--dry-run")) {
    const fake = () => OID();
    const user = (name) => ({ id: fake(), name });
    const out = build({ existingParts: new Set(), existingLocs: new Map(), existingSupplierCodes: new Set(), existingBoms: new Set(), existingVehicles: new Set(), partIdByNumber: new Map(), withDemoStock,
      special: { RECEIVING: fake(), QC_HOLD: fake(), REJECT: fake() }, users: { store: user("Store User"), qc: user("QC Inspector") }, counters: { receipt: 0, txn: 0, qc: 0, ncr: 0 } });
    const assets = buildAssets(); console.log("DRY RUN - nothing is written."); summarize(out, assets);
    const errors = validateAll(out, assets); if (errors.length) { console.log(`\n${errors.length} problem(s):`); errors.slice(0, 40).forEach((e) => console.log("  - " + e)); process.exit(1); }
    console.log("  validation: every record passes its schema, no duplicate keys."); return;
  }
  const config = require("../config"); const db = require("../db"); const bcrypt = require("bcryptjs"); const { ensureBaseData, backfillV3 } = require("./baseData");
  await db.connect(); await ensureBaseData();
  if (args.has("--wipe-demo")) { await wipeDemo(); return; }
  const existingPartCount = await M.PartMaster.estimatedDocumentCount();
  if (existingPartCount > 0 && !args.has("--force")) { console.log(`This database already has ${existingPartCount} parts. Use a fresh/test database, or add --force to load alongside (existing part numbers are skipped).`); process.exit(2); }

  // demo users (same list as `npm run seed`), unless disabled
  const demoUsers = [["Admin User", "admin@example.com", "admin"], ["Store User", "store@example.com", "store"], ["QC Inspector", "qc@example.com", "qc"], ["Assembly Operator", "assembly@example.com", "assembly"], ["Supervisor", "supervisor@example.com", "supervisor"], ["Engineer", "engineer@example.com", "engineer"]];
  const created = [];
  for (const [name, emailId, role] of (process.env.SEED_DEMO_USERS === "false" ? [] : demoUsers)) {
    if (await M.User.findOne({ emailId })) continue;
    const pw = process.env.SEED_DEMO_PASSWORD || (config.isProd ? require("crypto").randomBytes(9).toString("base64url") : "ChangeMe#2026");
    await M.User.create({ name, emailId, role, passwordHash: await bcrypt.hash(pw, config.bcryptRounds), mustChangePassword: config.isProd }); created.push({ emailId, role, password: pw });
  }
  const pickUser = async (role) => { const u = (await M.User.findOne({ role, active: { $ne: false } }).lean()) || (await M.User.findOne({ role: "admin" }).lean()) || (await M.User.findOne().lean()); return { id: u._id, name: u.name }; };
  const special = {}; for (const [k, type] of [["RECEIVING", "RECEIVING"], ["QC_HOLD", "QC_HOLD"], ["REJECT", "REJECT"]]) special[k] = (await M.Location.findOne({ type, active: true }).lean())._id;
  const reserve = async (name, n) => { const c = await M.Counter.findOneAndUpdate({ name }, { $inc: { seq: n } }, { new: true, upsert: true }); return c.seq - n; };
  const wantDemo = withDemoStock && !(await M.Receipt.exists({ invoiceNo: /^DEMO-/ }));
  const counters = wantDemo ? { receipt: await reserve("receipt", 0), txn: await reserve("txn", 0), qc: await reserve("qc", 0), ncr: await reserve("ncr", 0) } : { receipt: 0, txn: 0, qc: 0, ncr: 0 };
  const existingLocs = new Map((await M.Location.find().lean()).map((l) => [l.locationCode, l]));
  const out = build({ existingParts: new Set((await M.PartMaster.find().select("partNumber").lean()).map((p) => p.partNumber)), existingLocs,
    existingSupplierCodes: new Set((await M.Supplier.find().select("code").lean()).map((s) => s.code)), existingBoms: new Set((await M.BOM.find().select("vehicleModel").lean()).map((b) => b.vehicleModel)),
    existingVehicles: new Set((await M.Vehicle.find().select("model").lean()).map((v) => v.model)), partIdByNumber: new Map((await M.PartMaster.find().lean()).map((p) => [p.partNumber, p])), withDemoStock: wantDemo,
    special, users: { store: await pickUser("store"), qc: await pickUser("qc") }, counters });
  const assets = buildAssets(); summarize(out, assets);
  const errors = validateAll(out, assets); if (errors.length) { console.error("Nothing written. Problems:\n" + errors.slice(0, 30).join("\n")); process.exit(1); }

  const ins = async (Model, docs) => { if (docs.length) await Model.insertMany(docs, { ordered: true }); };
  await ins(M.Location, out.locations); await ins(M.Supplier, out.suppliers); await ins(M.PartMaster, out.parts); await ins(M.PartRevision, out.revisions);
  await ins(M.BOM, out.boms); await ins(M.BOMRevision, out.bomRevs); await ins(M.Vehicle, out.vehicles);
  await ins(M.Receipt, out.receipts); await ins(M.MaterialItem, out.items); await ins(M.StockBalance, out.balances); await ins(M.InventoryTransaction, out.txns); await ins(M.QCInspection, out.qcs); await ins(M.Ncr, out.ncrs);
  if (out.counterEnd) for (const [k, v] of Object.entries(out.counterEnd)) await M.Counter.updateOne({ name: k }, { $set: { seq: v } }, { upsert: true });
  const r = await M.CapitalAsset.bulkWrite(assets.map((a) => ({ updateOne: { filter: { assetNo: a.assetNo }, update: { $set: a }, upsert: true } })));
  await backfillV3(console.log);
  console.log(`Done. Capital assets: ${r.upsertedCount} added, ${r.modifiedCount} updated.`);
  if (created.length) { console.log("Demo accounts created:"); created.forEach((c) => console.log(`  ${c.role.padEnd(10)} ${c.emailId}  ${c.password}`)); }
}
module.exports = { build, buildAssets, validateAll, binFor };
if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
