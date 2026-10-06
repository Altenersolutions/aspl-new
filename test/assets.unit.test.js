// Pure unit tests (no database): CSV row -> capital asset mapping and the presentation loader's dry-run build.
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret-0123456789";
const test = require("node:test"); const assert = require("node:assert");
const { mapRow, parseDate } = require("../src/domain/assets");
const { parseCsv } = require("../src/domain/csv");

test("maps the Excel register headings", () => {
  const rows = parseCsv('Sl No,ASSET NO,DESCRIPTION,LOCATION,QUANTITY,MAKE, Date,Invoice/ Bill Ref  No,From Vendor,ACCESSORIES/REMARKS,Total Amount include GST \n1,ASPL-FS-110-0040,"NOSE PLIER 6""",FABRICATION SHOP,2,EASTMAN,31/12/2020,INV-1,ORIENTAL TOOLS,N/A,"1,250"\n');
  const a = mapRow(rows[0]);
  assert.equal(a.assetNo, "ASPL-FS-110-0040"); assert.equal(a.areaCode, "FS"); assert.equal(a.quantity, 2); assert.equal(a.totalAmount, 1250);
  assert.equal(a.purchaseDate.toISOString().slice(0, 10), "2020-12-31"); assert.equal(a.vendor, "ORIENTAL TOOLS"); assert.equal(a.remarks, undefined);
});
test("rejects bad rows with a readable message", () => {
  assert.throws(() => mapRow({ description: "x" }), /Asset No/);
  assert.throws(() => mapRow({ assetno: "A1" }), /Description/);
  assert.throws(() => mapRow({ assetno: "A1", description: "x", quantity: "abc" }), /Quantity/);
  assert.throws(() => mapRow({ assetno: "A1", description: "x", date: "someday" }), /Date/);
  assert.throws(() => mapRow({ assetno: "A1", description: "x", status: "LOST" }), /Status/);
});
test("date formats", () => { assert.equal(parseDate("2026-09-01").toISOString().slice(0, 10), "2026-09-01"); assert.equal(parseDate("1/9/26").toISOString().slice(0, 10), "2026-09-01"); assert.equal(parseDate(""), undefined); assert.equal(parseDate("x"), null); });

test("presentation loader: everything builds and validates", () => {
  const { build, buildAssets, validateAll } = require("../src/scripts/loadPresentation");
  const mongoose = require("mongoose"); const id = () => new mongoose.Types.ObjectId();
  const out = build({ existingParts: new Set(), existingLocs: new Map(), existingSupplierCodes: new Set(), existingBoms: new Set(), existingVehicles: new Set(), partIdByNumber: new Map(), withDemoStock: true,
    special: { RECEIVING: id(), QC_HOLD: id(), REJECT: id() }, users: { store: { id: id(), name: "S" }, qc: { id: id(), name: "Q" } }, counters: { receipt: 0, txn: 0, qc: 0, ncr: 0 } });
  const assets = buildAssets();
  assert.deepEqual(validateAll(out, assets), []);
  assert.equal(out.bomRevs.length, 3); assert.ok(out.parts.length > 300); assert.ok(assets.length > 250);
  assert.ok(out.receipts.every((r) => r.invoiceNo.startsWith("DEMO-")), "all demo receipts are marked");
});
