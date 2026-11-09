'use strict';
// The footer "Rate" link (factory/sprint/rating, copied by apply.sh to test/rate-link.test.js when the repo has
// src/support.js). Order v2.1: Rate · More free viewers · Sponsor · PayPal (only when set) · Hide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/support.js');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const review = `https://marketplace.visualstudio.com/items?itemName=${id}&ssr=false#review-details`;

test('rate link: SELF_ID is this extension', () => {
  assert.equal(S.SELF_ID, id);
  assert.equal(S.reviewUrl(id), review);
  assert.equal(S.reviewUrl(''), '');
});

test('rate link: footer order is Rate, More free viewers, Sponsor, PayPal (when set), Hide', () => {
  const html = S.footerHtml('x', true, '');
  assert.ok(html.includes(`<a href="${review}"`), html);
  const labels = [...html.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
  const want = ['Rate', 'More free viewers', 'Sponsor'].concat(S.paypalUrl() ? ['PayPal'] : [], ['Hide']);
  assert.deepEqual(labels, want, html);
  assert.equal((html.match(/zovo-sep/g) || []).length, want.length - 1, 'one separator between links');
  assert.equal(S.footerHtml('x', false, ''), '', 'Hide setting removes the whole line, Rate too');
});

test('rate link: hover markdown starts with Rate', () => {
  const md = S.footerMarkdown('x');
  assert.ok(md.startsWith(`[Rate](${review}) · [More free viewers](command:x.moreViewers) · [Sponsor](command:x.supportDeveloper)`), md);
  assert.equal(/\[PayPal\]/.test(md), S.paypalUrl() !== '');
});

test('rate link: a plain link, no new command and no prompt', () => {
  assert.deepEqual(Object.keys(S.commandIds('x')).sort(), ['more', 'sponsor']);
  assert.ok(!S.commandUris('x').some((c) => /rate/i.test(c)));
});
