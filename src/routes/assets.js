const express = require("express");
const { z } = require("zod");
const M = require("../models");
const { wrap, requirePerm, validate } = require("../middleware/common");
const { P } = require("../domain/permissions");
const { notFound, invalid } = require("../domain/errors");
const assets = require("../domain/assets");
const { audit } = require("../domain/audit");
const { toCsv, parseCsv } = require("../domain/csv");

const r = express.Router();
const str = (n = 200) => z.string().trim().max(n);
const body = z.object({
  assetNo: str(60).min(1), description: str(200).min(1), category: str(60).optional(), area: str(80).optional(), location: str(80).optional(),
  quantity: z.coerce.number().int().min(0).optional(), make: str(80).optional(), purchaseDate: str(40).optional(), invoiceNo: str(80).optional(),
  vendor: str(120).optional(), remarks: str(300).optional(), totalAmount: z.coerce.number().min(0).optional(), status: z.enum(assets.STATUSES).optional(),
});
const clean = (b) => { const o = { ...b }; if (o.purchaseDate !== undefined) { const d = assets.parseDate(o.purchaseDate); if (d === null) throw invalid("Date not understood (use YYYY-MM-DD)."); o.purchaseDate = d; } Object.keys(o).forEach((k) => (o[k] === "" || o[k] === undefined) && delete o[k]); return o; };

r.get("/assets", requirePerm(P.INV_VIEW, P.ENG_VIEW, P.REPORTS), wrap(async (req, res) => { const { rows, total } = await assets.list(req.query); res.set("X-Total-Count", String(total)).json(rows); }));
r.get("/assets/summary", requirePerm(P.INV_VIEW, P.ENG_VIEW, P.REPORTS), wrap(async (req, res) => res.json(await assets.summary())));
r.get("/assets/export.csv", requirePerm(P.INV_VIEW, P.ENG_VIEW, P.REPORTS), wrap(async (req, res) => {
  const { rows } = await assets.list({ ...req.query, limit: 5000 });
  const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "");
  const csv = toCsv(rows, [["Asset No", "assetNo"], ["Description", "description"], ["Category", "category"], ["Area", "area"], ["Quantity", "quantity"], ["Make", "make"], ["Purchase Date", (x) => d(x.purchaseDate)], ["Invoice No", "invoiceNo"], ["Vendor", "vendor"], ["Remarks", "remarks"], ["Total Amount (incl. GST)", "totalAmount"], ["Status", "status"]]);
  res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", `attachment; filename="capital-assets-${new Date().toISOString().slice(0, 10)}.csv"`).send("\uFEFF" + csv);
}));
r.post("/assets", requirePerm(P.ADMIN_MASTER), validate(body), wrap(async (req, res) => {
  if (await M.CapitalAsset.exists({ assetNo: req.body.assetNo })) throw invalid(`Asset ${req.body.assetNo} already exists.`);
  const a = await M.CapitalAsset.create(clean(req.body));
  await audit(null, req.user, { action: "ASSET_CREATED", entityType: "CapitalAsset", entityId: a._id, entityLabel: a.assetNo, after: { description: a.description } });
  res.status(201).json(a);
}));
r.put("/assets/:id", requirePerm(P.ADMIN_MASTER), validate(body.partial()), wrap(async (req, res) => {
  const a = await M.CapitalAsset.findById(req.params.id); if (!a) throw notFound("Asset");
  a.set(clean(req.body)); await a.save();
  await audit(null, req.user, { action: "ASSET_UPDATED", entityType: "CapitalAsset", entityId: a._id, entityLabel: a.assetNo });
  res.json(a);
}));
r.post("/import/assets", requirePerm(P.ADMIN_MASTER), validate(z.object({ csv: z.string().max(1200000), dryRun: z.boolean().optional() })), wrap(async (req, res) => res.json(await assets.importCsv(req.user, parseCsv(req.body.csv), !!req.body.dryRun))));

module.exports = r;
