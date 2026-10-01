const { Role } = require("../models");

const P = {
  SCAN: "scan.use",
  RECEIVE: "material.receive",
  PUTAWAY: "material.putaway",
  ISSUE: "material.issue",
  RETURN: "material.return",
  TRANSFER: "material.transfer",
  ADJUST: "inventory.adjust",
  QC: "qc.perform",
  QC_OVERRIDE: "qc.override",
  HANDOVER: "handover.create",
  HANDOVER_RESPOND: "handover.respond",
  INSTALL: "assembly.install",
  REMOVE: "assembly.remove",
  ENGINEERING: "engineering.manage",
  BOM_APPROVE: "engineering.approve",
  REPORTS: "reports.view",
  AUDIT: "audit.view",
  OVERRIDE: "override.approve",
  ADMIN_USERS: "admin.users",
  ADMIN_MASTER: "admin.master", // locations, suppliers, roles, settings
};
const ALL = Object.values(P);

const DEFAULT_ROLES = {
  admin: ALL,
  store: [P.SCAN, P.RECEIVE, P.PUTAWAY, P.ISSUE, P.RETURN, P.TRANSFER, P.HANDOVER, P.HANDOVER_RESPOND, P.REPORTS],
  "store assistant": [P.SCAN, P.RECEIVE, P.PUTAWAY, P.RETURN, P.TRANSFER, P.HANDOVER_RESPOND, P.REPORTS],
  "purchase executive": [P.SCAN, P.RECEIVE, P.REPORTS],
  qc: [P.SCAN, P.QC, P.REPORTS, P.HANDOVER_RESPOND],
  assembly: [P.SCAN, P.INSTALL, P.HANDOVER_RESPOND, P.REPORTS, P.QC],
  supervisor: [P.SCAN, P.INSTALL, P.REMOVE, P.HANDOVER, P.HANDOVER_RESPOND, P.QC, P.REPORTS, P.ISSUE, P.RETURN, P.TRANSFER],
  engineer: [P.SCAN, P.ENGINEERING, P.REPORTS],
  viewer: [P.SCAN, P.REPORTS],
};

let cache = { at: 0, map: null };
const norm = (r) => String(r || "").trim().toLowerCase();

async function loadMap() {
  if (cache.map && Date.now() - cache.at < 15000) return cache.map;
  const map = { ...Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([k, v]) => [k, new Set(v)])) };
  const rows = await Role.find().lean();
  rows.forEach((r) => { map[norm(r.name)] = new Set(r.permissions || []); });
  map.admin = new Set(ALL); // admin can never be locked out by editing the Role collection
  cache = { at: Date.now(), map };
  return map;
}
const invalidate = () => { cache = { at: 0, map: null }; };
async function permissionsFor(role) { return [...((await loadMap())[norm(role)] || [])]; }
async function can(role, perm) { return ((await loadMap())[norm(role)] || new Set()).has(perm); }

module.exports = { P, ALL, DEFAULT_ROLES, permissionsFor, can, invalidate, norm };
