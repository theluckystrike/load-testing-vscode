// Release gate in a real VS Code: installs the .vsix into a private profile, starts the local test API (a separate
// process on 127.0.0.1), writes the gate files (tests, real import files, a 2,000 req/s test, a large HAR and
// hostile files), runs scripts/gate/runner.js inside VS Code and prints a summary. No outside host is contacted.
//
//   node scripts/gate-vscode.mjs --vsix dist/x.vsix --work ~/load-testing-work/gate [--code ".../Code"] [--keep]
//
// Large and hostile files are written under --work (not the temp folder) and deleted at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const CODE = arg('code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code');
const CLI = path.join(path.dirname(path.dirname(CODE)), 'Resources/app/bin/code');
const keep = process.argv.includes('--keep');

fs.rmSync(work, { recursive: true, force: true });
const files = path.join(work, 'files');
fs.mkdirSync(files, { recursive: true });
const countsFile = path.join(work, 'server-counts.json');

// ---- local test API in its own process ----
const srv = spawn(process.execPath, [path.join(root, 'test/helpers/server.js'), '0'], { env: { ...process.env, COUNTS_FILE: countsFile, LAT: '2', JIT: '6', ERR: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((r) => srv.stdout.once('data', (d) => r(JSON.parse(String(d)).port)));
const host = `127.0.0.1:${port}`;
const T = `http://${host}`;
console.log('test API on', T);

const write = (name, text) => { const p = path.join(files, name); fs.writeFileSync(p, text); return p; };
const fx = (n) => fs.readFileSync(path.join(root, 'test/fixtures', n), 'utf8').replace(/127\.0\.0\.1:3000/g, host).replace(/(name="HTTPSampler\.port">)3000</g, `$1${port}<`);
const F = {
  accuracy: write('accuracy.load.yaml', `name: Accuracy (server waits 200 ms)\ntarget: ${T}\nrequest: /api/slow?ms=200\nchecks: { status: 200 }\nphases:\n  - { name: ramp-up, duration: 2s, vus: [1, 40] }\n  - { name: steady, duration: 8s, vus: 40 }\nthresholds:\n  - p95 < 300ms\n  - errors < 1%\n`),
  fail: write('fail.load.yaml', `name: Too slow on purpose\ntarget: ${T}\nrequest: /api/slow?ms=40\nvus: 5\nduration: 3s\nthresholds: ["p95 < 20ms", "errors < 50%"]\n`),
  flaky: write('flaky-25pct-5xx.load.yaml', `name: 25 % server errors\ntarget: ${T}\nrequest: /api/flaky?rate=0.25\nchecks: { status: 200 }\nvus: 10\nduration: 4s\nthresholds: ["errors < 1%"]\n`),
  large: write('large-2000rps.load.yaml', `name: 2,000 requests per second\ntarget: ${T}\nrequest: /api/orders?limit=5\nchecks: { status: 200 }\nphases:\n  - { duration: 20s, rate: 2000 }\nmaxVus: 200\nthresholds: ["p95 < 100ms", "errors < 0.1%"]\n`),
  never: write('hostile-never-answers-stop.load.yaml', `name: Server never answers (Stop test)\ntarget: ${T}\nrequest: /api/never\nvus: 100\nduration: 60s\ntimeout: 60s\n`),
  timeouts: write('hostile-timeouts.load.yaml', `name: Timeouts\ntarget: ${T}\nrequest: /api/never\nvus: 5\nduration: 2s\ntimeout: 500ms\n`),
  midbody: write('hostile-midbody-close.load.yaml', `name: Connection closed mid-body\ntarget: ${T}\nrequest: /api/midbody\nvus: 3\nduration: 2s\n`),
  big: write('hostile-50mb-body.load.yaml', `name: 50 MB responses\ntarget: ${T}\nrequest: /api/big?mb=50\nchecks: { bodyContains: aaaa }\nvus: 2\nduration: 2s\ntimeout: 30s\nmaxBodyKB: 64\n`),
  broken: write('hostile-broken-syntax.load.yaml', `name: Broken\ntarget: ${T}\nrequest:\n  url: /api/health\n  headers: { a: [1, 2\nphases: [\n`),
  laughs: write('hostile-billion-laughs.load.yaml', fs.readFileSync(path.join(root, 'test/fixtures/hostile-billion-laughs.yaml'), 'utf8')),
  blocked: write('blocked-host.load.yaml', `name: Blocked host\ntarget: http://api.example.gov\nrequest: /status\nvus: 1\nduration: 2s\n`),
  confirm: write('new-host-confirm.load.yaml', `name: New host\ntarget: http://localhost:${port}\nrequest: /api/health\nvus: 1\nduration: 2s\n`),
  http: write('orders.http', fx('orders.http')),
  rest: write('login-flow.rest', fx('login-flow.rest')),
  health: write('health.http', fx('health.http')),
  jmx: write('checkout.jmx', fx('checkout.jmx')),
  curl: write('curl-post.txt', fx('curl-post.txt')),
  har: write('shop-checkout.har', fx('shop-checkout.har')),
  openapi: write('petstore-3.0.yaml', fx('petstore-3.0.yaml')),
  notHar: write('not-a-har.har', fx('not-a-har.har')),
};
// Large HAR: 30,000 API entries with 2 KB response bodies (about 60 MB).
{
  const p = path.join(files, 'large-60mb.har');
  const fd = fs.openSync(p, 'w');
  fs.writeSync(fd, '{"log":{"version":"1.2","creator":{"name":"gate","version":"1"},"entries":[');
  const body = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, sku: 'SKU-' + i, note: 'x'.repeat(20) })) });
  for (let i = 0; i < 30000; i++) {
    const e = { startedDateTime: new Date(1762650000000 + i * 10).toISOString(), time: 12, _resourceType: 'fetch',
      request: { method: 'GET', url: `${T}/api/orders?limit=${(i % 20) + 1}&page=${i}`, httpVersion: 'HTTP/1.1', headers: [{ name: 'accept', value: 'application/json' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: body.length, mimeType: 'application/json', text: body }, redirectURL: '', headersSize: -1, bodySize: body.length },
      cache: {}, timings: { send: 1, wait: 10, receive: 1 } };
    fs.writeSync(fd, (i ? ',' : '') + JSON.stringify(e));
  }
  fs.writeSync(fd, ']}}');
  fs.closeSync(fd);
  F.bigHar = p;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { host, countsFile, files: F, hashes: { accuracy: sha(F.accuracy), fail: sha(F.fail) } };
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`gate files: ${Object.keys(F).length} (large: large-2000rps, large-60mb.har ${Math.round(fs.statSync(F.bigHar).size / 1048576)} MB)`);

// ---- install the vsix in a private profile ----
const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'git.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'loadTesting.askForRating': false,
}, null, 1));
const inst = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000 });
console.log('install:', (inst.stdout + inst.stderr).trim().split('\n').pop());
const installed = fs.readdirSync(ext).find((d) => d.startsWith('zovo.zovo-load-testing-'));
if (!installed) { console.error('not installed'); srv.kill(); process.exit(2); }

// ---- run the in-editor checks ----
const out = path.join(work, 'results.json');
const t0 = Date.now();
const child = spawn(CODE, ['--user-data-dir', ud, '--extensions-dir', ext, '--disable-workspace-trust', '--skip-welcome', '--new-window',
  `--extensionDevelopmentPath=${path.join(ext, installed)}`, `--extensionTestsPath=${path.join(root, 'scripts/gate/runner.js')}`, files],
{ stdio: 'ignore', env: { ...process.env, ZOVO_LOAD_GATE: '1', GATE_MANIFEST: path.join(work, 'manifest.json'), GATE_OUT: out } });
const timer = setTimeout(() => { console.error('gate timeout, killing VS Code'); child.kill('SIGKILL'); }, 10 * 60 * 1000);
await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
srv.kill('SIGTERM');
let res;
try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { console.error('no results'); process.exit(2); }
let pass = 0, fail = 0;
console.log(`VS Code ${res.vscode} ${res.platform}-${res.arch}, ${Math.round((Date.now() - t0) / 1000)} s, extension host RSS ${res.extHostRssMB} MB`);
for (const f of res.files) { f.ok ? pass++ : fail++; console.log(`${f.ok ? 'PASS' : 'FAIL'} file  ${f.file.padEnd(36)} ${String(f.ms).padStart(6)} ms  ${f.detail}`); }
for (const c of res.checks) { c.ok ? pass++ : fail++; console.log(`${c.ok ? 'PASS' : 'FAIL'} check ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
console.log(`gate: ${pass} pass, ${fail} fail, ${res.files.length} files`);
fs.writeFileSync(path.join(work, 'summary.txt'), `pass ${pass} fail ${fail}\n`);
// Teardown: the large file and the profile go (the profile only without --keep).
fs.rmSync(F.bigHar, { force: true });
for (const d of fs.readdirSync(files)) if (d === 'load-test-results') fs.rmSync(path.join(files, d), { recursive: true, force: true });
if (!keep) { fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); }
process.exit(fail ? 1 : 0);
