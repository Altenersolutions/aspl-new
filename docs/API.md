# API reference (generated)

All endpoints need `Authorization: Bearer <token>` except login. `perm` is the server-side permission required (the backend enforces it; the UI only hides buttons).

| Method | Path | Permission |
|---|---|---|
| POST | `/api/scan` | scan |
| POST | `/api/locations/scan` | scan |
| GET | `/api/qr` | signed in |
| POST | `/api/receiving` | receive |
| GET | `/api/receiving` | inv.view |
| GET | `/api/receiving/:id` | inv.view |
| POST | `/api/receiving/:id/qc` | qc.perform |
| GET | `/api/qc` | qc.history, qc.view |
| GET | `/api/qc/queue` | qc.view, inv.view |
| GET | `/api/materials` | inv.view, qc.view, asm.view |
| GET | `/api/materials/awaiting-putaway` | inv.view |
| GET | `/api/materials/:id` | scan, inv.view, qc.view, asm.view |
| GET | `/api/materials/:id/put-away-plan` | inv.view, putaway |
| POST | `/api/materials/:id/put-away` | putaway |
| POST | `/api/materials/:id/disposition` | qc.perform |
| POST | `/api/materials/:id/status-override` | override |
| GET | `/api/materials/:id/label` | inv.view |
| POST | `/api/inventory/issue` | issue |
| POST | `/api/inventory/return` | return |
| POST | `/api/inventory/transfer` | transfer |
| POST | `/api/inventory/adjust` | adjust |
| GET | `/api/inventory/transactions` | txn.view, reports |
| GET | `/api/inventory/stock` | inv.view |
| POST | `/api/handover` | ho.create |
| GET | `/api/handover` | ho.view |
| POST | `/api/handover/:id/acknowledge` | ho.respond |
| POST | `/api/handover/:id/refuse` | ho.respond |
| POST | `/api/vehicles/scan` | veh.view, asm.view |
| GET | `/api/vehicles` | veh.view, asm.view |
| GET | `/api/vehicles/:id` | veh.view, asm.view |
| POST | `/api/vehicles/:id/check` | asm.view, install |
| POST | `/api/vehicles/:id/install` | install |
| POST | `/api/vehicles/:id/remove` | remove |
| GET | `/api/installations` | asm.view, veh.trace |
| GET | `/api/traceability/vehicle/:id` | veh.trace, reports |
| GET | `/api/traceability/component/:id` | veh.trace, reports, inv.view |
| GET | `/api/traceability/serial/:serial` | veh.trace, reports, inv.view |
| GET | `/api/audit` | audit |
| GET | `/api/overrides` | audit |
| GET | `/api/dashboard` | dashboard |
| POST | `/api/inventory/issue-fifo` | issue |
| GET | `/api/inventory/fifo-next` | inv.view |
| GET | `/api/vehicles/:id/timeline` | veh.trace, veh.view, asm.view |
| GET | `/api/workbench/:kind` | signed in |
| GET | `/api/gatepasses` | gp.view |
| GET | `/api/gatepasses/next-ref` | gp.create |
| GET | `/api/gatepasses/:id` | gp.view |
| POST | `/api/gatepasses` | gp.create |
| POST | `/api/gatepasses/:id/print` | gp.print, gp.reprint |
| GET | `/api/search` | signed in |
| GET | `/api/alerts` | inv.view, qc.view, asm.view, eng.view, dashboard |
| GET | `/api/analytics` | reports |
| GET | `/api/purchase-orders` | inv.view |
| POST | `/api/purchase-orders` | receive |
| POST | `/api/purchase-orders/:id/cancel` | receive |
| GET | `/api/parts/:id/qc-template` | qc.view, eng.view |
| GET | `/api/materials/:id/qc-template` | qc.perform, qc.view |
| PUT | `/api/parts/:id/qc-template` | eng.parts |
| GET | `/api/ncr` | qc.view |
| PUT | `/api/ncr/:id` | qc.perform |
| POST | `/api/ncr/:id/close` | qc.approve |
| GET | `/api/eco` | eng.view |
| GET | `/api/eco/impact` | eng.view |
| POST | `/api/eco` | eng.rev |
| POST | `/api/eco/:id/approve` | eng.approve |
| POST | `/api/eco/:id/reject` | eng.approve |
| GET | `/api/kits` | inv.view, asm.view |
| POST | `/api/kits` | reserve |
| GET | `/api/kits/:id` | inv.view, asm.view |
| POST | `/api/kits/:id/issue` | issue |
| POST | `/api/kits/:id/cancel` | reserve |
| GET | `/api/counts` | inv.view |
| POST | `/api/counts` | transfer |
| GET | `/api/counts/:id` | inv.view |
| POST | `/api/counts/:id/submit` | transfer |
| POST | `/api/counts/:id/approve` | adjust |
| POST | `/api/counts/:id/cancel` | transfer |
| POST | `/api/recall/query` | qc.view, reports |
| POST | `/api/recall/quarantine` | qc.hold |
| GET | `/api/traceability/vehicle/:id/build-book` | veh.trace, reports |
| POST | `/api/files` | qc.perform, eng.dev, eng.parts, gp.create |
| GET | `/api/files/:id` | inv.view, qc.view, eng.view, asm.view |
| GET | `/api/export/:kind` | reports |
| POST | `/api/import/parts` | eng.parts |
| POST | `/api/import/bom` | eng.bom |
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
| POST | `/api/parts/:id/revisions` | eng.rev, eng.dev |
| POST | `/api/parts/:id/revisions/:rev/approve` | eng.approve |
| GET | `/api/dev-subcategories` | signed in |
| POST | `/api/parts/:id/dev/submit` | eng.dev |
| POST | `/api/parts/:id/dev/approve` | eng.approve |
| POST | `/api/parts/:id/dev/reject` | eng.approve |
| POST | `/api/parts/:id/dev/activate` | eng.dev |
| GET | `/api/parts/:id/images` | signed in |
| POST | `/api/parts/:id/images` | eng.dev |
| GET | `/api/bom` | signed in |
| POST | `/api/bom` | eng.bom |
| GET | `/api/bom/:model/revisions` | signed in |
| POST | `/api/bom/:model/revisions` | eng.bom |
| POST | `/api/bom/:model/revisions/:rev/approve` | eng.approve |
| POST | `/api/vehicles` | veh.create |
| POST | `/api/vehicles/:id/bom-revision` | veh.edit |
| GET | `/api/roles` | admin.roles, admin.perms |
| PUT | `/api/roles/:name` | admin.perms |
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
