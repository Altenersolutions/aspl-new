const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const { ensureBaseData } = require("./scripts/baseData");

(async () => {
  await db.connect();
  await ensureBaseData();          // special locations + first-run notice; never touches existing data
  if (process.env.SEED_ON_START === "true") { await require("./scripts/seed").seed({ quiet: false }); } // idempotent demo master data (parts, BOMs, locations, vehicles)
  const app = createApp();
  app.listen(config.port, () => console.log(`Server running on port ${config.port}`));
})().catch((e) => { console.error("Fatal:", e); process.exit(1); });
