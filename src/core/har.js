'use strict';
// Copied unchanged from factory/products/har-viewer-vscode/src/core/har.js (same author, MIT). The load test import uses parseHar and classify.
// HAR 1.2 reading, summaries, filters, the sensitive-data scan, redaction, export and Copy as cURL / fetch.
// Pure functions with no vscode import, so the tests and the webview bundle can use them.

const TYPES = ['doc', 'xhr', 'js', 'css', 'img', 'font', 'media', 'ws', 'other'];
const TYPE_LABELS = { doc: 'Doc', xhr: 'Fetch/XHR', js: 'JS', css: 'CSS', img: 'Img', font: 'Font', media: 'Media', ws: 'WS', other: 'Other' };
const TIMING_KEYS = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];
const REDACTED = '[REDACTED]';

// Header names whose whole value is a secret.
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-auth-token', 'x-access-token',
  'x-csrf-token', 'x-xsrf-token', 'x-amz-security-token', 'x-goog-api-key', 'x-session-id', 'x-refresh-token', 'private-token',
  'x-gitlab-token', 'x-github-token', 'ocp-apim-subscription-key']);
// Headers that carry cookies: names are kept, values are replaced.
// Headers that hold a URL or a path whose query can carry a token.
const URL_HEADERS = new Set([':path', 'referer', 'location', 'content-location']);
// Query, form and JSON field names that usually hold a secret.
const SECRET_KEY = /^(access[_-]?token|id[_-]?token|refresh[_-]?token|auth[_-]?token|token|bearer|jwt|session[_-]?(id|token)?|sid|ssid|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|pwd|pass|passcode|otp|pin|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|code_verifier|auth|authorization|credentials?|private[_-]?key|csrf[_-]?token|xsrf[_-]?token|_csrf)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : -1; }
function lc(s) { return String(s == null ? '' : s).toLowerCase(); }
function arr(v) { return Array.isArray(v) ? v : []; }

/** Parse HAR text. Throws an Error with a plain message when the text is not a HAR. */
function parseHar(text) {
  let s = typeof text === 'string' ? text : Buffer.from(text).toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let har;
  try { har = JSON.parse(s); } catch (e) {
    throw new Error(`This file is not valid JSON, so it can't be read as a HAR. ${e.message}`);
  }
  if (!har || typeof har !== 'object' || !har.log || typeof har.log !== 'object') throw new Error('This JSON has no "log" object, so it is not a HAR file.');
  if (!Array.isArray(har.log.entries)) throw new Error('This HAR has no "log.entries" list.');
  return har;
}

function pathName(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs.length ? decodeSafe(segs[segs.length - 1]) : (u.host || url);
    return { host: u.host, name: last + (u.search ? u.search : '') || '/', path: u.pathname + u.search, scheme: u.protocol.replace(':', '') };
  } catch {
    return { host: '', name: String(url || ''), path: String(url || ''), scheme: '' };
  }
}
function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** Resource type of an entry: one of TYPES. Uses Chrome's _resourceType, then the MIME type, then the URL. */
function classify(e) {
  const rt = lc(e._resourceType);
  if (rt) {
    if (rt === 'document') return 'doc';
    if (rt === 'xhr' || rt === 'fetch' || rt === 'eventsource' || rt === 'preflight') return 'xhr';
    if (rt === 'script') return 'js';
    if (rt === 'stylesheet') return 'css';
    if (rt === 'image') return 'img';
    if (rt === 'font') return 'font';
    if (rt === 'media') return 'media';
    if (rt === 'websocket') return 'ws';
    if (rt !== 'other' && rt !== 'manifest' && rt !== 'ping' && rt !== 'texttrack') return 'other';
  }
  const req = e.request || {};
  const res = e.response || {};
  const url = String(req.url || '');
  if (/^wss?:/i.test(url) || arr(e._webSocketMessages).length) return 'ws';
  if (arr(req.headers).some((h) => lc(h.name) === 'upgrade' && lc(h.value) === 'websocket')) return 'ws';
  const mime = lc((res.content && res.content.mimeType) || '').split(';')[0].trim();
  if (mime) {
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'doc';
    if (/javascript|ecmascript/.test(mime)) return 'js';
    if (mime === 'text/css') return 'css';
    if (mime.startsWith('image/')) return 'img';
    if (mime.startsWith('font/') || /font|woff|opentype|truetype/.test(mime)) return 'font';
    if (mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/vnd.apple.mpegurl' || mime === 'application/dash+xml') return 'media';
    if (/json|xml|text\/plain|x-www-form-urlencoded|grpc|protobuf|event-stream|graphql/.test(mime)) return 'xhr';
  }
  const ext = (pathName(url).path.split('?')[0].match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  if (ext) {
    const x = ext.toLowerCase();
    if (['html', 'htm'].includes(x)) return 'doc';
    if (['js', 'mjs', 'cjs'].includes(x)) return 'js';
    if (x === 'css') return 'css';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(x)) return 'img';
    if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(x)) return 'font';
    if (['mp4', 'webm', 'mp3', 'ogg', 'wav', 'm3u8', 'ts', 'm4s', 'aac'].includes(x)) return 'media';
    if (['json', 'xml'].includes(x)) return 'xhr';
  }
  return 'other';
}

function headerValue(headers, name) {
  const n = lc(name);
  const h = arr(headers).find((x) => lc(x && x.name) === n);
  return h ? String(h.value == null ? '' : h.value) : '';
}

/** Phases in ms, never negative. HAR counts ssl inside connect, so connect here is the part without TLS. */
function timings(e) {
  const t = e.timings || {};
  const v = TIMING_KEYS.map((k) => Math.max(0, num(t[k])));
  const ssl = v[3];
  if (ssl > 0 && v[2] >= ssl) v[2] -= ssl;
  return v;
}

function transferSize(e) {
  const res = e.response || {};
  const t = num(res._transferSize);
  if (t >= 0) return t;
  const b = num(res.bodySize);
  const h = num(res.headersSize);
  if (b >= 0 || h >= 0) return Math.max(0, b) + Math.max(0, h);
  return Math.max(0, num(res.content && res.content.size));
}

function isFailed(e) {
  const s = num(e.response && e.response.status);
  return s <= 0 || s >= 400 || !!(e.response && e.response._error) || !!e._error;
}

function live(v) { const s = String(v == null ? '' : v); return s !== '' && !s.includes(REDACTED) && !s.includes(encodeURIComponent(REDACTED)); }
function cookieHeaderLive(v) { return String(v || '').split(/;\s*/).some((p) => { const k = p.indexOf('='); return k > 0 && live(p.slice(k + 1)); }); }
const BODY_SECRET_JSON = /"(password|passwd|access_token|refresh_token|id_token|client_secret|api_?key|token)"\s*:\s*"(?!\[REDACTED\])[^"]/i;
const BODY_SECRET_FORM = /(^|&)(password|passwd|access_token|refresh_token|client_secret|api_?key|token)=(?!%5BREDACTED%5D|\[REDACTED\])[^&]/i;

/** What kinds of secrets one entry holds. Values that are already [REDACTED] don't count. */
function entrySensitive(e) {
  const req = e.request || {};
  const res = e.response || {};
  const out = { auth: 0, cookie: 0, setCookie: 0, query: 0, token: 0 };
  for (const h of arr(req.headers)) {
    const n = lc(h && h.name);
    const v = h && h.value;
    if (n === 'authorization' || n === 'proxy-authorization') { if (live(v)) out.auth++; } else if (n === 'cookie') { if (cookieHeaderLive(v)) out.cookie++; } else if ((SECRET_HEADERS.has(n) && live(v)) || JWT.test(String(v))) out.token++;
  }
  if (!out.cookie && arr(req.cookies).some((c) => live(c && c.value))) out.cookie++;
  for (const h of arr(res.headers)) if (lc(h && h.name) === 'set-cookie' && cookieHeaderLive(String(h.value || '').split(';')[0])) out.setCookie++;
  if (!out.setCookie && arr(res.cookies).some((c) => live(c && c.value))) out.setCookie++;
  for (const q of arr(req.queryString)) if ((SECRET_KEY.test(String(q && q.name)) && live(q && q.value)) || JWT.test(String(q && q.value))) out.query++;
  const pd = req.postData;
  if (pd) {
    if (arr(pd.params).some((p) => SECRET_KEY.test(String(p && p.name)) && live(p && p.value))) out.token++;
    else if (typeof pd.text === 'string' && pd.text.length < 2e6 && (JWT.test(pd.text) || BODY_SECRET_JSON.test(pd.text) || BODY_SECRET_FORM.test(pd.text))) out.token++;
  }
  return out;
}

/** Counts for the warning banner. */
function scanSensitive(har) {
  const r = { auth: 0, cookie: 0, setCookie: 0, query: 0, token: 0, entries: 0 };
  for (const e of arr(har.log && har.log.entries)) {
    const s = entrySensitive(e);
    let any = false;
    for (const k of ['auth', 'cookie', 'setCookie', 'query', 'token']) { r[k] += s[k]; if (s[k]) any = true; }
    if (any) r.entries++;
  }
  r.any = r.entries > 0;
  return r;
}

function sensitiveText(s) {
  if (!s || !s.any) return '';
  const parts = [];
  if (s.auth) parts.push(`${s.auth} Authorization header${s.auth === 1 ? '' : 's'}`);
  if (s.cookie) parts.push(`cookies in ${s.cookie} request${s.cookie === 1 ? '' : 's'}`);
  if (s.setCookie) parts.push(`${s.setCookie} Set-Cookie response${s.setCookie === 1 ? '' : 's'}`);
  if (s.query) parts.push(`${s.query} token${s.query === 1 ? '' : 's'} in URLs`);
  if (s.token) parts.push(`${s.token} other secret${s.token === 1 ? '' : 's'} in headers or bodies`);
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
  return `This HAR holds ${list} (${s.entries} request${s.entries === 1 ? '' : 's'}). Anyone who gets the file can use them. Share a redacted copy instead.`;
}

/** One small row per entry for the table. t0 = earliest start in ms since epoch. */
function summarize(har, slowMs) {
  const entries = arr(har.log && har.log.entries);
  const starts = entries.map((e) => Date.parse(e && e.startedDateTime));
  let t0 = Infinity;
  for (const s of starts) if (Number.isFinite(s) && s < t0) t0 = s;
  if (!Number.isFinite(t0)) t0 = 0;
  const slow = slowMs > 0 ? slowMs : 1000;
  const rows = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const req = e.request || {};
    const res = e.response || {};
    const p = pathName(req.url);
    const time = Math.max(0, num(e.time));
    const sens = entrySensitive(e);
    const status = num(res.status);
    rows[i] = {
      i,
      method: String(req.method || 'GET').toUpperCase(),
      url: String(req.url || ''),
      host: p.host,
      name: p.name,
      status: status < 0 ? 0 : status,
      statusText: String(res.statusText || (res._error ? res._error : '') || ''),
      type: classify(e),
      mime: String((res.content && res.content.mimeType) || '').split(';')[0].trim(),
      size: transferSize(e),
      csize: Math.max(0, num(res.content && res.content.size)),
      start: Number.isFinite(starts[i]) ? Math.max(0, starts[i] - t0) : 0,
      time,
      t: timings(e),
      failed: isFailed(e),
      slow: time >= slow,
      sens: sens.auth + sens.cookie + sens.setCookie + sens.query + sens.token > 0,
      page: String(e.pageref || ''),
    };
  }
  return { rows, t0 };
}

function pctl(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]; }

/** Totals for a list of rows (all or filtered). */
function totals(rows, ids) {
  const list = ids ? ids.map((i) => rows[i]) : rows;
  let size = 0; let csize = 0; let end = 0; let failed = 0; let slow = 0; let begin = Infinity; let slowest = null;
  const times = [];
  for (const r of list) {
    size += r.size; csize += r.csize;
    if (r.start < begin) begin = r.start;
    if (r.start + r.time > end) end = r.start + r.time;
    if (r.failed) failed++;
    if (r.slow) slow++;
    if (!slowest || r.time > slowest.time) slowest = r;
    times.push(r.time);
  }
  times.sort((a, b) => a - b);
  return { count: list.length, size, csize, span: list.length ? end - begin : 0, finish: end, failed, slow, slowest: slowest ? { i: slowest.i, time: slowest.time, name: slowest.name } : null, p50: pctl(times, 0.5), p95: pctl(times, 0.95) };
}

function domains(rows) {
  const m = new Map();
  for (const r of rows) if (r.host) m.set(r.host, (m.get(r.host) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([host, count]) => ({ host, count }));
}

function statusMatch(r, s) {
  switch (s) {
    case '2xx': return r.status >= 200 && r.status < 300;
    case '3xx': return r.status >= 300 && r.status < 400;
    case '4xx': return r.status >= 400 && r.status < 500;
    case '5xx': return r.status >= 500 && r.status < 600;
    case 'failed': return r.failed;
    case 'slow': return r.slow;
    case 'sensitive': return r.sens;
    default: return true;
  }
}

/**
 * Indices of rows that pass the filter, in the asked order.
 * f: { types: string[] (empty = all), status: 'all'|'2xx'|'3xx'|'4xx'|'5xx'|'failed'|'slow'|'sensitive', domain: '', text: '', sort: 'start'|'time'|'size'|'status'|'name'|'method'|'type', desc: bool }
 * text: words that must all appear in the URL, method, status, type or MIME type. A word that starts with - must not appear.
 */
function filterRows(rows, f) {
  const o = f || {};
  const types = new Set(arr(o.types).filter((t) => TYPES.includes(t)));
  const words = String(o.text || '').toLowerCase().split(/\s+/).filter(Boolean);
  const pos = words.filter((w) => !(w.startsWith('-') && w.length > 1));
  const neg = words.filter((w) => w.startsWith('-') && w.length > 1).map((w) => w.slice(1));
  const status = o.status || 'all';
  const domain = String(o.domain || '');
  const out = [];
  for (const r of rows) {
    if (types.size && !types.has(r.type)) continue;
    if (!statusMatch(r, status)) continue;
    if (domain && r.host !== domain) continue;
    if (words.length) {
      const hay = `${r.url} ${r.method} ${r.status || 'failed'} ${TYPE_LABELS[r.type]} ${r.mime} ${r.statusText}`.toLowerCase();
      if (!pos.every((w) => hay.includes(w)) || neg.some((w) => hay.includes(w))) continue;
    }
    out.push(r.i);
  }
  const key = o.sort || 'start';
  if (key !== 'start' || o.desc) {
    const get = {
      start: (r) => r.start, time: (r) => r.time, size: (r) => r.size, status: (r) => r.status,
      name: (r) => r.name.toLowerCase(), method: (r) => r.method, type: (r) => r.type,
    }[key] || ((r) => r.start);
    const dir = o.desc ? -1 : 1;
    out.sort((a, b) => {
      const x = get(rows[a]); const y = get(rows[b]);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (a - b);
    });
  }
  return out;
}

// ---- bodies ----

function isTextMime(m) {
  return /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|yaml|svg|html/.test(lc(m));
}
const IMAGE_MIMES = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;

function decodeText(text, encoding) {
  if (lc(encoding) === 'base64') {
    try { return Buffer.from(String(text), 'base64').toString('utf8'); } catch { return String(text); }
  }
  return String(text);
}

function prettyJson(s) {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
}

function formPairs(s) {
  const out = [];
  for (const part of String(s).split('&')) {
    if (!part) continue;
    const k = part.indexOf('=');
    const name = k < 0 ? part : part.slice(0, k);
    const value = k < 0 ? '' : part.slice(k + 1);
    const d = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    out.push({ name: d(name), value: d(value) });
  }
  return out;
}

function cut(s, maxChars) {
  if (s.length <= maxChars) return { text: s, truncated: false, full: s.length };
  return { text: s.slice(0, maxChars), truncated: true, full: s.length };
}

/**
 * What the details pane shows for a body.
 * kind: 'empty' | 'json' | 'text' | 'form' | 'image' | 'binary'.
 */
function bodyView(mimeType, text, encoding, maxChars, declaredSize) {
  const mime = lc(mimeType).split(';')[0].trim();
  const max = maxChars > 0 ? maxChars : 1024 * 1024;
  if (text == null || text === '') return { kind: 'empty', mime, size: Math.max(0, num(declaredSize)) };
  if (IMAGE_MIMES.test(mime)) {
    const b64 = lc(encoding) === 'base64' ? String(text).replace(/\s+/g, '') : Buffer.from(String(text), 'utf8').toString('base64');
    if (b64.length <= max * 4) return { kind: 'image', mime, dataUri: `data:${mime};base64,${b64}`, size: Math.floor(b64.length * 3 / 4) };
    return { kind: 'binary', mime, size: Math.floor(b64.length * 3 / 4), note: 'This image is larger than the harViewer.maxBodyKB setting.' };
  }
  if (lc(encoding) === 'base64' && !isTextMime(mime)) return { kind: 'binary', mime, size: Math.floor(String(text).length * 3 / 4) };
  const s = decodeText(text, encoding);
  if (mime === 'application/x-www-form-urlencoded') return { kind: 'form', mime, pairs: formPairs(s).slice(0, 2000), raw: cut(s, max) };
  if (/json/.test(mime) || (!mime && /^\s*[{[]/.test(s)) || (/^text\/plain/.test(mime) && /^\s*[{[]/.test(s))) {
    const p = s.length <= 20e6 ? prettyJson(s) : null;
    if (p != null) return { kind: 'json', mime, ...cut(p, max) };
  }
  if (!isTextMime(mime) && mime && /[\u0000-\u0008\u000e-\u001f]/.test(s.slice(0, 2000))) return { kind: 'binary', mime, size: s.length };
  return { kind: 'text', mime, ...cut(s, max) };
}

function requestBody(e, maxChars) {
  const pd = e.request && e.request.postData;
  if (!pd) return { kind: 'empty', mime: '', size: 0 };
  if ((pd.text == null || pd.text === '') && arr(pd.params).length) {
    return { kind: 'form', mime: lc(pd.mimeType), pairs: arr(pd.params).map((p) => ({ name: String(p.name || ''), value: p.fileName ? `(file ${p.fileName})` : String(p.value == null ? '' : p.value) })) };
  }
  return bodyView(pd.mimeType || '', pd.text, pd.encoding, maxChars, e.request.bodySize);
}

function responseBody(e, maxChars) {
  const c = (e.response && e.response.content) || {};
  return bodyView(c.mimeType || '', c.text, c.encoding, maxChars, c.size);
}

function nv(list) { return arr(list).map((h) => ({ name: String((h && h.name) || ''), value: String(h && h.value != null ? h.value : '') })); }

function cookieList(list) {
  return arr(list).map((c) => ({ name: String(c.name || ''), value: String(c.value == null ? '' : c.value), path: c.path || '', domain: c.domain || '', expires: c.expires || '', httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || '' }));
}

/** Everything the details pane needs for one entry. */
function entryDetail(har, i, maxChars) {
  const e = arr(har.log.entries)[i];
  if (!e) return null;
  const req = e.request || {};
  const res = e.response || {};
  const t = timings(e);
  return {
    i,
    general: {
      url: String(req.url || ''), method: String(req.method || ''), status: num(res.status), statusText: String(res.statusText || ''),
      httpVersion: String(res.httpVersion || req.httpVersion || ''), serverIPAddress: String(e.serverIPAddress || ''),
      connection: String(e.connection || ''), startedDateTime: String(e.startedDateTime || ''), time: Math.max(0, num(e.time)),
      type: classify(e), mime: String((res.content && res.content.mimeType) || ''), transfer: transferSize(e),
      contentSize: Math.max(0, num(res.content && res.content.size)), redirectURL: String(res.redirectURL || ''),
      error: String(res._error || e._error || ''), initiator: e._initiator && e._initiator.type ? String(e._initiator.type) + (e._initiator.url ? ' ' + e._initiator.url : '') : '',
      priority: String(e._priority || ''), fromCache: String(e._fromCache || ''), comment: String(e.comment || ''),
    },
    timings: TIMING_KEYS.map((k, j) => ({ name: k, ms: t[j] })),
    reqHeaders: nv(req.headers),
    resHeaders: nv(res.headers),
    query: nv(req.queryString),
    reqCookies: cookieList(req.cookies),
    resCookies: cookieList(res.cookies),
    requestBody: requestBody(e, maxChars),
    responseBody: responseBody(e, maxChars),
    sensitive: entrySensitive(e),
  };
}

// ---- Copy as cURL / fetch ----

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
const SKIP_COPY = new Set(['content-length', 'host', 'connection']);

function copyHeaders(e) {
  return nv(e.request && e.request.headers).filter((h) => h.name && !h.name.startsWith(':') && !SKIP_COPY.has(lc(h.name)));
}

function bodyText(e) {
  const pd = e.request && e.request.postData;
  if (!pd) return null;
  if (pd.text != null && pd.text !== '') return decodeText(pd.text, pd.encoding);
  if (arr(pd.params).length) return arr(pd.params).map((p) => `${encodeURIComponent(p.name || '')}=${encodeURIComponent(p.value == null ? '' : p.value)}`).join('&');
  return null;
}

/** bash-style "Copy as cURL", like the browsers' DevTools. */
function toCurl(e) {
  const req = e.request || {};
  const method = String(req.method || 'GET').toUpperCase();
  const body = bodyText(e);
  const lines = [`curl ${shellQuote(req.url || '')}`];
  if (method !== 'GET' || body != null) {
    if (!(method === 'POST' && body != null)) lines.push(`-X ${method}`);
  }
  let compressed = false;
  for (const h of copyHeaders(e)) {
    if (lc(h.name) === 'accept-encoding') { compressed = true; continue; }
    lines.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  if (body != null) lines.push(`--data-raw ${shellQuote(body)}`);
  if (compressed) lines.push('--compressed');
  return lines.join(' \\\n  ');
}

/** "Copy as fetch". Cookie headers can't be set by fetch, so they become credentials: "include". */
function toFetch(e) {
  const req = e.request || {};
  const method = String(req.method || 'GET').toUpperCase();
  const headers = {};
  let cookie = false;
  for (const h of copyHeaders(e)) {
    const n = lc(h.name);
    if (n === 'cookie') { cookie = true; continue; }
    if (n === 'accept-encoding' || n === 'user-agent' || n === 'referer' || n === 'origin' || n.startsWith('sec-')) continue;
    headers[n] = h.value;
  }
  const init = {};
  if (Object.keys(headers).length) init.headers = headers;
  const body = bodyText(e);
  if (body != null) init.body = body;
  init.method = method;
  const ref = headerValue(req.headers, 'referer');
  if (ref) init.referrer = ref;
  init.credentials = cookie ? 'include' : 'omit';
  return `await fetch(${JSON.stringify(String(req.url || ''))}, ${JSON.stringify(init, null, 2)});`;
}

// ---- export and redaction ----

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** A new HAR with only the given entries (in the given order) and the pages they refer to. */
function exportEntries(har, indices) {
  const all = arr(har.log.entries);
  const seen = new Set();
  const entries = [];
  for (const i of indices) if (Number.isInteger(i) && all[i] && !seen.has(i)) { seen.add(i); entries.push(all[i]); }
  entries.sort((a, b) => (Date.parse(a.startedDateTime) || 0) - (Date.parse(b.startedDateTime) || 0));
  const refs = new Set(entries.map((e) => e.pageref).filter(Boolean));
  const log = { ...har.log, entries };
  if (Array.isArray(har.log.pages)) log.pages = har.log.pages.filter((p) => refs.has(p.id));
  return { log };
}

function redactCookieHeader(v) {
  return String(v).split(/;\s*/).filter(Boolean).map((part) => {
    const k = part.indexOf('=');
    return k < 0 ? part : `${part.slice(0, k)}=${REDACTED}`;
  }).join('; ');
}

function redactSetCookie(v) {
  // keep the attributes (Path, Domain, Expires, HttpOnly...) and hide the value of the first pair
  return String(v).split('\n').map((line) => {
    const parts = line.split(/;\s*/);
    if (!parts[0]) return line;
    const k = parts[0].indexOf('=');
    parts[0] = k < 0 ? parts[0] : `${parts[0].slice(0, k)}=${REDACTED}`;
    return parts.join('; ');
  }).join('\n');
}

function redactJsonValue(v, count) {
  if (Array.isArray(v)) return v.map((x) => redactJsonValue(x, count));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && x != null && typeof x !== 'object' && x !== '' && x !== REDACTED) { o[k] = REDACTED; count.n++; } else o[k] = redactJsonValue(x, count);
    }
    return o;
  }
  if (typeof v === 'string' && JWT.test(v)) { count.n++; return v.replace(new RegExp(JWT.source, 'g'), REDACTED); }
  return v;
}

function redactFormText(s, count) {
  return String(s).split('&').map((part) => {
    const k = part.indexOf('=');
    if (k < 0) return part;
    let name = part.slice(0, k);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep */ }
    if (SECRET_KEY.test(name) && live(decodeSafe(part.slice(k + 1)))) { count.n++; return `${part.slice(0, k)}=${encodeURIComponent(REDACTED)}`; }
    return part;
  }).join('&');
}

function redactTextBody(text, mime, count) {
  const m = lc(mime);
  if (/x-www-form-urlencoded/.test(m)) return redactFormText(text, count);
  if (/json/.test(m) || /^\s*[{[]/.test(text)) {
    try { return JSON.stringify(redactJsonValue(JSON.parse(text), count)); } catch { /* not JSON */ }
  }
  if (JWT.test(text)) { count.n++; return text.replace(new RegExp(JWT.source, 'g'), REDACTED); }
  return text;
}

function redactUrl(url, count) {
  const s = String(url || '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const hash = s.indexOf('#', q);
  const query = hash < 0 ? s.slice(q + 1) : s.slice(q + 1, hash);
  const before = count.n;
  const red = redactFormText(query, count);
  count.n = before; // counted through queryString
  const tail = hash < 0 ? '' : s.slice(hash);
  return s.slice(0, q + 1) + red.replace(/(^|&)([^=&]*)=([^&]*)/g, (all, a, k, v) => (JWT.test(decodeSafe(v)) ? `${a}${k}=${encodeURIComponent(REDACTED)}` : all)) + tail;
}

/**
 * A redacted deep copy. Replaces secret header values, cookie values, secret query, form and JSON fields and JWTs
 * with [REDACTED]. Bodies of responses are scanned for secret JSON fields too. Returns { har, report }.
 */
function redactHar(har, opts) {
  const o = opts || {};
  const out = clone(har);
  const report = { headers: 0, cookies: 0, query: 0, bodies: 0, entries: 0 };
  for (const e of arr(out.log.entries)) {
    const before = report.headers + report.cookies + report.query + report.bodies;
    const req = e.request || {};
    const res = e.response || {};
    for (const list of [req.headers, res.headers]) {
      for (const h of arr(list)) {
        const n = lc(h.name);
        const v = String(h.value == null ? '' : h.value);
        if (SECRET_HEADERS.has(n)) { if (live(v)) { h.value = /^(bearer|basic|digest|token)\s/i.test(v) ? v.split(/\s/)[0] + ' ' + REDACTED : REDACTED; report.headers++; } } else if (n === 'cookie' || n === 'set-cookie') { const nv2 = n === 'cookie' ? redactCookieHeader(v) : redactSetCookie(v); if (nv2 !== v) { h.value = nv2; report.cookies++; } } else if (URL_HEADERS.has(n) && v.includes('?')) { const nv2 = redactUrl(v, { n: 0 }); if (nv2 !== v) { h.value = nv2; report.headers++; } } else if (JWT.test(v)) { h.value = v.replace(new RegExp(JWT.source, 'g'), REDACTED); report.headers++; }
      }
    }
    for (const list of [req.cookies, res.cookies]) for (const c of arr(list)) if (c.value !== REDACTED) { c.value = REDACTED; report.cookies++; }
    for (const q of arr(req.queryString)) {
      if (SECRET_KEY.test(String(q.name)) || JWT.test(String(q.value))) { if (q.value !== REDACTED) { q.value = REDACTED; report.query++; } }
    }
    const cu = { n: 0 };
    if (req.url) req.url = redactUrl(req.url, cu);
    if (res.redirectURL) res.redirectURL = redactUrl(res.redirectURL, cu);
    const pd = req.postData;
    if (pd) {
      const c = { n: 0 };
      for (const p of arr(pd.params)) if (SECRET_KEY.test(String(p.name)) && p.value !== REDACTED) { p.value = REDACTED; c.n++; }
      if (typeof pd.text === 'string' && pd.text) {
        if (lc(pd.encoding) === 'base64') {
          const dec = Buffer.from(pd.text, 'base64').toString('utf8');
          const red = redactTextBody(dec, pd.mimeType, c);
          if (red !== dec) pd.text = Buffer.from(red, 'utf8').toString('base64');
        } else pd.text = redactTextBody(pd.text, pd.mimeType, c);
      }
      report.bodies += c.n;
    }
    const content = res.content;
    if (content && typeof content.text === 'string' && content.text && isTextMime(content.mimeType || '') && o.bodies !== false) {
      const c = { n: 0 };
      if (lc(content.encoding) === 'base64') {
        const dec = Buffer.from(content.text, 'base64').toString('utf8');
        const red = redactTextBody(dec, content.mimeType, c);
        if (red !== dec) content.text = Buffer.from(red, 'utf8').toString('base64');
      } else content.text = redactTextBody(content.text, content.mimeType, c);
      report.bodies += c.n;
    }
    if (report.headers + report.cookies + report.query + report.bodies > before) report.entries++;
  }
  const note = 'Sensitive values replaced with [REDACTED] by HAR Viewer.';
  out.log.comment = out.log.comment ? `${out.log.comment} ${note}` : note;
  report.total = report.headers + report.cookies + report.query + report.bodies;
  return { har: out, report };
}

function redactReportText(r) {
  if (!r.total) return 'No Authorization headers, cookies or tokens were found, so the copy matches the original apart from a comment.';
  const parts = [];
  if (r.headers) parts.push(`${r.headers} header value${r.headers === 1 ? '' : 's'}`);
  if (r.cookies) parts.push(`${r.cookies} cookie${r.cookies === 1 ? '' : 's'}`);
  if (r.query) parts.push(`${r.query} URL parameter${r.query === 1 ? '' : 's'}`);
  if (r.bodies) parts.push(`${r.bodies} body field${r.bodies === 1 ? '' : 's'}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Replaced ${list} in ${r.entries} request${r.entries === 1 ? '' : 's'}.`;
}

function creatorText(har) {
  const c = har.log.creator || {};
  const b = har.log.browser || {};
  const a = [c.name, c.version].filter(Boolean).join(' ');
  const d = [b.name, b.version].filter(Boolean).join(' ');
  return [a, d && d !== a ? d : ''].filter(Boolean).join(', ');
}

function pagesInfo(har) {
  return arr(har.log.pages).map((p) => ({
    id: String(p.id || ''), title: String(p.title || ''), started: String(p.startedDateTime || ''),
    onContentLoad: num(p.pageTimings && p.pageTimings.onContentLoad), onLoad: num(p.pageTimings && p.pageTimings.onLoad),
  }));
}

module.exports = {
  TYPES, TYPE_LABELS, TIMING_KEYS, REDACTED, SECRET_KEY,
  parseHar, classify, pathName, timings, transferSize, isFailed, headerValue, summarize, totals, domains, filterRows,
  entrySensitive, scanSensitive, sensitiveText, bodyView, requestBody, responseBody, entryDetail, formPairs,
  toCurl, toFetch, shellQuote, exportEntries, redactHar, redactReportText, creatorText, pagesInfo,
};
