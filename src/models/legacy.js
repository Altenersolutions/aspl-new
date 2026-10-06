// Legacy prototype collections. Collection names are unchanged so existing data and the
// existing frontend keep working. Only the User model was extended (hashed passwords).
const mongoose = require("mongoose");
const { VEHICLE_TYPES } = require("../domain/constants");

const vehiclesField = { type: [{ type: String, enum: VEHICLE_TYPES }], default: [] };
const cleanVehicles = (v) =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toUpperCase()))].filter((x) => VEHICLE_TYPES.includes(x)) : [];

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, required: true },
  emailId: { type: String, required: true },
  password: { type: String }, // LEGACY plain text. Cleared on first successful login (upgraded to passwordHash).
  passwordHash: { type: String },
  active: { type: Boolean, default: true },
  lastLogin: { type: Date, default: null },
  mustChangePassword: { type: Boolean, default: false },
  totpSecret: { type: String }, totpEnabled: { type: Boolean, default: false }, totpPending: { type: String },
  tokenVersion: { type: Number, default: 0 },
});
userSchema.index({ name: 1, emailId: 1 }, { unique: true });

const base = { partId: String, partName: String, specification: String, catagory: String, quantity: Number, SI: String, supplier: String, price: String, vehicles: vehiclesField };
const Bom = mongoose.model("InventoryBom", new mongoose.Schema({ ...base }));
const Dev = mongoose.model("InventoryDev", new mongoose.Schema({ ...base, department: String }));
const Con = mongoose.model("InventoryCon", new mongoose.Schema({ ...base }));
const Parts = mongoose.model("InventoryParts", new mongoose.Schema({ ...base, date: Date, location: String }));
const PartsIO = mongoose.model("InventoryPartsIO", new mongoose.Schema({
  partId: String, invoice: String, partName: String, specification: String, catagory: String, date: String, quantity: Number,
  SI: String, supplier: String, batchNo: String, IO: String, unitPrice: Number, price: Number, purchasedBy: String, location: String, note: String,
}));
const Incomming = mongoose.model("InventoryIncomming", new mongoose.Schema({
  partId: String, invoice: String, partName: String, specification: String, catagory: String, department: String, date: String,
  quantity: String, SI: String, supplier: String, batchNo: String, IO: Boolean, unitPrice: Number, status: String,
  quantityApprove: Number, quantityReject: Number, quantityRemaining: Number, quantityIssued: Number, price: Number,
  purchasedBy: String, location: String, sgst: String, cgst: String, igst: String, vehicles: vehiclesField,
}));
const Msg = mongoose.model("InventoryMsg", new mongoose.Schema({ from: String, to: String, subject: String, date: Date, description: String }));
const Counter = mongoose.model("InventoryCounter", new mongoose.Schema({ name: { type: String, required: true, unique: true }, seq: { type: Number, default: 0 } }));
const lastUpdate = (schema) => schema.add({ lastAction: String, lastUpdatedBy: String, lastUpdatedByName: String, lastUpdatedAt: Date });
const gpSchema = new mongoose.Schema({
  refNo: String, date: String, supplier: String, dispatchMode: String, returnable: Boolean, returnDate: String, remarks: String,
  items: [{ _id: false, name: String, partNumber: String, serialBatch: String, qty: String, uom: String }],
  preparedBy: String, issuedBy: String, receivedBy: String,
  createdBy: String, createdByName: String, status: { type: String, default: "ISSUED" },
  printCount: { type: Number, default: 0 }, lastPrintedAt: Date, lastPrintedByName: String,
  printLog: [{ _id: false, no: Number, at: Date, byId: String, byName: String, reprint: Boolean, reason: String }],
}, { timestamps: true });
lastUpdate(gpSchema);
const GatePass = mongoose.model("InventoryGatePass", gpSchema);
const ActivityLog = mongoose.model("InventoryActivityLog", new mongoose.Schema({
  userId: String, userName: String, role: String, action: String, itemType: String, itemLabel: String, path: String,
}, { timestamps: true }));
const User = mongoose.model("InventoryUser", userSchema);

module.exports = { lastUpdate, User, Bom, Dev, Con, Parts, PartsIO, Incomming, Msg, Counter, GatePass, ActivityLog, cleanVehicles };
