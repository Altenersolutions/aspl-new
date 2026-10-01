# Inventory WMS – Backend API (Node + Express + MongoDB)

Upload this whole folder to a GitHub repo, then connect the repo to Render.

## Render settings (Web Service → connect this repo)
| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

## Render environment variables
| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |
| `JWT_SECRET` | any long random text (32+ chars) |
| `MONGO_URI` | MongoDB Atlas connection string, ending `/inventory?retryWrites=true&w=majority` |
| `BOOTSTRAP_ADMIN_EMAIL` | your admin login email |
| `BOOTSTRAP_ADMIN_PASSWORD` | your admin password (min 8 chars) |
| `SEED_ON_START` | `true` (creates sample locations/parts/BOMs/vehicles; safe to repeat) |
| `SEED_DEMO_USERS` | `false` |
| `SERVE_LEGACY` | `false` |
| `CORS_ORIGINS` | your Netlify URL, e.g. `https://my-wms.netlify.app` (no trailing slash) – add after Netlify is live |

Check: `https://<your-service>.onrender.com/api/health` → `{"ok":true}`

Local run: `npm install`, copy `.env.example` to `.env`, `npm run seed`, `npm start`. Tests: `npm test` (needs a local MongoDB).
