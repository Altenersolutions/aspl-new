process.env.JWT_SECRET = "test-secret-1234567890-abcdef";
process.env.LOGIN_RATE_LIMIT = "1000";
process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const db = require("../src/db");
const { createApp } = require("../src/app");
const { seed } = require("../src/scripts/seed");
const M = require("../src/models");
const { atomic } = require("../src/domain/uow");

const PW = "ChangeMe#2026";
let app; const tok = {}; let supplierId; let stamp = Date.now();
const api = (method, url, user, body) => { let r = request(app)[method](url); if (user) r = r.set("Authorization", `Bearer ${tok[user]}`); return body ? r.send(body) : r; };
const login = async (email) => (await request(app).post("/login").send({ email, password: PW })).body.token;

// helpers ---------------------------------------------------------------
async function receive(partNumber, opts = {}) {
  const line = { partNumber, quantity: opts.quantity ?? 1, ...opts.line };
  const res = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: opts.invoiceNo ?? `INV-${stamp}-${Math.random().toString(36).slice(2, 7)}`, lines: [line] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { receiptId: res.body.receiptId, items: res.body.items };
}
const qc = (receiptId, itemId, result, remarks) => api("post", `/api/receiving/${receiptId}/qc`, "qc", { materialItemId: itemId, result, remarks });
async function approved(partNumber, opts = {}) { const r = await receive(partNumber, opts); const it = r.items[0]; if (it.status !== "APPROVED") { const q = await qc(r.receiptId, it.id, "PASS"); assert.equal(q.status, 200, JSON.stringify(q.body)); } return { ...it, receiptId: r.receiptId }; }
async function stored(partNumber, opts = {}) {
  const it = await approved(partNumber, opts);
  const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body;
  const r = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: `LOC|${plan.destination.code}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...it, bin: plan.destination.code };
}
const balanceAt = async (itemId, code) => { const loc = await M.Location.findOne({ locationCode: code }); const b = await M.StockBalance.findOne({ materialItem: itemId, location: loc._id }); return b ? b.quantity : 0; };

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_test_${stamp}`);
  await seed({ quiet: true });
  app = createApp();
  for (const [k, e] of Object.entries({ admin: "admin@example.com", store: "store@example.com", qc: "qc@example.com", assembly: "assembly@example.com", supervisor: "supervisor@example.com", engineer: "engineer@example.com" })) tok[k] = await login(e);
  supplierId = String((await M.Supplier.findOne({ code: "ACME" }))._id);
  // A production part that is NOT FIFO-controlled, so quantity/handover tests are not affected by older lots left by other tests.
  const np = await api("post", "/api/parts", "engineer", { partNumber: "NOFIFO-1", partName: "No-FIFO test relay", inventoryClass: "PRODUCTION", category: "ELECTRICAL", trackingType: "BATCH", defaultLocationCode: "E-12", fifoApplicable: false });
  assert.equal(np.status, 201, JSON.stringify(np.body));
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

// ---------------------------------------------------------------------------
test("T1 receiving -> QC -> approve -> put-away creates the full transaction chain", async () => {
  const r = await receive("RELAY-001", { quantity: 50, line: { batchNumber: "B-202609" }, invoiceNo: "INV-T1" });
  const it = r.items[0];
  assert.equal((await M.MaterialItem.findById(it.id)).status, "PENDING_INCOMING_QC");
  const q = await qc(r.receiptId, it.id, "PASS");
  assert.equal(q.body.status, "APPROVED");
  const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body;
  assert.equal(plan.destination.code, "E-12"); assert.match(plan.destination.path, /Electrical Store > .*Relay Rack > E-12/);
  const pa = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "E-12" });
  assert.equal(pa.status, 200); assert.equal(pa.body.message, "MATERIAL STORED");
  assert.equal(await balanceAt(it.id, "E-12"), 50); assert.equal(await balanceAt(it.id, "RECEIVING"), 0);
  const types = (await M.InventoryTransaction.find({ materialItem: it.id }).sort({ timestamp: 1, createdAt: 1 })).map((t) => t.transactionType);
  assert.deepEqual(types, ["RECEIPT", "QC_APPROVAL", "PUT_AWAY"]);
});

test("T2 missing invoice is blocked by the backend and nothing is created", async () => {
  const before = await M.MaterialItem.countDocuments();
  for (const invoiceNo of [undefined, "", "   "]) {
    const res = await api("post", "/api/receiving", "store", { supplierId, ...(invoiceNo !== undefined && { invoiceNo }), lines: [{ partNumber: "RELAY-001", quantity: 5, batchNumber: "B-X" }] });
    assert.equal(res.status, 400); assert.equal(res.body.error, "INVOICE_REQUIRED");
  }
  assert.equal(await M.MaterialItem.countDocuments(), before);
  const legacy = await api("post", "/Incomming", "store", { partId: "X", partName: "x" });
  assert.equal(legacy.status, 400); assert.equal(legacy.body.error, "INVOICE_REQUIRED");
});

test("T3 wrong location is blocked with required-vs-scanned details; non-admin cannot override", async () => {
  const it = await approved("JST-8P-F", { quantity: 100, line: { batchNumber: "B-JST-1" } });
  const res = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "LOC|M-04" });
  assert.equal(res.status, 409); assert.equal(res.body.error, "WRONG_LOCATION");
  assert.equal(res.body.details.required.code, "E-08"); assert.equal(res.body.details.scanned.code, "M-04");
  assert.equal(res.body.overridable, true);
  const sneaky = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "M-04", override: { reason: "just because", confirm: true } });
  assert.equal(sneaky.status, 403);
  assert.equal(await balanceAt(it.id, "RECEIVING"), 100); assert.equal(await balanceAt(it.id, "M-04"), 0);
});

test("T4 correct location completes the put-away (via location QR payload)", async () => {
  const it = await approved("JST-8P-F", { quantity: 20, line: { batchNumber: "B-JST-2" } });
  const chk = await api("post", "/api/locations/scan", "store", { code: "LOC|E-08", expected: "E-08" });
  assert.equal(chk.body.message, "CORRECT LOCATION");
  const bad = await api("post", "/api/locations/scan", "store", { code: "LOC|M-04", expected: "E-08" });
  assert.equal(bad.body.message, "WRONG LOCATION");
  const res = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "LOC|E-08" });
  assert.equal(res.status, 200); assert.equal(await balanceAt(it.id, "E-08"), 20);
  assert.equal(res.body.transaction.transactionType, "PUT_AWAY");
});

test("T5 QC HOLD: moved to hold area, cannot be issued, put-away or installed", async () => {
  const r = await receive("RELAY-001", { quantity: 10, line: { batchNumber: "B-HOLD" } });
  const q = await qc(r.receiptId, r.items[0].id, "HOLD", "Contact resistance borderline");
  assert.equal(q.body.status, "HOLD");
  assert.equal(await balanceAt(r.items[0].id, "QC-HOLD"), 10);
  const issue = await api("post", "/api/inventory/issue", "store", { materialItemId: r.items[0].id, quantity: 1, fromLocation: "QC-HOLD", purpose: "x" });
  assert.equal(issue.status, 409); assert.equal(issue.body.error, "MATERIAL_ON_HOLD");
  const pa = await api("post", `/api/materials/${r.items[0].id}/put-away`, "store", { scannedLocation: "E-12" });
  assert.equal(pa.body.error, "MATERIAL_ON_HOLD");
  assert.equal((await qc(r.receiptId, r.items[0].id, "FAIL")).status, 400); // remarks mandatory for FAIL
  const again = await qc(r.receiptId, r.items[0].id, "FAIL", "second look");
  assert.equal(again.status, 409); assert.equal(again.body.error, "QC_NOT_ALLOWED"); // INCOMING QC not valid from HOLD; must use RETEST
});

test("T6 QC rejection: rejected serial cannot be issued or installed", async () => {
  const r = await receive("CTRL-001", { line: { serialNumbers: ["SN-REJ-1"], revision: "REV-C" } });
  const q = await qc(r.receiptId, r.items[0].id, "FAIL", "Cracked housing");
  assert.equal(q.body.status, "REJECTED"); assert.equal(await balanceAt(r.items[0].id, "REJECT-AREA"), 1);
  const inst = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: r.items[0].id });
  assert.equal(inst.status, 409); assert.equal(inst.body.error, "MATERIAL_REJECTED");
  const iss = await api("post", "/api/inventory/issue", "store", { materialItemId: r.items[0].id, quantity: 1, fromLocation: "REJECT-AREA", purpose: "x" });
  assert.equal(iss.body.error, "MATERIAL_REJECTED");
  // rework -> retest -> approved path
  const rw = await api("post", `/api/materials/${r.items[0].id}/disposition`, "qc", { action: "REWORK", reason: "Replace housing" });
  assert.equal(rw.body.status, "REWORK");
  assert.equal((await api("post", `/api/materials/${r.items[0].id}/disposition`, "qc", { action: "REWORK_DONE", reason: "Housing replaced" })).body.status, "PENDING_RETEST");
  const rt = await api("post", "/api/qc/retest", "qc", { materialItemId: r.items[0].id, result: "PASS" });
  assert.equal(rt.body.status, "APPROVED"); assert.equal(await balanceAt(r.items[0].id, "RECEIVING"), 1);
  const hist = await M.QCInspection.find({ materialItem: r.items[0].id }).sort({ createdAt: 1 });
  assert.deepEqual(hist.map((h) => `${h.inspectionType}:${h.result}`), ["INCOMING:FAIL", "RETEST:PASS"]); assert.ok(hist[1].previousInspection);
});

test("T7 issue creates a transaction; negative stock and concurrent over-issue are prevented", async () => {
  const it = await stored("NOFIFO-1", { quantity: 40, line: { batchNumber: "B-ISS" } });
  const ok = await api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 10, fromLocation: "E-12", purpose: "Line 1" });
  assert.equal(ok.status, 200); assert.equal(ok.body.transaction.transactionType, "ISSUE");
  assert.equal(await balanceAt(it.id, "E-12"), 30); assert.equal(await balanceAt(it.id, "WIP-FLOOR"), 10);
  const over = await api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 500, fromLocation: "E-12", purpose: "x" });
  assert.equal(over.status, 409); assert.equal(over.body.error, "INSUFFICIENT_STOCK");
  const race = await Promise.all([1, 2].map(() => api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 20, fromLocation: "E-12", purpose: "race" })));
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
  assert.ok((await balanceAt(it.id, "E-12")) >= 0);
  assert.equal(await balanceAt(it.id, "E-12"), 10);
  const noQty = await api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: -3, fromLocation: "E-12", purpose: "x" });
  assert.equal(noQty.status, 400);
});

let assemblyUser;
test("T8 handover: issue -> handover -> recipient acknowledges", async () => {
  assemblyUser = String((await M.User.findOne({ emailId: "assembly@example.com" }))._id);
  const it = await stored("NOFIFO-1", { quantity: 10, line: { batchNumber: "B-HO" } });
  const h = await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 4, toUserId: assemblyUser, fromLocation: "E-12", purpose: "Harness build", department: "Assembly" });
  assert.equal(h.status, 201); assert.equal(h.body.status, "PENDING");
  assert.equal(await balanceAt(it.id, "IN-TRANSIT"), 4); assert.equal(await balanceAt(it.id, "E-12"), 6);
  const wrong = await api("post", `/api/handover/${h.body._id}/acknowledge`, "qc", {});
  assert.equal(wrong.status, 403); // not the recipient
  const ack = await api("post", `/api/handover/${h.body._id}/acknowledge`, "assembly", { note: "Counted 4" });
  assert.equal(ack.body.status, "ACKNOWLEDGED"); assert.equal(await balanceAt(it.id, "IN-TRANSIT"), 0); assert.equal(await balanceAt(it.id, "WIP-FLOOR"), 4);
  const rec = await M.Handover.findById(h.body._id); assert.ok(rec.acknowledgedAt);
  const again = await api("post", `/api/handover/${h.body._id}/acknowledge`, "assembly", {}); assert.equal(again.body.error, "HANDOVER_CLOSED");
});

test("T9 refusal requires a reason and returns stock to the source", async () => {
  const it = await stored("NOFIFO-1", { quantity: 10, line: { batchNumber: "B-REF" } });
  const h = await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 3, toUserId: assemblyUser, fromLocation: "E-12", purpose: "Test" });
  const noReason = await api("post", `/api/handover/${h.body._id}/refuse`, "assembly", {});
  assert.equal(noReason.status, 400); assert.equal(noReason.body.error, "REFUSAL_REASON_REQUIRED");
  assert.equal((await M.Handover.findById(h.body._id)).status, "PENDING"); assert.equal(await balanceAt(it.id, "IN-TRANSIT"), 3);
  const ok = await api("post", `/api/handover/${h.body._id}/refuse`, "assembly", { reason: "Wrong part variant" });
  assert.equal(ok.body.status, "REFUSED"); assert.equal(await balanceAt(it.id, "E-12"), 10);
  assert.equal((await M.Handover.findById(h.body._id)).refusalReason, "Wrong part variant");
});

let sn10042;
test("T10 vehicle installation with BOM + revision validation creates traceability", async () => {
  const it = await stored("CTRL-001", { line: { serialNumbers: ["SN-10042"], revision: "REV-C" } });
  sn10042 = it;
  const veh = await api("post", "/api/vehicles/scan", "assembly", { code: "VEH|BUZZ-0042" });
  assert.equal(veh.body.bomRevision.revision, "REV-C"); assert.ok(veh.body.items.find((i) => i.partNumber === "CTRL-001"));
  const pre = await api("post", "/api/vehicles/BUZZ-0042/check", "assembly", { materialItemId: it.id });
  assert.equal(pre.body.ok, true);
  const r = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.message, "INSTALLED");
  const m = await M.MaterialItem.findById(it.id); assert.equal(m.status, "INSTALLED");
  const inst = await M.Installation.findOne({ materialItem: it.id, active: true });
  assert.equal(inst.vehicleNumber, "BUZZ-0042"); assert.equal(inst.partRevision, "REV-C"); assert.equal(inst.bomRevision, "REV-C"); assert.equal(inst.installedByName, "Assembly Operator");
  assert.equal((await M.Vehicle.findOne({ vehicleNumber: "BUZZ-0042" })).status, "UNDER_ASSEMBLY");
  const dup = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id });
  assert.equal(dup.body.error, "DUPLICATE_INSTALLATION");
  const vt = (await api("get", "/api/traceability/vehicle/BUZZ-0042", "admin")).body;
  assert.equal(vt.installedComponents[0].serialNumber, "SN-10042");
  const ct = (await api("get", "/api/traceability/serial/SN-10042", "admin")).body;
  assert.equal(ct.installations[0].vehicleNumber, "BUZZ-0042"); assert.ok(ct.transactions.length >= 4); assert.equal(ct.receipt.invoiceNo.startsWith("INV-"), true);
});

test("T11 BOM mismatch blocks installation with a clear message", async () => {
  const it = await stored("CTRL-LITE", { line: { serialNumbers: ["SN-LITE-1"] } });
  const r = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id });
  assert.equal(r.status, 409); assert.equal(r.body.error, "INCOMPATIBLE_VEHICLE".length ? r.body.error : "");
  assert.ok(["INCOMPATIBLE_VEHICLE", "BOM_MISMATCH"].includes(r.body.error));
  assert.equal(r.body.overridable, true);
  assert.equal((await M.MaterialItem.findById(it.id)).status, "APPROVED"); assert.equal(await balanceAt(it.id, "E-20"), 1);
  const chk = await api("post", "/api/vehicles/BUZZ-0042/check", "assembly", { materialItemId: it.id });
  assert.match(chk.body.checks.find((c) => c.check === "ON_BOM").message, /BOM MISMATCH: CTRL-LITE is not valid for BUZZ BOM REV-C/);
});

test("T12 wrong-vehicle protection; admin override needs reason+confirm and preserves history", async () => {
  const blocked = await api("post", "/api/vehicles/RETRO-0007/install", "assembly", { materialItemId: sn10042.id });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "COMPONENT_ALREADY_ASSIGNED"); assert.match(blocked.body.message, /BUZZ-0042/);
  const nonAdmin = await api("post", "/api/vehicles/RETRO-0007/install", "assembly", { materialItemId: sn10042.id, override: { reason: "please let me", confirm: true } });
  assert.equal(nonAdmin.status, 403);
  const noReason = await api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: sn10042.id, override: { reason: "", confirm: true } });
  assert.equal(noReason.status, 400); assert.equal(noReason.body.error, "OVERRIDE_REASON_REQUIRED");
  const noConfirm = await api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: sn10042.id, override: { reason: "Moved to retrofit pilot" } });
  assert.equal(noConfirm.status, 400);
  assert.equal((await M.Installation.countDocuments({ materialItem: sn10042.id, active: true })), 1); // still only BUZZ
  const ok = await api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: sn10042.id, override: { reason: "Moved to retrofit pilot", confirm: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.overrideUsed, true);
  const all = await M.Installation.find({ materialItem: sn10042.id }).sort({ installedAt: 1 });
  assert.equal(all.length, 2); assert.equal(all[0].active, false); assert.ok(all[0].removedAt); assert.equal(all[0].vehicleNumber, "BUZZ-0042"); assert.equal(all[1].vehicleNumber, "RETRO-0007"); assert.equal(all[1].active, true);
  const ov = await M.OverrideRecord.findOne({ kind: "WRONG_VEHICLE" }); assert.ok(ov); assert.equal(ov.adminName, "Admin User"); assert.equal(ov.reason, "Moved to retrofit pilot");
  assert.ok(await M.AuditLog.findOne({ action: "OVERRIDE_WRONG_VEHICLE", override: true }));
  const txns = (await M.InventoryTransaction.find({ materialItem: sn10042.id, override: true })).map((t) => t.transactionType).sort();
  assert.deepEqual(txns, ["INSTALLATION", "REMOVAL"]);
});

test("T13 revision control: BOM REV-C requires CTRL-001 REV-C, REV-B unit is blocked (admin override allowed)", async () => {
  const it = await stored("CTRL-001", { line: { serialNumbers: ["SN-REVB-1"], revision: "REV-B" } });
  const bomRev = await M.BOMRevision.findOne({ vehicleModel: "BUZZ", revision: "REV-C" });
  assert.equal(bomRev.items.find((i) => i.partNumber === "CTRL-001").requiredRevision, "REV-C");
  await M.Installation.updateMany({ vehicleNumber: "BUZZ-0042", active: true }, { $set: {} }); // no-op; BUZZ slot is empty after T12 (quantity 1 available)
  const r = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id });
  assert.equal(r.status, 409); assert.equal(r.body.error, "REVISION_MISMATCH"); assert.match(r.body.message, /REV-C.*REV-B/);
  const ov = await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: it.id, override: { reason: "Engineering deviation ED-77", confirm: true } });
  assert.equal(ov.status, 200); const inst = await M.Installation.findOne({ materialItem: it.id, active: true });
  assert.equal(inst.partRevision, "REV-B"); assert.equal(inst.bomRequiredRevision, "REV-C"); assert.equal(inst.override, true);
  // approved BOM revisions are immutable; changes need a new revision
  const ap = await api("post", "/api/bom/BUZZ/revisions/REV-C/approve", "engineer");
  assert.equal(ap.status, 409);
});

test("T14 removal keeps installation history, creates REMOVAL transaction and routes to QC", async () => {
  const bad = await api("post", "/api/vehicles/BUZZ-0042/remove", "supervisor", { materialItemId: sn10042.id, reason: "x", disposition: "HOLD" });
  assert.equal(bad.body.error, "NOT_INSTALLED"); // installed on RETRO-0007 now
  const noAuth = await api("post", "/api/vehicles/RETRO-0007/remove", "assembly", { materialItemId: sn10042.id, reason: "Faulty CAN", disposition: "QC_REQUIRED" });
  assert.equal(noAuth.status, 403); // assembly operators cannot remove
  const noReason = await api("post", "/api/vehicles/RETRO-0007/remove", "supervisor", { materialItemId: sn10042.id, disposition: "QC_REQUIRED" });
  assert.equal(noReason.status, 400);
  const rm = await api("post", "/api/vehicles/RETRO-0007/remove", "supervisor", { materialItemId: sn10042.id, reason: "Faulty CAN transceiver", disposition: "QC_REQUIRED" });
  assert.equal(rm.status, 200, JSON.stringify(rm.body)); assert.equal(rm.body.status, "QC_REQUIRED");
  const rec = await M.Installation.find({ materialItem: sn10042.id }).sort({ installedAt: 1 });
  assert.equal(rec.length, 2); assert.ok(rec.every((r) => r.active === false && r.removedAt)); assert.equal(rec[1].removalReason, "Faulty CAN transceiver");
  assert.ok(await M.InventoryTransaction.findOne({ materialItem: sn10042.id, transactionType: "REMOVAL", vehicle: rec[1].vehicle, reason: "Faulty CAN transceiver" }));
  const m = await M.MaterialItem.findById(sn10042.id); assert.equal(m.status, "QC_REQUIRED"); assert.equal(m.installedOn ?? null, null);
  assert.equal(await balanceAt(sn10042.id, "QC-HOLD"), 1);
  const reinstall = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: sn10042.id });
  assert.equal(reinstall.body.error, "MATERIAL_NOT_APPROVED"); // must be re-qualified first
  const rt = await api("post", "/api/qc/retest", "qc", { materialItemId: sn10042.id, result: "PASS", remarks: "Transceiver replaced" });
  assert.equal(rt.body.status, "APPROVED");
});

test("T15 admin corrections need reason + confirm, are admin-only and fully audited", async () => {
  const it = await stored("RELAY-001", { quantity: 12, line: { batchNumber: "B-ADJ" } });
  assert.equal((await api("post", "/api/inventory/adjust", "store", { materialItemId: it.id, location: "E-12", newQuantity: 10, reason: "count", confirm: true })).status, 403);
  assert.equal((await api("post", "/api/inventory/adjust", "admin", { materialItemId: it.id, location: "E-12", newQuantity: 10, reason: "", confirm: true })).status, 400);
  assert.equal((await api("post", "/api/inventory/adjust", "admin", { materialItemId: it.id, location: "E-12", newQuantity: 10, reason: "Physical count short", confirm: false })).status, 400);
  const ok = await api("post", "/api/inventory/adjust", "admin", { materialItemId: it.id, location: "E-12", newQuantity: 10, reason: "Physical count short by 2", confirm: true });
  assert.equal(ok.status, 200); assert.equal(await balanceAt(it.id, "E-12"), 10);
  const neg = await api("post", "/api/inventory/adjust", "admin", { materialItemId: it.id, location: "E-12", newQuantity: -4, reason: "nonsense", confirm: true }); assert.equal(neg.status, 400);
  const a = await M.AuditLog.findOne({ action: "INVENTORY_ADJUSTMENT", reference: ok.body.transaction.transactionId });
  assert.deepEqual([a.before.quantity, a.after.quantity, a.reason, a.userName, a.override], [12, 10, "Physical count short by 2", "Admin User", true]);
  const so = await api("post", `/api/materials/${it.id}/status-override`, "admin", { toStatus: "HOLD", reason: "Supplier recall notice", confirm: true });
  assert.equal(so.body.status, "HOLD");
  assert.equal((await api("post", `/api/materials/${it.id}/status-override`, "qc", { toStatus: "APPROVED", reason: "trust me", confirm: true })).status, 403);
  assert.ok(await M.AuditLog.findOne({ action: "STATUS_OVERRIDE", entityId: String(it.id) }));
  const feed = (await api("get", "/api/audit?override=true", "admin")).body; assert.ok(feed.length >= 3);
  assert.equal((await api("get", "/api/audit", "store")).status, 403);
});

// ------------------------- engine / security / integrity tests -------------------------
test("scan engine: identifies material, location, vehicle, part and unknown codes and guides next action", async () => {
  const r = await receive("JST-8P-F", { quantity: 30, line: { batchNumber: "B-SCAN" } });
  let s = (await api("post", "/api/scan", "store", { code: r.items[0].qrCode })).body;
  assert.equal(s.kind, "MATERIAL"); assert.equal(s.part.partName, "8-Pin JST Connector Female"); assert.equal(s.item.status, "PENDING_INCOMING_QC"); assert.equal(s.next.action, "INCOMING_QC"); assert.ok(s.allowedActions.includes("INCOMING_QC"));
  await qc(r.receiptId, r.items[0].id, "PASS");
  s = (await api("post", "/api/scan", "store", { code: r.items[0].qrCode })).body;
  assert.equal(s.badge, "APPROVED"); assert.equal(s.next.action, "PUT_AWAY"); assert.equal(s.next.destination.code, "E-08"); assert.match(s.next.destination.path, /Connector Rack > E-08/);
  assert.equal((await api("post", "/api/scan", "store", { code: "LOC|E-08" })).body.kind, "LOCATION");
  assert.equal((await api("post", "/api/scan", "store", { code: "VEH|BUZZ-0042" })).body.kind, "VEHICLE");
  assert.equal((await api("post", "/api/scan", "store", { code: "B-SCAN" })).body.kind, "MATERIAL"); // raw batch barcode
  assert.equal((await api("post", "/api/scan", "store", { code: "BOLT-M8" })).body.kind, "PART");
  assert.equal((await api("post", "/api/scan", "store", { code: "???nothing" })).body.kind, "UNKNOWN");
});

test("state machine: illegal QC / status transitions are rejected server-side", async () => {
  const it = await stored("RELAY-001", { quantity: 5, line: { batchNumber: "B-SM" } });
  const r = await api("post", "/api/qc/incoming", "qc", { materialItemId: it.id, result: "PASS" });
  assert.equal(r.body.error, "QC_NOT_ALLOWED");
  const d = await api("post", `/api/materials/${it.id}/disposition`, "qc", { action: "REWORK", reason: "x" });
  assert.equal(d.body.error, "INVALID_STATE_TRANSITION");
  assert.equal((await api("put", `/api/materials/${it.id}`, "admin", { status: "APPROVED" })).status, 404); // no generic status editing route
});

test("tracking types: serial needs serials, batch needs batch, quantity-only gets auto lot; duplicates rejected", async () => {
  const bad1 = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "I1", lines: [{ partNumber: "CTRL-001", quantity: 2, serialNumbers: ["A"] }] }); assert.equal(bad1.status, 400);
  const bad2 = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "I1", lines: [{ partNumber: "RELAY-001", quantity: 2 }] }); assert.equal(bad2.status, 400);
  const q = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "I2", lines: [{ partNumber: "BOLT-M8", quantity: 500 }] });
  assert.equal(q.status, 201); assert.match(q.body.items[0].batchNumber, /^LOT-GRN-/); assert.equal(q.body.items[0].quantity, 500);
  const d1 = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "I3", lines: [{ partNumber: "CTRL-001", quantity: 1, serialNumbers: ["SN-DUP"] }] }); assert.equal(d1.status, 201);
  const d2 = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "I4", lines: [{ partNumber: "CTRL-001", quantity: 1, serialNumbers: ["SN-DUP"] }] }); assert.equal(d2.body.error, "DUPLICATE_SERIAL");
  const items = await M.MaterialItem.countDocuments({ invoiceNo: "I4" }); assert.equal(items, 0);
});

test("BOM quantity limit and quantity-only consumable installation", async () => {
  const it = await stored("BOLT-M8", { quantity: 20 });
  const a = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id, quantity: 6 }); assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id, quantity: 6 });
  assert.equal(b.status, 409); assert.equal(b.body.error, "QUANTITY_EXCEEDED");
  const c = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: it.id, quantity: 2 }); assert.equal(c.status, 200);
  assert.equal(await balanceAt(it.id, "ON-VEHICLE"), 8); assert.equal(await balanceAt(it.id, "M-04"), 12);
  const partial = await api("post", "/api/vehicles/BUZZ-0042/remove", "supervisor", { materialItemId: it.id, quantity: 1, reason: "Damaged thread", disposition: "HOLD" });
  assert.equal(partial.status, 200);
});

test("atomicity: a failure part-way through a unit of work rolls back earlier writes", async () => {
  const it = await stored("RELAY-001", { quantity: 9, line: { batchNumber: "B-ATOM" } });
  const item = await M.MaterialItem.findById(it.id); const ledger = require("../src/domain/ledger");
  const wip = await M.Location.findOne({ locationCode: "WIP-FLOOR" }); const bin = await M.Location.findOne({ locationCode: "E-12" });
  const txBefore = await M.InventoryTransaction.countDocuments(); const auditBefore = await M.AuditLog.countDocuments();
  await assert.rejects(atomic(async (ctx) => {
    await ledger.post(ctx, { id: undefined, name: "t" }, { type: "ISSUE", item, qty: 4, from: bin._id, to: wip._id });
    await require("../src/domain/audit").audit(ctx, { name: "t" }, { action: "X" });
    throw new Error("boom");
  }), /boom/);
  assert.equal(await balanceAt(it.id, "E-12"), 9); assert.equal(await balanceAt(it.id, "WIP-FLOOR"), 0);
  assert.equal(await M.InventoryTransaction.countDocuments(), txBefore); assert.equal(await M.AuditLog.countDocuments(), auditBefore);
});

test("append-only: ledger, audit, QC history and override records cannot be updated or deleted", async () => {
  await assert.rejects(M.InventoryTransaction.deleteMany({}), /append-only/);
  await assert.rejects(M.InventoryTransaction.updateOne({}, { $set: { quantity: 1 } }), /append-only/);
  await assert.rejects(M.AuditLog.deleteMany({}), /append-only/);
  await assert.rejects(M.AuditLog.findOneAndUpdate({}, { $set: { reason: "x" } }), /append-only/);
  await assert.rejects(M.QCInspection.updateOne({}, { $set: { result: "PASS" } }), /append-only/);
  await assert.rejects(M.OverrideRecord.deleteOne({}), /append-only/);
  const t = await M.InventoryTransaction.findOne(); t.quantity = 999; await assert.rejects(t.save(), /append-only/);
});

test("security: auth required, no open registration, hashed passwords, role checks server-side", async () => {
  assert.equal((await request(app).get("/api/dashboard")).status, 401);
  assert.equal((await request(app).get("/api/dashboard").set("Authorization", "Bearer garbage")).status, 403);
  assert.equal((await request(app).post("/users").send({ name: "x", emailId: "x@x.com", role: "admin", password: "Password#123" })).status, 401);
  assert.equal((await api("post", "/users", "store", { name: "x", emailId: "x@x.com", role: "admin", password: "Password#123" })).status, 403);
  assert.equal((await api("post", "/api/users", "admin", { name: "Weak", emailId: "weak@x.com", role: "store", password: "123" })).status, 400);
  const u = await M.User.findOne({ emailId: "store@example.com" }); assert.ok(u.passwordHash.startsWith("$2")); assert.equal(u.password, undefined);
  const list = (await api("get", "/users", "admin")).body; assert.ok(list.length >= 6); assert.ok(list.every((x) => x.password === undefined && x.passwordHash === undefined));
  assert.equal((await api("get", "/users", "store")).status, 403);
  assert.equal((await request(app).post("/login").send({ email: "admin@example.com", password: "wrong" })).status, 401);
  assert.equal((await request(app).post("/login").send({ email: { $ne: "" }, password: { $ne: "" } })).status, 400); // NoSQL-injection shaped body rejected by validation
  // frontend-supplied role/status are never trusted
  assert.equal((await api("post", "/api/inventory/adjust", "assembly", { materialItemId: "0".repeat(24), location: "E-12", newQuantity: 1, reason: "abcdef", confirm: true, role: "admin" })).status, 403);
  // cannot demote the last admin
  const admin = await M.User.findOne({ emailId: "admin@example.com" });
  assert.equal((await api("put", `/users/${admin._id}`, "admin", { role: "store" })).body.error, "LAST_ADMIN");
  assert.equal((await api("delete", `/users/${admin._id}`, "admin")).body.error, "SELF_DELETE");
});

test("legacy compatibility: plaintext legacy password upgrades to a hash on first login; legacy endpoints keep working", async () => {
  await M.User.create({ name: "Old Timer", emailId: "old@example.com", role: "store", password: "legacy-pass" });
  const res = await request(app).post("/login").send({ email: "old@example.com", password: "legacy-pass" });
  assert.equal(res.status, 200); assert.equal(res.body.message, "Old Timer"); assert.ok(res.body.token); assert.equal(res.body.role, "store");
  const doc = await M.User.findOne({ emailId: "old@example.com" }).lean(); assert.ok(doc.passwordHash); assert.equal(doc.password, undefined);
  const t = res.body.token;
  const add = await request(app).post("/bom").set("Authorization", `Bearer ${t}`).send({ partId: "LEG-1", partName: "Legacy part", catagory: "EE", quantity: 3, vehicles: ["buzz", "nope"] });
  assert.equal(add.status, 201); assert.deepEqual([...add.body.vehicles], ["BUZZ"]);
  assert.equal((await request(app).post("/bom").set("Authorization", `Bearer ${t}`).send({ partId: "LEG-1" })).status, 409);
  assert.equal((await request(app).get("/bom?vehicle=BUZZ").set("Authorization", `Bearer ${t}`)).body.length, 1);
  // legacy direct quantity edit: store role allowed but audited
  await request(app).post("/parts").set("Authorization", `Bearer ${t}`).send({ partId: "LEG-P", partName: "P", catagory: "EE", quantity: 5 });
  const q = await request(app).put("/parts-partid?partId=LEG-P").set("Authorization", `Bearer ${t}`).send({ quantity: 7 });
  assert.equal(q.body.quantity, 7); const a = await M.AuditLog.findOne({ action: "LEGACY_QUANTITY_EDIT", entityLabel: "LEG-P" }); assert.deepEqual([a.before.quantity, a.after.quantity], [5, 7]);
  assert.equal((await request(app).put("/parts-partid?partId=LEG-P").set("Authorization", `Bearer ${t}`).send({ quantity: -1 })).status, 400);
  assert.equal((await request(app).get("/activity-log").set("Authorization", `Bearer ${t}`)).status, 403); // admin only
  assert.ok((await api("get", "/activity-log", "admin")).body.length > 0);
});

test("dashboard and reports return operational data", async () => {
  const d = (await api("get", "/api/dashboard", "admin")).body;
  for (const k of ["totalInventory", "pendingIncomingQc", "approved", "hold", "rejected", "pendingHandovers", "awaitingPutAway", "lowStock", "vehiclesUnderAssembly", "reworkPending"]) assert.equal(typeof d.kpis[k], "number", k);
  assert.ok(d.recentTransactions.length && d.recentAudit.length);
  const tx = (await api("get", "/api/inventory/transactions?type=PUT_AWAY", "store")).body; assert.ok(tx.length && tx.every((t) => t.transactionType === "PUT_AWAY"));
  const s = (await api("get", "/api/materials?q=SN-10042", "store")).body; assert.equal(s.length, 1);
  const qrsvg = await api("get", `/api/qr?payload=${encodeURIComponent("LOC|E-08")}`, "store"); assert.match(qrsvg.headers["content-type"], /svg/);
});

test("migration: legacy data is mapped without inventing serials; legacy stock must be re-qualified; idempotent", async () => {
  const L = require("../src/models/legacy"); const mig = require("../src/scripts/migrateLegacy");
  await L.Parts.create({ partId: "old-relay", partName: "Old Relay", catagory: "EE", quantity: 25, supplier: "Legacy Supplier Co", vehicles: ["LITE"], location: "Shelf 3" });
  await L.Bom.create({ partId: "old-relay", partName: "Old Relay", catagory: "EE", quantity: 2, vehicles: ["LITE"] });
  await L.Incomming.create({ partId: "old-relay", partName: "Old Relay", quantity: "5" });
  const dry = await mig.run({ apply: false, log: () => {} }); assert.ok(dry.parts >= 1); assert.equal(await M.PartMaster.countDocuments({ partNumber: "OLD-RELAY" }), 0);
  await mig.run({ apply: true, log: () => {} });
  const again = await mig.run({ apply: true, log: () => {} });
  assert.equal(await M.PartMaster.countDocuments({ partNumber: "OLD-RELAY" }), 1); assert.equal(await M.MaterialItem.countDocuments({ partNumber: "OLD-RELAY", legacy: true }), 1);
  const item = await M.MaterialItem.findOne({ partNumber: "OLD-RELAY" }); assert.equal(item.status, "LEGACY_UNVERIFIED"); assert.equal(item.serialNumber, undefined); assert.equal(item.quantity, 25);
  assert.equal(await L.Parts.countDocuments({ partId: "old-relay" }), 1); // legacy row untouched
  assert.ok(again.warnings.some((w) => /no invoice/.test(w)));
  const issue = await api("post", "/api/inventory/issue", "store", { materialItemId: item.id, quantity: 1, fromLocation: "LEGACY-STOCK", purpose: "x" });
  assert.equal(issue.body.error, "MATERIAL_NOT_APPROVED");
  const rq = await api("post", `/api/materials/${item.id}/disposition`, "qc", { action: "REQUALIFY", reason: "Re-qualify legacy stock" }); assert.equal(rq.body.status, "PENDING_INCOMING_QC");
  assert.equal((await api("post", "/api/qc/incoming", "qc", { materialItemId: item.id, result: "PASS" })).body.status, "APPROVED");
  const rev = await M.BOMRevision.findOne({ vehicleModel: "LITE", revision: "LEGACY-A" }); assert.equal(rev.status, "DRAFT");
});
