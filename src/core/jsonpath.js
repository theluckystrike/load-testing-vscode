'use strict';
// A small JSONPath subset for checks and variable extraction: $, .key, ['key'], [0], [-1], [*], ..key (deep).
// Returns every match. No script expressions, so a test file can never run code.

function tokenize(path) {
  const p = String(path || '').trim();
  if (!p.startsWith('$')) return null;
  const out = [];
  let i = 1;
  while (i < p.length) {
    if (p.startsWith('..', i)) {
      i += 2;
      const m = /^[A-Za-z_$][\w$-]*|^\*/.exec(p.slice(i));
      if (!m) return null;
      out.push({ deep: m[0] }); i += m[0].length;
    } else if (p[i] === '.') {
      i++;
      const m = /^[A-Za-z_$][\w$-]*|^\*/.exec(p.slice(i));
      if (!m) return null;
      out.push({ key: m[0] }); i += m[0].length;
    } else if (p[i] === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) return null;
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') out.push({ key: '*' });
      else if (/^-?\d+$/.test(inner)) out.push({ index: Number(inner) });
      else if (/^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/.test(inner)) out.push({ key: inner.slice(1, -1).replace(/\\(.)/g, '$1') });
      else return null;
    } else return null;
  }
  return out;
}

function children(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function deepFind(v, key, out, depth) {
  if (depth > 64 || out.length > 10000) return;
  if (Array.isArray(v)) { for (const x of v) deepFind(x, key, out, depth + 1); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (key === '*' || k === key) out.push(x);
      deepFind(x, key, out, depth + 1);
    }
  }
}

/** Returns { ok, values } or { ok: false, error }. */
function query(data, path) {
  const toks = tokenize(path);
  if (!toks) return { ok: false, error: `"${path}" is not a supported JSONPath. Use forms like $.items[0].id or $..id.` };
  let cur = [data];
  for (const t of toks) {
    const next = [];
    for (const v of cur) {
      if (t.deep !== undefined) deepFind(v, t.deep, next, 0);
      else if (t.index !== undefined) {
        if (Array.isArray(v)) { const i = t.index < 0 ? v.length + t.index : t.index; if (i >= 0 && i < v.length) next.push(v[i]); }
      } else if (t.key === '*') next.push(...children(v));
      else if (t.key === 'length' && (Array.isArray(v) || typeof v === 'string')) next.push(v.length);
      else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, t.key)) next.push(v[t.key]);
    }
    cur = next;
    if (!cur.length) break;
  }
  return { ok: true, values: cur };
}

function isValid(path) { return tokenize(path) !== null; }

module.exports = { query, isValid };
