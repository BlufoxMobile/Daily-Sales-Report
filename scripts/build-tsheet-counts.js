#!/usr/bin/env node
/**
 * Builds data/tsheet-counts.json — the small counts file the quote sheets read.
 *
 * WHY THIS EXISTS
 * The Apps Script submissions feed takes ~11s and returns ~4 MB / 24,000+ rows.
 * When the quote sheets called it directly, those reads starved the submission
 * endpoint and reps got "Submission failed / timeout" at the counter. This job
 * makes that expensive call ONCE for the whole company on a schedule and commits
 * a ~5 KB summary; the sheets read the summary from GitHub Pages in milliseconds
 * and never touch Apps Script.
 *
 * Run locally:  FEED_URL="https://script.google.com/.../exec" node scripts/build-tsheet-counts.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FEED_URL = process.env.FEED_URL;
const OUT = path.join(process.cwd(), 'data', 'tsheet-counts.json');
const TZ = 'America/Chicago';           // counts must roll over on store time, not UTC
const TIMEOUT_MS = 120000;              // the feed is slow; the runner can afford to wait

if (!FEED_URL) { console.error('FEED_URL is not set'); process.exit(1); }

// Canonical store naming — mirrors normalizeStoreName() in the dashboard so the
// legacy rows ("Skokie Xfinity Store", a bare "Machesney Park") land in the
// right bucket instead of orphan keys.
const ALIASES = { skokie: 'South Skokie', knoxville: 'South Knoxville' };
function normStore(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s) return '';
  s = s.replace(/\s*Xfinity\s+Store\s*$/i, '');
  if (!s) return '';
  const low = s.toLowerCase();
  if (ALIASES[low]) s = ALIASES[low];
  return s + ' Xfinity Store';
}

// Local (America/Chicago) Y-M-D for a Date, without pulling in a date library.
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
function localYMD(d) { return partsFmt.format(d); }   // "2026-08-28"

async function main() {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  const res = await fetch(FEED_URL + '?t=' + Date.now(), { signal: ctrl.signal });
  if (!res.ok) throw new Error('feed HTTP ' + res.status);
  const data = await res.json();
  clearTimeout(killer);
  if (!data || data.success === false) throw new Error('feed error: ' + (data && data.error));

  const rows = Array.isArray(data.submissions) ? data.submissions : [];
  const fetchMs = Date.now() - t0;

  const today = localYMD(new Date());
  const month = today.slice(0, 7);
  const stores = {};

  let skipped = 0;
  for (const r of rows) {
    if (!r) { skipped++; continue; }
    const store = normStore(r.store);
    if (!store) { skipped++; continue; }
    const d = new Date(r.timestamp);
    if (isNaN(d.getTime())) { skipped++; continue; }

    const ymd = localYMD(d);
    if (ymd.slice(0, 7) !== month) continue;        // month-to-date only

    const isToday = ymd === today;
    const rep = String(r.rep_name == null ? '' : r.rep_name).trim() || '(unknown)';

    const s = stores[store] || (stores[store] = { today: 0, mtd: 0, reps: {} });
    s.mtd++;
    if (isToday) s.today++;
    const p = s.reps[rep] || (s.reps[rep] = { today: 0, mtd: 0 });
    p.mtd++;
    if (isToday) p.today++;
  }

  const out = {
    generated_at: new Date().toISOString(),
    timezone: TZ,
    day: today,
    month: month,
    source_rows: rows.length,
    stores: stores
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Only rewrite when the numbers actually changed, so the repo isn't churned
  // with a commit every 10 minutes. generated_at is ignored for this comparison.
  let changed = true;
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      changed = JSON.stringify(prev.stores) !== JSON.stringify(out.stores) || prev.day !== out.day;
    } catch (_) { /* unreadable -> rewrite */ }
  }

  if (!changed) { console.log('no change; leaving file as-is'); return; }

  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  const bytes = fs.statSync(OUT).size;
  console.log(
    'wrote ' + OUT + ' — ' + Object.keys(stores).length + ' stores, ' +
    bytes + ' bytes, from ' + rows.length + ' rows (' + skipped + ' skipped) in ' + fetchMs + 'ms'
  );
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
