// Development components: DRAFT -> ENGINEERING_REVIEW -> APPROVED -> ACTIVE. Not forced through the production/vehicle workflow.
const { PartMaster, PartRevision, PartImage, FileBlob, MaterialItem } = require("../models");
const { DEV_SUBCATEGORIES } = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { rules } = require("./partRules");
const s = (v) => (v == null ? "" : String(v).trim());

async function dev(partId) {
  const p = await PartMaster.findById(partId); if (!p) throw notFound("Part", partId);
  if (rules(p).inventoryClass !== "DEVELOPMENT") throw new BusinessError("NOT_DEVELOPMENT", `${p.partNumber} is not a development component.`);
  return p;
}
function checkSub(cls, sub) { if (cls === "DEVELOPMENT" && !DEV_SUBCATEGORIES.includes(sub)) throw invalid(`Development components need a subcategory: ${DEV_SUBCATEGORIES.join(", ")}.`); }

async function move(user, partId, from, to, action, note) {
  const p = await dev(partId); const cur = p.devStatus || "ACTIVE";
  if (cur !== from) throw new BusinessError("INVALID_STATE_TRANSITION", `Development component is ${cur}; expected ${from}.`, { details: { from: cur, to } });
  return atomic(async (ctx) => {
    await ctx.set(PartMaster, p._id, { devStatus: to, devReviewNote: note || p.devReviewNote });
    if (to === "APPROVED") { const rev = await PartRevision.findOne({ part: p._id, revision: p.currentRevision }); if (rev && rev.status === "DRAFT") await ctx.set(PartRevision, rev._id, { status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), effectiveDate: new Date() }); }
    await audit(ctx, user, { action, entityType: "Part", entityId: p._id, entityLabel: p.partNumber, reason: note, before: { devStatus: cur }, after: { devStatus: to } });
    return { ok: true, devStatus: to };
  });
}
const submit = (u, id) => move(u, id, "DRAFT", "ENGINEERING_REVIEW", "DEV_SUBMITTED_FOR_REVIEW");
const approve = (u, id, note) => move(u, id, "ENGINEERING_REVIEW", "APPROVED", "DEV_APPROVED", note);
const activate = (u, id) => move(u, id, "APPROVED", "ACTIVE", "DEV_ACTIVATED");
async function reject(u, id, note) { if (!s(note)) throw invalid("A reason is required to send a component back to draft."); return move(u, id, "ENGINEERING_REVIEW", "DRAFT", "DEV_REJECTED", note); }

async function addImage(user, partId, body) {
  const p = await dev(partId);
  const rev = s(body.revision) || p.currentRevision;
  if (!(await PartRevision.exists({ part: p._id, revision: rev }))) throw invalid(`${p.partNumber} has no revision ${rev}.`);
  if (!["image/jpeg", "image/png", "image/webp"].includes(body.mime)) throw invalid("Images must be JPEG, PNG or WebP.");
  const data = Buffer.from(body.dataBase64, "base64"); if (!data.length || data.length > 800 * 1024) throw invalid("Image must be between 1 byte and 800 KB.");
  return atomic(async (ctx) => {
    const f = await ctx.create(FileBlob, { name: s(body.name) || "image", mime: body.mime, size: data.length, data, uploadedBy: user.id });
    const img = await ctx.create(PartImage, { part: p._id, partNumber: p.partNumber, revision: rev, file: f._id, name: f.name, mime: f.mime, caption: s(body.caption), uploadedBy: user.id, uploadedByName: user.name });
    await audit(ctx, user, { action: "DEV_IMAGE_ADDED", entityType: "Part", entityId: p._id, entityLabel: `${p.partNumber} ${rev}`, after: { image: f.name, revision: rev } });
    return { id: img._id, revision: rev, url: `/api/files/${f._id}` };
  });
}
async function images(partId) {
  const p = await PartMaster.findById(partId); if (!p) throw notFound("Part", partId);
  const rows = await PartImage.find({ part: p._id }).sort({ revision: 1, uploadedAt: -1 }).lean();
  const revs = await PartRevision.find({ part: p._id }).sort({ createdAt: 1 }).lean();
  return revs.map((r) => ({ revision: r.revision, status: r.status, images: rows.filter((i) => i.revision === r.revision).map((i) => ({ id: i._id, url: `/api/files/${i.file}`, name: i.name, caption: i.caption, uploadedBy: i.uploadedByName, uploadedAt: i.uploadedAt })) }));
}
module.exports = { checkSub, submit, approve, reject, activate, addImage, images };
