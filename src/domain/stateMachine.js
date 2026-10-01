// Single source of truth for every status rule. Routes and services call these; the
// frontend only displays what the backend returns.
const { MS } = require("./constants");
const { BusinessError } = require("./errors");

// from -> { to: [allowed operations] }
const MATERIAL_TRANSITIONS = {
  [MS.RECEIVED]: { [MS.PENDING_INCOMING_QC]: ["RECEIVE"] },
  [MS.PENDING_INCOMING_QC]: { [MS.APPROVED]: ["QC"], [MS.HOLD]: ["QC"], [MS.REJECTED]: ["QC"] },
  [MS.APPROVED]: {
    [MS.APPROVED]: ["QC"], [MS.HOLD]: ["QC"], [MS.REJECTED]: ["QC"],
    [MS.INSTALLED]: ["INSTALL"], [MS.SCRAPPED]: ["SCRAP"],
  },
  [MS.HOLD]: { [MS.APPROVED]: ["QC"], [MS.HOLD]: ["QC"], [MS.REJECTED]: ["QC"] },
  [MS.REJECTED]: { [MS.REWORK]: ["REWORK"], [MS.RETURNED_TO_SUPPLIER]: ["RETURN_TO_SUPPLIER"], [MS.SCRAPPED]: ["SCRAP"] },
  [MS.REWORK]: { [MS.PENDING_RETEST]: ["REWORK_DONE"], [MS.SCRAPPED]: ["SCRAP"] },
  [MS.PENDING_RETEST]: { [MS.APPROVED]: ["QC"], [MS.HOLD]: ["QC"], [MS.REJECTED]: ["QC"] },
  [MS.QC_REQUIRED]: { [MS.APPROVED]: ["QC"], [MS.HOLD]: ["QC"], [MS.REJECTED]: ["QC"] },
  [MS.INSTALLED]: { [MS.APPROVED]: ["REMOVE"], [MS.QC_REQUIRED]: ["REMOVE"], [MS.HOLD]: ["REMOVE"], [MS.REWORK]: ["REMOVE"] },
  [MS.LEGACY_UNVERIFIED]: { [MS.PENDING_INCOMING_QC]: ["REQUALIFY"] },
  [MS.RETURNED_TO_SUPPLIER]: {},
  [MS.SCRAPPED]: {},
};

// Which QC inspection types are valid from which statuses.
const QC_ALLOWED = {
  INCOMING: [MS.PENDING_INCOMING_QC],
  COMPONENT: [MS.APPROVED],
  IN_PROCESS: [MS.APPROVED, MS.INSTALLED],
  FINAL: [MS.INSTALLED, MS.APPROVED],
  RETEST: [MS.HOLD, MS.PENDING_RETEST, MS.QC_REQUIRED],
};
const RESULT_TO_STATUS = { PASS: MS.APPROVED, FAIL: MS.REJECTED, HOLD: MS.HOLD };

function canTransition(from, to, operation) {
  const ops = MATERIAL_TRANSITIONS[from] && MATERIAL_TRANSITIONS[from][to];
  return !!(ops && ops.includes(operation));
}
function assertTransition(from, to, operation) {
  if (!canTransition(from, to, operation)) {
    throw new BusinessError("INVALID_STATE_TRANSITION", `Status ${from} cannot change to ${to} via ${operation}.`, { details: { from, to, operation } });
  }
}
// What can I do with this item right now? (drives the Scan screen)
function allowedActions(item, { atReceiving = false, atBin = false } = {}) {
  const s = item.status;
  const a = [];
  if (s === MS.PENDING_INCOMING_QC) a.push("INCOMING_QC");
  if (s === MS.APPROVED) {
    if (atReceiving) a.push("PUT_AWAY");
    if (atBin) a.push("ISSUE", "TRANSFER", "HANDOVER");
    a.push("INSTALL");
  }
  if (s === MS.HOLD || s === MS.PENDING_RETEST || s === MS.QC_REQUIRED) a.push("RETEST");
  if (s === MS.REJECTED) a.push("REWORK_OR_RETURN");
  if (s === MS.REWORK) a.push("REWORK_DONE");
  if (s === MS.INSTALLED) a.push("REMOVE", "COMPONENT_QC");
  if (s === MS.LEGACY_UNVERIFIED) a.push("REQUALIFY");
  return a;
}

// Statuses whose stock may be issued / transferred / handed over / installed.
const MOVABLE = new Set([MS.APPROVED]);
function assertIssuable(item) {
  if (item.status === MS.REJECTED) throw new BusinessError("MATERIAL_REJECTED", "Rejected material cannot be issued or installed.", { details: { status: item.status } });
  if (item.status === MS.HOLD) throw new BusinessError("MATERIAL_ON_HOLD", "Material is on QC hold and cannot be issued or installed.", { details: { status: item.status } });
  if (!MOVABLE.has(item.status)) throw new BusinessError("MATERIAL_NOT_APPROVED", `Material status is ${item.status}; only APPROVED material can be used.`, { details: { status: item.status } });
}

module.exports = { MATERIAL_TRANSITIONS, QC_ALLOWED, RESULT_TO_STATUS, canTransition, assertTransition, allowedActions, assertIssuable };
