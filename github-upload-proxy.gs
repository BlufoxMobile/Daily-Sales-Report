/** ============================================================================
 * BLUFOX GITHUB UPLOAD PROXY  (Google Apps Script)
 * ----------------------------------------------------------------------------
 * Receives morning-report files from upload.html (and closure updates from
 * crm.html) and commits them to GitHub. The GitHub token lives ONLY in Script
 * Properties (server-side) — it never appears in any public page again.
 *
 * SETUP (one time):
 *   1. script.google.com → New project → paste this file.
 *   2. Project Settings (gear) → Script Properties → add TWO properties:
 *        GITHUB_TOKEN  = your new fine-grained PAT
 *        UPLOAD_KEY    = a passphrase you invent (this is what you'll type
 *                        into the upload page once per browser)
 *   3. Deploy → New deployment → type: Web app
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      → copy the /exec URL into PROXY_URL at the top of upload.html and
 *        crm.html.
 *
 * PAYLOAD CONTRACT (POSTed as text/plain JSON so no CORS preflight is needed):
 *   { key:   "<UPLOAD_KEY>",
 *     files: [ { repo: "Daily-Sales-Report",
 *                path: "data/open-orders.json",
 *                contentBase64: "<base64 bytes>",
 *                message: "commit message" }, ... ] }
 *
 * RESPONSE:
 *   { ok: <all repos committed>,
 *     results: [ { repo, ok, commit?, error?,
 *                  files: [ { path, ok, error } ] }, ... ] }
 *
 * SECURITY MODEL:
 *   - Callers must present UPLOAD_KEY. The key is never in public source —
 *     upload.html/crm.html ask for it once and keep it in that browser's
 *     localStorage ('blufoxUploadKey').
 *   - Even with the key, only the exact repo/path pairs in ALLOWED below can
 *     be written. All are data files (plus the Exception-Report page whose
 *     data is embedded in its index.html); nothing outside this list can
 *     ever be written.
 *   - One commit per repo per upload (atomic, clean history).
 *   - Ref conflicts (409/422 when another commit lands mid-flight) are
 *     retried up to 3× with a fresh ref.
 * ========================================================================== */

const REPO_OWNER = 'BlufoxMobile';
const BRANCH = 'main';
const MAX_FILE_BYTES = 40 * 1024 * 1024; // 40 MB per file, post-decode

/* Every path this proxy is allowed to write. Add a line when a new dashboard
 * needs a new data file — nothing outside this list can ever be written.
 *
 * Entry formats:
 *   'exact/path.ext'   exact match only
 *   'dir/*'            .json file sitting DIRECTLY under dir/ (no subdirs)
 *   'dir/*.pdf'        .pdf  file sitting DIRECTLY under dir/ (any extension
 *                      may be named this way)
 *   'dir/**.jpg'       .jpg  file anywhere UNDER dir/ (subdirs allowed —
 *                      Monday-Ops photos live in dir/<date>-<store>/<id>.jpg)
 * All wildcard matches additionally reject '..', '//', '\\' and leading '/'. */
const ALLOWED = {
  'Daily-Sales-Report': [
    'data/Sales Report.xlsx',
    'data/promo-card.jpg',
    'data/shoppertrack.xlsx',
    'data/open-orders.json',
    'data/nps-responses.json',
    'data/nps-sent-log.json',
    'data/nps-mtd.json',
    'data/closures.json',
    'data/store-directory.json',
    'data/target-summary.json',
    'data/target-pdfs/*.pdf',
    'data/monday-ops-submissions/*',
    'data/monday-ops-photos/**.jpg'
  ],
  'Daily-Goals-Sheet':  ['data/sales.xlsx'],
  'One-On-One-Form':    ['data/sales.xlsx'],
  'Auto-Punch-Report':  ['data/punch-data.xlsx'],
  'Exception-Report':   ['data/exceptions-data.js', 'index.html']
};

/* Allow check: exact match, or wildcard match per the entry formats above.
 * 'dir/*'      → path directly under dir/, extension .json (default)
 * 'dir/*.ext'  → path directly under dir/, extension .ext
 * 'dir/**.ext' → path anywhere under dir/ (subdirs OK), extension .ext */
function isAllowed_(repo, path) {
  const list = ALLOWED[repo];
  if (!list) return false;
  const p = String(path);
  if (p.indexOf('..') !== -1 || p.indexOf('//') !== -1 ||
      p.indexOf('\\') !== -1 || p.charAt(0) === '/') return false;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const star = entry.indexOf('*');
    if (star === -1) {                                   // exact entry
      if (entry === p) return true;
      continue;
    }
    const prefix = entry.slice(0, star);
    if (prefix.slice(-1) !== '/') continue;              // wildcard must follow 'dir/'
    const deep = entry.charAt(star + 1) === '*';         // 'dir/**.ext' → subdirs allowed
    const ext = (entry.slice(star).replace(/\*/g, '') || '.json').toLowerCase();
    if (p.indexOf(prefix) !== 0) continue;               // must start with the dir prefix
    const rest = p.slice(prefix.length);
    if (rest.length <= ext.length) continue;             // needs a real filename
    if (rest.slice(-ext.length).toLowerCase() !== ext) continue;
    if (!deep && rest.indexOf('/') !== -1) continue;     // must sit directly under dir/
    return true;
  }
  return false;
}

/* ---- entry points -------------------------------------------------------- */

function doGet() {
  return json_({ ok: true, service: 'blufox-upload-proxy' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'Bad JSON' }); }

  const props = PropertiesService.getScriptProperties();
  const expectedKey = props.getProperty('UPLOAD_KEY');
  const token = props.getProperty('GITHUB_TOKEN');
  if (!expectedKey || !token) return json_({ ok: false, error: 'Proxy not configured (Script Properties missing)' });
  if (!body.key || String(body.key) !== expectedKey) return json_({ ok: false, error: 'Bad key' });

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return json_({ ok: false, error: 'No files' });

  // Validate everything BEFORE writing anything.
  for (const f of files) {
    if (!f || !f.repo || !f.path || !f.contentBase64) return json_({ ok: false, error: 'Malformed file entry' });
    if (!isAllowed_(f.repo, f.path))
      return json_({ ok: false, error: 'Path not allowed: ' + f.repo + '/' + f.path });
    if (f.contentBase64.length * 0.75 > MAX_FILE_BYTES)
      return json_({ ok: false, error: 'File too large: ' + f.path });
  }

  // Group by repo → one commit per repo.
  const byRepo = {};
  files.forEach(f => { (byRepo[f.repo] = byRepo[f.repo] || []).push(f); });

  const results = [];
  for (const repo in byRepo) {
    const group = byRepo[repo];
    try {
      const sha = commitFiles_(token, repo, group);
      results.push({
        repo: repo, ok: true, commit: sha,
        files: group.map(f => ({ path: f.path, ok: true, error: null }))
      });
    } catch (err) {
      results.push({
        repo: repo, ok: false, error: String(err),
        files: group.map(f => ({ path: f.path, ok: false, error: String(err) }))
      });
    }
  }
  return json_({ ok: results.every(r => r.ok), results: results });
}

/* ---- GitHub git-data flow: blobs → tree → commit → ref ------------------- */
/* Retries the whole flow (with a freshly fetched ref) up to 3 times when the
 * ref update hits a 409/422 conflict — i.e. someone else committed between
 * our ref read and ref update. */

function commitFiles_(token, repo, files) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return commitFilesOnce_(token, repo, files);
    } catch (err) {
      lastErr = err;
      const code = err && err.ghCode;
      if ((code === 409 || code === 422) && attempt < MAX_ATTEMPTS) {
        Utilities.sleep(500 * attempt);  // brief backoff, then re-fetch ref & retry
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function commitFilesOnce_(token, repo, files) {
  const base = 'https://api.github.com/repos/' + REPO_OWNER + '/' + repo;

  const ref = gh_(token, base + '/git/ref/heads/' + BRANCH, 'get');
  const parentSha = ref.object.sha;
  const parent = gh_(token, base + '/git/commits/' + parentSha, 'get');

  const treeEntries = files.map(f => {
    const blob = gh_(token, base + '/git/blobs', 'post',
      { content: f.contentBase64, encoding: 'base64' });
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  });

  const tree = gh_(token, base + '/git/trees', 'post',
    { base_tree: parent.tree.sha, tree: treeEntries });

  const message = (files[0].message ? String(files[0].message).slice(0, 200) : 'Morning upload')
    + (files.length > 1 ? ' (+' + (files.length - 1) + ' more)' : '');

  const commit = gh_(token, base + '/git/commits', 'post',
    { message: message, tree: tree.sha, parents: [parentSha] });

  gh_(token, base + '/git/refs/heads/' + BRANCH, 'patch', { sha: commit.sha });
  return commit.sha;
}

function gh_(token, url, method, payload) {
  const params = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    muteHttpExceptions: true
  };
  if (payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(payload);
  }
  let resp = UrlFetchApp.fetch(url, params);
  if (resp.getResponseCode() >= 500) resp = UrlFetchApp.fetch(url, params); // one retry on 5xx
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    const err = new Error('GitHub ' + method.toUpperCase() + ' '
      + url.replace(/https:\/\/api\.github\.com/, '') + ' → ' + code);
    err.ghCode = code;
    throw err;
  }
  return JSON.parse(resp.getContentText() || '{}');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
