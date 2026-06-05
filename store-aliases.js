/* ============================================================================
   Blufox / Cook County Cooks — CENTRAL STORE NORMALIZER
   ----------------------------------------------------------------------------
   Single source of truth for recognizing a store by its name OR a nickname.
   Hosted at:  https://blufoxmobile.github.io/Daily-Sales-Report/store-aliases.js
   Every dashboard repo loads this file, so store-name logic lives in ONE place.

   HOW IT RESOLVES A NAME (first rule that matches wins):
     1. Exact canonical match            ("South Skokie"        -> "South Skokie")
     2. Explicit nickname in ALIASES     ("the skok"            -> "South Skokie")
     3. Bare city -> directional store   ("Skokie"              -> "South Skokie")
     4. Extra direction the canonical
        doesn't have                     ("South Burbank"       -> "Burbank")
     5. Unknown -> returned cleaned, unchanged (so display stays readable)

   TO ADD A NEW STORE NATIONALLY:  add its canonical short name to
   CANONICAL_STORES below. Directional pairs ("Skokie"/"South Skokie") then
   auto-resolve. Only add an ALIASES entry for nicknames the auto-rules can't
   infer (abbreviations, mall names, legacy spellings, etc.).
   ========================================================================== */
(function (root) {
  'use strict';

  /* Canonical SHORT names — the identity each dashboard groups & displays on. */
  var CANONICAL_STORES = [
    'Bourbonnais', 'Burbank', 'Calumet City', 'Cicero', 'Dekalb', 'Elkhart',
    'Evanston', 'Evergreen Park', 'Frankfort', 'Glenview', 'Greeneville',
    'Hammond', 'Johnson City', 'Kildeer', 'Michigan City', 'Oak Ridge',
    'Round Lake Beach', 'Schererville', 'South Bend', 'South Knoxville',
    'South Skokie', 'Tinley Park', 'Uptown', 'Valparaiso'
  ];

  /* Explicit nickname -> canonical short name.
     Keys are matched case/space-insensitively. Add hard-to-infer nicknames here.
     ("Skokie" is already handled automatically by rule 3, listed only as a
      worked example.) */
  var ALIASES = {
    'skokie': 'South Skokie'
  };

  /* The "X Xfinity Store" form differs from "<canonical> Xfinity Store" for a
     few stores. Only list the exceptions. */
  var XFINITY_NAME_OVERRIDES = {
    'South Skokie': 'Skokie Xfinity Store'
  };

  var DIRECTIONS = ['north', 'south', 'east', 'west', 'n', 's', 'e', 'w'];

  /* ---- helpers ---------------------------------------------------------- */
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/ /g, ' ')        // non-breaking spaces from Excel
      .replace(/\s+/g, ' ')
      .trim();
  }
  function key(s) { return clean(s).toLowerCase(); }
  function stripSuffix(s) {            // drop a trailing " Xfinity Store"
    return clean(s).replace(/\s+xfinity\s+store\s*$/i, '');
  }

  /* ---- lookup tables (built once) --------------------------------------- */
  var byKey = {};        // "south skokie" -> "South Skokie"
  var byBareCity = {};   // "skokie" -> ["South Skokie"]   (directional stores)
  CANONICAL_STORES.forEach(function (c) {
    byKey[key(c)] = c;
    var parts = key(c).split(' ');
    if (DIRECTIONS.indexOf(parts[0]) !== -1 && parts.length > 1) {
      var bare = parts.slice(1).join(' ');
      (byBareCity[bare] = byBareCity[bare] || []).push(c);
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

    if (byKey[k]) return byKey[k];                                  // 1
    if (aliasByKey[k]) return aliasByKey[k];                        // 2
    if (byBareCity[k] && byBareCity[k].length === 1)               // 3
      return byBareCity[k][0];

    var parts = k.split(' ');                                      // 4
    if (DIRECTIONS.indexOf(parts[0]) !== -1 && parts.length > 1) {
      var bare = parts.slice(1).join(' ');
      if (byKey[bare]) return byKey[bare];
    }
    return cleaned;                                                // 5
  }

  /* True only when raw resolves to one of our stores. */
  function isMyStore(raw) {
    return Object.prototype.hasOwnProperty.call(byKey, key(normalizeStore(raw)));
  }

  /* Canonical "X Xfinity Store" form used by the T-Sheet / quote-sheet data. */
  function xfinityStoreName(raw) {
    var canon = normalizeStore(raw);
    if (XFINITY_NAME_OVERRIDES[canon]) return XFINITY_NAME_OVERRIDES[canon];
    if (/xfinity\s+store\s*$/i.test(clean(raw))) return clean(raw);
    return canon + ' Xfinity Store';
  }

  var api = {
    CANONICAL_STORES: CANONICAL_STORES,
    ALIASES: ALIASES,
    normalizeStore: normalizeStore,
    isMyStore: isMyStore,
    xfinityStoreName: xfinityStoreName,
    clean: clean
  };

  root.BLUFOX_STORES = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : this);
