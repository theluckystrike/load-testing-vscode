#!/usr/bin/env node
'use strict';
// Runs a load test file outside VS Code, for CI. Plain Node 18+, nothing to install: it uses the same engine,
// parser and report code as the extension (this repository's src/ and vendor/ folders).
//   node scripts/ci-run.js tests/checkout.load.yaml [--out load-test-results] [--max-vus 200]
// Exit code: 0 when every threshold passes, 1 when one fails, 2 when the test file has a problem.
// Network: only the hosts in the test file. In CI there is no confirmation dialog, so the hosts are printed first.
const fs = require('fs');
const path = require('path');
const { validate, fmtDuration } = require('../src/core/spec');
const { Engine } = require('../src/engine/engine');
const { parseCsv } = require('../src/core/csv');
const report = require('../src/core/report');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!file) { console.error('Usage: node scripts/ci-run.js <test.load.yaml> [--out dir] [--max-vus n]'); process.exit(2); }
const v = validate(fs.readFileSync(file, 'utf8'), { maxVus: Number(opt('max-vus', 200)), maxRate: 50000, maxDurationMs: 24 * 3600000 });
if (!v.ok) { for (const e of v.errors) console.error(`${file}:${e.line + 1}: ${e.message}`); process.exit(2); }
const s = v.spec;
if (s.hosts.includes('?')) { console.error('A request URL takes its host from a run-time value. Put the host in target or variables.'); process.exit(2); }
let rows = null;
if (s.data) rows = parseCsv(fs.readFileSync(path.resolve(path.dirname(file), s.data.file), 'utf8')).rows;
console.log(`${s.name}: ${s.model === 'open' ? `up to ${s.peakRate} req/s` : `up to ${s.maxVus} users`} for ${fmtDuration(s.totalMs)} -> ${s.hosts.join(', ')}`);
const engine = new Engine(s, { rows, onTick: ({ tick }) => console.log(`  ${String(tick.t).padStart(6)} s  ${String(tick.rps).padStart(8)} req/s  p95 ${tick.p95} ms  failed ${tick.failed}`) });
process.on('SIGINT', () => engine.stop());
engine.start().then((r) => {
  const out = opt('out', path.join(path.dirname(file), 'load-test-results'));
  fs.mkdirSync(out, { recursive: true });
  const stem = path.join(out, report.fileStem(r.name, new Date(r.startedAt)));
  fs.writeFileSync(stem + '.json', JSON.stringify(r));
  fs.writeFileSync(stem + '.html', report.htmlReport(r));
  const L = r.summary.latency;
  console.log(`requests ${r.summary.requests}, ${r.summary.rps} req/s, p50 ${L.p50} ms, p95 ${L.p95} ms, p99 ${L.p99} ms, failed ${r.summary.failed}`);
  for (const t of r.thresholds) console.log(`  ${t.pass ? 'pass' : 'FAIL'}  ${t.text}  (measured ${t.actual}${t.unit ? ' ' + t.unit : ''})`);
  console.log(`report: ${stem}.html`);
  process.exit(r.pass ? 0 : 1);
});
