'use strict';
// Load test files (*.load.yaml, *.load.yml, *.load.json): parsing, validation with line numbers, and the
// normalized form the engine runs. Pure Node, no VS Code import, so the tests and the worker can use it.
// YAML goes through the `yaml` package (ISC, vendored) with a small alias budget, so a "billion laughs" file
// stops with a message. JSON is valid YAML, so one parser gives line numbers for both.
const YAML = require('../../vendor/yaml');
const { parseThresholds } = require('./thresholds');
const jsonpath = require('./jsonpath');

const MAX_ALIASES = 100;
const MAX_SPEC_BYTES = 2 * 1048576;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const TOP_KEYS = ['name', 'target', 'request', 'steps', 'phases', 'vus', 'rate', 'duration', 'model', 'thinkTime', 'timeout', 'checks',
  'thresholds', 'insecure', 'variables', 'data', 'dataOrder', 'maxVus', 'maxBodyKB', 'description', '$schema'];
const REQUEST_KEYS = ['method', 'url', 'headers', 'body', 'json', 'form', 'query'];
const STEP_KEYS = ['name', 'request', 'checks', 'extract', 'thinkTime', ...REQUEST_KEYS];
const CHECK_KEYS = ['status', 'maxLatency', 'bodyContains', 'bodyNotContains', 'jsonPath', 'header'];

/** "1m30s", "500ms", "2h", "45s" or a number in the given default unit. Returns milliseconds or NaN. */
function parseDuration(v, defaultUnit = 's') {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * (defaultUnit === 'ms' ? 1 : 1000) : NaN;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * (defaultUnit === 'ms' ? 1 : 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
  let total = 0, used = 0, m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000;
    used += m[0].length;
  }
  return used && used === s.replace(/\s+/g, '').length ? total : NaN;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', r || (!h && !m) ? `${r} s` : ''].filter(Boolean).join(' ');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Parses the text. Returns { ok, data, doc, lineOf(path) } or { ok: false, errors }. */
function parseText(text) {
  if (typeof text !== 'string') return { ok: false, errors: [{ path: [], message: 'The file is empty.', line: 0 }] };
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) return { ok: false, errors: [{ path: [], message: 'A load test file must be under 2 MB. Put large data in a CSV file and point "data" at it.', line: 0 }] };
  const lc = new YAML.LineCounter();
  let doc;
  try {
    doc = YAML.parseDocument(text.replace(/^﻿/, ''), { lineCounter: lc, uniqueKeys: true, maxAliasCount: MAX_ALIASES, prettyErrors: false, strict: false });
  } catch (e) {
    return { ok: false, errors: [{ path: [], message: String(e && e.message || e), line: 0 }] };
  }
  if (doc.errors && doc.errors.length) {
    return { ok: false, errors: doc.errors.slice(0, 5).map((e) => ({ path: [], message: String(e.message).split('\n')[0], line: e.pos ? lc.linePos(e.pos[0]).line - 1 : 0 })) };
  }
  let data;
  try { data = doc.toJS({ maxAliasCount: MAX_ALIASES }); } catch (e) {
    return { ok: false, errors: [{ path: [], message: String(e && e.message || e).split('\n')[0], line: 0 }] };
  }
  const lineOf = (path) => {
    try {
      for (let n = path.length; n >= 0; n--) {
        const node = n ? doc.getIn(path.slice(0, n), true) : doc.contents;
        // getIn returns the value node; for a key we want its line, which is the same line in block style.
        if (node && node.range) return lc.linePos(node.range[0]).line - 1;
        if (n && path.length) {
          const parent = n > 1 ? doc.getIn(path.slice(0, n - 1), true) : doc.contents;
          if (parent && YAML.isMap(parent)) {
            const pair = parent.items.find((it) => String(YAML.isScalar(it.key) ? it.key.value : it.key) === String(path[n - 1]));
            if (pair && pair.key && pair.key.range) return lc.linePos(pair.key.range[0]).line - 1;
          }
        }
      }
    } catch (e) { /* fall through */ }
    return 0;
  };
  return { ok: true, data, lineOf };
}

function headerList(h, path, err) {
  const out = [];
  if (h == null) return out;
  if (isObj(h)) {
    for (const [k, v] of Object.entries(h)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) { err(path.concat(k), `"${k}" is not a valid header name.`); continue; }
      if (v == null) continue;
      const val = String(v);
      if (/[\r\n]/.test(val)) { err(path.concat(k), `The value of header "${k}" has a line break.`); continue; }
      out.push([k, val]);
    }
    return out;
  }
  if (Array.isArray(h)) {
    h.forEach((line, i) => {
      const m = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(String(line));
      if (!m) err(path.concat(i), `"${line}" is not a header. Write it as "Name: value".`); else out.push([m[1], m[2]]);
    });
    return out;
  }
  err(path, 'headers must be a map of name: value.');
  return out;
}

function normalizeChecks(c, path, err) {
  if (c == null) return null;
  if (!isObj(c)) { err(path, 'checks must be a map, for example { status: 200, maxLatency: 500ms }.'); return null; }
  const out = {};
  for (const k of Object.keys(c)) if (!CHECK_KEYS.includes(k)) err(path.concat(k), `Unknown check "${k}". Use: ${CHECK_KEYS.join(', ')}.`);
  if (c.status != null) {
    const list = Array.isArray(c.status) ? c.status : [c.status];
    const codes = [];
    for (const s of list) {
      const t = String(s).trim().toLowerCase();
      if (/^[1-5]xx$/.test(t)) codes.push(t);
      else if (/^[1-5]\d\d$/.test(t)) codes.push(Number(t));
      else err(path.concat('status'), `"${s}" is not a status. Use 200, [200, 201] or 2xx.`);
    }
    out.status = codes;
  }
  if (c.maxLatency != null) {
    const ms = parseDuration(c.maxLatency, 'ms');
    if (!Number.isFinite(ms) || ms <= 0) err(path.concat('maxLatency'), `"${c.maxLatency}" is not a time. Use 500ms or 2s.`); else out.maxLatencyMs = ms;
  }
  if (c.bodyContains != null) out.bodyContains = String(c.bodyContains);
  if (c.bodyNotContains != null) out.bodyNotContains = String(c.bodyNotContains);
  if (c.jsonPath != null) {
    if (!isObj(c.jsonPath)) err(path.concat('jsonPath'), 'jsonPath must map a path to a value, for example { "$.status": ok }.');
    else {
      out.jsonPath = [];
      for (const [p, want] of Object.entries(c.jsonPath)) {
        if (!jsonpath.isValid(p)) { err(path.concat('jsonPath', p), `"${p}" is not a supported JSONPath. Use $.items[0].id or $..id.`); continue; }
        out.jsonPath.push([p, want]);
      }
    }
  }
  if (c.header != null) {
    if (!isObj(c.header)) err(path.concat('header'), 'header must map a header name to the text it must contain.');
    else out.header = Object.entries(c.header).map(([k, v]) => [k.toLowerCase(), String(v)]);
  }
  return out;
}

function bodyOf(r, headers, path, err) {
  let body = null;
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name);
  const n = ['body', 'json', 'form'].filter((k) => r[k] != null).length;
  if (n > 1) err(path, 'Use only one of body, json and form.');
  if (r.json != null) {
    body = JSON.stringify(r.json);
    if (!has('content-type')) headers.push(['content-type', 'application/json']);
  } else if (r.form != null) {
    if (!isObj(r.form)) err(path.concat('form'), 'form must be a map of field: value.');
    else {
      body = new URLSearchParams(Object.entries(r.form).map(([k, v]) => [k, String(v)])).toString();
      if (!has('content-type')) headers.push(['content-type', 'application/x-www-form-urlencoded']);
    }
  } else if (r.body != null) {
    if (typeof r.body === 'string') body = r.body;
    else {
      body = JSON.stringify(r.body);
      if (!has('content-type')) headers.push(['content-type', 'application/json']);
    }
  }
  return body;
}

function joinUrl(target, url) {
  if (!url) return target || '';
  if (/^https?:\/\//i.test(url) || /^\{\{/.test(url)) return url;
  if (!target) return url;
  return target.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url);
}

function normalizeRequest(r, base, path, err) {
  if (typeof r === 'string') {
    const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(r);
    r = m ? { method: m[1], url: m[2] } : { url: r.trim() };
  }
  if (!isObj(r)) { err(path, 'request must be a map with at least url.'); return null; }
  for (const k of Object.keys(r)) if (!REQUEST_KEYS.includes(k) && !STEP_KEYS.includes(k)) err(path.concat(k), `Unknown key "${k}" in a request. Use: ${REQUEST_KEYS.join(', ')}.`);
  const method = String(r.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) err(path.concat('method'), `"${r.method}" is not a supported method. Use ${METHODS.join(', ')}.`);
  if (r.url == null || String(r.url).trim() === '') { err(path.concat('url'), 'The request needs a url.'); return null; }
  let url = joinUrl(base.target, String(r.url).trim());
  if (r.query != null) {
    if (!isObj(r.query)) err(path.concat('query'), 'query must be a map of name: value.');
    else {
      const qs = new URLSearchParams(Object.entries(r.query).map(([k, v]) => [k, String(v)])).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
  }
  if (!/\{\{/.test(url)) {
    let u;
    try { u = new URL(url); } catch (e) { err(path.concat('url'), `"${url}" is not a full URL. Start it with http:// or https://, or set target.`); return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { err(path.concat('url'), `Only http and https URLs can be tested (found ${u.protocol}).`); return null; }
    if (u.username || u.password) err(path.concat('url'), 'Put credentials in an authorization header, not in the URL.');
  } else if (!/^https?:\/\//i.test(url) && !/^\{\{[^}]+\}\}/.test(url)) {
    err(path.concat('url'), `"${url}" is not a full URL. Start it with http:// or https://, or set target.`); return null;
  }
  const headers = headerList(r.headers, path.concat('headers'), err);
  const body = bodyOf(r, headers, path, err);
  return { method, url, headers, body };
}

/** Phases: [{ duration, vus | rate, name }], each value a number or [from, to] for a ramp. */
function normalizePhases(d, err) {
  let list = d.phases;
  if (list == null) {
    if (d.duration == null) { err(['phases'], 'Add phases, or vus (or rate) with a duration, for example "vus: 10" and "duration: 30s".'); return null; }
    list = [{ duration: d.duration, ...(d.rate != null ? { rate: d.rate } : { vus: d.vus == null ? 1 : d.vus }) }];
  } else if (d.duration != null || d.vus != null || d.rate != null) {
    err(['phases'], 'Use phases, or vus/rate with duration at the top, not both.');
  }
  if (!Array.isArray(list) || !list.length) { err(['phases'], 'phases must be a list with at least one phase.'); return null; }
  const out = [];
  let model = null;
  list.forEach((p, i) => {
    const path = ['phases', i];
    if (!isObj(p)) { err(path, 'Each phase needs a duration and vus (or rate).'); return; }
    for (const k of Object.keys(p)) if (!['name', 'duration', 'vus', 'rate'].includes(k)) err(path.concat(k), `Unknown key "${k}" in a phase. Use name, duration, vus or rate.`);
    const ms = parseDuration(p.duration, 's');
    if (!Number.isFinite(ms) || ms <= 0) err(path.concat('duration'), `"${p.duration}" is not a duration. Use 30s, 2m or 1m30s.`);
    const kind = p.rate != null ? 'open' : p.vus != null ? 'closed' : null;
    if (!kind) { err(path, 'The phase needs vus (virtual users) or rate (requests per second).'); return; }
    if (p.rate != null && p.vus != null) err(path, 'A phase uses vus or rate, not both.');
    if (model && model !== kind) err(path, 'All phases use vus, or all use rate. Do not mix them in one test.');
    model = model || kind;
    const raw = kind === 'open' ? p.rate : p.vus;
    const pair = Array.isArray(raw) ? raw : [raw, raw];
    if (pair.length !== 2 || !pair.every((x) => Number.isFinite(Number(x)) && Number(x) >= 0)) {
      err(path.concat(kind === 'open' ? 'rate' : 'vus'), `"${JSON.stringify(raw)}" must be a number or [from, to].`); return;
    }
    const from = Number(pair[0]), to = Number(pair[1]);
    if (kind === 'closed' && (!Number.isInteger(from) || !Number.isInteger(to))) err(path.concat('vus'), 'vus must be whole numbers.');
    out.push({ name: p.name ? String(p.name) : `phase ${i + 1}`, durationMs: ms, from, to });
  });
  return { model: model || 'closed', phases: out };
}

/**
 * Validates and normalizes. Returns { ok, spec, errors: [{ path, message, line }], warnings: [...] }.
 * limits: { maxVus, maxRate, maxDurationMs } from the settings.
 */
function validate(text, limits = {}) {
  const parsed = parseText(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const d = parsed.data;
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({ path, message, line: parsed.lineOf(path) });
  const warn = (path, message) => warnings.push({ path, message, line: parsed.lineOf(path) });
  if (!isObj(d)) { err([], 'A load test is a map with request (or steps) and phases. Run "Load Testing: New Load Test" for an example.'); return { ok: false, errors, warnings }; }
  for (const k of Object.keys(d)) if (!TOP_KEYS.includes(k)) err([k], `Unknown key "${k}". Use: ${TOP_KEYS.filter((x) => x !== '$schema').join(', ')}.`);

  const target = d.target != null ? String(d.target).trim().replace(/\/+$/, '') : '';
  if (target && !/\{\{/.test(target)) {
    try { const u = new URL(target); if (!/^https?:$/.test(u.protocol)) err(['target'], 'target must start with http:// or https://.'); }
    catch (e) { err(['target'], `"${target}" is not a URL. Use a base URL such as http://localhost:3000.`); }
  }
  const base = { target };

  const steps = [];
  if (d.request != null && d.steps != null) err(['steps'], 'Use request for one request, or steps for several, not both.');
  if (d.request == null && d.steps == null) err([], 'The test needs a request (or a list of steps).');
  if (d.request != null) {
    const r = normalizeRequest(d.request, base, ['request'], err);
    if (r) steps.push({ name: d.name ? String(d.name) : `${r.method} ${r.url}`, ...r, checks: normalizeChecks(d.checks, ['checks'], err), extract: [], thinkMs: null });
  } else if (d.steps != null) {
    if (!Array.isArray(d.steps) || !d.steps.length) err(['steps'], 'steps must be a list with at least one step.');
    else d.steps.forEach((s, i) => {
      const path = ['steps', i];
      if (!isObj(s)) { err(path, 'Each step is a map with a request.'); return; }
      for (const k of Object.keys(s)) if (!STEP_KEYS.includes(k)) err(path.concat(k), `Unknown key "${k}" in a step. Use: name, request, checks, extract, thinkTime.`);
      const r = normalizeRequest(s.request != null ? s.request : s, base, s.request != null ? path.concat('request') : path, err);
      if (!r) return;
      const extract = [];
      if (s.extract != null) {
        if (!isObj(s.extract)) err(path.concat('extract'), 'extract maps a variable name to a JSONPath, for example { token: $.token }.');
        else for (const [name, p] of Object.entries(s.extract)) {
          if (!/^[A-Za-z_][\w]*$/.test(name)) err(path.concat('extract', name), `"${name}" is not a variable name (letters, digits, _).`);
          else if (!jsonpath.isValid(String(p))) err(path.concat('extract', name), `"${p}" is not a supported JSONPath.`);
          else extract.push([name, String(p)]);
        }
      }
      let thinkMs = null;
      if (s.thinkTime != null) thinkMs = thinkOf(s.thinkTime, path.concat('thinkTime'), err);
      const checks = normalizeChecks(s.checks, path.concat('checks'), err) || normalizeChecks(d.checks, ['checks'], () => {});
      steps.push({ name: s.name ? String(s.name) : `${r.method} ${r.url}`, ...r, checks, extract, thinkMs });
    });
  }

  const ph = normalizePhases(d, err);
  const thinkMs = d.thinkTime != null ? thinkOf(d.thinkTime, ['thinkTime'], err) : [0, 0];
  const timeoutMs = d.timeout != null ? parseDuration(d.timeout, 'ms') : 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) err(['timeout'], `"${d.timeout}" is not a time. Use 10s or 500ms.`);
  if (timeoutMs > 300000) err(['timeout'], 'timeout can be at most 5m.');

  const th = parseThresholds(d.thresholds == null ? [] : (Array.isArray(d.thresholds) ? d.thresholds : [d.thresholds]));
  th.errors.forEach((m, i) => err(['thresholds', i], m));

  const variables = {};
  if (d.variables != null) {
    if (!isObj(d.variables)) err(['variables'], 'variables must be a map of name: value.');
    else for (const [k, v] of Object.entries(d.variables)) {
      if (!/^[A-Za-z_][\w]*$/.test(k)) err(['variables', k], `"${k}" is not a variable name (letters, digits, _).`);
      else variables[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  let data = null;
  if (d.data != null) {
    if (typeof d.data !== 'string' || !/\.(csv|tsv)$/i.test(d.data)) err(['data'], 'data is the path of a .csv or .tsv file, relative to this test file.');
    else data = { file: d.data, order: d.dataOrder === 'random' ? 'random' : 'sequential' };
  }
  if (d.dataOrder != null && !['sequential', 'random'].includes(d.dataOrder)) err(['dataOrder'], 'dataOrder is sequential or random.');
  if (d.insecure != null && typeof d.insecure !== 'boolean') err(['insecure'], 'insecure is true or false.');
  const maxBodyKB = d.maxBodyKB != null ? Number(d.maxBodyKB) : 1024;
  if (!Number.isFinite(maxBodyKB) || maxBodyKB < 0 || maxBodyKB > 65536) err(['maxBodyKB'], 'maxBodyKB is a number from 0 to 65536.');

  let maxVus = 0, totalMs = 0, peakRate = 0;
  if (ph) {
    totalMs = ph.phases.reduce((a, p) => a + p.durationMs, 0);
    if (ph.model === 'closed') maxVus = Math.max(0, ...ph.phases.map((p) => Math.max(p.from, p.to)));
    else {
      peakRate = Math.max(0, ...ph.phases.map((p) => Math.max(p.from, p.to)));
      maxVus = d.maxVus != null ? Number(d.maxVus) : Math.min(limits.maxVus || 200, Math.max(10, Math.ceil(peakRate * Math.max(timeoutMs, 1000) / 1000 / 10)));
      if (d.maxVus != null && (!Number.isInteger(maxVus) || maxVus < 1)) err(['maxVus'], 'maxVus is a whole number of 1 or more.');
    }
    if (limits.maxVus && maxVus > limits.maxVus) err(ph.model === 'closed' ? ['phases'] : ['maxVus'], `This test needs ${maxVus} virtual users. The limit is ${limits.maxVus} (setting loadTesting.maxVirtualUsers).`);
    if (limits.maxRate && peakRate > limits.maxRate) err(['phases'], `This test asks for ${peakRate} requests per second. The limit is ${limits.maxRate} (setting loadTesting.maxRequestsPerSecond).`);
    if (limits.maxDurationMs && totalMs > limits.maxDurationMs) err(['phases'], `This test runs ${fmtDuration(totalMs)}. The limit is ${fmtDuration(limits.maxDurationMs)} (setting loadTesting.maxDurationMinutes).`);
    if (ph.model === 'closed' && maxVus === 0) err(['phases'], 'Every phase has 0 virtual users, so nothing would be sent.');
    if (ph.model === 'open' && peakRate === 0) err(['phases'], 'Every phase has a rate of 0, so nothing would be sent.');
  }
  if (d.model != null && ph && d.model !== ph.model) warn(['model'], `model says ${d.model}, but the phases use ${ph.model === 'open' ? 'rate (open model)' : 'vus (closed model)'}. The phases win.`);

  const pro = [];
  if (steps.length > 1 || steps.some((s) => s.extract.length)) pro.push('scenarios');
  if (data) pro.push('data');

  if (errors.length) return { ok: false, errors, warnings };
  const spec = {
    name: d.name ? String(d.name) : steps[0].name,
    steps, model: ph.model, phases: ph.phases, totalMs, maxVus, peakRate,
    thinkMs, timeoutMs, thresholds: th.rules, variables, data, insecure: d.insecure === true,
    maxBodyBytes: Math.round(maxBodyKB * 1024), pro,
  };
  spec.hosts = hostsOf(spec);
  return { ok: true, spec, errors: [], warnings };
}

function thinkOf(v, path, err) {
  const pair = Array.isArray(v) ? v : [v, v];
  const ms = pair.map((x) => parseDuration(x, 'ms'));
  if (pair.length !== 2 || ms.some((x) => !Number.isFinite(x)) || ms[0] > ms[1]) { err(path, `"${JSON.stringify(v)}" is not a think time. Use 500ms, 1s or [200ms, 1s].`); return [0, 0]; }
  return ms;
}

/** Static hosts of the test, after the file's own variables are filled in. Used for the confirmation and the blocklist. */
function hostsOf(spec) {
  const set = new Set();
  for (const s of spec.steps) {
    const url = s.url.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (m, k) => (k in spec.variables ? spec.variables[k] : m));
    const origin = url.split('/').slice(0, 3).join('/');
    if (/\{\{|\}\}/.test(origin)) { set.add('?'); continue; } // the host is only known during the run
    try { const u = new URL(url); set.add(u.host.toLowerCase()); } catch (e) { set.add('?'); }
  }
  return [...set];
}

function example(target = 'http://localhost:3000') {
  return `# Load test. Run it with the "Run load test" link above, or Load Testing: Run Load Test.
# Requests go only to the URL below. Nothing else is sent anywhere.
name: Orders API
target: ${target}
request:
  method: GET
  url: /api/orders?limit=20
  headers:
    accept: application/json
checks:
  status: 200
  maxLatency: 500ms
phases:
  - name: ramp-up
    duration: 10s
    vus: [1, 20]
  - name: steady
    duration: 30s
    vus: 20
  - name: ramp-down
    duration: 5s
    vus: [20, 0]
thinkTime: [50ms, 150ms]
timeout: 10s
thresholds:
  - p95 < 300ms
  - errors < 1%
`;
}

module.exports = { validate, parseText, parseDuration, fmtDuration, example, hostsOf, METHODS, TOP_KEYS, MAX_SPEC_BYTES };
