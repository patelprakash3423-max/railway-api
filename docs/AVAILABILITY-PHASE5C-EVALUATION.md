# Phase 5C: sufficient direct results

AUTO now defers lower-preference whole-leg class checks under ALL once at least five distinct direct trains (or the larger internal usable target) have fresh normalized AVAILABLE whole-leg evidence. Every train retains its initial whole-leg opportunity. Higher-preference classes, RAC/unknown trains, explicit selections and candidates with observed fares retain class comparison. Preference comes from the existing recovery ranking; no availability is predicted. The recovery stage consumes retained evidence without refilling deferred classes, and reports SUFFICIENT_HIGH_QUALITY_RESULTS with truthful incomplete matrix coverage.

Unresolved trains with faster or tied schedules retain first-pass recovery even when five strong whole-leg results exist. A strictly worse duration/distance than the fifth strong schedule can stop deep checks: even ideal AVAILABLE inventory cannot improve the ranking dimensions preceding fare. Existing station/class ordering, recovery reservations, bounded revisit, ranking, solver, provider admission and caches remain in use. The global 300-call limit remains a ceiling. The internal `sufficientDirectResults: false` comparison switch preserves historical harness behavior and is not a public request option.

## Before/after

Both sides enable Phase 5A revisit and Phase 5B fairness. These are the original Phase 4 fixtures using the same planner/provider-boundary harness; the old reports/artifacts are unchanged.

| Fixture | Calls until fifth FULL before/after | Calls until fifth strong FULL before/after | Calls after fifth FULL before/after | Total before/after | Final results |
| --- | --- | --- | --- | --- | --- |
| 5 trains, AVAILABLE | 5 / 5 | 5 / 5 | 20 / 10 | 25 / 15 | Same five FULL trains, order, 2A class and reservation parts |
| 7 trains, AVAILABLE | 5 / 5 | 5 / 5 | 30 / 16 | 35 / 21 | Same seven FULL trains and best five, 2A class and reservation parts |
| 5 trains, RAC | 5 / 5 | none / none | 20 / 20 | 25 / 25 | Identical; RAC does not trigger strong-result stopping |
| 7 trains, RAC | 5 / 5 | none / none | 30 / 30 | 35 / 35 | Identical; preserve possible AVAILABLE upgrades |

The AVAILABLE cases reduce total calls by 40%, and post-fifth calls by 50% / 46.7%. Keeping 3A and 2A checks preserves the solver's class preference; stopping after SL alone failed the result-comparison regression and is not the implemented policy. Whole-leg evidence supplies the strong milestone; the existing harness's FULL milestone also includes RAC and split paths.

All 69 original fixture comparisons retain identical ranked result summaries, including reservation parts and selected classes. Only the two AVAILABLE rows change call counts: the unweighted fixture total is 4,379 before and 4,355 after. This aggregate is not a production cost forecast.

Reproduce all 69 Phase 4 fixture comparisons with `node --import ./src/test-support/local-network-only.mjs --import tsx src/test-support/availability-evaluation/phase5c.ts`. The [JSON artifact](evaluation/phase5c-results.json) records total and milestone calls, complete ranked result summaries, best five and initial candidate opportunities. The [focused regressions](../src/local-railway/tests/sufficient-direct-results.test.ts) additionally cover forward/reverse/shuffled candidate orders, later-class AVAILABLE upgrades, later-train split recovery, known cheaper fares, explicit classes, the strong threshold, cache tiers and caps 4/5/6/7/20/300.

## Fairness and limitations

All seven direct trains retain an initial opportunity in each tested permutation. Existing best-five order is preserved within each permutation; original schedule-rank tie breaking still applies. Later RAC trains reach 2S AVAILABLE, and later unresolved trains retain midpoint split recovery. The change neither assigns inventory to skipped classes nor claims exhaustive class or matrix discovery.

This deliberately leaves RAC-only overspend unchanged. Lower-preference unqueried classes may contain previously unknown fares or user-valued amenities; no offline stop can rule those out without querying them. Observed fare comparisons are protected, but this is an initial best-five policy, not a guarantee of globally cheapest inventory or enumeration of every ALL-class alternative. Synthetic no-fare fixtures cannot establish production savings. Existing budget/freshness limits, finite solver retention and bounded revisit limitations remain. Node 24, live provider and real Redis validation are outside this run.

## Validation

- Focused Phase 5C: **33 passed, 0 failed** (`sufficient-direct-results.test.ts`).
- Phase 1–5B cross-phase regressions: **262 passed, 0 failed**, covering provider budget, observations/persistence, Redis, evidence search, historical evaluation, revisit and station/class fairness. The older six-train sufficient-result assertion now expects 18 calls instead of 30; its FULL/stop/coverage assertions remain.
- `npm test`: **1,160 passed, 0 failed, 0 skipped**.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed. New files also passed trailing-whitespace checks. Git only emitted LF/CRLF notices.
- All 69 comparison rows and the completed JSON artifact were verified. Windows PowerShell classified Node's SQLite experimental warning as a native-command error despite completed measurement output; no scenario failed.
- Installed runtime: Node **22.21.0**; repository target Node 24 was not exercised. All test/evaluation commands preload the external-network guard. No live calls, commit, push or deployment.
