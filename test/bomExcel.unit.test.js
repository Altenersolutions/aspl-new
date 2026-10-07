process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef";
// No database needed: Excel parsing, merging, and the dry-run plan (models are stubbed).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const M = require("../src/models");
const { parseRows, importBomExcel } = require("../src/domain/bomExcel");

async function book(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) { const ws = wb.addWorksheet(name); rows.forEach((r) => ws.addRow(r)); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const rows = [
  ["BUZZ VEHICLE BOM"], [],
  ["S.NO", "PART NO", "DESCRIPTION", "QTY", "ASSEMBLY", "SUPPLIER"],
  [1, "", "Center Chassis", 1, "Chassis", ""],
  [2, "", "RHS Trailing Arm", "", "Rear Suspension", "Moh"],
  [3, "", "RHS Trailing Arm", 1, "Trailing Arm RH", ""],
  [4, "", "Bolt M8x30", 12, "Chassis", ""],
  [5, "CTRL-001", "VCU", 1, "Dashboard", ""],
  [6, "", "Contactor", { error: "#REF!" }, "Battery box", ""],
  [7, "", "", "", "", ""],
  ["", "", "Total", 3, "", ""],
];
test("parses header, merges duplicates, defaults blank qty, skips junk", () => {
  const r = parseRows(rows);
  assert.equal(r.header.row, 3);
  assert.equal(r.lines.length, 5);
  const arm = r.lines.find((l) => l.name === "RHS Trailing Arm");
  assert.equal(arm.qty, 2); assert.deepEqual(arm.positions, ["Rear Suspension", "Trailing Arm RH"]);
  assert.equal(r.lines.find((l) => l.name === "Contactor").qtyDefaulted, true);
  assert.equal(r.lines.find((l) => l.partNumber === "CTRL-001").name, "VCU");
});
test("rejects a sheet with no recognisable header", () => assert.throws(() => parseRows([["a", "b"], [1, 2]]), /header row/));
test("dry run: ID-less lines match existing parts by name, others become provisional; writes nothing", async () => {
  const buf = await book({ Notes: [["x"]], Buzz: rows });
  const orig = { b: M.BOM.findOne, r: M.BOMRevision.exists, p: M.PartMaster.find, s: M.Supplier.find };
  M.BOM.findOne = async () => null; M.BOMRevision.exists = async () => null;
  M.PartMaster.find = () => ({ lean: async () => [{ _id: 1, partNumber: "MECH-0001", partName: "center chassis", description: "", trackingType: "BATCH" }, { _id: 2, partNumber: "CTRL-001", partName: "VCU", description: "", trackingType: "SERIAL" }] });
  M.Supplier.find = () => ({ lean: async () => [] });
  try {
    const r = await importBomExcel({ id: "u" }, "buzz", { revision: "REV-A", changeReason: "t" }, buf, { dryRun: true });
    assert.equal(r.sheet, "Buzz"); assert.equal(r.bomLines, 5); assert.equal(r.mergedDuplicates, 1);
    assert.equal(r.usedExistingByName, 1); assert.equal(r.usedExistingById, 1); assert.equal(r.createdProvisional, 3); assert.equal(r.quantityDefaultedTo1, 1);
  } finally { M.BOM.findOne = orig.b; M.BOMRevision.exists = orig.r; M.PartMaster.find = orig.p; M.Supplier.find = orig.s; }
});

test("same name with different specification stays two parts; hierarchical (assembly + numbered parts) layout", () => {
  const r = parseRows([
    ["FINAL REVISION- BOM OF MECHANICAL (PREMIUM MODEL)"],
    ["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "PART ID", "QTY"],
    [1, "", "Chassis Assy", "Chassis Assy"],
    ["", 1, "A", "Hex Bolt", "M8 40L", "", 4], ["", 2, "B", "Hex Bolt", "M10 40L", "", 2], ["", 3, "C", "Hex Bolt", "M8 40L", "", 2],
    [2, "", "Door", "Door"],
    ["", 1, "A", "Hex Bolt", "M8 40L", "", 6], ["", 2, "B", "Door Panel", "-", "9001", 1],
    ["FINAL REVISION- BOM OF ELECTRICAL (PREMIUM MODEL)"],
    ["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "PART ID", "QTY"],
    [1, "", "", "Head Light"], ["", 1, "A", "LED Lamp", "", "", 1],
  ]);
  assert.equal(r.lines.length, 4);
  const m8 = r.lines.find((l) => l.spec === "M8 40L"); assert.equal(m8.qty, 12); assert.deepEqual(m8.positions, ["Chassis Assy", "Door"]);
  assert.equal(r.lines.find((l) => l.name === "Hex Bolt" && l.spec === "M10 40L").qty, 2);
  assert.equal(r.lines.find((l) => l.partNumber === "9001").category, "MECHANICAL");
  const lamp = r.lines.find((l) => l.name === "LED Lamp"); assert.equal(lamp.category, "ELECTRICAL"); assert.deepEqual(lamp.positions, ["Head Light"]);
});

test("real import (stubbed DB): rows from the browser, parts bulk-inserted once, TMP numbers sequential, BOM draft created", async () => {
  const q = (v) => ({ then: (res, rej) => Promise.resolve(v).then(res, rej), lean: async () => v });
  const saved = {}; const orig = {};
  const stub = (obj, k, fn) => { orig[`${obj.modelName}.${k}`] = [obj, k, obj[k]]; obj[k] = fn; };
  const bom = { _id: "64b000000000000000000001", vehicleModel: "BUZZ" };
  stub(M.BOM, "findOne", () => q(bom)); stub(M.BOM, "findOneAndUpdate", async () => ({}));
  stub(M.BOMRevision, "exists", async () => null);
  stub(M.BOMRevision, "create", async ([d]) => { saved.rev = d; return [d]; });
  stub(M.PartMaster, "find", () => ({ lean: async () => [{ _id: "e1", partNumber: "MECH-0001", partName: "Center Chassis", description: "", trackingType: "BATCH" }] }));
  stub(M.PartMaster, "insertMany", async (docs) => { saved.parts = docs; return docs; });
  stub(M.PartRevision, "insertMany", async (docs) => { saved.revs = docs; return docs; });
  stub(M.Supplier, "find", () => ({ lean: async () => [] }));
  stub(M.Counter, "findOneAndUpdate", async (f, u) => ({ seq: 40 + u.$inc.seq }));
  stub(M.AuditLog, "create", async ([d]) => { (saved.audit = saved.audit || []).push(d.action); return [d]; });
  try {
    const r = await importBomExcel({ id: "64b0000000000000000000aa", name: "T" }, "buzz", { revision: "REV-B", changeReason: "x" }, null || { sheetName: "Buzz", rows }, {});
    assert.equal(saved.parts.length, 4);                       // Chassis exists; 4 new (Arm, Bolt, VCU is ID-less->TMP, Contactor) minus CTRL-001 given-id
    assert.deepEqual(saved.parts.filter((p) => p.provisional).map((p) => p.partNumber), ["TMP-00041", "TMP-00042", "TMP-00043"].slice(0, saved.parts.filter((p) => p.provisional).length));
    assert.equal(saved.revs.length, saved.parts.length);
    assert.equal(saved.rev.items.length, 5); assert.equal(saved.rev.status, "DRAFT");
    assert.deepEqual(saved.audit, ["PARTS_CREATED_BY_IMPORT", "BOM_REVISION_CREATED"]);
    assert.equal(r.status, "DRAFT");
  } finally { for (const [o, k, f] of Object.values(orig)) o[k] = f; }
});
