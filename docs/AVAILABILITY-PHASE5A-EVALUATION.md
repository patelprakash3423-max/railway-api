# Phase 5A: bounded candidate revisit

Deterministic offline evaluation from committed Phase 4 `eeb0484`. Production AUTO now revisits promising unresolved direct trains after every direct candidate has completed its first-pass opportunity. No station/class ordering or whole-leg breadth changes. No live RailKit, real Redis, deployment, commit or push.

## Algorithm

The original recovery closure retains its interval graph, visited edge identities, diagnostics and the same AvailabilitySession/global provider budget. Reinvestment does not restart the matrix or route-wide spine. Eligible candidates have positive reserved evidence, are not FULL, and stopped for FAIRNESS_RESERVE or MARGINAL_VALUE_LOW. EXACT_MATRIX_COMPLETE, exhausted scopes, provider/deadline failures and exhausted logical limits are excluded.

Each round prioritizes greater reserved coverage, then smaller uncovered distance, then original rank. Every eligible candidate gets at most one turn before the next round. A turn checks at most eight new gap edges and receives at most eight remaining provider attempts, further divided by the number of candidates still awaiting that round. These are scheduling shares; the unchanged global gate admits every attempt, including retries. Existing caches remain ahead of admission. There is never a new provider budget.

Missing direct gap edges precede gap subdivision using the existing class order and alternating inner-node order. The same production solver runs after every revisit observation and stops immediately on FULL. Explicit selections use separate single-class solves; only ALL mixes classes. WAITLIST/NOT_AVAILABLE remain negative evidence and errors/unvisited edges remain unknown. Freshness is revalidated by the existing solver/session path.

Reinvestment stops after at most four rounds, two turns without reserved-distance gain per candidate, gap-scope exhaustion, sufficient full results, deadline or resource exhaustion. Per-candidate and global logical allowances are cumulative. Known/visited edges are not requested again. These bounds deliberately do not guarantee complete discovery.

## Before/after measurements

| Fixture | Provider cap | First-pass calls | Calls with revisit | Revisit calls | Result before → after |
| --- | ---: | ---: | ---: | ---: | --- |
| Phase 4 no-revisit, cold | 80 | 55 | **59** | **4** | Partial → FULL; 21 calls remain |
| Same case, missing direct gap classes cached | 80 | 55 | **55** | **0** | Partial → FULL; four logical cache checks |
| Two partial trains with short negative gaps | 150 | 126 | 130 | 4 | Both remain partial; both get a turn |
| Two partial trains with wide negative gaps | 150 | 126 | 150 | 24 | Both remain partial; turns spend 8/8 then 4/4 |

The cold result improves on the Phase 4 separate-search continuation (nine additional calls) because it goes directly to missing gap evidence and solves after each observation. The first 55 observations are unchanged and none is requested again. The later three-node EXACT_MATRIX_COMPLETE candidate is never revisited. Final cap denial can add a logical check without a provider call; the wide-gap fixture records 25 revisit logical checks and 24 actual attempts.

Reproduce these cases in [candidate-revisit.test.ts](../src/local-railway/tests/candidate-revisit.test.ts). The Phase 4 harness defaults to internal `candidateRevisit: false` to preserve its historical measurements; Phase 5A fixtures explicitly enable it. Product AUTO defaults to enabled. This is an internal evaluation option, not a public request parameter. The Phase 4 report/artifact is not overwritten with Phase 5A results.

## Diagnostics

`candidateRevisit` is included in engine diagnostics, opt-in V2 response diagnostics and completion metrics: candidates, rounds, providerCalls, logicalChecks, fullRecoveries, and bounded per-turn round/train/count/stop records. Final per-train coverage/path diagnostics include retained first-pass evidence plus revisit evidence, without summing duplicate coverage. `SCOPE_EXHAUSTED` on a revisit means the selected gaps have no unvisited refinement edges; it does not claim full matrix coverage. Existing `truncated` diagnostics can remain true when a FULL journey is found before completing the matrix.

## Validation and remaining issues

- 17 new offline regressions cover the 55/80 baseline, unchanged first-pass prefix, no duplicate checks, exact exclusion, multi-round fairness, later-candidate priority, cache-free completion, explicit classes, WAITLIST/NOT_AVAILABLE, cumulative logical allowance, deadlines and provider caps 5/20/55/60/80/100/300.
- Final focused/full-suite, typecheck, build and whitespace results are recorded in the [architecture handoff](AVAILABILITY-ENGINE.md#phase-5a-bounded-candidate-revisit).
- Node 22.21.0 was used; repository target Node 24 was not exercised. Tests preload the external-network guard.

The first-pass station/class/train-order sensitivities and whole-leg breadth costs remain. Candidates with no reserved evidence are not revisited. Gap-only refinement, the four-round/two-no-gain limits, finite solver state retention and shared admission limits can still miss recoverable journeys. A provider retry may consume more than its estimated turn share, but cannot bypass the global gate. Once the global stopped latch fires, no new revisit begins, even if shared caches might contain more evidence. No Phase 5B work was started.
