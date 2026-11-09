'use strict';
// Package wiring: name rules, engine floor, commands, settings, CSP, and "no network outside the engine".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('display name: phrase-first, every word of each target phrase, no other product name', () => {
  const name = pkg.displayName.toLowerCase();
  assert.ok(name.startsWith('load testing'));
  for (const phrase of ['load testing', 'load test', 'performance testing', 'http load test', 'api load test']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${phrase}: ${w}`);
  }
  for (const other of ['k6', 'jmeter', 'locust', 'gatling', 'artillery', 'azure', 'test runner']) assert.ok(!name.includes(other), other);
});

test('engines floor and types (OVX1)', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-load-testing');
  assert.equal(pkg.version.split('.').length, 3);
});

test('every registered command is in package.json, and every listed command is registered', () => {
  const src = read('src/extension.js');
  const registered = new Set([...src.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]));
  for (const c of ['supportDeveloper', 'moreViewers', 'enterLicenseKey', 'getPro', 'removeLicense', 'unlockWithSponsors']) registered.add('loadTesting.' + c);
  const listed = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const c of registered) assert.ok(listed.has(c), `${c} missing in package.json`);
  for (const c of listed) assert.ok(registered.has(c), `${c} is listed but not registered`);
});

test('Pro switch is off at ship, and Pro commands are hidden while it is off', () => {
  assert.match(read('src/pro.js'), /const PRO_ENABLED = false;/);
  const hidden = pkg.contributes.menus.commandPalette.filter((m) => m.when === 'loadTesting.proEnabled').map((m) => m.command);
  assert.deepEqual(hidden.sort(), ['loadTesting.enterLicenseKey', 'loadTesting.getPro', 'loadTesting.removeLicense', 'loadTesting.unlockWithSponsors']);
});

test('settings: safety limits and the rating switch', () => {
  const p = pkg.contributes.configuration.properties;
  assert.equal(p['loadTesting.maxVirtualUsers'].default, 200);
  assert.deepEqual(p['loadTesting.blockedHosts'].default, ['*.gov', '*.mil']);
  assert.equal(p['loadTesting.askForRating'].default, true);
  assert.equal(p['loadTesting.showSupportLinks'].default, true);
});

test('schema files exist and are valid JSON', () => {
  for (const v of [...pkg.contributes.jsonValidation, ...pkg.contributes.yamlValidation]) {
    const s = JSON.parse(read(v.url));
    assert.equal(s.type, 'object');
    assert.ok(s.properties.phases);
  }
});

test('walkthrough media exists', () => {
  for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) {
    const m = s.media.image || s.media.markdown;
    assert.ok(fs.existsSync(path.join(root, m)), m);
  }
});

test('dashboard CSP: no connect-src, scripts by nonce, default none', () => {
  const { buildHtml } = require('../src/html');
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'x.js', styleUri: 'x.css', title: '<t>', nonce: 'abc' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc'/);
  assert.ok(!/connect-src/.test(html));
  assert.ok(html.includes('&lt;t&gt;'));
});

test('network code only in the engine, the demo server, and the user-started Sponsors unlock', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d))) { const p = path.join(d, f); if (fs.statSync(path.join(root, p)).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk('src'); walk('media');
  for (const f of files) {
    // har.js (copied from the HAR viewer) builds "Copy as fetch" text in a template string; it never calls fetch.
    const s = f === 'src/core/har.js' ? read(f).replace(/return `await fetch\(.*$/m, '') : read(f);
    const net = /require\('(https?|net|tls|dgram|undici)'\)|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(s);
    if (net) assert.ok(['src/engine/engine.js', 'src/core/demoapi.js', 'src/license/sponsors.js'].includes(f), `${f} has network code`);
  }
});

test('the vsix keeps only what is needed', () => {
  const ig = read('.vscodeignore');
  for (const keep of ['!dist/extension.js', '!dist/worker.js', '!media/**', '!schemas/**', '!icon.png', '!README.md']) assert.ok(ig.includes(keep), keep);
  assert.ok(!ig.includes('!test'));
});

test('rating: a run where every request failed does not count as a success (VER15)', () => {
  const src = read('src/extension.js');
  assert.match(src, /result\.summary\.requests > 0 && result\.summary\.failed < result\.summary\.requests\) rating\.success\(this\.uri\)/);
  assert.equal((src.match(/rating\.success\(/g) || []).length, 1);
});
