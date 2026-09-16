export function stationCode(v: string): string { const code = v.trim().toUpperCase(); if (!/^[A-Z][A-Z0-9]{0,9}$/.test(code)) throw new Error(`Invalid station code ${v}`); return code; }
