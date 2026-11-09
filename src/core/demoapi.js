'use strict';
// A small local JSON API on 127.0.0.1 for trying the extension with no server of your own ("Try It on a Demo
// Server"), and for the tests. node:http only. It listens on 127.0.0.1 with a random port and stops when the
// run ends or VS Code closes. Routes:
//   GET  /api/health                    200 {"status":"ok"}
//   GET  /api/orders?limit=n            200 JSON list, latency set by the options (fixed + random)
//   GET  /api/slow?ms=n                 200 after n ms
//   GET  /api/flaky?rate=0.1            500 for that share of requests, else 200
//   POST /api/login                     200 {"token":"t-<n>"} (body: {"user": "..."})
//   GET  /api/me                        200 when "authorization: Bearer t-..." is sent, else 401
//   GET  /api/never                     never answers (timeouts)
//   GET  /api/midbody                   sends part of a body, then closes the connection
//   GET  /api/big?mb=50                 a body of that many MB, streamed
// Every request is counted (total and per path), so a test can compare the engine's count with the server's.
const http = require('http');

function createApi({ latencyMs = 0, jitterMs = 0, errorRate = 0 } = {}) {
  const counts = { total: 0, byPath: {}, latency: {} }; // latency: server-side handling time (ms) per path, last 100,000
  const held = new Set();
  let login = 0;
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const l = counts.latency[u.pathname] || (counts.latency[u.pathname] = []);
      if (l.length < 100000) l.push(Number(process.hrtime.bigint() - t0) / 1e6);
    });
    counts.total++;
    counts.byPath[u.pathname] = (counts.byPath[u.pathname] || 0) + 1;
    const json = (code, obj, delay = 0) => {
      const send = () => { if (res.destroyed) return; const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); };
      delay > 0 ? setTimeout(send, delay) : send();
    };
    const base = () => latencyMs + (jitterMs ? Math.random() * jitterMs : 0);
    let body = '';
    req.on('data', (c) => { if (body.length < 65536) body += c; });
    req.on('end', () => {
      switch (u.pathname) {
        case '/api/health': return json(200, { status: 'ok' });
        case '/api/orders': {
          if (errorRate && Math.random() < errorRate) return json(500, { error: 'internal' }, base());
          const n = Math.min(Number(u.searchParams.get('limit') || 5), 100);
          return json(200, { status: 'ok', items: Array.from({ length: n }, (_, i) => ({ id: i + 1, sku: 'SKU-' + (i + 1), qty: 1 + (i % 3) })) }, base());
        }
        case '/api/slow': return json(200, { status: 'ok' }, Number(u.searchParams.get('ms') || 100));
        case '/api/flaky': return Math.random() < Number(u.searchParams.get('rate') || 0.1) ? json(500, { error: 'flaky' }, base()) : json(200, { status: 'ok' }, base());
        case '/api/login': {
          let user = '';
          try { user = JSON.parse(body || '{}').user || ''; } catch (e) { /* ignore */ }
          return user ? json(200, { token: 't-' + (++login), user }) : json(400, { error: 'user missing' });
        }
        case '/api/me': return /^Bearer t-\d+$/.test(req.headers.authorization || '') ? json(200, { status: 'ok', me: true }) : json(401, { error: 'no token' });
        case '/api/never': held.add(res); res.on('close', () => held.delete(res)); return; // never answers
        case '/api/midbody': {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2000 });
          res.write('{"items":[' + '1,'.repeat(300));
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        case '/api/big': {
          const mb = Math.min(Number(u.searchParams.get('mb') || 1), 200);
          const chunk = Buffer.alloc(65536, 0x61);
          let left = mb * 1048576;
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': left });
          const pump = () => {
            while (left > 0) {
              const n = Math.min(left, chunk.length); left -= n;
              if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { res.once('drain', pump); return; }
            }
            res.end();
          };
          return pump();
        }
        default: return json(404, { error: 'not found' });
      }
    });
  };
  return { handler, counts, held };
}


/** Starts the API on 127.0.0.1. Returns { port, url, host, counts, close() }. */
function startDemoServer(opts = {}) {
  const api = createApi(opts);
  const server = http.createServer({ keepAliveTimeout: 30000 }, api.handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, counts: api.counts, server,
        close: () => { for (const r of api.held) { try { r.destroy(); } catch (e) { /* ignore */ } } if (server.closeAllConnections) server.closeAllConnections(); return new Promise((r) => server.close(() => r())); } });
    });
  });
}

module.exports = { createApi, startDemoServer };
