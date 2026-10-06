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
const L = require("../src/models/legacy");

const PW = "ChangeMe#2026"; let app; const tok = {}; const stamp = Date.now(); let gp;
const api = (method, url, user, body) => { let r = request(app)[method](url); if (user) r = r.set("Authorization", `Bearer ${tok[user]}`); return body ? r.send(body) : r; };
const login = async (email) => (await request(app).post("/login").send({ email, password: PW })).body.token;
const sample = { date: "2026-10-05", supplier: "Acme Components Pvt Ltd", dispatchMode: "By hand", returnable: true, returnDate: "2026-10-20", remarks: "Sample for supplier testing",
  items: [{ name: "Vehicle Control Unit", partNumber: "CTRL-001", serialBatch: "SN-10042", qty: "1", uom: "NOS" }, { name: "Automotive Relay", partNumber: "RELAY-001", serialBatch: "B-202609", qty: "20", uom: "NOS" }] };

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_gp_${stamp}`); await seed({ quiet: true }); app = createApp();
  for (const [k, e] of Object.entries({ admin: "admin@example.com", store: "store@example.com", qc: "qc@example.com", assembly: "assembly@example.com", supervisor: "supervisor@example.com", engineer: "engineer@example.com" })) tok[k] = await login(e);
  // a viewer-style role that can only look
  await api("put", "/api/roles/gpviewer", "admin", { permissions: ["scan.use", "gatepass.view"] }); await api("post", "/api/users", "admin", { name: "GP Viewer", emailId: "gpv@example.com", role: "gpviewer", password: PW }); tok.gpviewer = await login("gpv@example.com");
  await api("put", "/api/roles/reprinter", "admin", { permissions: ["scan.use", "gatepass.view", "gatepass.reprint"] }); await api("post", "/api/users", "admin", { name: "Reprinter", emailId: "rp@example.com", role: "reprinter", password: PW }); tok.reprinter = await login("rp@example.com");
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("gate pass: create needs gatepass.create and valid content", async () => {
  assert.equal((await api("post", "/api/gatepasses", "qc", sample)).status, 403); assert.equal((await api("post", "/api/gatepasses", "gpviewer", sample)).status, 403); assert.equal((await api("post", "/api/gatepasses", "engineer", sample)).status, 403);
  assert.equal((await api("post", "/api/gatepasses", "store", { ...sample, items: [] })).status, 400);
  assert.equal((await api("post", "/api/gatepasses", "store", { ...sample, returnDate: "" })).body.error, "VALIDATION");
  assert.equal((await api("post", "/api/gatepasses", "store", { ...sample, items: [{ name: "x", qty: "0" }] })).body.error, "VALIDATION");
  const ok = await api("post", "/api/gatepasses", "store", sample); assert.equal(ok.status, 201, JSON.stringify(ok.body)); gp = ok.body;
  assert.match(gp.refNo, /^ASPL-GP-\d{4}$/); assert.equal(gp.preparedBy, "Store User"); assert.equal(gp.status, "ISSUED"); assert.equal(gp.printCount, 0); assert.equal(gp.items[0].serialBatch, "SN-10042");
  const a = await M.AuditLog.findOne({ action: "GATE_PASS_CREATED" }); assert.equal(a.userName, "Store User"); assert.equal(a.entityLabel, gp.refNo); assert.ok(a.at);
  assert.equal((await L.GatePass.findById(gp._id)).lastAction, "GATE_PASS_CREATED"); // Last Update
});

test("gate pass: view needs gatepass.view (not admin.users)", async () => {
  for (const u of ["store", "gpviewer", "supervisor", "admin"]) { assert.equal((await api("get", "/api/gatepasses", u)).status, 200, u); assert.equal((await api("get", `/api/gatepasses/${gp._id}`, u)).body.refNo, gp.refNo); }
  for (const u of ["qc", "assembly", "engineer"]) { assert.equal((await api("get", "/api/gatepasses", u)).status, 403, u); assert.equal((await api("get", `/api/gatepasses/${gp._id}`, u)).status, 403, u); }
  assert.equal((await request(app).get("/api/gatepasses")).status, 401);
});

test("gate pass: first print needs gatepass.print and returns a dedicated A4 document; reprint needs gatepass.reprint + reason; both audited", async () => {
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "gpviewer", {})).status, 403); // can view, cannot print
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "reprinter", {})).status, 403); // reprint right alone does not allow the FIRST print
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "qc", {})).status, 403);
  const p1 = await api("post", `/api/gatepasses/${gp._id}/print`, "store", {}); assert.equal(p1.status, 200, JSON.stringify(p1.body)); assert.equal(p1.body.printNo, 1); assert.equal(p1.body.reprint, false);
  const h = p1.body.html;
  for (const must of ["GATE PASS", gp.refNo, "2026-10-05", "Acme Components Pvt Ltd", "By hand", "Returnable", "Yes", "Expected Return Date", "2026-10-20", "Sr No", "Part No", "Serial / Batch", "UOM", "CTRL-001", "SN-10042", "RELAY-001", "B-202609", "Sample for supplier testing", "Prepared By", "Issued By", "Received By", "Signature", "Name:", "Date / Time", "@page{size:A4", "LOGO", "Store User"]) assert.ok(h.includes(must), `print layout contains "${must}"`);
  assert.ok(!h.includes("REPRINT")); assert.ok(h.includes("@media print{.noprint{display:none!important}}")); assert.ok(!h.includes("<nav") && !h.includes("sidebar"));
  const rows = (h.match(/<tr><td class="c">\d+<\/td>/g) || []).length; assert.equal(rows, 2);
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "store", {})).status, 403); // store: print only, a second print is a reprint
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "supervisor", {})).body.error, "REPRINT_REASON_REQUIRED");
  const p2 = await api("post", `/api/gatepasses/${gp._id}/print`, "supervisor", { reason: "Original copy lost at gate" }); assert.equal(p2.status, 200); assert.equal(p2.body.reprint, true); assert.equal(p2.body.printNo, 2);
  assert.ok(p2.body.html.includes("REPRINT")); assert.ok(p2.body.html.includes("Print #2"));
  assert.equal((await api("post", `/api/gatepasses/${gp._id}/print`, "reprinter", { reason: "Customer copy" })).status, 200); // reprint permission alone is enough for later prints
  const rec = await L.GatePass.findById(gp._id); assert.equal(rec.printCount, 3); assert.deepEqual(rec.printLog.map((x) => [x.no, x.reprint, x.byName]), [[1, false, "Store User"], [2, true, "Supervisor"], [3, true, "Reprinter"]]);
  assert.equal(rec.printLog[1].reason, "Original copy lost at gate"); assert.equal(rec.lastAction, "GATE_PASS_REPRINTED");
  const aud = await M.AuditLog.find({ entityLabel: gp.refNo, action: /PRINT/ }).sort({ at: 1 }); assert.deepEqual(aud.map((a) => a.action), ["GATE_PASS_PRINTED", "GATE_PASS_REPRINTED", "GATE_PASS_REPRINTED"]); assert.equal(aud[1].reason, "Original copy lost at gate");
});

test("gate pass: print output escapes content (no script injection)", async () => {
  const g = (await api("post", "/api/gatepasses", "store", { ...sample, supplier: "<script>alert(1)</script>", remarks: "\"><img src=x onerror=alert(1)>", items: [{ name: "<b>bold</b>", qty: "2" }] })).body;
  const h = (await api("post", `/api/gatepasses/${g._id}/print`, "store", {})).body.html;
  assert.ok(!h.includes("<script>alert(1)</script>") && !h.includes("<img src=x") && !h.includes("<b>bold</b>")); assert.ok(h.includes("&lt;script&gt;"));
});

test("gate pass: existing (legacy) records are preserved, listed and printable", async () => {
  const old = await L.GatePass.collection.insertOne({ refNo: "GP-OLD1", date: "2025-12-01", supplier: "Old Supplier", dispatchMode: "Courier", returnable: false, remarks: "legacy", items: [{ name: "Old part", qty: "5" }], createdAt: new Date(), updatedAt: new Date() });
  const list = (await api("get", "/api/gatepasses", "store")).body; assert.ok(list.find((x) => x.refNo === "GP-OLD1"));
  const p = await api("post", `/api/gatepasses/${old.insertedId}/print`, "store", {}); assert.equal(p.status, 200, JSON.stringify(p.body)); assert.ok(p.body.html.includes("Old part") && p.body.html.includes("Old Supplier") && p.body.html.includes("NOS"));
  assert.equal((await L.GatePass.findById(old.insertedId)).printCount, 1);
});

test("gate pass: legacy /gatepass endpoints use the same collection and the new permissions (no admin-only role check)", async () => {
  assert.equal((await api("get", "/gatepass", "store")).status, 200); assert.equal((await api("get", "/gatepass", "qc")).status, 403); assert.equal((await api("get", "/gatepass/next-ref", "store")).status, 200);
  const c = await api("post", "/gatepass", "store", { date: "2026-10-06", supplier: "Legacy Screen Co", items: [{ name: "Gasket", qty: 3 }] }); assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.ok(await M.AuditLog.findOne({ action: "GATE_PASS_CREATED", entityLabel: c.body.refNo })); assert.equal((await api("post", "/gatepass", "qc", { supplier: "x", items: [{ name: "x", qty: 1 }] })).status, 403);
  assert.equal(await L.GatePass.countDocuments({ refNo: c.body.refNo }), 1);
  assert.equal((await api("get", "/activity-log", "store")).status, 403); assert.equal((await api("get", "/activity-log", "supervisor")).status, 200);
});

test("audit: important actions across the system leave who / what / when / before / after / reason", async () => {
  const supplierId = String((await M.Supplier.findOne({ code: "ACME" }))._id);
  const rc = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: "INV-AUD-1", lines: [{ partNumber: "CTRL-001", quantity: 1, serialNumbers: ["SN-AUD-1"] }] }); const id = rc.body.items[0].id;
  await api("post", "/api/qc/incoming", "qc", { materialItemId: id, result: "PASS" }); await api("post", `/api/materials/${id}/put-away`, "store", { scannedLocation: "E-20" });
  await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: id });
  await api("post", "/api/vehicles/LITE-0012/install", "admin", { materialItemId: id, override: { reason: "Reassigned for pilot build", confirm: true } }); // wrong vehicle / BOM override
  await api("post", "/api/vehicles/LITE-0012/remove", "supervisor", { materialItemId: id, reason: "Pilot cancelled", disposition: "QC_REQUIRED" });
  await api("post", "/api/inventory/adjust", "admin", { materialItemId: id, location: "QC-HOLD", newQuantity: 0, reason: "Count mismatch found", confirm: true });
  await api("put", "/api/roles/viewer", "admin", { permissions: ["scan.use", "inventory.view"] });
  const need = ["MATERIAL_RECEIPT", "QC_INCOMING_PASS", "PUT_AWAY", "COMPONENT_INSTALLED", "COMPONENT_REMOVED", "INVENTORY_ADJUSTMENT", "ROLE_PERMISSIONS_CHANGED"];
  for (const a of need) { const row = await M.AuditLog.findOne({ action: a }); assert.ok(row, `audit row for ${a}`); assert.ok(row.userName && row.at && row.entityType, `${a} has user, time, entity`); }
  assert.ok(await M.AuditLog.findOne({ override: true, action: /^OVERRIDE_/, reason: "Reassigned for pilot build" }));
  const adj = await M.AuditLog.findOne({ action: "INVENTORY_ADJUSTMENT" }); assert.equal(adj.reason, "Count mismatch found"); assert.ok(adj.before && adj.after); assert.equal(adj.userName, "Admin User");
  const rm = await M.AuditLog.findOne({ action: "COMPONENT_REMOVED" }); assert.equal(rm.reason, "Pilot cancelled"); assert.equal(rm.after.status, "QC_REQUIRED");
  const ov = await M.OverrideRecord.findOne({ reason: "Reassigned for pilot build" }); assert.ok(ov && ov.adminName === "Admin User" && ov.referenceTransaction);
});
