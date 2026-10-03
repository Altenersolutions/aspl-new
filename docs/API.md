# API reference (generated)

All endpoints need `Authorization: Bearer <token>` except login. `perm` is the server-side permission required (the backend enforces it; the UI only hides buttons).

| Method | Path | Permission |
|---|---|---|
| POST | `/api/scan` | scan |
| POST | `/api/locations/scan` | scan |
| GET | `/api/qr` | signed in |
| POST | `/api/receiving` | receive |
| GET | `/api/receiving` | scan |
| GET | `/api/receiving/:id` | scan |
| POST | `/api/receiving/:id/qc` | qc |
| GET | `/api/qc` | scan |
| GET | `/api/qc/queue` | scan |
| GET | `/api/materials` | scan |
| GET | `/api/materials/awaiting-putaway` | scan |
| GET | `/api/materials/:id` | scan |
| GET | `/api/materials/:id/put-away-plan` | scan |
| POST | `/api/materials/:id/put-away` | putaway |
| POST | `/api/materials/:id/disposition` | qc |
| POST | `/api/materials/:id/status-override` | override |
| GET | `/api/materials/:id/label` | scan |
| POST | `/api/inventory/issue` | issue |
| POST | `/api/inventory/return` | return |
| POST | `/api/inventory/transfer` | transfer |
| POST | `/api/inventory/adjust` | adjust |
| GET | `/api/inventory/transactions` | reports |
| GET | `/api/inventory/stock` | reports |
| POST | `/api/handover` | handover |
| GET | `/api/handover` | scan |
| POST | `/api/handover/:id/acknowledge` | handover.respond |
| POST | `/api/handover/:id/refuse` | handover.respond |
| POST | `/api/vehicles/scan` | scan |
| GET | `/api/vehicles` | scan |
| GET | `/api/vehicles/:id` | scan |
| POST | `/api/vehicles/:id/check` | scan |
| POST | `/api/vehicles/:id/install` | install |
| POST | `/api/vehicles/:id/remove` | remove |
| GET | `/api/installations` | scan |
| GET | `/api/traceability/vehicle/:id` | reports |
| GET | `/api/traceability/component/:id` | reports |
| GET | `/api/traceability/serial/:serial` | reports |
| GET | `/api/audit` | audit |
| GET | `/api/overrides` | audit |
| GET | `/api/dashboard` | scan |
| GET | `/api/search` | scan |
| GET | `/api/alerts` | scan |
| GET | `/api/analytics` | reports |
| GET | `/api/purchase-orders` | scan |
| POST | `/api/purchase-orders` | receive |
| POST | `/api/purchase-orders/:id/cancel` | receive |
| GET | `/api/parts/:id/qc-template` | scan |
| GET | `/api/materials/:id/qc-template` | scan |
| PUT | `/api/parts/:id/qc-template` | engineering |
| GET | `/api/ncr` | scan |
| PUT | `/api/ncr/:id` | qc |
| POST | `/api/ncr/:id/close` | qc |
| GET | `/api/eco` | scan |
| GET | `/api/eco/impact` | scan |
| POST | `/api/eco` | engineering |
| POST | `/api/eco/:id/approve` | bom.approve |
| POST | `/api/eco/:id/reject` | bom.approve |
| GET | `/api/kits` | scan |
| POST | `/api/kits` | issue |
| GET | `/api/kits/:id` | scan |
| POST | `/api/kits/:id/issue` | issue |
| POST | `/api/kits/:id/cancel` | issue |
| GET | `/api/counts` | scan |
| POST | `/api/counts` | transfer |
| GET | `/api/counts/:id` | scan |
| POST | `/api/counts/:id/submit` | transfer |
| POST | `/api/counts/:id/approve` | adjust |
| POST | `/api/counts/:id/cancel` | transfer |
| POST | `/api/recall/query` | reports |
| POST | `/api/recall/quarantine` | qc |
| GET | `/api/traceability/vehicle/:id/build-book` | reports |
| POST | `/api/files` | scan |
| GET | `/api/files/:id` | scan |
| GET | `/api/export/:kind` | reports |
| POST | `/api/import/parts` | engineering |
| POST | `/api/import/bom` | engineering |
| POST | `/api/import/opening-stock` | admin.master |
| GET | `/api/suppliers` | signed in |
| POST | `/api/suppliers` | admin.master, receive |
| PUT | `/api/suppliers/:id` | signed in |
| GET | `/api/locations` | signed in |
| POST | `/api/locations` | signed in |
| PUT | `/api/locations/:id` | signed in |
| GET | `/api/parts` | signed in |
| GET | `/api/parts/:id` | signed in |
| POST | `/api/parts` | signed in |
| PUT | `/api/parts/:id` | signed in |
| GET | `/api/parts/:id/revisions` | signed in |
| POST | `/api/parts/:id/revisions` | signed in |
| POST | `/api/parts/:id/revisions/:rev/approve` | bom.approve |
| GET | `/api/bom` | signed in |
| POST | `/api/bom` | signed in |
| GET | `/api/bom/:model/revisions` | signed in |
| POST | `/api/bom/:model/revisions` | signed in |
| POST | `/api/bom/:model/revisions/:rev/approve` | bom.approve |
| POST | `/api/vehicles` | signed in |
| POST | `/api/vehicles/:id/bom-revision` | signed in |
| GET | `/api/roles` | admin.users |
| PUT | `/api/roles/:name` | admin.users |
| GET | `/api/settings` | signed in |
| PUT | `/api/settings/:key` | signed in |
| POST | `/login` | signed in |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/change-password` | signed in |
| POST | `/api/auth/logout-all` | signed in |
| GET | `/api/auth/2fa` | signed in |
| POST | `/api/auth/2fa/setup` | signed in |
| POST | `/api/auth/2fa/enable` | signed in |
| POST | `/api/auth/2fa/disable` | signed in |
| GET | `/users/` | admin.users |
| GET | `/users/directory` | signed in |
| GET | `/users/:id` | admin.users |
| POST | `/users/` | admin.users |
| PUT | `/users/:id` | admin.users |
| DELETE | `/users/:id` | admin.users |
