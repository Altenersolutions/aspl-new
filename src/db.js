const mongoose = require("mongoose");
const config = require("./config");

let txSupported = false;

async function connect(uri = config.mongoUri) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    txSupported = !!(hello.setName || hello.msg === "isdbgrid");
  } catch { txSupported = false; }
  console.log(`Connected to MongoDB (multi-document transactions: ${txSupported ? "enabled" : "NOT available - using guarded writes with compensation"})`);
  return mongoose.connection;
}
const supportsTransactions = () => txSupported;
module.exports = { connect, supportsTransactions };
