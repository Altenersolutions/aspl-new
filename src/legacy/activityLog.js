// Original behaviour preserved: records every successful legacy add/edit/delete.
const { ActivityLog } = require("../models/legacy");
const ITEM_TYPE_BY_PATH = [[/^\/parts/i, "Parts"], [/^\/bom/i, "BOM"], [/^\/dev/i, "Development"], [/^\/con/i, "Consumables"], [/^\/incomming/i, "Incoming"], [/^\/partsio/i, "Parts I/O"], [/^\/gatepass/i, "Gate Pass"], [/^\/users/i, "Users"]];
const itemTypeFor = (p) => { const h = ITEM_TYPE_BY_PATH.find(([re]) => re.test(p)); return h ? h[1] : p; };
const actionFor = (m) => (m === "POST" ? "ADD" : m === "PUT" ? "EDIT" : m === "DELETE" ? "DELETE" : m);
module.exports = (req, res, next) => {
  if (req.path === "/login" || req.path === "/activity-log" || ![ "POST", "PUT", "DELETE" ].includes(req.method)) return next();
  const original = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && req.user) {
      const label = (req.body && (req.body.partName || req.body.partId || req.body.name)) || (req.params && (req.params.id || req.params.partId)) || "";
      ActivityLog.create({ userId: req.user.id, userName: req.user.name || "", role: req.user.role, action: actionFor(req.method), itemType: itemTypeFor(req.path), itemLabel: String(label), path: req.path }).catch((e) => console.error("Activity log error:", e));
    }
    return original(body);
  };
  next();
};
