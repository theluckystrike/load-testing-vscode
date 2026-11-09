'use strict';
// Worker thread for everything heavy, so the editor's extension host thread stays free:
//   { type: 'start', spec, allowedHosts, rows }  runs a load test; { type: 'stop' } stops it.
//     out: { type: 'tick', ... } once a second, { type: 'done', result }, { type: 'fatal', message }
//   { type: 'import', kind, file, maxBytes }  reads and parses a HAR, OpenAPI, JMeter, .http or CSV file.
//     out: { type: 'imported', result } or { type: 'fatal', message }
//   { type: 'demo' }  starts the demo API on 127.0.0.1. out: { type: 'demo', url, host }
const { parentPort } = require('worker_threads');
const fs = require('fs');
const { Engine } = require('./engine');

let engine = null;
let demo = null;

async function readLimited(file, maxBytes) {
  const st = await fs.promises.stat(file);
  if (st.size > maxBytes) {
    const mb = (n) => Math.round(n / 1048576);
    throw new Error(`The file is ${mb(st.size)} MB. Files up to ${mb(maxBytes)} MB are read (setting loadTesting.maxImportMB). Nothing was imported.`);
  }
  return fs.promises.readFile(file, 'utf8');
}

async function doImport(m) {
  const I = require('../core/importers');
  const text = await readLimited(m.file, m.maxBytes);
  switch (m.kind) {
    case 'har': return I.fromHar(text);
    case 'openapi': return I.fromOpenApi(text);
    case 'jmx': return I.fromJmx(text);
    case 'http': return I.fromHttpFile(text);
    case 'csv': {
      const r = require('../core/csv').parseCsv(text, { maxRows: m.maxRows || 1000000 });
      return { rows: r.rows, columns: r.columns, truncated: r.truncated };
    }
    default: throw new Error('Unknown import kind.');
  }
}

parentPort.on('message', async (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'start' && !engine) {
    try {
      engine = new Engine(m.spec, { allowedHosts: m.allowedHosts, rows: m.rows, onTick: (t) => parentPort.postMessage({ type: 'tick', ...t }) });
      const result = await engine.start();
      parentPort.postMessage({ type: 'done', result });
    } catch (e) {
      parentPort.postMessage({ type: 'fatal', message: String((e && e.message) || e) });
    }
  } else if (m.type === 'stop' && engine) {
    engine.stop();
  } else if (m.type === 'import') {
    try { parentPort.postMessage({ type: 'imported', result: await doImport(m) }); } catch (e) { parentPort.postMessage({ type: 'fatal', message: String((e && e.message) || e) }); }
  } else if (m.type === 'demo' && !demo) {
    try {
      demo = await require('../core/demoapi').startDemoServer({ latencyMs: 6, jitterMs: 14, errorRate: 0.002 });
      parentPort.postMessage({ type: 'demo', url: demo.url, host: demo.host });
    } catch (e) { parentPort.postMessage({ type: 'fatal', message: String((e && e.message) || e) }); }
  } else if (m.type === 'demoCounts' && demo) {
    parentPort.postMessage({ type: 'demoCounts', counts: demo.counts });
  }
});
