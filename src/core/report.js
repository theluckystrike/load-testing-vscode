'use strict';
// Run reports: a self-contained HTML file (inline CSS and SVG, no script, no outside file, so it opens offline in
// any browser and can be attached to a ticket), the side-by-side compare of two runs, and the run history.
// Dark and light follow the reader's system setting. Pure functions: no VS Code.
const { Histogram } = require('./histogram');
const { fmtDuration } = require('./spec');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const ms = (v) => (v == null ? '-' : `${num(v, v < 10 ? 2 : 1)} ms`);
const pct = (a, b) => (b ? (100 * a) / b : 0);

function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${num(n / 1024 ** i, i ? 1 : 0)} ${u[i]}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--mute:#59636e;--line:#d1d9e0;--card:#f6f8fa;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;
--s1:#0969da;--s2:#8250df;--s3:#bf3989;--s4:#1a7f37;--s5:#cf222e;--grid:#e6eaef}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#9198a1;--line:#3d444d;--card:#151b23;--ok:#3fb950;--bad:#f85149;--warn:#d29922;
--s1:#4493f8;--s2:#ab7df8;--s3:#f778ba;--s4:#3fb950;--s5:#f85149;--grid:#262c36}}
*{box-sizing:border-box}body{margin:0;padding:24px 28px 40px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sub{color:var(--mute);margin:0 0 18px}.verdict{display:inline-block;font-weight:600;padding:2px 10px;border-radius:12px;margin-left:8px;font-size:13px;vertical-align:3px}
.pass{color:var(--ok)}.fail{color:var(--bad)}.verdict.pass{background:color-mix(in srgb,var(--ok) 15%,transparent)}.verdict.fail{background:color-mix(in srgb,var(--bad) 15%,transparent)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.tile span{color:var(--mute);font-size:12px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}th{color:var(--mute);font-weight:600;font-size:12px}
td.n,th.n{text-align:right}.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 8px 4px;margin-bottom:12px}
.chart h3{margin:2px 6px 4px;font-size:13px;font-weight:600}.legend{display:flex;gap:14px;margin:0 6px 4px;font-size:12px;color:var(--mute)}.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:3px}
svg text{fill:var(--mute);font-size:11px}.warn{border-left:3px solid var(--warn);background:var(--card);padding:8px 12px;margin:10px 0;border-radius:4px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.foot{margin-top:32px;color:var(--mute);font-size:12px}
.up{color:var(--bad)}.down{color:var(--ok)}`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}
<p class="foot">Made by Load Testing for VS Code (Zovo). This file has no script and loads nothing from the network.</p></body></html>`;
}

/** A round top value and a step count that gives round labels: 250 -> 5 steps of 50, 40 -> 4 steps of 10. */
function niceScale(v) {
  if (!(v > 0)) return { max: 1, div: 4 };
  const p = 10 ** Math.floor(Math.log10(v));
  for (const [m, div] of [[1, 4], [2, 4], [2.5, 5], [4, 4], [5, 5], [10, 4]]) if (m * p >= v) return { max: m * p, div };
  return { max: 10 * p, div: 4 };
}

/** Inline SVG line chart. series: [{ name, color (CSS var), points: [[x, y]] }] */
function lineChart({ title, series, width = 900, height = 220, yUnit = '', xUnit = 's', yMax }) {
  const pad = { l: 56, r: 12, t: 10, b: 26 };
  const all = series.flatMap((s) => s.points);
  const xMax = Math.max(1, ...all.map((p) => p[0]));
  const sc = yMax ? { max: yMax, div: 4 } : niceScale(Math.max(0, ...all.map((p) => p[1])) * 1.05);
  const ym = sc.max;
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const X = (x) => pad.l + (x / xMax) * W, Y = (y) => pad.t + H - (Math.min(y, ym) / ym) * H;
  let g = '';
  for (let i = 0; i <= sc.div; i++) {
    const y = (ym * i) / sc.div;
    g += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}" stroke="var(--grid)"/>`;
    g += `<text x="${pad.l - 6}" y="${(Y(y) + 4).toFixed(1)}" text-anchor="end">${esc(num(y, y < 10 ? 1 : 0))}${esc(yUnit)}</text>`;
  }
  for (let i = 0; i <= 6; i++) {
    const x = (xMax * i) / 6;
    g += `<text x="${X(x).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(num(x, xMax < 10 ? 1 : 0))}${esc(xUnit)}</text>`;
  }
  const lines = series.map((s) => {
    if (!s.points.length) return '';
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
  }).join('');
  const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="chart"><h3>${esc(title)}</h3><div class="legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">${g}${lines}</svg></div>`;
}

function tiles(sum) {
  const t = [
    ['Requests', num(sum.requests, 0)], ['Requests/s', num(sum.rps, 1)], ['p50', ms(sum.latency.p50)], ['p95', ms(sum.latency.p95)],
    ['p99', ms(sum.latency.p99)], ['Max', ms(sum.latency.max)], ['Errors', `${num(pct(sum.failed, sum.requests), 2)} %`],
    ['Checks passed', sum.checksTotal ? `${num(pct(sum.checksPassed, sum.checksTotal), 2)} %` : '-'], ['Peak users', num(sum.peakVus, 0)],
    ['Data received', fmtBytes(sum.bytesIn)],
  ];
  return `<div class="tiles">${t.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>`;
}

function table(head, rows, numeric = []) {
  if (!rows.length) return '<p class="sub">None.</p>';
  return `<table><thead><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const WARNINGS = {
  generator: 'The load generator itself was at its limit for 3 seconds or more (its event loop was busy or late). The requests per second it reports are what this computer could send, not the limit of the server. Use fewer users, a lower rate or a faster machine to measure the server.',
  dropped: 'Some planned iterations were dropped because maxVus requests were already waiting. The server answered more slowly than the requested rate. Raise maxVus or lower the rate.',
};

function warningsHtml(result) {
  return (result.warnings || []).map((w) => `<div class="warn">${esc(WARNINGS[w] || w)}</div>`).join('');
}

function timelineCharts(tl) {
  return [
    lineChart({ title: 'Requests per second', series: [
      { name: 'requests/s', color: 'var(--s1)', points: tl.map((s) => [s.t, s.rps]) },
    ] }),
    lineChart({ title: 'Active users', series: [
      { name: 'active users', color: 'var(--s2)', points: tl.map((s) => [s.t, s.vus]) },
    ], height: 150 }),
    lineChart({ title: 'Latency per second', yUnit: ' ms', series: [
      { name: 'p50', color: 'var(--s4)', points: tl.map((s) => [s.t, s.p50]) },
      { name: 'p95', color: 'var(--s1)', points: tl.map((s) => [s.t, s.p95]) },
      { name: 'p99', color: 'var(--s3)', points: tl.map((s) => [s.t, s.p99]) },
    ] }),
    lineChart({ title: 'Failed requests per second', series: [
      { name: 'failed/s', color: 'var(--s5)', points: tl.map((s) => [s.t, s.requests && s.rps ? (s.failed * s.rps) / s.requests : s.failed]) },
    ] }),
  ].join('');
}

/** The HTML report of one run. */
function htmlReport(result) {
  const s = result.summary;
  const verdict = result.thresholds && result.thresholds.length ? `<span class="verdict ${result.pass ? 'pass' : 'fail'}">${result.pass ? 'PASSED' : 'FAILED'}</span>` : '';
  const when = result.startedAt ? new Date(result.startedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';
  const body = [
    `<h1>${esc(result.name)}${verdict}</h1>`,
    `<p class="sub">${esc(when)} · ${esc(fmtDuration(s.durationMs))} · ${esc(result.model === 'open' ? 'open model (rate)' : 'closed model (virtual users)')} · ${esc((result.hosts || []).join(', '))}${result.stoppedBy === 'user' ? ' · stopped by the user' : ''}</p>`,
    warningsHtml(result),
    tiles(s),
    result.thresholds && result.thresholds.length ? `<h2>Thresholds</h2>${table(['Rule', 'Measured', 'Result'], result.thresholds.map((t) => [
      `<code>${esc(t.text)}</code>`, esc(t.actual == null ? '-' : `${num(t.actual, 2)}${t.unit ? ' ' + t.unit : ''}`), `<b class="${t.pass ? 'pass' : 'fail'}">${t.pass ? 'pass' : 'fail'}</b>`]), [1])}` : '',
    `<h2>Over time</h2>${timelineCharts(result.timeline || [])}`,
    `<h2>Latency</h2>${table(['', 'min', 'mean', 'p50', 'p90', 'p95', 'p99', 'max'], [
      ['Full response', ...['min', 'mean', 'p50', 'p90', 'p95', 'p99', 'max'].map((k) => esc(ms(s.latency[k])))],
      ['First byte', ...['min', 'mean', 'p50', 'p90', 'p95', 'p99', 'max'].map((k) => esc(ms(s.ttfb[k])))],
    ], [1, 2, 3, 4, 5, 6, 7])}`,
    s.checks && s.checks.length ? `<h2>Checks</h2>${table(['Check', 'Passed', 'Failed', 'Rate'], s.checks.map((c) => [esc(c.name), num(c.passed, 0), num(c.failed, 0), `<span class="${c.failed ? 'fail' : 'pass'}">${num(pct(c.passed, c.passed + c.failed), 2)} %</span>`]), [1, 2, 3])}` : '',
    `<h2>Status codes</h2>${table(['Status', 'Count', 'Share'], Object.entries(s.statusCodes || {}).sort().map(([k, v]) => [esc(k), num(v, 0), `${num(pct(v, s.requests), 2)} %`]), [1, 2])}`,
    Object.keys(s.errorKinds || {}).length ? `<h2>Errors</h2>${table(['Kind', 'Count'], Object.entries(s.errorKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), num(v, 0)]), [1])}
      ${s.errorSamples && s.errorSamples.length ? `<h2>Error samples</h2>${table(['Step', 'Error', 'Detail'], s.errorSamples.map((e) => [esc(e.step), esc(e.error), `<code>${esc(e.detail)}</code>`]))}` : ''}` : '',
    `<h2>Test</h2>${table(['Phase', 'Duration', result.model === 'open' ? 'Rate (req/s)' : 'Users'], (result.phases || []).map((p) => [esc(p.name), esc(fmtDuration(p.durationMs)), esc(p.from === p.to ? p.from : `${p.from} → ${p.to}`)]), [2])}
     ${table(['Step', 'Method', 'URL'], (result.steps || []).map((x) => [esc(x.name), esc(x.method), `<code>${esc(x.url)}</code>`]))}
     <p class="sub">Iterations ${num(s.iterations, 0)} · interrupted ${num(s.interrupted, 0)} · dropped ${num(s.dropped, 0)} · sent ${fmtBytes(s.bytesOut)}${s.missingVariables && s.missingVariables.length ? ` · unknown variables: ${esc(s.missingVariables.join(', '))}` : ''}</p>`,
  ].join('\n');
  return page(`${result.name} - load test report`, body);
}

// ---------------------------------------------------------------------------------------------- compare
const COMPARE_ROWS = [
  ['Requests/s', (s) => s.rps, 'higher'], ['p50 (ms)', (s) => s.latency.p50, 'lower'], ['p90 (ms)', (s) => s.latency.p90, 'lower'],
  ['p95 (ms)', (s) => s.latency.p95, 'lower'], ['p99 (ms)', (s) => s.latency.p99, 'lower'], ['Max (ms)', (s) => s.latency.max, 'lower'],
  ['Mean (ms)', (s) => s.latency.mean, 'lower'], ['Errors (%)', (s) => pct(s.failed, s.requests), 'lower'], ['Requests', (s) => s.requests, ''],
  ['Checks passed (%)', (s) => (s.checksTotal ? pct(s.checksPassed, s.checksTotal) : null), 'higher'], ['Peak users', (s) => s.peakVus, ''],
];

/** [{ metric, a, b, delta, deltaPct, better: 'a'|'b'|'' }] */
function compareRows(a, b) {
  return COMPARE_ROWS.map(([metric, f, good]) => {
    const x = f(a.summary), y = f(b.summary);
    const delta = x == null || y == null ? null : y - x;
    const deltaPct = delta == null || !x ? null : (100 * delta) / x;
    let better = '';
    if (good && delta && Math.abs(deltaPct == null ? 100 : deltaPct) >= 1) better = (good === 'lower') === delta < 0 ? 'b' : 'a';
    return { metric, a: x, b: y, delta, deltaPct, better, good };
  });
}

function percentileCurve(result) {
  const h = Histogram.fromJSON(result.histogram);
  return [0, 10, 25, 50, 75, 90, 95, 97.5, 99, 99.5, 99.9].map((p, i) => [i, h.percentile(p) / 1000]);
}

function compareHtml(a, b) {
  const rows = compareRows(a, b);
  const label = (r) => `${r.name} · ${r.startedAt ? new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 16) : ''}`;
  const body = [
    `<h1>Compare two load test runs</h1>`,
    `<p class="sub">A: ${esc(label(a))}<br>B: ${esc(label(b))}</p>`,
    table(['Metric', 'A', 'B', 'Change'], rows.map((r) => [
      esc(r.metric), num(r.a, 2), num(r.b, 2),
      r.delta == null ? '-' : `<span class="${r.better === 'b' ? 'down' : r.better === 'a' ? 'up' : ''}">${r.delta > 0 ? '+' : ''}${num(r.delta, 2)}${r.deltaPct == null ? '' : ` (${r.deltaPct > 0 ? '+' : ''}${num(r.deltaPct, 1)} %)`}</span>`]), [1, 2, 3]),
    '<p class="sub">Green: B is better. Red: B is worse. Changes under 1 % are not colored.</p>',
    lineChart({ title: 'Latency by percentile (x: p0, p10, p25, p50, p75, p90, p95, p97.5, p99, p99.5, p99.9)', yUnit: ' ms', xUnit: '', series: [
      { name: 'A', color: 'var(--s2)', points: percentileCurve(a), dash: true }, { name: 'B', color: 'var(--s1)', points: percentileCurve(b) }] }),
    lineChart({ title: 'Requests per second', series: [
      { name: 'A', color: 'var(--s2)', points: (a.timeline || []).map((s) => [s.t, s.rps]), dash: true }, { name: 'B', color: 'var(--s1)', points: (b.timeline || []).map((s) => [s.t, s.rps]) }] }),
    lineChart({ title: 'p95 latency per second', yUnit: ' ms', series: [
      { name: 'A', color: 'var(--s2)', points: (a.timeline || []).map((s) => [s.t, s.p95]), dash: true }, { name: 'B', color: 'var(--s1)', points: (b.timeline || []).map((s) => [s.t, s.p95]) }] }),
  ].join('\n');
  return page('Compare load test runs', body);
}

/** Trend of many runs of one test, oldest first (Pro candidate). */
function historyHtml(runs) {
  const pts = (f) => runs.map((r, i) => [i + 1, f(r.summary)]);
  const body = [
    `<h1>Run history: ${esc(runs.length ? runs[runs.length - 1].name : '')}</h1>`,
    `<p class="sub">${runs.length} runs, oldest first.</p>`,
    lineChart({ title: 'Latency', yUnit: ' ms', xUnit: '', series: [
      { name: 'p50', color: 'var(--s4)', points: pts((s) => s.latency.p50) }, { name: 'p95', color: 'var(--s1)', points: pts((s) => s.latency.p95) },
      { name: 'p99', color: 'var(--s3)', points: pts((s) => s.latency.p99) }] }),
    lineChart({ title: 'Requests per second', xUnit: '', series: [{ name: 'requests/s', color: 'var(--s1)', points: pts((s) => s.rps) }] }),
    lineChart({ title: 'Errors (%)', xUnit: '', series: [{ name: 'errors', color: 'var(--s5)', points: pts((s) => pct(s.failed, s.requests)) }] }),
    table(['#', 'Started', 'Requests/s', 'p95', 'Errors', 'Result'], runs.map((r, i) => [String(i + 1), esc(r.startedAt ? r.startedAt.replace('T', ' ').slice(0, 16) : ''),
      num(r.summary.rps, 1), esc(ms(r.summary.latency.p95)), `${num(pct(r.summary.failed, r.summary.requests), 2)} %`,
      r.thresholds && r.thresholds.length ? `<b class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}</b>` : '-']), [2, 3, 4]),
  ].join('\n');
  return page('Load test history', body);
}

/** Checks a parsed run file before it is used. */
function isRun(o) {
  return !!(o && typeof o === 'object' && o.v === 1 && o.summary && o.summary.latency && typeof o.summary.requests === 'number');
}

function fileStem(name, date = new Date()) {
  const slug = String(name || 'load-test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'load-test';
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { htmlReport, compareHtml, compareRows, historyHtml, lineChart, isRun, fileStem, fmtBytes, esc };
