#!/usr/bin/env node
/* =========================================================================
 * tsheet-digest.js — GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Built by email/build.js from digest.js + fetch-data.js + cli.js.
 * Edit those and re-run `node build.js`; `node build.js --check` fails if this
 * file has drifted from them.
 *
 * Single file, zero npm dependencies, Node 20. It is meant to be curled into a
 * fresh cloud container and run immediately:
 *
 *   node tsheet-digest.js --slot=12:00 --out=emails.json [--day=YYYY-MM-DD] [--dry-run]
 * ========================================================================= */
/**
 * digest.js — composes the T-Sheet district email digest.
 *
 * PURE. No network, no filesystem, no timers, no side effects. Give it a day's
 * submissions and it hands back finished HTML + plain-text emails.
 *
 * WHY IT LOOKS LIKE 2009 JAVASCRIPT
 * This logic is expected to be pasted into Jeff's Google Apps Script project
 * later so the digest can send from the same account that owns the T-sheet
 * feed. So: no npm imports, no fetch, no top-level await, no Node-only APIs,
 * ES5-shaped functions. The only modern dependency is Intl.DateTimeFormat,
 * which the Apps Script V8 runtime does have. If this ever has to run on the
 * old Rhino runtime, Intl is the one thing you must replace.
 *
 * WHY THE HTML LOOKS LIKE 1999 HTML
 * Jeff screenshots each district block on his iPhone and posts it into that
 * district's group chat. It has to survive Gmail iOS, which throws away
 * <style> blocks, flexbox, grid, position, external fonts and external images.
 * So: nested tables, every colour inline AND on a bgcolor attribute, and each
 * district is a self-contained card that still makes sense cropped out of the
 * email with no header above it.
 */
'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */

var TZ = 'America/Chicago';              // every day boundary is store time, never UTC
var RAPID_WINDOW_MS = 5 * 60 * 1000;     // the rapid-fire window Jeff chose

/* HOW OLD THE COUNTS MAY BE before the card says so in amber rather than in grey.
   The GitHub Action that writes tsheet-counts.json is scheduled every 10 minutes
   but GitHub delays and drops scheduled runs under load, so an hour-plus gap is
   normal enough not to shout about and a 90-minute one is not. This threshold is
   PUBLISHED in the pre-rendered digest file (as age_stale_after_minutes) so the
   Zapier Code step picks the same variant this renderer would have picked. */
var STALE_COUNTS_MS = 90 * 60 * 1000;

var JEFF = { name: 'Jeff Bilbrey', email: 'jbilbrey@blufoxmobile.com' };

/* Districts, DM names and the store rosters are the dashboard's DISTRICTS const
   (index.html ~line 1003). DM emails come from store-directory.json. The
   dashboard calls the first four "Chicago North/South/East/West" where the store
   directory says "North Side" etc — user-facing output uses the dashboard names. */
/* FALLBACK ROSTER ONLY — a snapshot of store-directory.json, generated from it so
   the names, the order and the store membership match what the live file says
   today. Used when that file cannot be read, and when it is used the email says
   so in every district card. It WILL go stale; that is the point of the note. */
var DEFAULT_DISTRICTS = [
  { key: 'north-side', name: 'North Side', dm: 'Imaad Dhorajiwala', dmEmail: 'IDhorajiwala@blufoxmobile.com',
    stores: ['Cicero Xfinity Store',
             'Evanston Xfinity Store',
             'Kildeer Xfinity Store',
             'Machesney Park Xfinity Store',
             'South Skokie Xfinity Store',
             'Uptown Xfinity Store'] },
  { key: 'south-side', name: 'South Side', dm: 'Juan Carrillo', dmEmail: 'juCarrillo@blufoxmobile.com',
    stores: ['Bourbonnais Xfinity Store',
             'Evergreen Park Xfinity Store',
             'Frankfort Xfinity Store',
             'Oak Lawn Xfinity Store',
             'Tinley Park Xfinity Store'] },
  { key: 'east-side', name: 'East Side', dm: 'Jacob Cabrales', dmEmail: 'jcabrales@blufoxmobile.com',
    stores: ['Elkhart Xfinity Store',
             'Hammond Xfinity Store',
             'Michigan City Xfinity Store',
             'Schererville Xfinity Store',
             'South Bend Xfinity Store',
             'Valparaiso Xfinity Store'] },
  { key: 'big-south', name: 'Big South', dm: 'Matthew Brooks', dmEmail: 'mbrooks@blufoxmobile.com',
    stores: ['Greeneville Xfinity Store',
             'Johnson City Xfinity Store',
             'North Knoxville Xfinity Store',
             'Oak Ridge Xfinity Store',
             'South Knoxville Xfinity Store'] },
  { key: 'west-side', name: 'West Side', dm: 'Tanzim Chowdhury', dmEmail: 'tchowdhury@blufoxmobile.com',
    stores: ['Burbank Xfinity Store',
             'Calumet City Xfinity Store',
             'Dekalb Xfinity Store',
             'Glenview Xfinity Store',
             'Round Lake Beach Xfinity Store'] }
];

/* ------------------------------------------------------------
   PALETTE

   Near-black ink ground with brass accents — the cookcountycooks.com system,
   carried through colour and proportion because email cannot load Bodoni Moda
   or Archivo. A system stack stands in for the type; we do not fake the fonts.

   Chosen dark-first ON PURPOSE. Gmail iOS decides per-message whether to invert;
   it leaves already-dark messages alone far more often than it leaves light ones
   alone, and when it DOES invert, every colour here is stated explicitly on both
   the background and the text of the same cell, so the pair flips together and
   contrast survives. Nothing inherits a colour it did not set. Pure #000/#fff are
   avoided because they invite the most aggressive inversion.

   And nothing here conveys "flagged" by colour alone — red always ships with the
   ⚑ glyph and the literal words RAPID-FIRE.
   ------------------------------------------------------------ */
var C = {
  page:        '#05070a',   // brand ink ground
  card:        '#0d1016',
  cardEdge:    '#3a3226',   // dark brass edge
  storeBar:    '#151a22',
  rule:        '#1e242e',
  ink:         '#f2efe8',   // warm off-white, not pure white
  dim:         '#9aa1ab',
  faint:       '#6c757f',
  brass:       '#c9a961',
  brassDim:    '#8a7440',
  flag:        '#ff6b6b',   // legible on the dark ground, still red after inversion
  flagInk:     '#ffd5d0',
  flagBg:      '#3a1518',
  flagEdge:    '#8c3a34',
  noteBg:      '#221c0e',
  noteEdge:    '#6b5a24'
};

/* FONT STACKS — deliberately short, because they are the single largest thing in
   this email by bytes. The original stack was repeated ~275 times in Jeff's
   all-districts message and accounted for a third of its weight; Gmail clips a
   message over ~102 KB and drops the rest behind a "View entire message" link,
   which is exactly the part he screenshots.

   Every platform that matters still gets its intended face:
     -apple-system  iOS / macOS -> San Francisco (all WebKit, and Blink >= 56)
     'Segoe UI'     Windows, including the Outlook/Word rendering engine
     sans-serif     the generic, which the platform already resolves to Roboto on
                    Android, Arial on Windows and Helvetica on macOS — so it
                    does the job the explicit Roboto/Helvetica/Arial tail did.
   Dropped, each because something later in the list already lands on the same
   face on the platform that would have used it: BlinkMacSystemFont (an alias of
   -apple-system in every Chrome since 2017), Roboto (Android's own generic
   sans-serif), 'Helvetica Neue' / Helvetica / Arial (the generic, on the
   platforms that have them).

   font-family is still restated on EVERY <td>, and that repetition is the
   expensive part. It stays: the Word engine behind desktop Outlook does not
   reliably inherit a font into a table cell, and this is a Microsoft shop.
   Inline elements DO inherit from their own cell in every engine, so the spans
   below do not repeat it. */
var F = "-apple-system,'Segoe UI',sans-serif";
var SERIF = "Georgia,'Times New Roman',Times,serif";   // stands in for the Bodoni display voice

/* Emitted constantly, so they live in variables rather than being rebuilt. */
var FF = 'font-family:' + F + ';';
var TBL = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ';

/* ============================================================
   SMALL UTILITIES
   ============================================================ */

/* Escapes markup AND folds every non-ASCII character to a numeric entity.
   WHY THE SECOND HALF: these emails are sent by a Zapier "Outlook - Send Email"
   action with bodyFormat HTML, and that action may inject our body into its own
   document wrapper -- dropping our <meta charset="utf-8"> with it. A rep named
   Renee Munoz with the accents on, or the em dash in a stale-flags note, would
   then arrive as mojibake. Numeric entities render identically with or without a
   charset declaration, so the body is charset-independent. Surrogate pairs are
   recombined so an astral character survives as one entity rather than two. */
function esc(s) {
  s = String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  var out = '', i, c, lo;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c < 128) { out += s.charAt(i); continue; }
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      lo = s.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        out += '&#' + (((c - 0xD800) * 0x400) + (lo - 0xDC00) + 0x10000) + ';';
        i++; continue;
      }
    }
    out += '&#' + c + ';';
  }
  return out;
}

/* Store naming, copied from Daily-Sales-Report/scripts/build-tsheet-counts.js so
   the email buckets rows exactly the way the counts file and the dashboard do.
   Legacy "Skokie Xfinity Store" and a bare "Machesney Park" must roll up, or the
   same store shows twice under two names. */
var STORE_ALIASES = { skokie: 'South Skokie', knoxville: 'South Knoxville' };
function normalizeStoreName(raw) {
  var s = String(raw == null ? '' : raw).replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  s = s.replace(/\s*Xfinity\s+Store\s*$/i, '');
  if (!s) return '';
  var low = s.toLowerCase();
  if (STORE_ALIASES[low]) s = STORE_ALIASES[low];
  return s + ' Xfinity Store';
}

function normalizeRepName(raw) {
  return String(raw == null ? '' : raw).replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
}

/* A rep name that can never be flagged: blank, or the "(unknown)" placeholder the
   counts builder writes for a blank rep_name. You cannot accuse a placeholder of
   faking submissions. */
function isRealRep(name) {
  if (!name) return false;
  var low = name.toLowerCase();
  return low !== '(unknown)' && low !== 'unknown' && low !== 'n/a';
}

var _fmtCache = {};
function fmt(opts) {
  var k = JSON.stringify(opts);
  if (!_fmtCache[k]) {
    opts.timeZone = TZ;
    _fmtCache[k] = new Intl.DateTimeFormat('en-US', opts);
  }
  return _fmtCache[k];
}
var _ymdFmt = null;
function ymdInTZ(d) {
  if (!_ymdFmt) _ymdFmt = new Intl.DateTimeFormat('en-CA',
    { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return _ymdFmt.format(d);     // "2026-09-03"
}
function clockInTZ(d) {
  return fmt({ hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(d);
}
function shortClockInTZ(d) {
  return fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}
/* A 'YYYY-MM-DD' day string -> a Date safely inside that day in Chicago.
   Noon UTC is 6 or 7 a.m. Chicago — never the day before, never the day after. */
function dayToDate(day) { return new Date(String(day) + 'T12:00:00Z'); }
function longDate(day) {
  return fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(dayToDate(day));
}
function shortDate(day) {
  return fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(dayToDate(day));
}
function weekdayIndex(day) {
  var w = fmt({ weekday: 'short' }).format(dayToDate(day));
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(w);
}

/* The digest goes out at 12:00 PM, 3:00 PM and 6:00 PM Chicago, Mon-Sat.
   Snap `now` to the slot it belongs to so the subject line says "3:00 PM" even
   when the job actually fired at 3:00:41. More than an hour off any slot and we
   print the real time rather than lie about which run this was. */
var SEND_SLOTS = [{ h: 12, label: '12:00 PM' }, { h: 15, label: '3:00 PM' }, { h: 18, label: '6:00 PM' }];
function slotLabel(now) {
  var hh = Number(fmt({ hour: '2-digit', hour12: false }).format(now));
  var mm = Number(fmt({ minute: '2-digit' }).format(now));
  var mins = hh * 60 + mm, best = null, bestD = 1e9;
  for (var i = 0; i < SEND_SLOTS.length; i++) {
    var d = Math.abs(mins - SEND_SLOTS[i].h * 60);
    if (d < bestD) { bestD = d; best = SEND_SLOTS[i]; }
  }
  if (bestD <= 59) return best.label;
  return fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
}

function plural(n, one, many) { return n === 1 ? one : many; }

/* "22 minutes old" / "3 hours 31 minutes old". Minutes alone reads fine up to an
   hour; past that Jeff wants the size of the gap, not a four-digit minute count.

   THE OUTPUT IS PLAIN ASCII, ALWAYS. That is load-bearing, not incidental: the
   pre-rendered digest hands this phrase to the Zapier Code step as {{AGE_TEXT}},
   which substitutes it into already-escaped HTML. esc() is the identity on this
   string, so substituting the raw phrase gives byte-identical HTML to rendering
   it here. Never put an en dash, a non-breaking space or a "≈" in it. */
function ageText(ms) {
  var m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + ' ' + plural(m, 'minute', 'minutes') + ' old';
  var h = Math.floor(m / 60), r = m % 60;
  return h + ' ' + plural(h, 'hour', 'hours') +
    (r ? ' ' + r + ' ' + plural(r, 'minute', 'minutes') : '') + ' old';
}

/* ============================================================
   THE LIVE ROSTER — store-directory.json

   Jeff maintains store/district alignment and the employee roster in the Admin
   Panel Directory UI, which publishes store-directory.json to GitHub Pages. In
   his words: "Sometimes, I will change stores so I like for the alignment to
   come from this." So districts, their names, their store membership and the DM
   name+email are all READ AT RUN TIME from that file. DEFAULT_DISTRICTS below is
   a FALLBACK ONLY, used when the fetch fails — and when it is used the email
   says so, because a roster that silently reverts to a stale hardcoding is
   exactly the failure he asked to prevent.

   District NAMES come from the directory too ("North Side", not the dashboard's
   "Chicago North"). He maintains the Admin Panel, so that is where a rename
   belongs, and the dashboard is being changed to match.
   ============================================================ */

/* The four keys we depend on. Anything missing and we fall back visibly rather
   than composing an email out of half a roster. */
function directoryIsUsable(dir) {
  if (!dir || typeof dir !== 'object') return false;
  if (!dir.districts || !dir.districts.length) return false;
  if (!dir.storeDistricts || typeof dir.storeDistricts !== 'object') return false;
  if (!dir.storeEmployees || typeof dir.storeEmployees !== 'object') return false;
  if (!dir.stores || !dir.stores.length) return false;
  for (var i = 0; i < dir.districts.length; i++) {
    var d = dir.districts[i];
    if (!d || !d.id || !d.name) return false;
  }
  return true;
}

/**
 * parseDirectory(dir) -> { districts, roster, unknownDistrictIds, unrosteredStores }
 *
 *   districts  the same shape as DEFAULT_DISTRICTS, built from `districts` +
 *              `storeDistricts`, in the directory's own order.
 *   roster     normalizedStore -> { lowercased "first last" -> { name, email } }
 *              Used ONLY to normalize the DISPLAY spelling of a submitted name
 *              and to carry the employee's address through to the JSON. It never
 *              decides who is counted or flagged.
 */
function parseDirectory(dir) {
  var byId = {}, districts = [], i;
  for (i = 0; i < dir.districts.length; i++) {
    var d = dir.districts[i];
    var entry = { key: d.id, name: d.name, dm: d.dmName || '', dmEmail: d.dm || '', stores: [] };
    byId[d.id] = entry;
    districts.push(entry);                    // directory order, not ours
  }

  var unknownDistrictIds = {}, storeNames = Object.keys(dir.storeDistricts);
  for (i = 0; i < storeNames.length; i++) {
    var store = normalizeStoreName(storeNames[i]);
    if (!store) continue;
    var id = dir.storeDistricts[storeNames[i]];
    if (byId[id]) {
      if (byId[id].stores.indexOf(store) === -1) byId[id].stores.push(store);
    } else {
      (unknownDistrictIds[id] || (unknownDistrictIds[id] = [])).push(store);
    }
  }
  for (i = 0; i < districts.length; i++) districts[i].stores.sort();

  /* EFFECTIVE ROSTER = storeEmployees + the store's SM + its AM + its district's
     DM. Jeff: "Include manager submissions because they are supposed to do these
     too." They were always COUNTED (the breakdown is built from the submissions
     feed, not the roster) but they were second-class in roster handling: absent
     from storeEmployees, they never matched, so they never got display-name
     normalization, never got an email, and always read onRoster:false.

     Note the shape mismatch that makes this fiddly: storeEmployees is
     { store: [{first,last,email}] } while the manager data is TWO parallel maps,
     storeManagerNames { store: "First Last" } and storeManagers { store: email }.
     Both are normalized into one internal shape here rather than special-cased at
     every use site. */
  var roster = {}, rosterHasEmployees = {}, empStores = Object.keys(dir.storeEmployees);
  function addPerson(store, name, email, role) {
    if (!store || !name) return;
    var bucket = roster[store] || (roster[store] = {});
    var k = name.toLowerCase();
    // First writer wins, so a duplicate row in the panel cannot blank an email.
    // Roles are added AFTER reps, so a store's own leader keeps their rep record
    // if they somehow appear in both -- but picks the role up either way.
    if (!bucket[k]) bucket[k] = { name: name, email: email || null, role: role || null };
    else if (role && !bucket[k].role) bucket[k].role = role;
  }
  for (i = 0; i < empStores.length; i++) {
    var st = normalizeStoreName(empStores[i]);
    if (!st) continue;
    var list = dir.storeEmployees[empStores[i]] || [];
    if (list.length) rosterHasEmployees[st] = true;   // tracked separately: a store
    for (var j = 0; j < list.length; j++) {           // with only a manager still
      var e = list[j] || {};                          // has "no employees rostered"
      addPerson(st, normalizeRepName((e.first || '') + ' ' + (e.last || '')), e.email, null);
    }
  }

  /* Two indexes that turn "not on this store's roster" from a flat list of names
     into something Jeff can act on. Without them the section is ~24 identical
     lines three times a day and he stops reading it.
       rosterIndex  lowercased name -> the stores they ARE rostered at, so a line
                    can say "rostered at Evanston" -- i.e. covering a shift, not a
                    missing employee record.
       leaderNames  managers, assistant managers and DMs, who are never on a store
                    employee roster but legitimately submit at their stores. */
  var rosterIndex = {}, storeKeys = Object.keys(roster);
  for (i = 0; i < storeKeys.length; i++) {
    var names = Object.keys(roster[storeKeys[i]]);
    for (var n = 0; n < names.length; n++) {
      // reps only: "rostered at X" must not list every store a DM covers
      if (roster[storeKeys[i]][names[n]].role) continue;
      (rosterIndex[names[n]] || (rosterIndex[names[n]] = [])).push(storeKeys[i]);
    }
  }

  /* Leaders are keyed BY STORE, not just globally. A store manager, assistant
     manager or DM is never on a store's employee roster but legitimately submits
     at their own store -- on the live directory that alone was 21 of 24 "issues",
     which would have buried the 3 real ones. So a leader AT THE STORE THEY RUN is
     not an issue; the same person submitting at a store they do not run still is.
     leaderNames stays as a global lookup so those lines can say what the person is. */
  var storeLeaders = {}, leaderNames = {}, leaderPeople = {};
  function addLeaders(nameMap, emailMap, tag, label) {
    if (!nameMap) return;
    var ks = Object.keys(nameMap);
    for (var q = 0; q < ks.length; q++) {
      var nm = normalizeRepName(nameMap[ks[q]]);
      if (!nm) continue;
      var lk = nm.toLowerCase(), em = (emailMap && emailMap[ks[q]]) || null;
      leaderNames[lk] = label;
      // The tag describes the PERSON, so it travels with them to any store.
      if (!leaderPeople[lk]) leaderPeople[lk] = { name: nm, email: em, role: tag, leads: [] };
      var st2 = normalizeStoreName(ks[q]);
      if (!st2) continue;
      // Which store they LEAD, so an off-roster line can say so. Not collected for
      // DMs: a DM leads every store in their district, and naming all six says
      // nothing useful.
      if (tag !== 'DM' && leaderPeople[lk].leads.indexOf(st2) === -1) leaderPeople[lk].leads.push(st2);
      (storeLeaders[st2] || (storeLeaders[st2] = {}))[lk] = label;
      addPerson(st2, nm, em, tag);
    }
  }
  addLeaders(dir.storeManagerNames, dir.storeManagers, 'SM', 'store manager');
  addLeaders(dir.storeAMNames, dir.storeAMs, 'AM', 'assistant manager');
  addLeaders(dir.storeDMNames, dir.storeDMs, 'DM', 'district manager');
  for (i = 0; i < dir.districts.length; i++) {
    var dn = normalizeRepName(dir.districts[i].dmName || '');
    if (!dn) continue;
    var dk = dn.toLowerCase(), dEmail = dir.districts[i].dm || null;
    leaderNames[dk] = 'district manager';
    if (!leaderPeople[dk]) leaderPeople[dk] = { name: dn, email: dEmail, role: 'DM', leads: [] };
    // a DM covers every store in their district
    for (var ds = 0; ds < districts[i].stores.length; ds++) {
      (storeLeaders[districts[i].stores[ds]] || (storeLeaders[districts[i].stores[ds]] = {}))[dk] = 'district manager';
      addPerson(districts[i].stores[ds], dn, dEmail, 'DM');
    }
  }

  return { districts: districts, roster: roster, rosterHasEmployees: rosterHasEmployees,
           unknownDistrictIds: unknownDistrictIds, rosterIndex: rosterIndex,
           leaderNames: leaderNames, leaderPeople: leaderPeople, storeLeaders: storeLeaders };
}

/* ============================================================
   THE FLAG RULE

   A cluster is the SAME REP at the SAME STORE filing 2+ T-sheets inside five
   minutes. Jeff picked "same rep only" explicitly over "same store, any rep":
   two different people a minute apart is a busy counter, not a faker. Reps are
   therefore keyed by store + name, never by name alone — there is more than one
   "Mike" in 27 stores and they must not be able to flag each other.

   Every submission in a cluster is flagged. A rep is flagged if it has at least
   one cluster today. A store is flagged if any of its reps is flagged today —
   one cluster paints the store for the whole day, also Jeff's call.

   CLUSTER GROUPING: SPLIT ON THE GAP.
   A new cluster starts whenever the gap to the previous submission EXCEEDS the
   window. The naive reading -- "maximal runs of consecutive flagged rows" -- is
   wrong in exactly the case that matters: a rep whose whole day is bursts never
   has an unflagged row to break the run, so a 2:14pm pair and a 6:33pm pair fuse
   into one bogus cluster. Anaf Rahman at Evanston on 2026-09-02 is the pinned
   real case: four separate bursts of [2,5,2,2], not one cluster of 11.
   Which rows are FLAGGED is identical either way; only the evidence grouping
   changes. This matches the dashboard.

   PER-REP COUNTERS. Today's rule is still "any cluster of 2+ flags the rep", but
   flaggedCount / clusterCount / maxClusterSize are all carried on every rep so a
   future threshold ("only 3+ in five minutes", or "only 2+ separate bursts") is a
   template change and not a recomputation.
   ============================================================ */
function computeFlags(rows) {
  var groups = {}, order = [], i;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!isRealRep(r.rep)) continue;          // blank / "(unknown)" never flags
    if (!r.time || isNaN(r.time)) continue;   // no timestamp, nothing to compare
    var key = r.store + '||' + r.rep;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(r);
  }

  var out = {};   // "store||rep" -> { flagged, clusters:[{times:[ms,...]}] }
  for (i = 0; i < order.length; i++) {
    var g = groups[order[i]];
    g.sort(function (a, b) { return a.time - b.time; });
    var n = g.length, flagged = [], j;
    for (j = 0; j < n; j++) flagged.push(false);
    for (j = 1; j < n; j++) {
      // <= so identical timestamps count as inside the window. 5m00s exactly is in.
      if ((g[j].time - g[j - 1].time) <= RAPID_WINDOW_MS) { flagged[j] = true; flagged[j - 1] = true; }
    }
    var clusters = [], cur = null, flaggedCount = 0, maxSize = 0;
    for (j = 0; j < n; j++) {
      if (!flagged[j]) { cur = null; continue; }
      flaggedCount++;
      // Continue the burst only if this row is within the window of the previous
      // one; otherwise this is a new burst even though both rows are flagged.
      if (cur && (g[j].time - g[j - 1].time) <= RAPID_WINDOW_MS) cur.push(g[j].time);
      else { cur = [g[j].time]; clusters.push(cur); }
    }
    for (j = 0; j < clusters.length; j++) if (clusters[j].length > maxSize) maxSize = clusters[j].length;
    out[order[i]] = {
      flagged: clusters.length >= 1, clusters: clusters,
      flaggedCount: flaggedCount, clusterCount: clusters.length, maxClusterSize: maxSize
    };
  }
  return out;
}

/* ============================================================
   AGGREGATION
   ============================================================ */

/* Normalize whatever the caller handed us into { store, rep, time } rows for the
   requested day. `time` is a number (ms) or null when the source had no
   timestamp — the pre-aggregated counts file is exactly that case. */
function prepareRows(submissions, day) {
  var rows = [], anyTimestamp = false;
  for (var i = 0; i < submissions.length; i++) {
    var s = submissions[i];
    if (!s) continue;
    var store = normalizeStoreName(s.store);
    if (!store) continue;
    var rep = normalizeRepName(s.rep_name != null ? s.rep_name : s.rep);
    if (!rep) rep = '(unknown)';

    var t = null;
    if (s.timestamp != null && s.timestamp !== '') {
      var d = (s.timestamp instanceof Date) ? s.timestamp : new Date(s.timestamp);
      if (!isNaN(d.getTime())) {
        // Day boundaries are America/Chicago, always.
        if (ymdInTZ(d) !== day) continue;
        t = d.getTime();
        anyTimestamp = true;
      } else {
        continue;   // a timestamp we cannot parse is a row we cannot place in a day
      }
    }
    rows.push({ store: store, rep: rep, time: t });
  }
  return { rows: rows, anyTimestamp: anyTimestamp };
}

function buildModel(opts) {
  var day = opts.day;
  var districts = opts.districts || DEFAULT_DISTRICTS;
  var prepped = prepareRows(opts.submissions || [], day);
  var rows = prepped.rows;

  // Flag detection is only possible when the source carried timestamps. Callers
  // can force it off; otherwise we detect it. We never present untimed counts as
  // if they had been checked.
  var flagsAvailable = (opts.flagsAvailable === undefined || opts.flagsAvailable === null)
    ? (prepped.anyTimestamp || !!opts.flags)
    : !!opts.flagsAvailable;

  // Flags either come precomputed (the published tsheet-flags.json, which is how
  // scheduled runs get them, because the container cannot reach the raw feed) or
  // are computed here from timestamps we were handed. Same internal shape.
  var flags = {};
  if (flagsAvailable) flags = opts.flags ? opts.flags : computeFlags(rows);

  // store -> { today, reps: { rep -> count } }
  var byStore = {}, storeOrder = [], i;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!byStore[r.store]) { byStore[r.store] = { today: 0, reps: {}, repOrder: [] }; storeOrder.push(r.store); }
    var st = byStore[r.store];
    st.today++;
    if (st.reps[r.rep] === undefined) { st.reps[r.rep] = 0; st.repOrder.push(r.rep); }
    st.reps[r.rep]++;
  }

  var roster = opts.roster || {};
  var rosterIndex = opts.rosterIndex || {};
  var leaderNames = opts.leaderNames || {};
  var leaderPeople = opts.leaderPeople || {};
  var storeLeaders = opts.storeLeaders || {};
  var rosterHasEmployees = opts.rosterHasEmployees || {};
  var haveRoster = !!opts.roster;
  var unrostered = [];        // "reps at a store where they are not on that store's roster"
  // A store with NO roster at all: reported once, rather than listing every one of
  // its reps as unrostered and burying the real problem. Scoped to stores that
  // actually submitted today -- a standing gap at a store with no activity is not
  // something to put in front of five district managers three times a day.
  var unrosteredStores = [];

  var seen = {}, outDistricts = [];
  for (i = 0; i < districts.length; i++) {
    var d = districts[i];
    var stores = [], zeroStores = [], total = 0, flaggedReps = 0, flaggedStores = 0;
    for (var j = 0; j < d.stores.length; j++) {
      var name = normalizeStoreName(d.stores[j]);
      seen[name] = true;
      var st2 = byStore[name];
      if (!st2 || st2.today === 0) { zeroStores.push(name); continue; }

      var reps = [], storeFlagged = false;
      for (var k = 0; k < st2.repOrder.length; k++) {
        var rn = st2.repOrder[k];
        var f = flags[name + '||' + rn];
        var isF = !!(f && f.flagged);
        if (isF) { storeFlagged = true; flaggedReps++; }
        // The roster normalizes the DISPLAY spelling only. `rn` — the submitted,
        // trimmed name — stays the counting and flagging key, so the roster can
        // never change who is counted or who is flagged.
        //
        // THIS STORE'S effective roster is checked FIRST, always. That is what
        // stops a cross-match: a rep named "Chris Coleman" at one store must not
        // pick up the SM tag belonging to a different "Chris Coleman" who manages
        // another store. Matching their own store's roster gives them role null,
        // which is correct. Only a name that matches NOTHING at this store falls
        // through to the company-wide leader index — which is how a manager who
        // submitted at a store they do not run still gets their tag, since the tag
        // describes the person, not the location.
        var lowered = rn.toLowerCase();
        var storeEntry = roster[name] ? roster[name][lowered] : null;
        var rosterEntry = storeEntry || leaderPeople[lowered] || null;
        var leadsThisStore = storeLeaders[name] && storeLeaders[name][lowered];
        // Note this tests storeEntry, not rosterEntry: a manager submitting at a
        // store they do not run is still a directory issue, even though the leader
        // index gave us their proper name and tag.
        // rosterHasEmployees, not roster: at a store with no employees rostered at
        // all, listing each of its reps individually is the noise the store-level
        // line exists to replace. (Folding managers into the roster made this
        // distinction load-bearing -- every store now HAS a roster of some kind.)
        if (isRealRep(rn) && rosterHasEmployees[name] && !storeEntry && !leadsThisStore) {
          unrostered.push({
            name: rn, store: name,
            role: leaderNames[lowered] || null,                 // covering a shift, not a gap
            leads: (leaderPeople[lowered] && leaderPeople[lowered].leads || []).slice(0, 2),
            alsoAt: (rosterIndex[lowered] || []).slice(0, 3)    // where they ARE rostered
          });
        }
        reps.push({
          name: rosterEntry ? rosterEntry.name : rn,
          submittedName: rn,
          email: rosterEntry ? rosterEntry.email : null,
          onRoster: !!storeEntry,
          role: rosterEntry ? (rosterEntry.role || null) : null,   // 'SM' | 'AM' | 'DM' | null
          today: st2.reps[rn],
          flagged: isF,
          // Carried whether or not the rep is flagged, so a future threshold on
          // cluster SIZE or cluster COUNT is a template change, not a recompute.
          flaggedCount: isF ? f.flaggedCount : 0,
          clusterCount: isF ? f.clusterCount : 0,
          maxClusterSize: isF ? f.maxClusterSize : 0,
          clusters: isF ? f.clusters.map(function (times) {
            return { count: times.length, times: times.map(function (t) { return clockInTZ(new Date(t)); }) };
          }) : []
        });
      }
      // Highest first; ties alphabetical so the order is stable run to run.
      reps.sort(function (a, b) { return b.today - a.today || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });

      if (haveRoster && !rosterHasEmployees[name]) unrosteredStores.push(name);
      if (storeFlagged) flaggedStores++;
      total += st2.today;
      stores.push({ name: name, today: st2.today, flagged: storeFlagged, employees: reps });
    }
    stores.sort(function (a, b) { return b.today - a.today || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    zeroStores.sort();

    outDistricts.push({
      key: d.key, name: d.name, dm: d.dm, dmEmail: d.dmEmail,
      today: total, flaggedReps: flaggedReps, flaggedStores: flaggedStores,
      stores: stores, zeroStores: zeroStores
    });
  }

  // Stores that submitted but belong to no district roster. Almost always a new
  // store or a typo the aliases do not cover yet. Silently dropping them would
  // make the company total disagree with the dashboard, so Jeff sees them.
  var unassigned = [];
  for (i = 0; i < storeOrder.length; i++) {
    if (!seen[storeOrder[i]]) unassigned.push({ name: storeOrder[i], today: byStore[storeOrder[i]].today });
  }
  unassigned.sort(function (a, b) { return b.today - a.today; });

  unrostered.sort(function (a, b) {
    return (a.store < b.store ? -1 : a.store > b.store ? 1 : 0) || (a.name < b.name ? -1 : 1);
  });

  unrosteredStores.sort();

  return { day: day, districts: outDistricts, flagsAvailable: flagsAvailable,
           unassigned: unassigned, unrostered: unrostered, unrosteredStores: unrosteredStores };
}

/* ============================================================
   HTML — tables, inline colour, nothing a mail client can strip

   COMPACTION NOTES. The markup below is byte-for-byte tighter than the original
   but renders identically. What changed and why it is safe:
     - the font stack is shorter (see F above);
     - a <span> that sits inside a <td> which already declares the font does not
       restate it — inline elements inherit from their own cell in every engine,
       including Word/Outlook. Only the <td> reset is unreliable, and every <td>
       here still carries its own font-family;
     - "border-bottom:none" is simply omitted; no border is already the default;
     - "white-space:nowrap" is dropped from cells whose entire content is an
       integer, which has no break opportunity to begin with. It is KEPT on the
       RAPID-FIRE badge, where the hyphen is a real break opportunity.
   Nothing here changes a colour, a size, a padding or a weight.
   ============================================================ */

function cell(styles, content) { return '<td style="' + styles + '">' + content + '</td>'; }

/* Inherits its font from the rep-name cell it lives in. */
function flagBadge() {
  return '<span style="display:inline-block;background-color:' + C.flagBg + ';color:' + C.flagInk +
    ';border:1px solid ' + C.flagEdge + ';border-radius:4px;padding:2px 7px;font-size:12px;font-weight:700;' +
    'letter-spacing:0.06em;line-height:1.3;white-space:nowrap;">&#9873; RAPID-FIRE</span>';
}

/* The bucket key for a blank rep_name is "(unknown)", which is fine as data and
   useless to a DM. Say what it actually means: the sheet came in with no name on
   it. Those rows still count toward the store total; they just cannot be flagged. */
function repDisplayName(name) { return isRealRep(name) ? name : 'No name on the sheet'; }

/* A quiet SM / AM / DM qualifier on the name. Jeff asked for manager submissions
   to be included because "they are supposed to do these too" -- so what he
   actually wants to see is whether they are, without knowing every name in 27
   stores. Deliberately understated: dim, small, no fill, no border. It must not
   compete with the RAPID-FIRE badge, which is the only thing in this email that
   is allowed to shout. Plain reps get nothing. */
function roleTag(role) {
  if (!role) return '';
  return ' <span style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:' +
    C.dim + ';">' + esc(role) + '</span>';
}

function repRowHtml(rep, isLast) {
  var nameColor = rep.flagged ? C.flag : C.ink;
  var bb = isLast ? '' : 'border-bottom:1px solid ' + C.rule + ';';
  /* The glyph keeps its own <span> even though the cell already supplies the
     colour. The wrapper is not decoration: it breaks the text-shaping run, and
     folding "⚑ Ada Lovelace" into a single run re-rasterises the whole name a
     third of a pixel over. Verified — with the span, before/after render
     pixel-for-pixel identical; without it, 19 name lines shift. */
  var glyph = rep.flagged ? '<span>&#9873;</span> ' : '';

  var h = '<tr>' +
    cell('padding:11px 14px;' + bb + FF + 'font-size:19px;line-height:1.35;color:' + nameColor +
         ';font-weight:' + (rep.flagged ? '700' : '500') + ';',
         glyph + esc(repDisplayName(rep.name)) + roleTag(rep.role) +
         (rep.flagged ? ' &nbsp;' + flagBadge() : '')) +
    '<td align="right" valign="top" width="62" style="padding:11px 14px 11px 6px;' + bb + FF +
      'font-size:19px;font-weight:700;line-height:1.35;color:' + (rep.flagged ? C.flag : C.ink) + ';">' +
      rep.today + '</td></tr>';

  if (rep.flagged && rep.clusters.length) {
    var lines = [];
    for (var i = 0; i < rep.clusters.length; i++) {
      var c = rep.clusters[i];
      // Escape each time on its own; the arrow entity must survive the join.
      lines.push(c.count + ' in ' + c.times.map(esc).join('  &#8594;  '));
    }
    h += '<tr><td colspan="2" style="padding:0 14px 12px;' + bb + FF +
      'font-size:14px;line-height:1.5;color:' + C.flagInk + ';">' + lines.join('<br>') + '</td></tr>';
  }
  return h;
}

function storeBlockHtml(store) {
  var edge = store.flagged ? C.flag : C.brass;
  var nameColor = store.flagged ? C.flag : C.ink;
  var glyph = store.flagged ? '<span>&#9873;</span> ' : '';   // see repRowHtml

  var h = TBL + 'style="width:100%;border-collapse:collapse;margin:0 0 14px 0;">' +
    '<tr bgcolor="' + C.storeBar + '">' +
      '<td style="background-color:' + C.storeBar + ';border-left:4px solid ' + edge +
        ';padding:12px 14px;' + FF + 'font-size:20px;font-weight:700;line-height:1.3;color:' +
        nameColor + ';">' + glyph + esc(store.name.replace(/ Xfinity Store$/, '')) + '</td>' +
      '<td align="right" width="62" bgcolor="' + C.storeBar + '" style="background-color:' + C.storeBar +
        ';padding:12px 14px 12px 6px;' + FF + 'font-size:20px;font-weight:700;line-height:1.3;color:' +
        nameColor + ';">' + store.today + '</td>' +
    '</tr>';

  for (var i = 0; i < store.employees.length; i++) {
    h += repRowHtml(store.employees[i], i === store.employees.length - 1);
  }
  return h + '</table>';
}

/* ============================================================
   THE DATA-AGE ELEMENT

   ONE element per district card, always present, in exactly ONE position:
   directly under the headline numbers, above the "Counts only" / "Backup roster"
   notes. Fresh, it is a quiet grey line. Once the counts are older than
   STALE_COUNTS_MS it becomes the same amber note box the other two degraded
   states use — because if the numbers themselves are hours behind then nothing
   below them is worth reading closely, and Jeff must not screenshot them into a
   district group chat believing they are live.

   WHY ONE ELEMENT IN ONE PLACE, rather than a quiet footer line plus a separate
   amber box at the top: the pre-rendered digest (--emit-digest) replaces exactly
   this element with a single {{AGE_BLOCK}} placeholder and ships both variants
   beside it, so the Zapier Code step chooses a variant and fills in {{AGE_TEXT}}
   without rendering any HTML of its own. Two age elements in two positions could
   not be one placeholder, and a second placeholder is a second thing to get
   wrong in a UI text box.

   The clock ("3:42 PM CT") is baked in at render time — the counts file states
   when it was built and that never changes afterwards. Only the ELAPSED phrase
   depends on when the mail actually goes out, so only that is a placeholder.
   ============================================================ */
function ageBlockHtml(ctx) {
  // --emit-digest swaps the whole element for its placeholder.
  if (ctx.ageBlockOverride) return ctx.ageBlockOverride;
  // ...and renders each variant once with the elapsed phrase as a placeholder.
  var age = ctx.ageTextOverride || ctx.countsAge;
  if (ctx.countsStale) {
    return noteBoxHtml('Numbers may lag.',
      'These counts were built at ' + esc(ctx.countsClock) + ' (' + esc(age) +
      '). The feed that builds them can run hours apart, so what is in the stores right now may be higher.');
  }
  return '<tr><td colspan="2" style="padding:0 18px 14px;' + FF + 'font-size:13px;line-height:1.5;color:' +
    C.dim + ';">Counts as of <span style="color:' + C.brass + ';font-weight:700;">' + esc(ctx.countsClock) +
    '</span> (' + esc(age) + ').</td></tr>';
}

/* The amber "read this" box. Used for all three degraded states: no flags, backup
   roster, and counts older than 90 minutes. One shape so a DM learns it once. */
function noteBoxHtml(strongText, rest) {
  return '<tr><td colspan="2" style="padding:0 18px 14px;">' +
    TBL + 'bgcolor="' + C.noteBg + '" style="width:100%;background-color:' + C.noteBg +
      ';border:1px solid ' + C.noteEdge + ';border-radius:8px;">' +
    '<tr><td style="padding:11px 13px;' + FF + 'font-size:14px;line-height:1.5;color:' + C.ink + ';">' +
    '<span style="color:' + C.brass + ';font-weight:700;">&#9888; ' + strongText + '</span> ' + rest +
    '</td></tr></table></td></tr>';
}

/* ============================================================
   THE TWO SECTIONS

   Jeff screenshots these into two different chats, so they are two visually
   separate blocks inside one card, each labelled, each readable on its own:

     SECTION 1  T-SHEETS PER STORE  -- every store in the district, zeros
                included, counts only. This is the district scoreboard; it goes
                to the district chat and says nothing about individuals.
     SECTION 2  FILING 2+ WITHIN 5 MINUTES -- ONLY the people who tripped the
                rapid-fire rule, grouped under their store, in red, with the
                timestamps that triggered it. This is the one he sends to a
                store manager, so it must contain nothing a manager has to sift.

   Employees who submitted normally appear in NEITHER section by design. They are
   in the store count in section 1; naming them added length to both screenshots
   without adding anything a manager acts on.
   ============================================================ */
function sectionHeadHtml(label) {
  return '<tr><td colspan="2" style="padding:2px 18px 8px;' + FF +
    'font-size:12px;font-weight:700;letter-spacing:0.16em;color:' + C.brass +
    ';text-transform:uppercase;border-top:1px solid ' + C.rule + ';padding-top:16px;">' +
    esc(label) + '</td></tr>';
}

/* SECTION 1. One row per store, biggest first, then the zeros alphabetically —
   dist.stores is already sorted desc and dist.zeroStores alphabetically, so
   concatenating preserves both orders. A zero store is dimmed rather than
   hidden: "who did nothing today" is the whole reason this table exists. */
function storeCountsTableHtml(dist) {
  var rows = [];
  for (var i = 0; i < dist.stores.length; i++) {
    rows.push({ name: dist.stores[i].name, today: dist.stores[i].today, flagged: dist.stores[i].flagged });
  }
  for (var z = 0; z < dist.zeroStores.length; z++) {
    rows.push({ name: dist.zeroStores[z], today: 0, flagged: false });
  }
  if (!rows.length) {
    return '<div style="' + FF + 'font-size:17px;line-height:1.5;color:' + C.dim +
           ';padding:0 0 16px;">No stores in this district.</div>';
  }
  var h = TBL + 'style="width:100%;border-collapse:collapse;margin:0 0 16px 0;">';
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var zero = row.today === 0;
    var color = row.flagged ? C.flag : zero ? C.dim : C.ink;
    var glyph = row.flagged ? '<span>&#9873;</span> ' : '';   // see repRowHtml
    var bb = r === rows.length - 1 ? '' : 'border-bottom:1px solid ' + C.rule + ';';
    h += '<tr>' +
      cell('padding:11px 14px;' + bb + FF + 'font-size:19px;line-height:1.35;font-weight:' +
           (zero ? '500' : '700') + ';color:' + color + ';',
           glyph + esc(row.name.replace(/ Xfinity Store$/, ''))) +
      '<td align="right" valign="top" width="62" style="padding:11px 14px 11px 6px;' + bb + FF +
        'font-size:19px;font-weight:700;line-height:1.35;color:' + color + ';">' +
        row.today + '</td></tr>';
  }
  return h + '</table>';
}

/* SECTION 2. Only stores that actually have a flagged person, and inside them
   only the flagged people. A store with nobody flagged does not appear at all —
   its clean record is already visible in section 1. */
function flaggedStoresHtml(dist, ctx) {
  if (!ctx.flagsAvailable) {
    return '<div style="' + FF + 'font-size:17px;line-height:1.5;color:' + C.dim +
           ';padding:0 0 16px;">The 5-minute check did not run on this update, so nobody here has been ' +
           'cleared &#8212; they have not been checked.</div>';
  }
  var blocks = '';
  for (var i = 0; i < dist.stores.length; i++) {
    var st = dist.stores[i];
    var flaggedReps = [];
    for (var j = 0; j < st.employees.length; j++) {
      if (st.employees[j].flagged) flaggedReps.push(st.employees[j]);
    }
    if (!flaggedReps.length) continue;
    blocks += storeBlockHtml({ name: st.name, today: st.today, flagged: true, employees: flaggedReps });
  }
  if (!blocks) {
    return '<div style="' + FF + 'font-size:17px;line-height:1.5;color:' + C.dim +
           ';padding:0 0 16px;">Nobody in this district filed 2 or more T-sheets within 5 minutes today.</div>';
  }
  return blocks;
}

/* One district card. Self-contained on purpose: the district name, the DM, the
   date, the send slot and how old the numbers are all live INSIDE the card, so a
   screenshot cropped to this card alone still says what it is with no header
   above it. */
function districtCardHtml(dist, ctx) {
  var h = TBL + 'bgcolor="' + C.card + '" style="width:100%;background-color:' + C.card +
    ';border:1px solid ' + C.cardEdge + ';border-radius:12px;border-collapse:separate;margin:0 0 22px 0;">';

  // brass hairline across the top of the card
  h += '<tr><td colspan="2" bgcolor="' + C.brass + '" style="background-color:' + C.brass +
       ';height:4px;line-height:4px;font-size:1px;border-radius:12px 12px 0 0;">&nbsp;</td></tr>';

  // header — the font is set once on the cell; the two sans children inherit it
  h += '<tr><td colspan="2" style="padding:18px 18px 4px;' + FF + '">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:0.16em;color:' + C.brass +
      ';text-transform:uppercase;padding-bottom:6px;">T-Sheets &nbsp;&#183;&nbsp; ' + esc(ctx.shortDate) +
      ' &nbsp;&#183;&nbsp; ' + esc(ctx.slot) + '</div>' +
    '<div style="font-family:' + SERIF + ';font-size:30px;line-height:1.15;font-weight:700;color:' + C.ink + ';">' +
      esc(dist.name) + '</div>' +
    '<div style="font-size:15px;line-height:1.4;color:' + C.dim + ';padding-top:4px;">' + esc(dist.dm) + '</div>' +
    '</td></tr>';

  // headline numbers
  var flagText;
  if (!ctx.flagsAvailable) flagText = '<span style="color:' + C.brass + ';">flags not checked</span>';
  else if (dist.flaggedReps === 0) flagText = '<span style="color:' + C.dim + ';">0 flagged</span>';
  else flagText = '<span style="color:' + C.flag + ';font-weight:700;">&#9873; ' + dist.flaggedReps + ' flagged</span>';

  h += '<tr><td colspan="2" style="padding:8px 18px 14px;' + FF + '">' +
    '<span style="font-family:' + SERIF + ';font-size:40px;line-height:1;font-weight:700;color:' + C.brass + ';">' +
      dist.today + '</span>' +
    '<span style="font-size:17px;color:' + C.dim + ';">&nbsp; today &nbsp;&#183;&nbsp; </span>' +
    '<span style="font-size:17px;">' + flagText + '</span></td></tr>';

  // How old the numbers are, first of the notices and before anything they
  // qualify. Quiet when fresh, amber when not. See ageBlockHtml.
  h += ageBlockHtml(ctx);

  // the honest note when the run had no timestamps to check
  if (!ctx.flagsAvailable) {
    h += noteBoxHtml('Counts only.', esc(ctx.flagsReason) +
      ' Nobody here has been cleared &mdash; they have not been checked.');
  }

  // the same visible treatment when the LIVE ROSTER could not be read: a silent
  // revert to a stale hardcoded roster is precisely what Jeff asked to prevent.
  if (!ctx.directoryAvailable) {
    h += noteBoxHtml('Backup roster.', esc(ctx.directoryReason) +
      ' Store-to-district alignment and employee names below may be out of date.');
  }

  // SECTION 1 -- t-sheets per store, every store, zeros included
  h += sectionHeadHtml('1 \u00b7 T-sheets per store');
  h += '<tr><td colspan="2" style="padding:0 18px;">' + storeCountsTableHtml(dist) + '</td></tr>';

  // SECTION 2 -- only the people who tripped the 5-minute rule
  h += sectionHeadHtml('2 \u00b7 Filing 2+ within 5 minutes');
  h += '<tr><td colspan="2" style="padding:0 18px;">' + flaggedStoresHtml(dist, ctx) + '</td></tr>';

  // legend — written for a DM who has never seen this before
  h += '<tr><td colspan="2" bgcolor="' + C.storeBar + '" style="background-color:' + C.storeBar +
    ';border-top:1px solid ' + C.rule + ';border-radius:0 0 12px 12px;padding:12px 18px;' + FF +
    'font-size:13px;line-height:1.55;color:' + C.dim + ';">' +
    (ctx.flagsAvailable
      ? '<span style="color:' + C.flag + ';font-weight:700;">&#9873; Red</span> = the same person at the same store ' +
        'filed 2 or more T-sheets within 5 minutes of each other. Times are listed so you can check it. ' +
        'Section 2 lists only those people; everyone else who submitted is counted in section 1.'
      : 'Section 1 counts every store. The rapid-fire check did not run on this update, so section 2 is empty.') +
    '</td></tr>';

  return h + '</table>';
}

/* DIRECTORY ISSUES — Jeff's full email only.
   Deliberately OUTSIDE every district card and at the very end, so the district
   blocks he screenshots into group chats stay clean. Omitted entirely when there
   is nothing to report: an empty "no issues" block three times a day is noise.
   Note what is NOT here: roster employees with zero submissions. Zero people
   never appear anywhere in this email. */
/* Says WHY a name is off-roster, so the list separates "someone covered a shift"
   from "this employee record is missing". Both are worth seeing; only one needs
   a fix in the Admin Panel. */
function unrosteredQualifier(u) {
  if (u.role && u.leads && u.leads.length) {
    return ' (' + u.role + ' at ' +
      u.leads.map(function (n) { return n.replace(/ Xfinity Store$/, ''); }).join(', ') + ')';
  }
  if (u.role) return ' (' + u.role + ')';
  if (u.alsoAt && u.alsoAt.length) {
    return ' (rostered at ' + u.alsoAt.map(function (n) { return n.replace(/ Xfinity Store$/, ''); }).join(', ') + ')';
  }
  return ' (not on any store roster)';
}

function directoryIssuesHtml(issues) {
  if (!issues || !issues.count) return '';
  // The font is declared once on the wrapping cell; every div below inherits it.
  function block(label, lines) {
    if (!lines.length) return '';
    var h = '<div style="font-size:14px;font-weight:700;color:' + C.brass +
      ';padding:10px 0 4px;">' + esc(label) + '</div>';
    for (var i = 0; i < lines.length; i++) {
      h += '<div style="font-size:15px;line-height:1.5;color:' + C.ink + ';padding:1px 0;">' + lines[i] + '</div>';
    }
    return h;
  }
  var h = TBL + 'bgcolor="' + C.card + '" style="width:100%;background-color:' + C.card +
    ';border:1px solid ' + C.cardEdge + ';border-radius:12px;border-collapse:separate;margin:6px 0 0 0;">' +
    '<tr><td style="padding:16px 18px 18px;' + FF + '">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:0.16em;color:' + C.brass +
      ';text-transform:uppercase;">Directory issues</div>' +
    '<div style="font-size:14px;line-height:1.5;color:' + C.dim + ';padding-top:5px;">' +
      'Worth a look in the Admin Panel Directory. Nothing here affects the counts above.</div>';

  h += block('Submitted at a store they are not rostered at',
    issues.unrosteredReps.map(function (u) {
      return esc(u.name) + ' <span style="color:' + C.dim + ';">&#8212; ' +
             esc(u.store.replace(/ Xfinity Store$/, '')) + esc(unrosteredQualifier(u)) + '</span>';
    }));
  h += block('Stores with no employees on the roster',
    issues.unrosteredStores.map(function (n) { return esc(n.replace(/ Xfinity Store$/, '')); }));
  h += block('Stores submitting that are in no district',
    issues.unknownStores.map(function (u) {
      return esc(u.name.replace(/ Xfinity Store$/, '')) +
        ' <span style="color:' + C.dim + ';">&#8212; ' + u.today + ' today</span>';
    }));
  h += block('District ids used by a store but not defined',
    issues.unknownDistrictIds.map(function (u) {
      return esc(u.id) + ' <span style="color:' + C.dim + ';">&#8212; ' +
        esc(u.stores.map(function (n) { return n.replace(/ Xfinity Store$/, ''); }).join(', ')) + '</span>';
    }));

  return h + '</td></tr></table>';
}

function directoryIssuesText(issues) {
  if (!issues || !issues.count) return '';
  var L = ['', 'DIRECTORY ISSUES', 'Worth a look in the Admin Panel Directory. Nothing here affects the counts above.'];
  function block(label, lines) {
    if (!lines.length) return;
    L.push(''); L.push(label);
    for (var i = 0; i < lines.length; i++) L.push('  ' + lines[i]);
  }
  block('Submitted at a store they are not rostered at', issues.unrosteredReps.map(function (u) {
    return u.name + ' -- ' + u.store.replace(/ Xfinity Store$/, '') + unrosteredQualifier(u); }));
  block('Stores with no employees on the roster', issues.unrosteredStores.map(function (n) {
    return n.replace(/ Xfinity Store$/, ''); }));
  block('Stores submitting that are in no district', issues.unknownStores.map(function (u) {
    return u.name.replace(/ Xfinity Store$/, '') + ' -- ' + u.today + ' today'; }));
  block('District ids used by a store but not defined', issues.unknownDistrictIds.map(function (u) {
    return u.id + ' -- ' + u.stores.map(function (n) { return n.replace(/ Xfinity Store$/, ''); }).join(', '); }));
  return L.join('\n');
}

function emailHtml(title, introLines, cards, ctx) {
  var h = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">' +
    '<title>' + esc(title) + '</title></head>' +
    '<body style="margin:0;padding:0;width:100%;background-color:' + C.page + ';color:' + C.ink + ';">' +
    TBL + 'bgcolor="' + C.page + '" style="width:100%;background-color:' + C.page +
      ';margin:0;padding:0;border-collapse:collapse;">' +
    '<tr><td align="center" style="padding:18px 10px 28px;">' +
    TBL + 'style="width:100%;max-width:600px;border-collapse:collapse;">';

  h += '<tr><td style="padding:0 2px 16px;' + FF + '">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:0.2em;color:' + C.brassDim +
      ';text-transform:uppercase;">Blufox Mobile &#183; Cook County Cooks</div>' +
    '<div style="font-family:' + SERIF + ';font-size:24px;line-height:1.25;font-weight:700;color:' + C.ink +
      ';padding-top:6px;">' + esc(title) + '</div>';
  for (var i = 0; i < introLines.length; i++) {
    h += '<div style="font-size:15px;line-height:1.5;color:' + C.dim + ';padding-top:4px;">' + introLines[i] + '</div>';
  }
  h += '</td></tr>';

  h += '<tr><td>' + cards.join('') + '</td></tr>';

  h += '<tr><td style="padding:4px 2px 0;' + FF + 'font-size:12px;line-height:1.6;color:' + C.faint + ';">' +
    'Today = ' + esc(ctx.longDate) + ', America/Chicago. Generated ' + esc(ctx.generatedLabel) + '. ' +
    'Automated &#8212; do not reply.</td></tr>';

  return h + '</table></td></tr></table></body></html>';
}

/* ============================================================
   PLAIN TEXT
   ============================================================ */

function districtText(dist, ctx) {
  var L = [];
  L.push('T-SHEETS  ' + ctx.shortDate + '  ' + ctx.slot);
  L.push(dist.name.toUpperCase() + '  --  ' + dist.dm);
  L.push(dist.today + ' today  |  ' + (!ctx.flagsAvailable ? 'flags not checked'
        : dist.flaggedReps === 0 ? '0 flagged' : '(!) ' + dist.flaggedReps + ' flagged'));
  if (!ctx.flagsAvailable) {
    L.push('');
    L.push('! Counts only. ' + ctx.flagsReason);
    L.push('  Nobody here has been cleared -- they have not been checked.');
  }
  L.push('');
  L.push('1 - T-SHEETS PER STORE');
  var i, j, k, s2, sn;
  if (!dist.stores.length && !dist.zeroStores.length) {
    L.push('  No stores in this district.');
  }
  for (i = 0; i < dist.stores.length; i++) {
    s2 = dist.stores[i];
    sn = s2.name.replace(/ Xfinity Store$/, '');
    L.push('  ' + (s2.flagged ? '(!) ' : '    ') + sn + ' -- ' + s2.today);
  }
  for (i = 0; i < dist.zeroStores.length; i++) {
    L.push('      ' + dist.zeroStores[i].replace(/ Xfinity Store$/, '') + ' -- 0');
  }

  L.push('');
  L.push('2 - FILING 2+ WITHIN 5 MINUTES');
  if (!ctx.flagsAvailable) {
    L.push('  The 5-minute check did not run on this update, so nobody here has been');
    L.push('  cleared -- they have not been checked.');
  } else {
    var any = false;
    for (i = 0; i < dist.stores.length; i++) {
      s2 = dist.stores[i];
      var flaggedReps = [];
      for (j = 0; j < s2.employees.length; j++) {
        if (s2.employees[j].flagged) flaggedReps.push(s2.employees[j]);
      }
      if (!flaggedReps.length) continue;
      any = true;
      L.push('  (!) ' + s2.name.replace(/ Xfinity Store$/, '') + ' -- ' + s2.today);
      for (j = 0; j < flaggedReps.length; j++) {
        var r = flaggedReps[j];
        L.push('        ' + repDisplayName(r.name) + (r.role ? ' [' + r.role + ']' : '') + '  ' + r.today);
        for (k = 0; k < r.clusters.length; k++) {
          L.push('          ' + r.clusters[k].count + ' in ' + r.clusters[k].times.join(' -> '));
        }
      }
    }
    if (!any) L.push('  Nobody in this district filed 2 or more T-sheets within 5 minutes today.');
  }

  L.push('');
  L.push(ctx.flagsAvailable
    ? '(!) = same person, same store, 2+ T-sheets within 5 minutes of each other.'
    : 'Rapid-fire check did not run on this update.');
  L.push('Section 2 lists only those people; everyone else who submitted is counted in section 1.');
  return L.join('\n');
}

function emailText(title, introLines, dists, ctx) {
  var L = [title, ''];
  for (var i = 0; i < introLines.length; i++) L.push(introLines[i]);
  L.push('');
  L.push('==========================================================');
  for (var j = 0; j < dists.length; j++) {
    L.push('');
    L.push(districtText(dists[j], ctx));
    L.push('');
    L.push('==========================================================');
  }
  L.push('');
  L.push('Today = ' + ctx.longDate + ', America/Chicago. Generated ' + ctx.generatedLabel + '.');
  L.push('Automated -- do not reply.');
  return L.join('\n');
}

/* ============================================================
   SUBJECT LINES
   Front-loaded so the essentials survive an iPhone notification truncation.
   ============================================================ */
function subjectFor(scopeLabel, today, flaggedReps, ctx) {
  var tail;
  if (!ctx.flagsAvailable) tail = today + ' today, flags unavailable';
  else if (flaggedReps === 0) tail = today + ' today, 0 flagged';
  else tail = today + ' today, ' + flaggedReps + ' flagged';
  return 'T-Sheets ' + ctx.slot + ' ' + ctx.shortDate + ' — ' + scopeLabel + ': ' + tail;
}

/* ============================================================
   PUBLIC API
   ============================================================ */

/**
 * buildDigest({ day, submissions, districts, now })
 *
 *   day          'YYYY-MM-DD' in America/Chicago. Defaults to `now`'s Chicago date.
 *   submissions  [{ timestamp, store, rep_name }, ...]. `timestamp` may be null
 *                when the source is the pre-aggregated counts file; rows with a
 *                timestamp are filtered to `day`, rows without one are trusted to
 *                already be today's (the counts file only reports today).
 *   districts    optional override of the roster; defaults to the dashboard's.
 *   now          Date (or anything new Date() accepts). Defaults to real now.
 *
 * Optional extras (all safe to omit):
 *   slotLabel       '3:00 PM' etc. Given by the scheduler so a late run still
 *                   names the slot it was scheduled for, not the clock time.
 *   flags           precomputed clusters (see flagsFromFile) instead of timestamps.
 *   flagsReason     the sentence shown when the check could not run.
 *   flagsAvailable  force the flag check on/off. Default: auto — true only if at
 *                   least one usable timestamp was supplied.
 *   jeff            { name, email } override for the all-districts recipient.
 *
 * -> { generatedAt, day, slot, flagsAvailable, sendWindow, districts, unassigned, emails }
 */
function buildDigest(opts) {
  opts = opts || {};
  var now = opts.now ? (opts.now instanceof Date ? opts.now : new Date(opts.now)) : new Date();
  var day = opts.day || ymdInTZ(now);
  var jeff = opts.jeff || JEFF;

  // The roster is LIVE: districts, their names, their store membership and the DM
  // name+email all come from store-directory.json. DEFAULT_DISTRICTS is a
  // fallback, and using it is stated in the email rather than hidden.
  var parsed = null, directoryAvailable = false;
  if (opts.directory && directoryIsUsable(opts.directory)) {
    parsed = parseDirectory(opts.directory);
    directoryAvailable = true;
  }
  if (opts.directoryAvailable === false) directoryAvailable = false;

  var districts = opts.districts || (parsed ? parsed.districts : DEFAULT_DISTRICTS);

  var model = buildModel({
    day: day,
    submissions: opts.submissions || [],
    districts: districts,
    roster: parsed ? parsed.roster : null,
    rosterIndex: parsed ? parsed.rosterIndex : null,
    leaderNames: parsed ? parsed.leaderNames : null,
    leaderPeople: parsed ? parsed.leaderPeople : null,
    storeLeaders: parsed ? parsed.storeLeaders : null,
    rosterHasEmployees: parsed ? parsed.rosterHasEmployees : null,
    flagsAvailable: opts.flagsAvailable,
    flags: opts.flags || null
  });

  /* HOW OLD ARE THE NUMBERS. The counts file states when it was built; anything
     we cannot parse is treated as STALE, because "we do not know" and "it is
     fine" are not the same answer. */
  var gen = opts.countsGeneratedAt ? new Date(opts.countsGeneratedAt) : null;
  var genOk = !!(gen && !isNaN(gen.getTime()));
  var ageMs = genOk ? (now.getTime() - gen.getTime()) : null;

  var ctx = {
    day: day,
    // The scheduled runner PASSES the slot label rather than letting us read the
    // clock: a task that fires three minutes late must still say "3:00 PM".
    slot: opts.slotLabel || slotLabel(now),
    shortDate: shortDate(day),
    longDate: longDate(day),
    generatedLabel: fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(now) + ' CT',
    countsClock: genOk ? (shortClockInTZ(gen) + ' CT') : 'an unknown time',
    countsAge: genOk ? ageText(ageMs) : 'age unknown',
    countsStale: !genOk || ageMs > STALE_COUNTS_MS,
    /* --emit-digest only. Both default to undefined, so a normal run renders the
       real element with the real elapsed phrase and never sees a placeholder. */
    ageBlockOverride: opts.ageBlockOverride || null,
    ageTextOverride: opts.ageTextOverride || null,
    flagsAvailable: model.flagsAvailable,
    // WHY the check did not run, in the DM's words. fetch-data.js passes the real
    // reason -- a missing flags file reads differently from a stale one, and a
    // stale one must be visibly stale rather than quietly unflagged.
    flagsReason: opts.flagsReason ||
      'This run came from the summary feed, which has no submission times, so the ' +
      '5-minute rapid-fire check could not run.',
    directoryAvailable: directoryAvailable,
    directoryReason: opts.directoryReason ||
      'The live store directory could not be read, so this used the built-in backup roster.'
  };

  var totalToday = 0, totalFlaggedReps = 0, totalFlaggedStores = 0, i;
  for (i = 0; i < model.districts.length; i++) {
    totalToday += model.districts[i].today;
    totalFlaggedReps += model.districts[i].flaggedReps;
    totalFlaggedStores += model.districts[i].flaggedStores;
  }

  // Directory issues — Jeff's email only, at the very end, never inside a card.
  var unknownDistrictIds = [];
  if (parsed) {
    var ids = Object.keys(parsed.unknownDistrictIds);
    for (i = 0; i < ids.length; i++) unknownDistrictIds.push({ id: ids[i], stores: parsed.unknownDistrictIds[ids[i]] });
  }
  var issues = {
    unrosteredReps: model.unrostered,
    unrosteredStores: model.unrosteredStores,
    unknownStores: model.unassigned,
    unknownDistrictIds: unknownDistrictIds
  };
  issues.count = issues.unrosteredReps.length + issues.unrosteredStores.length +
                 issues.unknownStores.length + issues.unknownDistrictIds.length;

  var emails = [];

  // --- Jeff: every district in one email -------------------------------------
  var allCards = model.districts.map(function (d) { return districtCardHtml(d, ctx); });
  allCards.push(directoryIssuesHtml(issues));
  var jeffIntro = [
    '<strong style="color:' + C.ink + ';">' + totalToday + '</strong> T-' + plural(totalToday, 'sheet', 'sheets') +
      ' today across ' + model.districts.length + ' districts' +
      (ctx.flagsAvailable
        ? ' &#183; <span style="color:' + (totalFlaggedReps ? C.flag : C.dim) + ';font-weight:700;">' +
          (totalFlaggedReps ? '&#9873; ' : '') + totalFlaggedReps + ' ' + plural(totalFlaggedReps, 'person', 'people') +
          ' flagged in ' + totalFlaggedStores + ' ' + plural(totalFlaggedStores, 'store', 'stores') + '</span>'
        : ' &#183; <span style="color:' + C.brass + ';font-weight:700;">flags not checked this run</span>'),
    esc(ctx.longDate) + ' &#183; ' + esc(ctx.slot) + ' update'
  ];

  var jeffTextIntro = [
    totalToday + ' T-sheets today across ' + model.districts.length + ' districts' +
      (ctx.flagsAvailable ? ' | ' + totalFlaggedReps + ' flagged in ' + totalFlaggedStores + ' stores'
                          : ' | flags not checked this run'),
    ctx.longDate + ' | ' + ctx.slot + ' update'
  ];


  emails.push({
    to: jeff.email,
    toName: jeff.name,
    scope: 'all',
    scopeName: 'All districts',
    subject: subjectFor('All districts', totalToday, totalFlaggedReps, ctx),
    districts: model.districts,
    html: emailHtml('All Districts', jeffIntro, allCards, ctx),
    text: emailText('T-SHEETS -- ALL DISTRICTS', jeffTextIntro, model.districts, ctx) +
          '\n' + directoryIssuesText(issues)
  });

  // --- Each DM: their own district only ---------------------------------------
  for (i = 0; i < model.districts.length; i++) {
    var d = model.districts[i];
    /* FAIL LOUDLY. `continue` here would silently ship five emails instead of
       six and one district's group chat would just stop getting its numbers --
       with nothing anywhere saying why. The address comes from the Admin Panel
       Directory, so a missing one is a fixable data problem, not a runtime one. */
    if (!d.dmEmail) {
      throw new Error('T-Sheet digest: district "' + d.name + '" (' + d.key + ') has no DM email address in ' +
        'store-directory.json. Fix it in the Admin Panel Directory. No digest built.');
    }
    var intro = [esc(ctx.longDate) + ' &#183; ' + esc(ctx.slot) + ' update &#183; for ' + esc(d.dm)];
    emails.push({
      to: d.dmEmail,
      toName: d.dm,
      scope: d.key,
      scopeName: d.name,
      districts: [d],
      subject: subjectFor(d.name, d.today, d.flaggedReps, ctx),
      html: emailHtml(d.name, intro, [districtCardHtml(d, ctx)], ctx),
      text: emailText('T-SHEETS -- ' + d.name.toUpperCase(),
        [ctx.longDate + ' | ' + ctx.slot + ' update | for ' + d.dm], [d], ctx)
    });
  }

  var wd = weekdayIndex(day);
  return {
    generatedAt: now.toISOString(),
    day: day,
    slot: ctx.slot,
    timezone: TZ,
    flagsAvailable: model.flagsAvailable,
    // The digest runs Mon-Sat, never Sunday. buildDigest still composes on a
    // Sunday (so it can be previewed) but says plainly that it must not send.
    sendWindow: { weekday: wd, isSunday: wd === 0, shouldSend: wd !== 0 },
    totals: { today: totalToday, flaggedReps: totalFlaggedReps, flaggedStores: totalFlaggedStores },
    directoryAvailable: directoryAvailable,
    districts: model.districts,
    unassigned: model.unassigned,
    directoryIssues: issues,
    emails: emails
  };
}

/**
 * flagsFromFile(json) — turn the published tsheet-flags.json into the internal
 * flag map buildDigest({ flags }) expects. Pure, so it also runs in Apps Script.
 *
 * Expected shape (see README for the contract we asked the builder for):
 *   { generated_at, day, timezone, window_ms, rule, run_id?,
 *     stores: { "<Store> Xfinity Store": {
 *       reps: { "<Rep Name>": { flagged: <n>, clusters: [ ["<iso>", ...], ... ] } } } } }
 *
 * Store and rep keys are re-normalized here anyway. Trusting the file to have
 * done it is how the two feeds silently stop joining.
 */
/* ============================================================
   THE PRE-RENDERED DIGEST  —  data/tsheet-digest.json

   WHY THIS EXISTS. The 12:00 / 3:00 / 6:00 send runs on Zapier, and the only
   place to put code there is a "Code by Zapier" step: an unversioned textarea in
   a web UI that nothing can diff or review. Pasting this 80 KB renderer into it
   is not an option. So the GitHub Action that already reads the feed renders the
   six emails HERE, into a file in the repo, and the Code step becomes a fetch, a
   handful of sanity checks and two string substitutions.

   WHAT CANNOT BE PRE-RENDERED, and therefore what the placeholders are:

     {{SLOT}}       Which of the three sends this is ("3:00 PM"). The Action runs
                    every ten minutes and has no idea which send will pick its
                    output up, so the slot is decided by the Zap at send time.
     {{AGE_BLOCK}}  How old the counts are BY THE TIME THE MAIL GOES OUT. The
                    file is built once and may be read up to a send later, so the
                    elapsed time is the one number that keeps moving after the
                    render. Both variants of the element ship alongside so the
                    Code step chooses one rather than rendering anything.

   That is the whole list. Everything else — every count, every name, every flag,
   every colour, the date, the DM addresses — is fixed the moment the counts file
   is written, and is baked in.

   The clock the age is measured FROM ("3:42 PM CT") is baked in too: the counts
   file states when it was built and that never changes afterwards.

   INVARIANT, asserted by the test suite: for any slot and any `now`,
     html_template
       .split('{{SLOT}}').join(slot)
       .split('{{AGE_BLOCK}}').join(variant.split('{{AGE_TEXT}}').join(ageText(now - countsGeneratedAt)))
   is BYTE-IDENTICAL to buildDigest(...).emails[i].html for the same inputs. It
   holds by construction — one renderer, called with sentinels instead of values —
   and it holds only because esc() is the identity on every substituted string
   (all ASCII, no markup). Keep it that way.
   ============================================================ */

var SLOT_PLACEHOLDER      = '{{SLOT}}';
var AGE_BLOCK_PLACEHOLDER = '{{AGE_BLOCK}}';
var AGE_TEXT_PLACEHOLDER  = '{{AGE_TEXT}}';

/* The subject cannot take {{AGE_BLOCK}} (that is a block of HTML) and must not
   need a third placeholder, so staleness reaches it as a PREFIX the Code step
   prepends to the already-substituted subject. Front, not back: a stale-data
   warning truncated off an iPhone notification is worth nothing, and how many
   T-sheets a district filed does not matter if the number is ninety minutes
   behind. The wording lives here, in the repo, not in a Zapier text box. */
var SUBJECT_STALE_PREFIX_TEMPLATE = '[Data ' + AGE_TEXT_PLACEHOLDER + '] ';

/**
 * buildPrerenderedDigest(opts) -> the object written to data/tsheet-digest.json.
 *
 * Takes everything buildDigest() takes, plus:
 *   countsGeneratedAt  ISO string from the counts file — what the age is measured
 *                      FROM. Missing/unparseable renders as "an unknown time" and
 *                      is treated as stale.
 *   runId              the counts/flags run_id, carried through so a consumer can
 *                      prove all three files came from one feed read.
 */
function buildPrerenderedDigest(opts) {
  opts = opts || {};
  var now = opts.now ? (opts.now instanceof Date ? opts.now : new Date(opts.now)) : new Date();

  // Same options, same renderer — only the two moving values become sentinels.
  var o = {}, k;
  for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
  o.now = now;
  o.slotLabel = SLOT_PLACEHOLDER;
  o.ageBlockOverride = AGE_BLOCK_PLACEHOLDER;

  var result = buildDigest(o);

  /* The two variants come out of ageBlockHtml — the same function the live email
     uses — with the elapsed phrase as its placeholder. Writing this markup a
     second time by hand is exactly how the two would drift apart. */
  var gen = opts.countsGeneratedAt ? new Date(opts.countsGeneratedAt) : null;
  var genOk = !!(gen && !isNaN(gen.getTime()));
  var clock = genOk ? (shortClockInTZ(gen) + ' CT') : 'an unknown time';
  function variant(stale) {
    return ageBlockHtml({ countsStale: stale, countsClock: clock,
                          ageTextOverride: AGE_TEXT_PLACEHOLDER });
  }

  return {
    generated_at: now.toISOString(),
    run_id: opts.runId || null,
    day: result.day,
    timezone: TZ,
    // What the age is measured from. The Code step needs it to compute the
    // elapsed phrase; nothing else in the file moves after the render.
    counts_generated_at: genOk ? gen.toISOString() : null,
    flags_available: result.flagsAvailable,
    flags_note: result.flagsAvailable ? null : opts.flagsReason || null,
    directory_available: result.directoryAvailable,
    directory_note: result.directoryAvailable ? null : opts.directoryReason || null,
    // Sunday still renders — the Zap's filter is what stops the send — but the
    // file says plainly that it must not go out, so a broken filter is visible.
    send_window: result.sendWindow,
    totals: {
      today: result.totals.today,
      flagged_reps: result.totals.flaggedReps,
      flagged_stores: result.totals.flaggedStores
    },
    age_stale_after_minutes: STALE_COUNTS_MS / 60000,
    age_block_fresh_template: variant(false),
    age_block_stale_template: variant(true),
    subject_stale_prefix_template: SUBJECT_STALE_PREFIX_TEMPLATE,
    emails: result.emails.map(function (e) {
      return {
        to: e.to,
        to_name: e.toName,
        district: e.scope,              // 'all' for Jeff, else the district key
        subject_template: e.subject,
        html_template: e.html
      };
    })
  };
}

function flagsFromFile(json) {
  var out = {};
  if (!json || !json.stores) return out;
  var storeNames = Object.keys(json.stores);
  for (var i = 0; i < storeNames.length; i++) {
    var store = normalizeStoreName(storeNames[i]);
    if (!store) continue;
    var reps = (json.stores[storeNames[i]] || {}).reps || {};
    var repNames = Object.keys(reps);
    for (var j = 0; j < repNames.length; j++) {
      var rep = normalizeRepName(repNames[j]);
      if (!isRealRep(rep)) continue;              // a placeholder can never be flagged
      var raw = reps[repNames[j]] || {};
      var rawClusters = raw.clusters || [];
      var clusters = [], flaggedCount = 0, maxSize = 0;
      for (var k = 0; k < rawClusters.length; k++) {
        var times = [], bad = false;
        for (var m = 0; m < rawClusters[k].length; m++) {
          var d = new Date(rawClusters[k][m]);
          if (isNaN(d.getTime())) { bad = true; break; }
          times.push(d.getTime());
        }
        if (bad || times.length < 2) continue;    // a "cluster" of one is not a cluster
        times.sort(function (a, b) { return a - b; });
        clusters.push(times);
        flaggedCount += times.length;
        if (times.length > maxSize) maxSize = times.length;
      }
      if (!clusters.length) continue;             // unflagged reps are simply absent
      var key = store + '||' + rep;
      if (out[key]) {   // same store under two spellings; merge rather than drop
        out[key].clusters = out[key].clusters.concat(clusters);
        out[key].flaggedCount += flaggedCount;
        out[key].clusterCount = out[key].clusters.length;
        if (maxSize > out[key].maxClusterSize) out[key].maxClusterSize = maxSize;
      } else {
        out[key] = { flagged: true, clusters: clusters, flaggedCount: flaggedCount,
                     clusterCount: clusters.length, maxClusterSize: maxSize };
      }
    }
  }
  return out;
}

/* ============================================================
   NETWORK LAYER (inlined from fetch-data.js)
   ============================================================ */
/**
 * fetch-data.js — the ONLY file in this folder that touches the network.
 *
 * digest.js is pure on purpose. Everything that can fail, time out, or return a
 * Google "Page Not Found" page instead of JSON lives here, behind one call:
 *
 *   fetchDay({ source, day }) -> { source, day, submissions, flags, flagsAvailable, flagsReason, meta }
 *
 * ------------------------------------------------------------------------
 * WHY THE SCHEDULED DIGEST DOES NOT READ THE APPS SCRIPT FEED
 *
 * The raw T-sheet feed (APPS_SCRIPT_URL, index.html line 1014) is reachable from
 * Jeff's browser and from GitHub Actions runners. It is NOT reachable from this
 * container or from anything else running outside those: it answers HTTP 404 with
 * a Google Drive "Page Not Found" HTML page after ~61 seconds. Settled; do not
 * spend time re-testing it.
 *
 * Note the trap that cost us once already: QUOTE_SCRIPT_URL (index.html line
 * 1017, the Internet Quote Sheets deployment) IS reachable and returns healthy
 * JSON. It is a DIFFERENT PRODUCT. Reading it and thinking you have T-sheets
 * gives you a few hundred rows with the wrong schema and a believable-looking
 * digest built on nothing. The two URLs are kept apart below and labelled.
 *
 * So the scheduled digest reads two small static files off GitHub Pages, both
 * built by the Daily-Sales-Report GitHub Action that already reads the feed
 * successfully every 10 minutes with a working secret:
 *
 *   tsheet-counts.json   store -> rep -> { today, mtd }         (exists today)
 *   tsheet-flags.json    store -> rep -> clusters of ISO times   (being added)
 *
 * Neither is big, both are free, both are always reachable.
 * ------------------------------------------------------------------------
 */

/* index.html line 1014 — the T-SHEET feed. Real timestamps, ~13,400 rows, keys:
   timestamp, store, rep_name, customer_name, monthly_savings, annual_savings.
   `timestamp` is ISO-8601 UTC with milliseconds and an explicit Z, so new Date()
   yields correct Chicago wall-clock. There is no outcome/internet_plan/quote
   field on a T-sheet row and nothing here reads one.
   UNREACHABLE from anywhere but Jeff's browser and GitHub Actions. */
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyQaa1yvggLJuw5dcme74vwAW3hSB3BvzCK40IhLThy-F8KZDFOF6gcyl8psNMd3yD-Cg/exec';

/* index.html line 1017 — Internet Quote Sheets. A DIFFERENT PRODUCT. Recorded
   here only so nobody mistakes it for the T-sheet feed again. Never fetched. */
var QUOTE_SCRIPT_URL_DO_NOT_USE = 'https://script.google.com/macros/s/AKfycbxEehuxYvy1HD6NeSf-phnZKUitvWveqB_ncKu9lEDl-KNPVxhQCbRyi0A1fzgmva6w/exec';

var COUNTS_URL = 'https://blufoxmobile.github.io/Daily-Sales-Report/data/tsheet-counts.json';
var FLAGS_URL  = 'https://blufoxmobile.github.io/Daily-Sales-Report/data/tsheet-flags.json';

/* The LIVE ROSTER. Jeff edits store/district alignment and the employee roster in
   the Admin Panel Directory (https://blufoxmobile.github.io/Admin-Panel-Directory/,
   which is a UI, not data); that panel publishes THIS file. Fetched once per run.
   Its own staleness does not matter -- it is a roster, not a measurement -- but
   unreachable or malformed must degrade to the built-in fallback VISIBLY. */
var DIRECTORY_URL = 'https://blufoxmobile.github.io/Daily-Sales-Report/data/store-directory.json';

var DEFAULT_TIMEOUT_MS = 120000;

// (bundled) digest.js is inlined above; this shim keeps the call sites identical.
var digest = { ymdInTZ: ymdInTZ, flagsFromFile: flagsFromFile, buildDigest: buildDigest,
               directoryIsUsable: directoryIsUsable, RAPID_WINDOW_MS: RAPID_WINDOW_MS };

function ymdToday() { return digest.ymdInTZ(new Date()); }

async function getJson(url, timeoutMs, label) {
  var ctrl = new AbortController();
  var killer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  var t0 = Date.now();
  try {
    var res = await fetch(url, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(label + ' HTTP ' + res.status);
    var body = await res.text();
    try {
      return { data: JSON.parse(body), ms: Date.now() - t0, bytes: body.length };
    } catch (e) {
      // The Apps Script failure mode: a Google Drive "Page Not Found" HTML page
      // where JSON was expected. Say so plainly instead of dying on a parse error.
      throw new Error(label + ' returned non-JSON (' + body.length + ' bytes): ' +
        body.slice(0, 120).replace(/\s+/g, ' '));
    }
  } finally {
    clearTimeout(killer);
  }
}

/* --- the counts file: store -> rep -> { today, mtd } ----------------------- */
async function getCounts(opts) {
  var url = (opts.countsUrl || COUNTS_URL) + '?t=' + Date.now();
  var got = await getJson(url, opts.timeoutMs || 30000, 'counts file');
  if (!got.data || !got.data.stores) throw new Error('counts file has no .stores');
  return got;
}

/* --- the flags file: store -> rep -> clusters of ISO timestamps ------------ */
async function getDirectory(opts) {
  var url = (opts.directoryUrl || DIRECTORY_URL) + '?t=' + Date.now();
  var got = await getJson(url, opts.timeoutMs || 30000, 'store directory');
  if (!digest.directoryIsUsable(got.data)) {
    throw new Error('store directory is missing one of districts / storeDistricts / storeEmployees / stores');
  }
  return got;
}

async function getFlags(opts) {
  var url = (opts.flagsUrl || FLAGS_URL) + '?t=' + Date.now();
  var got = await getJson(url, opts.timeoutMs || 30000, 'flags file');
  if (!got.data || !got.data.stores) throw new Error('flags file has no .stores');
  return got;
}

/**
 * Expand store -> rep -> today into one timestamp-less row per submission, so
 * digest.js has exactly one code path whatever the source was.
 */
function expandCounts(countsJson) {
  var subs = [], names = Object.keys(countsJson.stores);
  for (var i = 0; i < names.length; i++) {
    var reps = countsJson.stores[names[i]].reps || {};
    var repNames = Object.keys(reps);
    for (var j = 0; j < repNames.length; j++) {
      var n = reps[repNames[j]].today || 0;
      for (var k = 0; k < n; k++) subs.push({ timestamp: null, store: names[i], rep_name: repNames[j] });
    }
  }
  return subs;
}

/* WHICH FLAGS, IF ANY — one copy of the rule, shared by the network path and the
   on-disk path, because the two silently disagreeing about whether a day was
   checked is precisely the failure the notice in the email exists to prevent.

   A STALE flags file is the dangerous case: every count is right, nothing is red,
   and it looks like a clean day. Refuse to use it and say why. */
function chooseFlags(countsData, day, flagsData, flagsErr) {
  if (flagsErr) {
    return { flags: null, flagsAvailable: false,
             flagsReason: 'The rapid-fire results file could not be read (' +
               ((flagsErr && flagsErr.message) || String(flagsErr)) + '), so the 5-minute check did not run.' };
  }
  if (flagsData === false) {
    return { flags: null, flagsAvailable: false,
             flagsReason: 'This run read counts only, so the 5-minute rapid-fire check was not applied.' };
  }
  var f = flagsData;
  var reason = null;
  if (f.day && f.day !== day) {
    reason = 'The rapid-fire results file is stale — it covers ' + f.day +
      ', but these counts are for ' + day + '. The 5-minute check was not applied.';
  } else if (f.run_id && countsData.run_id && f.run_id !== countsData.run_id) {
    reason = 'The counts and the rapid-fire results came from two different feed reads, ' +
      'so they may disagree. The 5-minute check was not applied.';
  } else if (f.window_ms && Number(f.window_ms) !== digest.RAPID_WINDOW_MS) {
    reason = 'The rapid-fire results were built with a ' + f.window_ms +
      'ms window, not the ' + digest.RAPID_WINDOW_MS + 'ms rule this digest states. Not applied.';
  }
  if (reason) return { flags: null, flagsAvailable: false, flagsReason: reason };
  return { flags: digest.flagsFromFile(f), flagsAvailable: true, flagsReason: null };
}

/* --- source: 'local' — the three files ON DISK, not over the network --------

   This is the path the GitHub Action uses. It renders the digest from the counts
   and flags files THE SAME RUN JUST WROTE, in the working tree, BEFORE they are
   committed. Fetching them over HTTP there would be wrong twice over: GitHub
   Pages can sit hours behind main, and raw.githubusercontent cannot serve a file
   that has not been pushed yet — so the Action would render last run's numbers
   and commit them beside this run's counts, under this run's run_id. Reading the
   bytes on disk is the only way the three committed files are guaranteed to
   describe one feed read.
   -------------------------------------------------------------------------- */
function readLocalJson(p, label) {
  var body = require('fs').readFileSync(p, 'utf8');
  try {
    return { data: JSON.parse(body), bytes: body.length, ms: 0 };
  } catch (e) {
    throw new Error(label + ' at ' + p + ' is not JSON (' + body.length + ' bytes)');
  }
}

async function fetchLocal(opts) {
  var countsPath = opts.countsPath || 'data/tsheet-counts.json';
  var flagsPath = opts.flagsPath || 'data/tsheet-flags.json';
  var directoryPath = opts.directoryPath || 'data/store-directory.json';

  // The counts file is the one that may not fail: no counts, no digest.
  var counts = readLocalJson(countsPath, 'counts file');
  if (!counts.data || !counts.data.stores) throw new Error('counts file at ' + countsPath + ' has no .stores');

  var directory = null, directoryReason = null, directoryMeta = null;
  try {
    var dirGot = readLocalJson(directoryPath, 'store directory');
    if (!digest.directoryIsUsable(dirGot.data)) {
      throw new Error('store directory is missing one of districts / storeDistricts / storeEmployees / stores');
    }
    directory = dirGot.data;
    directoryMeta = { path: directoryPath, bytes: dirGot.bytes, updatedAt: dirGot.data.updatedAt,
                      districts: dirGot.data.districts.length,
                      stores: Object.keys(dirGot.data.storeDistricts).length };
  } catch (err) {
    directoryReason = 'The live store directory could not be read (' +
      ((err && err.message) || String(err)) + '), so this used the built-in backup roster.';
  }

  var day = counts.data.day || opts.day || ymdToday();
  var subs = expandCounts(counts.data);

  var flagsData = null, flagsErr = null, flagsMeta = null;
  if (opts.withFlags === false) {
    flagsData = false;
  } else {
    try {
      var fg = readLocalJson(flagsPath, 'flags file');
      if (!fg.data || !fg.data.stores) throw new Error('flags file at ' + flagsPath + ' has no .stores');
      flagsData = fg.data;
      flagsMeta = { path: flagsPath, bytes: fg.bytes, day: fg.data.day, generatedAt: fg.data.generated_at,
                    windowMs: fg.data.window_ms, rule: fg.data.rule, runId: fg.data.run_id };
    } catch (err) { flagsErr = err; }
  }

  var chosen = chooseFlags(counts.data, day, flagsData, flagsErr);

  return {
    source: 'local', day: day, submissions: subs,
    flags: chosen.flags, flagsAvailable: chosen.flagsAvailable, flagsReason: chosen.flagsReason,
    directory: directory, directoryAvailable: !!directory, directoryReason: directoryReason,
    meta: { directory: directoryMeta,
            counts: { path: countsPath, bytes: counts.bytes, generatedAt: counts.data.generated_at,
                      cycleLabel: counts.data.cycle_label, sourceRows: counts.data.source_rows,
                      runId: counts.data.run_id },
            flags: flagsMeta, todayRows: subs.length }
  };
}

/* --- source: 'pages' — counts + flags, the scheduled path ------------------ */
async function fetchPages(opts) {
  var counts = await getCounts(opts);

  // The roster, fetched alongside the counts. Never fatal: a missing roster
  // degrades to the built-in fallback and the email says so.
  var directory = null, directoryReason = null, directoryMeta = null;
  try {
    var dirGot = await getDirectory(opts);
    directory = dirGot.data;
    directoryMeta = { url: opts.directoryUrl || DIRECTORY_URL, bytes: dirGot.bytes, fetchMs: dirGot.ms,
                      updatedAt: dirGot.data.updatedAt, districts: dirGot.data.districts.length,
                      stores: Object.keys(dirGot.data.storeDistricts).length };
  } catch (err) {
    directoryReason = 'The live store directory could not be read (' +
      ((err && err.message) || String(err)) + '), so this used the built-in backup roster.';
  }

  var day = counts.data.day || opts.day || ymdToday();
  var subs = expandCounts(counts.data);

  var flagsData = null, flagsErr = null, flagsMeta = null;
  if (opts.withFlags === false) {
    flagsData = false;
  } else {
    try {
      var f = await getFlags(opts);
      flagsData = f.data;
      flagsMeta = { url: opts.flagsUrl || FLAGS_URL, bytes: f.bytes, fetchMs: f.ms,
                    day: f.data.day, generatedAt: f.data.generated_at,
                    windowMs: f.data.window_ms, rule: f.data.rule, runId: f.data.run_id };
    } catch (err) { flagsErr = err; }
  }

  var chosen = chooseFlags(counts.data, day, flagsData, flagsErr);
  var flags = chosen.flags, flagsAvailable = chosen.flagsAvailable, flagsReason = chosen.flagsReason;

  return {
    source: 'pages', day: day, submissions: subs,
    flags: flags, flagsAvailable: flagsAvailable, flagsReason: flagsReason,
    directory: directory, directoryAvailable: !!directory, directoryReason: directoryReason,
    meta: { directory: directoryMeta, counts: { url: opts.countsUrl || COUNTS_URL, bytes: counts.bytes, fetchMs: counts.ms,
                      generatedAt: counts.data.generated_at, cycleLabel: counts.data.cycle_label,
                      sourceRows: counts.data.source_rows, runId: counts.data.run_id },
            flags: flagsMeta, todayRows: subs.length }
  };
}

/* --- source: 'counts' — counts only, flags never attempted ----------------- */
async function fetchCounts(opts) {
  var o = {}; for (var k in opts) o[k] = opts[k];
  o.withFlags = false;
  var r = await fetchPages(o);
  r.source = 'counts';
  return r;
}

/* --- source: 'apps-script' — for a machine that CAN reach the feed ---------
   Jeff's browser, or a GitHub Actions runner. Real timestamps, so flags are
   computed locally by digest.js. It is SLOW (~11s), BIG (~13,400 rows) and it is
   the SAME endpoint the quote sheets POST submissions to: reads here starved that
   endpoint once and reps got "Submission failed" at the counter.
   ONE call per digest run. Never poll. -------------------------------------- */
async function fetchAppsScript(opts) {
  var url = (opts.appsScriptUrl || APPS_SCRIPT_URL) + '?t=' + Date.now();
  var got = await getJson(url, opts.timeoutMs || DEFAULT_TIMEOUT_MS, 'apps-script T-sheet feed');
  var data = got.data;
  if (!data || data.success === false) throw new Error('apps-script feed error: ' + (data && data.error));
  var rows = Array.isArray(data.submissions) ? data.submissions : [];

  var day = opts.day || ymdToday();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    var d = new Date(r.timestamp);              // ISO-8601 UTC with an explicit Z
    if (isNaN(d.getTime())) continue;
    if (digest.ymdInTZ(d) !== day) continue;
    // The only three fields a T-sheet row has that this digest cares about.
    out.push({ timestamp: r.timestamp, store: r.store, rep_name: r.rep_name });
  }
  return {
    source: 'apps-script', day: day, submissions: out,
    flags: null, flagsAvailable: true, flagsReason: null,
    directory: null, directoryAvailable: false,
    directoryReason: 'This run read the raw feed directly and did not fetch the live store directory.',
    meta: { url: opts.appsScriptUrl || APPS_SCRIPT_URL, fetchMs: got.ms, bytes: got.bytes,
            sourceRows: rows.length, todayRows: out.length }
  };
}

/* --- one interface ---------------------------------------------------------
   'auto' (the default) is counts+flags. It does NOT try Apps Script first: from
   anywhere but Jeff's browser or a GitHub runner that is a guaranteed 61-second
   stall followed by a 404. Ask for 'apps-script' explicitly if you are on a
   machine that can reach it. -------------------------------------------------- */
async function fetchDay(opts) {
  opts = opts || {};
  var source = opts.source || 'auto';
  if (source === 'auto' || source === 'pages') return await fetchPages(opts);
  if (source === 'counts') return await fetchCounts(opts);
  if (source === 'local') return await fetchLocal(opts);
  if (source === 'apps-script') {
    try {
      return await fetchAppsScript(opts);
    } catch (err) {
      // Explicitly asked for the feed and it failed: degrade to counts+flags
      // rather than sending nothing, and carry the reason through.
      var res = await fetchPages(opts);
      res.meta.attempted = 'apps-script';
      res.meta.fallbackReason = (err && err.message) || String(err);
      return res;
    }
  }
  throw new Error('unknown source: ' + source + " (try 'auto', 'pages', 'counts', 'local' or 'apps-script')");
}




/* ============================================================
   SCHEDULED-RUN CLI
   ============================================================

   TWO MODES.

   (1) SEND-READY EMAILS — unchanged, and still what a human runs by hand:

       node tsheet-digest.js --slot=12:00 --out=emails.json [--day=YYYY-MM-DD] [--dry-run]

   (2) PRE-RENDERED DIGEST — what the GitHub Action runs every ten minutes:

       node tsheet-digest.js --emit-digest --source=local \
            --digest-out=data/tsheet-digest.json --skip-if-current

       Renders the same six emails with the send slot and the data-age element
       left as placeholders, and writes data/tsheet-digest.json. --source=local
       reads the counts/flags/directory files from DISK (see fetch-data.js), so
       the Action renders the very bytes it is about to commit rather than
       whatever GitHub Pages happens to be serving. Mode (2) takes no --slot: the
       whole point is that the slot is not known until the mail goes out.

   Mode (1) runs in a COMPLETELY FRESH cloud container that a scheduled task starts at
   12:00, 3:00 and 6:00 PM America/Chicago, Monday through Saturday. Nothing
   survives between runs: no npm install, no repo checkout, no node_modules. That
   is why this is one file with zero dependencies.

   FAILURE ASYMMETRY, on purpose:
     - counts file unreachable, or its `day` is not the day we are sending for
       -> EXIT NON-ZERO, mail nothing. A scheduled run must fail loudly rather
          than mail a stale or empty day at a district group chat.
     - flags file missing or stale
       -> STILL SEND. The counts are the point and the flags are the enrichment.
          The email degrades visibly, saying in plain words that the rapid-fire
          check did not run and that nobody has been cleared.
     - Sunday
       -> mode (1): EXIT 0 immediately, write nothing, say so. Jeff was explicit
          that Sunday never sends; this is belt-and-braces behind the cron.
       -> mode (2): STILL WRITE THE FILE. The Action runs seven days a week and
          must commit three files that agree; the Zap's own filter is what stops
          the Sunday send. The file says so itself in send_window, so a broken
          filter is visible rather than inferred.
   ============================================================ */

var SLOTS = { '12:00': '12:00 PM', '15:00': '3:00 PM', '18:00': '6:00 PM' };

function die(msg) { process.stderr.write('tsheet-digest: ' + msg + '\n'); process.exit(1); }

function parseArgs(argv) {
  var a = {};
  for (var i = 0; i < argv.length; i++) {
    var m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m) continue;
    a[m[1]] = (m[2] === undefined) ? true : m[2];
  }
  return a;
}

/* ---------- mode (2): write data/tsheet-digest.json ------------------------ */
async function emitDigest(a) {
  var out = a['digest-out'];
  if (!out || out === true) die('--digest-out=PATH is required with --emit-digest');

  var source = a.source ? String(a.source) : 'local';
  var fetched;
  try {
    fetched = await fetchDay({
      source: source,
      day: a.day ? String(a.day).trim() : undefined,
      countsPath: a['counts-file'], flagsPath: a['flags-file'], directoryPath: a['directory-file'],
      countsUrl: a['counts-url'], flagsUrl: a['flags-url'], directoryUrl: a['directory-url']
    });
  } catch (err) {
    die('counts unreadable: ' + ((err && err.message) || String(err)));
  }

  /* The day comes from the COUNTS FILE, never from the clock: this file describes
     that read and nothing else. A mismatch with today is worth shouting about --
     it means the feed build has stalled -- but it is not fatal here, because the
     Zap re-checks the day before it sends anything and a half-written trio of
     files is worse than a stale one. */
  var today = ymdInTZ(new Date());
  if (fetched.day !== today) {
    process.stderr.write('tsheet-digest: WARNING - counts cover ' + fetched.day + ', not today (' + today +
      '). Rendering the day the counts describe.\n');
  }
  if (weekdayIndex(fetched.day) === 0) {
    process.stderr.write('tsheet-digest: note - ' + fetched.day + ' is a Sunday. Rendering anyway; ' +
      'send_window.shouldSend is false and the Zap filter is what stops the send.\n');
  }

  var countsMeta = (fetched.meta && fetched.meta.counts) || {};

  /* --skip-if-current: LEAVE THE FILE ALONE when it already describes this exact
     feed read. This is what keeps the three files moving together.

     build-tsheet-counts.js only rewrites counts+flags when something MEANINGFUL
     moved; if nothing did, both keep their previous run_id and the working tree
     stays clean, so the Action commits nothing. Without this check the digest
     would still be rewritten every ten minutes — generated_at alone changes every
     run — and would drag counts and flags into a commit they did not earn, all
     day, every day, for nothing.

     The comparison is on run_id, not on file content: same run_id means the same
     feed read, which means the same numbers, the same flags and the same
     counts_generated_at the age is measured from. A missing file, an unparseable
     one, or one carrying a different run_id all fall through and re-render — that
     is the repair path for a first deploy or a half-finished earlier run. */
  if (a['skip-if-current']) {
    var cur = null;
    try { cur = JSON.parse(require('fs').readFileSync(out, 'utf8')); } catch (e) { cur = null; }
    if (cur && cur.run_id && countsMeta.runId && cur.run_id === countsMeta.runId && cur.day === fetched.day) {
      process.stdout.write('digest already current for run_id ' + cur.run_id + '; leaving ' + out + ' as-is\n');
      return;
    }
  }

  var payload = buildPrerenderedDigest({
    day: fetched.day,
    submissions: fetched.submissions,
    flags: fetched.flags, flagsAvailable: fetched.flagsAvailable, flagsReason: fetched.flagsReason,
    directory: fetched.directory, directoryReason: fetched.directoryReason,
    countsGeneratedAt: countsMeta.generatedAt,
    runId: countsMeta.runId,
    now: new Date()
  });

  /* The run_id is what proves counts, flags and digest describe one feed read.
     Committing a digest that cannot be tied to its counts defeats the point. */
  if (!payload.run_id) die('the counts file carries no run_id - refusing to write a digest that cannot be ' +
    'matched to its counts and flags');

  /* Belt and braces on the thing this file exists to guarantee. Six recipients,
     Jeff first, and not one un-substituted placeholder outside the two the
     contract names. A Zapier Code step cannot check this for us. */
  assertPrerendered(payload);

  require('fs').writeFileSync(out, JSON.stringify(payload, null, 2));
  var bytes = require('fs').statSync(out).size;
  process.stderr.write('tsheet-digest: ' + payload.day + ' run_id=' + payload.run_id + ' - ' +
    payload.totals.today + ' today, ' +
    (payload.flags_available ? payload.totals.flagged_reps + ' flagged in ' +
       payload.totals.flagged_stores + ' stores' : 'FLAGS UNAVAILABLE') + '\n');
  if (payload.flags_note) process.stderr.write('tsheet-digest: ' + payload.flags_note + '\n');
  if (payload.directory_note) process.stderr.write('tsheet-digest: ' + payload.directory_note + '\n');
  process.stdout.write('wrote ' + out + ' (' + payload.emails.length + ' emails, ' + bytes + ' bytes)\n');
}

/* Every invariant the Zapier Code step is entitled to assume, checked HERE where
   a failure is a red X on a commit rather than six wrong emails. */
function assertPrerendered(p) {
  var ALLOWED = { '{{SLOT}}': 1, '{{AGE_BLOCK}}': 1 };
  if (!p.emails || p.emails.length !== 6) {
    die('expected exactly 6 emails, got ' + ((p.emails && p.emails.length) || 0) +
      ' - a district is missing from store-directory.json');
  }
  if (p.emails[0].district !== 'all') die('the first email must be the all-districts one (Jeff), got ' +
    p.emails[0].district);
  var seen = {};
  for (var i = 0; i < p.emails.length; i++) {
    var e = p.emails[i];
    if (!e.to || e.to.indexOf('@') < 1) die('email ' + i + ' has no usable address');
    if (seen[e.to.toLowerCase()]) die('two emails address ' + e.to);
    seen[e.to.toLowerCase()] = 1;
    if (e.html_template.indexOf('{{SLOT}}') === -1) die(e.district + ': html_template has no {{SLOT}}');
    if (e.html_template.indexOf('{{AGE_BLOCK}}') === -1) die(e.district + ': html_template has no {{AGE_BLOCK}}');
    if (e.subject_template.indexOf('{{SLOT}}') === -1) die(e.district + ': subject_template has no {{SLOT}}');
    stray(e.html_template, ALLOWED, e.district + '.html_template');
    stray(e.subject_template, ALLOWED, e.district + '.subject_template');
  }
  stray(p.age_block_fresh_template, { '{{AGE_TEXT}}': 1 }, 'age_block_fresh_template');
  stray(p.age_block_stale_template, { '{{AGE_TEXT}}': 1 }, 'age_block_stale_template');
  stray(p.subject_stale_prefix_template, { '{{AGE_TEXT}}': 1 }, 'subject_stale_prefix_template');
  if (p.age_block_fresh_template.indexOf('{{AGE_TEXT}}') === -1) die('age_block_fresh_template has no {{AGE_TEXT}}');
  if (p.age_block_stale_template.indexOf('{{AGE_TEXT}}') === -1) die('age_block_stale_template has no {{AGE_TEXT}}');
}

/* Any {{...}} in `s` that is not in `allowed` is a placeholder nobody will ever
   substitute, and it would ship to a district group chat as literal braces. */
function stray(s, allowed, where) {
  var re = /\{\{[^}]*\}\}/g, m;
  while ((m = re.exec(String(s)))) {
    if (!allowed[m[0]]) die(where + ': unexpected placeholder ' + m[0]);
  }
}

async function main() {
  var a = parseArgs(process.argv.slice(2));

  if (a['emit-digest']) return await emitDigest(a);

  // The slot label is GIVEN, never derived from the clock: a task that fires
  // three minutes late must still say "3:00 PM" in the subject line.
  if (!a.slot) die('--slot is required (one of ' + Object.keys(SLOTS).join(', ') + ')');
  var slot = SLOTS[String(a.slot).trim()];
  if (!slot) die('unknown --slot "' + a.slot + '" (expected one of ' + Object.keys(SLOTS).join(', ') + ')');

  var day = a.day ? String(a.day).trim() : ymdInTZ(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) die('--day must be YYYY-MM-DD, got "' + day + '"');

  // Sunday: stop before touching the network.
  if (weekdayIndex(day) === 0) {
    process.stdout.write('Sunday (' + day + '): the T-sheet digest never sends. Nothing written.\n');
    process.exit(0);
  }

  var fetched;
  try {
    fetched = await fetchPages({ day: day, countsUrl: a['counts-url'],
                                 flagsUrl: a['flags-url'], directoryUrl: a['directory-url'] });
  } catch (err) {
    die('counts file unreachable: ' + ((err && err.message) || String(err)));
  }

  // Guard against mailing a stale day. The counts file states which day it
  // covers; if the GitHub Action has stalled, that will not be today.
  if (fetched.day !== day) {
    die('counts file covers ' + fetched.day + ', not ' + day + ' - refusing to send a stale day');
  }
  if (!fetched.submissions.length) {
    process.stderr.write('tsheet-digest: warning - the counts file reports zero submissions for ' + day + '\n');
  }

  var result = buildDigest({
    day: day, submissions: fetched.submissions,
    flags: fetched.flags, flagsAvailable: fetched.flagsAvailable,
    flagsReason: fetched.flagsReason,
    directory: fetched.directory, directoryReason: fetched.directoryReason,
    now: new Date(), slotLabel: slot
  });

  var payload = {
    generatedAt: result.generatedAt,
    day: result.day,
    slot: slot,
    flagsAvailable: result.flagsAvailable,
    flagsNote: result.flagsAvailable ? null : fetched.flagsReason,
    directoryAvailable: result.directoryAvailable,
    directoryNote: result.directoryAvailable ? null : fetched.directoryReason,
    directoryIssues: result.directoryIssues.count ? result.directoryIssues : null,
    totals: result.totals,
    emails: result.emails.map(function (e) {
      return {
        to: e.to, toName: e.toName,
        district: e.scope,            // 'all' for Jeff, else the DISTRICTS key
        districtName: e.scopeName,    // 'All districts' / 'Chicago North' / ...
        subject: e.subject, html: e.html, text: e.text,
        // Employee addresses ride along here for later use; they are deliberately
        // NOT in the visible HTML -- the district blocks get screenshotted into
        // group chats and a wall of addresses would both ruin them and leak more
        // than it should.
        districts: e.districts
      };
    })
  };

  process.stderr.write('tsheet-digest: ' + day + ' ' + slot + ' - ' +
    payload.totals.today + ' today, ' +
    (payload.flagsAvailable ? payload.totals.flaggedReps + ' flagged in ' + payload.totals.flaggedStores + ' stores'
                            : 'FLAGS UNAVAILABLE') +
    ', ' + payload.emails.length + ' emails\n');
  if (payload.flagsNote) process.stderr.write('tsheet-digest: ' + payload.flagsNote + '\n');
  if (payload.directoryNote) process.stderr.write('tsheet-digest: ' + payload.directoryNote + '\n');
  if (payload.directoryIssues) process.stderr.write('tsheet-digest: ' + payload.directoryIssues.count +
    ' directory issue(s) reported in the full email\n');

  if (a['dry-run']) {
    process.stdout.write(payload.emails.map(function (e) {
      return e.to + '  |  ' + e.subject;
    }).join('\n') + '\n');
    process.stdout.write('--dry-run: nothing written.\n');
    process.exit(0);
  }

  if (!a.out) die('--out is required (or pass --dry-run)');
  require('fs').writeFileSync(a.out, JSON.stringify(payload, null, 2));
  process.stdout.write('wrote ' + a.out + ' (' + payload.emails.length + ' emails)\n');
}

main().catch(function (e) { die((e && e.stack) || String(e)); });
