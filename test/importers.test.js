'use strict';
// Imports from 10 real files: 3 .http/.rest, 2 cURL commands, a real HAR, 2 OpenAPI/Swagger documents, a JMeter
// plan, and hostile input. Every import must give a valid test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../src/core/importers');
const { validate } = require('../src/core/spec');

const F = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const L = { maxVus: 200 };
const valid = (imp, src) => { const v = validate(I.buildTest(imp, { source: src }), L); assert.ok(v.ok, JSON.stringify(v.errors)); return v.spec; };

test('.http: file variables, two requests, $guid', () => {
  const imp = I.fromHttpFile(F('orders.http'));
  assert.equal(imp.requests.length, 2);
  assert.equal(imp.requests[1].method, 'POST');
  assert.match(imp.requests[1].body, /\{\{\$uuid\}\}/);
  const s = valid(imp, 'orders.http');
  assert.equal(s.steps.length, 2);
  assert.equal(s.hosts[0], '127.0.0.1:3000');
});

test('.rest: a named request and a response variable become an extract', () => {
  const imp = I.fromHttpFile(F('login-flow.rest'));
  assert.deepEqual(imp.requests.map((r) => r.name), ['login', 'me']);
  assert.deepEqual(imp.requests[0].extract, [['login_token', '$.token']]);
  assert.equal(imp.requests[1].headers[0][1], 'Bearer {{login_token}}');
  const s = valid(imp, 'login-flow.rest');
  assert.deepEqual(s.pro, ['scenarios']);
});

test('.http: query continuation lines, comments and a bare URL', () => {
  const imp = I.fromHttpFile(F('health.http'));
  assert.equal(imp.requests[0].url, 'http://127.0.0.1:3000/api/orders?limit=5&sort=desc');
  assert.equal(imp.requests[1].method, 'GET');
  valid(imp, 'health.http');
});

test('cURL: quoted JSON body with an escaped quote', () => {
  const imp = I.fromCurl(F('curl-post.txt'));
  const r = imp.requests[0];
  assert.equal(r.method, 'POST');
  assert.deepEqual(JSON.parse(r.body), { user: 'grace', note: "it's fine" });
  assert.ok(r.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
  valid(imp, 'curl');
});

test('cURL: -G data goes to the query, -u becomes basic auth, -k sets insecure', () => {
  const imp = I.fromCurl(F('curl-get.txt'));
  const r = imp.requests[0];
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://127.0.0.1:3443/api/orders?limit=20&q=a b');
  assert.ok(r.headers.some(([k, v]) => k === 'authorization' && v === 'Basic ' + Buffer.from('admin:secret').toString('base64')));
  assert.equal(imp.insecure, true);
  assert.equal(valid(imp, 'curl').insecure, true);
  assert.equal(I.fromCurl('wget http://x').requests.length, 0);
  assert.equal(I.fromCurl("curl 'http://x").requests.length, 0);
});

test('HAR: API requests only, pseudo and hop headers dropped, secrets noted', () => {
  const imp = I.fromHar(F('shop-checkout.har'));
  assert.ok(imp.requests.length > 5);
  assert.ok(imp.requests.every((r) => ['xhr', 'doc'].includes(r.type)));
  assert.ok(imp.requests.every((r) => r.headers.every(([k]) => !k.startsWith(':') && k.toLowerCase() !== 'content-length')));
  assert.ok(imp.notes.some((n) => /left out/.test(n)));
  valid({ ...imp, requests: imp.requests.slice(0, 1) }, 'har');
  valid({ ...imp, requests: imp.requests.slice(0, 4) }, 'har');
  assert.throws(() => I.fromHar(F('not-a-har.har')));
});

test('OpenAPI 3: server URL, path parameters as variables, example bodies', () => {
  const imp = I.fromOpenApi(F('petstore-3.0.yaml'));
  assert.ok(imp.requests.length >= 3);
  const byId = imp.requests.find((r) => /\{\{petId\}\}/.test(r.url));
  assert.ok(byId, 'path parameter');
  assert.ok('petId' in imp.variables);
  for (const r of imp.requests) valid({ ...imp, requests: [r] }, 'openapi');
});

test('Swagger 2: host, basePath and scheme', () => {
  const imp = I.fromOpenApi(F('petstore-swagger-2.0.yaml'));
  assert.ok(imp.requests.length >= 3);
  assert.match(imp.requests[0].url, /^https?:\/\/[^/]+\//);
  valid({ ...imp, requests: imp.requests.slice(0, 2) }, 'swagger');
});

test('JMeter: samplers, defaults, header manager, variables and the thread group', () => {
  const imp = I.fromJmx(F('checkout.jmx'));
  assert.deepEqual(imp.requests.map((r) => r.name), ['List orders', 'Login & get token']);
  assert.equal(imp.requests[0].url, 'http://127.0.0.1:3000/api/orders?limit={{limit}}');
  assert.equal(imp.variables.limit, '15');
  assert.match(imp.requests[1].body, /\{\{\$randomInt 1 999\}\}/);
  assert.equal(imp.phases[0].vus[1], 25);
  const s = valid(imp, 'jmx');
  assert.equal(s.maxVus, 25);
  assert.equal(s.totalMs, 70000);
  assert.equal(I.fromJmx('<xml/>').requests.length, 0);
});

test('hostile: billion laughs OpenAPI, garbage and empty input give a message, not a crash', () => {
  const imp = I.fromOpenApi(F('hostile-billion-laughs.yaml'));
  assert.equal(imp.requests.length, 0);
  assert.ok(imp.notes.length);
  assert.equal(I.fromOpenApi('{"not":"openapi"}').requests.length, 0);
  assert.equal(I.fromHttpFile('').requests.length, 0);
  assert.equal(I.fromHttpFile('### only separators\n###\n').requests.length, 0);
  assert.throws(() => I.buildTest({ requests: [] }));
});
