// Demo/bootstrap data. Idempotent. Never deletes anything.
//   npm run seed                      -> master data + demo users (passwords from env or printed once)
// Demo passwords are only created when the account doesn't exist yet.
const bcrypt = require("bcryptjs");
const config = require("../config");
const db = require("../db");
const M = require("../models");
const codes = require("../domain/codes");
const { locationPath } = require("../domain/locations");
const { ensureBaseData } = require("./baseData");

async function upsertLocation(code, name, type, parentCode, extra = {}) {
  let l = await M.Location.findOne({ locationCode: code });
  if (l) return l;
  const parent = parentCode ? await M.Location.findOne({ locationCode: parentCode }) : null;
  const data = { locationCode: code, name, type, ...extra };
  if (parent) Object.assign(data, { parentLocation: parent._id, store: parent.store, zone: parent.zone, rack: parent.rack, shelf: parent.shelf });
  const lvl = { STORE: "store", ZONE: "zone", RACK: "rack", SHELF: "shelf", BIN: "bin" }[type]; if (lvl) data[lvl] = name;
  l = await M.Location.create(data);
  l.path = await locationPath(l); l.qrCode = codes.locationPayload(l); await l.save();
  return l;
}
async function upsertPart(p) {
  let x = await M.PartMaster.findOne({ partNumber: p.partNumber });
  if (x) return x;
  const d = { ...p };
  if (p.bin) { const b = await M.Location.findOne({ locationCode: p.bin }); d.defaultLocation = b._id; delete d.bin; }
  x = await M.PartMaster.create(d);
  await M.PartRevision.create({ part: x._id, revision: x.currentRevision, status: "APPROVED", approvedAt: new Date(), changeReason: "Initial revision", effectiveDate: new Date() });
  return x;
}

async function seed({ quiet } = {}) {
  await ensureBaseData();
  // --- location hierarchy: Store > Zone > Rack > Shelf > Bin ---
  await upsertLocation("ES", "Electrical Store", "STORE");
  await upsertLocation("ES-Z1", "Electrical Zone 1", "ZONE", "ES");
  await upsertLocation("ES-Z1-CONN", "Connector Rack", "RACK", "ES-Z1");
  await upsertLocation("ES-Z1-RELAY", "Relay Rack", "RACK", "ES-Z1");
  await upsertLocation("ES-Z1-CTRL", "Controller Rack", "RACK", "ES-Z1");
  await upsertLocation("E-08", "E-08", "BIN", "ES-Z1-CONN", { allowedCategories: ["ELECTRICAL", "ELECTRONICS"], capacity: 5000 });
  await upsertLocation("E-12", "E-12", "BIN", "ES-Z1-RELAY", { allowedCategories: ["ELECTRICAL"], capacity: 2000 });
  await upsertLocation("E-20", "E-20", "BIN", "ES-Z1-CTRL", { allowedCategories: ["ELECTRONICS", "ELECTRICAL"] });
  await upsertLocation("MS", "Mechanical Store", "STORE");
  await upsertLocation("MS-Z1", "Mechanical Zone 1", "ZONE", "MS");
  await upsertLocation("MS-Z1-FAST", "Fastener Rack", "RACK", "MS-Z1");
  await upsertLocation("M-04", "M-04", "BIN", "MS-Z1-FAST", { allowedCategories: ["MECHANICAL", "CONSUMABLE"] });

  // --- supplier + parts ---
  if (!(await M.Supplier.findOne({ code: "ACME" }))) await M.Supplier.create({ code: "ACME", name: "Acme Components Pvt Ltd", contact: "Sales Desk", gstin: "29AAAAA0000A1Z5" });
  await upsertPart({ partNumber: "JST-8P-F", partName: "8-Pin JST Connector Female", category: "ELECTRICAL", trackingType: "BATCH", bin: "E-08", vehicleCompatibility: ["BUZZ", "LITE", "RETROFIT"], minStock: 100 });
  await upsertPart({ partNumber: "RELAY-001", partName: "Automotive Relay", category: "ELECTRICAL", trackingType: "BATCH", bin: "E-12", vehicleCompatibility: ["BUZZ", "LITE", "RETROFIT"], minStock: 50 });
  await upsertPart({ partNumber: "CTRL-001", partName: "Vehicle Control Unit", category: "ELECTRONICS", trackingType: "SERIAL", bin: "E-20", vehicleCompatibility: ["BUZZ", "RETROFIT"], currentRevision: "REV-B" });
  await upsertPart({ partNumber: "CTRL-LITE", partName: "Lite Control Unit", category: "ELECTRONICS", trackingType: "SERIAL", bin: "E-20", vehicleCompatibility: ["LITE"] });
  await upsertPart({ partNumber: "BOLT-M8", partName: "Bolt M8", category: "CONSUMABLE", trackingType: "QUANTITY", bin: "M-04", unit: "NOS", minStock: 200 });

  // --- BOMs (BUZZ REV-C requires CTRL-001 REV-C; RETROFIT REV-A accepts any revision) ---
  const part = async (n) => M.PartMaster.findOne({ partNumber: n });
  for (const model of ["BUZZ", "LITE", "RETROFIT"]) if (!(await M.BOM.findOne({ vehicleModel: model }))) await M.BOM.create({ vehicleModel: model, name: `${model} BOM` });
  const mkRev = async (model, revision, items, status = "APPROVED") => {
    const bom = await M.BOM.findOne({ vehicleModel: model });
    if (await M.BOMRevision.findOne({ bom: bom._id, revision })) return;
    const rows = []; for (const [pn, q, req] of items) { const p = await part(pn); rows.push({ part: p._id, partNumber: pn, requiredQuantity: q, requiredRevision: req, trackingType: p.trackingType, installationPosition: `${pn} position` }); }
    await M.BOMRevision.create({ bom: bom._id, vehicleModel: model, revision, effectiveDate: new Date(), status, approvedAt: new Date(), changeReason: "Seed", items: rows });
    if (status === "APPROVED") await M.BOM.updateOne({ _id: bom._id }, { $set: { currentRevision: revision } });
  };
  await mkRev("BUZZ", "REV-C", [["CTRL-001", 1, "REV-C"], ["RELAY-001", 2], ["JST-8P-F", 4], ["BOLT-M8", 8]]);
  await mkRev("LITE", "REV-A", [["CTRL-LITE", 1], ["RELAY-001", 1], ["BOLT-M8", 4]]);
  await mkRev("RETROFIT", "REV-A", [["CTRL-001", 1], ["JST-8P-F", 2]]);
  for (const [num, model] of [["BUZZ-0042", "BUZZ"], ["LITE-0012", "LITE"], ["RETRO-0007", "RETROFIT"]]) {
    if (await M.Vehicle.findOne({ vehicleNumber: num })) continue;
    const bom = await M.BOM.findOne({ vehicleModel: model });
    const v = await M.Vehicle.create({ vehicleNumber: num, model, vehicleType: model, project: "Pilot", currentBOMRevision: bom.currentRevision });
    v.qrCode = codes.vehiclePayload(v); await v.save();
  }

  // --- demo users ---
  const demo = [["Admin User", "admin@example.com", "admin"], ["Store User", "store@example.com", "store"], ["QC Inspector", "qc@example.com", "qc"], ["Assembly Operator", "assembly@example.com", "assembly"], ["Supervisor", "supervisor@example.com", "supervisor"], ["Engineer", "engineer@example.com", "engineer"]];
  const created = [];
  for (const [name, emailId, role] of (process.env.SEED_DEMO_USERS === "false" ? [] : demo)) {
    if (await M.User.findOne({ emailId })) continue;
    const pw = process.env.SEED_DEMO_PASSWORD || (config.isProd ? require("crypto").randomBytes(9).toString("base64url") : "ChangeMe#2026");
    await M.User.create({ name, emailId, role, passwordHash: await bcrypt.hash(pw, config.bcryptRounds), mustChangePassword: config.isProd });
    created.push({ emailId, role, password: pw });
  }
  if (!quiet && created.length) { console.log("Demo accounts created:"); created.forEach((c) => console.log(`  ${c.role.padEnd(10)} ${c.emailId}  ${c.password}`)); }
  return created;
}
module.exports = { seed };
if (require.main === module) db.connect().then(seed).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
