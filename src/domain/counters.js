const { Counter } = require("../models");
async function nextId(name, prefix, pad = 6) {
  const c = await Counter.findOneAndUpdate({ name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${prefix}-${String(c.seq).padStart(pad, "0")}`;
}
module.exports = { nextId };
