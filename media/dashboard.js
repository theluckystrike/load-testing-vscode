// Live load test dashboard (webview). Draws the charts on canvas with the theme's chart colors.
// It never makes a network request: data comes from the extension by postMessage.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const S = { init: null, ticks: [], last: null, done: null, state: 'starting', hostLag: 0, pro: {} };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (v == null || !isFinite(v) ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
  const ms = (v) => (v == null || !isFinite(v) ? '-' : (v < 10 ? num(v, 2) : num(v, v < 100 ? 1 : 0)) + ' ms');
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  const clock = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const css = (name, fb) => getComputedStyle(document.body).getPropertyValue(name).trim() || fb;

  function shell() {
    app.innerHTML = `
<header class="top">
  <div class="title"><h1 id="name"></h1><div class="sub" id="sub"></div></div>
  <div class="actions">
    <span id="pill" class="pill">Starting</span>
    <button id="stop" class="danger" title="Stop now. Every connection closes.">Stop</button>
    <button id="rerun" class="secondary" hidden>Run again</button>
    <button id="report" class="secondary" hidden title="Open the HTML report in your browser (offline)">Open HTML report</button>
    <button id="compare" class="secondary" hidden title="Compare this run with an earlier one">Compare...</button>
  </div>
</header>
<div class="progress"><div id="bar"></div></div>
<div id="warn"></div>
<section class="tiles" id="tiles"></section>
<section class="charts">
  <div class="chart"><h3>Requests per second <span class="key"><i class="k1"></i>req/s <i class="k2 dash"></i>users (right)</span></h3><canvas id="c1"></canvas></div>
  <div class="chart"><h3>Latency <span class="key"><i class="k4"></i>p50 <i class="k1"></i>p95 <i class="k3"></i>p99</span></h3><canvas id="c2"></canvas></div>
  <div class="chart"><h3>Failed requests per second <span class="key"><i class="k5"></i>failed/s</span></h3><canvas id="c3"></canvas></div>
</section>
<section class="tables">
  <div><h2>Thresholds</h2><div id="th"></div><h2>Checks</h2><div id="checks"></div></div>
  <div><h2>Status codes</h2><div id="codes"></div><h2>Errors</h2><div id="errors"></div></div>
</section>
<p class="saved" id="saved"></p>`;
    document.getElementById('stop').onclick = () => { vscode.postMessage({ type: 'stop' }); document.getElementById('stop').disabled = true; document.getElementById('pill').textContent = 'Stopping'; };
    document.getElementById('rerun').onclick = () => vscode.postMessage({ type: 'rerun' });
    document.getElementById('report').onclick = () => vscode.postMessage({ type: 'openReport' });
    document.getElementById('compare').onclick = () => vscode.postMessage({ type: 'compare' });
  }

  function table(head, rows, numeric) {
    if (!rows.length) return '<p class="none">None yet.</p>';
    return `<table><thead><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function render() {
    const init = S.init;
    if (!init) return;
    const sum = (S.done && S.done.summary) || (S.last && S.last.summary) || null;
    const tick = S.ticks.length ? S.ticks[S.ticks.length - 1] : null;
    document.getElementById('name').textContent = init.name;
    document.getElementById('sub').textContent = `${init.hosts.join(', ')} · ${init.model === 'open' ? 'open model (requests per second)' : 'closed model (virtual users)'} · ${init.totalText}`;
    const elapsed = tick ? tick.t : 0;
    const total = init.totalMs / 1000;
    const pill = document.getElementById('pill');
    if (S.done) {
      const r = S.done;
      const th = r.thresholds || [];
      pill.className = 'pill ' + (th.length ? (r.pass ? 'ok' : 'bad') : 'neutral');
      pill.textContent = th.length ? (r.pass ? 'Passed' : 'Failed') : (r.stoppedBy === 'user' ? 'Stopped' : 'Finished');
      if (r.stoppedBy === 'user') pill.textContent += ' (stopped)';
    } else if (S.state === 'running') {
      pill.className = 'pill run';
      pill.textContent = `Running · ${tick && tick.phase ? tick.phase + ' · ' : ''}${clock(elapsed)} / ${clock(total)}`;
    }
    document.getElementById('bar').style.width = `${Math.min(100, (100 * (S.done ? total : elapsed)) / (total || 1))}%`;
    const running = !S.done;
    document.getElementById('stop').hidden = !running;
    for (const id of ['rerun', 'report', 'compare']) document.getElementById(id).hidden = running || (id === 'report' && !S.done.htmlPath) || (id === 'compare' && !S.done.jsonPath);

    const warn = [];
    if (tick && tick.saturated) warn.push('The load generator is at its limit (its event loop is busy). The requests per second shown are what this computer can send, not the limit of the server. Use fewer users or a lower rate to measure the server.');
    if (S.done && (S.done.warnings || []).includes('generator') && !(tick && tick.saturated)) warn.push('During this run the load generator was at its limit for 3 seconds or more. Read the results with care.');
    if ((tick && tick.dropped) || (S.done && (S.done.warnings || []).includes('dropped'))) warn.push('Some planned iterations were dropped because the server answered more slowly than the requested rate (maxVus requests were already waiting).');
    if (S.hostLag > 250) warn.push(`VS Code itself was slow for ${num(S.hostLag, 0)} ms. Other extensions may be busy.`);
    if (S.error) warn.push(S.error);
    document.getElementById('warn').innerHTML = warn.map((w) => `<div class="warning">${esc(w)}</div>`).join('');

    const tiles = [
      [running ? 'Requests/s now' : 'Requests/s (average)', running ? num(tick ? tick.rps : 0, 0) : num(sum ? sum.rps : 0, 1)],
      ['Requests', num(sum ? sum.requests : 0, 0)],
      ['p50', ms(sum && sum.latency.p50)], ['p95', ms(sum && sum.latency.p95)], ['p99', ms(sum && sum.latency.p99)],
      ['Errors', sum ? num(pct(sum.failed, sum.requests), 2) + ' %' : '-'],
      [running ? 'Active users' : 'Peak users', running ? num(tick ? tick.vus : 0, 0) : num(sum ? sum.peakVus : 0, 0)],
      ['Checks passed', sum && sum.checksTotal ? num(pct(sum.checksPassed, sum.checksTotal), 2) + ' %' : '-'],
    ];
    document.getElementById('tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');

    const th = (S.done && S.done.thresholds) || (S.last && S.last.thresholds) || [];
    document.getElementById('th').innerHTML = th.length ? table(['Rule', 'Now', ''], th.map((t) => [`<code>${esc(t.text)}</code>`, esc(t.actual == null ? '-' : num(t.actual, 2) + (t.unit ? ' ' + t.unit : '')), `<b class="${t.pass ? 'ok' : 'bad'}">${t.pass ? 'pass' : 'fail'}</b>`]), [1]) : '<p class="none">No thresholds in this test. Add for example <code>thresholds: ["p95 < 300ms", "errors < 1%"]</code>.</p>';
    const checks = sum ? sum.checks : [];
    document.getElementById('checks').innerHTML = table(['Check', 'Passed', 'Failed'], checks.map((c) => [esc(c.name), num(c.passed, 0), c.failed ? `<b class="bad">${num(c.failed, 0)}</b>` : '0']), [1, 2]);
    const codes = sum ? Object.entries(sum.statusCodes).sort() : [];
    document.getElementById('codes').innerHTML = table(['Status', 'Count', 'Share'], codes.map(([k, v]) => [`<span class="code c${esc(k[0])}">${esc(k)}</span>`, num(v, 0), num(pct(v, sum.requests), 1) + ' %']), [1, 2]);
    const errs = sum ? Object.entries(sum.errorKinds).sort((a, b) => b[1] - a[1]) : [];
    document.getElementById('errors').innerHTML = table(['Kind', 'Count'], errs.map(([k, v]) => [esc(k), num(v, 0)]), [1]);
    document.getElementById('saved').innerHTML = S.done && S.done.jsonPath ? `Saved: <code>${esc(S.done.jsonPath)}</code>${S.done.htmlPath ? ` and <code>${esc(S.done.htmlPath)}</code>` : ''}` : '';
    draw();
  }

  function chart(id, series, opts = {}) {
    const cv = document.getElementById(id);
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = cv.clientHeight || 160;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const right = series.filter((x) => x.right);
    const pad = { l: 46, r: right.length ? 34 : 8, t: 6, b: 18 };
    const total = S.init ? S.init.totalMs / 1000 : 1;
    const xMax = Math.max(total, ...series.flatMap((s) => s.points.map((p) => p[0])), 1);
    // A round top value and a number of grid steps that gives round labels (250 -> 5 steps of 50, 40 -> 4 of 10).
    const nice = (v) => { v = Math.max(1, v) * 1.05; const p10 = Math.pow(10, Math.floor(Math.log10(v))); const c = [[1, 4], [2, 4], [2.5, 5], [4, 4], [5, 5], [10, 4]].find(([m]) => m * p10 >= v) || [10, 4]; return { max: c[0] * p10, div: c[1] }; };
    const left = nice(Math.max(1, ...series.filter((x) => !x.right).flatMap((s) => s.points.map((p) => p[1]))));
    const yMax = left.max, div = left.div;
    const yMax2 = right.length ? nice(Math.max(1, ...right.flatMap((s) => s.points.map((p) => p[1]))) * (div === 5 ? 1.25 : 1)).max : 1;
    const fg = css('--vscode-descriptionForeground', '#888');
    const grid = css('--vscode-editorWidget-border', css('--vscode-panel-border', 'rgba(128,128,128,.25)'));
    const font = css('--vscode-font-family', 'sans-serif');
    g.font = `11px ${font}`; g.fillStyle = fg; g.strokeStyle = grid; g.lineWidth = 1;
    const X = (x) => pad.l + (x / xMax) * (w - pad.l - pad.r);
    const Y = (y, m = yMax) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(y, m) / m);
    g.textAlign = 'right';
    for (let i = 0; i <= div; i++) {
      const v = (yMax * i) / div, y = Math.round(Y(v)) + 0.5;
      g.globalAlpha = 0.6; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.globalAlpha = 1;
      g.fillText(num(v, v < 10 ? 1 : 0) + (opts.unit || ''), pad.l - 5, y + 4);
      if (right.length) { g.textAlign = 'left'; g.fillText(num((yMax2 * i) / div, 1), w - pad.r + 5, y + 4); g.textAlign = 'right'; }
    }
    g.textAlign = 'center';
    for (let i = 0; i <= 4; i++) { const v = (xMax * i) / 4; g.fillText(clock(v), X(v), h - 4); }
    for (const s of series) {
      if (!s.points.length) continue;
      g.strokeStyle = s.color; g.lineWidth = 1.8; g.setLineDash(s.dash ? [5, 4] : []);
      g.beginPath();
      const m = s.right ? yMax2 : yMax;
      s.points.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1], m)) : g.moveTo(X(p[0]), Y(p[1], m))));
      g.stroke();
    }
    g.setLineDash([]);
  }

  function draw() {
    const t = S.ticks;
    const c = { blue: css('--vscode-charts-blue', '#3794ff'), purple: css('--vscode-charts-purple', '#b180d7'), green: css('--vscode-charts-green', '#89d185'), red: css('--vscode-charts-red', '#f14c4c'), orange: css('--vscode-charts-orange', '#d18616') };
    chart('c1', [{ color: c.blue, points: t.map((s) => [s.t, s.rps]) }, { color: c.purple, dash: true, right: true, points: t.map((s) => [s.t, s.vus]) }]);
    chart('c2', [{ color: c.green, points: t.map((s) => [s.t, s.p50]) }, { color: c.blue, points: t.map((s) => [s.t, s.p95]) }, { color: c.orange, points: t.map((s) => [s.t, s.p99]) }], { unit: ' ms' });
    chart('c3', [{ color: c.red, points: t.map((s) => [s.t, s.requests ? (s.failed * s.rps) / s.requests : 0]) }]);
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // theme change

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      if (!S.init || m.runId !== S.init.runId) { S.ticks = []; S.last = null; S.done = null; S.error = ''; shell(); }
      S.init = m; S.state = 'running';
      document.getElementById('stop').disabled = false;
      schedule();
    } else if (m.type === 'tick' && S.init && m.runId === S.init.runId) {
      if (m.tick) S.ticks.push(m.tick);
      if (S.ticks.length > 7200) S.ticks.shift();
      S.last = m; S.hostLag = m.hostLagMs || 0;
      schedule();
    } else if (m.type === 'done' && S.init && m.runId === S.init.runId) {
      S.done = m.result; S.state = 'done';
      if (m.result.timeline && m.result.timeline.length) S.ticks = m.result.timeline.slice();
      S.done.htmlPath = m.htmlPath; S.done.jsonPath = m.jsonPath;
      schedule();
      vscode.postMessage({ type: 'rendered' });
    } else if (m.type === 'error') {
      S.error = m.message; S.state = 'done';
      if (!S.init) { app.innerHTML = `<div class="warning">${esc(m.message)}</div>`; return; }
      if (!S.done) S.done = { summary: S.last && S.last.summary, thresholds: [], warnings: [], stoppedBy: 'error' };
      schedule();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
