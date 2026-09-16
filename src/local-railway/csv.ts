import { readFileSync } from 'node:fs';
/** RFC-style quoted CSV, including escaped quotes, CRLF, BOM and multiline fields. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const push = () => { row.push(field); field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === ',' || c === '\n' || c === '\r') {
      push();
      if (c !== ',') { if (row.some(s => s.trim())) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Malformed CSV quoting'); field += c; }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length || closed) { push(); if (row.some(s => s.trim())) rows.push(row); }
  return rows;
}
export function readCsv(path: string, required: string[]): Record<string, string>[] {
  try {
    const [rawHeaders, ...rows] = parseCsv(readFileSync(path, 'utf8'));
    if (!rawHeaders) throw new Error('Empty CSV');
    const headers = rawHeaders.map(h => h.trim().toLowerCase());
    if (new Set(headers).size !== headers.length || headers.some(h => !h)) throw new Error('Duplicate/blank headers');
    for (const h of required) if (!headers.includes(h)) throw new Error(`Incompatible schema: missing header ${h}`);
    return rows.map((r, i) => {
      if (r.length !== headers.length) throw new Error(`Record ${i + 2}: expected ${headers.length} columns, got ${r.length}`);
      return { ...Object.fromEntries(headers.map((h, j) => [h, r[j].trim()])), __record: String(i + 2) };
    });
  } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
}
