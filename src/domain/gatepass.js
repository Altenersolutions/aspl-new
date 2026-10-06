// Gate Pass: create / view / print / reprint on the existing InventoryGatePass collection (no second system).
const L = require("../models/legacy");
const { Setting } = require("../models");
const { BusinessError, notFound, invalid, forbidden } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { can, P } = require("./permissions");
const s = (v) => (v == null ? "" : String(v).trim());
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function nextRef() { const c = await L.Counter.findOneAndUpdate({ name: "gatepass" }, { $inc: { seq: 1 } }, { new: true, upsert: true }); return `ASPL-GP-${String(c.seq).padStart(4, "0")}`; }
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
  return (row && row.value) || process.env.COMPANY_NAME || COMPANY_DEFAULT;
}
const COMPANY_DEFAULT = "ALTENER SOLUTIONS OPC PRIVATE LIMITED";
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "Survey No 81/1, Site No 16, Babanna Layout, Near Delhi Public International School, Mallasandra, Off Hesaraghatta Road, Bengaluru – 560057, Karnataka.";
const COMPANY_GSTIN = process.env.COMPANY_GSTIN || "29AATCA4078Q1ZK";
// Layout follows the company's standard MATERIAL GATE PASS (header, Ref/Date, returnable, dispatch mode, items, remark, supplier, "From ASPL", address + GSTIN).
function renderHtml(gp, { printNo, reprint, printedBy, companyName }) {
  const items = (gp.items || []).length ? gp.items : [{}];
  const rows = items.map((i, n) => {
    return `<tr><td class="sl">${i.name ? n + 1 : "-"}</td><td>${esc(i.name) || "-"}</td><td class="q">${esc(i.qty) || "-"}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(gp.refNo)}</title><style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}
body{font-family:Roboto,Arial,Helvetica,sans-serif;color:#000;margin:0;font-size:14px;line-height:1.45}
.page{border:1px solid #555;min-height:270mm;position:relative}
.co{margin:0;padding:14px 10px 0;text-align:center;font-size:25px;font-weight:700;color:rgba(222,146,34,.87)}
.ttl{margin:8px 0 0;padding:10px 0 0;border-top:1px solid #555;text-align:center;font-size:22px;font-weight:700}
.in{padding:0 24px}.top{display:flex;justify-content:space-between;margin-top:26px;font-size:15px}
.ret{margin-top:16px;font-size:20px;font-weight:700}.ret .dr{margin-left:24px;font-size:16px}.ret .dv{font-weight:400;font-size:16px}
.h{margin-top:18px;font-size:20px;font-weight:700}.v{font-size:15px}
table{width:calc(100% - 48px);margin:20px 24px 0;border-collapse:collapse;border:1px solid #555}
th{background:#eee;text-align:left;font-size:13px;padding:8px 10px;border-bottom:1px solid #555}td{font-size:12px;padding:6px 10px;border-bottom:1px solid #ddd;vertical-align:top}
.sl{width:72px;white-space:nowrap}.q{width:90px}.sub{font-size:10px;color:#444;margin-top:2px}
.bx{border:1px solid #555;border-radius:4px;margin:8px 24px 0;padding:14px}.bx .t{font-size:20px;font-weight:700}.bx .val{font-size:16px;margin-top:6px;white-space:pre-wrap}
.ppl{font-size:10px;color:#333;margin-top:62px}
.addr{border-top:1px solid #555;margin:10px 24px 0;padding-top:8px;text-align:center;font-size:11px}.gst{text-align:center;font-size:13px;padding-bottom:12px}
.foot{display:flex;justify-content:space-between;margin-top:6px;font-size:9px;color:#555}
.wm{position:fixed;top:42%;left:10%;font-size:90px;color:rgba(200,0,0,.12);transform:rotate(-25deg);pointer-events:none}
.noprint{margin:0 0 10px}@media print{.noprint{display:none!important}}
</style></head><body>
${reprint ? `<div class="wm">REPRINT ${printNo - 1}</div>` : ""}
<div class="noprint"><button onclick="window.print()">Print</button></div>
<div class="page">
<h1 class="co">${esc(companyName || COMPANY_DEFAULT)}</h1>
<div class="ttl">MATERIAL GATE PASS</div>
<div class="in">
<div class="top"><span><b>Ref No:</b> ${esc(gp.refNo) || "-"}</span><span><b>Date:</b> ${esc(gp.date) || "-"}</span></div>
<div class="ret">Returnable ${gp.returnable ? "[ ✔ ]" : "[ ✖ ]"}${gp.returnable ? `<span class="dr">Date of Return: <span class="dv">${esc(gp.returnDate) || "-"}</span></span>` : ""}</div>
<div class="h">Material Dispatch Mode</div><div class="v">${esc(gp.dispatchMode) || "-"}</div>
</div>
<table><thead><tr><th>SL NO</th><th>NAME &amp; FULL DESCRIPTION OF THE ITEM</th><th>QTY</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bx" style="min-height:80px"><div class="t">Remark:</div><div class="val">${esc(gp.remarks) || "-"}</div></div>
<div class="bx" style="min-height:110px"><div class="t">Supplier Details:</div><div class="val">${esc(gp.supplier) || "-"}</div></div>
<div class="bx" style="min-height:130px"><div class="t" style="font-weight:400">From ASPL:</div></div>
<div class="addr">${esc(COMPANY_ADDRESS)}</div><div class="gst">GSTIN: ${esc(COMPANY_GSTIN)}</div>
</div>
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
    const guard = (gp.printCount || 0) === 0 ? { $or: [{ printCount: 0 }, { printCount: { $exists: false } }] } : { printCount: gp.printCount };
    const u = await ctx.set(L.GatePass, gp._id, { printCount: printNo, printLog: log, lastPrintedAt: new Date(), lastPrintedByName: user.name }, guard);
    if (!u) throw new BusinessError("PRINT_CONFLICT", "This gate pass was just printed by someone else. Refresh and try again.", { status: 409 });
    await audit(ctx, user, { action: reprint ? "GATE_PASS_REPRINTED" : "GATE_PASS_PRINTED", entityType: "GatePass", entityId: gp._id, entityLabel: gp.refNo, reason: s(body.reason) || undefined, after: { printNo } });
    return u;
  });
  return { gatePass: updated, printNo, reprint, html: renderHtml(updated, { printNo, reprint, printedBy: user.name, companyName: await company() }) };
}
module.exports = { create, load, print, nextRef, renderHtml };
