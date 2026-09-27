# Phase 5B: station/class fairness evaluation

Deterministic offline comparison using the unchanged Phase 4 fixtures. Both sides enable Phase 5A bounded revisit; only balancedFairness changes. No live provider or Redis. Run `node --import ./src/test-support/local-network-only.mjs --import tsx src/test-support/availability-evaluation/phase5b.ts` to regenerate this comparison and its JSON artifact.

Adaptive endpoint exploration first samples early, late and middle representatives across every eligible class, one station/class endpoint pair at a time. It then widens over the remaining stations in breadth-first regional order with rotating classes. Every station/class pair appears once. The pass length, solver batching, gap refinement cadence, whole-leg breadth, exact selector, provider gate and bounded revisit remain unchanged. No randomness or extra provider allowance is introduced.

Regional ordering retains early, tail, midpoint and second-tail opportunities, then bisects remaining route sections breadth-first. Left/right midpoint rounding is symmetric around the route center. It is based on route indices, not station names. Explicit-class filtering remains upstream; ALL alone permits mixed-class paths. The historical harness defaults to the previous order to preserve Phase 4/5A baseline artifacts; production AUTO enables the new order.

| Scenario | Cap | Calls before | Calls after | Full trains before | Full trains after | Partial trains before | Partial trains after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 300 | 20 | 20 | 0 | 0 | 0 | 0 |
| representative-cold | 300 | 180 | 180 | 0 | 0 | 0 | 0 |
| representative-warm90 | 300 | 18 | 18 | 0 | 0 | 0 | 0 |
| large-adaptive | 300 | 193 | 193 | 0 | 0 | 0 | 0 |
| very-large-adaptive | 300 | 293 | 293 | 0 | 0 | 0 | 0 |
| very-large-dense | 300 | 300 | 300 | 0 | 0 | 1 | 1 |
| very-large-branching | 300 | 293 | 293 | 0 | 0 | 1 | 1 |
| budget-5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 |
| budget-10 | 10 | 10 | 10 | 0 | 0 | 0 | 0 |
| budget-20 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |
| budget-50 | 50 | 50 | 50 | 0 | 0 | 0 | 0 |
| budget-100 | 100 | 100 | 100 | 0 | 0 | 0 | 0 |
| budget-300 | 300 | 193 | 193 | 0 | 0 | 0 | 0 |
| cache-0 | 300 | 193 | 193 | 0 | 0 | 0 | 0 |
| cache-25 | 300 | 132 | 132 | 0 | 0 | 0 | 0 |
| cache-50 | 300 | 86 | 86 | 0 | 0 | 0 | 0 |
| cache-75 | 300 | 48 | 48 | 0 | 0 | 0 | 0 |
| cache-90 | 300 | 21 | 21 | 0 | 0 | 0 | 0 |
| cache-100 | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| cache-path-0 | 300 | 49 | 21 | 1 | 1 | 0 | 0 |
| cache-path-25 | 300 | 32 | 16 | 1 | 1 | 0 | 0 |
| cache-path-50 | 300 | 21 | 10 | 1 | 1 | 0 | 0 |
| cache-path-75 | 300 | 9 | 5 | 1 | 1 | 0 | 0 |
| cache-path-90 | 300 | 4 | 3 | 1 | 1 | 0 | 0 |
| cache-path-100 | 300 | 0 | 0 | 1 | 1 | 0 | 0 |
| cache-only-hot | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| cache-only-redis | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| cache-only-persistent | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| cache-logical-global | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| cache-logical-candidate | 300 | 0 | 0 | 0 | 0 | 0 | 0 |
| position-1 | 25 | 9 | 9 | 1 | 1 | 0 | 0 |
| position-10 | 25 | 25 | 9 | 0 | 1 | 0 | 0 |
| position-17 | 25 | 9 | 9 | 1 | 1 | 0 | 0 |
| position-18 | 25 | 9 | 9 | 1 | 1 | 0 | 0 |
| class-SL | 50 | 50 | 13 | 0 | 1 | 0 | 0 |
| class-2A | 50 | 45 | 21 | 1 | 1 | 0 | 0 |
| class-2S | 50 | 50 | 37 | 0 | 1 | 0 | 0 |
| class-mixed | 150 | 49 | 21 | 1 | 1 | 0 | 0 |
| class-explicit | 150 | 45 | 45 | 0 | 0 | 1 | 1 |
| class-explicit-multiple | 150 | 89 | 82 | 0 | 0 | 1 | 1 |
| train-position-0 | 60 | 60 | 60 | 0 | 1 | 0 | 0 |
| train-position-1 | 60 | 60 | 60 | 0 | 1 | 0 | 0 |
| train-position-2 | 60 | 60 | 53 | 0 | 1 | 0 | 0 |
| train-position-0-100 | 100 | 100 | 99 | 1 | 1 | 0 | 0 |
| train-position-1-100 | 100 | 100 | 99 | 0 | 1 | 0 | 0 |
| train-position-2-100 | 100 | 100 | 81 | 0 | 1 | 0 | 0 |
| heterogeneous-30 | 30 | 28 | 28 | 1 | 1 | 1 | 1 |
| heterogeneous-60 | 60 | 56 | 55 | 1 | 1 | 1 | 1 |
| heterogeneous-100 | 100 | 86 | 84 | 1 | 1 | 1 | 1 |
| no-revisit | 80 | 59 | 52 | 1 | 1 | 0 | 0 |
| no-revisit-counterfactual | 80 | 64 | 52 | 1 | 1 | 0 | 0 |
| bridge-50-cold | 50 | 50 | 50 | 0 | 0 | 1 | 1 |
| bridge-50-warm | 50 | 50 | 50 | 0 | 0 | 1 | 1 |
| bridge-150-cold | 150 | 93 | 93 | 1 | 1 | 0 | 0 |
| bridge-150-warm | 150 | 91 | 91 | 1 | 1 | 0 | 0 |
| gap-no-bridge | 150 | 150 | 150 | 0 | 0 | 1 | 1 |
| direct-1-AVAILABLE | 300 | 5 | 5 | 1 | 1 | 0 | 0 |
| direct-1-RAC | 300 | 5 | 5 | 1 | 1 | 0 | 0 |
| direct-5-AVAILABLE | 300 | 25 | 25 | 5 | 5 | 0 | 0 |
| direct-5-RAC | 300 | 25 | 25 | 5 | 5 | 0 | 0 |
| direct-7-AVAILABLE | 300 | 35 | 35 | 7 | 7 | 0 | 0 |
| direct-7-RAC | 300 | 35 | 35 | 7 | 7 | 0 | 0 |
| partials-only | 300 | 300 | 300 | 0 | 0 | 5 | 5 |
| deadline-90000 | 300 | 190 | 190 | 0 | 0 | 1 | 1 |
| deadline-1000 | 300 | 54 | 54 | 0 | 0 | 1 | 1 |
| deadline-30 | 300 | 3 | 3 | 0 | 0 | 1 | 1 |
| failure-rate | 300 | 8 | 8 | 0 | 0 | 1 | 1 |
| failure-unavailable | 300 | 36 | 36 | 0 | 0 | 1 | 1 |
| failure-individual | 300 | 36 | 36 | 0 | 0 | 1 | 1 |

Total across these 69 synthetic fixtures: 4614 -> 4379 provider calls. This is an unweighted fixture total, not a production cost forecast. Per-fixture changes above matter more than the aggregate.

Full validation results and limitations are recorded in [the architecture handoff](AVAILABILITY-ENGINE.md#phase-5b-stationclass-fairness). The original Phase 4/5A reports remain historical baselines.
