'use strict';
// The load engine against local servers on 127.0.0.1 only. No outside host is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startHttp, startHttps } = require('./helpers/server');
const { validate } = require('../src/core/spec');
const { Engine, arrivalsUntil, phaseAt, classify } = require('../src/engine/engine');

const WORK = path.join(os.homedir(), 'load-testing-work', 'unit');

function specOf(text, limits = { maxVus: 500 }) {
  const v = validate(text, limits);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.spec;
}

async function run(text, opts = {}) {
  const e = new Engine(specOf(text), opts);
  const r = await e.start();
  return { r, e };
}

test('open model: the engine count matches the server count and the rate is kept', async () => {
  const s = await startHttp({ latencyMs: 2, jitterMs: 4 });
  try {
    const { r } = await run(`target: ${s.url}\nrequest: /api/orders\nphases:\n  - { duration: 4s, rate: 300 }\n`);
    const server = s.counts.total;
    assert.ok(Math.abs(r.summary.requests - server) / server <= 0.05, `engine ${r.summary.requests} vs server ${server}`);
    assert.ok(Math.abs(r.summary.requests - 1200) <= 60, `about 1200 requests, got ${r.summary.requests}`);
    assert.equal(r.summary.failed, 0);
    assert.equal(r.stoppedBy, 'end');
    assert.ok(r.timeline.length >= 4);
  } finally { await s.close(); }
});

test('closed model: users ramp, latency percentiles follow the server delay', async () => {
  const s = await startHttp({ latencyMs: 20, jitterMs: 0 });
  try {
    const { r } = await run(`target: ${s.url}\nrequest: /api/orders\nphases:\n  - { duration: 1s, vus: [1, 10] }\n  - { duration: 2s, vus: 10 }\n`);
    assert.equal(r.summary.peakVus, 10);
    assert.ok(r.summary.latency.p50 >= 19 && r.summary.latency.p50 < 60, `p50 ${r.summary.latency.p50}`);
    assert.ok(r.summary.latency.p95 >= r.summary.latency.p50);
    assert.ok(Math.abs(r.summary.requests - s.counts.total) / s.counts.total <= 0.05);
    // 10 users with ~20 ms each: about 400 req/s at most
    assert.ok(r.summary.rps > 100 && r.summary.rps < 520, `rps ${r.summary.rps}`);
  } finally { await s.close(); }
});

test('thresholds pass and fail correctly', async () => {
  const s = await startHttp({ latencyMs: 30, jitterMs: 0 });
  try {
    const ok = (await run(`target: ${s.url}\nrequest: /api/orders\nvus: 4\nduration: 1s\nthresholds: ["p95 < 500ms", "errors < 1%", "rps > 10"]\n`)).r;
    assert.equal(ok.pass, true, JSON.stringify(ok.thresholds));
    const bad = (await run(`target: ${s.url}\nrequest: /api/orders\nvus: 4\nduration: 1s\nthresholds: ["p95 < 10ms", "errors < 1%"]\n`)).r;
    assert.equal(bad.pass, false);
    assert.equal(bad.thresholds[0].pass, false);
    assert.equal(bad.thresholds[1].pass, true);
  } finally { await s.close(); }
});

test('5xx responses count as failures; checks count separately', async () => {
  const s = await startHttp({ latencyMs: 1, errorRate: 0.3 });
  try {
    const { r } = await run(`target: ${s.url}\nrequest: /api/orders\nchecks: { status: 200, bodyContains: '"ok"' }\nvus: 5\nduration: 1s\nthresholds: ["errors < 1%"]\n`);
    const e500 = r.summary.statusCodes['500'] || 0;
    assert.ok(e500 > 0);
    assert.equal(r.summary.failed, e500);
    assert.equal(r.summary.errorKinds['HTTP 500'], e500);
    const st = r.summary.checks.find((c) => c.name.startsWith('status'));
    assert.equal(st.failed, e500);
    assert.equal(r.pass, false);
  } finally { await s.close(); }
});

test('hostile: a server that never answers gives timeouts, and the run still ends on time', async () => {
  const s = await startHttp();
  try {
    const t0 = Date.now();
    const { r } = await run(`target: ${s.url}\nrequest: /api/never\nvus: 3\nduration: 1s\ntimeout: 300ms\n`);
    assert.ok(r.summary.errorKinds.timeout >= 3, JSON.stringify(r.summary.errorKinds));
    assert.equal(r.summary.failed, r.summary.requests);
    assert.ok(Date.now() - t0 < 4000);
  } finally { await s.close(); }
});

test('hostile: a connection closed mid-body is an error, not a hang', async () => {
  const s = await startHttp();
  try {
    const { r } = await run(`target: ${s.url}\nrequest: /api/midbody\nvus: 2\nduration: 1s\ntimeout: 2s\n`);
    assert.ok(r.summary.requests > 0);
    assert.equal(r.summary.failed, r.summary.requests);
    assert.ok(r.summary.errorKinds['connection closed mid-response'] > 0, JSON.stringify(r.summary.errorKinds));
  } finally { await s.close(); }
});

test('hostile: a 50 MB response is read and counted, but only maxBodyKB is kept in memory', async () => {
  const s = await startHttp();
  try {
    const before = process.memoryUsage().rss;
    const { r } = await run(`target: ${s.url}\nrequest: /api/big?mb=50\nchecks: { bodyContains: aaa }\nvus: 2\nduration: 1s\ntimeout: 30s\nmaxBodyKB: 64\n`);
    assert.ok(r.summary.requests >= 2);
    assert.equal(r.summary.failed, 0);
    assert.equal(r.summary.bytesIn, r.summary.requests * 50 * 1048576);
    assert.ok(r.summary.checks[0].passed >= 2);
    assert.ok(process.memoryUsage().rss - before < 300 * 1048576, 'memory stays bounded');
  } finally { await s.close(); }
});

test('hostile: an invalid TLS certificate fails by default and works only with insecure: true', async (t) => {
  fs.mkdirSync(WORK, { recursive: true });
  const key = path.join(WORK, 'key.pem'), cert = path.join(WORK, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch (e) { t.skip('openssl not available'); return; }
  const s = await startHttps({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  try {
    const bad = (await run(`target: ${s.url}\nrequest: /api/health\nvus: 1\nduration: 500ms\n`)).r;
    assert.ok(bad.summary.errorKinds['TLS certificate not trusted'] > 0, JSON.stringify(bad.summary.errorKinds));
    assert.equal(bad.summary.statusCodes['200'], undefined);
    const ok = (await run(`target: ${s.url}\nrequest: /api/health\nvus: 1\nduration: 500ms\ninsecure: true\n`)).r;
    assert.ok(ok.summary.statusCodes['200'] > 0);
    assert.equal(ok.summary.failed, 0);
  } finally { await s.close(); fs.rmSync(WORK, { recursive: true, force: true }); }
});

test('connection refused is reported as such', async () => {
  const s = await startHttp();
  const url = s.url; await s.close();
  const { r } = await run(`target: ${url}\nrequest: /api/health\nvus: 1\nduration: 300ms\n`);
  assert.ok(r.summary.errorKinds['connection refused'] > 0, JSON.stringify(r.summary.errorKinds));
});

test('Stop ends every connection within 2 s, even with requests that never answer', async () => {
  const s = await startHttp();
  try {
    const e = new Engine(specOf(`target: ${s.url}\nrequest: /api/never\nvus: 50\nduration: 60s\ntimeout: 60s\n`));
    const done = e.start();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(e.inflight.size >= 40, `in flight ${e.inflight.size}`);
    const t0 = Date.now();
    e.stop();
    const r = await done;
    assert.ok(Date.now() - t0 < 2000, `stopped in ${Date.now() - t0} ms`);
    assert.equal(e.inflight.size, 0);
    assert.equal(r.stoppedBy, 'user');
    assert.ok(r.summary.interrupted >= 40);
    await new Promise((res) => setTimeout(res, 200));
    const conns = await new Promise((res) => s.server.getConnections((err, n) => res(n)));
    assert.equal(conns, 0, 'the server sees no open connection');
  } finally { await s.close(); }
});

test('a host that was not confirmed never receives a request', async () => {
  const s = await startHttp();
  try {
    const { r } = await run(`target: ${s.url}\nrequest: /api/health\nvus: 1\nduration: 300ms\n`, { allowedHosts: ['example.invalid'] });
    assert.equal(s.counts.total, 0);
    assert.ok(r.summary.errorKinds['host not allowed'] > 0);
  } finally { await s.close(); }
});

test('multi-step scenario: extract a token, use it in the next step, rows from a CSV', async () => {
  const s = await startHttp();
  try {
    const rows = [{ user: 'ada' }, { user: 'grace' }, { user: 'linus' }];
    const text = `target: ${s.url}
steps:
  - name: login
    request: { method: POST, url: /api/login, json: { user: "{{user}}" } }
    extract: { token: $.token }
    checks: { status: 200 }
  - name: me
    request: { url: /api/me, headers: { authorization: "Bearer {{token}}" } }
    checks: { status: 200, jsonPath: { "$.me": true } }
vus: 3
duration: 2s
timeout: 30s
`;
    const { r } = await run(text, { rows });
    assert.equal(r.summary.failed, 0, JSON.stringify(r.summary.errorKinds));
    assert.ok(s.counts.byPath['/api/me'] > 3);
    for (const c of r.summary.checks) assert.equal(c.failed, 0, c.name);
    assert.ok(r.summary.checks.some((c) => c.name.startsWith('me: ')));
  } finally { await s.close(); }
});

test('ramp math: phaseAt and arrivalsUntil', () => {
  const phases = [{ name: 'a', durationMs: 10000, from: 0, to: 100 }, { name: 'b', durationMs: 10000, from: 100, to: 100 }];
  assert.equal(phaseAt(phases, 5000).value, 50);
  assert.equal(phaseAt(phases, 15000).name, 'b');
  assert.equal(Math.round(arrivalsUntil(phases, 10000)), 500);
  assert.equal(Math.round(arrivalsUntil(phases, 20000)), 1500);
});

test('error classes', () => {
  assert.equal(classify({ code: 'ECONNREFUSED' }), 'connection refused');
  assert.equal(classify({ code: 'ENOTFOUND' }), 'DNS lookup failed');
  assert.equal(classify({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), 'TLS certificate not trusted');
  assert.equal(classify({ code: 'HPE_INVALID_CONSTANT' }), 'invalid HTTP response');
});
