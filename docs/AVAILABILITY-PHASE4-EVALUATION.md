# Phase 4: deterministic offline availability evaluation

Measured against committed Phase 3 baseline bd1f8c0. 70 deterministic scenarios; no production search changes. Runtime: v22.21.0 (repository target: Node 24.x). This is synthetic offline evidence, not a statistical estimate of production performance.

## Reproduce and inspect

- Run `npm run evaluate:availability` to regenerate this report and [machine-readable measurements](evaluation/phase4-results.json). Append scenario IDs to run a subset; subsets write only an ignored scratch result.
- Run `node --import ./src/test-support/local-network-only.mjs --import tsx --test src/local-railway/tests/availability-evaluation.test.ts` for truth, budget, fairness, cache, repeatability and structural regressions.
- Sources: [harness](../src/test-support/availability-evaluation/harness.ts), [fixtures](../src/test-support/availability-evaluation/scenarios.ts), [suite and continuation](../src/test-support/availability-evaluation/suite.ts), [report generator](../src/test-support/availability-evaluation/report.ts), [CLI](../src/test-support/availability-evaluation/run.ts), [tests](../src/local-railway/tests/availability-evaluation.test.ts).

The real LocalJourneyPlannerV2 discovers schedules in an in-memory timetable; the harness only permutes its direct candidates. JourneyRecoveryOrchestrator, AvailabilitySession, normalization, admission, AvailabilityScheduler, hot cache, Redis cache validation, SQLite latest observations, freshness and intervalPaths all execute production code. Only the inventory provider boundary, clock and Redis transport are fake. The fixture never instantiates RailKit or connects to Redis. Networking is blocked by the repository guard.

Routes use synthetic ordered A/S1/…/B nodes, one same-day run, 100 km spacing and authoritative class fixtures. Sizes/order, classes, request selection, provider/logical/candidate limits, inventory, cache fraction/tier, deadline and failure point are configurable. The default inventory is WAITLIST; failure scenarios also include explicit NOT_AVAILABLE. Full results always require observed AVAILABLE/RAC reservation parts. No second planner is implemented.

Every scenario has isolated caches. A stable seeded hash selects exactly the rounded requested cache fraction; mixed seeds cycle through hot, Redis and SQLite. Hot priming naturally writes lower tiers too, but precedence makes the observed source exclusive. Separate tier-only cases validate attribution. Burst/monthly limits are raised to isolate the per-search provider limit; hot capacity is raised to avoid fixture seeding eviction. These choices do not represent deployed quota/cache capacity. The fake provider costs 1 ms per attempt, or 10 ms in deadline cases; cache operations cost zero simulated time. Real Redis/SDK latency, retries, transport cancellation and multi-instance behavior are outside this evaluation and retain their existing regression coverage.

## Metric semantics

All production diagnostics are preserved in JSON, including per-train exploration, hot/Redis/persistent hits, logical checks, provider limit/remaining, station/class breadth, solver path counts and stop reasons. Coverage is distinct fresh observed class-labelled edges divided by C×N×(N−1)/2, summed across trains. Failed/denied attempts are not checked inventory. Logical checks include denied requests; passive session rehydration does not add checks or cache hits.

Full/partial path counts are retained solver alternatives, not distinct trains. The table uses these production counts; JSON separately records fullJourneys and partialJourneys. Calls/full divides by fullPathsFound. Cache reuse ratio is (hot + Redis + persistent hits) / logical checks, excluding compatibility aliases. Coverage/call is checked edges per actual provider attempt. A zero denominator produces null, never infinity.

First-full and best-five milestones replay the observation trace into the same production intervalPaths solver after profiling. They record when available evidence first suffices, not when the scheduler next solves or publishes results. Best-five is measurable here as five distinct fully reserved physical trains; it is not proof of the globally best five ranked alternatives. Explicit multi-class replay solves each class separately. Replay does not influence the measured search or solver counts.

## Scenario measurements

Mode abbreviations: EXACT = EXACT_MATRIX; ADAPTIVE = ADAPTIVE_GRAPH. Stops: COMPLETE = EXACT_MATRIX_COMPLETE; SUFFICIENT = SUFFICIENT_HIGH_QUALITY_RESULTS; MARGINAL = MARGINAL_VALUE_LOW; BUDGET = PROVIDER_BUDGET_EXHAUSTED; LOGICAL = LOGICAL_SAFETY_LIMIT; RATE = PROVIDER_RATE_LIMIT; UNAVAILABLE = PROVIDER_UNAVAILABLE; RESERVE = FAIRNESS_RESERVE; SCOPE = SCOPE_EXHAUSTED. N lists heterogeneous train sizes where necessary; C is selected eligible classes.

### size

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| small-exact | 5 | 2 | 20 | EXACT | 300 | 20 | 20 | 0.0% | 100.00% | 0 | 0 | COMPLETE |
| representative-cold | 9 | 5 | 180 | EXACT | 300 | 180 | 180 | 0.0% | 100.00% | 0 | 0 | COMPLETE |
| representative-warm90 | 9 | 5 | 180 | EXACT | 300 | 18 | 180 | 90.0% | 100.00% | 0 | 0 | COMPLETE |
| large-adaptive | 20 | 5 | 950 | ADAPTIVE | 300 | 193 | 193 | 0.0% | 20.32% | 0 | 0 | MARGINAL |
| very-large-adaptive | 30 | 5 | 2175 | ADAPTIVE | 300 | 293 | 293 | 0.0% | 13.47% | 0 | 0 | MARGINAL |

### complexity

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| very-large-dense | 30 | 5 | 2175 | ADAPTIVE | 300 | 300 | 301 | 0.0% | 13.79% | 0 | 15 | BUDGET |
| very-large-branching | 30 | 5 | 2175 | ADAPTIVE | 300 | 293 | 293 | 0.0% | 13.47% | 0 | 64 | MARGINAL |

### budget

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| budget-5 | 20 | 5 | 950 | ADAPTIVE | 5 | 5 | 6 | 0.0% | 0.53% | 0 | 0 | BUDGET |
| budget-10 | 20 | 5 | 950 | ADAPTIVE | 10 | 10 | 11 | 0.0% | 1.05% | 0 | 0 | BUDGET |
| budget-20 | 20 | 5 | 950 | ADAPTIVE | 20 | 20 | 21 | 0.0% | 2.11% | 0 | 0 | BUDGET |
| budget-50 | 20 | 5 | 950 | ADAPTIVE | 50 | 50 | 51 | 0.0% | 5.26% | 0 | 0 | BUDGET |
| budget-100 | 20 | 5 | 950 | ADAPTIVE | 100 | 100 | 101 | 0.0% | 10.53% | 0 | 0 | BUDGET |
| budget-300 | 20 | 5 | 950 | ADAPTIVE | 300 | 193 | 193 | 0.0% | 20.32% | 0 | 0 | MARGINAL |

### cache

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cache-0 | 20 | 5 | 950 | ADAPTIVE | 300 | 193 | 193 | 0.0% | 20.32% | 0 | 0 | MARGINAL |
| cache-25 | 20 | 5 | 950 | ADAPTIVE | 300 | 132 | 193 | 31.6% | 20.32% | 0 | 0 | MARGINAL |
| cache-50 | 20 | 5 | 950 | ADAPTIVE | 300 | 86 | 193 | 55.4% | 20.32% | 0 | 0 | MARGINAL |
| cache-75 | 20 | 5 | 950 | ADAPTIVE | 300 | 48 | 193 | 75.1% | 20.32% | 0 | 0 | MARGINAL |
| cache-90 | 20 | 5 | 950 | ADAPTIVE | 300 | 21 | 193 | 89.1% | 20.32% | 0 | 0 | MARGINAL |
| cache-100 | 20 | 5 | 950 | ADAPTIVE | 300 | 0 | 950 | 100.0% | 100.00% | 0 | 0 | SCOPE |
| cache-only-hot | 9 | 5 | 180 | EXACT | 300 | 0 | 180 | 100.0% | 100.00% | 0 | 0 | COMPLETE |
| cache-only-redis | 9 | 5 | 180 | EXACT | 300 | 0 | 180 | 100.0% | 100.00% | 0 | 0 | COMPLETE |
| cache-only-persistent | 9 | 5 | 180 | EXACT | 300 | 0 | 180 | 100.0% | 100.00% | 0 | 0 | COMPLETE |

### cache-path

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cache-path-0 | 20 | 5 | 950 | ADAPTIVE | 300 | 49 | 49 | 0.0% | 5.16% | 1 | 2 | SUFFICIENT |
| cache-path-25 | 20 | 5 | 950 | ADAPTIVE | 300 | 32 | 49 | 34.7% | 5.16% | 1 | 2 | SUFFICIENT |
| cache-path-50 | 20 | 5 | 950 | ADAPTIVE | 300 | 21 | 49 | 57.1% | 5.16% | 1 | 2 | SUFFICIENT |
| cache-path-75 | 20 | 5 | 950 | ADAPTIVE | 300 | 9 | 49 | 81.6% | 5.16% | 1 | 2 | SUFFICIENT |
| cache-path-90 | 20 | 5 | 950 | ADAPTIVE | 300 | 4 | 49 | 91.8% | 5.16% | 1 | 2 | SUFFICIENT |
| cache-path-100 | 20 | 5 | 950 | ADAPTIVE | 300 | 0 | 49 | 100.0% | 5.16% | 1 | 2 | SUFFICIENT |

### limits

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cache-logical-global | 20/20/20 | 5 | 2850 | ADAPTIVE | 300 | 0 | 25 | 100.0% | 0.88% | 0 | 0 | LOGICAL |
| cache-logical-candidate | 20 | 5 | 950 | ADAPTIVE | 300 | 0 | 35 | 100.0% | 3.68% | 0 | 0 | LOGICAL |

### position

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| position-1 | 20 | 1 | 190 | ADAPTIVE | 25 | 9 | 9 | 0.0% | 4.74% | 1 | 2 | SUFFICIENT |
| position-10 | 20 | 1 | 190 | ADAPTIVE | 25 | 25 | 26 | 0.0% | 13.16% | 0 | 0 | BUDGET |
| position-17 | 20 | 1 | 190 | ADAPTIVE | 25 | 9 | 9 | 0.0% | 4.74% | 1 | 2 | SUFFICIENT |
| position-18 | 20 | 1 | 190 | ADAPTIVE | 25 | 9 | 9 | 0.0% | 4.74% | 1 | 2 | SUFFICIENT |

### class

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| class-SL | 20 | 5 | 950 | ADAPTIVE | 50 | 50 | 51 | 0.0% | 5.26% | 0 | 0 | BUDGET |
| class-2A | 20 | 5 | 950 | ADAPTIVE | 50 | 45 | 45 | 0.0% | 4.74% | 1 | 2 | SUFFICIENT |
| class-2S | 20 | 5 | 950 | ADAPTIVE | 50 | 50 | 51 | 0.0% | 5.26% | 0 | 0 | BUDGET |
| class-mixed | 20 | 5 | 950 | ADAPTIVE | 150 | 49 | 49 | 0.0% | 5.16% | 1 | 2 | SUFFICIENT |
| class-explicit | 20 | 1 | 190 | ADAPTIVE | 150 | 45 | 45 | 0.0% | 23.68% | 0 | 1 | MARGINAL |
| class-explicit-multiple | 20 | 2 | 380 | ADAPTIVE | 150 | 89 | 89 | 0.0% | 23.42% | 0 | 2 | MARGINAL |

### train

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| train-position-0 | 20/20/20 | 1 | 570 | ADAPTIVE | 60 | 60 | 61 | 0.0% | 10.53% | 0 | 0 | BUDGET |
| train-position-1 | 20/20/20 | 1 | 570 | ADAPTIVE | 60 | 60 | 61 | 0.0% | 10.53% | 0 | 0 | BUDGET |
| train-position-2 | 20/20/20 | 1 | 570 | ADAPTIVE | 60 | 60 | 61 | 0.0% | 10.53% | 0 | 0 | BUDGET |
| train-position-0-100 | 20/20/20 | 1 | 570 | ADAPTIVE | 100 | 100 | 101 | 0.0% | 17.54% | 1 | 2 | BUDGET |
| train-position-1-100 | 20/20/20 | 1 | 570 | ADAPTIVE | 100 | 100 | 101 | 0.0% | 17.54% | 0 | 0 | BUDGET |
| train-position-2-100 | 20/20/20 | 1 | 570 | ADAPTIVE | 100 | 100 | 101 | 0.0% | 17.54% | 0 | 0 | BUDGET |
| heterogeneous-30 | 20/20/4 | 5 | 1930 | ADAPTIVE | 30 | 24 | 24 | 0.0% | 1.24% | 1 | 3 | RESERVE |
| heterogeneous-60 | 20/20/4 | 5 | 1930 | ADAPTIVE | 60 | 52 | 52 | 0.0% | 2.69% | 1 | 3 | RESERVE |
| heterogeneous-100 | 20/20/4 | 5 | 1930 | ADAPTIVE | 100 | 82 | 82 | 0.0% | 4.25% | 1 | 3 | RESERVE |

### revisit

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| no-revisit | 20/3 | 5 | 965 | MIXED | 80 | 55 | 55 | 0.0% | 5.70% | 0 | 1 | RESERVE |
| no-revisit-counterfactual | 20/3 | 5 | 965 | MIXED | 80 | 64 | 64 | 0.0% | 6.63% | 1 | 2 | SUFFICIENT |
| no-revisit-retained-evidence | 20 | 5 | 950 | ADAPTIVE | 25 | 9 | 49 | 81.6% | 5.16% | 1 | 2 | SUFFICIENT |

### gap

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| bridge-50-cold | 20 | 5 | 950 | ADAPTIVE | 50 | 50 | 51 | 0.0% | 5.26% | 0 | 7 | BUDGET |
| bridge-50-warm | 20 | 5 | 950 | ADAPTIVE | 50 | 50 | 52 | 1.9% | 5.37% | 0 | 7 | BUDGET |
| bridge-150-cold | 20 | 5 | 950 | ADAPTIVE | 150 | 93 | 93 | 0.0% | 9.79% | 4 | 31 | SUFFICIENT |
| bridge-150-warm | 20 | 5 | 950 | ADAPTIVE | 150 | 91 | 93 | 2.2% | 9.79% | 4 | 31 | SUFFICIENT |
| gap-no-bridge | 20 | 5 | 950 | ADAPTIVE | 150 | 150 | 151 | 0.0% | 15.79% | 0 | 15 | BUDGET |

### direct

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| direct-1-AVAILABLE | 20 | 5 | 950 | ADAPTIVE | 300 | 5 | 5 | 0.0% | 0.53% | 5 | 0 | SUFFICIENT |
| direct-1-RAC | 20 | 5 | 950 | ADAPTIVE | 300 | 5 | 5 | 0.0% | 0.53% | 5 | 0 | SUFFICIENT |
| direct-5-AVAILABLE | 20/20/20/20/20 | 5 | 4750 | ADAPTIVE | 300 | 25 | 25 | 0.0% | 0.53% | 25 | 0 | SUFFICIENT |
| direct-5-RAC | 20/20/20/20/20 | 5 | 4750 | ADAPTIVE | 300 | 25 | 25 | 0.0% | 0.53% | 25 | 0 | SUFFICIENT |
| direct-7-AVAILABLE | 20/20/20/20/20/20/20 | 5 | 6650 | ADAPTIVE | 300 | 35 | 35 | 0.0% | 0.53% | 35 | 0 | SUFFICIENT |
| direct-7-RAC | 20/20/20/20/20/20/20 | 5 | 6650 | ADAPTIVE | 300 | 35 | 35 | 0.0% | 0.53% | 35 | 0 | SUFFICIENT |
| partials-only | 20/20/20/20/20 | 5 | 4750 | ADAPTIVE | 300 | 300 | 301 | 0.0% | 6.32% | 0 | 9 | BUDGET |

### deadline

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| deadline-90000 | 20 | 1 | 190 | EXACT | 300 | 190 | 190 | 0.0% | 100.00% | 0 | 1 | COMPLETE |
| deadline-1000 | 20 | 1 | 190 | ADAPTIVE | 300 | 53 | 53 | 0.0% | 27.89% | 0 | 1 | MARGINAL |
| deadline-30 | 20 | 1 | 190 | ADAPTIVE | 300 | 3 | 3 | 0.0% | 1.58% | 0 | 1 | DEADLINE |

### failure

| Scenario | N | C | Possible | Mode | Budget | Calls | Logical | Cache reuse | Coverage | Full paths | Partial paths | Stop |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| failure-rate | 9 | 1 | 36 | EXACT | 300 | 8 | 8 | 0.0% | 19.44% | 0 | 1 | RATE |
| failure-unavailable | 9 | 1 | 36 | EXACT | 300 | 36 | 36 | 0.0% | 19.44% | 0 | 1 | UNAVAILABLE |
| failure-individual | 9 | 1 | 36 | EXACT | 300 | 36 | 36 | 0.0% | 97.22% | 0 | 1 | UNAVAILABLE |

## Findings

### Exact, adaptive and budgets

N=5/C=2 completes all 20 edges. N=9/C=5 completes all 180 edges: 180 cold calls, 18 with 90% seeded cache. Both choose exact. N=20/C=5 chooses adaptive and stops at 193/950 edges (20.32%) with low marginal value; N=30/C=5 reaches 293/2,175 (13.47%). Neither treats 300 as a spending target. Budgets 5/10/20/50/100 stop at the cap with unknown distance retained. Budget 300 stops early at 193 in the negative-only fixture. No provider cap violation was observed. Independent global and per-candidate logical bounds also terminate cache-only exploration.

### Cache effectiveness

At 0/25/50/75/90% warm evidence, the same negative-only adaptive traversal checks 193 edges with 193/132/86/48/21 calls. At 100%, it traverses all 950 logical edges for zero provider calls and SCOPE_EXHAUSTED. Cache-only batches avoid paid marginal stopping. With a useful mixed-class path, all six fractions find a full journey at 49/32/21/9/4/0 calls. That positive fixture appropriately stops below complete coverage even when fully cached. Hot-only, Redis-only and SQLite-only N=9 fixtures each report 180 hits in the correct layer, 100% coverage and zero calls. Shared-cache warmth is not speculatively discounted by the exact selector; the 950-edge warm case remains ADAPTIVE.

### Station and class fairness

The same 25-call, one-class budget finds splits at indices 1, 17 and 18, each using 9 calls; the split at index 10 is missed. Alternating ends protects the tail but favors endpoints over the center under tight budgets. This is a quality limitation, not a violation of the documented promise of an early tail opportunity.

With five classes, split index 18 and budget 50, the middle eligible class 2A is found in 45 calls; first SL and last 2S are both missed. Station/pass class rotation creates a joint station/class ordering effect, not simply first-class preference. ALL recovers the SL→3A split; explicit SL and explicit SL/3A retain partial evidence without borrowing/mixing classes.

### Train ordering and no revisit

With three large trains and budget 60, the useful middle-route split is missed in all three positions. At budget 100 it is found only when its train is first; second and last positions miss it. Global whole-leg breadth and reservations do not guarantee equal recovery depth. The heterogeneous unresolved/partial/small-full fixture does find the cheap third train at budgets 30/60/100, spending 24/52/82 calls respectively.

The no-revisit fixture spends 55/80 calls, leaves 25 unused and retains A→S1 on Train A. Its final reason is FAIRNESS_RESERVE; Train B's 3-node exact scope is negative. Reversing candidate order finds A's mixed-class full path within 64 calls. More directly, a separate evaluation-only continuation seeds only A's actually observed evidence and gives it only the 25 unspent calls: it completes with 9 additional calls (64 combined), with first sufficient full evidence after 5 additional calls. This proves a material lost recoverable journey. It does not implement or claim production revisit support.

### WAITLIST gaps

A→S5 and S14→B are reserved; S5→S14 remains WAITLIST. Bridging uses S5→S6 in SL and S6→S14 in 3A. At budget 50, both cold and warm-bridge searches remain partial. At budget 150, cold/warm find full paths in 93/91 calls; the two fresh bridge observations save two provider attempts. Without positive bridge evidence, no full path is fabricated and both reserved portions remain. Warm evidence only helps once the scheduler requests its edges.

### Direct full and sufficient results

| Scenario | Full trains | Total calls | First full evidence | Fifth full evidence | Calls after first | Calls after fifth | Calls/full solver path | Checked edges/call |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct-1-AVAILABLE | 1 | 5 | 1 | — | 4 | — | 1 | 1 |
| direct-1-RAC | 1 | 5 | 1 | — | 4 | — | 1 | 1 |
| direct-5-AVAILABLE | 5 | 25 | 1 | 5 | 24 | 20 | 1 | 1 |
| direct-5-RAC | 5 | 25 | 1 | 5 | 24 | 20 | 1 | 1 |
| direct-7-AVAILABLE | 7 | 35 | 1 | 5 | 34 | 30 | 1 | 1 |
| direct-7-RAC | 7 | 35 | 1 | 5 | 34 | 30 | 1 | 1 |
| partials-only | 0 | 300 | — | — | — | — | — | 1 |

AVAILABLE and RAC behave alike for stopping. With 1/5/7 immediately usable direct trains, the first full evidence costs 1 call and total breadth costs 5/25/35. Fifth full evidence costs 5 calls, leaving 20/30 further calls in the five/seven-train cases. Sufficient-result stopping suppresses interval recovery but does not interrupt the all-train/all-class whole-leg breadth pass. This is bounded alternative collection with measurable additional cost. The five-partial-train case correctly spends up to 300 and never reports sufficient full results.

### Deadlines and failures

Generous 90,000 ms permits a 190-edge one-class exact matrix. At 1,000 ms, adaptive stops for low marginal value after 53 calls/530 simulated ms; labelling that DEADLINE would be false. At 30 ms it stops after 3 calls with DEADLINE and retains its partial reservation. Rate limiting at call 8 stops with 7 valid edges. Persistent unavailability and a single failed request both prevent exact completion; the latter retains 35/36 valid edges. Previously observed reserved evidence survives and errors do not become negative inventory. These are planner deadline allowances, not a simulation of the protected HTTP abort/504 response.

## Structural complexity

V8 in-process precise coverage counts actual production intervalPaths calls and frontier add attempts. Anonymous frontier callbacks are identified from their source range, because runtime-assigned names are not reliable coverage names. Profiling ends before milestone replay. Generated intervals come from real recovery diagnostics; requested class edges count unique edge objects sent through the session/provider boundary, including a denied miss. Matrix iterator entries include generator creation/resumption and completion, and are not an exact yielded-edge count. The 512-entry frontier and 64 retained states/node are enforced production bounds, not measured peak heap/state occupancy. Frontier add attempts include rejected/deduplicated additions. No assertion relies on wall-clock timing or heap deltas.

| Scenario | Generated intervals | Requested class edges | Matrix iterator entries | Frontier add attempts | Frontier bound | Solver calls | Approx ms | Heap delta MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| large-adaptive | 39 | 193 | 39 | 223 | 512 | 4 | 832 | 13.36 |
| very-large-adaptive | 59 | 293 | 39 | 323 | 512 | 4 | 1080 | -6.30 |
| very-large-dense | 61 | 301 | 57 | 351 | 512 | 5 | 675 | 10.83 |
| very-large-branching | 59 | 293 | 39 | 43 | 512 | 28 | 1064 | -5.33 |
| cache-100 | 190 | 950 | 952 | 1430 | 512 | 4 | 1982 | 5.06 |

The N=30 cold and interior-positive fixtures need only 4/5 solver invocations; the branching fixture additionally exercises repeated solves with many usable prefixes. Structural bounds prevent unbounded enumeration in these fixtures. This does not prove an asymptotic complexity bound for all inventories. Known-evidence cost scans still visit the potential matrix. Durations include profiler overhead and local scheduling; heap deltas can be negative because of GC and are not peak memory. Real latency/memory benchmarking needs a separate controlled runtime.

## Validation

Validation commands and final results are recorded in the Phase 4 handoff in [AVAILABILITY-ENGINE.md](AVAILABILITY-ENGINE.md#phase-4-offline-evaluation-handoff). No live RailKit, real Redis, server startup, heuristic tuning, commit, push or deployment is part of this phase.

## Decisions

### CORRECTNESS BUGS

None demonstrated by these scenarios and truth/accounting regressions. Provider caps, valid coverage, explicit-class isolation, continuous evidence-backed full paths, unknown gaps and deadline/failure reporting hold. No production fix or API metric change was made. This does not establish correctness for every real provider response.

### QUALITY ISSUES

| Reproduction | Observed | Desired | Responsible stage | Block controlled live validation? |
| --- | --- | --- | --- | --- |
| no-revisit + retained-evidence continuation | Partial at 55/80; 9 more calls can complete | Spend an explicitly bounded residual share on promising deferred trains | One-pass direct recovery reservation | No for a small diagnostic run; prioritize before claiming search completeness |
| position-10 versus position-1/17/18 | Center missed at 25; ends found at 9 | More balanced discovery probability across positions | Alternating endpoint spine | No; quality limitation must be recorded |
| class-SL / class-2A / class-2S | Only middle class found at budget 50 | Reduce station/class rotation sensitivity | Class rotation across spine passes | No; avoid claims of class-independent recall |
| train-position-*-100 | Useful train found only in first position | Less candidate-order dependence under a shared cap | Sequential reservation/deepening | No for diagnosis; prioritize before broad quality validation |
| bridge-50-warm | Cached bridge still misses full | Reach useful gap evidence sooner when affordable | Breadth before bridge refinement; caches discovered on demand | No; constrained-budget tradeoff, no invented coverage |

### EFFICIENCY ISSUES

| Reproduction | Observed | Desired | Responsible stage | Block controlled live validation? |
| --- | --- | --- | --- | --- |
| direct-5/7-AVAILABLE and RAC | 20/30 calls after fifth full evidence | Evaluate whether extra classes/trains justify their provider cost | Whole-leg breadth precedes sufficient-result stop | No; bounded, but measure value before changing policy |
| position-1 / class-mixed / bridge-150-cold | 6/7/7 calls after first sufficient path evidence | Balance earlier solving against CPU cost | Eight-check solver batching | No; bounded overshoot |
| failure-unavailable | Calls 8–36 continue failing (29 failures total) | Consider a separate failure-aware stop policy | Exact matrix continues after individual provider errors | No; cap holds, but waste should be evaluated |
| cache-25 through cache-90 | Lower call cost without more than 193 checked edges | Assess whether cheap wider search improves recall | Paid marginal-value stop after spine | No; saves cost with uncertain lost opportunity |

### ACCEPTABLE TRADEOFFS

| Reproduction | Observed / desired behavior | Responsible stage | Block controlled live validation? |
| --- | --- | --- | --- |
| small-exact / representative-* | Full affordable coverage; retain this guarantee | Conservative exact selector | No |
| budget-* / cache-logical-* | Stop at independent hard provider/logical limits; preserve uncertainty | Admission and logical safety gates | No |
| cache-100 / cache-path-100 | Free complete negative scope, or early full-path stop | Shared caches and paid-gain rule | No |
| heterogeneous-* | Cheap third train found despite earlier large scopes | Fairness reservation | No |
| gap-no-bridge / class-explicit* | Partial stays partial without valid continuous permitted evidence | Normalizer and bounded solver | No |
| deadline-* / failure-* | Truthful incomplete results and retained evidence | Deadline checks and failure classification | No |
| very-large-* | Bounded frontier/state retention and measured operation counts | Lazy traversal and bounded DAG solver | No; no production throughput claim |

Offline evidence supports a small, separately authorized single-instance live diagnostic run from a budget/inventory-truth perspective. It does not authorize one, establish provider/Redis integration readiness, certify Node 24 behavior, or justify broad rollout. Existing process quotas, deadlines, lack of distributed dedupe and cache freshness constraints still apply.

**Recommended next step:** review this report, then separately scope Phase 5 offline quality tuning: bounded revisits of promising deferred trains first, followed by station/class/train-order fairness experiments using these fixed baselines. Agree on acceptable additional provider cost before changing sufficient-result behavior. Do not start tuning or live validation as part of Phase 4.
