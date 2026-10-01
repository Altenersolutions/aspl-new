// QR/barcode payload formats.  Pipe-delimited so they also work as Code128 text.
//   MAT|<partNumber>|R=<rev>|S=<serial>|B=<batch>|I=<itemId>
//   LOC|<locationCode>
//   VEH|<vehicleNumber>
const materialPayload = (item, part) =>
  ["MAT", (part && part.partNumber) || item.partNumber, item.partRevision ? `R=${item.partRevision}` : null,
    item.serialNumber ? `S=${item.serialNumber}` : null, item.batchNumber ? `B=${item.batchNumber}` : null, `I=${item._id}`]
    .filter(Boolean).join("|");
const locationPayload = (loc) => `LOC|${loc.locationCode}`;
const vehiclePayload = (v) => `VEH|${v.vehicleNumber}`;

function parse(raw) {
  const text = String(raw || "").trim();
  if (!text) return { kind: "EMPTY" };
  const parts = text.split("|");
  const tag = parts[0].toUpperCase();
  if (tag === "LOC" && parts[1]) return { kind: "LOCATION", code: parts[1].trim().toUpperCase() };
  if (tag === "VEH" && parts[1]) return { kind: "VEHICLE", number: parts[1].trim().toUpperCase() };
  if (tag === "MAT" && parts[1]) {
    const out = { kind: "MATERIAL", partNumber: parts[1].trim().toUpperCase() };
    parts.slice(2).forEach((p) => {
      const [k, ...v] = p.split("="); const val = v.join("=");
      if (k === "R") out.revision = val; if (k === "S") out.serial = val; if (k === "B") out.batch = val; if (k === "I") out.itemId = val;
    });
    return out;
  }
  return { kind: "RAW", text };
}
module.exports = { materialPayload, locationPayload, vehiclePayload, parse };
