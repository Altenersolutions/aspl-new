// Idempotent: ensures the system locations the workflows depend on exist. Safe to run at every boot.
const { Location, User, PartMaster, Role } = require("../models");
const { defaultsFor, deriveClass } = require("../domain/partRules");
const { normalisePerms, invalidate } = require("../domain/permissions");
const bcrypt = require("bcryptjs");
const config = require("../config");
const codes = require("../domain/codes");

const SPECIAL = [
  ["RECEIVING", "Receiving Area", "RECEIVING"], ["QC-HOLD", "QC Hold Area", "QC_HOLD"], ["REJECT-AREA", "Rejection Area", "REJECT"],
  ["REWORK-AREA", "Rework Area", "REWORK"], ["WIP-FLOOR", "Work In Progress / Issued", "WIP"], ["IN-TRANSIT", "Handover In Transit", "TRANSIT"],
  ["ON-VEHICLE", "Installed On Vehicle", "VEHICLE"], ["SCRAP-YARD", "Scrap", "SCRAP"],
];
// v3 upgrade, idempotent and non-destructive: give existing parts an inventory class + explicit flags, and translate saved role permissions to the new names.
async function backfillV3(log = () => {}) {
  let parts = 0, roles = 0, stamped = 0;
  // .lean(): hydrated documents would apply the schema default (PRODUCTION) and hide that the field is missing.
  for (const p of await PartMaster.find({ inventoryClass: { $exists: false } }).lean()) {
    const cls = deriveClass(p); const patch = { ...defaultsFor({ ...p, inventoryClass: cls }), inventoryClass: cls };
    if (cls === "DEVELOPMENT" && !p.devStatus) patch.devStatus = "ACTIVE"; // already in use -> stays usable
    await PartMaster.updateOne({ _id: p._id }, { $set: patch }); parts++;
  }
  for (const p of await PartMaster.find({ inventoryClass: "DEVELOPMENT", devStatus: { $exists: false } }).lean()) { await PartMaster.updateOne({ _id: p._id }, { $set: { devStatus: "ACTIVE" } }); parts++; }
  for (const r of await Role.find().lean()) { const n = normalisePerms(r.permissions); if (JSON.stringify(n) !== JSON.stringify(r.permissions)) { await Role.updateOne({ _id: r._id }, { $set: { permissions: n } }); roles++; } }
  // Last Update for records that predate it: their creation is their latest known business action.
  const M = require("../models"); const L = require("../models/legacy");
  for (const [Model, action] of [[M.PartMaster, "PART_CREATED"], [M.Vehicle, "VEHICLE_CREATED"], [M.MaterialItem, "RECEIPT"], [M.Location, "LOCATION_CREATED"], [M.BOM, "BOM_CREATED"], [L.GatePass, "GATE_PASS_CREATED"], [M.Handover, "HANDOVER_CREATED"]]) {
    for (const d of await Model.find({ lastAction: { $exists: false } }).select("createdAt createdByName fromUserName").lean()) {
      await Model.updateOne({ _id: d._id }, { $set: { lastAction: action, lastUpdatedAt: d.createdAt || new Date(), lastUpdatedByName: d.createdByName || d.fromUserName || "" } }); stamped++;
    }
  }
  if (roles) invalidate();
  if (parts || roles || stamped) log(`Upgrade: ${parts} part(s) classified, ${roles} role(s) migrated to the new permission names, ${stamped} record(s) given a Last Update.`);
  return { parts, roles, stamped };
}

async function ensureBaseData() {
  for (const [code, name, type] of SPECIAL) {
    if (await Location.exists({ type, active: true })) continue;
    const l = await Location.create({ locationCode: code, name, type, path: name });
    l.qrCode = codes.locationPayload(l); await l.save();
  }
  // Hosts without a shell (Render free tier): create the first admin from env vars, only when no users exist.
  if ((await User.estimatedDocumentCount()) === 0 && config.bootstrapAdminEmail && config.bootstrapAdminPassword) {
    if (config.bootstrapAdminPassword.length < 8) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters");
    await User.create({ name: process.env.BOOTSTRAP_ADMIN_NAME || "Administrator", emailId: config.bootstrapAdminEmail, role: "admin", passwordHash: await bcrypt.hash(config.bootstrapAdminPassword, config.bcryptRounds) });
    console.log(`First administrator created: ${config.bootstrapAdminEmail}`);
  }
  await backfillV3(console.log);
  if ((await User.estimatedDocumentCount()) === 0) console.log("No users exist. Create the first administrator with POST /users {name,emailId,password} or run `npm run seed`.");
}
module.exports = { ensureBaseData, backfillV3, SPECIAL };
