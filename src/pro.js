'use strict';
// Zovo Pro switch for this extension. PRO_ENABLED is false: every feature is free and no Pro prompt is ever shown.
// When the owner turns it on, these features need Zovo Pro (one price, every Zovo extension):
//   - scenarios: tests with several steps, values extracted from responses, and CSV data files
//   - history:   the run history chart of one test over many runs
//   - schedule:  scheduled local runs while VS Code is open
// A single-request test, the live dashboard, thresholds, the HTML report, the compare of two runs and every import
// stay free for good. Unlock is offline (a signed key) or one GitHub call after the user clicks "Unlock with GitHub
// Sponsors" (factory/sprint/license, unchanged copies in src/license).
const { createLicense } = require('./license');

const PRO_ENABLED = false;
const SKU = 'load-testing-pro';

const FEATURES = {
  scenarios: ['Multi-step scenarios', 'Run several requests in a row, pass values from one response to the next request, and feed rows from a CSV file.'],
  history: ['Run history', 'See p95, requests per second and errors of every run of a test on one chart.'],
  schedule: ['Scheduled runs', 'Run a test every few minutes while VS Code is open and get a message only when a threshold fails.'],
};

function createPro({ vscode, context, enabled = PRO_ENABLED }) {
  // The unlock commands exist only while the switch is on, so with Pro off nothing can ever call GitHub.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Load Testing', commandPrefix: enabled ? 'loadTesting' : undefined });
  try { vscode.commands.executeCommand('setContext', 'loadTesting.proEnabled', !!enabled); } catch (e) { /* ignore */ }
  /** True when the feature may run. Shows the one Pro explanation only when the switch is on and Pro is missing. */
  async function allow(feature) {
    if (!enabled) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh(); return true; }
    const [name, detail] = FEATURES[feature] || [feature, ''];
    return !!(await license.requirePro(name, detail));
  }
  return { license, allow, enabled: !!enabled, SKU };
}

module.exports = { createPro, PRO_ENABLED, SKU, FEATURES };
