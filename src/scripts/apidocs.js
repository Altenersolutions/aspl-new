// Generates docs/API.md from the route files:  npm run docs
const fs = require("fs"), path = require("path");
const files = [["routes/workflows.js", "/api"], ["routes/extra.js", "/api"], ["routes/master.js", "/api"], ["routes/auth.js", ""]];
const rx = /\b(r|authed|users|router)\.(get|post|put|delete)\(\s*"([^"]+)"([^\n]*)/g;
const out = ["# API reference (generated)", "", "All endpoints need `Authorization: Bearer <token>` except login. `perm` is the server-side permission required (the backend enforces it; the UI only hides buttons).", "", "| Method | Path | Permission |", "|---|---|---|"];
for (const [f, base] of files) {
  const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); let m;
  const prefix = (name) => (f.endsWith("auth.js") ? (name === "authed" ? "/api/auth" : name === "users" ? "/users" : name === "router" ? "" : "") : base);
  while ((m = rx.exec(src))) {
    const perm = (m[4].match(/requirePerm\(([^)]*)\)/) || [])[1] || (/adminOnly/.test(m[4]) ? "P.ADMIN_USERS" : /requireRole/.test(m[4]) ? "role" : "");
    out.push(`| ${m[2].toUpperCase()} | \`${prefix(m[1])}${m[3]}\` | ${perm.replace(/P\./g, "").toLowerCase().replace(/_/g, ".") || "signed in"} |`);
  }
}
fs.mkdirSync(path.join(__dirname, "..", "..", "docs"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "..", "..", "docs", "API.md"), out.join("\n") + "\n");
console.log(`docs/API.md written (${out.length - 6} endpoints)`);
