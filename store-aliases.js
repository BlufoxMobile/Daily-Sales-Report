/* ============================================================================
   Blufox / Cook County Cooks — CENTRAL STORE NORMALIZER            v2
   ----------------------------------------------------------------------------
   Single source of truth for recognizing a store by its name OR a nickname.
   Hosted at:  https://blufoxmobile.github.io/Daily-Sales-Report/store-aliases.js
   Every dashboard repo loads this file, so store-name logic lives in ONE place.

   ── THE ONE RULE ──────────────────────────────────────────────────────────
   Every store has exactly ONE canonical short name, and its long form is
   ALWAYS  <canonical short name> + " Xfinity Store".  No exceptions, ever.

       "South Skokie"  <->  "South Skokie Xfinity Store"

   v1 carried an XFINITY_NAME_OVERRIDES table so that South Skokie's long form
   came out as "Skokie Xfinity Store". That single output exception is what kept
   regenerating the South Skokie bug for months: this library — the thing every
   dashboard is told to trust — handed back a spelling that 1 in 19,806 live
   submissions actually used, so counts silently landed in orphan buckets. The
   table is gone and must not come back.

   INPUT aliases (below) are safe and necessary — they let any historical or
   sloppy spelling resolve. An OUTPUT exception is what bites. Add aliases
   freely; never add an override.

   HOW IT RESOLVES A NAME (first rule that matches wins):
     1. Exact canonical match            ("South Skokie"        -> "South Skokie")
     2. Explicit nickname in ALIASES     ("the skok"            -> "South Skokie")
     3. Bare city -> directional store   ("Skokie"              -> "South Skokie")
     4. Abbreviated / extra direction    ("S. Skokie","N Knox"  -> canonical)
     5. Unknown -> returned cleaned, unchanged (so display stays readable),
        and recorded in unresolved() so drift is visible instead of silent.

   TO ADD A NEW STORE:  add its canonical short name to CANONICAL_STORES.
   Directional pairs ("Skokie"/"South Skokie") then auto-resolve. Only add an
   ALIASES entry for nicknames the auto-rules can't infer.
   ========================================================================== */
(function (root) {
  'use strict';

  var VERSION = 2;

  /* Canonical SHORT names — the identity each dashboard groups & displays on. */
  var CANONICAL_STORES = [
    'Bourbonnais', 'Burbank', 'Calumet City', 'Cicero', 'Dekalb', 'Elkhart',
    'Evanston', 'Evergreen Park', 'Frankfort', 'Glenview', 'Greeneville',
    'Hammond', 'Johnson City', 'Kildeer', 'Machesney Park', 'Michigan City',
    'North Knoxville', 'Oak Lawn', 'Oak Ridge', 'Round Lake Beach',
    'Schererville', 'South Bend', 'South Knoxville', 'South Skokie',
    'Tinley Park', 'Uptown', 'Valparaiso'
  ];

  /* Explicit nickname -> canonical short name. Matched case/space-insensitively
     AFTER any trailing " Xfinity Store" is stripped.

     These exist to keep HISTORICAL data resolving forever. "Skokie" is the
     pre-2026 spelling still present in old T-Sheet rows, old quote-sheet
     submissions and the credit-escalation CSV; "Knoxville" predates the North
     Knoxville opening. Both must keep working — that is the point of an input
     alias. Add hard-to-infer nicknames here. */
  var ALIASES = {
    'skokie': 'South Skokie',
    'knoxville': 'South Knoxville'
  };

  var DIRECTIONS = ['north', 'south', 'east', 'west', 'n', 's', 'e', 'w'];

  /* Labels that did not resolve to one of our stores, in first-seen order.
     Dashboards can surface these so a new spelling shows up loudly instead of
     silently zeroing a store for weeks. */
  var unresolvedSeen = {};
  var unresolvedList = [];

  /* ---- helpers ---------------------------------------------------------- */
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/ /g, ' ')      // non-breaking spaces from Excel
      .replace(/\s+/g, ' ')
      .trim();
  }
  function key(s) { return clean(s).toLowerCase(); }
  function stripSuffix(s) {         // drop a trailing " Xfinity Store"
    return clean(s).replace(/\s+xfinity\s+store\s*$/i, '');
  }
  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  /* Expand "s."/"s"/"south" to the full direction word so abbreviated
     directionals ("S. Knoxville", "N Skokie") resolve like spelled-out ones. */
  var DIR_EXPAND = {
    'n': 'north', 'n.': 'north', 'north': 'north',
    's': 'south', 's.': 'south', 'south': 'south',
    'e': 'east',  'e.': 'east',  'east': 'east',
    'w': 'west',  'w.': 'west',  'west': 'west'
  };

  /* ---- lookup tables (built once) --------------------------------------- */
  var byKey = {};        // "south skokie" -> "South Skokie"
  var byBareCity = {};   // "skokie" -> ["South Skokie"]   (directional stores)
  CANONICAL_STORES.forEach(function (c) {
    byKey[key(c)] = c;
    var parts = key(c).split(' ');
    if (DIRECTIONS.indexOf(parts[0]) !== -1 && parts.length > 1) {
      var bare = parts.slice(1).join(' ');
      if (!has(byBareCity, bare)) byBareCity[bare] = [];
      byBareCity[bare].push(c);
    }
  });
  var aliasByKey = {};
  Object.keys(ALIASES).forEach(function (k) { aliasByKey[key(k)] = ALIASES[k]; });

  /* ---- public API ------------------------------------------------------- */

  /* normalizeStore(raw) -> canonical short name, or cleaned input if unknown. */
  function normalizeStore(raw) {
    var cleaned = stripSuffix(raw);
    if (!cleaned) return clean(raw);
    var k = key(cleaned);

    if (has(byKey, k)) return byKey[k];                            // 1
    if (has(aliasByKey, k)) return aliasByKey[k];                  // 2
    if (has(byBareCity, k) && byBareCity[k].length === 1)          // 3
      return byBareCity[k][0];

    var parts = k.split(' ');                                      // 4
    if (parts.length > 1 && has(DIR_EXPAND, parts[0])) {
      var rest = parts.slice(1).join(' ');
      // "S. Skokie" -> "south skokie"
      var expanded = DIR_EXPAND[parts[0]] + ' ' + rest;
      if (has(byKey, expanded)) return byKey[expanded];
      if (has(aliasByKey, expanded)) return aliasByKey[expanded];
      // "South Burbank" -> "Burbank" (canonical has no direction)
      if (has(byKey, rest)) return byKey[rest];
      if (has(aliasByKey, rest)) return aliasByKey[rest];
    }

    if (!has(unresolvedSeen, k)) {                                 // 5
      unresolvedSeen[k] = true;
      unresolvedList.push(cleaned);
    }
    return cleaned;
  }

  /* True only when raw resolves to one of our stores. */
  function isMyStore(raw) {
    return has(byKey, key(normalizeStore(raw)));
  }

  /* Canonical "X Xfinity Store" form. Mechanical — no per-store exceptions. */
  function xfinityStoreName(raw) {
    return normalizeStore(raw) + ' Xfinity Store';
  }

  /* Labels seen that aren't one of our stores (first-seen order). */
  function unresolved() { return unresolvedList.slice(); }

  /* Round-trip every canonical store. Returns [] when healthy. Runs on load so
     a broken edit to this file is caught immediately rather than in a report. */
  function selfTest() {
    var failures = [];
    CANONICAL_STORES.forEach(function (c) {
      var long = xfinityStoreName(c);
      if (long !== c + ' Xfinity Store') failures.push(c + ': long form is "' + long + '"');
      if (normalizeStore(long) !== c) failures.push(c + ': long form does not round-trip');
      if (normalizeStore(c) !== c) failures.push(c + ': short form does not round-trip');
      if (!isMyStore(c) || !isMyStore(long)) failures.push(c + ': isMyStore false');
    });
    Object.keys(ALIASES).forEach(function (a) {
      if (normalizeStore(a) !== ALIASES[a]) failures.push('alias "' + a + '" -> ' + normalizeStore(a));
    });
    return failures;
  }

  var api = {
    VERSION: VERSION,
    CANONICAL_STORES: CANONICAL_STORES,
    ALIASES: ALIASES,
    normalizeStore: normalizeStore,
    isMyStore: isMyStore,
    xfinityStoreName: xfinityStoreName,
    unresolved: unresolved,
    selfTest: selfTest,
    clean: clean
  };

  root.BLUFOX_STORES = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // selfTest() must not throw in any host; a failure is a loud console error,
  // never a broken page. unresolved labels are intentionally NOT logged here —
  // dashboards decide when to surface them.
  try {
    var f = selfTest();
    if (f.length && typeof console !== 'undefined' && console.error) {
      console.error('[BLUFOX_STORES] self-test FAILED:', f);
    }
  } catch (e) { /* never block page load */ }

})(typeof window !== 'undefined' ? window : this);
