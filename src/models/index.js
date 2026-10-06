const mongoose = require("mongoose");
const { Schema } = mongoose;
const C = require("../domain/constants");
const legacy = require("./legacy");
const extra = require("./extra");
const { Kit } = extra;

const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });
const { lastUpdate } = legacy;
// Any schema declared with { lastUpdate: true } gets the "last meaningful business action" fields.
mongoose.plugin((schema) => { if (schema.options.lastUpdate) lastUpdate(schema); });

// Blocks updates/deletes on append-only collections (ledger, audit, QC history).
function appendOnly(schema, name) {
  const deny = function () { throw new Error(`${name} is append-only: updates and deletes are not permitted`); };
  ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove"].forEach((op) => schema.pre(op, deny));
  schema.pre("save", function (next) { if (!this.isNew) return next(new Error(`${name} is append-only`)); next(); });
  schema.pre("deleteOne", { document: true, query: false }, deny);
}

const Role = mongoose.model("WmsRole", new Schema({
  name: { type: String, required: true, unique: true, lowercase: true, trim: true },
  label: String,
  permissions: [String],
  system: { type: Boolean, default: false },
}, { timestamps: true }));

const Supplier = mongoose.model("WmsSupplier", new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  contact: String, phone: String, email: String, gstin: String, address: String,
  active: { type: Boolean, default: true },
}, { timestamps: true }));

const Location = mongoose.model("WmsLocation", new Schema({
  locationCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  type: { type: String, enum: C.LOCATION_TYPES, required: true },
  parentLocation: oid("WmsLocation"),
  store: String, zone: String, rack: String, shelf: String, bin: String,
  path: String, // human readable "Electrical Store > Connector Rack > E-08"
  qrCode: String, // payload encoded in the location QR
  active: { type: Boolean, default: true },
  allowedCategories: [String], // empty = any
  allowedPartTypes: [String],  // tracking types; empty = any
  capacity: Number,            // max total quantity, optional
}, { timestamps: true, lastUpdate: true }));

const PartMaster = mongoose.model("WmsPart", new Schema({
  partNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
  partName: { type: String, required: true },
  description: String,
  category: { type: String, enum: C.CATEGORIES, required: true },
  subCategory: String,
  materialType: String,
  unit: { type: String, default: "NOS" },
  trackingType: { type: String, enum: C.TRACKING, required: true },
  defaultLocation: oid("WmsLocation"),
  storageRule: { // used when defaultLocation is unset or full: first matching active BIN wins
    store: String, zone: String, rack: String,
  },
  supplier: oid("WmsSupplier"),
  vehicleCompatibility: [{ type: String, enum: C.VEHICLE_TYPES }],
  // inventoryClass = WHAT KIND of stock (GENERAL / PRODUCTION / DEVELOPMENT); trackingType = HOW it is counted (SERIAL / BATCH / QUANTITY).
  inventoryClass: { type: String, enum: C.INVENTORY_CLASSES, default: "PRODUCTION" },
  revisionControlled: Boolean, qcRequired: Boolean, fifoApplicable: Boolean, bomControlled: Boolean, // undefined => derived from class (see partRules)
  devStatus: { type: String, enum: C.DEV_STATUS }, devReviewNote: String, // development components only
  currentRevision: { type: String, default: "REV-A" },
  minStock: { type: Number, default: 0 },
  unitCost: Number, sourcing: String, // sourcing: Proprietary / Local / Inhouse (from the BOM sheet)
  active: { type: Boolean, default: true },
  legacy: { source: String, legacyId: String }, // provenance of migrated records
}, { timestamps: true, lastUpdate: true }));

const PartRevision = mongoose.model("WmsPartRevision", new Schema({
  part: { ...oid("WmsPart"), required: true },
  revision: { type: String, required: true },
  drawingNumber: String, specification: String, effectiveDate: Date,
  status: { type: String, enum: ["DRAFT", "APPROVED", "OBSOLETE"], default: "DRAFT" },
  changeReason: String, approvedBy: oid("InventoryUser"), approvedAt: Date,
}, { timestamps: true }));
PartRevision.schema.index({ part: 1, revision: 1 }, { unique: true });

const Vehicle = mongoose.model("WmsVehicle", new Schema({
  vehicleNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
  vin: { type: String, sparse: true, unique: true, uppercase: true },
  model: { type: String, required: true },         // BOM model key, e.g. BUZZ
  vehicleType: { type: String, required: true },   // BUZZ / LITE / RETROFIT / future
  project: String,
  currentBOMRevision: String,
  status: { type: String, enum: ["PLANNED", "UNDER_ASSEMBLY", "ASSEMBLED", "FINAL_QC", "RELEASED", "SCRAPPED"], default: "PLANNED" },
  qrCode: String,
}, { timestamps: true, lastUpdate: true }));

const BOM = mongoose.model("WmsBom", new Schema({
  vehicleModel: { type: String, required: true, unique: true, uppercase: true },
  name: String,
  currentRevision: String,
}, { timestamps: true, lastUpdate: true }));

const BOMRevision = mongoose.model("WmsBomRevision", new Schema({
  bom: { ...oid("WmsBom"), required: true },
  vehicleModel: { type: String, required: true, uppercase: true },
  revision: { type: String, required: true },
  effectiveDate: Date,
  status: { type: String, enum: ["DRAFT", "APPROVED", "OBSOLETE"], default: "DRAFT" },
  approvedBy: oid("InventoryUser"), approvedAt: Date, changeReason: String,
  items: [{
    _id: false,
    part: { ...oid("WmsPart"), required: true },
    partNumber: String,
    requiredQuantity: { type: Number, required: true, min: 1 },
    requiredRevision: String, // null/undefined = any approved revision
    trackingType: { type: String, enum: C.TRACKING },
    optional: { type: Boolean, default: false },
    installationPosition: String,
  }],
}, { timestamps: true, lastUpdate: true }));
BOMRevision.schema.index({ bom: 1, revision: 1 }, { unique: true });

const Receipt = mongoose.model("WmsReceipt", new Schema({
  receiptNo: { type: String, unique: true },
  supplier: { ...oid("WmsSupplier"), required: true },
  invoiceNo: { type: String, required: true, trim: true },
  invoiceDate: Date, poNo: String,
  status: { type: String, enum: ["RECEIVED", "QC_IN_PROGRESS", "CLOSED"], default: "RECEIVED" },
  receivedBy: oid("InventoryUser"),
  notes: String,
  lines: [{ _id: false, part: oid("WmsPart"), materialItems: [oid("WmsMaterialItem")], quantity: Number }],
}, { timestamps: true }));
Receipt.schema.index({ supplier: 1, invoiceNo: 1 });

// One document per serialised unit, or per batch/lot (BATCH and QUANTITY tracking).
const MaterialItem = mongoose.model("WmsMaterialItem", new Schema({
  part: { ...oid("WmsPart"), required: true },
  partNumber: String,
  partRevision: String,
  trackingType: { type: String, enum: C.TRACKING, required: true },
  serialNumber: { type: String },
  batchNumber: { type: String },   // batch/lot number (auto-generated for QUANTITY tracked)
  quantity: { type: Number, required: true, min: 0 }, // total qty of this item (1 for serials)
  status: { type: String, enum: Object.values(C.MS), required: true },
  receipt: oid("WmsReceipt"),
  supplier: oid("WmsSupplier"),
  invoiceNo: String,
  installedOn: oid("WmsVehicle"),   // set only while INSTALLED (serial items)
  lastQc: oid("WmsQcInspection"),
  legacy: { type: Boolean, default: false }, // tracking data unknown / migrated
  legacyNote: String,
  qrCode: String,
}, { timestamps: true, lastUpdate: true }));
MaterialItem.schema.index({ part: 1, serialNumber: 1 }, { unique: true, partialFilterExpression: { serialNumber: { $type: "string" } } });
MaterialItem.schema.index({ part: 1, batchNumber: 1, supplier: 1, invoiceNo: 1 });

// Projection of the ledger: quantity of a material item at a location.
const StockBalance = mongoose.model("WmsStockBalance", new Schema({
  materialItem: { ...oid("WmsMaterialItem"), required: true },
  part: oid("WmsPart"),
  location: { ...oid("WmsLocation"), required: true },
  quantity: { type: Number, required: true, min: 0 },
  holder: oid("InventoryUser"), // custody for WIP / TRANSIT pools
}, { timestamps: true }));
StockBalance.schema.index({ materialItem: 1, location: 1 }, { unique: true });

const QCInspection = (() => {
  const s = new Schema({
    inspectionId: { type: String, unique: true },
    materialItem: oid("WmsMaterialItem"), // omitted for vehicle-level in-process/final inspections
    part: oid("WmsPart"),
    serialNumber: String, batchNumber: String,
    inspectionType: { type: String, enum: ["INCOMING", "COMPONENT", "IN_PROCESS", "FINAL", "RETEST"], required: true },
    vehicle: oid("WmsVehicle"),
    inspector: oid("InventoryUser"),
    inspectionDate: { type: Date, default: Date.now },
    result: { type: String, enum: ["PASS", "FAIL", "HOLD"], required: true },
    remarks: String,
    measurements: [{ _id: false, parameter: String, value: String, unit: String, spec: String, pass: Boolean }],
    attachments: [{ _id: false, name: String, url: String }],
    reworkRequired: { type: Boolean, default: false },
    previousInspection: oid("WmsQcInspection"),
    quantity: Number,
  }, { timestamps: { createdAt: true, updatedAt: false } });
  appendOnly(s, "QCInspection");
  return mongoose.model("WmsQcInspection", s);
})();

const InventoryTransaction = (() => {
  const s = new Schema({
    transactionId: { type: String, unique: true },
    transactionType: { type: String, enum: C.TXN, required: true },
    part: oid("WmsPart"), partNumber: String,
    materialItem: oid("WmsMaterialItem"),
    serialNumber: String, batchNumber: String,
    quantity: { type: Number, required: true },
    fromLocation: oid("WmsLocation"), toLocation: oid("WmsLocation"),
    fromStatus: String, toStatus: String,
    vehicle: oid("WmsVehicle"),
    user: oid("InventoryUser"), userName: String,
    reason: String,
    referenceType: String, referenceId: String,
    override: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
  }, { timestamps: { createdAt: true, updatedAt: false } });
  s.index({ timestamp: -1 });
  appendOnly(s, "InventoryTransaction");
  return mongoose.model("WmsTransaction", s);
})();

const Handover = mongoose.model("WmsHandover", (() => { const hs = new Schema({
  handoverId: { type: String, unique: true },
  materialItem: { ...oid("WmsMaterialItem"), required: true },
  part: oid("WmsPart"), partNumber: String,
  serialNumber: String, batchNumber: String,
  quantity: { type: Number, required: true, min: 1 },
  fromUser: oid("InventoryUser"), toUser: oid("InventoryUser"),
  fromUserName: String, toUserName: String,
  fromLocation: oid("WmsLocation"),
  department: String, purpose: { type: String, required: true },
  status: { type: String, enum: ["PENDING", "ACKNOWLEDGED", "REFUSED"], default: "PENDING" },
  handedOverAt: { type: Date, default: Date.now },
  acknowledgedAt: Date, refusedAt: Date,
  refusalReason: String,
  acknowledgementNote: String,
}, { timestamps: true }); lastUpdate(hs); return hs; })());

// Permanent record. Removal closes it (removedAt) but never deletes it.
const Installation = mongoose.model("WmsInstallation", new Schema({
  vehicle: { ...oid("WmsVehicle"), required: true },
  vehicleNumber: String,
  materialItem: { ...oid("WmsMaterialItem"), required: true },
  part: oid("WmsPart"), partNumber: String,
  serialNumber: String, batchNumber: String,
  quantity: { type: Number, required: true },
  partRevision: String,          // revision actually installed
  bomRevision: String,           // BOM revision applicable at install time
  bomRequiredRevision: String,
  installationPosition: String,
  installedBy: oid("InventoryUser"), installedByName: String,
  installedAt: { type: Date, default: Date.now },
  installTransaction: oid("WmsTransaction"),
  override: { type: Boolean, default: false },
  removedAt: Date, removedBy: oid("InventoryUser"), removalReason: String,
  removeTransaction: oid("WmsTransaction"),
  removalDisposition: String,
  splitFrom: oid("WmsInstallation"),
  active: { type: Boolean, default: true },
}, { timestamps: true }));
Installation.schema.index({ vehicle: 1, active: 1 });
Installation.schema.index({ materialItem: 1, active: 1 });

const AuditLog = (() => {
  const s = new Schema({
    at: { type: Date, default: Date.now },
    user: oid("InventoryUser"), userName: String, role: String,
    action: { type: String, required: true },
    entityType: String, entityId: String, entityLabel: String,
    where: String, // location / vehicle / endpoint context
    reason: String,
    before: Schema.Types.Mixed, after: Schema.Types.Mixed,
    reference: String,
    override: { type: Boolean, default: false },
  });
  s.index({ at: -1 });
  appendOnly(s, "AuditLog");
  return mongoose.model("WmsAudit", s);
})();

const OverrideRecord = (() => {
  const s = new Schema({
    kind: { type: String, required: true }, // WRONG_LOCATION, BOM_MISMATCH, WRONG_VEHICLE, ...
    blockedCode: String,
    admin: oid("InventoryUser"), adminName: String,
    reason: { type: String, required: true },
    originalValue: Schema.Types.Mixed, newValue: Schema.Types.Mixed,
    referenceTransaction: String,
    operation: String,
    at: { type: Date, default: Date.now },
  });
  appendOnly(s, "OverrideRecord");
  return mongoose.model("WmsOverride", s);
})();

const Setting = mongoose.model("WmsSetting", new Schema({ key: { type: String, unique: true }, value: Schema.Types.Mixed }, { timestamps: true }));


// Development component images: one row per upload, tied to a revision. Never updated or deleted, so earlier revisions keep their pictures.
const PartImage = (() => {
  const s = new Schema({ part: { ...oid("WmsPart"), required: true }, partNumber: String, revision: { type: String, required: true }, file: { ...oid("WmsFile"), required: true }, name: String, mime: String, caption: String, uploadedBy: oid("InventoryUser"), uploadedByName: String, uploadedAt: { type: Date, default: Date.now } });
  s.index({ part: 1, revision: 1, uploadedAt: -1 }); appendOnly(s, "PartImage"); return mongoose.model("WmsPartImage", s);
})();

module.exports = {
  PartImage, ...legacy, ...extra, Role, Supplier, Location, PartMaster, PartRevision, Vehicle, BOM, BOMRevision, Receipt, MaterialItem,
  StockBalance, QCInspection, InventoryTransaction, Handover, Installation, AuditLog, OverrideRecord, Setting,
};
