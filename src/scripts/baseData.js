// Idempotent: ensures the system locations the workflows depend on exist. Safe to run at every boot.
const { Location, User } = require("../models");
const bcrypt = require("bcryptjs");
const config = require("../config");
const codes = require("../domain/codes");

const SPECIAL = [
  ["RECEIVING", "Receiving Area", "RECEIVING"], ["QC-HOLD", "QC Hold Area", "QC_HOLD"], ["REJECT-AREA", "Rejection Area", "REJECT"],
  ["REWORK-AREA", "Rework Area", "REWORK"], ["WIP-FLOOR", "Work In Progress / Issued", "WIP"], ["IN-TRANSIT", "Handover In Transit", "TRANSIT"],
  ["ON-VEHICLE", "Installed On Vehicle", "VEHICLE"], ["SCRAP-YARD", "Scrap", "SCRAP"],
];
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
  if ((await User.estimatedDocumentCount()) === 0) console.log("No users exist. Create the first administrator with POST /users {name,emailId,password} or run `npm run seed`.");
}
module.exports = { ensureBaseData, SPECIAL };
