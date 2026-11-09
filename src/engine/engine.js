'use strict';
// The load generator. Pure Node (node:http and node:https with keep-alive agents), no native code and no
// dependency. It runs in a worker thread in the extension (worker.js) and in-process in the tests.
//
// Closed model (vus): each virtual user sends its steps, waits the think time, and starts again. The number of
// users follows the phases (a number, or [from, to] for a linear ramp).
// Open model (rate): new iterations start at the given rate per second, whether or not earlier ones finished.
// When maxVus iterations are already in flight, the iteration is dropped and counted (the server is too slow).
//
// Latency is the time from sending the request to the last byte of the response. Time to first byte is kept too.
// A request fails on a network error, a timeout, or a status of 400 or more that the checks do not list.
// Stop destroys every socket at once. At the planned end, requests in flight get up to 2 s to finish.
const http = require('http');
const https = require('https');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { Histogram } = require('../core/histogram');
const { render } = require('../core/template');
const jsonpath = require('../core/jsonpath');
const { evaluate } = require('../core/thresholds');

const VERSION = '0.1.0';
const END_GRACE_MS = 2000;
const MAX_ERRORS_KEPT = 20;

function classify(e) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  const msg = String((e && e.message) || e || '');
  if (code === 'ZOVO_TIMEOUT' || code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'timeout';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ZOVO_MIDBODY' || /aborted/i.test(msg)) return 'connection closed mid-response';
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(msg)) return 'connection reset';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT/i.test(code) || /certificate/i.test(msg)) return 'TLS certificate not trusted';
  if (code === 'EPROTO' || /ssl|tls/i.test(msg)) return 'TLS error';
  if (/^HPE_/.test(code)) return 'invalid HTTP response';
  if (code === 'ZOVO_BLOCKED') return 'host not allowed';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
  return code || 'network error';
}

function statusAllowed(status, list) {
  return list.some((s) => (typeof s === 'number' ? s === status : Math.floor(status / 100) === Number(s[0])));
}

function phaseAt(phases, t) {
  let start = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (t < start + p.durationMs) {
      const f = (t - start) / p.durationMs;
      return { index: i, value: p.from + (p.to - p.from) * f, name: p.name };
    }
    start += p.durationMs;
  }
  const last = phases[phases.length - 1];
  return { index: phases.length - 1, value: last ? last.to : 0, name: last ? last.name : '' };
}

/** Arrivals from 0 to t (ms) for the open model: the integral of the rate. */
function arrivalsUntil(phases, t) {
  let start = 0, total = 0;
  for (const p of phases) {
    const D = p.durationMs / 1000;
    const tau = Math.min(Math.max((t - start) / 1000, 0), D);
    total += p.from * tau + ((p.to - p.from) * tau * tau) / (2 * D);
    start += p.durationMs;
    if (t <= start) break;
  }
  return total;
}

class Engine {
  /**
   * opts: { allowedHosts: [host], rows: [object] | null, onTick(snapshot), tickMs, userAgent }
   */
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.opts = opts;
    this.allowed = new Set((opts.allowedHosts || spec.hosts || []).map((h) => String(h).toLowerCase()));
    this.rows = opts.rows && opts.rows.length ? opts.rows : null;
    this.rowIndex = 0;
    this.tickMs = opts.tickMs || 1000;
    const maxSockets = Math.max(1, spec.maxVus || 1);
    const agentOpts = { keepAlive: true, maxSockets, maxFreeSockets: maxSockets, scheduling: 'lifo', timeout: spec.timeoutMs };
    this.httpAgent = new http.Agent(agentOpts);
    this.httpsAgent = new https.Agent({ ...agentOpts, rejectUnauthorized: !spec.insecure });
    this.total = new Histogram();
    this.ttfb = new Histogram();
    this.tick = new Histogram();
    this.inflight = new Set();
    this.timeline = [];
    this.statusCodes = {};
    this.errorKinds = {};
    this.errorSamples = [];
    this.checks = new Map();
    this.missing = new Set();
    this.c = { requests: 0, failed: 0, bytesIn: 0, bytesOut: 0, interrupted: 0, dropped: 0, iterations: 0 };
    this.t = { requests: 0, failed: 0, statusCodes: {}, errorKinds: {}, bytesIn: 0, dropped: 0 };
    this.activeVus = 0;
    this.peakVus = 0;
    this.state = 'idle';
    this.warnings = [];
    this.saturatedTicks = 0;
    this.done = new Promise((r) => { this._resolveDone = r; });
  }

  // ---- one request ----
  send(step, ctx) {
    return new Promise((resolve) => {
      const url = render(step.url, ctx);
      let u;
      try { u = new URL(url); } catch (e) { resolve({ error: 'invalid URL', detail: url.slice(0, 200), ms: 0 }); return; }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !this.allowed.has(u.host.toLowerCase())) {
        resolve({ error: 'host not allowed', detail: `${u.host} was not confirmed for this run`, ms: 0 });
        return;
      }
      const headers = {};
      for (const [k, v] of step.headers) headers[k] = render(v, ctx);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['user-agent'] = this.opts.userAgent || `zovo-load-testing/${VERSION}`;
      const body = step.body == null ? null : Buffer.from(render(step.body, ctx));
      if (body) headers['content-length'] = String(body.length);
      const isHttps = u.protocol === 'https:';
      const t0 = performance.now();
      let ttfb = 0, bytes = 0, finished = false;
      const chunks = []; let kept = 0;
      const cap = this.spec.maxBodyBytes;
      const finish = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.inflight.delete(req);
        r.ms = performance.now() - t0; r.ttfb = ttfb; r.bytes = bytes;
        resolve(r);
      };
      let req;
      try {
        req = (isHttps ? https : http).request(u, { method: step.method, headers, agent: isHttps ? this.httpsAgent : this.httpAgent });
      } catch (e) { resolve({ error: classify(e), detail: String(e.message || e).slice(0, 200), ms: 0 }); return; }
      req._zovoAbort = (why) => { const e = new Error(why); e.code = why === 'stopped' ? 'ZOVO_STOPPED' : 'ZOVO_TIMEOUT'; req.destroy(e); };
      this.inflight.add(req);
      const timer = setTimeout(() => req._zovoAbort('timeout'), this.spec.timeoutMs);
      req.on('response', (res) => {
        ttfb = performance.now() - t0;
        res.on('data', (c) => {
          bytes += c.length;
          if (kept < cap) { const part = kept + c.length > cap ? c.subarray(0, cap - kept) : c; chunks.push(part); kept += part.length; }
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: kept ? Buffer.concat(chunks) : Buffer.alloc(0), truncated: bytes > kept }));
        res.on('aborted', () => { const e = new Error('aborted'); e.code = 'ZOVO_MIDBODY'; finish({ error: classify(e), detail: `closed after ${bytes} bytes`, status: res.statusCode }); });
        res.on('error', (e) => {
          if (e && e.code === 'ZOVO_STOPPED') return finish({ interrupted: true });
          if (e && e.code === 'ZOVO_TIMEOUT') return finish({ error: 'timeout', detail: `no complete response in ${this.spec.timeoutMs} ms`, status: res.statusCode });
          finish({ error: e && e.code === 'ECONNRESET' ? 'connection closed mid-response' : classify(e), detail: String(e && e.message || e).slice(0, 200), status: res.statusCode });
        });
      });
      req.on('error', (e) => {
        if (e && e.code === 'ZOVO_STOPPED') return finish({ interrupted: true });
        if (e && e.code === 'ZOVO_TIMEOUT') return finish({ error: 'timeout', detail: `no complete response in ${this.spec.timeoutMs} ms` });
        finish({ error: classify(e), detail: String(e && e.message || e).slice(0, 200) });
      });
      if (body) req.end(body); else req.end();
      this.c.bytesOut += body ? body.length : 0;
    });
  }

  checkName(step, what) { return `${this.spec.steps.length > 1 ? step.name + ': ' : ''}${what}`; }

  recordCheck(name, ok) {
    let c = this.checks.get(name);
    if (!c) { c = { name, passed: 0, failed: 0 }; this.checks.set(name, c); }
    if (ok) c.passed++; else c.failed++;
  }

  /** Records a finished request. Returns the parsed JSON body when a check or extract needed it. */
  record(step, r, ctx) {
    if (r.interrupted) { this.c.interrupted++; return; }
    this.c.requests++; this.t.requests++;
    const us = r.ms * 1000;
    this.total.record(us); this.tick.record(us);
    if (r.ttfb) this.ttfb.record(r.ttfb * 1000);
    this.c.bytesIn += r.bytes || 0; this.t.bytesIn += r.bytes || 0;
    const checks = step.checks || {};
    let failed = false;
    if (r.error) {
      failed = true;
      this.errorKinds[r.error] = (this.errorKinds[r.error] || 0) + 1;
      this.t.errorKinds[r.error] = (this.t.errorKinds[r.error] || 0) + 1;
      if (this.errorSamples.length < MAX_ERRORS_KEPT) this.errorSamples.push({ step: step.name, error: r.error, detail: r.detail || '' });
    }
    if (r.status) {
      const k = String(r.status);
      this.statusCodes[k] = (this.statusCodes[k] || 0) + 1;
      this.t.statusCodes[k] = (this.t.statusCodes[k] || 0) + 1;
      if (!r.error && r.status >= 400 && !(checks.status && statusAllowed(r.status, checks.status))) {
        failed = true;
        const kind = `HTTP ${r.status}`;
        this.errorKinds[kind] = (this.errorKinds[kind] || 0) + 1;
        this.t.errorKinds[kind] = (this.t.errorKinds[kind] || 0) + 1;
      }
    }
    if (failed) { this.c.failed++; this.t.failed++; }
    let json;
    const bodyText = () => (r.body ? r.body.toString('utf8') : '');
    const parse = () => {
      if (json !== undefined) return json;
      try { json = JSON.parse(bodyText()); } catch (e) { json = null; }
      return json;
    };
    if (checks.status) this.recordCheck(this.checkName(step, `status is ${checks.status.join(' or ')}`), !!r.status && !r.error && statusAllowed(r.status, checks.status));
    if (checks.maxLatencyMs) this.recordCheck(this.checkName(step, `latency under ${checks.maxLatencyMs} ms`), !r.error && r.ms <= checks.maxLatencyMs);
    if (checks.bodyContains != null) this.recordCheck(this.checkName(step, `body contains "${checks.bodyContains.slice(0, 40)}"`), !r.error && bodyText().includes(render(checks.bodyContains, ctx)));
    if (checks.bodyNotContains != null) this.recordCheck(this.checkName(step, `body does not contain "${checks.bodyNotContains.slice(0, 40)}"`), !r.error && !bodyText().includes(render(checks.bodyNotContains, ctx)));
    if (checks.jsonPath) for (const [p, want] of checks.jsonPath) {
      let ok = false;
      if (!r.error) {
        const q = jsonpath.query(parse(), p);
        if (q.ok && q.values.length) {
          if (want && typeof want === 'object' && !Array.isArray(want) && 'exists' in want) ok = !!want.exists;
          else ok = q.values.some((v) => (v && typeof v === 'object' ? JSON.stringify(v) === JSON.stringify(want) : String(v) === String(want)));
        } else if (want && typeof want === 'object' && 'exists' in want) ok = !want.exists;
      }
      this.recordCheck(this.checkName(step, `${p} ${want && typeof want === 'object' && 'exists' in want ? (want.exists ? 'exists' : 'is missing') : '= ' + JSON.stringify(want)}`), ok);
    }
    if (checks.header) for (const [h, want] of checks.header) {
      const v = r.headers && r.headers[h];
      this.recordCheck(this.checkName(step, `header ${h} has "${want}"`), !r.error && v != null && String(v).includes(want));
    }
    if (step.extract.length && !r.error) {
      const data = parse();
      for (const [name, p] of step.extract) {
        const q = jsonpath.query(data, p);
        if (q.ok && q.values.length) ctx.extracted[name] = typeof q.values[0] === 'object' ? JSON.stringify(q.values[0]) : String(q.values[0]);
      }
    }
  }

  nextRow() {
    if (!this.rows) return null;
    if (this.spec.data && this.spec.data.order === 'random') return this.rows[Math.floor(Math.random() * this.rows.length)];
    const r = this.rows[this.rowIndex % this.rows.length];
    this.rowIndex++;
    return r;
  }

  sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((r) => { const t = setTimeout(r, ms); this.sleepers.add({ t, r }); });
  }

  think(range) {
    if (!range) return 0;
    const [a, b] = range;
    return a === b ? a : a + Math.random() * (b - a);
  }

  async iteration(vu, iteration) {
    this.c.iterations++;
    const ctx = { vu, iteration, variables: this.spec.variables, row: this.nextRow(), extracted: {}, missing: this.missing };
    for (const step of this.spec.steps) {
      if (this.state !== 'running') return;
      const r = await this.send(step, ctx);
      if (this.state === 'stopped' && !r.interrupted) { this.c.interrupted++; return; }
      this.record(step, r, ctx);
      if (r.interrupted) return;
      if (step.thinkMs) await this.sleep(this.think(step.thinkMs));
    }
  }

  // ---- closed model ----
  async vuLoop(vu) {
    this.activeVus++;
    if (this.activeVus > this.peakVus) this.peakVus = this.activeVus;
    let i = 0;
    try {
      while (this.state === 'running' && vu.id < this.targetVus) {
        await this.iteration(vu.id + 1, ++i);
        if (this.state !== 'running') break;
        const w = this.think(this.spec.thinkMs);
        if (w > 0) await this.sleep(w);
        else if (i % 64 === 0) await new Promise((r) => setImmediate(r)); // keep timers and Stop responsive
      }
    } finally {
      this.activeVus--;
      this.vus.delete(vu.id);
    }
  }

  controlClosed() {
    const t = performance.now() - this.t0;
    const ph = phaseAt(this.spec.phases, t);
    this.phase = ph;
    this.targetVus = Math.round(ph.value);
    for (let id = 0; id < this.targetVus; id++) {
      if (!this.vus.has(id)) { const vu = { id }; this.vus.set(id, vu); this.vuLoop(vu); }
    }
  }

  // ---- open model ----
  controlOpen() {
    const t = performance.now() - this.t0;
    this.phase = phaseAt(this.spec.phases, t);
    const due = Math.floor(arrivalsUntil(this.spec.phases, Math.min(t, this.spec.totalMs)));
    while (this.launched < due && this.state === 'running') {
      this.launched++;
      if (this.openInflight >= this.spec.maxVus) { this.c.dropped++; this.t.dropped++; continue; }
      this.openInflight++;
      if (this.openInflight > this.peakVus) this.peakVus = this.openInflight;
      const n = this.launched;
      this.iteration(((n - 1) % this.spec.maxVus) + 1, n).finally(() => { this.openInflight--; });
    }
    this.activeVus = this.openInflight;
  }

  // ---- ticks ----
  snapshot() {
    const now = performance.now();
    const sec = (now - this.lastTick) / 1000;
    this.lastTick = now;
    const lag = this.lag ? this.lag.max / 1e6 : 0;
    if (this.lag) this.lag.reset();
    const elu = performance.eventLoopUtilization(this.lastElu);
    this.lastElu = performance.eventLoopUtilization();
    const s = {
      t: Math.round((now - this.t0) / 100) / 10,
      phase: this.phase ? this.phase.name : '',
      target: this.phase ? Math.round(this.phase.value * 10) / 10 : 0,
      vus: this.activeVus,
      rps: sec > 0 ? Math.round((this.t.requests / sec) * 10) / 10 : 0,
      requests: this.t.requests,
      failed: this.t.failed,
      p50: Math.round(this.tick.percentile(50)) / 1000,
      p90: Math.round(this.tick.percentile(90)) / 1000,
      p95: Math.round(this.tick.percentile(95)) / 1000,
      p99: Math.round(this.tick.percentile(99)) / 1000,
      max: Math.round(this.tick.max) / 1000,
      statusCodes: this.t.statusCodes,
      errorKinds: this.t.errorKinds,
      bytesIn: this.t.bytesIn,
      dropped: this.t.dropped,
      inflight: this.inflight.size,
      lagMs: Math.round(lag * 10) / 10,
      elu: Math.round(elu.utilization * 100) / 100,
    };
    this.tick.reset();
    this.t = { requests: 0, failed: 0, statusCodes: {}, errorKinds: {}, bytesIn: 0, dropped: 0 };
    // The generator itself is the limit when its event loop is busy nearly all the time or lags.
    if (s.elu > 0.9 || s.lagMs > 100) this.saturatedTicks++; else this.saturatedTicks = 0;
    s.saturated = this.saturatedTicks >= 3;
    if (s.saturated && !this.warnings.includes('generator')) this.warnings.push('generator');
    if (s.dropped && !this.warnings.includes('dropped')) this.warnings.push('dropped');
    this.timeline.push(s);
    if (this.timeline.length > 7200) this.timeline.splice(0, this.timeline.length - 7200);
    return s;
  }

  summary() {
    const durMs = (this.endedAt || performance.now()) - this.t0;
    const checks = [...this.checks.values()];
    const checksPassed = checks.reduce((a, c) => a + c.passed, 0);
    const checksTotal = checks.reduce((a, c) => a + c.passed + c.failed, 0);
    return {
      requests: this.c.requests, failed: this.c.failed, iterations: this.c.iterations, interrupted: this.c.interrupted, dropped: this.c.dropped,
      durationMs: Math.round(durMs),
      rps: durMs > 0 ? Math.round((this.c.requests / (durMs / 1000)) * 100) / 100 : 0,
      latency: this.total.summary(), ttfb: this.ttfb.summary(),
      bytesIn: this.c.bytesIn, bytesOut: this.c.bytesOut,
      statusCodes: this.statusCodes, errorKinds: this.errorKinds, errorSamples: this.errorSamples,
      checks, checksPassed, checksTotal, peakVus: this.peakVus,
      missingVariables: [...this.missing].slice(0, 20),
    };
  }

  emit() {
    const s = this.snapshot();
    if (this.opts.onTick) {
      const sum = this.summary();
      try { this.opts.onTick({ tick: s, summary: sum, thresholds: evaluate(this.spec.thresholds, sum), state: this.state }); } catch (e) { /* listener errors never stop the run */ }
    }
  }

  start() {
    if (this.state !== 'idle') return this.done;
    this.state = 'running';
    this.startedAt = new Date().toISOString();
    this.t0 = performance.now();
    this.lastTick = this.t0;
    this.lastElu = performance.eventLoopUtilization();
    try { this.lag = monitorEventLoopDelay({ resolution: 10 }); this.lag.enable(); } catch (e) { this.lag = null; }
    this.sleepers = new Set();
    this.vus = new Map();
    this.targetVus = 0;
    this.launched = 0;
    this.openInflight = 0;
    const control = this.spec.model === 'open' ? () => this.controlOpen() : () => this.controlClosed();
    control();
    this.controlTimer = setInterval(() => {
      if (this.state !== 'running') return;
      if (performance.now() - this.t0 >= this.spec.totalMs) { this.finish('end'); return; }
      control();
    }, this.spec.model === 'open' ? 5 : 50);
    this.tickTimer = setInterval(() => this.emit(), this.tickMs);
    return this.done;
  }

  async finish(reason) {
    if (this.state !== 'running') return this.done;
    this.state = reason === 'end' ? 'draining' : 'stopped';
    clearInterval(this.controlTimer);
    for (const s of this.sleepers) { clearTimeout(s.t); s.r(); }
    this.sleepers.clear();
    if (reason === 'end') {
      // Let requests in flight finish, up to END_GRACE_MS. No new request starts.
      const until = performance.now() + END_GRACE_MS;
      while (this.inflight.size && performance.now() < until) await new Promise((r) => setTimeout(r, 20));
      this.state = 'stopped';
    }
    for (const req of [...this.inflight]) req._zovoAbort('stopped');
    this.httpAgent.destroy(); this.httpsAgent.destroy();
    // The abort events arrive on the next turns of the event loop; wait for them (at most 1 s) so the counts are final.
    const until = performance.now() + 1000;
    while (this.inflight.size && performance.now() < until) await new Promise((r) => setTimeout(r, 5));
    this.endedAt = performance.now();
    clearInterval(this.tickTimer);
    this.emit();
    if (this.lag) this.lag.disable();
    const summary = this.summary();
    const thresholds = evaluate(this.spec.thresholds, summary);
    const result = {
      v: 1, tool: `zovo-load-testing ${VERSION}`, name: this.spec.name, startedAt: this.startedAt, endedAt: new Date().toISOString(),
      stoppedBy: reason, model: this.spec.model, phases: this.spec.phases, hosts: [...this.allowed],
      steps: this.spec.steps.map((s) => ({ name: s.name, method: s.method, url: s.url })),
      summary, thresholds, pass: thresholds.every((t) => t.pass), warnings: this.warnings,
      timeline: this.timeline, histogram: this.total.toJSON(),
    };
    this._resolveDone(result);
    return this.done;
  }

  /** Stops now: every socket is destroyed. Resolves with the result. */
  stop() { if (this.state === 'running') this.finish('user'); else if (this.state === 'draining') { for (const req of [...this.inflight]) req._zovoAbort('stopped'); } return this.done; }
}

function run(spec, opts) { const e = new Engine(spec, opts); e.start(); return e; }

module.exports = { Engine, run, classify, phaseAt, arrivalsUntil, VERSION };
