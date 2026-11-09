'use strict';
// Who may receive load. The user keeps a blocklist (setting loadTesting.blockedHosts) of host patterns:
// "example.com" matches that host, "*.example.com" matches its subdomains and itself, and a pattern may end in
// ":port". The engine also refuses any host that the user did not confirm before the run, so a value from a
// response or a CSV row can never send traffic to a new host.

function hostOnly(host) {
  const h = String(host || '').toLowerCase().trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i > 0 && h.indexOf(':') === i ? h.slice(0, i) : h;
}

function matchPattern(pattern, host) {
  let p = String(pattern || '').toLowerCase().trim();
  const h = String(host || '').toLowerCase().trim();
  if (!p || !h) return false;
  p = p.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hasPort = /:\d+$/.test(p) && !p.endsWith(']');
  const target = hasPort ? h : hostOnly(h);
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return target === base || target.endsWith('.' + base);
  }
  return target === p;
}

/** The first blocklist pattern that matches, or ''. */
function blockedBy(host, blocklist) {
  for (const p of Array.isArray(blocklist) ? blocklist : []) if (matchPattern(p, host)) return String(p);
  return '';
}

function isLocal(host) {
  const h = hostOnly(host);
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h) || h === '0.0.0.0';
}

module.exports = { matchPattern, blockedBy, isLocal, hostOnly };
