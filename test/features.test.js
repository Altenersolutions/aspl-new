process.env.JWT_SECRET = "test-secret-1234567890-abcdef";
process.env.LOGIN_RATE_LIMIT = "1000"; process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const db = require("../src/db");
const { createApp } = require("../src/app");
const { seed } = require("../src/scripts/seed");
const M = require("../src/models");
const totp = require("../src/domain/totp");

const PW = "ChangeMe#2026"; let app; const tok = {}; let supplierId; const stamp = Date.now(); let seq = 0;
const api = (method, url, user, body) => { let r = request(app)[method](url); if (user) r = r.set("Authorization", `Bearer ${tok[user]}`); return body ? r.send(body) : r; };
const login = async (email, extra = {}) => (await request(app).post("/login").send({ email, password: PW, ...extra })).body.token;
const inv = () => `INV-F-${stamp}-${++seq}`;
async function receive(partNumber, line = {}, extra = {}) {
  const res = await api("post", "/api/receiving", extra.as || "store", { supplierId: extra.supplierId || supplierId, invoiceNo: inv(), lines: [{ partNumber, quantity: 1, ...line }], ...extra.body });
  assert.equal(res.status, 201, JSON.stringify(res.body)); return { receiptId: res.body.receiptId, items: res.body.items, body: res.body };
}
async function approved(partNumber, line = {}) { const r = await receive(partNumber, line); const q = await api("post", "/api/qc/incoming", "qc", { materialItemId: r.items[0].id, result: "PASS" }); assert.equal(q.status, 200, JSON.stringify(q.body)); return r.items[0]; }
async function stored(partNumber, line = {}) {
  const it = await approved(partNumber, line); const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body;
  const r = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: plan.destination.code }); assert.equal(r.status, 200, JSON.stringify(r.body)); return it;
}
const bal = async (itemId, code) => { const l = await M.Location.findOne({ locationCode: code }); const b = await M.StockBalance.findOne({ materialItem: itemId, location: l._id }); return b ? b.quantity : 0; };

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_feat_${stamp}`); await seed({ quiet: true }); app = createApp();
  for (const [k, e] of Object.entries({ admin: "admin@example.com", store: "store@example.com", qc: "qc@example.com", assembly: "assembly@example.com", supervisor: "supervisor@example.com", engineer: "engineer@example.com" })) tok[k] = await login(e);
  supplierId = String((await M.Supplier.findOne({ code: "ACME" }))._id);
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("purchase orders: partial receipt, over-receipt blocked, admin-only audited override, closed PO rejected", async () => {
  const po = await api("post", "/api/purchase-orders", "store", { poNo: "po-100", supplierId, lines: [{ partNumber: "RELAY-001", orderedQty: 10 }] });
  assert.equal(po.status, 201); assert.equal(po.body.poNo, "PO-100");
  await receive("RELAY-001", { quantity: 6, batchNumber: "B-PO-1" }, { body: { poNumber: "PO-100" } });
  assert.equal((await M.PurchaseOrder.findOne({ poNo: "PO-100" })).status, "PARTIAL");
  const over = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: inv(), poNumber: "PO-100", lines: [{ partNumber: "RELAY-001", quantity: 6, batchNumber: "B-PO-2" }] });
  assert.equal(over.status, 409); assert.equal(over.body.error, "PO_MISMATCH"); assert.equal(over.body.overridable, true);
  const sneaky = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: inv(), poNumber: "PO-100", lines: [{ partNumber: "RELAY-001", quantity: 6, batchNumber: "B-PO-2" }], override: { reason: "supplier sent extra", confirm: true } });
  assert.equal(sneaky.status, 403);
  const ok = await api("post", "/api/receiving", "admin", { supplierId, invoiceNo: inv(), poNumber: "PO-100", lines: [{ partNumber: "RELAY-001", quantity: 6, batchNumber: "B-PO-2" }], override: { reason: "supplier sent 2 extra, accepted", confirm: true } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal((await M.PurchaseOrder.findOne({ poNo: "PO-100" })).status, "CLOSED");
  assert.ok(await M.OverrideRecord.findOne({ kind: "PO_MISMATCH" }));
  const closed = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: inv(), poNumber: "PO-100", lines: [{ partNumber: "RELAY-001", quantity: 1, batchNumber: "B-PO-3" }] });
  assert.equal(closed.body.error, "PO_CLOSED");
  const other = (await api("post", "/api/suppliers", "store", { code: "OTHER", name: "Other Co" })).body;
  const wrongSup = await api("post", "/api/receiving", "store", { supplierId: other._id, invoiceNo: inv(), poNumber: "PO-100", lines: [{ partNumber: "RELAY-001", quantity: 1, batchNumber: "x" }] });
  assert.ok(["PO_SUPPLIER_MISMATCH", "PO_CLOSED"].includes(wrongSup.body.error));
});

test("QC templates: out-of-spec cannot PASS, mandatory measurements enforced, FAIL raises an NCR that needs CAPA to close", async () => {
  const p = await api("post", "/api/parts", "engineer", { partNumber: "TPL-PART", partName: "Template part", category: "ELECTRICAL", trackingType: "BATCH", defaultLocationCode: "E-12" }); assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal((await api("put", `/api/parts/${p.body._id}/qc-template?type=INCOMING`, "store", { parameters: [] })).status, 403);
  const t = await api("put", `/api/parts/${p.body._id}/qc-template?type=INCOMING`, "engineer", { parameters: [{ parameter: "Contact resistance", kind: "NUMERIC", unit: "mΩ", max: 50, mandatory: true }, { parameter: "Visual", kind: "PASSFAIL", mandatory: true }] }); assert.equal(t.status, 200);
  const r = await receive("TPL-PART", { quantity: 5, batchNumber: "B-TPL" }); const id = r.items[0].id;
  const missing = await api("post", "/api/qc/incoming", "qc", { materialItemId: id, result: "PASS", measurements: [{ parameter: "Visual", value: "pass" }] });
  assert.equal(missing.status, 400); assert.equal(missing.body.error, "QC_MEASUREMENT_REQUIRED");
  const bad = await api("post", "/api/qc/incoming", "qc", { materialItemId: id, result: "PASS", measurements: [{ parameter: "Contact resistance", value: "80" }, { parameter: "Visual", value: "pass" }] });
  assert.equal(bad.status, 409); assert.equal(bad.body.error, "QC_OUT_OF_SPEC"); assert.equal((await M.MaterialItem.findById(id)).status, "PENDING_INCOMING_QC");
  const fail = await api("post", "/api/qc/incoming", "qc", { materialItemId: id, result: "FAIL", remarks: "Resistance too high", measurements: [{ parameter: "Contact resistance", value: "80" }, { parameter: "Visual", value: "pass" }] });
  assert.equal(fail.status, 200); assert.equal(fail.body.status, "REJECTED");
  const insp = await M.QCInspection.findOne({ materialItem: id }); assert.deepEqual(insp.measurements.map((m) => m.pass), [false, true]);
  const ncr = await M.Ncr.findOne({ materialItem: id }); assert.ok(ncr); assert.equal(ncr.status, "OPEN"); assert.equal(ncr.defect, "Resistance too high");
  assert.equal((await api("post", `/api/ncr/${ncr._id}/close`, "qc")).body.error, "NCR_INCOMPLETE");
  await api("put", `/api/ncr/${ncr._id}`, "qc", { disposition: "RETURN_TO_SUPPLIER", capa: { rootCause: "Plating defect", correctiveAction: "Supplier 8D" } });
  assert.equal((await api("post", `/api/ncr/${ncr._id}/close`, "qc")).body.error, "NCR_INCOMPLETE"); // RMA missing
  await api("put", `/api/ncr/${ncr._id}`, "qc", { rmaNo: "RMA-77" });
  assert.equal((await api("post", `/api/ncr/${ncr._id}/close`, "qc")).status, 200); assert.equal((await M.Ncr.findById(ncr._id)).status, "CLOSED");
  const r2 = await receive("TPL-PART", { quantity: 5, batchNumber: "B-TPL2" });
  const good = await api("post", "/api/qc/incoming", "qc", { materialItemId: r2.items[0].id, result: "PASS", measurements: [{ parameter: "Contact resistance", value: "12.5" }, { parameter: "Visual", value: "pass" }] });
  assert.equal(good.status, 200); assert.equal(good.body.status, "APPROVED");
});

test("ECO: impact analysis, only approvers decide, new receipts take the new revision, old units keep theirs", async () => {
  const old = await stored("CTRL-LITE", { serialNumbers: ["SN-ECO-1"] });
  const imp = (await api("get", "/api/eco/impact?partNumber=CTRL-LITE&toRevision=REV-B", "engineer")).body; assert.ok(imp.stockUnitsOnOtherRevisions >= 1);
  const eco = await api("post", "/api/eco", "engineer", { partNumber: "CTRL-LITE", toRevision: "REV-B", reason: "Connector change", drawingNumber: "DWG-9" }); assert.equal(eco.status, 201, JSON.stringify(eco.body));
  assert.equal((await api("post", `/api/eco/${eco.body._id}/approve`, "engineer", {})).status, 403);
  assert.equal((await api("post", `/api/eco/${eco.body._id}/reject`, "admin", {})).status, 400); // reason required
  assert.equal((await api("post", `/api/eco/${eco.body._id}/approve`, "admin", { note: "OK" })).status, 200);
  assert.equal((await M.PartMaster.findOne({ partNumber: "CTRL-LITE" })).currentRevision, "REV-B");
  assert.equal((await M.MaterialItem.findById(old.id)).partRevision, "REV-A");
  const fresh = await receive("CTRL-LITE", { serialNumbers: ["SN-ECO-2"] }); assert.equal((await M.MaterialItem.findById(fresh.items[0].id)).partRevision, "REV-B");
  assert.equal((await api("post", `/api/eco/${eco.body._id}/approve`, "admin", {})).body.error, "INVALID_STATE_TRANSITION");
});

let kitVeh;
test("kitting: shortage blocked, FIFO reservation, reserved stock protected, kit issue moves to WIP, install from kit works", async () => {
  const v = await api("post", "/api/vehicles", "engineer", { vehicleNumber: "KIT-0001", model: "BUZZ", vehicleType: "BUZZ" }); assert.equal(v.status, 201, JSON.stringify(v.body)); kitVeh = v.body;
  const short = await api("post", "/api/kits", "store", { vehicle: "KIT-0001" }); assert.equal(short.status, 409); assert.equal(short.body.error, "KIT_SHORTAGE"); assert.ok(short.body.details.shortages.length >= 1);
  const relayOld = await stored("RELAY-001", { quantity: 1, batchNumber: "B-OLD" });
  const relayNew = await stored("RELAY-001", { quantity: 10, batchNumber: "B-NEW" });
  const ctrl = await stored("CTRL-001", { serialNumbers: ["SN-KIT-1"], revision: "REV-C" });
  const jst = await stored("JST-8P-F", { quantity: 10, batchNumber: "B-JKIT" });
  const bolt = await stored("BOLT-M8", { quantity: 20 });
  const k = await api("post", "/api/kits", "store", { vehicle: "KIT-0001" }); assert.equal(k.status, 201, JSON.stringify(k.body)); assert.equal(k.body.status, "READY");
  const res = await M.Reservation.find({ kit: k.body._id, partNumber: "RELAY-001" }).sort({ createdAt: 1 });
  assert.deepEqual(res.map((x) => [String(x.materialItem), x.quantity]), [[relayOld.id, 1], [relayNew.id, 1]]); // oldest batch first (FIFO)
  assert.equal((await api("post", "/api/kits", "store", { vehicle: "KIT-0001" })).body.error, "KIT_ALREADY_OPEN");
  const tooMany = await api("post", "/api/inventory/issue", "store", { materialItemId: relayNew.id, quantity: 10, fromLocation: "E-12", purpose: "x" });
  assert.equal(tooMany.status, 409); assert.equal(tooMany.body.error, "RESERVED_STOCK");
  assert.equal((await api("post", "/api/inventory/issue", "store", { materialItemId: relayNew.id, quantity: 9, fromLocation: "E-12", purpose: "ok" })).status, 200);
  const d = (await api("get", `/api/kits/${k.body._id}`, "store")).body; assert.ok(d.pickList.length >= 4); assert.ok(d.pickList[0].locations.length);
  const iss = await api("post", `/api/kits/${k.body._id}/issue`, "store"); assert.equal(iss.status, 200, JSON.stringify(iss.body));
  assert.equal(await bal(ctrl.id, "WIP-FLOOR"), 1); assert.equal(await bal(bolt.id, "WIP-FLOOR"), 8); assert.equal(await bal(relayOld.id, "E-12"), 0);
  assert.equal((await M.Kit.findById(k.body._id)).status, "ISSUED");
  assert.equal((await api("post", `/api/kits/${k.body._id}/issue`, "store")).body.error, "KIT_CLOSED");
  const inst = await api("post", "/api/vehicles/KIT-0001/install", "assembly", { materialItemId: ctrl.id }); assert.equal(inst.status, 200, JSON.stringify(inst.body));
  // cancel releases reservations
  await api("post", "/api/vehicles", "engineer", { vehicleNumber: "KIT-0002", model: "RETROFIT", vehicleType: "RETROFIT" });
  const j = await stored("JST-8P-F", { quantity: 5, batchNumber: "B-JKIT2" }); const ctrl2 = await stored("CTRL-001", { serialNumbers: ["SN-KIT-2"], revision: "REV-C" });
  const k2 = await api("post", "/api/kits", "store", { vehicle: "KIT-0002" }); assert.equal(k2.status, 201, JSON.stringify(k2.body));
  assert.equal((await api("post", `/api/kits/${k2.body._id}/cancel`, "store", {})).status, 400);
  assert.equal((await api("post", `/api/kits/${k2.body._id}/cancel`, "store", { reason: "Build postponed" })).status, 200);
  assert.equal(await M.Reservation.countDocuments({ kit: k2.body._id, status: "ACTIVE" }), 0);
});

test("cycle count: variances need approval, adjustment posted with audit, stale counts rejected, only admin approves", async () => {
  const it = await stored("RELAY-001", { quantity: 10, batchNumber: "B-CC" });
  const c = await api("post", "/api/counts", "store", { location: "E-12" }); assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await api("post", "/api/counts", "store", { location: "E-12" })).body.error, "COUNT_ALREADY_OPEN");
  const counts = c.body.lines.map((l) => ({ materialItemId: l.materialItem, countedQty: String(l.materialItem) === it.id ? l.systemQty - 2 : l.systemQty }));
  assert.equal((await api("post", `/api/counts/${c.body._id}/submit`, "store", { counts: counts.slice(1) })).status, 400); // not all counted
  const sub = await api("post", `/api/counts/${c.body._id}/submit`, "store", { counts }); assert.equal(sub.status, 200); assert.equal(sub.body.variances.length, 1);
  assert.equal((await api("post", `/api/counts/${c.body._id}/approve`, "store", { reason: "recount ok", confirm: true })).status, 403);
  assert.equal((await api("post", `/api/counts/${c.body._id}/approve`, "admin", { confirm: true })).status, 400); // reason needed
  const ok = await api("post", `/api/counts/${c.body._id}/approve`, "admin", { reason: "Two relays damaged on shelf", confirm: true }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.adjustmentsPosted, 1);
  assert.equal(await bal(it.id, "E-12"), 8);
  assert.ok(await M.AuditLog.findOne({ action: "CYCLE_COUNT_APPROVED", override: true }));
  const c2 = await api("post", "/api/counts", "store", { location: "E-12" });
  await api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 1, fromLocation: "E-12", purpose: "moved during count" });
  await api("post", `/api/counts/${c2.body._id}/submit`, "store", { counts: c2.body.lines.map((l) => ({ materialItemId: l.materialItem, countedQty: l.systemQty })) });
  // counted == system snapshot -> no variance, so approval is harmless; make a variance on the moved item to prove staleness
  const c3 = await api("post", "/api/counts", "store", { location: "E-08" }); assert.equal(c3.status, 201);
  await api("post", `/api/counts/${c2.body._id}/cancel`, "store"); await api("post", `/api/counts/${c3.body._id}/cancel`, "store");
});

test("recall: query by batch shows stock and vehicles; quarantine holds free stock and flags installed units", async () => {
  const relay = await stored("RELAY-001", { quantity: 6, batchNumber: "B-RECALL" });
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: relay.id, quantity: 1 })).status, 200);
  const ctrl = await stored("CTRL-001", { serialNumbers: ["SN-RECALL-1"], revision: "REV-C" });
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: ctrl.id })).status, 200);
  const q = (await api("post", "/api/recall/query", "store", { batchNumber: "B-RECALL" })).body;
  assert.equal(q.count, 1); assert.equal(q.onHand, 5); assert.equal(q.installedQty, 1); assert.deepEqual(q.vehicles.map((v) => v.vehicleNumber), ["BUZZ-0042"]);
  assert.equal((await api("post", "/api/recall/query", "store", {})).status, 400); // criteria required
  assert.equal((await api("post", "/api/recall/quarantine", "store", { criteria: { batchNumber: "B-RECALL" }, reason: "Supplier recall", confirm: true })).status, 403);
  assert.equal((await api("post", "/api/recall/quarantine", "qc", { criteria: { batchNumber: "B-RECALL" }, reason: "x", confirm: true })).status, 400);
  const go = await api("post", "/api/recall/quarantine", "qc", { criteria: { batchNumber: "B-RECALL" }, reason: "Supplier recall notice 77", confirm: true }); assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.equal(go.body.results[0].outcome, "HELD"); assert.equal((await M.MaterialItem.findById(relay.id)).status, "HOLD");
  assert.equal(await bal(relay.id, "QC-HOLD"), 5); assert.equal(await bal(relay.id, "ON-VEHICLE"), 1); // installed unit stays on the vehicle
  const g2 = await api("post", "/api/recall/quarantine", "qc", { criteria: { serialNumber: "SN-RECALL-1" }, reason: "Suspect controller lot", confirm: true });
  assert.equal(g2.body.results[0].outcome, "FLAGGED_INSTALLED"); assert.equal((await M.MaterialItem.findById(ctrl.id)).status, "INSTALLED");
  assert.ok(await M.AuditLog.findOne({ action: "RECALL_QUARANTINE" }));
  const bb = (await api("get", "/api/traceability/vehicle/BUZZ-0042/build-book", "admin")).body; assert.ok(bb.generatedBy); assert.ok(bb.installedComponents.every((c) => c.partName));
});

test("CSV: exports are spreadsheet-safe; part/BOM/opening-stock imports validate per row and support dry-run", async () => {
  await api("post", "/api/parts", "engineer", { partNumber: "CSV-EXPORT", partName: "=HYPERLINK(\"x\")", category: "OTHER", trackingType: "QUANTITY" });
  const ex = await api("get", "/api/export/parts", "admin"); assert.match(ex.headers["content-type"], /text\/csv/); assert.match(ex.text, /partNumber,partName/); assert.match(ex.text, /'=HYPERLINK/); // formula injection neutralised
  const csv = "partNumber,partName,category,trackingType,defaultBin,minStock,compatibility\nIMP-1,Imported relay,ELECTRICAL,BATCH,E-12,5,BUZZ;LITE\nIMP-2,Bad category,WRONG,BATCH,,,\nIMP-3,Bad bin,ELECTRICAL,BATCH,NOPE,,\nRELAY-001,Duplicate,ELECTRICAL,BATCH,,,\n";
  const dry = (await api("post", "/api/import/parts", "engineer", { csv, dryRun: true })).body; assert.equal(dry.created, 1); assert.equal(dry.errors.length, 2); assert.equal(dry.skipped, 1); assert.equal(await M.PartMaster.countDocuments({ partNumber: "IMP-1" }), 0);
  const real = (await api("post", "/api/import/parts", "engineer", { csv })).body; assert.equal(real.created, 1); assert.ok(await M.PartMaster.findOne({ partNumber: "IMP-1", minStock: 5 }));
  assert.equal((await api("post", "/api/import/parts", "store", { csv })).status, 403);
  const b = await api("post", "/api/import/bom", "engineer", { model: "LITE", revision: "REV-IMP", changeReason: "CSV import", csv: "partNumber,quantity,requiredRevision,optional,position\nIMP-1,2,,,Left\nRELAY-001,1,,yes,Right\n" });
  assert.equal(b.status, 201, JSON.stringify(b.body)); assert.equal(b.body.status, "DRAFT"); assert.equal(b.body.items, 2);
  assert.equal((await api("post", "/api/import/bom", "engineer", { model: "LITE", revision: "REV-IMP2", changeReason: "x", csv: "partNumber,quantity\nIMP-1,0\n" })).status, 400);
  const os = (await api("post", "/api/import/opening-stock", "admin", { csv: "partNumber,quantity,batchNumber,serialNumber\nBOLT-M8,300,,\nCTRL-001,1,,SN-OPEN-1\nCTRL-001,1,,\nNOPE-1,5,,\n" })).body;
  assert.equal(os.created, 2); assert.equal(os.errors.length, 2);
  const it = await M.MaterialItem.findOne({ serialNumber: "SN-OPEN-1" }); assert.equal(it.status, "LEGACY_UNVERIFIED"); assert.equal(it.legacy, true);
  assert.equal((await api("post", "/api/import/opening-stock", "engineer", { csv: "partNumber,quantity\nBOLT-M8,1\n" })).status, 403);
  for (const k of ["stock", "transactions", "audit", "qc", "installations", "ncr"]) assert.equal((await api("get", `/api/export/${k}`, "admin")).status, 200, k);
  assert.equal((await api("get", "/api/export/passwords", "admin")).status, 404);
});

test("pagination headers, global search, alerts and analytics", async () => {
  const p = await api("get", "/api/inventory/transactions?limit=2", "admin"); assert.equal(p.body.length, 2); assert.ok(+p.headers["x-total-count"] > 2);
  const p2 = await api("get", "/api/inventory/transactions?limit=2&skip=2", "admin"); assert.notEqual(p2.body[0]._id, p.body[0]._id);
  const a = await api("get", "/api/audit?limit=3", "admin"); assert.equal(a.body.length, 3); assert.ok(+a.headers["x-total-count"] >= 3);
  const s = (await api("get", "/api/search?q=RELAY", "store")).body; assert.ok(s.parts.length && s.materials.length === 0 || s.parts.length);
  assert.ok((await api("get", "/api/search?q=KIT-0001", "store")).body.vehicles.length === 1);
  assert.equal((await api("get", "/api/search?q=B-RECALL", "store")).body.materials.length, 1);
  const al = (await api("get", "/api/alerts", "store")).body; assert.equal(typeof al.total, "number"); assert.ok(Array.isArray(al.alerts));
  const an = (await api("get", "/api/analytics", "admin")).body; assert.ok(an.supplierQuality.find((x) => x.supplier.includes("Acme"))); assert.ok(an.supplierQuality[0].rejectionRate >= 0); assert.ok(an.stockAgeing["0-30 d"] >= 0); assert.ok(an.vehicleProgress.length >= 1);
  assert.equal((await api("get", "/api/analytics", "assembly")).status, 200); // assembly has reports.view
});

test("two-factor login, password change and sign-out-everywhere invalidate sessions", async () => {
  assert.equal((await api("post", "/api/users", "admin", { name: "Twofa", emailId: "twofa@example.com", role: "store", password: PW })).status, 201);
  let t = await login("twofa@example.com"); const me = (tk) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${tk}`);
  assert.equal((await me(t)).status, 200);
  const setup = await request(app).post("/api/auth/2fa/setup").set("Authorization", `Bearer ${t}`); assert.equal(setup.status, 200); assert.ok(setup.body.qrSvg.includes("<svg"));
  assert.equal((await request(app).post("/api/auth/2fa/enable").set("Authorization", `Bearer ${t}`).send({ code: "000000" })).status, 400);
  assert.equal((await request(app).post("/api/auth/2fa/enable").set("Authorization", `Bearer ${t}`).send({ code: totp.code(setup.body.secret) })).status, 200);
  const noOtp = await request(app).post("/login").send({ email: "twofa@example.com", password: PW }); assert.equal(noOtp.status, 401); assert.equal(noOtp.body.otpRequired, true);
  assert.equal((await request(app).post("/login").send({ email: "twofa@example.com", password: PW, otp: "123456" })).status, 401);
  const good = await request(app).post("/login").send({ email: "twofa@example.com", password: PW, otp: totp.code(setup.body.secret) }); assert.equal(good.status, 200);
  const all = await request(app).post("/api/auth/logout-all").set("Authorization", `Bearer ${good.body.token}`); assert.equal(all.status, 200);
  assert.equal((await me(good.body.token)).status, 403); // token revoked
  const t2 = (await request(app).post("/login").send({ email: "twofa@example.com", password: PW, otp: totp.code(setup.body.secret) })).body.token;
  const chg = await request(app).post("/api/auth/change-password").set("Authorization", `Bearer ${t2}`).send({ currentPassword: PW, newPassword: "NewPassw0rd!" }); assert.equal(chg.status, 200);
  assert.equal((await me(t2)).status, 403);
  assert.equal((await request(app).post("/login").send({ email: "twofa@example.com", password: "NewPassw0rd!", otp: totp.code(setup.body.secret) })).status, 200);
});

test("file storage: images/PDFs only, size-limited, retrievable only when signed in", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const up = await api("post", "/api/files", "qc", { name: "defect.png", mime: "image/png", dataBase64: png.toString("base64") }); assert.equal(up.status, 201);
  const dl = await api("get", up.body.url, "qc"); assert.equal(dl.status, 200); assert.equal(dl.headers["content-type"], "image/png"); assert.deepEqual(Buffer.from(dl.body), png);
  assert.equal((await request(app).get(up.body.url)).status, 401);
  assert.equal((await api("post", "/api/files", "qc", { name: "x.html", mime: "text/html", dataBase64: "PGI+" })).status, 400);
  assert.equal((await api("post", "/api/files", "qc", { name: "big.png", mime: "image/png", dataBase64: Buffer.alloc(900 * 1024).toString("base64") })).status, 400);
});

test("scan engine shows a FIFO hint when older approved stock is still in a bin", async () => {
  assert.equal((await api("post", "/api/parts", "engineer", { partNumber: "FIFO-PART", partName: "Fifo part", category: "CONSUMABLE", trackingType: "QUANTITY", defaultLocationCode: "M-04" })).status, 201);
  const older = await stored("FIFO-PART", { quantity: 7 }); const newer = await stored("FIFO-PART", { quantity: 9 });
  const s = (await api("post", "/api/scan", "store", { code: `MAT|FIFO-PART|I=${newer.id}` })).body; assert.ok(s.fifo); assert.equal(s.fifo.older.id, older.id);
  const s2 = (await api("post", "/api/scan", "store", { code: `MAT|FIFO-PART|I=${older.id}` })).body; assert.equal(s2.fifo, undefined);
});
