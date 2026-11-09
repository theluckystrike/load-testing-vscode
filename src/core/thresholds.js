'use strict';
// Pass or fail rules such as "p95 < 300ms", "errors < 1%", "rps >= 100" or "checks > 99%".
// Pure functions: the engine, the dashboard and the tests use them.

const METRICS = {
  p50: 'latency', p90: 'latency', p95: 'latency', p99: 'latency', max: 'latency', min: 'latency', avg: 'latency', mean: 'latency',
  ttfb_p95: 'latency',
  errors: 'percent', checks: 'percent',
  rps: 'number', requests: 'number',
};
const ALIASES = { median: 'p50', error_rate: 'errors', failures: 'errors', 'errors%': 'errors', 'checks%': 'checks', avg_latency: 'avg', 'ttfb-p95': 'ttfb_p95' };
const OPS = ['<=', '>=', '==', '<', '>'];

/** Parses one rule. Returns { ok: true, rule } or { ok: false, error }. */
function parseThreshold(text) {
  const src = String(text == null ? '' : text).trim();
  const m = /^([a-z0-9_%-]+)\s*(<=|>=|==|=|<|>)\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s|%|\/s)?$/i.exec(src);
  if (!m) return { ok: false, error: `"${src}" is not a rule. Write it like "p95 < 300ms", "errors < 1%" or "rps >= 100".` };
  let metric = m[1].toLowerCase();
  metric = ALIASES[metric] || metric;
  const kind = METRICS[metric];
  if (!kind) return { ok: false, error: `"${m[1]}" is not a metric. Use one of: ${Object.keys(METRICS).join(', ')}.` };
  const op = m[2] === '=' ? '==' : m[2];
  let value = Number(m[3]);
  const unit = (m[4] || '').toLowerCase();
  if (kind === 'latency') {
    if (unit === '%' || unit === '/s') return { ok: false, error: `"${src}": ${metric} is a time. Use ms or s.` };
    if (unit === 's') value *= 1000;
  } else if (kind === 'percent') {
    if (unit && unit !== '%') return { ok: false, error: `"${src}": ${metric} is a percentage. Use %.` };
  } else if (unit && unit !== '/s') return { ok: false, error: `"${src}": ${metric} is a count. Leave out the unit.` };
  return { ok: true, rule: { text: src, metric, op, value, kind } };
}

function parseThresholds(list) {
  const rules = [], errors = [];
  for (const t of Array.isArray(list) ? list : []) {
    const r = parseThreshold(t);
    if (r.ok) rules.push(r.rule); else errors.push(r.error);
  }
  return { rules, errors };
}

/** Reads the metric from a run summary (see report.summarize). */
function metricValue(summary, metric) {
  const lat = summary.latency || {};
  switch (metric) {
    case 'p50': return lat.p50;
    case 'p90': return lat.p90;
    case 'p95': return lat.p95;
    case 'p99': return lat.p99;
    case 'max': return lat.max;
    case 'min': return lat.min;
    case 'avg': case 'mean': return lat.mean;
    case 'ttfb_p95': return (summary.ttfb || {}).p95;
    case 'errors': return summary.requests ? (100 * summary.failed) / summary.requests : 0;
    case 'checks': return summary.checksTotal ? (100 * summary.checksPassed) / summary.checksTotal : 100;
    case 'rps': return summary.rps;
    case 'requests': return summary.requests;
    default: return NaN;
  }
}

function compare(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return Math.abs(a - b) < 1e-9;
    default: return false;
  }
}

/** [{ text, metric, actual, pass }]. A run with 0 requests fails every latency and rps rule. */
function evaluate(rules, summary) {
  return rules.map((r) => {
    const actual = metricValue(summary, r.metric);
    const empty = !summary.requests && (r.kind === 'latency' || r.metric === 'rps');
    const pass = !empty && Number.isFinite(actual) && compare(actual, r.op, r.value);
    return { text: r.text, metric: r.metric, actual: Number.isFinite(actual) ? Math.round(actual * 1000) / 1000 : null, unit: r.kind === 'latency' ? 'ms' : r.kind === 'percent' ? '%' : '', pass };
  });
}

module.exports = { parseThreshold, parseThresholds, evaluate, metricValue, OPS, METRICS };
