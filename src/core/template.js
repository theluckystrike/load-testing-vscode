'use strict';
// {{name}} placeholders in URLs, headers and bodies. Values come from the test's variables, the current CSV row
// and values extracted from earlier responses. Built-ins: {{$vu}}, {{$iteration}}, {{$uuid}}, {{$timestamp}},
// {{$isoTimestamp}}, {{$randomInt min max}} and {{$processEnv NAME}}. Nothing here evaluates code.
const crypto = require('crypto');

const RE = /\{\{\s*(\$?[A-Za-z_][\w.-]*)((?:\s+[^\s}]+)*)\s*\}\}/g;

function builtin(name, args, ctx) {
  switch (name) {
    case '$vu': return String(ctx.vu || 0);
    case '$iteration': return String(ctx.iteration || 0);
    case '$uuid': return crypto.randomUUID();
    case '$timestamp': return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp': return new Date().toISOString();
    case '$randomInt': {
      const min = Number(args[0] || 0), max = Number(args[1] || 1000000);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return String(min);
      return String(min + Math.floor(Math.random() * (max - min)));
    }
    case '$processEnv': return args[0] && Object.prototype.hasOwnProperty.call(process.env, args[0]) ? String(process.env[args[0]]) : '';
    default: return undefined;
  }
}

/** Fills placeholders. Unknown names stay as they are and are added to ctx.missing (a Set) when given. */
function render(text, ctx) {
  if (typeof text !== 'string' || text.indexOf('{{') < 0) return text;
  return text.replace(RE, (m, name, rest) => {
    if (name[0] === '$') {
      const v = builtin(name, rest.trim() ? rest.trim().split(/\s+/) : [], ctx);
      if (v !== undefined) return v;
    } else {
      for (const scope of [ctx.extracted, ctx.row, ctx.variables]) {
        if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return String(scope[name]);
      }
    }
    if (ctx.missing) ctx.missing.add(name);
    return m;
  });
}

function hasPlaceholder(text) { return typeof text === 'string' && /\{\{\s*\$?[A-Za-z_]/.test(text); }

module.exports = { render, hasPlaceholder };
