import type { JourneyRecoveryCandidate, RecoveryDiagnostics, ReservedTrainSegment } from './types.js';
export const RECOVERY_WEIGHTS = { coverage: 1000, available: 200, rac: 120, selfManaged: 60, uncovered: 100, classPreference: 50, fare: 10 } as const;
export const reserved = (c: JourneyRecoveryCandidate) => c.segments.find((s): s is ReservedTrainSegment => s.type === 'RESERVED_TRAIN')!;
export function scoreRecovery(c: JourneyRecoveryCandidate, classes: readonly string[]): number {
  const w = RECOVERY_WEIGHTS; const r = reserved(c); const ratio = c.reservedCoverage.ratio;
  return w.coverage * ratio * ratio + (r.availability === 'AVAILABLE' ? w.available : w.rac) - w.selfManaged * c.selfManagedSegmentCount
    - w.uncovered * (1 - ratio) + w.classPreference / (1 + Math.max(0, classes.indexOf(r.classCode)))
    - (c.totalReservedFare === undefined ? 0 : w.fare * c.totalReservedFare / (c.totalReservedFare + 1000));
}
export function dominates(a: JourneyRecoveryCandidate, b: JourneyRecoveryCandidate): boolean {
  if (a.reservedCoverage.method !== b.reservedCoverage.method) return false;
  const ar = reserved(a), br = reserved(b);
  // Preserve class tradeoffs and incomparable unknown fares.
  if (ar.classCode !== br.classCode || (a.totalReservedFare === undefined) !== (b.totalReservedFare === undefined)) return false;
  const av = [a.reservedCoverage.ratio, ar.availability === 'AVAILABLE' ? 1 : 0, -a.selfManagedSegmentCount, -(a.totalReservedFare ?? 0)];
  const bv = [b.reservedCoverage.ratio, br.availability === 'AVAILABLE' ? 1 : 0, -b.selfManagedSegmentCount, -(b.totalReservedFare ?? 0)];
  return av.every((v, i) => v >= bv[i]) && av.some((v, i) => v > bv[i]);
}
export function rankRecovery(input: JourneyRecoveryCandidate[], d: RecoveryDiagnostics): JourneyRecoveryCandidate[] {
  const unique = new Map<string, JourneyRecoveryCandidate>();
  for (const c of input) {
    const key = JSON.stringify(c.segments.map((s) => s.type === 'SELF_MANAGED' ? [s.type, s.from.code, s.to.code] : [s.type, s.trainNumber, s.from.code, s.to.code, s.journeyDate, s.classCode, s.quota]));
    if (unique.has(key)) d.recoveryDuplicatesRemoved++; else unique.set(key, c);
  }
  const all = [...unique.values()];
  const survivors = all.filter((c) => !all.some((other) => other !== c && dominates(other, c)));
  d.recoveryDominatedCandidatesRemoved += all.length - survivors.length;
  survivors.sort((a, b) => b.score - a.score || JSON.stringify(a.segments).localeCompare(JSON.stringify(b.segments)));
  // Keep the best of each competitive recovery strategy before near-identical variants.
  const diverse: JourneyRecoveryCandidate[] = []; const types = new Set<string>();
  for (const c of survivors) if (!types.has(c.recoveryType) && c.score >= survivors[0].score - 150) { diverse.push(c); types.add(c.recoveryType); }
  return [...diverse, ...survivors.filter((c) => !diverse.includes(c))];
}
