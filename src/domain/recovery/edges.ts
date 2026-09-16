import type { TrainStop } from '../types/station.js';
import { coverage } from './coverage.js';
import { MIN_RESERVED_COVERAGE, type RecoveryConfig, type RecoveryDiagnostics, type ReservedCoverage } from './types.js';
export type Edge = { from: number; to: number; coverage: ReservedCoverage };
export function scoreRecoveryEdgeStation(edge: Edge): number { return edge.coverage.ratio; }
export function recoveryEdges(route: TrainStop[], i: number, j: number, config: RecoveryConfig, d: RecoveryDiagnostics): Edge[][] {
  const make = (from: number, to: number): Edge => ({ from, to, coverage: coverage(route, i, j, from, to) });
  const order = (a: Edge, b: Edge) => scoreRecoveryEdgeStation(b) - scoreRecoveryEdgeStation(a) || a.from - b.from || b.to - a.to;
  const board = Array.from({ length: Math.min(config.boarding, j - i - 1) }, (_, k) => make(i + k + 1, j)).sort(order);
  const drop = Array.from({ length: Math.min(config.drop, j - i - 1) }, (_, k) => make(i, j - k - 1)).sort(order);
  // Only bounded edge lists are paired, never the entire route.
  const both = board.flatMap((b) => drop.filter((e) => b.from < e.to).map((e) => make(b.from, e.to))).sort(order).slice(0, config.doublePairs);
  return [board, drop, both].map((edges) => edges.filter((edge) => {
    d.recoveryCandidatesGenerated++;
    if (edge.coverage.ratio + 1e-9 < MIN_RESERVED_COVERAGE) { d.recoveryCandidatesCoveragePruned++; return false; }
    return true;
  }));
}
