// Unit of work: makes multi-step inventory operations all-or-nothing.
//  * Replica set / Atlas: real MongoDB multi-document transaction.
//  * Standalone mongod (dev, tests): every write registers an inverse so a failure part-way
//    rolls the earlier steps back (compensation). Stock decrements are additionally guarded
//    with conditional updates ({quantity: {$gte: n}}) so races cannot drive stock negative.
const mongoose = require("mongoose");
const { supportsTransactions } = require("../db");

const rawDelete = (Model, id) => Model.collection.deleteOne({ _id: id });

function makeCtx(session, undo) {
  const opt = session ? { session } : {};
  return {
    session,
    opt,
    async create(Model, data) {
      const [doc] = await Model.create([data], opt);
      if (!session) undo.push(() => rawDelete(Model, doc._id));
      return doc;
    },
    // set fields on one document, remembering old values
    async set(Model, id, patch, guard = {}) {
      const prev = await Model.findOne({ _id: id, ...guard }, null, opt).lean();
      if (!prev) return null;
      const res = await Model.findOneAndUpdate({ _id: id, ...guard }, { $set: patch }, { ...opt, new: true });
      if (!res) return null;
      if (!session) {
        const old = {};
        Object.keys(patch).forEach((k) => { old[k] = prev[k] === undefined ? null : prev[k]; });
        undo.push(() => Model.collection.updateOne({ _id: id }, { $set: old }));
      }
      return res;
    },
    // guarded increment; returns updated doc or null when the guard fails
    async inc(Model, filter, delta, { upsert = false, setOnInsert } = {}) {
      const update = { $inc: { quantity: delta } };
      if (setOnInsert) update.$setOnInsert = setOnInsert;
      const res = await Model.findOneAndUpdate(filter, update, { ...opt, new: true, upsert });
      if (res && !session) undo.push(() => Model.collection.updateOne({ _id: res._id }, { $inc: { quantity: -delta } }));
      return res;
    },
    onUndo(fn) { if (!session) undo.push(fn); },
  };
}

async function atomic(fn) {
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await fn(makeCtx(session, [])); });
      return result;
    } finally { session.endSession(); }
  }
  const undo = [];
  try {
    return await fn(makeCtx(null, undo));
  } catch (err) {
    for (const u of undo.reverse()) {
      try { await u(); } catch (e) { console.error("ROLLBACK STEP FAILED", e); }
    }
    throw err;
  }
}
module.exports = { atomic };
