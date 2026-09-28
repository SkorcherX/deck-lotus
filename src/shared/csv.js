/**
 * A small RFC 4180 CSV reader: quoted fields, doubled quotes, commas and
 * newlines inside quotes ("2,062.34" is one field in a CardCastle export).
 * Import-free so it runs in the browser and in tests alike.
 *
 * Returns an array of objects keyed by the header row, with header names
 * trimmed. Blank lines are dropped.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonBlank = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (nonBlank.length === 0) return [];
  const header = nonBlank[0].map((h) => h.trim());
  return nonBlank.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** "2,062.34" / "$9.78" / "" → number or null. */
export function parseMoney(value) {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return String(value).trim() === '' || !Number.isFinite(n) ? null : n;
}
