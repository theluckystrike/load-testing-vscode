'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHttp } = require('./helpers/server');
const { validate } = require('../src/core/spec');
const { Engine } = require('../src/engine/engine');
const R = require('../src/core/report');

let a, b;
test.before(async () => {
  const s = await startHttp({ latencyMs: 3, jitterMs: 3 });
  const spec = (lat) => validate(`name: "Report <test> & co"\ntarget: ${s.url}\nrequest: /api/slow?ms=${lat}\nchecks: { status: 200 }\nvus: 4\nduration: 1s\nthresholds: ["p95 < 150ms"]\n`, { maxVus: 50 }).spec;
  a = await new Engine(spec(1)).start();
  b = await new Engine(spec(400)).start();
  await s.close();
});

test('HTML report: no script, nothing loaded from outside, text escaped, both themes', () => {
  const html = R.htmlReport(a);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/(src|href)=["']?https?:/i.test(html), 'no outside resource');
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('Report &lt;test&gt; &amp; co'));
  assert.ok(!html.includes('Report <test>'));
  assert.ok(html.includes('prefers-color-scheme:dark'));
  assert.ok(html.includes('<svg'));
  assert.ok(/PASSED|FAILED/.test(html));
});

test('compare: deltas and which run is better', () => {
  const rows = R.compareRows(a, b);
  const p95 = rows.find((r) => r.metric === 'p95 (ms)');
  assert.ok(p95.b > p95.a);
  assert.equal(p95.better, 'a', 'B is slower, so A is better');
  const rps = rows.find((r) => r.metric === 'Requests/s');
  assert.equal(rps.better, 'a');
  const html = R.compareHtml(a, b);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('Compare two load test runs'));
});

test('history and run file checks', () => {
  const html = R.historyHtml([a, b]);
  assert.ok(html.includes('2 runs'));
  assert.ok(R.isRun(JSON.parse(JSON.stringify(a))));
  assert.ok(!R.isRun({ v: 1 }));
  assert.ok(!R.isRun(null));
  assert.match(R.fileStem('My API: smoke!', new Date(2026, 10, 9, 8, 5, 3)), /^my-api-smoke-20261109-080503$/);
});

test('the thresholds of a slow run fail and a fast run pass', () => {
  assert.equal(a.pass, true, JSON.stringify(a.thresholds));
  assert.equal(b.pass, false);
});
