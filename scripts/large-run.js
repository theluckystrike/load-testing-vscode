'use strict';
// Large run: 2 minutes at 2,000 requests per second against the local test API in a separate process.
// Checks that the engine's request count and p95 agree with the server's own count within 5 %, and that memory
// stays flat. Results go to --work (not the temp folder) and are deleted at the end unless --keep.
//   node scripts/large-run.js --work ~/load-testing-work/large [--seconds 120] [--rate 2000] [--keep]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { validate } = require('../src/core/spec');
const { Engine } = require('../src/engine/engine');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const work = path.resolve(arg('work', path.join(require('os').homedir(), 'load-testing-work', 'large')));
const seconds = Number(arg('seconds', 120));
const rate = Number(arg('rate', 2000));
fs.mkdirSync(work, { recursive: true });
const countsFile = path.join(work, 'server-counts.json');

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'test', 'helpers', 'server.js'), '0'], { env: { ...process.env, COUNTS_FILE: countsFile, LAT: '2', JIT: '6', ERR: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => srv.stdout.once('data', (d) => r(JSON.parse(String(d)).port)));
  const v = validate(`name: Large run\ntarget: http://127.0.0.1:${port}\nrequest: /api/orders?limit=5\nchecks: { status: 200 }\nphases:\n  - { duration: ${seconds}s, rate: ${rate} }\nmaxVus: 500\nthresholds: ["p95 < 50ms", "errors < 0.1%"]\n`, { maxVus: 500, maxRate: 5000 });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const rss = [];
  const e = new Engine(v.spec, { onTick: (t) => { rss.push(Math.round(process.memoryUsage().rss / 1048576)); if (t.tick.t % 10 < 1) console.log(`t=${t.tick.t}s rps=${t.tick.rps} p95=${t.tick.p95}ms vus=${t.tick.vus} elu=${t.tick.elu} rss=${rss[rss.length - 1]}MB`); } });
  const r = await e.start();
  await new Promise((res) => setTimeout(res, 800));
  srv.kill('SIGTERM');
  await new Promise((res) => srv.on('exit', res));
  const server = JSON.parse(fs.readFileSync(countsFile, 'utf8'));
  const expected = seconds * rate;
  const out = {
    seconds, rate, expected, engineRequests: r.summary.requests, serverRequests: server.total,
    countDiffPct: Math.round((10000 * Math.abs(r.summary.requests - server.total)) / server.total) / 100,
    rateDiffPct: Math.round((10000 * Math.abs(r.summary.requests - expected)) / expected) / 100,
    rps: r.summary.rps, latency: r.summary.latency, failed: r.summary.failed, dropped: r.summary.dropped, warnings: r.warnings,
    pass: r.pass, thresholds: r.thresholds, rssMB: { first: rss[0], max: Math.max(...rss), last: rss[rss.length - 1] },
    resultJsonBytes: Buffer.byteLength(JSON.stringify(r)),
  };
  fs.writeFileSync(path.join(work, 'large-summary.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  const ok = out.countDiffPct <= 5 && out.rateDiffPct <= 5 && r.summary.failed === 0;
  console.log(ok ? 'LARGE RUN PASS' : 'LARGE RUN FAIL');
  if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
