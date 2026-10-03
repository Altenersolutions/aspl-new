// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with no external dependency. Works with Google/Microsoft Authenticator.
const crypto = require("crypto");
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) { let bits = "", out = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return out; }
function b32decode(str) { let bits = ""; for (const c of str.replace(/=+$/, "").toUpperCase()) { const v = A.indexOf(c); if (v < 0) throw new Error("bad base32"); bits += v.toString(2).padStart(5, "0"); } const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); }
const newSecret = () => b32encode(crypto.randomBytes(20));
function code(secret, t = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(counter).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, "0");
}
function verify(secret, token, t = Date.now()) {
  const tok = String(token || "").replace(/\s/g, ""); if (!/^\d{6}$/.test(tok)) return false;
  for (const d of [-1, 0, 1]) { const c = code(secret, t + d * 30000); if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(tok))) return true; }
  return false;
}
const uri = (secret, account, issuer = "Inventory WMS") => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
module.exports = { newSecret, code, verify, uri };
