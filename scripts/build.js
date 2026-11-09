'use strict';
// Bundles the extension host code and the worker (load engine, imports, demo API) with esbuild.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root, platform: 'node', format: 'cjs', target: 'node18' };
(async () => {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', external: ['vscode'] }),
    esbuild.build({ ...common, entryPoints: ['src/engine/worker.js'], outfile: 'dist/worker.js' }),
  ]);
  const kb = (f) => (fs.statSync(path.join(root, 'dist', f)).size / 1024).toFixed(0) + ' KB';
  console.log(`built: extension ${kb('extension.js')}, worker ${kb('worker.js')}`);
})().catch((e) => { console.error(e); process.exit(1); });
