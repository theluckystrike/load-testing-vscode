'use strict';
// CSV and TSV data files for the "data" key: one row per iteration. RFC 4180 quoting, a header row, a BOM is
// dropped. Limits keep a huge file from filling memory: the caller passes maxRows, and the file size is checked
// before it is read.

function parseCsv(text, { delimiter, maxRows = 1000000 } = {}) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const d = delimiter || (firstLine.split('\t').length > firstLine.split(',').length ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows = [];
  let row = [], field = '', q = false, i = 0, truncated = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { q = true; i++; continue; }
    if (c === d) { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rows.length > maxRows) { truncated = true; break; }
      continue;
    }
    field += c; i++;
  }
  if (!truncated && (field !== '' || row.length)) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return { columns: [], rows: [], truncated: false, delimiter: d };
  const columns = rows[0].map((h, k) => String(h).trim() || `col${k + 1}`);
  const out = rows.slice(1, maxRows + 1).map((r) => Object.fromEntries(columns.map((h, k) => [h, r[k] == null ? '' : r[k]])));
  return { columns, rows: out, truncated, delimiter: d };
}

module.exports = { parseCsv };
