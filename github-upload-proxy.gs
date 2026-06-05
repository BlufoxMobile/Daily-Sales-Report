/** ============================================================================
 * BLUFOX GITHUB UPLOAD PROXY  (Google Apps Script)
 * ----------------------------------------------------------------------------
 * Receives morning-report files from upload.html and commits them to GitHub.
 * The GitHub token lives ONLY in Script Properties (server-side) — it never
 * appears in any public page again.
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
 *      → copy the /exec URL.
 *
 * SECURITY MODEL:
 *   - Callers must present UPLOAD_KEY. The key is never in public source —
 *     upload.html asks for it once and keeps it in that browser's localStorage.
 *   - Even with the key, only the exact repo/path pairs in ALLOWED below can
 *     be written. All are data files; this proxy can never modify code.
 *   - One commit per repo per upload (atomic, clean history).
 * ========================================================================== */

const REPO_OWNER = 'BlufoxMobile';
const BRANCH = 'main';
const MAX_FILE_BYTES = 40 * 1024 * 1024; // 40 MB per file, post-decode

/* Every path this proxy is allowed to write. Add a line when a new dashboard
 * needs a new data file — nothing outside this list can ever be written. */
const ALLOWED = {
  'Daily-Sales-Report': [
    'data/Sales Report.xlsx',
    'data/promo-card.jpg',
    'data/shoppertrack.xlsx',
    'data/open-orders.json'
  ],
  'Daily-Goals-Sheet':  ['data/sales.xlsx'],
  'One-On-One-Form':    ['data/sales.xlsx'],
  'Auto-Punch-Report':  ['data/punch-data.xlsx'],
  'Exception-Report':   ['data/exceptions-data.js']
};

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
  if (!body.key || String(body.key) !== expectedKey) return json_({ ok: false, error: 'unauthorized' });

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return json_({ ok: false, error: 'No files' });

  // Validate everything BEFORE writing anything.
  for (const f of files) {
    if (!f || !f.repo || !f.path || !f.contentBase64) return json_({ ok: false, error: 'Malformed file entry' });
    if (!ALLOWED[f.repo] || ALLOWED[f.repo].indexOf(f.path) === -1)
      return json_({ ok: false, error: 'Path not allowed: ' + f.repo + '/' + f.path });
    if (f.contentBase64.length * 0.75 > MAX_FILE_BYTES)
      return json_({ ok: false, error: 'File too large: ' + f.path });
  }

  // Group by repo → one commit per repo.
  const byRepo = {};
  files.forEach(f => { (byRepo[f.repo] = byRepo[f.repo] || []).push(f); });

  const results = [];
  for (const repo in byRepo) {
    try {
      const sha = commitFiles_(token, repo, byRepo[repo]);
      results.push({ repo: repo, ok: true, commit: sha, files: byRepo[repo].map(f => f.path) });
    } catch (err) {
      results.push({ repo: repo, ok: false, error: String(err) });
    }
  }
  return json_({ ok: results.every(r => r.ok), results: results });
}

/* ---- GitHub git-data flow: blobs → tree → commit → ref ------------------- */

function commitFiles_(token, repo, files) {
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
  if (resp.getResponseCode() >= 500) resp = UrlFetchApp.fetch(url, params); // one retry
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300)
    throw new Error('GitHub ' + method.toUpperCase() + ' ' + url.replace(/https:\/\/api\.github\.com/, '') + ' → ' + code);
  return JSON.parse(resp.getContentText() || '{}');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
