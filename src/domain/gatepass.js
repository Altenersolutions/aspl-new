// Gate Pass: create / view / print / reprint on the existing InventoryGatePass collection (no second system).
const L = require("../models/legacy");
const { Setting } = require("../models");
const { BusinessError, notFound, invalid, forbidden } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { can, P } = require("./permissions");
const s = (v) => (v == null ? "" : String(v).trim());
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function nextRef() { const c = await L.Counter.findOneAndUpdate({ name: "gatepass" }, { $inc: { seq: 1 } }, { new: true, upsert: true }); return `GP-${String(c.seq).padStart(4, "0")}`; }
async function load(id) {
  const gp = /^[a-f\d]{24}$/i.test(String(id)) ? await L.GatePass.findById(id) : await L.GatePass.findOne({ refNo: String(id) });
  if (!gp) throw notFound("Gate pass", id); return gp;
}
async function create(user, body) {
  const items = (body.items || []).map((i) => ({ name: s(i.name), partNumber: s(i.partNumber), serialBatch: s(i.serialBatch), qty: s(i.qty), uom: s(i.uom) || "NOS" })).filter((i) => i.name || i.partNumber);
  if (!s(body.supplier)) throw invalid("'To / Supplier' is required.");
  if (!items.length) throw invalid("Add at least one item.");
  if (items.some((i) => !i.qty || !(Number(i.qty) > 0))) throw invalid("Every item needs a quantity greater than zero.");
  if (body.returnable && !s(body.returnDate)) throw invalid("An expected return date is required for a returnable gate pass.");
  return atomic(async (ctx) => {
    const gp = await ctx.create(L.GatePass, { refNo: await nextRef(), date: s(body.date) || new Date().toISOString().slice(0, 10), supplier: s(body.supplier), dispatchMode: s(body.dispatchMode), returnable: !!body.returnable, returnDate: body.returnable ? s(body.returnDate) : "", remarks: s(body.remarks),
      items, preparedBy: user.name, issuedBy: s(body.issuedBy), receivedBy: s(body.receivedBy), createdBy: user.id, createdByName: user.name, status: "ISSUED" });
    await audit(ctx, user, { action: "GATE_PASS_CREATED", entityType: "GatePass", entityId: gp._id, entityLabel: gp.refNo, after: { to: gp.supplier, items: items.length, returnable: gp.returnable } });
    return gp;
  });
}
async function company() {
  const row = await Setting.findOne({ key: "company.name" }).lean();
  return (row && row.value) || process.env.COMPANY_NAME || "Company Name";
}
function renderHtml(gp, { printNo, reprint, printedBy, companyName }) {
  const rows = (gp.items || []).map((i, n) => `<tr><td class="c">${n + 1}</td><td>${esc(i.name)}</td><td>${esc(i.partNumber)}</td><td>${esc(i.serialBatch)}</td><td class="r">${esc(i.qty)}</td><td class="c">${esc(i.uom || "NOS")}</td></tr>`).join("");
  const blank = Math.max(0, 8 - (gp.items || []).length);
  const pad = Array.from({ length: blank }, () => `<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>`).join("");
  const sig = (title, name, when) => `<div class="sig"><div class="line"></div><b>${title}</b><br>Name: ${esc(name) || "&nbsp;"}<br>Signature: ______________________<br>Date / Time: ${esc(when) || "______________"}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(gp.refNo)}</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:12px/1.4 Arial,Helvetica,sans-serif;color:#000;margin:0}
.hd{display:flex;align-items:center;gap:14px;border-bottom:2px solid #000;padding-bottom:8px}.logo{width:70px;height:70px;border:1px dashed #666;display:flex;align-items:center;justify-content:center;font-size:9px;color:#666;text-align:center}
.co{flex:1}.co h1{margin:0;font-size:20px}.co div{font-size:11px;color:#333}h2{text-align:center;letter-spacing:4px;margin:12px 0;font-size:20px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-bottom:10px}.meta div{border-bottom:1px solid #999;padding:3px 0}.meta span{color:#555;display:inline-block;min-width:120px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #000;padding:5px 6px;vertical-align:top}th{background:#eee}.c{text-align:center}.r{text-align:right}
.rm{border:1px solid #000;margin-top:10px;padding:6px;min-height:42px}.sigs{display:flex;gap:24px;margin-top:36px}.sig{flex:1;font-size:11px}.sig .line{border-top:1px solid #000;margin-bottom:4px}
.foot{margin-top:16px;font-size:9px;color:#555;display:flex;justify-content:space-between}.wm{position:fixed;top:45%;left:12%;font-size:90px;color:rgba(200,0,0,.12);transform:rotate(-25deg);pointer-events:none}
.noprint{margin:10px 0}@media print{.noprint{display:none!important}}</style></head><body>
${reprint ? `<div class="wm">REPRINT ${printNo - 1}</div>` : ""}
<div class="noprint"><button onclick="window.print()">Print</button></div>
<div class="hd"><div class="logo">LOGO</div><div class="co"><h1>${esc(companyName)}</h1><div>Stores / Dispatch</div></div><div style="text-align:right"><b>${esc(gp.refNo)}</b><br>${reprint ? `REPRINT #${printNo - 1}` : "ORIGINAL"}</div></div>
<h2>GATE PASS</h2>
<div class="meta"><div><span>Gate Pass No.</span><b>${esc(gp.refNo)}</b></div><div><span>Date</span>${esc(gp.date)}</div><div><span>To / Supplier</span>${esc(gp.supplier)}</div><div><span>Dispatch Mode</span>${esc(gp.dispatchMode)}</div>
<div><span>Returnable</span>${gp.returnable ? "Yes" : "No"}</div><div><span>Expected Return Date</span>${gp.returnable ? esc(gp.returnDate) : "—"}</div></div>
<table><thead><tr><th style="width:36px">Sr No</th><th>Item</th><th>Part No</th><th>Serial / Batch</th><th style="width:60px">Qty</th><th style="width:50px">UOM</th></tr></thead><tbody>${rows}${pad}</tbody></table>
<div class="rm"><b>Remarks:</b> ${esc(gp.remarks)}</div>
<div class="sigs">${sig("Prepared By", gp.preparedBy, gp.createdAt ? new Date(gp.createdAt).toLocaleString("en-GB") : "")}${sig("Issued By", gp.issuedBy, "")}${sig("Received By", gp.receivedBy, "")}</div>
<div class="foot"><span>Printed by ${esc(printedBy)} on ${new Date().toLocaleString("en-GB")}</span><span>Print #${printNo}${reprint ? " (reprint)" : ""}</span></div>
</body></html>`;
}
// First print needs gatepass.print; every later print is a REPRINT and needs gatepass.reprint plus a reason. All are audited.
async function print(user, id, body = {}) {
  const gp = await load(id); const reprint = (gp.printCount || 0) > 0;
  if (!(await can(user.role, reprint ? P.GP_REPRINT : P.GP_PRINT))) throw forbidden(reprint ? "You are not authorised to reprint gate passes." : "You are not authorised to print gate passes.");
  if (reprint && s(body.reason).length < 3) throw new BusinessError("REPRINT_REASON_REQUIRED", "A reason is required to reprint a gate pass.", { status: 400 });
  const printNo = (gp.printCount || 0) + 1;
  const log = [...(gp.printLog || []).map((x) => x.toObject ? x.toObject() : x), { no: printNo, at: new Date(), byId: user.id, byName: user.name, reprint, reason: s(body.reason) }];
  const updated = await atomic(async (ctx) => {
    const u = await ctx.set(L.GatePass, gp._id, { printCount: printNo, printLog: log, lastPrintedAt: new Date(), lastPrintedByName: user.name });
    await audit(ctx, user, { action: reprint ? "GATE_PASS_REPRINTED" : "GATE_PASS_PRINTED", entityType: "GatePass", entityId: gp._id, entityLabel: gp.refNo, reason: s(body.reason) || undefined, after: { printNo } });
    return u;
  });
  return { gatePass: updated, printNo, reprint, html: renderHtml(updated, { printNo, reprint, printedBy: user.name, companyName: await company() }) };
}
module.exports = { create, load, print, nextRef, renderHtml };
