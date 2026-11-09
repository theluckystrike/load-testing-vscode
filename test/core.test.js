'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate, parseDuration, fmtDuration, example } = require('../src/core/spec');
const { parseThreshold, evaluate } = require('../src/core/thresholds');
const { Histogram, indexOf, valueOf } = require('../src/core/histogram');
const jsonpath = require('../src/core/jsonpath');
const { render } = require('../src/core/template');
const { parseCsv } = require('../src/core/csv');
const { blockedBy, matchPattern, isLocal } = require('../src/core/safety');

const L = { maxVus: 200, maxRate: 5000, maxDurationMs: 3600000 };

test('the example test is valid and normalized', () => {
  const v = validate(example('http://localhost:3000'), L);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.spec.model, 'closed');
  assert.equal(v.spec.maxVus, 20);
  assert.equal(v.spec.totalMs, 45000);
  assert.deepEqual(v.spec.hosts, ['localhost:3000']);
  assert.equal(v.spec.steps[0].url, 'http://localhost:3000/api/orders?limit=20');
  assert.deepEqual(v.spec.thresholds.map((t) => t.metric), ['p95', 'errors']);
  assert.deepEqual(v.spec.pro, []);
});

test('errors carry line numbers', () => {
  const v = validate('name: x\nrequest:\n  url: /a\nphases:\n  - duration: 3q\n    vus: 5\nthresholds: ["p95 < 3 apples"]\nfoo: 1\n', L);
  assert.equal(v.ok, false);
  const by = Object.fromEntries(v.errors.map((e) => [e.path.join('.'), e.line]));
  assert.equal(by.foo, 7);
  assert.equal(by['phases.0.duration'], 4);
  assert.equal(by['thresholds.0'], 6);
  assert.ok(v.errors.some((e) => /not a full URL/.test(e.message)));
});

test('limits: users, rate and duration over the settings are refused', () => {
  assert.match(validate('request: http://a.test/\nvus: 500\nduration: 10s\n', L).errors[0].message, /needs 500 virtual users\. The limit is 200/);
  assert.match(validate('request: http://a.test/\nrate: 9000\nduration: 10s\n', L).errors.map((e) => e.message).join(' '), /9000 requests per second/);
  assert.match(validate('request: http://a.test/\nvus: 1\nduration: 2h\n', L).errors[0].message, /runs 2 h/);
});

test('mixing vus and rate, empty load and bad methods are refused', () => {
  assert.equal(validate('request: http://a.test/\nphases:\n  - {duration: 1s, vus: 1}\n  - {duration: 1s, rate: 5}\n', L).ok, false);
  assert.equal(validate('request: http://a.test/\nvus: 0\nduration: 1s\n', L).ok, false);
  assert.equal(validate('request: { method: FETCH, url: http://a.test/ }\nvus: 1\nduration: 1s\n', L).ok, false);
  assert.equal(validate('request: ftp://a.test/\nvus: 1\nduration: 1s\n', L).ok, false);
});

test('JSON test files work the same', () => {
  const v = validate(JSON.stringify({ target: 'http://127.0.0.1:9', request: { url: '/x', json: { a: 1 } }, rate: [1, 10], duration: '5s' }), L);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.spec.model, 'open');
  assert.equal(v.spec.steps[0].body, '{"a":1}');
  assert.deepEqual(v.spec.steps[0].headers, [['content-type', 'application/json']]);
});

test('steps, extract and data mark the test as a scenario (Pro candidate)', () => {
  const v = validate('target: http://a.test\nsteps:\n  - request: { method: POST, url: /login }\n    extract: { token: $.token }\n  - request: /me\ndata: users.csv\nvus: 1\nduration: 1s\n', L);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.spec.pro, ['scenarios', 'data']);
});

test('hostile: billion laughs and a huge file stop with a message', () => {
  const laughs = fs.readFileSync(path.join(__dirname, 'fixtures', 'hostile-billion-laughs.yaml'), 'utf8');
  const v = validate(laughs, L);
  assert.equal(v.ok, false);
  const big = validate('name: x\n#' + 'a'.repeat(3 * 1048576) + '\n', L);
  assert.equal(big.ok, false);
  assert.match(big.errors[0].message, /under 2 MB/);
  assert.equal(validate('{{{{', L).ok, false);
  assert.equal(validate('', L).ok, false);
  assert.equal(validate('- a\n- b\n', L).ok, false);
});

test('hostile: header injection and credentials in the URL are refused', () => {
  assert.equal(validate('request: { url: "http://a.test/", headers: { x: "a\\r\\nHost: b" } }\nvus: 1\nduration: 1s\n', L).ok, false);
  assert.equal(validate('request: http://user:pw@a.test/\nvus: 1\nduration: 1s\n', L).ok, false);
});

test('a host that comes from a run-time value cannot be confirmed', () => {
  const v = validate('steps:\n  - request: "http://{{host}}/x"\nvus: 1\nduration: 1s\n', L);
  assert.ok(v.ok);
  assert.deepEqual(v.spec.hosts, ['?']);
  const w = validate('variables: { host: "127.0.0.1:8080" }\nrequest: "http://{{host}}/x"\nvus: 1\nduration: 1s\n', L);
  assert.deepEqual(w.spec.hosts, ['127.0.0.1:8080']);
});

test('durations', () => {
  assert.equal(parseDuration('1m30s'), 90000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration(2), 2000);
  assert.equal(parseDuration(250, 'ms'), 250);
  assert.ok(Number.isNaN(parseDuration('soon')));
  assert.equal(fmtDuration(90000), '1 min 30 s');
});

test('thresholds parse and evaluate', () => {
  assert.equal(parseThreshold('p95 < 300ms').rule.value, 300);
  assert.equal(parseThreshold('p99<=1.5s').rule.value, 1500);
  assert.equal(parseThreshold('errors < 1%').rule.metric, 'errors');
  assert.equal(parseThreshold('median < 20ms').rule.metric, 'p50');
  assert.equal(parseThreshold('p95 < 3%').ok, false);
  assert.equal(parseThreshold('speed > 3').ok, false);
  const sum = { requests: 1000, failed: 5, rps: 120, latency: { p50: 10, p95: 250, p99: 400, max: 900, min: 1, mean: 20 }, ttfb: {}, checksPassed: 990, checksTotal: 1000 };
  const r = evaluate(['p95 < 300ms', 'errors < 1%', 'rps >= 150', 'checks > 99.5%'].map((t) => parseThreshold(t).rule), sum);
  assert.deepEqual(r.map((x) => x.pass), [true, true, false, false]);
  assert.equal(r[1].actual, 0.5);
  const empty = evaluate([parseThreshold('p95 < 300ms').rule], { requests: 0, failed: 0, rps: 0, latency: { p95: 0 }, ttfb: {} });
  assert.equal(empty[0].pass, false, 'a run with no requests never passes a latency rule');
});

test('histogram: percentiles within 0.1 %, merge and JSON round trip', () => {
  const h = new Histogram();
  const vals = [];
  for (let i = 0; i < 50000; i++) { const v = Math.round(Math.exp(Math.random() * 14)); vals.push(v); h.record(v); }
  vals.sort((a, b) => a - b);
  for (const p of [50, 90, 95, 99, 99.9]) {
    const exact = vals[Math.ceil((p / 100) * vals.length) - 1];
    const got = h.percentile(p);
    assert.ok(Math.abs(got - exact) <= Math.max(1, exact * 0.001), `p${p}: ${got} vs ${exact}`);
  }
  const back = Histogram.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
  assert.equal(back.percentile(99), h.percentile(99));
  const two = new Histogram().add(h).add(h);
  assert.equal(two.n, 2 * h.n);
  for (const v of [0, 1, 2047, 2048, 3000, 1e6, 1e9, 1e12]) assert.ok(indexOf(v) >= 0);
  assert.ok(Math.abs(valueOf(indexOf(123456)) - 123456) / 123456 < 0.001);
  assert.equal(new Histogram().percentile(50), 0);
});

test('jsonpath subset, no code', () => {
  const d = { items: [{ id: 1, tags: ['a'] }, { id: 2 }], status: 'ok', 'a b': 3 };
  assert.deepEqual(jsonpath.query(d, '$.items[0].id').values, [1]);
  assert.deepEqual(jsonpath.query(d, '$.items[-1].id').values, [2]);
  assert.deepEqual(jsonpath.query(d, '$.items[*].id').values, [1, 2]);
  assert.deepEqual(jsonpath.query(d, '$..id').values, [1, 2]);
  assert.deepEqual(jsonpath.query(d, "$['a b']").values, [3]);
  assert.deepEqual(jsonpath.query(d, '$.items.length').values, [2]);
  assert.equal(jsonpath.query(d, '$.items[?(@.id>1)]').ok, false);
  assert.equal(jsonpath.query(d, 'items').ok, false);
});

test('templates fill variables and built-ins, unknown names stay', () => {
  const missing = new Set();
  const out = render('{{a}}-{{row}}-{{tok}}-{{$vu}}-{{$randomInt 5 6}}-{{nope}}', { variables: { a: 'A', row: 'v' }, row: { row: 'R' }, extracted: { tok: 'T' }, vu: 3, missing });
  assert.equal(out, 'A-R-T-3-5-{{nope}}');
  assert.deepEqual([...missing], ['nope']);
  assert.match(render('{{$uuid}}', {}), /^[0-9a-f-]{36}$/);
});

test('csv: quotes, BOM, tab files and the row limit', () => {
  const r = parseCsv('﻿user,note\nada,"a, ""b"""\r\ngrace,x\n');
  assert.deepEqual(r.columns, ['user', 'note']);
  assert.deepEqual(r.rows[0], { user: 'ada', note: 'a, "b"' });
  assert.equal(r.rows.length, 2);
  assert.equal(parseCsv('a\tb\n1\t2\n').rows[0].b, '2');
  const many = parseCsv('n\n' + Array.from({ length: 100 }, (_, i) => i).join('\n'), { maxRows: 10 });
  assert.equal(many.rows.length, 10);
  assert.equal(many.truncated, true);
});

test('blocklist patterns and local hosts', () => {
  assert.equal(blockedBy('api.example.gov', ['*.gov']), '*.gov');
  assert.equal(blockedBy('example.com:8443', ['example.com:8443']), 'example.com:8443');
  assert.equal(blockedBy('example.com:8080', ['example.com:8443']), '');
  assert.equal(blockedBy('example.com:8080', ['example.com']), 'example.com');
  assert.equal(blockedBy('notexample.com', ['*.example.com']), '');
  assert.ok(matchPattern('https://Shop.Example.com/x', 'shop.example.com'));
  assert.ok(isLocal('127.0.0.1:3000'));
  assert.ok(isLocal('localhost'));
  assert.ok(!isLocal('10.0.0.1'));
});
