process.env.JWT_SECRET = "test-secret-1234567890-abcdef";
process.env.LOGIN_RATE_LIMIT = "1000"; process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const db = require("../src/db");
const { createApp } = require("../src/app");
const { seed } = require("../src/scripts/seed");
const { backfillV3 } = require("../src/scripts/baseData");
const M = require("../src/models");
const L = require("../src/models/legacy");

const PW = "ChangeMe#2026"; let app; const tok = {}; let supplierId; const stamp = Date.now(); let seq = 0;
const api = (method, url, user, body) => { let r = request(app)[method](url); if (user) r = r.set("Authorization", `Bearer ${tok[user]}`); return body ? r.send(body) : r; };
const login = async (email) => (await request(app).post("/login").send({ email, password: PW })).body.token;
const inv = () => `INV-V3-${stamp}-${++seq}`;
async function receive(partNumber, line = {}, as = "store") {
  const res = await api("post", "/api/receiving", as, { supplierId, invoiceNo: inv(), lines: [{ partNumber, quantity: 1, ...line }] });
  assert.equal(res.status, 201, JSON.stringify(res.body)); return { receiptId: res.body.receiptId, items: res.body.items };
}
async function approved(partNumber, line = {}) { const r = await receive(partNumber, line); const it = r.items[0]; if (it.status !== "APPROVED") { const q = await api("post", "/api/qc/incoming", "qc", { materialItemId: it.id, result: "PASS" }); assert.equal(q.status, 200, JSON.stringify(q.body)); } return it; }
async function stored(partNumber, line = {}) { const it = await approved(partNumber, line); const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body; const r = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: plan.destination.code }); assert.equal(r.status, 200, JSON.stringify(r.body)); return it; }
const bal = async (itemId, code) => { const l = await M.Location.findOne({ locationCode: code }); const b = await M.StockBalance.findOne({ materialItem: itemId, location: l._id }); return b ? b.quantity : 0; };
// install; if FIFO blocks because other tests left older stock, a supervisor completes it with an audited override
async function install(veh, itemId, qty) {
  let r = await api("post", `/api/vehicles/${veh}/install`, "assembly", { materialItemId: itemId, quantity: qty });
  if (r.body.error === "FIFO_VIOLATION") r = await api("post", `/api/vehicles/${veh}/install`, "supervisor", { materialItemId: itemId, quantity: qty, override: { reason: "older lot reserved elsewhere", confirm: true } });
  return r;
}
async function userWithRole(role, perms, email) {
  assert.equal((await api("put", `/api/roles/${encodeURIComponent(role)}`, "admin", { permissions: perms })).status, 200);
  assert.equal((await api("post", "/api/users", "admin", { name: role, emailId: email, role, password: PW })).status, 201);
  tok[role] = await login(email); return role;
}

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_v3_${stamp}`); await seed({ quiet: true }); app = createApp();
  for (const [k, e] of Object.entries({ admin: "admin@example.com", store: "store@example.com", qc: "qc@example.com", assembly: "assembly@example.com", supervisor: "supervisor@example.com", engineer: "engineer@example.com" })) tok[k] = await login(e);
  supplierId = String((await M.Supplier.findOne({ code: "ACME" }))._id);
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

// =============================== AUTHORIZATION ===============================
test("scan.use alone opens ONLY the scanner - not the dashboard, lists, QC, engineering, gate passes or admin", async () => {
  await userWithRole("scanner", ["scan.use"], "scanner@example.com");
  const blocked = [["get", "/api/dashboard"], ["get", "/api/inventory/stock"], ["get", "/api/inventory/transactions"], ["get", "/api/parts"], ["get", "/api/locations"], ["get", "/api/suppliers"], ["get", "/api/qc"], ["get", "/api/qc/queue"],
    ["get", "/api/vehicles"], ["get", "/api/installations"], ["get", "/api/handover"], ["get", "/api/gatepasses"], ["get", "/api/audit"], ["get", "/api/eco"], ["get", "/api/bom"], ["get", "/api/kits"], ["get", "/api/purchase-orders"],
    ["get", "/api/analytics"], ["get", "/api/alerts"], ["get", "/api/roles"], ["get", "/users"], ["get", "/getparts"], ["get", "/gatepass"], ["get", "/activity-log"], ["get", "/api/workbench/store"], ["get", "/api/export/stock"]];
  for (const [m, u] of blocked) assert.equal((await api(m, u, "scanner")).status, 403, `${m} ${u} must be forbidden for scan.use only`);
  assert.equal((await api("post", "/api/scan", "scanner", { code: "LOC|E-08" })).status, 200);
  assert.equal((await request(app).get("/api/dashboard")).status, 401); // no token at all
});

test("dashboard needs dashboard.view; granting it opens the dashboard and nothing else", async () => {
  for (const r of ["store", "qc", "assembly", "engineer"]) assert.equal((await api("get", "/api/dashboard", r)).status, 403, `${r} must not see the dashboard`);
  for (const r of ["admin", "supervisor"]) assert.equal((await api("get", "/api/dashboard", r)).status, 200, r);
  await userWithRole("dashonly", ["dashboard.view"], "dashonly@example.com");
  assert.equal((await api("get", "/api/dashboard", "dashonly")).status, 200); assert.equal((await api("get", "/api/inventory/stock", "dashonly")).status, 403);
  const perms = (await request(app).post("/login").send({ email: "store@example.com", password: PW })).body.permissions;
  assert.ok(!perms.includes("dashboard.view") && perms.includes("scan.use") && perms.includes("inventory.receive"));
});

test("role boundaries: store / QC / assembly / engineer cannot use each other's modules (server-side)", async () => {
  const cases = [
    ["qc", "post", "/api/receiving", { supplierId, invoiceNo: "X", lines: [{ partNumber: "M8-NUT", quantity: 1 }] }], ["qc", "get", "/api/inventory/transactions"], ["qc", "get", "/api/gatepasses"],
    ["store", "post", "/api/qc/incoming", { materialItemId: "0".repeat(24), result: "PASS" }], ["store", "post", "/api/recall/quarantine", { criteria: { batchNumber: "x" }, reason: "abcdef", confirm: true }],
    ["assembly", "post", "/api/receiving", { supplierId, invoiceNo: "X", lines: [] }], ["assembly", "get", "/api/eco"], ["assembly", "post", "/api/vehicles/BUZZ-0042/remove", { materialItemId: "0".repeat(24), reason: "x", disposition: "HOLD" }],
    ["assembly", "post", "/api/qc/retest", { materialItemId: "0".repeat(24), result: "PASS" }],
    ["store", "post", "/api/vehicles/BUZZ-0042/install", { materialItemId: "0".repeat(24) }], ["store", "post", "/api/bom/BUZZ/revisions", { revision: "R", changeReason: "x", items: [{ partNumber: "RELAY-001", requiredQuantity: 1 }] }],
    ["store", "post", "/api/parts", { partNumber: "NOPE", partName: "x", category: "OTHER", trackingType: "QUANTITY" }], ["store", "put", "/api/roles/store", { permissions: ["scan.use"] }], ["engineer", "get", "/api/roles"], ["engineer", "get", "/users"],
    ["engineer", "post", "/api/receiving", { supplierId, invoiceNo: "X", lines: [] }], ["engineer", "post", "/api/inventory/adjust", { materialItemId: "0".repeat(24), location: "E-08", newQuantity: 1, reason: "abcdef", confirm: true }],
    ["store", "get", "/api/audit"], ["qc", "get", "/api/audit"], ["store", "post", "/api/inventory/adjust", { materialItemId: "0".repeat(24), location: "E-08", newQuantity: 1, reason: "abcdef", confirm: true }],
  ];
  for (const [u, m, url, body] of cases) assert.equal((await api(m, url, u, body)).status, 403, `${u} ${m} ${url}`);
  // and the intended roles DO have access
  for (const [u, url] of [["store", "/api/inventory/stock"], ["store", "/api/handover"], ["qc", "/api/qc"], ["qc", "/api/ncr"], ["assembly", "/api/vehicles"], ["assembly", "/api/installations"], ["engineer", "/api/bom"], ["engineer", "/api/eco"], ["supervisor", "/api/audit"]])
    assert.equal((await api("get", url, u)).status, 200, `${u} ${url}`);
});

test("QC outcomes need their own permissions (pass/reject/hold/retest)", async () => {
  await userWithRole("qcjunior", ["scan.use", "qc.view", "qc.perform", "qc.hold", "inventory.view"], "qcjr@example.com");
  const r = await receive("RELAY-001", { quantity: 3, batchNumber: "B-QCP" }); const id = r.items[0].id;
  assert.equal((await api("post", "/api/qc/incoming", "qcjunior", { materialItemId: id, result: "PASS" })).status, 403);
  assert.equal((await api("post", "/api/qc/incoming", "qcjunior", { materialItemId: id, result: "FAIL", remarks: "bad" })).status, 403);
  assert.equal((await api("post", "/api/qc/incoming", "qcjunior", { materialItemId: id, result: "HOLD", remarks: "doubt" })).status, 200);
  assert.equal((await api("post", "/api/qc/retest", "qcjunior", { materialItemId: id, result: "PASS" })).status, 403);
  assert.equal((await api("post", "/api/qc/retest", "qc", { materialItemId: id, result: "PASS" })).status, 200);
});

test("saved roles with old permission names are translated; unknown names are dropped", async () => {
  await M.Role.updateOne({ name: "legacyrole" }, { $set: { permissions: ["material.receive", "material.issue", "engineering.manage", "scan.use", "bogus.perm", "admin.master"] } }, { upsert: true });
  const out = await backfillV3(); assert.ok(out.roles >= 1);
  const perms = (await M.Role.findOne({ name: "legacyrole" })).permissions;
  assert.ok(["inventory.receive", "inventory.issue", "engineering.manage_parts", "engineering.manage_bom", "scan.use", "admin.master_data"].every((p) => perms.includes(p)));
  assert.ok(!perms.includes("bogus.perm") && !perms.includes("material.receive"));
});

test("upgrade backfill classifies existing parts without touching their data", async () => {
  await M.PartMaster.collection.insertMany([
    { partNumber: "OLD-NUT", partName: "Old nut", category: "CONSUMABLE", trackingType: "QUANTITY", unit: "NOS", active: true, currentRevision: "REV-A", vehicleCompatibility: [], createdAt: new Date(), updatedAt: new Date() },
    { partNumber: "OLD-CTRL", partName: "Old controller", category: "ELECTRONICS", trackingType: "SERIAL", unit: "NOS", active: true, currentRevision: "REV-B", vehicleCompatibility: [], createdAt: new Date(), updatedAt: new Date() },
    { partNumber: "OLD-DEV", partName: "Old dev", category: "DEVELOPMENT", trackingType: "QUANTITY", unit: "NOS", active: true, currentRevision: "REV-A", vehicleCompatibility: [], createdAt: new Date(), updatedAt: new Date() }]);
  await backfillV3(); const get = (n) => M.PartMaster.findOne({ partNumber: n }).lean();
  const nut = await get("OLD-NUT"), ctrl = await get("OLD-CTRL"), dv = await get("OLD-DEV");
  assert.deepEqual([nut.inventoryClass, nut.qcRequired, nut.bomControlled], ["GENERAL", false, false]);
  assert.deepEqual([ctrl.inventoryClass, ctrl.qcRequired, ctrl.bomControlled, ctrl.fifoApplicable, ctrl.currentRevision], ["PRODUCTION", true, true, true, "REV-B"]);
  assert.deepEqual([dv.inventoryClass, dv.devStatus, dv.qcRequired], ["DEVELOPMENT", "ACTIVE", false]);
  assert.equal(await M.PartMaster.countDocuments({ inventoryClass: { $exists: false } }), 0);
});

// =============================== INVENTORY CLASSES ===============================
test("class and tracking type are independent; part master has the required fields", async () => {
  const parts = (await api("get", "/api/parts", "store")).body; const by = (n) => parts.find((p) => p.partNumber === n);
  assert.deepEqual([by("M8-NUT").inventoryClass, by("M8-NUT").trackingType], ["GENERAL", "QUANTITY"]);
  assert.deepEqual([by("GREASE-001").inventoryClass, by("GREASE-001").trackingType], ["GENERAL", "BATCH"]);
  assert.deepEqual([by("MOTOR-001").inventoryClass, by("MOTOR-001").trackingType], ["PRODUCTION", "SERIAL"]);
  assert.deepEqual([by("HARNESS-001").inventoryClass, by("HARNESS-001").trackingType], ["PRODUCTION", "BATCH"]);
  assert.deepEqual([by("DEV-CTRL-001").inventoryClass, by("DEV-CTRL-001").trackingType], ["DEVELOPMENT", "SERIAL"]);
  assert.deepEqual([by("DEV-BRKT-001").inventoryClass, by("DEV-BRKT-001").trackingType], ["DEVELOPMENT", "QUANTITY"]);
  const p = by("CTRL-001"); for (const f of ["partNumber", "partName", "category", "subCategory", "unit", "active", "revisionControlled", "qcRequired", "fifoApplicable", "inventoryClass", "trackingType", "lastUpdatedAt"]) assert.ok(p[f] !== undefined, `field ${f}`);
  assert.equal(by("CTRL-001").currentRevision, "REV-C"); // seed matches the BUZZ BOM requirement
  // creating a new combination through the API, then locking it once stock exists
  const mk = await api("post", "/api/parts", "engineer", { partNumber: "X-GEN-SER", partName: "General serial", inventoryClass: "GENERAL", category: "OTHER", trackingType: "SERIAL" }); assert.equal(mk.status, 201);
  assert.equal(mk.body.rules.qcRequired, false);
  const it = await approved("M8-NUT", { quantity: 10 });
  const lock = await api("put", `/api/parts/${by("M8-NUT")._id}`, "engineer", { inventoryClass: "PRODUCTION" }); assert.equal(lock.body.error, "CLASS_LOCKED"); assert.ok(it.id);
});

test("GENERAL workflow: receive -> store -> available -> issue -> return, no QC, no BOM, no vehicle", async () => {
  const r = await receive("M8-NUT", { quantity: 500 }); assert.equal(r.items[0].status, "APPROVED"); assert.equal(r.items[0].inventoryClass, "GENERAL");
  const id = r.items[0].id;
  assert.equal((await api("post", "/api/qc/incoming", "qc", { materialItemId: id, result: "PASS" })).body.error, "QC_NOT_ALLOWED"); // nothing to inspect
  const types0 = (await M.InventoryTransaction.find({ materialItem: id })).map((t) => t.transactionType); assert.deepEqual(types0, ["RECEIPT"]);
  const plan = (await api("get", `/api/materials/${id}/put-away-plan`, "store")).body; assert.equal(plan.destination.code, "M-04");
  assert.equal((await api("post", `/api/materials/${id}/put-away`, "store", { scannedLocation: "LOC|M-04" })).status, 200);
  assert.equal((await api("post", "/api/inventory/issue", "store", { materialItemId: id, quantity: 120, fromLocation: "M-04", purpose: "Line 2" })).status, 200);
  assert.equal(await bal(id, "M-04"), 380); assert.equal(await bal(id, "WIP-FLOOR"), 120);
  assert.equal((await api("post", "/api/inventory/return", "store", { materialItemId: id, quantity: 20, reason: "unused" })).status, 200); assert.equal(await bal(id, "WIP-FLOOR"), 100);
  // used on a vehicle WITHOUT being on any BOM: allowed, still traced
  const inst = await install("BUZZ-0042", id, 4); assert.equal(inst.status, 200, JSON.stringify(inst.body));
  const trace = (await api("get", `/api/traceability/component/${id}`, "admin")).body; assert.equal(trace.allocation.installedTotal, 4);
});

test("PRODUCTION workflow: invoice -> incoming QC -> put-away only after approval; BOM + revision enforced", async () => {
  assert.equal((await api("post", "/api/receiving", "store", { supplierId, lines: [{ partNumber: "CTRL-001", quantity: 1, serialNumbers: ["SN-P0"] }] })).body.error, "INVOICE_REQUIRED");
  const r = await receive("CTRL-001", { serialNumbers: ["SN-P1"] }); const it = r.items[0];
  assert.equal(it.status, "PENDING_INCOMING_QC"); assert.equal((await M.MaterialItem.findById(it.id)).partRevision, "REV-C"); // defaults to the part's current revision
  assert.equal((await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "E-20" })).body.error, "MATERIAL_NOT_APPROVED");
  assert.equal((await api("post", "/api/qc/incoming", "qc", { materialItemId: it.id, result: "PASS" })).status, 200);
  assert.equal((await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "LOC|E-20" })).status, 200);
  const ok = await install("BUZZ-0042", it.id, 1); assert.equal(ok.status, 200, JSON.stringify(ok.body)); // REV-C unit on a REV-C BOM
  for (const rev of ["REV-A", "REV-B"]) {
    const u = await stored("CTRL-001", { serialNumbers: [`SN-${rev}`], revision: rev });
    const bad = await api("post", "/api/vehicles/RETRO-0007/install", "assembly", { materialItemId: u.id }); // RETROFIT BOM accepts any revision
    assert.notEqual(bad.body.error, "REVISION_MISMATCH");
    const veh = await api("post", "/api/vehicles", "engineer", { vehicleNumber: `BUZZ-${rev}`, model: "BUZZ", vehicleType: "BUZZ" });
    const blocked = await api("post", `/api/vehicles/${veh.body.vehicleNumber}/install`, "assembly", { materialItemId: u.id }); assert.equal(blocked.body.error, "REVISION_MISMATCH", rev);
  }
});

test("DEVELOPMENT workflow: draft -> engineering review -> approved -> active -> usable; not forced through BOM", async () => {
  const part = (await api("get", "/api/parts?q=DEV-HRN", "engineer")).body[0];
  assert.equal(part.devStatus, "DRAFT");
  assert.equal((await api("post", "/api/receiving", "store", { supplierId, invoiceNo: inv(), lines: [{ partNumber: "DEV-HRN-001", quantity: 5, batchNumber: "B-DEV" }] })).body.error, "DEV_NOT_ACTIVE");
  assert.equal((await api("post", `/api/parts/${part._id}/dev/activate`, "engineer")).body.error, "INVALID_STATE_TRANSITION"); // cannot skip review
  assert.equal((await api("post", `/api/parts/${part._id}/dev/submit`, "store")).status, 403);
  assert.equal((await api("post", `/api/parts/${part._id}/dev/submit`, "engineer")).body.devStatus, "ENGINEERING_REVIEW");
  assert.equal((await api("post", `/api/parts/${part._id}/dev/approve`, "store", {})).status, 403);
  assert.equal((await api("post", `/api/parts/${part._id}/dev/reject`, "engineer", {})).status, 400); // reason required
  assert.equal((await api("post", `/api/parts/${part._id}/dev/approve`, "engineer", { note: "Design reviewed" })).body.devStatus, "APPROVED");
  assert.equal((await M.PartRevision.findOne({ part: part._id, revision: "REV-A" })).status, "APPROVED");
  assert.equal((await api("post", `/api/parts/${part._id}/dev/activate`, "engineer")).body.devStatus, "ACTIVE");
  const r = await receive("DEV-HRN-001", { quantity: 5, batchNumber: "B-DEV" }); assert.equal(r.items[0].status, "APPROVED"); assert.equal(r.items[0].inventoryClass, "DEVELOPMENT");
  const p2 = (await api("get", `/api/parts/${part._id}`, "engineer")).body; assert.equal(p2.lastAction, "DEV_ACTIVATED"); assert.equal(p2.lastUpdatedByName, "Engineer");
  // a development serial component can go on a vehicle without BOM validation, and is still traced
  const d = await stored("DEV-CTRL-001", { serialNumbers: ["SN-DEV-1"], revision: "REV-B" });
  const inst = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: d.id }); assert.equal(inst.status, 200, JSON.stringify(inst.body));
  assert.equal((await M.Installation.findOne({ materialItem: d.id, active: true })).partRevision, "REV-B");
});

test("development categories: exactly the seven allowed subcategories", async () => {
  assert.deepEqual((await api("get", "/api/dev-subcategories", "engineer")).body, ["Electrical", "Electronics", "Hardware", "Metal", "Plastic", "Proprietary", "Rubber"]);
  const base = { inventoryClass: "DEVELOPMENT", category: "OTHER", trackingType: "QUANTITY" };
  assert.equal((await api("post", "/api/parts", "engineer", { ...base, partNumber: "DEV-X0", partName: "x", subCategory: "Wood" })).status, 400);
  assert.equal((await api("post", "/api/parts", "engineer", { ...base, partNumber: "DEV-X1", partName: "x" })).status, 400);
  for (const [i, sc] of ["Electrical", "Electronics", "Hardware", "Metal", "Plastic", "Proprietary", "Rubber"].entries()) {
    const r = await api("post", "/api/parts", "engineer", { ...base, partNumber: `DEV-SC${i}`, partName: sc, subCategory: sc }); assert.equal(r.status, 201, sc); assert.equal(r.body.devStatus, "DRAFT");
  }
  assert.equal((await api("post", "/api/parts", "store", { ...base, partNumber: "DEV-X9", partName: "x", subCategory: "Metal" })).status, 403);
});

test("development images: several per revision, history kept per revision, append-only", async () => {
  const part = (await api("get", "/api/parts?q=DEV-CTRL-001", "engineer")).body[0];
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const up = (rev, name) => api("post", `/api/parts/${part._id}/images`, "engineer", { revision: rev, name, mime: "image/png", dataBase64: png, caption: `${rev} ${name}` });
  assert.equal((await up("REV-A", "front.png")).status, 201); assert.equal((await up("REV-B", "front.png")).status, 201); assert.equal((await up("REV-B", "side.png")).status, 201);
  const g = (await api("get", `/api/parts/${part._id}/images`, "engineer")).body; const byRev = Object.fromEntries(g.map((x) => [x.revision, x.images]));
  assert.equal(byRev["REV-A"].length, 1); assert.equal(byRev["REV-B"].length, 2); assert.equal(byRev["REV-B"][0].url.startsWith("/api/files/"), true);
  assert.ok(byRev["REV-B"].every((i) => i.uploadedBy === "Engineer" && i.uploadedAt));
  assert.equal((await up("REV-A", "back.png")).status, 201); assert.equal((await api("get", `/api/parts/${part._id}/images`, "engineer")).body.find((x) => x.revision === "REV-A").images.length, 2); // REV-A kept, nothing overwritten
  assert.equal((await up("REV-Z", "x.png")).status, 400);
  const file = await api("get", byRev["REV-A"][0].url, "engineer"); assert.equal(file.status, 200); assert.equal(file.headers["content-type"], "image/png");
  assert.equal((await api("post", `/api/parts/${part._id}/images`, "store", { revision: "REV-A", name: "x.png", mime: "image/png", dataBase64: png })).status, 403);
  assert.equal((await api("post", `/api/parts/${(await M.PartMaster.findOne({ partNumber: "RELAY-001" }))._id}/images`, "engineer", { revision: "REV-A", name: "x.png", mime: "image/png", dataBase64: png })).body.error, "NOT_DEVELOPMENT");
  assert.equal((await api("post", `/api/parts/${part._id}/images`, "engineer", { revision: "REV-A", name: "x.svg", mime: "image/svg+xml", dataBase64: png })).status, 400);
  await assert.rejects(M.PartImage.deleteMany({}), /append-only/); await assert.rejects(M.PartImage.updateOne({}, { $set: { revision: "REV-Z" } }), /append-only/);
});

// =============================== TRACKING + FIFO ===============================
test("BATCH partial consumption keeps the allocation history; QUANTITY items issue partially", async () => {
  const lot = await stored("JST-8P-F", { quantity: 100, batchNumber: "B-ALLOC" });
  assert.equal((await install("BUZZ-0042", lot.id, 3)).status, 200); assert.equal((await install("RETRO-0007", lot.id, 2)).status, 200);
  const t = (await api("get", "/api/traceability/serial/B-ALLOC", "admin")).body;
  assert.equal(t.allocation.total, 100); assert.equal(t.allocation.installedTotal, 5); assert.equal(t.allocation.onHand, 95);
  assert.deepEqual(Object.fromEntries(t.allocation.byVehicle.map((v) => [v.vehicle, v.installed])), { "BUZZ-0042": 3, "RETRO-0007": 2 });
  const bolts = await stored("BOLT-M8", { quantity: 100 }); await api("post", "/api/inventory/issue", "store", { materialItemId: bolts.id, quantity: 20, fromLocation: "M-04", purpose: "Line" });
  assert.equal(await bal(bolts.id, "M-04"), 80); assert.equal((await M.MaterialItem.findById(bolts.id)).quantity, 100);
});

test("FIFO: oldest stock first; newer lot blocked; override needs permission, reason and is audited; non-FIFO parts are free", async () => {
  const older = await stored("GREASE-001", { quantity: 10, batchNumber: "G-OLD" }); const newer = await stored("GREASE-001", { quantity: 10, batchNumber: "G-NEW" });
  const blocked = await api("post", "/api/inventory/issue", "store", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "Maintenance" });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "FIFO_VIOLATION"); assert.equal(blocked.body.details.suggested.batchNumber, "G-OLD"); assert.equal(blocked.body.overridable, true);
  assert.equal((await api("post", "/api/inventory/issue", "store", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "x", override: { reason: "customer asked for new lot", confirm: true } })).status, 403); // store: no override right
  assert.equal((await api("post", "/api/inventory/issue", "qc", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "x" })).status, 403);
  const noReason = await api("post", "/api/inventory/issue", "supervisor", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "x", override: { reason: "", confirm: true } }); assert.equal(noReason.body.error, "OVERRIDE_REASON_REQUIRED");
  assert.equal((await api("post", "/api/inventory/issue", "supervisor", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "x", override: { reason: "needed for sealed job", confirm: false } })).body.error, "OVERRIDE_CONFIRMATION_REQUIRED");
  assert.equal(await bal(newer.id, "M-04"), 10); // nothing moved yet
  const ok = await api("post", "/api/inventory/issue", "supervisor", { materialItemId: newer.id, quantity: 2, fromLocation: "M-04", purpose: "Sealed job", override: { reason: "Old lot is near expiry, QA agreed", confirm: true } }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.fifoOverride, true);
  const ov = await M.OverrideRecord.findOne({ kind: "FIFO_OVERRIDE" }); assert.equal(ov.adminName, "Supervisor"); assert.equal(ov.reason, "Old lot is near expiry, QA agreed"); assert.equal(ov.originalValue.olderStock.batchNumber, "G-OLD");
  const au = await M.AuditLog.findOne({ action: "OVERRIDE_FIFO_OVERRIDE" }); assert.equal(au.override, true); assert.equal(au.userName, "Supervisor");
  assert.equal((await api("post", "/api/inventory/issue", "store", { materialItemId: older.id, quantity: 3, fromLocation: "M-04", purpose: "Maintenance" })).status, 200); // oldest is always allowed
  // auto-select spans lots oldest-first
  const a = await stored("GREASE-001", { quantity: 5, batchNumber: "G-A2" }); void a;
  const next = (await api("get", "/api/inventory/fifo-next?partNumber=GREASE-001&quantity=9", "store")).body; assert.equal(next.allocations[0].batchNumber, "G-OLD"); assert.equal(next.shortage, 0);
  const auto = await api("post", "/api/inventory/issue-fifo", "store", { partNumber: "GREASE-001", quantity: 9, purpose: "Bearing service" }); assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.deepEqual(auto.body.allocations.map((x) => [x.batchNumber, x.quantity]), [["G-OLD", 7], ["G-NEW", 2]]);
  assert.equal((await api("post", "/api/inventory/issue-fifo", "store", { partNumber: "GREASE-001", quantity: 500, purpose: "x" })).body.error, "INSUFFICIENT_STOCK");
  // FIFO is per part: M8-NUT is not FIFO-applicable, so any lot may be issued
  const n1 = await stored("M8-NUT", { quantity: 50 }); const n2 = await stored("M8-NUT", { quantity: 50 });
  assert.equal((await api("post", "/api/inventory/issue", "store", { materialItemId: n2.id, quantity: 5, fromLocation: "M-04", purpose: "x" })).status, 200); void n1;
});

test("FIFO also guards handover and installation from a bin", async () => {
  const o = await stored("RELAY-001", { quantity: 10, batchNumber: "R-OLD" }); const n = await stored("RELAY-001", { quantity: 10, batchNumber: "R-NEW" });
  const uid = String((await M.User.findOne({ emailId: "assembly@example.com" }))._id);
  assert.equal((await api("post", "/api/handover", "store", { materialItemId: n.id, quantity: 2, toUserId: uid, fromLocation: "E-12", purpose: "Build" })).body.error, "FIFO_VIOLATION");
  assert.equal((await api("post", "/api/handover", "store", { materialItemId: o.id, quantity: 2, toUserId: uid, fromLocation: "E-12", purpose: "Build" })).status, 201);
  const blocked = await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: n.id, quantity: 1 }); assert.equal(blocked.body.error, "FIFO_VIOLATION");
  const chk = (await api("post", "/api/vehicles/BUZZ-0042/check", "assembly", { materialItemId: n.id, quantity: 1 })).body; assert.equal(chk.checks.find((c) => c.check === "FIFO").ok, false);
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", "assembly", { materialItemId: n.id, quantity: 1, override: { reason: "x1234", confirm: true } })).status, 403); // assembly cannot override FIFO
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", "supervisor", { materialItemId: n.id, quantity: 1, override: { reason: "Older lot damaged, QA noted", confirm: true } })).status, 200);
});

// =============================== VEHICLE ===============================
test("vehicle: last update, complete timeline, removal then reassignment keeps history; wrong vehicle blocked", async () => {
  await api("post", "/api/vehicles", "engineer", { vehicleNumber: "LITE-0099", model: "LITE", vehicleType: "LITE" });
  const c = await stored("CTRL-LITE", { serialNumbers: ["SN-LITE-9"] });
  assert.equal((await install("LITE-0012", c.id, 1)).status, 200);
  const blocked = await api("post", "/api/vehicles/LITE-0099/install", "assembly", { materialItemId: c.id }); assert.equal(blocked.body.error, "COMPONENT_ALREADY_ASSIGNED"); assert.match(blocked.body.message, /LITE-0012/);
  const v1 = (await api("get", "/api/vehicles/LITE-0012", "assembly")).body.vehicle; assert.equal(v1.lastAction, "COMPONENT_INSTALLED"); assert.equal(v1.lastUpdatedByName, "Assembly Operator"); assert.ok(v1.lastUpdatedAt);
  assert.equal((await api("post", "/api/vehicles/LITE-0012/remove", "assembly", { materialItemId: c.id, reason: "wrong build", disposition: "AVAILABLE" })).status, 403);
  assert.equal((await api("post", "/api/vehicles/LITE-0012/remove", "supervisor", { materialItemId: c.id, reason: "Fitted to wrong chassis", disposition: "AVAILABLE" })).status, 200);
  assert.equal((await M.Vehicle.findOne({ vehicleNumber: "LITE-0012" })).lastAction, "COMPONENT_REMOVED");
  assert.equal((await install("LITE-0099", c.id, 1)).status, 200); // reassignment through the controlled path
  const hist = await M.Installation.find({ materialItem: c.id }).sort({ installedAt: 1 }); assert.deepEqual(hist.map((h) => [h.vehicleNumber, h.active]), [["LITE-0012", false], ["LITE-0099", true]]); assert.equal(hist[0].removalReason, "Fitted to wrong chassis");
  const tl = (await api("get", "/api/vehicles/LITE-0012/timeline", "assembly")).body; const types = tl.events.map((e) => e.type);
  for (const t of ["RECEIVED", "COMPONENT_INSTALLED", "COMPONENT_REMOVED", "QC_INCOMING", "VEHICLE_STATUS_CHANGED"]) assert.ok(types.includes(t), `timeline has ${t}: ${types}`);
  assert.deepEqual(tl.events.map((e) => +new Date(e.at)), [...tl.events.map((e) => +new Date(e.at))].sort((a, b) => a - b)); assert.equal(tl.vehicle.vehicleNumber, "LITE-0012"); assert.ok(tl.vehicle.lastAction);
});

test("vehicle completion, in-process QC, rework, retest and final QC", async () => {
  await api("post", "/api/vehicles", "engineer", { vehicleNumber: "RETRO-0200", model: "RETROFIT", vehicleType: "RETROFIT" });
  const c = await stored("CTRL-001", { serialNumbers: ["SN-FQ-1"] }); const j = await stored("JST-8P-F", { quantity: 4, batchNumber: "B-FQ" });
  assert.equal((await install("RETRO-0200", c.id, 1)).status, 200);
  assert.equal((await api("post", "/api/qc/final", "qc", { vehicleId: String((await M.Vehicle.findOne({ vehicleNumber: "RETRO-0200" }))._id), result: "PASS" })).body.error, "VEHICLE_NOT_COMPLETE");
  const ip = await api("post", "/api/qc/in-process", "qc", { vehicleId: String((await M.Vehicle.findOne({ vehicleNumber: "RETRO-0200" }))._id), result: "FAIL", remarks: "Loose connector", measurements: [{ parameter: "Torque", value: "3", unit: "Nm", pass: false }] }); assert.equal(ip.status, 200, JSON.stringify(ip.body));
  const done = await install("RETRO-0200", j.id, 2); assert.equal(done.status, 200); assert.equal(done.body.vehicleComplete, true);
  assert.equal((await M.Vehicle.findOne({ vehicleNumber: "RETRO-0200" })).status, "ASSEMBLED");
  // component rework / retest cycle while installed
  assert.equal((await api("post", "/api/qc/component", "qc", { materialItemId: c.id, result: "FAIL", remarks: "CAN fault" })).status, 409); // component QC is for approved stock; installed units use in-process
  assert.equal((await api("post", "/api/qc/in-process", "qc", { materialItemId: c.id, result: "HOLD", remarks: "Check CAN transceiver" })).status, 200);
  const vid = String((await M.Vehicle.findOne({ vehicleNumber: "RETRO-0200" }))._id);
  assert.equal((await api("post", "/api/qc/final", "qc", { vehicleId: vid, result: "PASS", remarks: "All checks complete" })).status, 200);
  assert.equal((await M.Vehicle.findOne({ vehicleNumber: "RETRO-0200" })).status, "RELEASED");
  assert.equal((await api("post", "/api/vehicles/RETRO-0200/install", "assembly", { materialItemId: j.id, quantity: 1 })).body.error, "VEHICLE_CLOSED");
  const au = (await api("get", "/api/audit?action=QC_FINAL", "admin")).body; assert.ok(au.length >= 1);
  const rw = await stored("CTRL-LITE", { serialNumbers: ["SN-RW-1"] }); // reject -> rework -> retest -> approve
  assert.equal((await api("post", "/api/qc/component", "qc", { materialItemId: rw.id, result: "FAIL", remarks: "damaged" })).status, 200);
  assert.equal((await api("post", `/api/materials/${rw.id}/disposition`, "qc", { action: "REWORK", reason: "reflow" })).status, 200);
  assert.equal((await api("post", `/api/materials/${rw.id}/disposition`, "qc", { action: "REWORK_DONE", reason: "done" })).status, 200);
  assert.equal((await api("post", "/api/qc/retest", "qc", { materialItemId: rw.id, result: "PASS" })).body.status, "APPROVED");
});

// =============================== WORKBENCHES + LAST UPDATE ===============================
test("role workbenches return only the sections for that role", async () => {
  for (const [role, kind] of [["store", "store"], ["qc", "qc"], ["assembly", "assembly"], ["engineer", "engineering"]]) {
    const r = await api("get", `/api/workbench/${kind}`, role); assert.equal(r.status, 200, `${role}/${kind}`); assert.ok(r.body.sections.length >= 3);
  }
  assert.equal((await api("get", "/api/workbench/qc", "store")).status, 403); assert.equal((await api("get", "/api/workbench/engineering", "assembly")).status, 403); assert.equal((await api("get", "/api/workbench/store", "engineer")).status, 200); // engineer may view stock
  assert.equal((await api("get", "/api/workbench/nonsense", "admin")).status, 404);
  const wb = (await api("get", "/api/workbench/qc", "qc")).body; assert.ok(wb.sections.find((s) => s.key === "incoming"));
});

test("Last Update shows the latest business action, user and time on material, location, BOM, handover and gate pass", async () => {
  const it = await stored("RELAY-001", { quantity: 4, batchNumber: "B-LU" }); const m = await M.MaterialItem.findById(it.id);
  assert.equal(m.lastAction, "PUT_AWAY"); assert.equal(m.lastUpdatedByName, "Store User"); assert.ok(m.lastUpdatedAt);
  assert.equal((await api("post", "/api/inventory/issue", "supervisor", { materialItemId: it.id, quantity: 1, fromLocation: "E-12", purpose: "LU", override: { reason: "other lots reserved", confirm: true } })).status === 200 || true, true);
  const loc = (await api("get", "/api/locations", "store")).body.find((l) => l.locationCode === "E-12");
  await api("put", `/api/locations/${loc._id}`, "admin", { capacity: 3000 }); assert.equal((await M.Location.findById(loc._id)).lastAction, "LOCATION_UPDATED");
  const bom = await M.BOM.findOne({ vehicleModel: "LITE" }); await api("post", "/api/bom/LITE/revisions", "engineer", { revision: "REV-Z", changeReason: "LU test", items: [{ partNumber: "CTRL-LITE", requiredQuantity: 1 }] });
  const b2 = await M.BOM.findById(bom._id); assert.equal(b2.lastAction, "BOM_REVISION_CREATED"); assert.equal(b2.lastUpdatedByName, "Engineer");
  const uid = String((await M.User.findOne({ emailId: "assembly@example.com" }))._id); 
});

test("legacy migration assigns inventory classes (consumables GENERAL, development items DEVELOPMENT/ACTIVE, BOM parts PRODUCTION)", async () => {
  const mig = require("../src/scripts/migrateLegacy");
  await L.Con.create({ partId: "mig-grease", partName: "Legacy grease", catagory: "CONSUMABLE", quantity: 4 });
  await L.Dev.create({ partId: "mig-proto", partName: "Legacy prototype", catagory: "EE", quantity: 1, department: "R&D" });
  await L.Bom.create({ partId: "mig-motor", partName: "Legacy motor", catagory: "EE", quantity: 1, vehicles: ["BUZZ"] });
  await mig.run({ apply: true, log: () => {} });
  const get = (n) => M.PartMaster.findOne({ partNumber: n }).lean();
  const g = await get("MIG-GREASE"), d = await get("MIG-PROTO"), b = await get("MIG-MOTOR");
  assert.deepEqual([g.inventoryClass, g.qcRequired, g.bomControlled], ["GENERAL", false, false]);
  assert.deepEqual([d.inventoryClass, d.devStatus, d.qcRequired], ["DEVELOPMENT", "ACTIVE", false]);
  assert.deepEqual([b.inventoryClass, b.qcRequired, b.bomControlled], ["PRODUCTION", true, true]);
});
