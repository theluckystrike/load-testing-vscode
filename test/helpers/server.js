'use strict';
// Local test API for the unit tests, the real VS Code gate and the README screenshots. node:http only.
// Routes:
//   GET  /api/health                    200 {"status":"ok"}
//   GET  /api/orders?limit=n            200 JSON list, latency set by the server options (fixed + random)
//   GET  /api/slow?ms=n                 200 after n ms
//   GET  /api/flaky?rate=0.1            500 for that share of requests, else 200
//   POST /api/login                     200 {"token":"t-<n>"} (body: {"user": "..."})
//   GET  /api/me                        200 when "authorization: Bearer t-..." is sent, else 401
//   GET  /api/never                     never answers (timeouts)
//   GET  /api/midbody                   sends half a body, then closes the connection
//   GET  /api/big?mb=50                 a body of that many MB, streamed
// Every request is counted (total and per path), so a test can compare the engine's count with the server's.
const http = require('http');
const https = require('https');
const { createApi } = require('../../src/core/demoapi');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function startHttp(opts) {
  const api = createApi(opts);
  const server = http.createServer({ keepAliveTimeout: 30000 }, api.handler);
  server.maxConnections = 10000;
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, counts: api.counts, server, close: () => closeServer(server, api) };
}

async function startHttps({ key, cert, ...opts }) {
  const api = createApi(opts);
  const server = https.createServer({ key, cert }, api.handler);
  const port = await listen(server);
  return { port, url: `https://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, counts: api.counts, server, close: () => closeServer(server, api) };
}

function closeServer(server, api) {
  for (const r of api.held) { try { r.destroy(); } catch (e) { /* ignore */ } }
  if (server.closeAllConnections) server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

module.exports = { startHttp, startHttps };

// node test/helpers/server.js [port]  -> runs the API until killed (used by the gate and the screenshots).
if (require.main === module) {
  const port = Number(process.argv[2] || 0);
  const api = createApi({ latencyMs: Number(process.env.LAT || 8), jitterMs: Number(process.env.JIT || 12), errorRate: Number(process.env.ERR || 0) });
  const server = http.createServer({ keepAliveTimeout: 30000 }, api.handler);
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: server.address().port }));
  });
  let open = 0;
  const write = () => { if (process.env.COUNTS_FILE) require('fs').writeFileSync(process.env.COUNTS_FILE + '.tmp', JSON.stringify({ total: api.counts.total, byPath: api.counts.byPath, open, serverP95: Object.fromEntries(Object.entries(api.counts.latency).map(([k, v]) => { const a = v.slice().sort((x, y) => x - y); return [k, { n: a.length, p50: a[Math.ceil(a.length * 0.5) - 1], p95: a[Math.ceil(a.length * 0.95) - 1] }]; })) })); if (process.env.COUNTS_FILE) require('fs').renameSync(process.env.COUNTS_FILE + '.tmp', process.env.COUNTS_FILE); };
  setInterval(() => server.getConnections((e, n) => { open = n || 0; write(); }), 250).unref();
  process.on('SIGTERM', () => { write(); process.exit(0); });
}
