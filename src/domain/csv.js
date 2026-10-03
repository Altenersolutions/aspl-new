const esc = (v) => { if (v == null) return ""; let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; /* spreadsheet formula-injection guard */ return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows, cols) { return [cols.map((c) => esc(c[0])).join(","), ...rows.map((r) => cols.map((c) => esc(typeof c[1] === "function" ? c[1](r) : r[c[1]])).join(","))].join("\r\n"); }
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false; const t = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}
module.exports = { toCsv, parseCsv };
