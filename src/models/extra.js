const mongoose = require("mongoose");
const { Schema } = mongoose;
const C = require("../domain/constants");
const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });

const QcTemplate = mongoose.model("WmsQcTemplate", new Schema({
  part: { ...oid("WmsPart"), required: true },
  inspectionType: { type: String, enum: ["INCOMING", "COMPONENT", "IN_PROCESS", "FINAL", "RETEST"], required: true },
  parameters: [{ _id: false, parameter: { type: String, required: true }, kind: { type: String, enum: ["NUMERIC", "PASSFAIL", "TEXT"], default: "NUMERIC" }, unit: String, min: Number, max: Number, mandatory: { type: Boolean, default: true } }],
  updatedBy: oid("InventoryUser"),
}, { timestamps: true }));
QcTemplate.schema.index({ part: 1, inspectionType: 1 }, { unique: true });

const PurchaseOrder = mongoose.model("WmsPurchaseOrder", new Schema({
  poNo: { type: String, required: true, unique: true, uppercase: true, trim: true },
  supplier: { ...oid("WmsSupplier"), required: true },
  status: { type: String, enum: ["OPEN", "PARTIAL", "CLOSED", "CANCELLED"], default: "OPEN" },
  lines: [{ _id: false, part: oid("WmsPart"), partNumber: String, orderedQty: { type: Number, min: 1 }, receivedQty: { type: Number, default: 0 } }],
  expectedDate: Date, notes: String, createdBy: oid("InventoryUser"),
}, { timestamps: true }));

const Reservation = mongoose.model("WmsReservation", new Schema({
  kit: { ...oid("WmsKit"), required: true },
  materialItem: { ...oid("WmsMaterialItem"), required: true },
  part: oid("WmsPart"), partNumber: String,
  quantity: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["ACTIVE", "ISSUED", "RELEASED"], default: "ACTIVE" },
}, { timestamps: true }));
Reservation.schema.index({ materialItem: 1, status: 1 });

const Kit = mongoose.model("WmsKit", new Schema({
  kitId: { type: String, unique: true },
  vehicle: { ...oid("WmsVehicle"), required: true }, vehicleNumber: String, bomRevision: String,
  status: { type: String, enum: ["READY", "PARTIAL", "ISSUED", "CANCELLED"], default: "READY" },
  lines: [{ _id: false, part: oid("WmsPart"), partNumber: String, required: Number, reserved: Number, shortage: Number }],
  createdBy: oid("InventoryUser"), createdByName: String, issuedAt: Date, issuedBy: oid("InventoryUser"),
}, { timestamps: true }));

const CycleCount = mongoose.model("WmsCycleCount", new Schema({
  countId: { type: String, unique: true },
  location: { ...oid("WmsLocation"), required: true }, locationCode: String,
  status: { type: String, enum: ["OPEN", "SUBMITTED", "APPROVED", "CANCELLED"], default: "OPEN" },
  lines: [{ _id: false, materialItem: oid("WmsMaterialItem"), partNumber: String, serialNumber: String, batchNumber: String, systemQty: Number, countedQty: Number, variance: Number }],
  startedBy: oid("InventoryUser"), startedByName: String, submittedAt: Date, approvedBy: oid("InventoryUser"), approvedAt: Date, approvalNote: String,
}, { timestamps: true }));

const Ncr = mongoose.model("WmsNcr", new Schema({
  ncrNo: { type: String, unique: true },
  materialItem: oid("WmsMaterialItem"), part: oid("WmsPart"), partNumber: String, serialNumber: String, batchNumber: String,
  supplier: oid("WmsSupplier"), invoiceNo: String, inspectionId: String, quantity: Number,
  defect: String,
  status: { type: String, enum: ["OPEN", "DISPOSITIONED", "CLOSED"], default: "OPEN" },
  disposition: { type: String, enum: ["REWORK", "RETURN_TO_SUPPLIER", "SCRAP", "USE_AS_IS"] },
  rmaNo: String,
  capa: { rootCause: String, correctiveAction: String, preventiveAction: String, owner: String, dueDate: Date },
  raisedBy: oid("InventoryUser"), closedAt: Date, closedBy: oid("InventoryUser"),
}, { timestamps: true }));

const Eco = mongoose.model("WmsEco", new Schema({
  ecoNo: { type: String, unique: true },
  part: { ...oid("WmsPart"), required: true }, partNumber: String,
  fromRevision: String, toRevision: { type: String, required: true }, reason: String,
  status: { type: String, enum: ["DRAFT", "APPROVED", "REJECTED"], default: "DRAFT" },
  impact: Schema.Types.Mixed,
  requestedBy: oid("InventoryUser"), decidedBy: oid("InventoryUser"), decidedAt: Date, decisionNote: String,
}, { timestamps: true }));

const FileBlob = mongoose.model("WmsFile", new Schema({
  name: String, mime: String, size: Number, data: Buffer, uploadedBy: oid("InventoryUser"),
}, { timestamps: true }));

module.exports = { QcTemplate, PurchaseOrder, Reservation, Kit, CycleCount, Ncr, Eco, FileBlob };
