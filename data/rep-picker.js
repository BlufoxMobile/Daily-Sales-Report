/*! ============================================================================
 *  BLUFOX REP PICKER v4
 *  ---------------------------------------------------------------------------
 *  One shared script for every Blufox quote tool. Drives the "Your Store" and
 *  "Your Name" dropdowns straight off the Admin Panel directory:
 *      https://blufoxmobile.github.io/Admin-Panel-Directory/
 *      -> BlufoxMobile/Daily-Sales-Report/data/store-directory.json
 *
 *  Pick a store  -> the name dropdown lists that store's Reps, Store Manager,
 *                   Assistant Manager and District Manager.
 *  Pick a name   -> the email field auto-fills and locks.
 *  Not listed?   -> "My name isn't listed" lets you type name + email.
 *
 *  Include ONCE, in <head>, BEFORE any legacy inline roster block:
 *      <script src="https://blufoxmobile.github.io/Daily-Sales-Report/data/rep-picker.js"></script>
 *
 *  It sets __BLUFOX_ROSTER__ / __BLUFOX_REPEMAIL__ immediately, which makes the
 *  older inline BLUFOX_ROSTER_DIRECTORY_V3 and BLUFOX_REP_EMAIL_DROPDOWN_V2
 *  blocks self-disable, so no other edit to the host page is required.
 *
 *  Host pages supported (auto-detected by element id):
 *      Mobile-Quote-Sheet-6th-Gen      storeName / repName / repEmail
 *      Upgrade-Quote-Sheet             storeName / repName / repEmail
 *      Internet-Rate-Plan-Calculator   rep-store / rep-name / rep-email
 * ========================================================================== */
(function () {
  'use strict';

  /* Disable the legacy inline blocks (they bail out on these flags). */
  window.__BLUFOX_ROSTER__ = true;
  window.__BLUFOX_REPEMAIL__ = true;

  if (window.__BLUFOX_REP_PICKER_V4__) return;
  window.__BLUFOX_REP_PICKER_V4__ = true;

  var DIR_RAW = 'https://raw.githubusercontent.com/BlufoxMobile/Daily-Sales-Report/main/data/store-directory.json';
  var DIR_PAGES = 'https://blufoxmobile.github.io/Daily-Sales-Report/data/store-directory.json';

  var SUFFIX = ' Xfinity Store';
  var DOMAIN = '@blufoxmobile.com';
  var TYPE_IT = '__type_it__';
  var LS_STORE = 'bfx_lastStore';
  var LS_REP = 'bfx_lastRep';
  var LS_EMAIL = 'bfx_lastRepEmail';

  /* Element-id sets, tried in order. */
  var LAYOUTS = [
    { store: 'storeName', rep: 'repName', email: 'repEmail' },
    { store: 'rep-store', rep: 'rep-name', email: 'rep-email' }
  ];
  var FIELD_SELECTORS = ['.rep-info-field', '.intake-field', '.rep-field'];

  /* ---------------------------------------------------------------- utils */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function gL(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function sL(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function jget(u) {
    return fetch(u, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function hostCallbacks() {
    ['onRepStoreChange', 'checkSubmitReady', 'updatePreview', 'persistRepData'].forEach(function (fn) {
      if (typeof window[fn] === 'function') { try { window[fn](); } catch (e) {} }
    });
  }
  function fire(el) {
    if (!el) return;
    ['input', 'change', 'blur'].forEach(function (t) {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
    });
  }
  function fieldOf(el) {
    for (var i = 0; i < FIELD_SELECTORS.length; i++) {
      var f = el.closest && el.closest(FIELD_SELECTORS[i]);
      if (f) return f;
    }
    return el.parentNode;
  }
  function titleCase(s) {
    return String(s).replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
  }

  /* ------------------------------------------------------------------ go */
  function init() {
    var cfg = null;
    for (var i = 0; i < LAYOUTS.length; i++) {
      if ($(LAYOUTS[i].store) && $(LAYOUTS[i].rep)) { cfg = LAYOUTS[i]; break; }
    }
    if (!cfg) return;

    var storeSel = $(cfg.store);
    if (!storeSel || storeSel.tagName !== 'SELECT') return;

    /* Does this page display stores WITHOUT the " Xfinity Store" suffix? */
    var shortStores = !Array.prototype.some.call(storeSel.options, function (o) {
      return /xfinity store\s*$/i.test((o.value || o.textContent || '').trim());
    });
    function toFull(v) { return (!v || !shortStores) ? v : (v + SUFFIX); }
    function toDisplay(v) { return shortStores ? String(v).replace(/ Xfinity Store$/i, '') : v; }

    /* ---- the name control -------------------------------------------- */
    var repEl = $(cfg.rep);
    var repField = fieldOf(repEl);
    var repLabel = repField.querySelector('label');
    var repLabelHtml = repLabel ? repLabel.outerHTML : '';
    var repClass = repEl.className || '';
    var repNameAttr = repEl.getAttribute('name') || '';
    var repOnInput = repEl.getAttribute('oninput') || '';
    var repOnChange = repEl.getAttribute('onchange') || '';

    function repAttrs() {
      return ' id="' + esc(cfg.rep) + '"' +
        (repNameAttr ? ' name="' + esc(repNameAttr) + '"' : '') +
        (repClass ? ' class="' + esc(repClass) + '"' : '') +
        (repOnInput ? ' oninput="' + esc(repOnInput) + '"' : '') +
        (repOnChange ? ' onchange="' + esc(repOnChange) + '"' : '');
    }
    var currentRep = repEl;
    function setRepControl(html) {
      repField.innerHTML = repLabelHtml + html;
      currentRep = $(cfg.rep);
      return currentRep;
    }

    /* ---- the email control (kept in place so host listeners survive) -- */
    var emailEl = $(cfg.email);
    var emailIsSelect = !!emailEl && emailEl.tagName === 'SELECT';
    var emailField = emailEl ? fieldOf(emailEl) : null;
    var manualEmail = null;   // only built when the email element is a <select>

    function buildManualEmail() {
      if (manualEmail || !emailEl) return;
      manualEmail = document.createElement('input');
      manualEmail.type = 'email';
      manualEmail.id = 'bfxManualEmail';
      manualEmail.className = emailEl.className || '';
      manualEmail.setAttribute('autocomplete', 'email');
      manualEmail.placeholder = 'name' + DOMAIN;
      manualEmail.style.display = 'none';
      emailEl.parentNode.insertBefore(manualEmail, emailEl.nextSibling);
      manualEmail.addEventListener('input', function () {
        var v = manualEmail.value.trim();
        emailEl.innerHTML = '<option value="' + esc(v) + '" selected>' + esc(v || '—') + '</option>';
        sL(LS_EMAIL, v);
        fire(emailEl);
        hostCallbacks();
      });
    }

    /* The host pages force-append "@blufoxmobile.com" on every keystroke. If
       someone pastes their whole address that can leave the domain in twice,
       so collapse anything after the first occurrence. Registered after the
       host's own input listener, so it always gets the last word. */
    if (emailEl && !emailIsSelect) {
      emailEl.addEventListener('input', function () {
        var v = emailEl.value;
        var i = v.toLowerCase().indexOf(DOMAIN);
        if (i !== -1 && i + DOMAIN.length < v.length) {
          var fixed = v.slice(0, i + DOMAIN.length);
          if (fixed !== v) emailEl.value = fixed;
        }
      });
    }

    /* locked === true  -> roster pick, read-only
       locked === false -> manual entry, editable                          */
    function setEmail(value, locked, placeholderText) {
      if (!emailEl) return;
      if (emailIsSelect) {
        buildManualEmail();
        if (locked === false) {
          emailEl.style.display = 'none';
          manualEmail.style.display = '';
          if (!manualEmail.value) manualEmail.value = value || '';
          var mv = manualEmail.value.trim();
          emailEl.innerHTML = '<option value="' + esc(mv) + '" selected>' + esc(mv || '—') + '</option>';
        } else {
          manualEmail.style.display = 'none';
          emailEl.style.display = '';
          emailEl.disabled = true;
          emailEl.innerHTML = value
            ? '<option value="' + esc(value) + '" selected>' + esc(value) + '</option>'
            : '<option value="">' + esc(placeholderText || '— Select your name first —') + '</option>';
        }
      } else {
        if (locked === false) {
          emailEl.readOnly = false;
          emailEl.style.background = '';
          emailEl.style.opacity = '';
          emailEl.value = value || DOMAIN;
        } else {
          emailEl.value = value || '';
          emailEl.readOnly = true;
          emailEl.style.background = 'rgba(0,0,0,.04)';
          emailEl.style.opacity = '.85';
        }
      }
      if (typeof window.__syncRepEmailSelect === 'function') {
        try { window.__syncRepEmailSelect(); } catch (e) {}
      }
      fire(emailEl);
    }

    /* ---- directory -> people by store --------------------------------- */
    var peopleByStore = {};   // full store name -> [{name,email,role,rank}]
    var storeList = [];
    var loaded = false;

    var ROLE_RANK = { 'Store Manager': 1, 'Assistant Manager': 2, 'District Manager': 3 };

    function buildMaps(d) {
      var emp = (d && d.storeEmployees) || {};
      var sm = (d && d.storeManagers) || {};
      var smn = (d && d.storeManagerNames) || {};
      var am = (d && d.storeAMs) || {};
      var amn = (d && d.storeAMNames) || {};
      var dm = (d && d.storeDMs) || {};
      var dmn = (d && d.storeDMNames) || {};

      /* email -> name, harvested from everything that carries both */
      var e2n = {};
      function learn(email, name) {
        if (!email || !name) return;
        e2n[String(email).trim().toLowerCase()] = String(name).trim();
      }
      Object.keys(emp).forEach(function (s) {
        (emp[s] || []).forEach(function (r) {
          if (r && r.email) learn(r.email, ((r.first || '') + ' ' + (r.last || '')).trim());
        });
      });
      Object.keys(sm).forEach(function (s) { learn(sm[s], smn[s]); });
      Object.keys(am).forEach(function (s) { learn(am[s], amn[s]); });
      Object.keys(dm).forEach(function (s) { learn(dm[s], dmn[s]); });

      function nameFor(email, explicit) {
        var n = (explicit || '').trim();
        if (n) return n;
        if (!email) return '';
        n = e2n[String(email).trim().toLowerCase()] || '';
        if (n) return n;
        return String(email).trim();   // last resort: show the address itself
      }

      var storeSet = {};
      [emp, sm, smn, am, amn, dm].forEach(function (o) {
        Object.keys(o || {}).forEach(function (s) { storeSet[s] = 1; });
      });

      peopleByStore = {};
      Object.keys(storeSet).forEach(function (s) {
        var byEmail = {}, list = [];
        function push(name, email, role) {
          name = (name || '').trim();
          if (!name) return;
          var key = (email || '').trim().toLowerCase() || ('name:' + name.toLowerCase());
          var existing = byEmail[key];
          if (existing) {
            /* already here — keep the entry with the more senior role */
            if (role && (ROLE_RANK[role] || 0) && !existing.role) {
              existing.role = role;
              existing.rank = ROLE_RANK[role];
            }
            return;
          }
          var rec = { name: name, email: (email || '').trim(), role: role || '', rank: role ? ROLE_RANK[role] : 0 };
          byEmail[key] = rec;
          list.push(rec);
        }

        push(nameFor(sm[s], smn[s]), sm[s], 'Store Manager');
        push(nameFor(am[s], amn[s]), am[s], 'Assistant Manager');
        push(nameFor(dm[s], dmn[s]), dm[s], 'District Manager');
        (emp[s] || []).forEach(function (r) {
          var nm = (r && typeof r === 'object')
            ? ((r.first || '') + ' ' + (r.last || '')).trim()
            : String(r || '').trim();
          push(nm, (r && r.email) || '', '');
        });

        list.sort(function (a, b) {
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        peopleByStore[s] = list;
      });
    }

    /* ---- rendering ---------------------------------------------------- */
    var lastStore = gL(LS_STORE) || storeSel.value || '';
    var lastRep = gL(LS_REP) || (repEl.value || '').trim() || '';
    var manualMode = false;

    function onRepPicked(el) {
      var v = (el.value || '').trim();
      if (v === TYPE_IT) {
        manualMode = true;
        renderRepManual('');
        return;
      }
      if (v) sL(LS_REP, v);
      var opt = el.options && el.options[el.selectedIndex];
      var em = opt ? (opt.getAttribute('data-email') || '') : '';
      if (em) sL(LS_EMAIL, em);
      setEmail(em, true);
      hostCallbacks();
    }

    function renderRepPlaceholder(text) {
      var el = setRepControl('<select' + repAttrs() + ' autocomplete="name"><option value="">' + esc(text) + '</option></select>');
      el.disabled = true;
      setEmail('', true, '— Select your store first —');
    }

    function renderRepList(people) {
      var reps = [], leads = [];
      people.forEach(function (p) { (p.role ? leads : reps).push(p); });
      leads.sort(function (a, b) { return (a.rank - b.rank) || a.name.localeCompare(b.name); });

      var html = '<option value="">— Select your name —</option>';
      if (reps.length) {
        html += '<optgroup label="Reps">';
        reps.forEach(function (p) {
          html += '<option value="' + esc(p.name) + '" data-email="' + esc(p.email) + '"' +
            (p.name === lastRep ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        });
        html += '</optgroup>';
      }
      if (leads.length) {
        html += '<optgroup label="Management">';
        leads.forEach(function (p) {
          html += '<option value="' + esc(p.name) + '" data-email="' + esc(p.email) + '"' +
            (p.name === lastRep ? ' selected' : '') + '>' + esc(p.name) + ' — ' + esc(p.role) + '</option>';
        });
        html += '</optgroup>';
      }
      if (!reps.length && !leads.length) {
        html += '<option value="" disabled>(no one listed for this store yet)</option>';
      }
      html += '<option value="' + TYPE_IT + '">✏️ My name isn\'t listed — type it</option>';

      var el = setRepControl('<select' + repAttrs() + ' autocomplete="name">' + html + '</select>');
      el.disabled = false;
      el.addEventListener('change', function () { onRepPicked(el); });
      /* reflect whatever was restored */
      if (el.value && el.value !== TYPE_IT) {
        var opt = el.options[el.selectedIndex];
        setEmail(opt ? (opt.getAttribute('data-email') || '') : '', true);
      } else {
        setEmail('', true, '— Select your name —');
      }
    }

    function renderRepManual(prefill) {
      var el = setRepControl(
        '<input type="text"' + repAttrs() + ' autocomplete="name" placeholder="Type your full name">' +
        '<div style="margin-top:6px"><a href="#" id="bfxBackToList" style="font-size:11px;color:#6713d2;text-decoration:underline">↩ back to the store list</a></div>'
      );
      if (prefill) el.value = prefill;
      el.addEventListener('input', function () {
        var v = (el.value || '').trim();
        if (v) sL(LS_REP, v);
        hostCallbacks();
      });
      setEmail('', false);
      var back = $('bfxBackToList');
      if (back) {
        back.addEventListener('click', function (e) {
          e.preventDefault();
          manualMode = false;
          lastRep = '';
          if (manualEmail) manualEmail.value = '';
          if (emailEl && !emailIsSelect) emailEl.value = '';
          refreshRep();
        });
      }
      try { el.focus(); } catch (e) {}
    }

    function refreshRep() {
      var sv = storeSel.value;
      if (manualMode) { renderRepManual((currentRep && currentRep.value) || ''); return; }
      if (!sv) { renderRepPlaceholder('— Select your store first —'); return; }
      if (!loaded) { renderRepPlaceholder('— Loading names… —'); return; }
      var people = peopleByStore[toFull(sv)] || peopleByStore[sv] || [];
      renderRepList(people.slice());
    }

    function fillStores(fullStores) {
      var keep = storeSel.value || lastStore || '';
      var html = '<option value="">— Select your store —</option>';
      fullStores.forEach(function (full) {
        html += '<option>' + esc(toDisplay(full)) + '</option>';
      });
      storeSel.innerHTML = html;
      if (keep) {
        storeSel.value = keep;
        if (storeSel.value !== keep) storeSel.value = '';
      }
    }

    storeSel.addEventListener('change', function () {
      if (storeSel.value) sL(LS_STORE, storeSel.value);
      manualMode = false;
      lastRep = '';
      if (manualEmail) manualEmail.value = '';
      if (emailEl && !emailIsSelect) emailEl.value = '';
      refreshRep();
      hostCallbacks();
    });

    /* first paint from whatever the page shipped with */
    var seeded = [];
    Array.prototype.slice.call(storeSel.options).forEach(function (o) {
      var v = (o.value || o.textContent || '').trim();
      if (!v || /select your store/i.test(v)) return;
      if (!shortStores && !/xfinity store\s*$/i.test(v)) return;  // drops "DM Submission" etc.
      seeded.push(toFull(v));
    });
    fillStores(seeded);
    refreshRep();

    /* then the live directory */
    var bust = '?d=' + new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
    jget(DIR_RAW + bust)
      .catch(function () { return jget(DIR_PAGES + bust); })
      .then(function (d) {
        buildMaps(d);
        storeList = (d && Array.isArray(d.stores) && d.stores.length)
          ? d.stores.slice()
          : Object.keys(peopleByStore);
        storeList.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
        loaded = true;
        if (storeList.length) fillStores(storeList);
        refreshRep();
        hostCallbacks();
      })
      .catch(function () {
        /* directory unreachable — let people type their own details */
        loaded = true;
        manualMode = true;
        refreshRep();
      });
  }

  function boot() { setTimeout(init, 700); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
