# Presentation data – what is real, derived, and demo

## REAL (from your Excel files, nothing invented)
* **BOM** – sheets Buzz, LITE, Retrofit of `BOM.xlsx` → 372 unique parts, three BOMs loaded as **REV-A, approved**: BUZZ 322 lines, LITE 283 lines, RETROFIT 98 lines. Assembly / sub-assembly names are kept in each line's *installation position*.
* **Capital assets** – sheet `JULY-26` of `Assets_List_2026_SEP.xlsx` (the newest sheet; it has 12 more asset numbers than sheet `ASSET`) → 271 records. Asset No, description, quantity, make, date, invoice, vendor, remarks and amount are exactly as in the sheet.

## DERIVED (a rule of mine – check before showing)
| What | How | Check |
|---|---|---|
| Part numbers | The BOM has no Part IDs, so numbers were generated: `MECH-0001…`, `ELEC-0001…`, `ELCN-0001…` | Replace with your real IDs when you have them |
| Part category / tracking type | Keyword rules on the description (e.g. motor, controller, battery pack → SERIAL; bolts, nuts, washers → QUANTITY; rest BATCH) | Parts page → filter and correct |
| Same part in several places | Merged into one BOM line per vehicle, quantities added, positions joined (BUZZ 392→322 lines, LITE 355→283, RETROFIT 115→98) | – |
| **Missing quantities** | Blank QTY → **1**. BUZZ 30 lines, LITE 19 lines, and **all 115 RETROFIT lines** (that sheet has no quantity column) | **Retrofit quantities are placeholders** |
| Unit cost | Only where the sheet has one (78 of 372 parts) | – |
| Asset area | From the area code inside the Asset No (Sheet2 of the register), so blank / mixed location names (FS, Fabrication, Fabrication shop …) are unified | – |
| Asset category | Keyword rules on the description (Hand Tools, Furniture, Test & Measuring …) | Edit in the Assets page |
| Duplicate Asset No | `ASPL-FS-110-0141` and `ASPL-B1-40-0189` are used for several different items; the 2nd, 3rd… get `/2`, `/3` | Ask whoever keeps the register |
| Blank description on a sub-row (e.g. chair `-2`) | Copied from the row above with the same base tag (37 rows) | – |

## NOT in the sheets, so left empty (not invented)
* Asset **amount** exists for only **12 of 271** assets (₹47,902 in total); purchase date for 136; invoice for 112. The Assets page shows these counts openly.
* The BOM status words (Under Development / Testing / Finalized / Rework) appear on only 11 cells and were not imported.
* Source spelling is kept as is ("Suspention", "Break Pipe" …). The LITE sheet lists "RHS Trailing Arm" under the LH arm; `#REF!` cells in the sheet were ignored.

## DEMO (invented – marked `DEMO-`)
Receipts (`DEMO-INV-…`), stock quantities, batch / serial numbers, QC results, 11 NCRs, and 5 sample vehicles (BUZZ-0001/0002, LITE-0001/0002, RETRO-0001). About 12% of parts get no stock (shows BOM shortages) and about 10% get low stock (shows alerts). Fixed random seed → the same demo every time. Remove with `--wipe-demo`. **No components are installed on the sample vehicles** – do the install live by scanning if you want to show assembly.

## Not tested
The loader's logic is validated against every database schema (`--dry-run`, `test/assets.unit.test.js`) and the Capital Assets page was exercised in a simulated browser, but I had no MongoDB in my sandbox, so the actual database load and the API endpoints were **not** run end to end. Do the first load on a test database and look at the screens before the presentation.
