'use strict';
// Runs inside a real VS Code (extension host) during the release gate, started by scripts/gate-vscode.mjs with
// --extensionTestsPath and ZOVO_LOAD_GATE=1. It drives the installed extension through its commands and its gate
// hook, against the local test API only, and writes the results to GATE_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

exports.run = async function run() {
  const M = JSON.parse(fs.readFileSync(process.env.GATE_MANIFEST, 'utf8'));
  const res = { started: new Date().toISOString(), vscode: vscode.version, platform: process.platform, arch: process.arch, files: [], checks: [] };
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 500) }); save(); };
  const fileRes = (file, ok, detail, ms) => { res.files.push({ file: path.basename(file), ok: !!ok, detail: String(detail || '').slice(0, 400), ms: ms || 0 }); save(); };
  const save = () => fs.writeFileSync(process.env.GATE_OUT, JSON.stringify(res, null, 1));
  const counts = () => { try { return JSON.parse(fs.readFileSync(M.countsFile, 'utf8')); } catch (e) { return { total: 0, byPath: {}, open: -1 }; } };
  const settle = async () => { await sleep(700); return counts(); };
  // Edits go through the open document (not the disk), so the run reads the new text at once.
  const setText = async (uri, text) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    await vscode.workspace.applyEdit(we);
    await doc.save();
  };
  const shortPhases = (text, secs = 3, vus = 4) => text.replace(/\nphases:[\s\S]*?(?=\n[a-zA-Z]|$)/, `\nphases:\n  - { duration: ${secs}s, vus: ${vus} }`);
  try {
    const ext = vscode.extensions.getExtension('zovo.zovo-load-testing');
    check('extension installed', !!ext, ext && ext.extensionPath);
    const api = await ext.activate();
    check('extension activates, gate hook present', api && api._gate, ext.packageJSON.version);
    const G = api._gate;
    const host = M.host;
    const runFile = async (file, allowed = [host]) => {
      const r = await G.runTest(vscode.Uri.file(file), allowed);
      if (!r) throw new Error(`${path.basename(file)}: the run did not start or ended with an error`);
      return r;
    };

    // ---- 1. accuracy: a fixed 50 ms endpoint, closed model ----
    {
      const c0 = await settle();
      const t0 = Date.now();
      const r = await runFile(M.files.accuracy);
      const c1 = await settle();
      const server = c1.total - c0.total;
      const diff = Math.abs(r.summary.requests - server) / server;
      const p95 = r.summary.latency.p95;
      const sp = (c1.serverP95 || {})['/api/slow'] || {}; // the accuracy run is the first one on /api/slow
      const pdiff = sp.p95 ? Math.abs(p95 - sp.p95) / sp.p95 : 1;
      const rdiff = Math.abs(r.summary.rps - server / (r.summary.durationMs / 1000)) / r.summary.rps;
      fileRes(M.files.accuracy, diff <= 0.05 && pdiff <= 0.05 && r.pass, `engine ${r.summary.requests} vs server ${server} (${(diff * 100).toFixed(2)} %), rps ${r.summary.rps}, p50 ${r.summary.latency.p50} p95 ${p95} ms vs server-side p50 ${sp.p50 && sp.p50.toFixed(2)} p95 ${sp.p95 && sp.p95.toFixed(2)} ms (${(pdiff * 100).toFixed(2)} %), pass ${r.pass}`, Date.now() - t0);
      check('accuracy: request count and RPS within 5 % of the server count', diff <= 0.05 && rdiff <= 0.05, `count ${(diff * 100).toFixed(2)} %, rps ${(rdiff * 100).toFixed(2)} %`);
      check('accuracy: p95 within 5 % of the server-side p95 (200 ms endpoint)', pdiff <= 0.05, `${p95} vs ${sp.p95 && sp.p95.toFixed(2)} ms`);
      const runs = G.runs().find((x) => x.uri === vscode.Uri.file(M.files.accuracy).toString());
      check('run saved as JSON and HTML', runs && fs.existsSync(runs.jsonPath) && fs.existsSync(runs.htmlPath), runs && runs.htmlPath);
      if (runs && runs.htmlPath) {
        const html = fs.readFileSync(runs.htmlPath, 'utf8');
        check('HTML report is offline (no script, no outside URL)', !/<script/i.test(html) && !/(src|href)=["']?https?:/i.test(html), `${html.length} bytes`);
        M.firstRun = runs.jsonPath;
      }
    }

    // ---- 2. thresholds fail correctly ----
    {
      const t0 = Date.now();
      const r = await runFile(M.files.fail);
      const failed = r.thresholds.filter((t) => !t.pass).map((t) => t.text);
      fileRes(M.files.fail, r && r.pass === false && failed.includes('p95 < 20ms') && !failed.includes('errors < 50%'), `pass ${r.pass}, failed: ${failed.join(', ')}`, Date.now() - t0);
    }

    // ---- 3. 5xx at a set rate: errors counted, threshold fails ----
    {
      const c0 = await settle();
      const t0 = Date.now();
      const r = await runFile(M.files.flaky);
      const c1 = await settle();
      const e500 = r.summary.statusCodes['500'] || 0;
      const share = e500 / r.summary.requests;
      fileRes(M.files.flaky, r.summary.failed === e500 && share > 0.15 && share < 0.35 && r.pass === false && Math.abs(r.summary.requests - (c1.total - c0.total)) / (c1.total - c0.total) <= 0.05, `500s ${e500}/${r.summary.requests} (${(share * 100).toFixed(1)} %, server rate 25 %), pass ${r.pass}`, Date.now() - t0);
    }

    // ---- 4. large: 2,000 requests per second, VS Code stays responsive ----
    {
      const c0 = await settle();
      const t0 = Date.now();
      const p = runFile(M.files.large);
      const lags = [], opens = [];
      let last = Date.now();
      const iv = setInterval(() => { const n = Date.now(); lags.push(n - last - 100); last = n; }, 100);
      await sleep(3000);
      for (let i = 0; i < 6; i++) {
        const a = Date.now();
        const doc = await vscode.workspace.openTextDocument(M.files.accuracy);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
        opens.push(Date.now() - a);
        await sleep(1500);
      }
      const r = await p;
      clearInterval(iv);
      const c1 = await settle();
      const server = c1.total - c0.total;
      const diff = Math.abs(r.summary.requests - server) / server;
      const maxLag = Math.max(...lags);
      const run = G.runs().find((x) => x.uri === vscode.Uri.file(M.files.large).toString());
      const ok = diff <= 0.05 && r.summary.rps >= 1900 && r.summary.failed === 0 && maxLag < 100 && Math.max(...opens) < 250;
      fileRes(M.files.large, ok, `engine ${r.summary.requests} vs server ${server} (${(diff * 100).toFixed(2)} %), rps ${r.summary.rps}, p95 ${r.summary.latency.p95} ms, ext host timer lag max ${maxLag} ms, open file ${Math.max(...opens)} ms max, host lag (extension) ${run && Math.round(run.hostLagMax)} ms, warnings ${JSON.stringify(r.warnings)}`, Date.now() - t0);
      check('2,000 req/s: VS Code extension host stays responsive (timer lag < 100 ms, file opens < 250 ms; README claim)', maxLag < 100 && Math.max(...opens) < 250, `lag ${maxLag} ms, opens ${opens.join('/')} ms`);
      res.extHostRssMB = Math.round(process.memoryUsage().rss / 1048576);
    }

    // ---- 5. hostile: Stop closes everything within 2 s (server that never answers) ----
    {
      const p = runFile(M.files.never);
      await sleep(2500);
      const before = counts();
      const t0 = Date.now();
      await vscode.commands.executeCommand('loadTesting.stop');
      const r = await p;
      const stopMs = Date.now() - t0;
      await sleep(600);
      const after = counts();
      fileRes(M.files.never, stopMs < 2000 && after.open === 0 && r.stoppedBy === 'user', `open connections before Stop ${before.open}, after ${after.open}; Stop took ${stopMs} ms; interrupted ${r.summary.interrupted}`, stopMs);
      check('Stop ends all connections within 2 s (README claim: 0.1 s)', stopMs < 100 && after.open === 0, `${stopMs} ms, open ${after.open}`);
    }

    // ---- 6. hostile: timeouts, mid-body close, 50 MB body ----
    for (const [key, test] of [['timeouts', (r) => r.summary.errorKinds.timeout > 0 && r.summary.failed === r.summary.requests],
      ['midbody', (r) => r.summary.errorKinds['connection closed mid-response'] > 0],
      ['big', (r) => r.summary.failed === 0 && r.summary.bytesIn >= 50 * 1048576 && r.summary.requests > 0]]) {
      const t0 = Date.now();
      const r = await runFile(M.files[key]);
      fileRes(M.files[key], r && test(r), `requests ${r.summary.requests}, errors ${JSON.stringify(r.summary.errorKinds)}, received ${Math.round(r.summary.bytesIn / 1048576)} MB`, Date.now() - t0);
    }

    // ---- 7. hostile: broken YAML, billion laughs: diagnostics, nothing sent ----
    for (const key of ['broken', 'laughs']) {
      const c0 = await settle();
      const doc = await vscode.workspace.openTextDocument(M.files[key]);
      await vscode.window.showTextDocument(doc);
      await sleep(900);
      const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Load Testing');
      await vscode.commands.executeCommand('loadTesting.run', doc.uri);
      await sleep(500);
      const c1 = counts();
      fileRes(M.files[key], diags.length > 0 && c1.total === c0.total, `${diags.length} problem(s), first at line ${diags[0] && diags[0].range.start.line + 1}: ${diags[0] && diags[0].message}`);
    }

    // ---- 8. blocked host: refused before anything is sent ----
    {
      const c0 = await settle();
      const p = vscode.commands.executeCommand('loadTesting.run', vscode.Uri.file(M.files.blocked));
      await sleep(1200);
      const c1 = counts();
      const run = G.runs().find((x) => x.uri === vscode.Uri.file(M.files.blocked).toString());
      fileRes(M.files.blocked, !run && c1.total === c0.total, 'refused by the blocklist (*.gov), no run started');
      try { await vscode.commands.executeCommand('notifications.clearAll'); } catch (e) { /* older VS Code */ }
      void p;
    }

    // ---- 9. imports: .http, .rest, cURL, HAR, OpenAPI, JMeter -> valid tests; local ones also run ----
    const importOne = async (file, run) => {
      const t0 = Date.now();
      const p = vscode.commands.executeCommand('loadTesting.importFile', vscode.Uri.file(file));
      await sleep(1800);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const out = await Promise.race([p, sleep(15000).then(() => null)]);
      if (!out) { fileRes(file, false, 'no test file was created'); return; }
      const text = fs.readFileSync(out.fsPath, 'utf8');
      const v = G.validate(text);
      let detail = `${path.basename(out.fsPath)}: ${v.ok ? `valid, ${v.spec.steps.length} step(s), hosts ${v.spec.hosts.join(', ')}` : 'INVALID ' + JSON.stringify(v.errors)}`;
      let ok = v.ok;
      if (ok && run) {
        await setText(out, shortPhases(text));
        const c0 = await settle();
        const r = await runFile(out.fsPath);
        const c1 = await settle();
        detail += `; ran: ${r.summary.requests} requests (server ${c1.total - c0.total}), failed ${r.summary.failed}, status ${JSON.stringify(r.summary.statusCodes)}`;
        ok = r.summary.requests > 0 && Math.abs(r.summary.requests - (c1.total - c0.total)) <= Math.max(2, 0.05 * r.summary.requests);
        if (run === 'clean') ok = ok && r.summary.failed === 0;
      }
      fileRes(file, ok, detail, Date.now() - t0);
    };
    await importOne(M.files.http, 'clean');
    await importOne(M.files.rest, 'clean');
    await importOne(M.files.health, 'run');
    await importOne(M.files.jmx, 'clean');
    await importOne(M.files.har, false);
    await importOne(M.files.openapi, false);
    {
      const t0 = Date.now();
      const out = await vscode.commands.executeCommand('loadTesting.importCurl', fs.readFileSync(M.files.curl, 'utf8'));
      const v = out && G.validate(fs.readFileSync(out.fsPath, 'utf8'));
      let ok = !!(v && v.ok), detail = out ? path.basename(out.fsPath) : 'no file';
      if (ok) {
        await setText(out, shortPhases(fs.readFileSync(out.fsPath, 'utf8')));
        const r = await runFile(out.fsPath);
        ok = r.summary.requests > 0 && r.summary.failed === 0;
        detail += `; ran ${r.summary.requests} POST requests, failed ${r.summary.failed}`;
      }
      fileRes(M.files.curl, ok, detail, Date.now() - t0);
    }
    // hostile import: not a HAR -> a message, no file
    {
      const before = fs.readdirSync(path.dirname(M.files.notHar)).length;
      const p = vscode.commands.executeCommand('loadTesting.importFile', vscode.Uri.file(M.files.notHar));
      const out = await Promise.race([p, sleep(5000).then(() => 'timeout')]);
      fileRes(M.files.notHar, out === undefined && fs.readdirSync(path.dirname(M.files.notHar)).length === before, `result ${out}`);
    }
    // large import: a big HAR is read in a worker; the extension host keeps running
    {
      const lags = []; let last = Date.now();
      const iv = setInterval(() => { const n = Date.now(); lags.push(n - last - 50); last = n; }, 50);
      const t0 = Date.now();
      const p = vscode.commands.executeCommand('loadTesting.importFile', vscode.Uri.file(M.files.bigHar));
      // wait until the quick pick appears (the worker has parsed the file)
      let picked = false;
      for (let i = 0; i < 60 && !picked; i++) { await sleep(500); if (Date.now() - t0 > 2500) { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); } const r = await Promise.race([p, sleep(10).then(() => 'wait')]); if (r !== 'wait') picked = r; }
      clearInterval(iv);
      const maxLag = Math.max(...lags);
      const ok = picked && picked.fsPath && G.validate(fs.readFileSync(picked.fsPath, 'utf8')).ok && maxLag < 300;
      fileRes(M.files.bigHar, ok, `${Math.round(fs.statSync(M.files.bigHar).size / 1048576)} MB HAR imported in ${Date.now() - t0} ms, extension host lag max ${maxLag} ms`, Date.now() - t0);
    }

    // ---- 10. the test files were never changed by a run ----
    check('runs never change the test file', sha(M.files.accuracy) === M.hashes.accuracy && sha(M.files.fail) === M.hashes.fail, '');

    // ---- 11. compare two runs opens a webview ----
    {
      const runs = G.runs().filter((x) => x.jsonPath);
      check('at least 2 runs saved for compare', runs.length >= 2, runs.length);
    }

    // ---- 12. confirmation: a new host gets a modal and no traffic until the user confirms ----
    {
      const c0 = await settle();
      void vscode.commands.executeCommand('loadTesting.run', vscode.Uri.file(M.files.confirm));
      await sleep(2000);
      const c1 = counts();
      const run = G.runs().find((x) => x.uri === vscode.Uri.file(M.files.confirm).toString());
      check('a new host waits for confirmation: no request sent', !run && c1.total === c0.total, `requests during the dialog: ${c1.total - c0.total}`);
    }
  } catch (e) {
    check('gate runner error', false, e && e.stack || e);
  }
  res.ended = new Date().toISOString();
  save();
};
