const { Role } = require("../models");

// Every permission the system knows. Backend routes check these (requirePerm); the UI only mirrors them.
// `scan.use` allows ONLY the scanner endpoints. It no longer opens dashboards, lists or any module.
const P = {
  DASHBOARD: "dashboard.view",
  INV_VIEW: "inventory.view", RECEIVE: "inventory.receive", PUTAWAY: "inventory.putaway", ISSUE: "inventory.issue", RETURN: "inventory.return",
  TRANSFER: "inventory.transfer", ADJUST: "inventory.adjust", RESERVE: "inventory.reserve", TXN_VIEW: "inventory.view_transactions", FIFO_OVERRIDE: "inventory.override_fifo",
  QC_VIEW: "qc.view", QC_PERFORM: "qc.perform", QC_APPROVE: "qc.approve", QC_REJECT: "qc.reject", QC_HOLD: "qc.hold", QC_RETEST: "qc.retest", QC_HISTORY: "qc.view_history",
  VEH_VIEW: "vehicle.view", VEH_CREATE: "vehicle.create", VEH_EDIT: "vehicle.edit", VEH_TRACE: "vehicle.traceability",
  ASM_VIEW: "assembly.view", INSTALL: "assembly.install", REMOVE: "assembly.remove",
  ENG_VIEW: "engineering.view", ENG_PARTS: "engineering.manage_parts", ENG_REV: "engineering.manage_revisions", ENG_BOM: "engineering.manage_bom",
  ENG_DEV: "engineering.manage_development_components", ENG_APPROVE: "engineering.approve",
  HO_VIEW: "handover.view", HO_CREATE: "handover.create", HO_RESPOND: "handover.respond",
  GP_VIEW: "gatepass.view", GP_CREATE: "gatepass.create", GP_PRINT: "gatepass.print", GP_REPRINT: "gatepass.reprint",
  AUDIT: "audit.view", REPORTS: "reports.view",
  ADMIN_USERS: "admin.users", ADMIN_ROLES: "admin.roles", ADMIN_PERMS: "admin.permissions", ADMIN_MASTER: "admin.master_data",
  SCAN: "scan.use",
  OVERRIDE: "override.approve", // generic audited override (wrong location, BOM mismatch, wrong vehicle, status correction …)
};
const ALL = Object.values(P);

// Old permission names found in roles saved by earlier versions -> new names (applied when roles are loaded).
const LEGACY = {
  "material.receive": ["inventory.receive"], "material.putaway": ["inventory.putaway"], "material.issue": ["inventory.issue"], "material.return": ["inventory.return"], "material.transfer": ["inventory.transfer"],
  "inventory.adjust": ["inventory.adjust"], "qc.override": ["qc.approve"], "assembly.install": ["assembly.install"], "assembly.remove": ["assembly.remove"],
  "engineering.manage": ["engineering.manage_parts", "engineering.manage_revisions", "engineering.manage_bom", "engineering.manage_development_components"],
  "admin.master": ["admin.master_data"], "admin.users": ["admin.users"],
};
const normalisePerms = (list = []) => [...new Set(list.flatMap((p) => (LEGACY[p] ? LEGACY[p] : ALL.includes(p) ? [p] : [])))];

const STORE_CORE = [P.SCAN, P.INV_VIEW, P.RECEIVE, P.PUTAWAY, P.RETURN, P.TRANSFER, P.HO_VIEW, P.HO_RESPOND, P.GP_VIEW, P.GP_CREATE, P.GP_PRINT];
const QC_ALL = [P.QC_VIEW, P.QC_PERFORM, P.QC_APPROVE, P.QC_REJECT, P.QC_HOLD, P.QC_RETEST, P.QC_HISTORY];
const DEFAULT_ROLES = {
  admin: ALL,
  store: [...STORE_CORE, P.ISSUE, P.RESERVE, P.TXN_VIEW, P.HO_CREATE],
  "store assistant": STORE_CORE,
  "purchase executive": [P.SCAN, P.INV_VIEW, P.RECEIVE, P.GP_VIEW],
  qc: [P.SCAN, P.INV_VIEW, P.VEH_VIEW, P.ASM_VIEW, P.HO_VIEW, P.HO_RESPOND, ...QC_ALL],
  assembly: [P.SCAN, P.ASM_VIEW, P.INSTALL, P.VEH_VIEW, P.VEH_TRACE, P.HO_VIEW, P.HO_RESPOND, P.QC_VIEW, P.QC_PERFORM, P.QC_APPROVE, P.QC_REJECT, P.QC_HOLD],
  engineer: [P.SCAN, P.ENG_VIEW, P.ENG_PARTS, P.ENG_REV, P.ENG_BOM, P.ENG_DEV, P.ENG_APPROVE, P.VEH_VIEW, P.VEH_CREATE, P.VEH_EDIT, P.INV_VIEW, P.QC_VIEW],
  supervisor: [P.DASHBOARD, P.SCAN, P.INV_VIEW, P.RECEIVE, P.PUTAWAY, P.ISSUE, P.RETURN, P.TRANSFER, P.ADJUST, P.RESERVE, P.TXN_VIEW, P.FIFO_OVERRIDE, ...QC_ALL,
    P.VEH_VIEW, P.VEH_TRACE, P.ASM_VIEW, P.INSTALL, P.REMOVE, P.ENG_VIEW, P.HO_VIEW, P.HO_CREATE, P.HO_RESPOND, P.GP_VIEW, P.GP_CREATE, P.GP_PRINT, P.GP_REPRINT, P.REPORTS, P.AUDIT, P.OVERRIDE],
  viewer: [P.SCAN, P.INV_VIEW, P.ENG_VIEW, P.VEH_VIEW, P.ASM_VIEW, P.QC_VIEW, P.HO_VIEW, P.GP_VIEW, P.REPORTS],
};

let cache = { at: 0, map: null };
const norm = (r) => String(r || "").trim().toLowerCase();
async function loadMap() {
  if (cache.map && Date.now() - cache.at < 15000) return cache.map;
  const map = Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([k, v]) => [k, new Set(v)]));
  for (const r of await Role.find().lean()) map[norm(r.name)] = new Set(normalisePerms(r.permissions));
  map.admin = new Set(ALL); // admin can never be locked out by editing the Role collection
  cache = { at: Date.now(), map };
  return map;
}
const invalidate = () => { cache = { at: 0, map: null }; };
async function permissionsFor(role) { return [...((await loadMap())[norm(role)] || [])]; }
async function can(role, perm) { return ((await loadMap())[norm(role)] || new Set()).has(perm); }
async function canAny(role, perms) { const s = (await loadMap())[norm(role)] || new Set(); return perms.some((p) => s.has(p)); }

module.exports = { P, ALL, DEFAULT_ROLES, LEGACY, normalisePerms, permissionsFor, can, canAny, invalidate, norm };
