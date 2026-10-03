# Inventory WMS – Backend API (Node + Express + MongoDB)

Upload this folder's contents to GitHub, then connect the repo to Render.

## Render settings (Web Service)
Build `npm install --omit=dev` · Start `npm start` · Health check `/api/health`

## Environment variables
| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |
| `JWT_SECRET` | long random text (32+ chars) |
| `MONGO_URI` | Atlas string ending `/inventory?retryWrites=true&w=majority` |
| `CORS_ORIGINS` | your Netlify URL, no trailing slash |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first admin (only used while no users exist) |
| `SEED_ON_START` | `true` once to create sample master data, then `false` |
| `SEED_DEMO_USERS` | `false` |
| `SERVE_LEGACY` | `false` |
| `ALERT_*` (optional) | alert thresholds, see `.env.example` |

## What's in v2.1
Scan engine · put-away guidance · receiving (mandatory invoice, optional PO matching) · QC state machine with per-part QC templates · NCR/CAPA · handover · BOM revisions + engineering change orders · assembly validation, installation/removal history · kitting & reservations (FIFO) · cycle counts · recall query & quarantine · build book · alerts & analytics · global search · CSV import/export · QC photo/PDF storage · TOTP two-factor + session revocation · append-only ledger/audit.

`docs/API.md` lists every endpoint with its permission (`npm run docs` regenerates it). `npm test` runs 36 end-to-end tests (needs MongoDB on 127.0.0.1:27017). `.github/workflows/test.yml` runs them on every push – create it in GitHub with Add file → Create new file (dot-folders are skipped by drag-and-drop).
