#!/usr/bin/env node
/**
 * PROTOTYPE (2026-09-02). Perf (2026-09-24): NOW WIRED IN - read by this repo's
 * index.html and by Yesterday-s-Conversion, T-Sheet-Submissions and
 * NPS-Index---Medallia (look for "PREBUILT WORKBOOK ROWS" in each).
 *
 * CONTRACT those four pages rely on (change it and they silently stop using
 * this file - they are never wrong, just slower - so change it only together
 * with them):
 *   - source.sha256 / source.bytes: of the exact workbook bytes. A page uses
 *     the rows ONLY when they match the workbook it has just downloaded.
 *   - sheetjs: must stay "0.18.5" (the pages check it; it is the build they
 *     load from cdnjs).
 *   - sheets[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
 *     of a default XLSX.read, for every sheet in SHEETS below. Do not change
 *     the options or drop a sheet.
 *
 * Builds data/sales-report.json from data/Sales Report.xlsx at commit time so the
 * dashboards can fetch a small JSON instead of the 902 KB workbook and parsing it
 * with SheetJS on every open (measured: the fetch + XLSX.read is the single
 * biggest cost on Daily-Sales-Report, Yesterday-s-Conversion, T-Sheet-Submissions
 * and NPS-Index; XLSX.read alone is ~1 s of CPU per open).
 *
 * WHY THIS IS SAFE
 * It does NOT re-implement any parsing. It uses the same SheetJS build the pages
 * load from cdnjs (xlsx 0.18.5) and calls the same
 *   XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
 * the pages call, for only the sheets the pages read. The output is therefore the
 * exact array-of-arrays each page already works on; a page switching to this file
 * keeps every header-detection / column-matching line unchanged and just skips
 * XLSX.read. Sheets not listed below are not read by any dashboard.
 *
 * Measured on the 2026-09-02 workbook: 902 KB xlsx -> 1.76 MB JSON, 140 KB gzipped
 * on the wire (GitHub serves it gzipped); JSON.parse ~30 ms vs XLSX.read ~1,000 ms.
 *
 * Run locally:  mkdir -p /tmp/sheetjs && echo '{"private":true}' > /tmp/sheetjs/package.json
 *              npm install --prefix /tmp/sheetjs xlsx@0.18.5
 *              NODE_PATH=/tmp/sheetjs/node_modules node scripts/build-sales-json.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const SRC = path.join(process.cwd(), 'data', 'Sales Report.xlsx');
const OUT = path.join(process.cwd(), 'data', 'sales-report.json');
// Only what the dashboards consume:
//   Store Rank, Rep Rank, District Rank, Region Rank -> Daily-Sales-Report, NPS-Index, T-Sheet-Submissions
//   Zero                                             -> Daily-Sales-Report, Yesterday-s-Conversion
const SHEETS = ['Store Rank', 'Rep Rank', 'District Rank', 'Region Rank', 'Zero'];

if (!fs.existsSync(SRC)) { console.error('missing ' + SRC); process.exit(1); }
const buf = fs.readFileSync(SRC);
const t0 = Date.now();
const wb = XLSX.read(buf, { type: 'buffer' });
const sheets = {};
for (const name of SHEETS) {
  const ws = wb.Sheets[name];
  if (!ws) { console.warn('sheet not found: ' + name); continue; }
  sheets[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
}
const out = {
  generated_at: new Date().toISOString(),
  source: { file: 'data/Sales Report.xlsx', bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
  sheetjs: XLSX.version,
  sheets: sheets,
};
const json = JSON.stringify(out);
// Skip the commit churn when the workbook did not change.
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev.source && prev.source.sha256 === out.source.sha256) { console.log('workbook unchanged; leaving ' + OUT + ' as-is'); process.exit(0); }
  } catch (_) { /* unreadable -> rewrite */ }
}
fs.writeFileSync(OUT, json + '\n');
console.log('wrote ' + OUT + ': ' + Object.keys(sheets).map(n => n + '=' + sheets[n].length + ' rows').join(', ') +
  ' (' + json.length + ' bytes) from ' + buf.length + '-byte workbook in ' + (Date.now() - t0) + ' ms');

/*
 * Perf (2026-09-24): done - kept for the record. The pages use the JSON only
 * after a SHA-256 match against the workbook they downloaded (so it can never
 * show different numbers), and parse the workbook themselves otherwise.
 * TO WIRE INTO index.html (deliberately not done in the same change - the JSON has
 * to exist on main first, and the page change needs its own review):
 *   1. In loadData(), fetch CONFIG.EXCEL_URL.replace(/Sales%20Report\.xlsx$/, 'sales-report.json')
 *      and, on 200, build  wb = { Sheets: json.sheets }  and give parseWorkbook / parseZeroSheet /
 *      parseRankSheet the arrays directly instead of calling XLSX.utils.sheet_to_json
 *      (three call sites; each becomes  wb.Sheets[name]  when the value is already an array).
 *   2. Use the JSON text (or source.sha256) for bufferSignature() so the unchanged-file check keeps working.
 *   3. Keep the xlsx path as the fallback for a 404 / parse error, and for the local-file upload.
 *   4. Repeat for Yesterday-s-Conversion (Zero), T-Sheet-Submissions (Store Rank) and NPS-Index
 *      (Store Rank, Rep Rank, District Rank) once the Daily-Sales-Report change has been live for a day.
 */
