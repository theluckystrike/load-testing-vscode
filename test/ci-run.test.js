'use strict';
// The CI runner: exit code 0 on pass, 1 on a failed threshold, 2 on a broken file. Local server only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startHttp } = require('./helpers/server');

const WORK = path.join(os.homedir(), 'load-testing-work', 'ci-unit');
const run = (f) => new Promise((r) => execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'ci-run.js'), f, '--out', path.join(WORK, 'out')], (e, out, err) => r({ code: e ? e.code : 0, out, err })));

test('ci-run: pass, fail and broken files', async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const s = await startHttp({ latencyMs: 2 });
  try {
    fs.writeFileSync(path.join(WORK, 'ok.load.yaml'), `target: ${s.url}\nrequest: /api/orders\nvus: 2\nduration: 1s\nthresholds: ["errors < 1%"]\n`);
    fs.writeFileSync(path.join(WORK, 'bad.load.yaml'), `target: ${s.url}\nrequest: /api/slow?ms=30\nvus: 2\nduration: 1s\nthresholds: ["p95 < 5ms"]\n`);
    fs.writeFileSync(path.join(WORK, 'broken.load.yaml'), `request: [\n`);
    const ok = await run(path.join(WORK, 'ok.load.yaml'));
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /pass {2}errors < 1%/);
    assert.equal((await run(path.join(WORK, 'bad.load.yaml'))).code, 1);
    assert.equal((await run(path.join(WORK, 'broken.load.yaml'))).code, 2);
    assert.ok(fs.readdirSync(path.join(WORK, 'out')).some((f) => f.endsWith('.html')));
  } finally { await s.close(); fs.rmSync(WORK, { recursive: true, force: true }); }
});
