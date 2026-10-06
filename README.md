# Inventory, QC & Assembly Control System – Backend API (v3)

Node + Express + MongoDB. Upload this folder's contents to GitHub, connect it to Render.

## Render
Build `npm install --omit=dev` · Start `npm start` · Health check `/api/health`

| Env var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |
| `JWT_SECRET` | long random text (32+ chars) |
| `MONGO_URI` | Atlas string ending `/inventory?retryWrites=true&w=majority` |
| `CORS_ORIGINS` | your Netlify URL, no trailing slash |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first admin (only used while no users exist) |
| `SEED_ON_START` | `true` once for sample master data, then `false` |
| `SEED_DEMO_USERS` | `false` |
| `COMPANY_NAME` | printed in the Gate Pass header (or set Setting `company.name`) |

## Upgrading an existing database (automatic, safe to repeat)
On every start the server: gives each existing part an **inventory class** and explicit QC / FIFO / BOM / revision flags (consumables → General, development items → Development/ACTIVE, everything else → Production); translates saved role permissions from the old names (`material.*`, `engineering.manage`, `admin.master`) to the new granular ones and drops unknown names; and gives existing records a **Last Update** (their creation). Nothing is deleted. Existing gate passes are kept and can be printed.

## Concepts
* **Inventory class** (GENERAL / PRODUCTION / DEVELOPMENT) is what the stock *is*; **tracking type** (SERIAL / BATCH / QUANTITY) is how it is counted.
* GENERAL: receive → store → issue → return (no QC, BOM or vehicle needed). PRODUCTION: invoice → incoming QC → put-away → FIFO → reserve → issue/handover → BOM + revision validation → install → QC → traceability. DEVELOPMENT: draft → engineering review → approved → active; revisions with image history.
* Permissions are granular (`docs/API.md` lists the permission each endpoint needs). `scan.use` opens only the scanner.

`npm test` runs 63 end-to-end tests against a MongoDB on 127.0.0.1:27017. `npm run docs` regenerates `docs/API.md`.

## Presentation data (BOM + Capital Assets)
`src/data/bom.json` and `src/data/assets.json` were generated from `BOM.xlsx` and `Assets_List_2026_SEP.xlsx`. **Read `PRESENTATION_DATA_NOTES.md` first** – it lists what is real, what was derived, and what is demo.

```
npm run load:presentation -- --dry-run     # build + validate everything, writes nothing, no database needed
npm run load:presentation                  # load into the database in MONGO_URI  (use a separate TEST database)
npm run load:presentation -- --wipe-demo   # remove only the demo stock again (invoice numbers starting DEMO-)
npm run load:presentation -- --no-demo-stock   # real BOM + assets only
```
Run it against a fresh database (it refuses to run on one that already has parts unless you add `--force`). It is safe to run twice: existing part numbers are skipped and assets are matched on Asset No.

New: **Capital Assets** register (`/api/assets`, `/api/assets/summary`, `/api/assets/export.csv`, `/api/import/assets`) – separate from stock. View: inventory.view / engineering.view / reports.view. Add / edit / import: admin.master_data.
