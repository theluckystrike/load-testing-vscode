// README and walkthrough screenshots from a real VS Code with the packaged extension installed, against the local
// test API (a separate process on 127.0.0.1). Nothing outside this computer is contacted.
//   node scripts/shots.mjs --vsix dist/x.vsix --work ~/load-testing-work/shots --port 9263 [--theme "Default Light Modern"] [--prefix light-]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { installVsix, launch, sleep } from './vsc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const port = Number(arg('port', 9263));
const theme = arg('theme', 'Default Dark Modern');
const outDir = path.resolve(arg('out', path.join(root, 'images')));
const prefix = arg('prefix', 'dark-');
const fresh = !process.argv.includes('--reuse');

if (fresh) fs.rmSync(work, { recursive: true, force: true });
const demo = path.join(work, 'shop-api');
fs.mkdirSync(path.join(demo, 'tests'), { recursive: true });

const srv = spawn(process.execPath, [path.join(root, 'test/helpers/server.js'), '0'], { env: { ...process.env, LAT: '9', JIT: '22', ERR: '0.003' }, stdio: ['ignore', 'pipe', 'inherit'] });
const apiPort = await new Promise((r) => srv.stdout.once('data', (d) => r(JSON.parse(String(d)).port)));
const testFile = path.join(demo, 'tests', 'checkout.load.yaml');
fs.writeFileSync(testFile, `# Checkout API: ramp to 30 users, hold, ramp down.
name: Checkout API
target: http://localhost:${apiPort}
request:
  method: GET
  url: /api/orders?limit=20
  headers:
    accept: application/json
checks:
  status: 200
  jsonPath:
    $.status: ok
phases:
  - { name: ramp-up, duration: 5s, vus: [1, 30] }
  - { name: steady, duration: 20s, vus: 30 }
  - { name: ramp-down, duration: 5s, vus: [30, 0] }
thinkTime: [5ms, 25ms]
thresholds:
  - p95 < 100ms
  - errors < 1%
  - checks > 99%
`);
fs.copyFileSync(path.join(root, 'test/fixtures/orders.http'), path.join(demo, 'orders.http'));

if (fresh) { const inst = installVsix(work, vsix); if (inst.code !== 0) { console.error(inst.out); srv.kill(); process.exit(2); } }
const vs = await launch(work, port, demo, {
  'workbench.colorTheme': theme, 'editor.fontSize': 13, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.commandCenter.enabled': false,
  'editor.minimap.enabled': false, 'breadcrumbs.enabled': false, 'workbench.editor.enablePreview': false, 'loadTesting.askForRating': false,
  'workbench.layoutControl.enabled': false, 'window.dialogStyle': 'custom',
});
const errors = [];
const clickButton = async (text) => {
  const r = await vs.wbEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button, .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return ''; b.click(); return 'ok'; })()`);
  return r === 'ok';
};
const dialogText = () => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d ? d.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
try {
  await sleep(4000);
  vs.open(testFile);
  await sleep(2500);
  const aux = await vs.wbEval(`(() => { const a = document.querySelector('.part.auxiliarybar'); return !!(a && a.offsetWidth > 0); })()`);
  if (aux) { await vs.command('View: Toggle Secondary Side Bar Visibility'); await sleep(800); }
  await vs.command('View: Close Primary Side Bar');
  await sleep(600);
  // Click the "Run load test" CodeLens above line 1, as a user would.
  const lens = await vs.wbEval(`(() => { const a = [...document.querySelectorAll('.codelens-decoration a')].find(x => /Run load test/.test(x.textContent)); if (!a) return ''; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`);
  if (lens) { const b = JSON.parse(lens); await vs.click(b.x, b.y); } else { errors.push('CodeLens not found'); await vs.command('Load Testing: Run Load Test'); }
  const dlg = await vs.waitFor(async () => (await dialogText()) || '', 8000);
  console.log('notifications:', JSON.stringify(await vs.notifications()).slice(0, 400));
  console.log('dialog:', dlg ? dlg.slice(0, 200) : '(none: host remembered)');
  if (dlg) {
    await vs.shot(path.join(outDir, prefix + 'confirm.png'));
    if (!(await clickButton('Run and Remember Host'))) errors.push('confirm button not found');
  }
  await sleep(14000);
  await vs.shot(path.join(outDir, prefix + 'running.png'));
  // wait for the end of the run (30 s of phases)
  const done = await vs.waitFor(async () => {
    const wv = await vs.webview();
    if (!wv) return false;
    const r = await vs.s.send('Runtime.evaluate', { expression: `(document.getElementById('pill')||{}).textContent || ''`, contextId: wv.cid, returnByValue: true }, wv.sid);
    return /Passed|Failed|Finished/.test(r.result.value) ? r.result.value : false;
  }, 40000, 500);
  console.log('result pill:', done);
  if (!done) errors.push('run did not finish');
  await sleep(1500);
  await vs.shot(path.join(outDir, prefix + 'dashboard.png'));
  const extErr = vs.console.filter((c) => /zovo|load/i.test(c.where + c.text) && c.type !== 'warning');
  console.log('console errors from the extension:', extErr.length, extErr.slice(0, 3));
  const reports = path.join(demo, 'tests', 'load-test-results');
  console.log('saved:', fs.existsSync(reports) ? fs.readdirSync(reports) : []);
} catch (e) {
  errors.push(String(e && e.stack || e));
} finally {
  await vs.close();
  srv.kill('SIGTERM');
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('shots in', outDir);
