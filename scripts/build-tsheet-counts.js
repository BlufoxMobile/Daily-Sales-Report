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
 * It ALSO builds data/tsheet-flags.json — today's rapid-fire clusters (the same
 * rep at the same store filing 2+ t-sheets inside five minutes, which is how Jeff
 * spots someone batching t-sheets in the back instead of filling them out after
 * real conversations). That check needs per-submission TIMESTAMPS, which the
 * counts file deliberately does not carry, and this runner is the only machine
 * that can read the feed at all — from anywhere else the Apps Script URL answers
 * a Google Drive "Page Not Found" page after ~60s. So the flags are computed
 * here, ONCE, off the SAME read as the counts, and published as a static file
 * that the dashboard and the email digest just download.
 *
 * Run locally:  FEED_URL="https://script.google.com/.../exec" node scripts/build-tsheet-counts.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FEED_URL = process.env.FEED_URL;
const OUT = path.join(process.cwd(), 'data', 'tsheet-counts.json');
const FLAGS_OUT = path.join(process.cwd(), 'data', 'tsheet-flags.json');
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

const YFMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' });
const MFMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' });
const DFMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit' });
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const pad2 = n => String(n).padStart(2, '0');

/**
 * Blufox fiscal cycle: the 22nd through the 21st, named for the month it ENDS in.
 * Aug 22 - Sep 21 is "September". Verified against the live T-Sheet-Submissions
 * dashboard 2026-08-29 (Aug 21 out, Aug 22 in, Sep 21 in, Sep 22 out).
 *
 * MTD MUST use this window, not the calendar month, or the quote sheets disagree
 * with the dashboard — they did: Cicero showed 532 (calendar Aug) vs 126 (fiscal).
 */
function cycleFor(d) {
  const y = Number(YFMT.format(d)), m = Number(MFMT.format(d)), day = Number(DFMT.format(d));
  let sy = y, sm = m;
  if (day < 22) { sm = m - 1; if (sm < 1) { sm = 12; sy = y - 1; } }
  let ey = sy, em = sm + 1;
  if (em > 12) { em = 1; ey = sy + 1; }
  return { start: `${sy}-${pad2(sm)}-22`, end: `${ey}-${pad2(em)}-21`, label: `${MONTHS[em-1]} ${ey}` };
}

/* ============================================================
   RAPID-FIRE SUBMISSION FLAGGING
   A "cluster" is the SAME rep at the SAME store filing 2+ t-sheets within five
   minutes of each other. Every submission in a cluster is flagged; the dashboard
   paints that rep's name red, and the store's name too.

   These choices are deliberate and are shared, to the behaviour, with the two
   implementations that already exist — flagsForDay() in the T-Sheet-Submissions
   dashboard and computeFlags() in the email digest. This file is the THIRD copy
   of the same rule, so it must not "improve" any of it:
   - SAME REP ONLY. Two different reps at one store a minute apart is a rush, not
     a fake. Jeff was asked directly and picked this.
   - Reps are keyed by store + name, NEVER name alone. Two stores can carry the
     same name and merging them would invent clusters that never happened.
   - A blank rep name is an aggregation bucket ("(unknown)" in the counts file),
     not a person, and can never be flagged — otherwise every store with sloppy
     form entry would sit red permanently and Jeff would learn to ignore red.
   - A gap of exactly 0 ms (two rows with an identical timestamp) is INSIDE the
     window, and so is exactly 5m00s: the comparison is `<=`. Duplicate-looking
     timestamps are the behaviour being hunted, not an edge case to forgive.
   ============================================================ */
const RAPID_WINDOW_MS = 5 * 60 * 1000;
const RAPID_RULE = 'same-rep-same-store-5min-v1';   // published so the digest can refuse a rule it doesn't know

/**
 * Clusters for ONE rep at ONE store, given that rep's submission times in ms.
 * Returns [] for a rep with nothing to answer for. Mutates/sorts `times`.
 */
function rapidClusters(times) {
  times.sort((a, b) => a - b);
  const n = times.length;
  if (n < 2) return [];

  // Mark BOTH sides of every too-short gap. Marking PAIRS rather than runs is
  // what chains three submissions three minutes apart into one cluster instead
  // of two overlapping pairs.
  const hot = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (times[i] - times[i - 1] <= RAPID_WINDOW_MS) { hot[i] = true; hot[i - 1] = true; }
  }

  // Group the flagged rows into bursts by SPLITTING ON THE GAP: a row joins the
  // burst before it only when it is also within the window of that row. Reading
  // this as "any run of consecutive flagged rows" instead is wrong in exactly
  // the case that matters — a rep whose whole day is bursts never files a calm
  // row to break the run, so his 8:42am pair and his 2:21pm pair fuse into one
  // bogus cluster and the evidence reads "7 t-sheets in 5 hr 39 min". WHICH rows
  // are flagged is identical either way; only the grouping changes, so the red
  // never moves. The pinned real case is Anaf Rahman at Evanston on 2026-09-02:
  // four separate bursts of [2,5,2,2], not one cluster of 11.
  const clusters = [];
  let run = null;
  for (let i = 0; i < n; i++) {
    if (!hot[i]) { run = null; continue; }
    if (!run || times[i] - times[i - 1] > RAPID_WINDOW_MS) { run = []; clusters.push(run); }
    run.push(times[i]);
  }

  // A flagged row is by definition within the window of a flagged neighbour, so
  // a one-row cluster cannot come out of the loop above. The filter is a guard
  // rail: if someone ever edits the marking loop, a stray singleton would look
  // like evidence in the email, and the digest would silently discard it anyway.
  return clusters.filter(c => c.length > 1);
}

// Missing or unreadable is not an error here — it just means "rewrite it".
function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

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

  const now = new Date();
  const today = localYMD(now);
  const cycle = cycleFor(now);
  const stores = {};
  const rapidGroups = new Map();   // "store||rep" -> { store, rep, times:[ms] }, TODAY only

  let skipped = 0;
  for (const r of rows) {
    if (!r) { skipped++; continue; }
    const store = normStore(r.store);
    if (!store) { skipped++; continue; }
    const d = new Date(r.timestamp);
    if (isNaN(d.getTime())) { skipped++; continue; }

    const ymd = localYMD(d);
    // MTD = inside the fiscal cycle (22nd-21st), NOT the calendar month.
    if (ymd < cycle.start || ymd > cycle.end) continue;

    const isToday = ymd === today;
    const repRaw = String(r.rep_name == null ? '' : r.rep_name).trim();
    const rep = repRaw || '(unknown)';

    const s = stores[store] || (stores[store] = { today: 0, mtd: 0, reps: {} });
    s.mtd++;
    if (isToday) s.today++;
    const p = s.reps[rep] || (s.reps[rep] = { today: 0, mtd: 0 });
    p.mtd++;
    if (isToday) p.today++;

    // Rapid-fire input, collected in THIS pass on purpose. The consumer joins the
    // two files on store + '||' + rep, so those keys have to be the same BYTES in
    // both. Deriving them twice is how they drift — a second normalizer, a stray
    // trim rule, a different blank-name policy — and drifted keys match nothing
    // and fail SILENTLY: no error, just a day where nobody is flagged and the
    // email looks clean. Same `store`, same `repRaw` the counts key came from.
    // TODAY only: the flags file is a today-only artefact, and today is always
    // inside the fiscal cycle above, so that `continue` can never eat one.
    if (isToday && repRaw) {              // a blank name is a bucket, not a person
      const key = store + '||' + repRaw;
      let g = rapidGroups.get(key);
      if (!g) { g = { store: store, rep: repRaw, times: [] }; rapidGroups.set(key, g); }
      g.times.push(d.getTime());
    }
  }

  // Fold each rep's day into bursts. Reps with no cluster, and stores with no
  // flagged rep, are omitted entirely — presence in this file MEANS flagged, and
  // that omission is what keeps it a couple of KB instead of a copy of the feed.
  const flagStores = {};
  let flaggedRepCount = 0, flaggedRowCount = 0;
  rapidGroups.forEach(g => {
    const clusters = rapidClusters(g.times);
    if (!clusters.length) return;
    flaggedRepCount++;
    let flaggedRows = 0;
    for (const c of clusters) flaggedRows += c.length;
    flaggedRowCount += flaggedRows;
    const bucket = flagStores[g.store] || (flagStores[g.store] = { reps: {} });
    bucket.reps[g.rep] = {
      // Number of flagged SUBMISSIONS for this rep. The digest recomputes this
      // (and the cluster count, and the biggest burst) from the clusters rather
      // than trusting the field, so it is a convenience for a human reading the
      // raw file — never let it disagree with the clusters below it.
      flagged: flaggedRows,
      // RAW ISO strings, in ascending time order. The email formats them into
      // Chicago wall-clock itself; a pre-formatted string would lock every
      // consumer to one presentation.
      clusters: clusters.map(c => c.map(ms => new Date(ms).toISOString()))
    };
  });

  // ONE run_id per feed read, stamped on BOTH files. The digest refuses to paint
  // flags whose run_id differs from the counts' — that is the only way to catch
  // 12:00 counts being coloured in with 11:50 flags, which would look like a
  // perfectly ordinary email. It only has to be equal across the two files of one
  // read and different across reads; the timestamp makes it readable in a diff
  // and the random suffix keeps two runs in the same second apart.
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replace(/\.\d+Z$/, 'Z') + '#' + crypto.randomBytes(3).toString('hex');

  const out = {
    generated_at: generatedAt,
    run_id: runId,
    timezone: TZ,
    day: today,
    cycle_start: cycle.start,
    cycle_end: cycle.end,
    cycle_label: cycle.label,
    month: cycle.end.slice(0, 7),   // kept for backwards compatibility
    source_rows: rows.length,
    stores: stores
  };

  const flagsOut = {
    generated_at: generatedAt,
    run_id: runId,
    day: today,                    // REQUIRED: the digest's staleness check. A flags
                                   // file for yesterday next to today's counts would
                                   // render as a spotless day, which is the worst way
                                   // this can fail, so it is refused on this field.
    timezone: TZ,
    window_ms: RAPID_WINDOW_MS,    // the digest refuses a file built with another window
    rule: RAPID_RULE,
    stores: flagStores
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  /* NO-CHANGE DETECTION — the two files move together or not at all.
     Without this the Action commits every ten minutes for nothing and the repo
     history becomes unreadable. Two traps here:

     1. generated_at and run_id change on EVERY run, so comparing whole files
        would never match and the check would be dead code. Compare only the
        MEANINGFUL content: the numbers, the day, and (for flags) the window the
        file was built with.
     2. The two files must never carry DIFFERENT run_ids. If flags were rewritten
        and counts were left alone, the digest would see two run_ids, decide the
        files came from reads ten minutes apart and refuse to apply any flags —
        a silently unflagged email caused by a commit we skipped to be tidy. So
        the decision is joint: if EITHER file's content moved, BOTH are rewritten
        with the same fresh generated_at/run_id; if neither moved, NEITHER is
        touched and both keep the previous pair, which still matches.
     `pairedIds` covers the deployment case: an old counts file with no run_id, or
     a missing/hand-deleted flags file, forces one rewrite that puts the pair back
     in step. (The stores comparison is by serialized key order, as it always has
     been. A feed that reorders its rows costs one spurious commit, never a wrong
     file.) */
  const prevCounts = readJsonOrNull(OUT);
  const prevFlags = readJsonOrNull(FLAGS_OUT);
  const countsSame = !!prevCounts &&
    prevCounts.day === out.day &&
    JSON.stringify(prevCounts.stores) === JSON.stringify(out.stores);
  const flagsSame = !!prevFlags &&
    prevFlags.day === flagsOut.day &&
    Number(prevFlags.window_ms) === flagsOut.window_ms &&
    JSON.stringify(prevFlags.stores) === JSON.stringify(flagsOut.stores);
  const pairedIds = !!prevCounts && !!prevFlags &&
    !!prevCounts.run_id && prevCounts.run_id === prevFlags.run_id;

  if (countsSame && flagsSame && pairedIds) {
    console.log('no change; leaving both files as-is (run_id ' + prevCounts.run_id + ')');
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  fs.writeFileSync(FLAGS_OUT, JSON.stringify(flagsOut) + '\n');
  const bytes = fs.statSync(OUT).size;
  const flagBytes = fs.statSync(FLAGS_OUT).size;
  console.log('cycle ' + cycle.label + ' (' + cycle.start + ' .. ' + cycle.end + ')');
  console.log(
    'wrote ' + OUT + ' — ' + Object.keys(stores).length + ' stores, ' +
    bytes + ' bytes, from ' + rows.length + ' rows (' + skipped + ' skipped) in ' + fetchMs + 'ms'
  );
  console.log(
    'wrote ' + FLAGS_OUT + ' — ' + Object.keys(flagStores).length + ' stores, ' +
    flaggedRepCount + ' flagged reps, ' + flaggedRowCount + ' flagged submissions, ' +
    flagBytes + ' bytes, run_id ' + runId
  );
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
