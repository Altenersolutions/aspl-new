const M = require("../models");
const { MS } = require("./constants");
const assembly = require("./assembly");
const day = 86400000;
const env = (k, d) => Number(process.env[k] || d);

async function alerts() {
  const now = Date.now(); const out = [];
  const push = (type, severity, title, items, link) => items.length && out.push({ type, severity, title, count: items.length, items: items.slice(0, 10), link });
  const stock = await M.StockBalance.find({ quantity: { $gt: 0 } }).populate("materialItem", "status part partNumber").populate("location", "type").lean();
  const byPart = {}; stock.filter((b) => b.materialItem && b.materialItem.status === MS.APPROVED && b.location.type === "BIN").forEach((b) => (byPart[b.materialItem.part] = (byPart[b.materialItem.part] || 0) + b.quantity));
  const parts = await M.PartMaster.find({ active: true, minStock: { $gt: 0 } }).lean();
  push("LOW_STOCK", "high", "Below minimum stock", parts.filter((p) => (byPart[p._id] || 0) < p.minStock).map((p) => `${p.partNumber}: ${byPart[p._id] || 0} / min ${p.minStock}`), "#/parts");
  const qcDays = env("ALERT_QC_PENDING_DAYS", 2), holdDays = env("ALERT_HOLD_DAYS", 7), hoHours = env("ALERT_HANDOVER_HOURS", 24), slow = env("ALERT_SLOW_DAYS", 90);
  push("QC_WAITING", "medium", `Waiting for incoming QC > ${qcDays} day(s)`, (await M.MaterialItem.find({ status: MS.PENDING_INCOMING_QC, createdAt: { $lt: new Date(now - qcDays * day) } }).lean()).map((i) => `${i.partNumber} ${i.serialNumber || i.batchNumber}`), "#/qc-incoming");
  push("HOLD_LONG", "medium", `On QC hold > ${holdDays} days`, (await M.MaterialItem.find({ status: MS.HOLD, updatedAt: { $lt: new Date(now - holdDays * day) } }).lean()).map((i) => `${i.partNumber} ${i.serialNumber || i.batchNumber}`), "#/qc-retest");
  push("HANDOVER_UNANSWERED", "high", `Handover unanswered > ${hoHours} h`, (await M.Handover.find({ status: "PENDING", handedOverAt: { $lt: new Date(now - hoHours * 3600000) } }).lean()).map((h) => `${h.handoverId} → ${h.toUserName}`), "#/handover");
  push("OPEN_NCR", "medium", "Open non-conformances", (await M.Ncr.find({ status: { $ne: "CLOSED" } }).lean()).map((n) => `${n.ncrNo} ${n.partNumber}`), "#/ncr");
  let lastMap;
  try { lastMap = new Map((await M.InventoryTransaction.aggregate([{ $group: { _id: "$materialItem", last: { $max: "$timestamp" } } }])).map((x) => [String(x._id), x.last])); }
  catch { lastMap = new Map(); for (const t of await M.InventoryTransaction.find().select("materialItem timestamp").sort({ timestamp: -1 }).limit(200000).lean()) if (!lastMap.has(String(t.materialItem))) lastMap.set(String(t.materialItem), t.timestamp); } // portable fallback
  const slowItems = stock.filter((b) => b.location.type === "BIN" && b.materialItem && b.materialItem.status === MS.APPROVED && (lastMap.get(String(b.materialItem._id)) || 0) < now - slow * day).map((b) => `${b.materialItem.partNumber} (${b.quantity})`);
  push("SLOW_MOVING", "low", `No movement for ${slow}+ days`, slowItems, "#/inventory");
  push("OPEN_COUNTS", "low", "Cycle counts awaiting approval", (await M.CycleCount.find({ status: "SUBMITTED" }).lean()).map((c) => `${c.countId} ${c.locationCode}`), "#/counts");
  return { total: out.reduce((t, a) => t + a.count, 0), alerts: out };
}

async function analytics() {
  const sup = await M.Supplier.find().lean(); const supMap = new Map(sup.map((s) => [String(s._id), s.name]));
  const insp = await M.QCInspection.find({ inspectionType: "INCOMING" }).populate("materialItem", "supplier createdAt").lean();
  const q = {};
  for (const i of insp) { if (!i.materialItem) continue; const k = supMap.get(String(i.materialItem.supplier)) || "Unknown"; q[k] = q[k] || { supplier: k, pass: 0, fail: 0, hold: 0 }; q[k][i.result.toLowerCase()]++; }
  const supplierQuality = Object.values(q).map((x) => ({ ...x, total: x.pass + x.fail + x.hold, rejectionRate: +(100 * x.fail / Math.max(1, x.pass + x.fail + x.hold)).toFixed(1) })).sort((a, b) => b.rejectionRate - a.rejectionRate);
  const first = {}; insp.forEach((i) => { if (i.materialItem && (!first[i.materialItem._id] || i.createdAt < first[i.materialItem._id].at)) first[i.materialItem._id] = { at: i.createdAt, from: i.materialItem.createdAt }; });
  const hrs = Object.values(first).map((x) => (x.at - x.from) / 3600000);
  const qcTurnaroundHours = hrs.length ? +(hrs.reduce((a, b) => a + b, 0) / hrs.length).toFixed(1) : null;
  const stock = await M.StockBalance.find({ quantity: { $gt: 0 } }).populate("materialItem", "createdAt").populate("location", "type").lean();
  const ageing = { "0-30 d": 0, "31-90 d": 0, "91-180 d": 0, "180+ d": 0 };
  stock.filter((b) => b.location.type === "BIN" && b.materialItem).forEach((b) => { const d = (Date.now() - b.materialItem.createdAt) / day; ageing[d <= 30 ? "0-30 d" : d <= 90 ? "31-90 d" : d <= 180 ? "91-180 d" : "180+ d"] += b.quantity; });
  const vehicles = await M.Vehicle.find({ status: { $in: ["PLANNED", "UNDER_ASSEMBLY", "ASSEMBLED"] } }).lean(); const progress = [];
  for (const v of vehicles) { const view = await assembly.vehicleView(v); const m = view.items.filter((i) => !i.optional); const need = m.reduce((t, i) => t + i.required, 0), have = m.reduce((t, i) => t + Math.min(i.installed, i.required), 0); progress.push({ vehicleNumber: v.vehicleNumber, status: v.status, percent: need ? Math.round(100 * have / need) : 0 }); }
  const since = new Date(Date.now() - 14 * day); const tx = await M.InventoryTransaction.find({ timestamp: { $gte: since } }).select("transactionType timestamp").lean();
  const perDay = {}; tx.forEach((t) => { const k = t.timestamp.toISOString().slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; });
  return { supplierQuality, qcTurnaroundHours, stockAgeing: ageing, vehicleProgress: progress, transactionsPerDay: perDay };
}

async function search(term) {
  const t = String(term || "").trim(); if (t.length < 2) return { parts: [], materials: [], vehicles: [], locations: [], suppliers: [], pos: [] };
  const rx = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [parts, materials, vehicles, locations, suppliers, pos] = await Promise.all([
    M.PartMaster.find({ $or: [{ partNumber: rx }, { partName: rx }] }).limit(8).select("partNumber partName").lean(),
    M.MaterialItem.find({ $or: [{ serialNumber: rx }, { batchNumber: rx }, { invoiceNo: rx }] }).limit(8).select("partNumber serialNumber batchNumber status invoiceNo").lean(),
    M.Vehicle.find({ $or: [{ vehicleNumber: rx }, { vin: rx }] }).limit(8).select("vehicleNumber model status").lean(),
    M.Location.find({ $or: [{ locationCode: rx }, { name: rx }] }).limit(8).select("locationCode path type").lean(),
    M.Supplier.find({ $or: [{ code: rx }, { name: rx }] }).limit(5).select("code name").lean(),
    M.PurchaseOrder.find({ poNo: rx }).limit(5).select("poNo status").lean(),
  ]);
  return { parts, materials, vehicles, locations, suppliers, pos };
}
// ---- role workbenches: what THIS kind of user has to do right now ----
async function workbench(kind, user) {
  const sec = (key, title, items, link, hint) => ({ key, title, count: items.length, items: items.slice(0, 12), link, hint });
  const mat = (i) => ({ label: `${i.partNumber} ${i.serialNumber || i.batchNumber || ""}`, sub: `${i.status}${i.invoiceNo ? " · inv " + i.invoiceNo : ""}`, link: `#/scan/${encodeURIComponent(i.qrCode || i.serialNumber || i.batchNumber)}` });
  const myHo = (await M.Handover.find({ toUser: user.id, status: "PENDING" }).lean()).map((h) => ({ label: `${h.handoverId}: ${h.partNumber} ${h.serialNumber || h.batchNumber || ""} × ${h.quantity}`, sub: `from ${h.fromUserName}`, link: "#/handover" }));
  const out = [];
  if (kind === "store") {
    const rec = await M.Location.findOne({ type: "RECEIVING" });
    const wait = rec ? (await M.StockBalance.find({ location: rec._id, quantity: { $gt: 0 } }).populate("materialItem").lean()).filter((r) => r.materialItem && r.materialItem.status === MS.APPROVED).map((r) => mat(r.materialItem)) : [];
    out.push(sec("putaway", "Waiting to be put away", wait, "#/putaway", "Approved stock still in the Receiving area – scan it and follow the location guidance."));
    out.push(sec("ho", "Handovers waiting for you", myHo, "#/handover"));
    out.push(sec("kits", "Kits to pick and issue", (await M.Kit.find({ status: { $in: ["READY", "PARTIAL"] } }).lean()).map((k) => ({ label: `${k.kitId} · ${k.vehicleNumber}`, sub: k.status, link: "#/kits" })), "#/kits"));
    out.push(sec("po", "Open purchase orders", (await M.PurchaseOrder.find({ status: { $in: ["OPEN", "PARTIAL"] } }).populate("supplier", "name").lean()).map((p) => ({ label: p.poNo, sub: p.supplier && p.supplier.name, link: "#/po" })), "#/po"));
    out.push(sec("qcwait", "Received – waiting for incoming QC", (await M.MaterialItem.find({ status: MS.PENDING_INCOMING_QC }).sort({ createdAt: 1 }).limit(50).lean()).map(mat), "#/inventory?status=PENDING_INCOMING_QC"));
    const a = await alerts(); const low = a.alerts.find((x) => x.type === "LOW_STOCK"); out.push(sec("low", "Below minimum stock", low ? low.items.map((t) => ({ label: t, link: "#/parts" })) : [], "#/parts"));
  } else if (kind === "qc") {
    const q = async (status) => (await M.MaterialItem.find({ status }).sort({ createdAt: 1 }).limit(60).lean()).map(mat);
    out.push(sec("incoming", "Incoming QC", await q(MS.PENDING_INCOMING_QC), "#/qc-incoming", "Oldest first. Open an item to record PASS / HOLD / FAIL."));
    out.push(sec("hold", "On hold", await q(MS.HOLD), "#/qc-retest"));
    out.push(sec("retest", "Re-test / QC required", [...(await q(MS.PENDING_RETEST)), ...(await q(MS.QC_REQUIRED))], "#/qc-retest"));
    out.push(sec("rework", "Rejected / in rework", [...(await q(MS.REJECTED)), ...(await q(MS.REWORK))], "#/qc-rework"));
    out.push(sec("veh", "Vehicles awaiting final QC", (await M.Vehicle.find({ status: { $in: ["ASSEMBLED", "FINAL_QC"] } }).lean()).map((v) => ({ label: v.vehicleNumber, sub: v.status, link: `#/assembly/${encodeURIComponent(v.vehicleNumber)}` })), "#/vehicles"));
    out.push(sec("ncr", "Open non-conformances", (await M.Ncr.find({ status: { $ne: "CLOSED" } }).lean()).map((n) => ({ label: `${n.ncrNo} ${n.partNumber}`, sub: n.status, link: "#/ncr" })), "#/ncr"));
    out.push(sec("ho", "Handovers waiting for you", myHo, "#/handover"));
  } else if (kind === "assembly") {
    const vs = await M.Vehicle.find({ status: { $in: ["PLANNED", "UNDER_ASSEMBLY", "ASSEMBLED"] } }).lean(); const rows = [];
    for (const v of vs) { const view = await assembly.vehicleView(v); const m = view.items.filter((i) => !i.optional); const need = m.reduce((t, i) => t + i.required, 0), have = m.reduce((t, i) => t + Math.min(i.installed, i.required), 0); rows.push({ label: v.vehicleNumber, sub: `${v.status} · ${need ? Math.round(100 * have / need) : 0}% of BOM installed`, link: `#/assembly/${encodeURIComponent(v.vehicleNumber)}` }); }
    out.push(sec("veh", "Vehicles in build", rows, "#/vehicles", "Open a vehicle to scan components."));
    out.push(sec("ho", "Handovers waiting for you", myHo, "#/handover"));
    out.push(sec("kits", "Issued kits (material on the floor)", (await M.Kit.find({ status: "ISSUED" }).sort({ issuedAt: -1 }).limit(20).lean()).map((k) => ({ label: `${k.kitId} · ${k.vehicleNumber}`, sub: "issued", link: `#/assembly/${encodeURIComponent(k.vehicleNumber)}` })), "#/kits"));
    out.push(sec("recent", "Recent installations", (await M.Installation.find({ active: true }).sort({ installedAt: -1 }).limit(10).lean()).map((i) => ({ label: `${i.vehicleNumber}: ${i.partNumber} ${i.serialNumber || i.batchNumber || ""}`, sub: i.installedByName, link: "#/installs" })), "#/installs"));
  } else if (kind === "engineering") {
    const dev = (st) => M.PartMaster.find({ inventoryClass: "DEVELOPMENT", devStatus: st }).lean().then((a) => a.map((p) => ({ label: `${p.partNumber} ${p.partName}`, sub: `${p.currentRevision}${p.subCategory ? " · " + p.subCategory : ""}`, link: "#/devcomp" })));
    out.push(sec("review", "Development components awaiting review", await dev("ENGINEERING_REVIEW"), "#/devcomp", "Engineering approval needed."));
    out.push(sec("draft", "Development components in draft", await dev("DRAFT"), "#/devcomp"));
    out.push(sec("rev", "Draft part revisions", (await M.PartRevision.find({ status: "DRAFT" }).populate("part", "partNumber").lean()).map((r) => ({ label: `${r.part && r.part.partNumber} ${r.revision}`, sub: r.changeReason, link: "#/parts" })), "#/parts"));
    out.push(sec("bom", "Draft BOM revisions", (await M.BOMRevision.find({ status: "DRAFT" }).lean()).map((b) => ({ label: `${b.vehicleModel} ${b.revision}`, sub: b.changeReason, link: "#/bom" })), "#/bom"));
    out.push(sec("eco", "Engineering changes pending", (await M.Eco.find({ status: "DRAFT" }).lean()).map((e) => ({ label: `${e.ecoNo} ${e.partNumber}`, sub: `${e.fromRevision} → ${e.toRevision}`, link: "#/eco" })), "#/eco"));
  }
  return { kind, sections: out };
}
module.exports = { alerts, analytics, search, workbench };
