'use strict';
// Load Testing for VS Code (Zovo). Runs HTTP load tests written as small YAML or JSON files, shows a live
// dashboard, checks thresholds and saves JSON and HTML reports. The load runs in a worker thread.
// Network: only the hosts in the test file, after the user confirmed them. No telemetry, no account.
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { monitorEventLoopDelay } = require('perf_hooks');
const spec = require('./core/spec');
const importers = require('./core/importers');
const report = require('./core/report');
const safety = require('./core/safety');
const { buildHtml } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createPro } = require('./pro');

const EXT_ID = 'zovo.zovo-load-testing';
const TEST_GLOB = '**/*.load.{yaml,yml,json}';
const isTestFile = (p) => /\.load\.(ya?ml|json)$/i.test(String(p || ''));
const CONFIRMED_KEY = 'loadTesting.confirmedHosts.v1';

let rating = { success() {}, failure() {} };
let pro = { allow: async () => true, enabled: false };
let ctx;
const runs = new Map(); // test uri -> Run
let diagnostics;
let status;
let demo = null; // { worker, url, host }
const schedules = new Map(); // uri -> { timer, minutes, next }

function cfg() {
  const c = vscode.workspace.getConfiguration('loadTesting');
  return {
    maxVus: c.get('maxVirtualUsers', 200),
    maxRate: c.get('maxRequestsPerSecond', 5000),
    maxDurationMs: c.get('maxDurationMinutes', 60) * 60000,
    blocked: c.get('blockedHosts', ['*.gov', '*.mil']),
    saveResults: c.get('saveResults', true),
    resultsFolder: c.get('resultsFolder', 'load-test-results'),
    maxImportBytes: c.get('maxImportMB', 200) * 1048576,
    maxDataBytes: c.get('maxDataFileMB', 100) * 1048576,
  };
}

const limits = (c = cfg()) => ({ maxVus: c.maxVus, maxRate: c.maxRate, maxDurationMs: c.maxDurationMs });
const workerPath = () => path.join(__dirname, 'worker.js');

// ------------------------------------------------------------------------------------------------ validation
function validateDocument(doc) {
  if (!doc || !isTestFile(doc.fileName)) return;
  const v = spec.validate(doc.getText(), limits());
  const list = [...v.errors.map((e) => [e, vscode.DiagnosticSeverity.Error]), ...v.warnings.map((e) => [e, vscode.DiagnosticSeverity.Warning])].map(([e, sev]) => {
    const line = Math.min(Math.max(0, e.line || 0), Math.max(0, doc.lineCount - 1));
    const d = new vscode.Diagnostic(doc.lineAt(line).range, e.message, sev);
    d.source = 'Load Testing';
    return d;
  });
  diagnostics.set(doc.uri, list);
  return v;
}

// ------------------------------------------------------------------------------------------------ safety
async function confirmHosts(s, docUri) {
  const c = cfg();
  for (const h of s.hosts) {
    if (h === '?') {
      await vscode.window.showErrorMessage('A request URL takes its host from a value that is only known during the run. Put the host in target or in variables, so you can confirm it before the run.');
      return null;
    }
    const by = safety.blockedBy(h, c.blocked);
    if (by) {
      await vscode.window.showErrorMessage(`${h} is on your blocklist ("${by}" in the setting loadTesting.blockedHosts). Nothing was sent.`, 'Open Setting')
        .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'loadTesting.blockedHosts'));
      return null;
    }
  }
  const remembered = new Set(ctx.workspaceState.get(CONFIRMED_KEY, []));
  const need = s.hosts.filter((h) => !remembered.has(h));
  if (need.length) {
    const load = s.model === 'open' ? `up to ${s.peakRate} requests per second (at most ${s.maxVus} at a time)` : `up to ${s.maxVus} virtual users`;
    const pick = await vscode.window.showWarningMessage(`Send load to ${need.join(', ')}?`, {
      modal: true,
      detail: `${s.name}: ${load} for ${spec.fmtDuration(s.totalMs)}.${s.insecure ? ' TLS certificate checks are off for this test (insecure: true).' : ''}\n\nOnly test servers you own or may test. Requests go only to ${s.hosts.length === 1 ? 'this host' : 'these hosts'}. Nothing else is sent anywhere.`,
    }, 'Run', 'Run and Remember Host');
    if (!pick) return null;
    if (pick === 'Run and Remember Host') { for (const h of need) remembered.add(h); await ctx.workspaceState.update(CONFIRMED_KEY, [...remembered].slice(-200)); }
  }
  return s.hosts;
}

// ------------------------------------------------------------------------------------------------ worker jobs
function workerJob(msg, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath());
    const t = setTimeout(() => { w.terminate(); reject(new Error('Reading the file took too long.')); }, timeoutMs);
    w.on('message', (m) => {
      if (m.type === 'imported') { clearTimeout(t); w.terminate(); resolve(m.result); }
      else if (m.type === 'fatal') { clearTimeout(t); w.terminate(); reject(new Error(m.message)); }
    });
    w.on('error', (e) => { clearTimeout(t); reject(e); });
    w.postMessage(msg);
  });
}

async function loadRows(s, docUri) {
  if (!s.data) return null;
  if (docUri.scheme !== 'file') throw new Error('A CSV data file works only for a saved test file on disk.');
  const file = path.resolve(path.dirname(docUri.fsPath), s.data.file);
  const r = await workerJob({ type: 'import', kind: 'csv', file, maxBytes: cfg().maxDataBytes });
  if (!r.rows.length) throw new Error(`${s.data.file} has no data rows.`);
  return { rows: r.rows, truncated: r.truncated };
}

// ------------------------------------------------------------------------------------------------ runs
class Run {
  constructor(uri, s, panel) {
    this.uri = uri; this.spec = s; this.panel = panel;
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.done = false;
  }

  post(m) { if (this.panel && !this.panel.disposed) this.panel.webview.postMessage(m).then(undefined, () => {}); }

  start(allowedHosts, rows, { quiet } = {}) {
    const s = this.spec;
    this.quiet = quiet;
    this.init = { type: 'init', runId: this.id, name: s.name, hosts: allowedHosts, model: s.model, totalMs: s.totalMs, totalText: spec.fmtDuration(s.totalMs), phases: s.phases };
    this.post(this.init);
    this.worker = new Worker(workerPath());
    try { this.hostLag = monitorEventLoopDelay({ resolution: 20 }); this.hostLag.enable(); } catch (e) { this.hostLag = null; }
    this.hostLagMax = 0;
    this.finished = new Promise((r) => { this._finish = r; });
    this.worker.on('message', (m) => this.onMessage(m));
    this.worker.on('error', (e) => this.fail(String(e && e.message || e)));
    this.worker.on('exit', () => { if (!this.done) this.fail('The load test stopped unexpectedly.'); });
    this.worker.postMessage({ type: 'start', spec: s, allowedHosts, rows });
    updateStatus();
    return this.finished;
  }

  onMessage(m) {
    if (m.type === 'tick') {
      let lag = 0;
      if (this.hostLag) { lag = this.hostLag.max / 1e6; this.hostLag.reset(); }
      if (lag > this.hostLagMax) this.hostLagMax = lag;
      this.last = m;
      this.post({ type: 'tick', runId: this.id, tick: m.tick, summary: m.summary, thresholds: m.thresholds, hostLagMs: Math.round(lag) });
      updateStatus();
    } else if (m.type === 'done') this.complete(m.result);
    else if (m.type === 'fatal') this.fail(m.message);
  }

  async complete(result) {
    if (this.done) return;
    this.done = true;
    if (this.hostLag) this.hostLag.disable();
    result.hostLagMaxMs = Math.round(this.hostLagMax);
    const w = this.worker; setTimeout(() => w.terminate(), 50);
    let jsonPath = '', htmlPath = '';
    try { ({ jsonPath, htmlPath } = await saveRun(this.uri, result)); } catch (e) { vscode.window.showWarningMessage(`The report could not be saved: ${e.message}`); }
    this.result = result; this.jsonPath = jsonPath; this.htmlPath = htmlPath;
    this.post({ type: 'done', runId: this.id, result, jsonPath, htmlPath });
    if (result.summary.requests > 0) rating.success(this.uri);
    updateStatus();
    if (!this.quiet && this.panel && this.panel.disposed) {
      const msg = result.thresholds.length ? `${result.name}: ${result.pass ? 'passed' : 'FAILED'} (${result.thresholds.filter((t) => !t.pass).map((t) => t.text).join(', ') || 'all thresholds met'}).` : `${result.name} finished: ${result.summary.requests} requests.`;
      vscode.window.showInformationMessage(msg, ...(htmlPath ? ['Open Report'] : [])).then((p) => p && vscode.env.openExternal(vscode.Uri.file(htmlPath)));
    }
    this._finish(result);
  }

  fail(message) {
    if (this.done) return;
    this.done = true;
    if (this.hostLag) this.hostLag.disable();
    try { this.worker.terminate(); } catch (e) { /* ignore */ }
    rating.failure();
    this.post({ type: 'error', runId: this.id, message });
    if (!this.quiet) vscode.window.showErrorMessage(`Load test stopped: ${message}`);
    updateStatus();
    this._finish(null);
  }

  /** Stops the run: the worker destroys every socket; after 1.5 s the worker is terminated, which closes the rest. */
  stop() {
    if (this.done || !this.worker) return this.finished;
    this.worker.postMessage({ type: 'stop' });
    const w = this.worker;
    setTimeout(() => { if (!this.done) { w.terminate(); } }, 1500);
    return this.finished;
  }
}

function resultsDir(uri) {
  const c = cfg();
  if (uri.scheme === 'file') return path.join(path.dirname(uri.fsPath), c.resultsFolder);
  return path.join(ctx.globalStorageUri.fsPath, 'results');
}

async function saveRun(uri, result) {
  const c = cfg();
  const dir = isSample(uri) ? path.join(ctx.globalStorageUri.fsPath, 'results') : resultsDir(uri);
  if (!c.saveResults && !isSample(uri)) return { jsonPath: '', htmlPath: '' };
  const stem = report.fileStem(result.name, new Date(result.startedAt));
  const d = vscode.Uri.file(dir);
  await vscode.workspace.fs.createDirectory(d);
  const jsonUri = vscode.Uri.joinPath(d, stem + '.json');
  const htmlUri = vscode.Uri.joinPath(d, stem + '.html');
  const data = { ...result, test: uri.scheme === 'file' ? path.basename(uri.fsPath) : uri.toString() };
  await vscode.workspace.fs.writeFile(jsonUri, Buffer.from(JSON.stringify(data)));
  await vscode.workspace.fs.writeFile(htmlUri, Buffer.from(report.htmlReport(result)));
  return { jsonPath: jsonUri.fsPath, htmlPath: htmlUri.fsPath };
}

function isSample(uri) {
  const inside = (base) => base && uri.scheme === 'file' && (uri.fsPath + path.sep).startsWith(base.fsPath + path.sep);
  return inside(ctx.extensionUri) || inside(ctx.globalStorageUri);
}

const panels = new Map(); // test uri -> panel

function dashboard(uri, title) {
  const key = uri.toString();
  let panel = panels.get(key);
  if (panel && !panel.disposed) { panel.reveal(undefined, true); return panel; }
  panel = vscode.window.createWebviewPanel('loadTesting.dashboard', `Load: ${title}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    enableCommandUris: commandUris('loadTesting'),
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'icon.png');
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard.css')).toString(),
    title, showSupportLinks: showLinks(vscode, 'loadTesting'),
  });
  panel.webview.onDidReceiveMessage((m) => {
    if (!m || typeof m !== 'object') return;
    const run = runs.get(key);
    if (m.type === 'ready' && run) { run.post(run.init); if (run.done && run.result) run.post({ type: 'done', runId: run.id, result: run.result, jsonPath: run.jsonPath, htmlPath: run.htmlPath }); }
    else if (m.type === 'stop' && run) run.stop();
    else if (m.type === 'rerun') vscode.commands.executeCommand('loadTesting.run', uri);
    else if (m.type === 'openReport' && run && run.htmlPath) vscode.env.openExternal(vscode.Uri.file(run.htmlPath));
    else if (m.type === 'compare' && run && run.jsonPath) compareRuns(run.jsonPath);
  });
  panel.onDidDispose(() => { panel.disposed = true; panels.delete(key); });
  panels.set(key, panel);
  return panel;
}

function updateStatus() {
  const active = [...runs.values()].filter((r) => !r.done);
  if (!active.length) { status.hide(); vscode.commands.executeCommand('setContext', 'loadTesting.running', false); return; }
  const r = active[0];
  const t = r.last && r.last.tick;
  status.text = `$(pulse) ${t ? `${Math.round(t.rps)} req/s · p95 ${t.p95} ms` : 'Load test starting'}`;
  status.tooltip = `${r.spec.name}: click to stop`;
  status.command = 'loadTesting.stop';
  status.show();
  vscode.commands.executeCommand('setContext', 'loadTesting.running', true);
}

async function getTestDocument(uri) {
  if (uri instanceof vscode.Uri) return vscode.workspace.openTextDocument(uri);
  const ed = vscode.window.activeTextEditor;
  if (ed && isTestFile(ed.document.fileName)) return ed.document;
  const found = await vscode.workspace.findFiles(TEST_GLOB, '**/node_modules/**', 200);
  if (!found.length) {
    const pick = await vscode.window.showInformationMessage('No load test file is open. Create one, or try a demo server first.', 'New Load Test', 'Try the Demo');
    if (pick === 'New Load Test') vscode.commands.executeCommand('loadTesting.newTest');
    if (pick === 'Try the Demo') vscode.commands.executeCommand('loadTesting.tryDemo');
    return null;
  }
  const pick = found.length === 1 ? { uri: found[0] } : await vscode.window.showQuickPick(found.map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Pick a load test to run' });
  return pick ? vscode.workspace.openTextDocument(pick.uri) : null;
}

/** Validates, asks for Pro features and confirmation, then runs. Returns the result or null. */
async function runTest(uri, opts = {}) {
  const doc = await getTestDocument(uri);
  if (!doc) return null;
  const key = doc.uri.toString();
  const existing = runs.get(key);
  if (existing && !existing.done) { dashboard(doc.uri, existing.spec.name); vscode.window.showInformationMessage('This test is already running. Stop it first.'); return null; }
  const v = spec.validate(doc.getText(), limits());
  validateDocument(doc);
  if (!v.ok) {
    const e = v.errors[0];
    vscode.window.showErrorMessage(`The test has ${v.errors.length} problem${v.errors.length > 1 ? 's' : ''}. Line ${e.line + 1}: ${e.message}`, 'Show Problems').then((p) => p && vscode.commands.executeCommand('workbench.actions.view.problems'));
    return null;
  }
  const s = v.spec;
  if (s.pro.length && !(await pro.allow('scenarios'))) return null;
  let rows = null;
  try {
    const r = await loadRows(s, doc.uri);
    if (r) { rows = r.rows; if (r.truncated) vscode.window.showInformationMessage(`${s.data.file}: the first ${rows.length.toLocaleString('en-US')} rows are used.`); }
  } catch (e) { vscode.window.showErrorMessage(`Data file: ${e.message}`); return null; }
  const allowed = opts.allowedHosts || await confirmHosts(s, doc.uri);
  if (!allowed) return null;
  if (doc.isDirty && doc.uri.scheme === 'file' && !opts.quiet) await doc.save();
  const panel = opts.quiet ? null : dashboard(doc.uri, s.name);
  const run = new Run(doc.uri, s, panel);
  runs.set(key, run);
  return run.start(allowed, rows, { quiet: opts.quiet });
}

async function stopRuns() {
  const active = [...runs.values()].filter((r) => !r.done);
  if (!active.length) { vscode.window.setStatusBarMessage('No load test is running.', 3000); return; }
  await Promise.all(active.map((r) => r.stop()));
}

// ------------------------------------------------------------------------------------------------ new test, demo
function uniqueUri(dir, base, ext) {
  return (async () => {
    for (let i = 0; i < 1000; i++) {
      const u = vscode.Uri.joinPath(dir, `${base}${i ? '-' + (i + 1) : ''}${ext}`);
      try { await vscode.workspace.fs.stat(u); } catch (e) { return u; }
    }
    return vscode.Uri.joinPath(dir, `${base}-${Date.now()}${ext}`);
  })();
}

function baseDir(near) {
  if (near && near.scheme === 'file') return vscode.Uri.file(path.dirname(near.fsPath));
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : null;
}

async function writeAndOpen(text, near, base) {
  const dir = baseDir(near);
  if (!dir) {
    const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('Save the file with a name that ends in .load.yaml to run it.');
    return doc.uri;
  }
  const u = await uniqueUri(dir, base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'api', '.load.yaml');
  await vscode.workspace.fs.writeFile(u, Buffer.from(text));
  await vscode.window.showTextDocument(u);
  return u;
}

async function newTest() {
  const target = await vscode.window.showInputBox({
    title: 'New load test', prompt: 'Base URL of the API to test (only this host receives requests)', value: 'http://localhost:3000',
    validateInput: (v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? '' : 'Use http:// or https://'; } catch (e) { return 'Enter a URL such as http://localhost:3000'; } },
  });
  if (!target) return;
  return writeAndOpen(spec.example(target.replace(/\/+$/, '')), null, 'api');
}

function startDemo() {
  if (demo) return Promise.resolve(demo);
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath());
    w.on('message', (m) => { if (m.type === 'demo') { demo = { worker: w, url: m.url, host: m.host }; resolve(demo); } else if (m.type === 'fatal') reject(new Error(m.message)); });
    w.on('error', reject);
    w.on('exit', () => { demo = null; });
    w.postMessage({ type: 'demo' });
  });
}

async function tryDemo() {
  const d = await startDemo();
  const dir = ctx.globalStorageUri;
  await vscode.workspace.fs.createDirectory(dir);
  const u = vscode.Uri.joinPath(dir, 'demo-api.load.yaml');
  const text = `# Demo: a small JSON API that this extension started on your own computer (${d.host}).
# It stops when VS Code closes. Change the phases or thresholds and run again.
name: Demo API
target: ${d.url}
request:
  method: GET
  url: /api/orders?limit=10
checks:
  status: 200
  jsonPath:
    $.status: ok
phases:
  - name: ramp-up
    duration: 5s
    vus: [1, 25]
  - name: steady
    duration: 15s
    vus: 25
  - name: ramp-down
    duration: 3s
    vus: [25, 0]
thinkTime: [5ms, 20ms]
thresholds:
  - p95 < 100ms
  - errors < 1%
`;
  await vscode.workspace.fs.writeFile(u, Buffer.from(text));
  await vscode.window.showTextDocument(u);
  // The demo host is local and started by the extension, so no confirmation is needed.
  return runTest(u, { allowedHosts: [d.host] });
}

// ------------------------------------------------------------------------------------------------ imports
function importKind(fsPath, head) {
  const p = fsPath.toLowerCase();
  if (p.endsWith('.har')) return 'har';
  if (p.endsWith('.jmx')) return 'jmx';
  if (p.endsWith('.http') || p.endsWith('.rest')) return 'http';
  if (/\.(ya?ml|json)$/.test(p)) return /["']?(openapi|swagger)["']?\s*:/.test(head) ? 'openapi' : '';
  return '';
}

async function pickRequests(imp, kind) {
  if (imp.requests.length <= 1) return imp.requests;
  const max = 2000;
  const items = imp.requests.slice(0, max).map((r, i) => ({ label: r.name, description: r.label && r.label !== r.name ? r.label : '', detail: r.url.length > 120 ? r.url.slice(0, 120) + '...' : r.url, picked: kind === 'http' || kind === 'jmx' || i < 1, i }));
  const pick = await vscode.window.showQuickPick(items, {
    canPickMany: true, matchOnDetail: true,
    placeHolder: `Pick the requests for the test (${imp.requests.length}${imp.requests.length > max ? `, first ${max} shown` : ''}). One request makes a simple test; several make a multi-step scenario.`,
  });
  if (!pick || !pick.length) return null;
  return pick.sort((a, b) => a.i - b.i).map((p) => imp.requests[p.i]);
}

async function importFile(uri) {
  let target = uri instanceof vscode.Uri ? uri : null;
  if (!target) {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file' && importKind(ed.document.fileName, ed.document.getText(new vscode.Range(0, 0, 50, 0)))) target = ed.document.uri;
  }
  if (!target) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import', filters: { 'Requests': ['http', 'rest', 'har', 'yaml', 'yml', 'json', 'jmx'] } });
    if (!picked || !picked.length) return;
    target = picked[0];
  }
  if (target.scheme !== 'file') { vscode.window.showErrorMessage('Import works with files on disk.'); return; }
  let head = '';
  try {
    const fh = await require('fs').promises.open(target.fsPath, 'r');
    const b = Buffer.alloc(65536); const { bytesRead } = await fh.read(b, 0, b.length, 0); await fh.close();
    head = b.subarray(0, bytesRead).toString('utf8');
  } catch (e) { vscode.window.showErrorMessage(`The file could not be read: ${e.message}`); return; }
  const kind = importKind(target.fsPath, head);
  if (!kind) { vscode.window.showErrorMessage('This file is not a .http or .rest file, a HAR file, an OpenAPI or Swagger document, or a JMeter .jmx plan.'); return; }
  let imp;
  try {
    imp = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading ${path.basename(target.fsPath)}` },
      () => workerJob({ type: 'import', kind, file: target.fsPath, maxBytes: cfg().maxImportBytes }));
  } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  if (!imp.requests.length) { vscode.window.showErrorMessage(`No request found. ${(imp.notes || []).join(' ')}`); return; }
  const chosen = await pickRequests(imp, kind);
  if (!chosen) return;
  const base = path.basename(target.fsPath).replace(/\.[^.]+$/, '');
  const text = importers.buildTest({ ...imp, requests: chosen }, { name: imp.title || base, source: path.basename(target.fsPath) });
  const out = await writeAndOpen(text, target, base);
  if (imp.notes && imp.notes.length) vscode.window.showInformationMessage(`Imported ${chosen.length} request${chosen.length > 1 ? 's' : ''}. ${imp.notes[0]}`);
  return out;
}

async function importCurl(arg) {
  let text = typeof arg === 'string' ? arg : '';
  const ed = vscode.window.activeTextEditor;
  if (!text && ed && !ed.selection.isEmpty && /\bcurl\b/.test(ed.document.getText(ed.selection))) text = ed.document.getText(ed.selection);
  if (!text) { const clip = await vscode.env.clipboard.readText(); if (/^\s*curl\s/.test(clip)) text = clip; }
  if (!text) text = await vscode.window.showInputBox({ title: 'Import a cURL command', prompt: 'Paste a curl command (from DevTools "Copy as cURL" or the API docs)', placeHolder: "curl 'https://api.example.com/items' -H 'accept: application/json'" });
  if (!text) return;
  const imp = importers.fromCurl(text);
  if (!imp.requests.length) { vscode.window.showErrorMessage(imp.notes.join(' ') || 'No request found in the cURL command.'); return; }
  const r = imp.requests[0];
  return writeAndOpen(importers.buildTest(imp, { source: 'a cURL command' }), ed && ed.document.uri.scheme === 'file' ? ed.document.uri : null, r.name.split(' ')[1].split('/').filter(Boolean).pop() || 'curl');
}

// ------------------------------------------------------------------------------------------------ reports
async function listRuns(near) {
  const pattern = `**/${cfg().resultsFolder}/*.json`;
  const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 2000);
  const extra = [];
  try {
    const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'results');
    for (const [n] of await vscode.workspace.fs.readDirectory(dir)) if (n.endsWith('.json')) extra.push(vscode.Uri.joinPath(dir, n));
  } catch (e) { /* none */ }
  const all = [...found, ...extra];
  const out = [];
  for (const u of all) {
    try {
      const st = await vscode.workspace.fs.stat(u);
      if (st.size > 64 * 1048576) continue;
      out.push({ uri: u, mtime: st.mtime });
    } catch (e) { /* skip */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function readRun(fsPathOrUri) {
  const u = typeof fsPathOrUri === 'string' ? vscode.Uri.file(fsPathOrUri) : fsPathOrUri;
  const o = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8'));
  if (!report.isRun(o)) throw new Error(`${path.basename(u.fsPath)} is not a run saved by this extension.`);
  return o;
}

async function pickRun(placeHolder, exclude) {
  const list = (await listRuns()).filter((r) => !exclude || r.uri.fsPath !== exclude);
  if (!list.length) { vscode.window.showInformationMessage('No saved runs found. Runs are saved in load-test-results next to each test.'); return null; }
  const pick = await vscode.window.showQuickPick(list.slice(0, 500).map((r) => ({ label: path.basename(r.uri.fsPath, '.json'), description: new Date(r.mtime).toLocaleString(), detail: vscode.workspace.asRelativePath(r.uri), uri: r.uri })), { placeHolder, matchOnDetail: true });
  return pick ? pick.uri : null;
}

async function compareRuns(aPath) {
  try {
    const bUri = aPath ? vscode.Uri.file(aPath) : await pickRun('Pick the newer run (B)');
    if (!bUri) return;
    const aUri = await pickRun('Pick the run to compare it with (A, the baseline)', bUri.fsPath);
    if (!aUri) return;
    const [a, b] = [await readRun(aUri), await readRun(bUri)];
    showHtml('Compare runs', report.compareHtml(a, b));
  } catch (e) { vscode.window.showErrorMessage(e.message); }
}

async function showHistory() {
  if (!(await pro.allow('history'))) return;
  const ed = vscode.window.activeTextEditor;
  const name = ed && isTestFile(ed.document.fileName) ? (spec.validate(ed.document.getText()).spec || {}).name : null;
  const runsList = [];
  for (const r of (await listRuns()).slice(0, 400)) {
    try { const o = await readRun(r.uri); if (!name || o.name === name) runsList.push(o); } catch (e) { /* skip */ }
  }
  if (!runsList.length) { vscode.window.showInformationMessage('No saved runs found for this test.'); return; }
  runsList.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  showHtml('Run history', report.historyHtml(runsList.slice(-100)));
}

function showHtml(title, html) {
  // The report HTML has no script. In the webview it gets a CSP that allows only inline styles.
  const panel = vscode.window.createWebviewPanel('loadTesting.report', title, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
  panel.webview.html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
}

async function openReport() {
  const u = await pickRun('Pick a saved run');
  if (!u) return;
  const html = u.fsPath.replace(/\.json$/, '.html');
  try { await vscode.workspace.fs.stat(vscode.Uri.file(html)); await vscode.env.openExternal(vscode.Uri.file(html)); }
  catch (e) { try { showHtml('Load test report', report.htmlReport(await readRun(u))); } catch (e2) { vscode.window.showErrorMessage(e2.message); } }
}

// ------------------------------------------------------------------------------------------------ schedule
async function scheduleRuns(uri) {
  if (!(await pro.allow('schedule'))) return;
  const doc = await getTestDocument(uri);
  if (!doc) return;
  const key = doc.uri.toString();
  const existing = schedules.get(key);
  const pick = await vscode.window.showQuickPick([
    ...['5', '15', '30', '60'].map((m) => ({ label: `Every ${m} minutes`, minutes: Number(m) })),
    ...(existing ? [{ label: 'Stop the schedule', minutes: 0 }] : []),
  ], { placeHolder: `Run ${path.basename(doc.fileName)} on a schedule while VS Code is open${existing ? ` (now every ${existing.minutes} min)` : ''}` });
  if (!pick) return;
  if (existing) { clearInterval(existing.timer); schedules.delete(key); }
  if (!pick.minutes) { vscode.window.setStatusBarMessage('Schedule stopped.', 3000); return; }
  const v = spec.validate(doc.getText(), limits());
  if (!v.ok) { validateDocument(doc); vscode.window.showErrorMessage('Fix the problems in the test first.'); return; }
  const hosts = await confirmHosts(v.spec, doc.uri);
  if (!hosts) return;
  const timer = setInterval(async () => {
    const r = runs.get(key);
    if (r && !r.done) return;
    const res = await runTest(doc.uri, { quiet: true, allowedHosts: hosts });
    if (res && res.thresholds.length && !res.pass) vscode.window.showWarningMessage(`Scheduled run of ${res.name} FAILED: ${res.thresholds.filter((t) => !t.pass).map((t) => `${t.text} (measured ${t.actual})`).join(', ')}`);
  }, pick.minutes * 60000);
  schedules.set(key, { timer, minutes: pick.minutes });
  vscode.window.showInformationMessage(`${path.basename(doc.fileName)} runs every ${pick.minutes} minutes while VS Code is open. You get a message only when a threshold fails.`);
}

// ------------------------------------------------------------------------------------------------ editor help
class Lens {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeCodeLenses = this.emitter.event; }
  provideCodeLenses(doc) {
    if (!isTestFile(doc.fileName)) return [];
    const r = new vscode.Range(0, 0, 0, 0);
    const run = runs.get(doc.uri.toString());
    if (run && !run.done) return [new vscode.CodeLens(r, { title: '$(debug-stop) Stop load test', command: 'loadTesting.stop' })];
    return [
      new vscode.CodeLens(r, { title: '$(play) Run load test', command: 'loadTesting.run', arguments: [doc.uri] }),
      new vscode.CodeLens(r, { title: 'Compare runs', command: 'loadTesting.compareRuns' }),
    ];
  }
}

const KEYS = {
  '': spec.TOP_KEYS.filter((k) => k !== '$schema'),
  request: ['method', 'url', 'headers', 'body', 'json', 'form', 'query'],
  checks: ['status', 'maxLatency', 'bodyContains', 'bodyNotContains', 'jsonPath', 'header'],
  phases: ['name', 'duration', 'vus', 'rate'],
  steps: ['name', 'request', 'checks', 'extract', 'thinkTime'],
};
const HINTS = {
  target: 'Base URL, for example http://localhost:3000', request: 'One request: method, url, headers, body', steps: 'Several requests in a row',
  phases: 'Load over time: duration with vus (users) or rate (requests per second)', thresholds: 'Pass/fail rules, for example "p95 < 300ms"',
  thinkTime: 'Pause after each iteration, for example 100ms or [50ms, 200ms]', checks: 'Checks on each response', insecure: 'Allow invalid TLS certificates',
  data: 'CSV file with one row per iteration', vus: 'Virtual users: a number or [from, to]', rate: 'Requests per second: a number or [from, to]',
};

function completionItems(doc, pos) {
  if (!isTestFile(doc.fileName) || /json$/i.test(doc.fileName)) return [];
  const line = doc.lineAt(pos.line).text.slice(0, pos.character);
  if (!/^\s*(-\s+)?[A-Za-z]*$/.test(line)) return [];
  const indent = line.match(/^\s*(-\s+)?/)[0].length;
  let parent = '';
  if (indent > 0) {
    for (let l = pos.line - 1; l >= 0; l--) {
      const t = doc.lineAt(l).text;
      if (!t.trim() || /^\s*#/.test(t)) continue;
      const ind = t.match(/^\s*/)[0].length;
      const m = /^\s*(?:-\s+)?([A-Za-z]+)\s*:/.exec(t);
      if (ind < indent && m && !/^\s*-/.test(t)) { parent = m[1]; break; }
      if (ind === 0) break;
    }
  }
  const keys = KEYS[parent] || (indent === 0 ? KEYS[''] : []);
  return keys.map((k) => {
    const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
    it.insertText = k + ': ';
    if (HINTS[k]) it.detail = HINTS[k];
    return it;
  });
}

// ------------------------------------------------------------------------------------------------ activate
function activate(context) {
  ctx = context;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'loadTesting', name: 'Load Testing' });
  registerSupport({ vscode, context, prefix: 'loadTesting', selfId: EXT_ID });
  pro = createPro({ vscode, context });
  diagnostics = vscode.languages.createDiagnosticCollection('Load Testing');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const lens = new Lens();
  const timers = new Map();
  const revalidate = (doc) => {
    if (!isTestFile(doc.fileName)) return;
    clearTimeout(timers.get(doc.uri.toString()));
    timers.set(doc.uri.toString(), setTimeout(() => validateDocument(doc), 300));
  };
  const selector = [{ pattern: '**/*.load.{yaml,yml}' }, { pattern: '**/*.load.json' }];
  context.subscriptions.push(
    diagnostics, status,
    vscode.languages.registerCodeLensProvider(selector, lens),
    vscode.languages.registerCompletionItemProvider({ pattern: '**/*.load.{yaml,yml}' }, { provideCompletionItems: completionItems }),
    vscode.workspace.onDidOpenTextDocument(revalidate),
    vscode.workspace.onDidChangeTextDocument((e) => revalidate(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    vscode.commands.registerCommand('loadTesting.run', (uri) => runTest(uri).then(() => lens.emitter.fire())),
    vscode.commands.registerCommand('loadTesting.stop', () => stopRuns()),
    vscode.commands.registerCommand('loadTesting.newTest', () => newTest()),
    vscode.commands.registerCommand('loadTesting.tryDemo', () => tryDemo().then(() => lens.emitter.fire())),
    vscode.commands.registerCommand('loadTesting.importFile', (uri) => importFile(uri)),
    vscode.commands.registerCommand('loadTesting.importCurl', (text) => importCurl(text)),
    vscode.commands.registerCommand('loadTesting.openReport', () => openReport()),
    vscode.commands.registerCommand('loadTesting.compareRuns', (a) => compareRuns(typeof a === 'string' ? a : undefined)),
    vscode.commands.registerCommand('loadTesting.showHistory', () => showHistory()),
    vscode.commands.registerCommand('loadTesting.scheduleRuns', (uri) => scheduleRuns(uri)),
    vscode.commands.registerCommand('loadTesting.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#loadTesting.start`, false)),
    vscode.commands.registerCommand('loadTesting.forgetHosts', async () => { await context.workspaceState.update(CONFIRMED_KEY, []); vscode.window.setStatusBarMessage('Confirmed hosts cleared. Each host is asked again.', 4000); }),
    { dispose: () => { for (const r of runs.values()) r.stop(); for (const s of schedules.values()) clearInterval(s.timer); if (demo) demo.worker.terminate(); } },
  );
  for (const d of vscode.workspace.textDocuments) revalidate(d);
  // A hook for the release gate only (VS Code started with ZOVO_LOAD_GATE=1). Normal installs export nothing,
  // so no other extension can start a run through this one.
  if (process.env.ZOVO_LOAD_GATE !== '1') return undefined;
  return {
    _gate: {
      runs: () => [...runs.values()].map((r) => ({ uri: r.uri.toString(), done: r.done, jsonPath: r.jsonPath, htmlPath: r.htmlPath, result: r.result, hostLagMax: r.hostLagMax, last: r.last && r.last.tick })),
      runTest: (uri, allowedHosts) => runTest(uri, { allowedHosts, quiet: false }),
      startDemo: () => startDemo().then((d) => ({ url: d.url, host: d.host })),
      validate: (text) => spec.validate(text, limits()),
    },
  };
}

function deactivate() {
  for (const r of runs.values()) r.stop();
  if (demo) demo.worker.terminate();
}

module.exports = { activate, deactivate, importKind };
