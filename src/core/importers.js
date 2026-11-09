'use strict';
// Turns requests you already have into a load test: .http / .rest files (REST Client format), cURL commands,
// HAR files, OpenAPI / Swagger documents and JMeter .jmx test plans (HTTP samplers only).
// Every importer returns { requests: [{ name, method, url, headers: [[k, v]], body, extract? }], variables, notes,
// phases? }. buildTest() writes the YAML. Pure functions: no VS Code, no network.
const YAML = require('../../vendor/yaml');
const { parseHar, classify } = require('./har');

const HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'accept-encoding']);
const SENSITIVE = /^(authorization|cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;

function cleanHeaders(list) {
  const out = [];
  const seen = new Set();
  for (const [k, v] of list) {
    const n = String(k).trim();
    if (!n || n.startsWith(':') || HOP.has(n.toLowerCase())) continue;
    const key = n.toLowerCase();
    if (seen.has(key) && key !== 'cookie') continue;
    seen.add(key);
    out.push([n, String(v)]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- .http / .rest
const REST_BUILTINS = [
  [/\{\{\s*\$guid\s*\}\}/g, '{{$uuid}}'],
  [/\{\{\s*\$datetime\s+iso8601[^}]*\}\}/g, '{{$isoTimestamp}}'],
  [/\{\{\s*\$localDatetime\s+iso8601[^}]*\}\}/g, '{{$isoTimestamp}}'],
  [/\{\{\s*\$dotenv\s+%?([A-Za-z_]\w*)\s*\}\}/g, '{{$processEnv $1}}'],
  [/\{\{\s*\$processEnv\s+%?([A-Za-z_]\w*)\s*\}\}/g, '{{$processEnv $1}}'],
];

function fromHttpFile(text) {
  const notes = [];
  const variables = {};
  const requests = [];
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const blocks = [[]];
  for (const line of lines) {
    if (/^###/.test(line)) { blocks.push([]); continue; }
    blocks[blocks.length - 1].push(line);
  }
  for (const block of blocks) {
    let i = 0, name = '';
    // file variables and comments before the request line
    for (; i < block.length; i++) {
      const l = block[i];
      const v = /^\s*@([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(l);
      if (v) { variables[v[1].replace(/-/g, '_')] = v[2].trim(); continue; }
      const nm = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/.exec(l);
      if (nm) { name = nm[1]; continue; }
      if (/^\s*(#|\/\/)/.test(l) || !l.trim()) continue;
      break;
    }
    if (i >= block.length) continue;
    const m = /^\s*(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+)?(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i.exec(block[i]);
    if (!m) { notes.push(`Skipped a block that does not start with a request line: "${block[i].slice(0, 60)}"`); continue; }
    const method = (m[1] || 'GET').toUpperCase();
    let url = m[2];
    i++;
    while (i < block.length && /^\s*[?&]/.test(block[i])) { url += block[i].trim(); i++; }
    const headers = [];
    for (; i < block.length && block[i].trim(); i++) {
      if (/^\s*(#|\/\/)/.test(block[i])) continue;
      const h = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(block[i]);
      if (h) headers.push([h[1], h[2]]);
    }
    let body = block.slice(i + 1).join('\n').replace(/\s+$/, '');
    if (/^\s*<\s*\S/.test(body)) { notes.push(`${name || method + ' ' + url}: the body is read from a file ("${body.trim().slice(0, 60)}"). Paste the body into the test.`); }
    if (!body) body = null;
    requests.push({ name: name || `${method} ${url}`, refName: name, method, url, headers: cleanHeaders(headers), body });
  }
  // REST Client request variables {{login.response.body.$.token}} become extracted values.
  const byName = new Map(requests.filter((r) => r.refName).map((r) => [r.refName, r]));
  const conv = (s) => {
    if (s == null) return s;
    let out = String(s);
    for (const [re, rep] of REST_BUILTINS) out = out.replace(re, rep);
    out = out.replace(/\{\{\s*([A-Za-z_][\w-]*)\.response\.body\.(\$[^}\s]*)\s*\}\}/g, (all, ref, p) => {
      const src = byName.get(ref);
      if (!src) return all;
      const v = `${ref.replace(/-/g, '_')}_${(p.match(/[A-Za-z_]\w*$/) || ['value'])[0]}`;
      src.extract = src.extract || [];
      if (!src.extract.some(([n]) => n === v)) src.extract.push([v, p]);
      return `{{${v}}}`;
    });
    return out.replace(/\{\{\s*([A-Za-z_][\w]*)-([\w-]+)\s*\}\}/g, (all, a, b) => `{{${a}_${b.replace(/-/g, '_')}}}`);
  };
  for (const r of requests) {
    r.url = conv(r.url);
    r.headers = r.headers.map(([k, v]) => [k, conv(v)]);
    r.body = conv(r.body);
  }
  for (const k of Object.keys(variables)) variables[k] = conv(variables[k]);
  if (!requests.length) notes.push('No request found. A request line looks like "GET https://example.com/api".');
  return { requests: requests.map(({ refName, ...r }) => r), variables, notes };
}

// ---------------------------------------------------------------------------------------------- cURL
function shellWords(cmd) {
  const s = String(cmd || '').replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out = [];
  let cur = '', inWord = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } i++; continue; }
    inWord = true;
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Error('A single quote is not closed.'); cur += s.slice(i + 1, j); i = j + 1; continue; }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[++j];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += s[j];
      }
      if (j >= s.length) throw new Error('A $\'...\' string is not closed.');
      i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && '"\\$`'.includes(s[j + 1])) { cur += s[++j]; } else cur += s[j];
      }
      if (j >= s.length) throw new Error('A double quote is not closed.');
      i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    cur += c; i++;
  }
  if (inWord) out.push(cur);
  return out;
}

function fromCurl(cmd) {
  const notes = [];
  let words;
  try { words = shellWords(String(cmd || '').trim()); } catch (e) { return { requests: [], variables: {}, notes: [e.message] }; }
  const ci = words.findIndex((w) => /(^|[\\/])curl(\.exe)?$/i.test(w));
  if (ci < 0) return { requests: [], variables: {}, notes: ['This text does not start with curl.'] };
  words = words.slice(ci + 1);
  let method = '', url = '', get = false, insecure = false;
  const headers = [], data = [];
  let json = false;
  const takes = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
    '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '--url', '-o', '--output', '-m', '--max-time', '--connect-timeout',
    '-x', '--proxy', '-w', '--write-out', '--retry', '-T', '--upload-file', '-F', '--form', '--cacert', '--cert', '--key', '-r', '--range', '--resolve', '-c', '--cookie-jar']);
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    let val;
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(w);
    if (eq && takes.has(eq[1])) { w = eq[1]; val = eq[2]; }
    else if (/^-[XHdAbeuo]./.test(w) && !w.startsWith('--')) { val = w.slice(2); w = w.slice(0, 2); }
    else if (takes.has(w)) { val = words[++i]; }
    switch (w) {
      case '-X': case '--request': method = String(val || '').toUpperCase(); break;
      case '-H': case '--header': { const m = /^([^:]+):\s*(.*)$/s.exec(val || ''); if (m) headers.push([m[1].trim(), m[2]]); break; }
      case '-d': case '--data': case '--data-ascii': case '--data-binary': case '--data-raw':
        if (String(val).startsWith('@') && w !== '--data-raw') notes.push(`The body is read from the file ${val.slice(1)}. Paste it into the test.`);
        data.push(String(val == null ? '' : val)); break;
      case '--data-urlencode': {
        const v = String(val || ''); const k = v.indexOf('=');
        data.push(k > 0 ? v.slice(0, k + 1) + encodeURIComponent(v.slice(k + 1)) : encodeURIComponent(v.replace(/^=/, ''))); break;
      }
      case '--json': json = true; data.push(String(val || '')); break;
      case '-u': case '--user': headers.push(['authorization', 'Basic ' + Buffer.from(String(val || '')).toString('base64')]); break;
      case '-A': case '--user-agent': headers.push(['user-agent', String(val || '')]); break;
      case '-b': case '--cookie': if (String(val).includes('=')) headers.push(['cookie', String(val)]); else notes.push('Cookies from a file are not imported.'); break;
      case '-e': case '--referer': headers.push(['referer', String(val || '')]); break;
      case '--url': url = String(val || ''); break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': method = 'HEAD'; break;
      case '-k': case '--insecure': insecure = true; break;
      case '-F': case '--form': notes.push('Multipart form fields (-F) are not imported. Use a body instead.'); break;
      case '-T': case '--upload-file': notes.push('File uploads (-T) are not imported.'); break;
      default:
        if (val === undefined && !w.startsWith('-') && !url) url = w;
    }
  }
  if (!url) return { requests: [], variables: {}, notes: notes.concat('No URL found in the cURL command.') };
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  let body = data.length ? data.join('&') : null;
  if (get && body != null) { url += (url.includes('?') ? '&' : '?') + body; body = null; }
  if (!method) method = body != null ? 'POST' : 'GET';
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
  if (json) { if (!has('content-type')) headers.push(['content-type', 'application/json']); if (!has('accept')) headers.push(['accept', 'application/json']); }
  else if (body != null && !has('content-type')) headers.push(['content-type', 'application/x-www-form-urlencoded']);
  const short = (() => { try { const u = new URL(url); return u.pathname; } catch (e) { return url; } })();
  return { requests: [{ name: `${method} ${short}`, method, url, headers: cleanHeaders(headers), body }], variables: {}, notes, insecure };
}

// ---------------------------------------------------------------------------------------------- HAR
function fromHar(text, { types = ['xhr', 'doc'] } = {}) {
  const har = parseHar(text);
  const notes = [];
  const requests = [];
  let skipped = 0;
  for (const e of har.log.entries) {
    const req = e && e.request;
    if (!req || !/^https?:\/\//i.test(String(req.url || ''))) { skipped++; continue; }
    const type = classify(e);
    if (types && !types.includes(type)) { skipped++; continue; }
    const headers = cleanHeaders((req.headers || []).map((h) => [h && h.name, h && h.value]));
    let body = null;
    if (req.postData) {
      if (typeof req.postData.text === 'string' && req.postData.text) body = req.postData.text;
      else if (Array.isArray(req.postData.params) && req.postData.params.length) body = new URLSearchParams(req.postData.params.map((p) => [p.name, p.value || ''])).toString();
      if (body != null && req.postData.mimeType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['content-type', req.postData.mimeType]);
    }
    let path = req.url;
    try { const u = new URL(req.url); path = u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '...' : u.search); } catch (e2) { /* keep */ }
    requests.push({ name: `${String(req.method || 'GET').toUpperCase()} ${path}`, method: String(req.method || 'GET').toUpperCase(), url: req.url, headers, body, type, status: e.response && e.response.status, ms: e.time });
  }
  if (skipped) notes.push(`${skipped} entries were left out (scripts, styles, images, fonts and other non-API requests).`);
  if (requests.some((r) => r.headers.some(([k]) => SENSITIVE.test(k)))) notes.push('Some requests carry cookies or authorization headers from the recording. They are copied into the test file. Do not commit it as is.');
  return { requests, variables: {}, notes };
}

// ---------------------------------------------------------------------------------------------- OpenAPI
function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let cur = doc;
  for (const part of ref.slice(2).split('/')) {
    const k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object' || !(k in cur)) return null;
    cur = cur[k];
  }
  return cur;
}

function deref(doc, v, seen = new Set()) {
  let n = 0;
  while (v && typeof v === 'object' && typeof v.$ref === 'string' && n++ < 20) {
    if (seen.has(v.$ref)) return {};
    seen.add(v.$ref);
    v = resolveRef(doc, v.$ref);
  }
  return v || {};
}

function sampleOf(doc, schema, depth = 0, seen = new Set()) {
  const s = deref(doc, schema, new Set(seen));
  if (depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sampleOf(doc, x, depth + 1, seen)).filter((x) => x && typeof x === 'object'));
  if (s.oneOf || s.anyOf) return sampleOf(doc, (s.oneOf || s.anyOf)[0], depth + 1, seen);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const o = {};
    for (const [k, v] of Object.entries(s.properties || {})) {
      const vv = deref(doc, v);
      if (vv.readOnly) continue;
      o[k] = sampleOf(doc, v, depth + 1, seen);
    }
    return o;
  }
  if (type === 'array') return [sampleOf(doc, s.items || {}, depth + 1, seen)];
  if (type === 'integer' || type === 'number') return s.minimum !== undefined ? s.minimum : 1;
  if (type === 'boolean') return true;
  if (type === 'string') {
    if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (s.format === 'date') return '2026-01-01';
    if (s.format === 'email') return 'user@example.com';
    if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
    return 'string';
  }
  return null;
}

function fromOpenApi(text) {
  const notes = [];
  let doc;
  try {
    doc = YAML.parse(String(text || '').replace(/^﻿/, ''), { maxAliasCount: 100, uniqueKeys: false });
  } catch (e) { return { requests: [], variables: {}, notes: [`The file could not be read: ${String(e.message).split('\n')[0]}`] }; }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger)) return { requests: [], variables: {}, notes: ['This is not an OpenAPI or Swagger document (no "openapi" or "swagger" key).'] };
  let base = '';
  if (doc.openapi) {
    const sv = Array.isArray(doc.servers) && doc.servers[0];
    if (sv && sv.url) {
      base = String(sv.url).replace(/\{([^}]+)\}/g, (m, k) => (sv.variables && sv.variables[k] && sv.variables[k].default) || m);
    }
  } else {
    const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || 'https';
    if (doc.host) base = `${scheme}://${doc.host}${doc.basePath || ''}`;
    else if (doc.basePath) base = doc.basePath;
  }
  if (!/^https?:\/\//i.test(base)) {
    notes.push(`The document has no full server URL${base ? ` ("${base}")` : ''}, so the target is http://localhost:8080. Change target to your test server.`);
    base = 'http://localhost:8080' + (base.startsWith('/') ? base : '');
  }
  base = base.replace(/\/+$/, '');
  const variables = {};
  const requests = [];
  const sec = doc.components && doc.components.securitySchemes || doc.securityDefinitions || {};
  const authHeaders = [];
  for (const s of Object.values(sec)) {
    const v = deref(doc, s);
    if ((v.type === 'http' && /bearer/i.test(v.scheme || '')) || v.type === 'oauth2' || v.type === 'openIdConnect') { authHeaders.push(['authorization', 'Bearer {{token}}']); variables.token = 'replace-me'; break; }
    if (v.type === 'apiKey' && v.in === 'header' && v.name) { authHeaders.push([v.name, '{{apiKey}}']); variables.apiKey = 'replace-me'; break; }
    if (v.type === 'basic' || (v.type === 'http' && /basic/i.test(v.scheme || ''))) { authHeaders.push(['authorization', 'Basic {{basicAuth}}']); variables.basicAuth = 'replace-me'; break; }
  }
  for (const [p, item0] of Object.entries(doc.paths || {})) {
    const item = deref(doc, item0);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((x) => deref(doc, x));
      let path = p.replace(/\{([^}]+)\}/g, (m, k) => {
        const name = k.replace(/[^\w]/g, '_');
        const prm = params.find((x) => x.in === 'path' && x.name === k);
        const ex = prm ? (prm.example !== undefined ? prm.example : sampleOf(doc, prm.schema || { type: prm.type || 'string' })) : 1;
        if (!(name in variables)) variables[name] = String(ex == null ? 1 : ex === 'string' ? 1 : ex);
        return `{{${name}}}`;
      });
      const q = params.filter((x) => x.in === 'query' && x.required).map((x) => [x.name, String(x.example !== undefined ? x.example : sampleOf(doc, x.schema || { type: x.type || 'string' }))]);
      if (q.length) path += '?' + new URLSearchParams(q).toString();
      const headers = [...authHeaders];
      let body = null;
      if (op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const content = rb.content || {};
        const mt = Object.keys(content).find((k) => /json/i.test(k)) || Object.keys(content)[0];
        if (mt) {
          const c = content[mt] || {};
          let ex = c.example;
          if (ex === undefined && c.examples && typeof c.examples === 'object') { const first = Object.values(c.examples)[0]; ex = deref(doc, first).value; }
          if (ex === undefined) ex = sampleOf(doc, c.schema || {});
          body = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 0);
          headers.push(['content-type', mt]);
        }
      } else {
        const bp = params.find((x) => x.in === 'body');
        if (bp) { body = JSON.stringify(sampleOf(doc, bp.schema || {})); headers.push(['content-type', 'application/json']); }
      }
      const name = op.operationId || op.summary || `${method.toUpperCase()} ${p}`;
      requests.push({ name: `${method.toUpperCase()} ${p}${op.operationId ? ` (${op.operationId})` : ''}`, label: String(name), method: method.toUpperCase(), url: base + path, headers, body });
    }
  }
  if (!requests.length) notes.push('The document has no operations under paths.');
  return { requests, variables, notes, title: doc.info && doc.info.title ? String(doc.info.title) : '' };
}

// ---------------------------------------------------------------------------------------------- JMeter
function xmlDecode(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
}

function props(xml) {
  const o = {};
  const re = /<(stringProp|intProp|longProp|boolProp)\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(xml))) if (!(m[2] in o)) o[m[2]] = xmlDecode(m[3] || '');
  return o;
}

function argsOf(xml) {
  const out = [];
  const re = /<elementProp\s+name="[^"]*"\s+elementType="HTTPArgument"[^>]*>([\s\S]*?)<\/elementProp>/g;
  let m;
  while ((m = re.exec(xml))) { const p = props(m[1]); out.push([p['Argument.name'] || '', p['Argument.value'] || '']); }
  return out;
}

function fromJmx(text) {
  const notes = [];
  const xml = String(text || '');
  if (!/<jmeterTestPlan/.test(xml)) return { requests: [], variables: {}, notes: ['This is not a JMeter test plan (no <jmeterTestPlan> element).'] };
  if (xml.length > 20 * 1048576) return { requests: [], variables: {}, notes: ['The test plan is over 20 MB.'] };
  const jvar = (s) => String(s || '').replace(/\$\{__UUID\(\)\}/g, '{{$uuid}}').replace(/\$\{__time\([^)]*\)\}/g, '{{$timestamp}}')
    .replace(/\$\{__Random\((\d+),(\d+)[^)]*\)\}/g, '{{$randomInt $1 $2}}').replace(/\$\{([A-Za-z_][\w]*)\}/g, '{{$1}}');
  // HTTP Request Defaults
  let defaults = {};
  const dm = /<ConfigTestElement[^>]*guiclass="HttpDefaultsGui"[^>]*>([\s\S]*?)<\/ConfigTestElement>/.exec(xml);
  if (dm) defaults = props(dm[1]);
  // User Defined Variables
  const variables = {};
  const um = /<Arguments[^>]*guiclass="ArgumentsPanel"[^>]*>([\s\S]*?)<\/Arguments>/g;
  let u;
  while ((u = um.exec(xml))) {
    const re = /<elementProp\s+name="[^"]*"\s+elementType="Argument"[^>]*>([\s\S]*?)<\/elementProp>/g;
    let a;
    while ((a = re.exec(u[1]))) { const p = props(a[1]); if (p['Argument.name'] && /^[A-Za-z_]\w*$/.test(p['Argument.name'])) variables[p['Argument.name']] = jvar(p['Argument.value']); }
  }
  // Header managers apply to every sampler here (JMeter scopes them by tree position).
  const headers = [];
  const hm = /<HeaderManager[^>]*>([\s\S]*?)<\/HeaderManager>/g;
  let h;
  while ((h = hm.exec(xml))) {
    const re = /<elementProp\s+name="[^"]*"\s+elementType="Header"[^>]*>([\s\S]*?)<\/elementProp>/g;
    let e;
    while ((e = re.exec(h[1]))) { const p = props(e[1]); if (p['Header.name']) headers.push([p['Header.name'], jvar(p['Header.value'])]); }
  }
  if (headers.length) notes.push('Headers from every Header Manager are added to every request.');
  const requests = [];
  const sm = /<HTTPSamplerProxy[^>]*testname="([^"]*)"[^>]*>([\s\S]*?)<\/HTTPSamplerProxy>/g;
  let s;
  while ((s = sm.exec(xml))) {
    const p = props(s[2]);
    const g = (k) => p['HTTPSampler.' + k] || defaults['HTTPSampler.' + k] || '';
    const protocol = (g('protocol') || 'http').toLowerCase();
    const domain = g('domain');
    const port = g('port');
    let path = g('path') || '/';
    const method = (p['HTTPSampler.method'] || 'GET').toUpperCase();
    let url;
    if (/^https?:\/\//i.test(path)) url = path;
    else {
      if (!domain) { notes.push(`"${xmlDecode(s[1])}" has no server name and was skipped.`); continue; }
      url = `${protocol}://${domain}${port && !((protocol === 'http' && port === '80') || (protocol === 'https' && port === '443')) ? ':' + port : ''}${path.startsWith('/') ? path : '/' + path}`;
    }
    const args = argsOf(s[2]);
    let body = null;
    if (p['HTTPSampler.postBodyRaw'] === 'true') body = jvar(args.map(([, v]) => v).join(''));
    else if (args.length) {
      const qs = args.map(([k, v]) => `${encodeURIComponent(jvar(k))}=${encodeURIComponent(jvar(v)).replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}')}`).join('&');
      if (['GET', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) url += (url.includes('?') ? '&' : '?') + qs; else body = qs;
    }
    const hs = headers.slice();
    if (body != null && p['HTTPSampler.postBodyRaw'] === 'true' && /^\s*[[{]/.test(body) && !hs.some(([k]) => k.toLowerCase() === 'content-type')) hs.push(['content-type', 'application/json']);
    if (body != null && !p['HTTPSampler.postBodyRaw'] && !hs.some(([k]) => k.toLowerCase() === 'content-type')) hs.push(['content-type', 'application/x-www-form-urlencoded']);
    requests.push({ name: xmlDecode(s[1]) || `${method} ${path}`, method, url: jvar(url), headers: cleanHeaders(hs), body });
  }
  // Thread Group: users and ramp-up
  let phases = null;
  const tg = /<ThreadGroup[^>]*>([\s\S]*?)<\/ThreadGroup>/.exec(xml);
  if (tg) {
    const p = props(tg[1]);
    const users = Number(p['ThreadGroup.num_threads']) || 0;
    const ramp = Number(p['ThreadGroup.ramp_time']) || 0;
    const dur = Number(p['ThreadGroup.duration']) || 0;
    if (users > 0) {
      phases = [];
      if (ramp > 0) phases.push({ name: 'ramp-up', duration: `${ramp}s`, vus: [1, users] });
      phases.push({ name: 'steady', duration: `${dur > ramp ? dur - ramp : 60}s`, vus: users });
      if (!dur) notes.push('The thread group runs by loop count, not by time. The steady phase is set to 60 s.');
    }
  }
  if (!requests.length) notes.push('No HTTP Request sampler found.');
  const otherSamplers = (xml.match(/<(JDBCSampler|JSR223Sampler|TCPSampler|FTPSampler|SmtpSampler|JMSSampler|BeanShellSampler)\b/g) || []).length;
  if (otherSamplers) notes.push(`${otherSamplers} samplers that are not HTTP were left out.`);
  if (/<(CSVDataSet)\b/.test(xml)) notes.push('The plan reads a CSV Data Set. Point "data" at the CSV file to use it.');
  return { requests, variables, notes, phases };
}

// ---------------------------------------------------------------------------------------------- YAML output
const DEFAULT_PHASES = [
  { name: 'ramp-up', duration: '10s', vus: [1, 10] },
  { name: 'steady', duration: '30s', vus: 10 },
  { name: 'ramp-down', duration: '5s', vus: [10, 0] },
];

function bodyValue(r) {
  if (r.body == null) return {};
  const ct = (r.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  if (/json/i.test(ct)) {
    try { const j = JSON.parse(r.body); if (j && typeof j === 'object') return { json: j, dropContentType: /^application\/json\s*$/i.test(ct) }; } catch (e) { /* keep text */ }
  }
  return { body: r.body };
}

function requestObject(r) {
  const o = { method: r.method, url: r.url };
  const b = bodyValue(r);
  const hs = r.headers.filter(([k]) => !(b.dropContentType && k.toLowerCase() === 'content-type'));
  if (hs.length) { o.headers = {}; for (const [k, v] of hs) o.headers[k] = k in o.headers ? `${o.headers[k]}; ${v}` : v; }
  if (b.json !== undefined) o.json = b.json;
  if (b.body !== undefined) o.body = b.body;
  return o;
}

/** YAML text of a test from imported requests. Several requests become steps (one scenario per iteration). */
function buildTest(imp, { name, source, insecure } = {}) {
  const reqs = imp.requests;
  if (!reqs.length) throw new Error('Nothing to import.');
  const t = { name: name || (reqs.length === 1 ? reqs[0].name : `${reqs.length} requests`) };
  if (Object.keys(imp.variables || {}).length) t.variables = imp.variables;
  if (reqs.length === 1) {
    t.request = requestObject(reqs[0]);
    t.checks = { status: '2xx' };
    if (reqs[0].extract && reqs[0].extract.length) notes(imp, 'Values extracted from responses need steps.');
  } else {
    t.steps = reqs.map((r) => {
      const s = { name: r.name, request: requestObject(r) };
      if (r.extract && r.extract.length) s.extract = Object.fromEntries(r.extract);
      s.checks = { status: '2xx' };
      return s;
    });
  }
  t.phases = imp.phases || DEFAULT_PHASES;
  t.thinkTime = '100ms';
  t.timeout = '10s';
  t.thresholds = ['p95 < 500ms', 'errors < 1%'];
  if (insecure || imp.insecure) t.insecure = true;
  const header = [
    `# Load test imported from ${source || 'requests'}.`,
    '# Check the target before you run it: requests go only to the hosts below, and only after you confirm them.',
    ...(imp.notes || []).map((n) => '# Note: ' + n),
  ].join('\n');
  const doc = new YAML.Document(t, { aliasDuplicateObjects: false });
  // [from, to] pairs read better on one line: vus: [1, 10]
  YAML.visit(doc, { Seq(_, node) { if (node.items.length <= 2 && node.items.every((x) => YAML.isScalar(x) && typeof x.value === 'number')) node.flow = true; } });
  return header + '\n' + doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function notes(imp, n) { imp.notes = (imp.notes || []).concat(n); }

module.exports = { fromHttpFile, fromCurl, fromHar, fromOpenApi, fromJmx, buildTest, shellWords, cleanHeaders };
