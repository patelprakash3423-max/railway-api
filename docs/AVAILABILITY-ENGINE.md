# Availability engine: durable architecture and audit

Audit date: 2026-09-23. Scope: the current working tree, including the existing uncommitted direct-matrix implementation. The original audit added only this document. The Phase 1 implementation update below records subsequent code changes.

## Read this before changing availability discovery

This is both a record of **current behavior** and the **required target design**. Sections labelled target/proposed are not claims that the feature already exists. **Phase 1 is now implemented:** per-search provider admission/accounting and the configurable maximum of 300. Redis, persistent observations, adaptive freshness and dynamic EXACT_MATRIX/ADAPTIVE_GRAPH selection remain **not implemented**. The audited descriptions below are the baseline where the Phase 1 update explicitly supersedes them.

The target production policy is **at most 300 actual uncached availability provider requests per user search**, shared across all trains and search stages. The executable now independently enforces that provider ceiling. The earlier 32,768-search / 8,192-candidate limits remain as defensive logical-check ceilings, not provider-call allowances; adaptive scheduling has not replaced them.

Future sessions must read this document, inspect the current working tree and tests, and preserve working behavior before proposing implementation. Do not remove the old allocator, normalizers, provider scheduler or path solver merely because an architectural replacement is planned. Make one reviewable migration phase at a time. Keep public inventory truth unchanged. No live provider verification, commits, pushes or deployment unless separately authorized.

Existing docs were read first: [README](../README.md), [direct matrix policy](direct-matrix-search.md), [cleanup manifest](cleanup-manifest.md), and [presentation notes](../src/journey/presentation/README.md). The direct-matrix policy describes the current intermediate implementation, not the new target. Some older README paragraphs still say 12/30/40 for V2, and the presentation README still describes status-first ranking. Those statements conflict with the audited code; do not copy them into a replacement design. They were not edited during this documentation-only audit.

## Implemented Phase 1: global provider admission

The scope is provider-cost accounting only. Route ordering, matrix/progressive selection, class selection, path solving, ranking, cache TTLs and public inventory truth are unchanged. A cold matrix can stop earlier under the new cap; Phase 1 does not promise route-wide fairness or adaptive search quality.

- **Configuration:** JOURNEY_AVAILABILITY_PROVIDER_CALL_LIMIT defaults to 300 and accepts only safe integers 1..300 through hardeningConfig. Missing/blank uses the safe default; malformed, fractional, zero, negative, infinite or greater-than-300 values fail validation. Internal overrides use the same bounds. Protected V2 passes its configured limit; the standalone V2 service and journey CLI also create one bounded search budget.
- **Lifetime:** JourneyRecoveryOrchestrator creates one AvailabilityProviderBudget and passes it to the single AvailabilitySession shared by whole-leg, same-train/mixed-class/gap recovery and indirect work. Phase/candidate allowances never reset it. AsyncLocalStorage propagates this object through provider calls; scheduler waiter snapshots restore the actual executing owner's budget. Independent searches have independent objects.
- **Exact boundary:** scheduledAvailability calls invokeAvailabilityProvider inside the scheduler's executing-owner callback, after input/configuration validation, shared inventory/unsupported cache lookup, inflight deduplication and cancellation checks, immediately before getAvailability in the RailKit SDK. The initial admitted SDK availability request counts even if its invocation throws. No debit occurs at the API wrapper for RailKit.
- **Additional attempts:** the scoped fetch hook in availability-abort.ts associates the first fetch with that already-admitted SDK request. Each subsequent fetch by that invocation, including an SDK retry, needs a new search/process-quota admission. No SDK/fetch is invoked after its admission is refused. actualSdkInvocations remains distinct: it does not include additional fetch attempts. The counter describes admitted outbound availability attempts, not provider receipt, billing, or a proof of wire traffic when an SDK throws before fetch.
- **Atomic admission:** acquire synchronously reserves one unit before calling the existing process-quota admission, with no await. If quota admission fails, the search reservation rolls back; if the search limit denies first, process quota is untouched. Once invocation begins, success/failure never refunds the attempt. Concurrent workers therefore cannot exceed the search limit, including when exactly one slot remains.
- **Cache/dedupe:** search-local completed/pending reuse, fresh shared inventory and unsupported evidence hits, and shared inflight followers spend zero additional provider allowance. The active executing owner is charged once; queued cancellation transfers ownership before dispatch, never after a request has started. Shared lookup/join precedes admission even at zero remaining provider allowance. The existing 15-second inventory cache, unsupported TTL, queue concurrency, quotas, abort behavior and no-late-publication rules remain.
- **Controlled exhaustion:** ProviderCallBudgetExhausted has the structural category PROVIDER_BUDGET_EXHAUSTED, propagated through the existing failure/normalization path. It is unknown/error evidence, never WAITLIST/NOT_AVAILABLE or reusable shared inventory. Once a fresh miss is denied, the session stops new exploration via its effective allowance, avoiding thousands of repeated denials. Already collected local evidence still works and the path solver retains partial reserved segments; uncovered distance remains unknown. The configured logical remaining count is reported separately from this stop condition. A result can still be FULL when a continuous valid path was already obtained.
- **Injected providers:** adapters without scheduler instrumentation are conservatively charged immediately before getAvailability; the protected wrapper combines that admission with its existing lease quota. An adapter with its own cache/dedupe must explicitly implement the scoped owner admission contract (providerCallAccounting: SCOPED); declaring instrumentation without performing admission is unsupported. RailKit uses its existing SDK_INVOCATION marker. API/CLI wrappers preserve these markers to avoid early or double charging.

Per-search API diagnostics and completion logs now include:

| Field | Implemented meaning |
| --- | --- |
| logicalAvailabilityChecks | Calls to AvailabilitySession.get, including local/shared reuse and denied logical lookups; offline planning and passive cache rehydration are excluded |
| providerAvailabilityCalls | Admitted outbound availability SDK/adapter requests plus additional scoped fetch attempts; excludes discovery/train-info |
| providerCallBudgetLimit | Validated search ceiling, at most 300 |
| providerCallBudgetRemaining | Limit minus admitted attempts |
| providerCallBudgetExhausted | True when no provider allowance remains, even if a full result was found on the last attempt |

Existing attemptedAvailabilityChecks/availabilityRequestsUsed, budgetLimit/Used/Remaining and class/whole-leg/recovery counters retain logical-check semantics. logicalAvailabilityChecks is not an alias for session misses. Existing cache/source/SDK diagnostics remain available; Redis/persistent metrics are not claimed.

Known scope/risk: production V2 and the journey CLI are covered. Raw playground calls outside a search context retain process quota only; they are not V2 searches. Custom adapters must honor the instrumentation contract. SDK changes that replace fetch or introduce transport-internal redirect/retry behavior need renewed transport tests; this layer does not claim provider-side billing telemetry. Default burst quota (120 per ten minutes) and deadlines may stop a search below 300. No Phase 2 scheduling changes are included.

Focused offline regressions in src/tests/availability-provider-budget.test.ts cover small/default hard caps, final-slot concurrency, cache/unsupported reuse, shared followers, ownership transfer, independent searches, quota rollback, thrown attempts, extra fetch attempts, cross-phase scope and partial evidence. Large logical-matrix regressions use explicitly cache-only fixture observations so they preserve exploration/path assertions without implying thousands of allowed external requests. Cold requests are covered by the mocked RailKit transport tests.

## Product goal and non-negotiable truth

For FROM + TO + DATE + explicit CLASS/classes or ALL, discover the best evidence-backed journeys:

1. Direct AVAILABLE/RAC tickets.
2. The same physical train with an alternate boarding station or alternate destination.
3. The same train split at intermediate stations, including class changes.
4. Different-train combinations only after useful direct/same-train opportunities have been sufficiently explored.

Discover inventory ordinary point-to-point checks miss. Never fabricate availability or infer booking eligibility.

- Evidence identity includes train, from, to, journey/boarding date, class and quota. Provider and schema/adapter version must namespace shared persistent evidence where necessary.
- Only actual, validated provider observations can establish AVAILABLE, RAC, WAITLIST or NOT_AVAILABLE. Reusing fresh validated evidence is allowed; generating a status from a heuristic is not.
- Availability is not monotonic. A failure on A-B says nothing about A-X, X-B, X-Y, a neighboring interval, another date or another class. Never use WAITLIST/NOT_AVAILABLE to prune those checks as if their inventory were known.
- WAITLIST and NOT_AVAILABLE are observed non-reserved evidence. Unknown, errors, unsupported class/booking, rate limiting and timeout are separate states, never manufactured WAITLIST.
- Repository terminology: the adapter exposes NOT_AVAILABLE; normalizeInventory maps it to internal UNAVAILABLE. Both mean explicit negative inventory, not provider failure.
- Only AVAILABLE/RAC edges with valid identity/date/bookability are reserved. AVAILABLE/RAC with canBook=false must remain unusable. Missing canBook or optional identity fields must not be reported as explicitly verified; preserve current D1 handling.
- FULL requires a continuous, chronologically valid AVAILABLE/RAC path from the requested origin to destination. Distance ratio alone is not a substitute for endpoint/path continuity. Never combine evidence from different physical train runs as a same-train path.
- Retain AVAILABLE/RAC portions around an unresolved gap. Unchecked/failed inventory stays unknown; SELF_MANAGED means no reservation or transport is confirmed for that range. No assumption about unreserved travel or boarding rights is permitted.
- Alternative boarding/destination inside the requested slice covers only the observed portion. Booking beyond the requested slice or changing the actual boarding point requires separate provider/product validation; a longer interval must not silently prove inventory on a contained interval.
- Explicit class selections are a hard restriction. ALL may use the canonical classes SL, 3A, 2A, 1A, 3E, 2S, CC and EC, narrowed only by reliable supported-class metadata. The recovery probe rounds currently order these as SL/3A, 2A/CC/2S, then 1A/EC/3E.
- An exact-route UNSUPPORTED_CLASS response does not establish train-wide class metadata. Unknown support remains eligible. The current timetable schema contains no class-support table.
- Preserve Phase A error classification, Phase B accounting, Phase C mixed-class/revisit behavior, D1 provenance/identity validation and the D2 gap-subinterval fix, unless a tested replacement is demonstrably stronger.
- No train, station, name or route-specific scheduling logic. Named real trains/stations in older regression fixtures are examples only.

## Audited runtime architecture

```mermaid
flowchart TD
  HTTP[POST /api/journeys/v2/search] --> Protect[ProtectedJourneyService: admission and deadline]
  Protect --> API[JourneyV2ApiService]
  API --> Planner[PlannerV2JourneyRecoveryService / local timetable]
  Planner --> Orch[JourneyRecoveryOrchestrator]
  Orch --> Direct[Direct whole-leg checks and same-train matrix]
  Direct --> Paths[intervalPaths / evidence-backed recovery]
  Paths --> Indirect[Remaining indirect validation and recovery]
  Indirect --> Present[serializeJourneyV2 / presentJourneys]
  Orch --> Session[AvailabilitySession: local evidence and check budget]
  Session --> Provider[RailKitProvider / scheduledAvailability]
  Provider --> Scheduler[AvailabilityScheduler: cache, dedupe, execution slots]
  Scheduler --> SDK[Quota and SDK invocation / scoped fetch]
```

These are call relationships, not a guarantee that indirect work or every matrix edge executes. Existing targets, deadlines, quotas and check limits can end work.

### Entry points and discovery

- [main.ts](../src/api/main.ts) opens the production SQLite timetable read-only, installs scoped abort transport, creates one RailKit provider and the protected V2 service. The legacy V1 endpoint is wired to ENDPOINT_RETIRED, although its engines remain covered by tests.
- [router.ts](../src/api/router.ts) delegates V2 POSTs; [protected-journey-service.ts](../src/api/services/protected-journey-service.ts) validates dates/stations/configuration, enforces search admission and cancellation/deadline, and wraps availability calls.
- [journey-v2-service.ts](../src/api/services/journey-v2-service.ts) validates the public GN-only request, runs local planning/recovery, logs optional evidence, serializes and presents results. Public dates remain DD-MM-YYYY; internal railway timestamps use +05:30.
- [planner/v2/planner.ts](../src/local-railway/planner/v2/planner.ts), [network.ts](../src/local-railway/planner/v2/network.ts) and [ranking.ts](../src/local-railway/planner/v2/ranking.ts) discover direct schedules and bounded indirect schedules offline. Network data is cached in a WeakMap keyed by database and dataset metadata.
- Product V2/CLI pass preserveDirectCandidates=true. Direct candidates survive schedule-only dominance, detour filtering and the indirect result cap; the standard planner still retains its separately tested default behavior.
- Planner defaults include beamWidth=160, maxExpandedStates=4000, maxCompleteCandidates=400, maxResults=30, outgoingTrainCap=80 and maxBaselineStates=1200. These are schedule-computation controls, not provider-call budgets or evidence guarantees.
- V2 makes no provider discovery or train-info requests. Its narrow AvailabilityProvider exposes getAvailability and optional guards/accounting metadata. Production does not currently supply supportedClassesByTrain; fake CLI fixtures and internal callers can supply authoritative exclusions.

### Direct recovery, graph and indirect work

- [journey/orchestrator.ts](../src/journey/availability/journey/orchestrator.ts) defaults to MATRIX in all public modes. It validates one direct candidate's whole leg, skips interval recovery for a whole-leg AVAILABLE result, otherwise searches that candidate's matrix before moving to the next direct candidate. Whole-leg RAC can still enter matrix refinement.
- [recovery/recover.ts](../src/journey/availability/recovery/recover.ts) validates a unique contiguous local route slice, chronology, service calendar and endpoint distances. It retains all eligible intermediate stations for matrix/progressive direct searches; missing distances are excluded with diagnostics, not guessed.
- Matrix traversal is lazy: full interval, then A-X and X-B for each intermediate in route order, then all internal forward pairs in increasing span. Each interval/class is admitted separately. Negative inventory does not stop the traversal; all eligible classes are checked even after a usable interval class. The matrix does not currently stop after finding a full split path.
- There is no pre-search matrix-cost calculation or cost-based mode selection. Endpoint-first probing improves reach relative to top-station caps but still deepens every class at early stations before later stations and processes early trains before later trains.
- The retained PROGRESSIVE policy uses scored station batches, class rounds, deferred revisits and focusGaps. Gap subintervals are admitted one class at a time, preserving independently useful portions. This implementation is reusable design material, not an adequate automatic adaptive selector today.
- [recovery/paths.ts](../src/journey/availability/recovery/paths.ts) is a forward DAG dynamic program. Only usable edges become ReservedSegment objects; gap edges contribute no reserved distance. Compatible display segments can coalesce, but reservationParts preserve separate interval evidence and fares. Mixed-class paths are supported.
- [recovery/types.ts](../src/journey/availability/recovery/types.ts) defaults maxStatesPerNode=64, maxResults=5 and minimumReservedCoverageRatio=0.5. Complete evidence collection does not mean an unpruned mathematical search for every path: path states/results can be truncated. Keep inventory-exploration completion distinct from solver optimality and output truncation.
- The journey orchestrator consumes best partial evidence even below the standalone 50% threshold. Matrix budget/missing-distance/provider failures retain reserved segments and mark the uncovered remainder unknown. The established status may remain INVENTORY_CHECK_INCOMPLETE even when useful evidence is shown.
- Indirect candidates use [availability/orchestrator.ts](../src/journey/availability/orchestrator.ts)'s bounded allocator and the retained recovery logic after the direct lane. Their graph/availability costs share the session. There are still heuristic candidate, interval and target caps; this is not exhaustive multi-train search.
- [application/journey-recovery-engine.ts](../src/application/journey-recovery-engine.ts), [domain/recovery/edges.ts](../src/domain/recovery/edges.ts), [connection/provider-session.ts](../src/journey/connection/provider-session.ts) and [application/search-budget-orchestrator.ts](../src/application/search-budget-orchestrator.ts) are retained legacy/tested paths. They have alternate-board/drop models and separate request-local caches/12-30-40 budgets. Do not confuse their counters or circuit-breaker heuristics with V2's evidence rules or reuse them without audit.

### Ranking and initial five

Current engine and [presentation/index.ts](../src/journey/presentation/index.ts) primarily compare reservedCoverageRatio, then AVAILABLE-versus-RAC quality, train changes, class changes, connection penalty, duration, distance and complete fare. Presentation retains status/engine rank as late tie-breaks. Quality weights AVAILABLE at 1 and RAC at 0.8; it never creates additional coverage. Connection penalties are GOOD=0, TIGHT=1, LONG=2. The engine and presentation are not identical in every final tie-break.

Target priority: actual AVAILABLE/RAC coverage; complete coverage over partial; fewer train changes; fewer class changes; connection safety; total duration; extra distance; fare. A fully evidenced route must not lose to a partial route merely through a comfort score or a favorable status label. Audit the current RAC preference before any reprioritization; preserve RAC as reserved evidence, not a guaranteed confirmed berth. Within a common requested origin/destination, the current total-distance comparison approximates extra-distance preference; explicit detour definitions should be documented when expanded.

Presentation groups equivalent route signatures (origin/destination/date/ordered trains/interchanges), chooses the best variant, and marks at most five evidence-backed primary routes initiallyVisible. Incomplete/subthreshold results with reserved evidence are eligible; no status is upgraded. Other routes and class variants remain in results. There is no separate Generate/Show More inventory endpoint in the current router; expansion can display already-returned alternatives. Public classChanges counts within same-train legs; journeyClassTransitions additionally exists internally across legs. Do not silently alter that distinction.

## Provider validation and evidence boundaries

The [RailwayProvider](../src/providers/railway-provider.ts) abstraction covers discovery, train info and availability; V2 narrows it. [RailKitProvider](../src/providers/railkit/railkit-provider.ts) validates inputs and delegates through [railkit-client.ts](../src/providers/railkit/railkit-client.ts). The lockfile/installed SDK version audited is RailKit 5.0.3; its JavaScript is obfuscated. No assumption that one SDK call permanently equals one external request is safe across SDK changes.

- [railkit-normalizers.ts](../src/providers/railkit/railkit-normalizers.ts) validates envelopes/statuses/dates and rejects conflicting provider-supplied train/from/to/class/quota or request-level date. Optional identity absence is recorded, not invented.
- [availability/inventory.ts](../src/journey/availability/inventory.ts) requires matching request identity, exactly one matching date row and a recognized inventory status. canBook=false blocks AVAILABLE/RAC. Invalid fares do not become known complete fares.
- [provider-failure.ts](../src/domain/types/provider-failure.ts) gives structural HTTP failures precedence. HTTP 429/5xx with a success-shaped body cannot become inventory. Exact recognized unsupported-class evidence has narrow scope; arbitrary 400s/messages are not train support metadata.
- [availability-evidence.ts](../src/providers/availability-evidence.ts) preserves source, identity presence/validation, exact-date counts, bookability and allowlisted availability text. Debug evidence logs are opt-in and failure-safe. No API keys, arbitrary provider bodies/URLs or headers belong in diagnostics/persistent payloads.
- [availability-observation.ts](../src/providers/availability-observation.ts) uses AsyncLocalStorage for per-search SDK metrics/quota callbacks. [availability-abort.ts](../src/providers/railkit/availability-abort.ts) scopes transport cancellation and structural failures without rewriting provider request semantics.

## Actual cache and deduplication findings

### Canonical identity

[utils/availability-key.ts](../src/utils/availability-key.ts) returns JSON.stringify([trainNumber, from, to, journeyDate, class, quota]). Train number is trimmed and preserves leading zeroes; station/class/quota codes are trimmed and uppercased. Valid ISO or day-first input dates canonicalize to DD-MM-YYYY. Invalid dates are not repaired into valid dates. Identity normalization does not relax input validation.

The key is shared by the V2 session and RailKit scheduler. It currently has no provider/version prefix, appropriate only to its single-provider process-local context. Add namespace/schema version before Redis or persistence; do not silently mix formats. Interval journeyDate is the actual departure/boarding date at that interval's origin, including midnight offsets, not always the user's first boarding date.

| Layer | Stored data / lifetime | Hit behavior | Missing target capability |
| --- | --- | --- | --- |
| AvailabilitySession.cache/pending | Map of normalized InventoryCheck results, including failures, and pending promises; one search, no TTL | Completed and pending exact reuse costs no new session check; cacheHits combines those cases | No observedAt/freshUntil; a long session can retain evidence beyond the shared-cache TTL |
| AvailabilityScheduler INVENTORY | Cloned validated raw envelopes, expires timestamp; default 15 seconds / 500 entries | Fresh exact hit avoids SDK/quota; expired entries are not served | No adaptive TTL, persistent fallback or observation timestamp exposed with evidence |
| AvailabilityScheduler UNSUPPORTED_CLASS | Separate cloned exact-request evidence bucket; default 15 minutes / 1000 entries | Avoids SDK/quota, never becomes inventory or train-wide support | Must remain separate from inventory/latest status records |
| Scheduler pending/queue | Process-local entries and waiter sets per canonical key | Identical concurrent work shares one invocation; active waiter owns accounting | No distributed coordination |
| Planner network cache | WeakMap of local timetable network per database/metadata version | Offline reuse, no availability claim | Not an availability cache |
| Legacy ConnectionProviderSession | Per-request discovery/route/seat Maps, including failures; no TTL | Its own budget skips local hits | Separate non-production-V2 gateway; not Redis/persistence |

The scheduler only stores INVENTORY when normalization succeeds, exactly one requested-date row exists, and status is AVAILABLE/RAC/WAITLIST/NOT_AVAILABLE; AVAILABLE/RAC with canBook=false is excluded. Generic errors, empty/malformed/ambiguous rows, booking-unsupported and local configuration failures are not reusable shared inventory. UNSUPPORTED_CLASS has its own retention policy; HTTP auth/rate/server errors are not cached as unsupported evidence.

Both shared buckets delete expired records on access/insertion, evict oldest insertions at capacity (FIFO, not LRU), clone on storage/reuse, and do not extend TTL or insertion order on hits. Writing one bucket removes that key from the other. The unsupported TTL is configurable up to 24 hours and capacity up to 10,000; positive safe-integer validation is enforced.

The scheduler singleton is shared across default provider instances in one process. Owners rotate between starts at concurrency 2 by default. One waiter cancelling does not cancel peers. A cancelled queued leader can be replaced by an active follower's context before execution. No remaining waiters aborts shared work; timed-out/abandoned work cannot publish late evidence. An SDK that ignores abort retains its physical slot until settlement. Preserve these guarantees.

### Database/Redis inventory

Repository/package/config/schema searches found **no Redis client, Redis configuration, distributed lock, ORM, Postgres/MySQL/Mongo driver, persistent availability table, refresh worker or observation-history store**. This is a repository finding, not a claim about services an operator may run outside the repository.

Existing database technology is Node 24's built-in node:sqlite DatabaseSync via [local-railway/database.ts](../src/local-railway/database.ts). [schema.ts](../src/local-railway/schema.ts) defines stations, trains, train_stops and dataset_metadata, schema version 2 (read compatibility with version 1). It holds schedule/geography/calendar/distances, not live seats or supported classes. Import tooling writes datasets; production opens an immutable, checksummed read-only snapshot at LOCAL_RAILWAY_DB_PATH, default data/local-railway/railway.sqlite. [provision-railway-db.mjs](../scripts/provision-railway-db.mjs) verifies/downloads the deployment artifact outside the search path.

Runtime dependencies in package.json are dotenv and railkit. There is no provisioned writable availability database. A future observation store must use a separately provisioned writable database and lifecycle; never write availability into the immutable timetable snapshot.

## Current budgets: exactly what is counted

| Event | Existing session check budget | Existing real RailKit SDK counter / process provider quota |
| --- | --- | --- |
| Offline planning | 0 | 0 |
| Same-session completed or pending reuse | 0 | 0 additional |
| New session key, shared inventory cache hit | 1 | 0 |
| New session key, shared unsupported cache hit | 1 | 0 |
| New session key joining shared inflight | 1 in follower | 0 in follower; leader owns invocation |
| Valid fresh provider execution | 1 | 1 SDK invocation / quota charge, even if provider subsequently fails |
| Invalid adapter request after session admission | Can spend 1 | 0 SDK / quota |
| Local configuration failure | Latched/rethrown before session charge when preflight is available | 0 |
| Rejected queue/admission/cancelled-before-execution work | May already have a logical check | 0 SDK / quota |

AvailabilitySession.get consults its local cache/pending map, then calls budget.consumeCall **before** invoking the adapter. The adapter then reaches scheduler cache/pending lookup. Thus availabilityCalls, availabilityRequestsUsed, attemptedAvailabilityChecks and budgetUsed currently represent distinct search-local misses/checks, not actual external calls. Shared cache/dedupe hits still spend this budget. cacheHits also omits direct peek/rehydration done by allocation.

In scheduledAvailability, the callback executed only after scheduler cache/dedupe/queue admission runs configureRailKit, installs scoped transport, calls scheduler.quota.consume(), calls availabilitySdkInvoked(), then the SDK. actualSdkInvocations is observational at that boundary, not proof of wire traffic/billing. The production ProtectedJourneyService's supplied SDK charge callback deliberately does not call lease.consume for SDK_INVOCATION-accounted providers; the scheduler owns their quota. Injected non-instrumented providers instead use lease.consume immediately before adapter invocation. Do not add a second quota debit to this path.

Process provider quota defaults are **120 invocations per rolling 10 minutes and 10,000 per UTC month**, shared across searches within one process. Search admission defaults are three concurrent searches globally; declared direct-peer clients also have configured per-client restrictions. Counters reset on process restart and are not account-authoritative or multi-instance safe. A 90-second search deadline and 15-second execution timeout remain independent. Quota denial becomes unknown/provider-error evidence; deadline currently returns structured HTTP 504 rather than a partial-success result.

### 32,768 / 8,192 dependency map (current, to migrate later)

| Location | Dependency |
| --- | --- |
| [journey/search-policy.ts](../src/journey/availability/journey/search-policy.ts) | Source constants maxAvailabilityChecks=32768, maxChecksPerDirectCandidate=8192, initialVisibleJourneys=5 |
| [journey/orchestrator.ts](../src/journey/availability/journey/orchestrator.ts) | MATRIX default; session limit clamped to 32768; per-direct allowance 8192; optional smaller budgetLimit/recovery cap; DIRECT_MATRIX diagnostics; direct work independent of display target |
| [protected-journey-service.ts](../src/api/services/protected-journey-service.ts) | Imports the policy for admission/logging and injected-provider lease allowance; real provider quota still belongs to scheduler |
| [journey/cli-runner.ts](../src/journey/availability/journey/cli-runner.ts) | Uses default matrix policy, including offline fake mode; no separate STANDARD=30 override |
| [journey-v2-service.ts](../src/api/services/journey-v2-service.ts), [journey-v2-model.ts](../src/api/services/journey-v2-model.ts) | Diagnostics/logging expose budgetLimit/used/remaining, searchPolicy and directCandidateCheckLimit |
| [recovery/recover.ts](../src/journey/availability/recovery/recover.ts), [session.ts](../src/journey/availability/session.ts), [utils/search-budget.ts](../src/journey/utils/search-budget.ts) | Consume inherited allowances; matrix strategy bypasses legacy station/interval caps; no literal 32768 required here |
| [planner/v2/planner.ts](../src/local-railway/planner/v2/planner.ts) | Product direct-candidate preservation feeds this policy, but is not itself a provider budget; retain preservation |
| [direct-matrix.test.ts](../src/local-railway/tests/direct-matrix.test.ts) | Imports both constants; asserts full matrices, per-direct/global limits and protected API diagnostics; also contains truth regressions that must remain |
| [journey-v2-api.test.ts](../src/local-railway/tests/journey-v2-api.test.ts) | Literal 32768 and zero recovery reserve in QUICK/STANDARD/DEEP |
| [journey-cli-live.test.ts](../src/local-railway/tests/journey-cli-live.test.ts) | Literal 32768 in injected offline provider test, despite historical test filename |
| [http-client-concurrency.test.ts](../src/tests/http-client-concurrency.test.ts) | Literal 32768 in response diagnostic assertions; concurrency semantics are independent |
| [README](../README.md), [direct-matrix-search.md](direct-matrix-search.md) | Document current ceilings/formula; README also contains contradictory older budget passages |

Compatibility tests explicitly selecting directSearch: PROGRESSIVE: allocation-v3.test.ts, journey-recovery-v2.test.ts, journey-reserve-v2.test.ts, phase-c-recovery.test.ts, phase-d2-gap.test.ts and phase-d2-strategy.test.ts under src/local-railway/tests. They protect earlier scheduling/invariants, not the new target ceiling. Other explicit 30-limit AvailabilitySession tests, availability-v2 tests and legacy searchModeConfig tests are not automatically dependencies on 32768. Do not mechanically replace all occurrences of 30 or 300.

## Required budget design and safest insertion point

**One SearchProviderBudget per user search, hard maximum 300 actual uncached outbound availability requests across direct, recovery, retries and indirect work.** Configurations may reduce that ceiling, never raise it. It is an emergency bound, not a consumption target. Logical work/CPU/frontier bounds remain separate and must not masquerade as provider-call limits.

Do not implement this by changing maxAvailabilityChecks to 300: that still charges fresh shared-cache and inflight reuse and reintroduces station starvation. Do not use global counter deltas to attribute a search's requests.

The safest execution boundary is **inside the scheduler-owned availability execution, after every evidence cache/persistent lookup and inflight join**, restoring the active initiating waiter's request context. For a conservative SDK-attempt ceiling, scheduledAvailability's actual invocation callback is the existing seam. For the required external-request counter, extend the already scoped transport in availability-abort.ts immediately before delegating an availability fetch to the underlying transport. Propagate a typed request-owned budget/observer through the existing scope and scheduler waiter context. A raw API service wrapper or AvailabilitySession.get is too early.

Implementation requirements for that seam:

1. Check local configuration/input, cancellation, cache/persistent freshness and dedupe before any debit.
2. Atomically admit/charge an outbound attempt against both search remaining capacity and process/provider quotas, with no await between checks and mutation. Avoid charging one quota when the other denies admission; refactor the existing scheduler quota location as needed without double charging.
3. Instrument each dispatched availability attempt. Retries count separately; a failed dispatched attempt is still spent. Local validation failure, fresh cache/persistent reuse and joins cost zero. A transport-attempt metric is not an assertion that RailKit received or billed the request. Verify SDK retry/redirect behavior with mocked transport; prevent hidden requests from bypassing the cap.
4. Cross-search deduplication charges the executing owner once, followers zero. If the queued owner leaves, select a live eligible owner before dispatch; never transfer/double-charge an already-started attempt. At exhausted budget, cache reads and joining already-running work may still supply evidence without starting a new request.
5. Prevent concurrent starts racing at remaining=1. Test 299/300/301, cancellation, synchronous exceptions, quota rejection and multiple searches with separate budgets.
6. Propagate explicit PROVIDER_BUDGET_EXHAUSTED or other stop reasons to orchestration; do not loop over thousands of new edges turning admission denials into provider errors. Preserve accumulated reserved edges and solve the partial graph. Never convert exhausted/unknown edges into negative inventory.
7. Keep SDK diagnostics distinct from providerAvailabilityCalls. Instrument non-RailKit providers at an explicit transport seam or mark fallback accounting conservatively; fake adapters do not prove external traffic.

The default burst quota of 120 may stop an otherwise 180-call exact matrix before the 300 search ceiling. Mode selection must consider current quota/deadline/concurrency as well as remaining search budget. Do not raise/remove provider protection to make a matrix fit. Distributed provider-account quotas and distributed dedupe need separate atomic coordination before multi-instance production operation.

## Target search model: adaptive evidence graph

For each direct train's eligible ordered route slice, use station nodes (with route sequence/run timing) and potential edges (from, to, class). Observed edges retain exact provider evidence; AVAILABLE/RAC are traversable, explicit negatives are non-reserved, and unchecked/error edges remain unknown. Keep observed negative edges for diagnostics without using them to infer other edges.

Before each train, calculate fullMatrixCost = C * N * (N - 1) / 2, where N includes both endpoints and C is the selected/authoritatively supported canonical class scope. Keep this full denominator even if enumeration is lazy. Estimate additional provider cost after fresh cache/persistent hits and inflight work; cache expiry or failed pending work can change that estimate. Never promise completion based solely on an earlier cache snapshot.

- EXACT_MATRIX: may enumerate every eligible edge when remaining global provider capacity, quota, deadline and the direct-train exploration plan safely admit it. N=9, C=5 gives 180 edges; it can fit under 300 if those other limits allow it. If conditions change, preserve evidence and mark incomplete/downgrade mode; do not overrun the cap.
- ADAPTIVE_GRAPH: for N=20, C=5, the 950-edge cold matrix cannot fit 300. Do not attempt exhaustive provider fetching. Use a deterministic bounded frontier with route-wide probes, path solving and gap-directed refinement.
- Full matrix cost and actual provider misses differ: a large warm graph may need few external requests. Bound local materialization/solver work independently, and report when those bounds prune work.

Recommended order: discover direct schedules offline; determine eligible classes; obtain direct A-B evidence; collect same-train probes; run intervalPaths; refine gaps; spend remaining capacity on high-value unresolved evidence; then indirect inventory. Schedule-only indirect planning may already happen offline without spending provider budget.

Adaptive fairness must be explicit rather than implicit in station scoring. Give route-wide distance/sequence regions, including the late tail, initial opportunities before repeatedly deepening early stops/classes. Endpoint probes A-X and X-B are useful but each is independently admissible evidence, not an atomic prerequisite for retaining the other. Rotate candidate/station/class opportunities; reliable metadata can eliminate genuinely unsupported classes, exact-route failures cannot. A route with more opportunities than 300 permits cannot be guaranteed exhaustive probing; report unexplored scope and never label it an inventory failure.

Use predicted value only to choose the next unknown check: potential connected coverage gain, gap bridging, class continuity, cache cost, route fairness and remaining resources. Scheduling priority never assigns a seat status. Direct recovery need not run forever: transition to indirect work only after the useful direct frontier is exhausted, sufficiently explored or explicitly stopped for low marginal value/results/resources, with a recorded reason.

After each bounded probe wave, solve the current graph. For A-X class1 AVAILABLE, X-Y WAITLIST, Y-B AVAILABLE, retain both reserved portions without FULL. Probe other classes or X-M/M-Y edges inside the unresolved gap. If X-M class2 and M-Y class3 are AVAILABLE/RAC, their actual observations can bridge it. Keep searching past a failed interval; never use a negative as an early break over later intervals. Reuse the D2 one-class gap-subinterval admission and Phase C mixed-class solver behavior.

Keep separate completion signals: full edge-observation coverage, inventory errors/unresolved scope, solver pruning, output truncation and finding a full reserved path. A full path does not mean a fully checked matrix; a fully checked negative matrix does not mean a usable journey.

## Target cache and persistent observation architecture

Target lookup: search-local evidence -> Redis hot evidence -> persistent latest observation -> provider fallback, with shared inflight coordination around miss/revalidation work. Optional immutable observation history is not a current-availability lookup. Recheck freshness at consumption; use one canonical key/validation contract across layers.

Redis and the writable database are not installed by this design document. Introduce storage interfaces and offline contract tests before selecting/provisioning a database implementation. The existing read-only SQLite snapshot must remain isolated.

### Observation representation (proposed)

Use a unique latest-record identity (provider, evidenceSchemaVersion, trainNumber, fromStation, toStation, journeyDate, travelClass, quota). An ISO date in storage is acceptable only via one deliberate canonical conversion; do not change the public date contract accidentally. Example conceptual Redis key: availability:v1:railkit:<train>:<from>:<to>:<date>:<class>:<quota>.

Latest observation fields should include:

- The entire identity and route/run boarding-date context needed to validate use.
- normalizedStatus, availabilityText/count where recognized, canBook with ABSENT distinct from false, optional validated fare/currency.
- observedAt (when the provider observation was obtained), storedAt separately, freshUntil and freshnessPolicyVersion. Provider-supplied observation time may be retained separately if validated; it must not replace observation time without an explicit contract.
- Provider/adapter/evidence schema version; safe transport category/status; D1 identity-presence/validation and exact-date matching metadata. Retain enough allowlisted response evidence to revalidate at read time; do not persist secrets or unrestricted raw envelopes.

Only validated inventory observations advance latest inventory. Store errors/unsupported evidence separately or as distinct attempt records; a failed refresh must not convert old AVAILABLE to WAITLIST or reset observedAt. Stale old inventory remains historical, not current. Conditional upsert must prevent an older/slower response overwriting a newer observation. Redis hydration uses the remaining freshness lifetime, never a new full TTL; hits must not reset observedAt.

Redis outage may fall through to a fresh persistent record or budgeted provider request. Database outage may still permit fresh Redis evidence or fresh provider results. Neither outage permits unbounded fallback traffic, bypassed quotas, invented freshness or silently stale reserved edges.

Immutable history is optional: useful for cache tuning, demand-based refresh priority, operations and change analysis. Costs include volume, retention, indexing and duplicate events. Start with latest observations and opt-in bounded history only when a concrete use warrants it. History never substitutes for fresh truth and must never generate predictive seat claims.

### Freshness proposal, not immutable product truth

Make freshness a validated configuration policy evaluated against interval departure time in the railway time zone. The following non-overlapping starting bands resolve the user's approximate ranges; they require operational tuning and are not current TTLs:

| Time until departure | Proposed maximum age |
| --- | --- |
| At least 30 days | 12 hours |
| At least 15, less than 30 days | 6 hours |
| At least 7, less than 15 days | 3 hours |
| At least 48 hours, less than 7 days | 1 hour |
| Under 48 hours, before departure | 15-30 minutes, configurable |

Use shorter configured ages near departure, low AVAILABLE counts, RAC/WL boundaries or recently changing inventory. Do not lengthen the current 15-second hot TTL to hours without timestamps, validation, explicit product freshness semantics and tests. Past-departure/invalid-date evidence is not a current booking claim. Fresh cached evidence may satisfy a request, but must never be labelled newly fetched.

Stale-while-revalidate requires explicit public provenance/age semantics before displaying stale observations. Until such a response contract exists, stale evidence cannot populate current RESERVED edges or FULL labels. It may inform which query to refresh, without inferring its result. A stale FULL historical path must not appear currently verified because a background job was queued.

Background refresh is optional, demand-aware and bounded: prioritize frequent/recent searches, upcoming trips and boundary-sensitive observations; cold records refresh on demand. Never periodically scan and refresh every train/station/class/date combination. Background work needs separate bounded job/owner budgets plus the same shared provider quota, concurrency and dedupe, and cannot be used to evade a user's 300-call limit.

### Multi-instance coordination

Current dedupe is process-local. Redis hot caching alone does not deduplicate simultaneous misses on separate instances. A later distributed design needs per-key expiring ownership, safe takeover/fencing, result publication or bounded polling, and rechecking storage after ownership acquisition. Locks must not be held indefinitely across a dead worker or outlive transport cancellation. Do not claim exactly one cross-process request without failure-mode tests. Coordinate account-wide quotas separately; process restart must not reset distributed usage.

## Target observability

The Phase 1 fields and their implemented semantics are listed above. Remaining names below are target additions/semantics, not a rename of existing aliases without migration:

| Field | Required meaning / current gap |
| --- | --- |
| searchMode | Per-train EXACT_MATRIX or ADAPTIVE_GRAPH; keep requested QUICK/STANDARD/DEEP separately; mixed searches need per-train detail |
| logicalAvailabilityChecks | Explicitly defined logical edge requests, independent of provider debit; existing attemptedAvailabilityChecks counts only session misses, so do not silently alias it |
| providerAvailabilityCalls | Outbound availability attempts charged once to the executing search owner after caches/dedupe; actualSdkInvocations stays separate |
| cacheHits | Define fresh local/hot hits with layer breakdown; current cacheHits combines local completed/pending reuse |
| persistentCacheHits | Fresh latest-store reuse; currently absent |
| inflightDedupeHits | Local/shared and eventually distributed joins, zero additional provider charge; define mutually exclusive per-check source |
| providerErrors | Validated failure categories; keep actual attempts versus logical/error replays distinct |
| budgetLimit / budgetRemaining | Target provider allowance at most 300; publish versioned/distinct check-budget fields during migration |
| possibleMatrixEdges | Class-labelled potential edges C*N*(N-1)/2; current candidateIntervalsGenerated counts interval pairs only |
| checkedMatrixEdges / matrixCoverage | Distinct class-labelled edges with valid fresh positive/negative observations divided by eligible denominator; unsupported/error attempts separate; no success inferred from merely trying a call |
| directTrainsConsidered / stationsExplored / classesExplored | Per-train distinct counts and unexplored scope; current progressive statistics cover only part of this |
| fullPathsFound / partialPathsFound | Paths backed by valid edges, with solver/output truncation reported |
| stopReason / durationMs | Explicit cause and elapsed time; currently fragmented truncation/directExploration states plus log timing |

Stop reasons must include EXACT_MATRIX_COMPLETE, SUFFICIENT_HIGH_QUALITY_RESULTS, MARGINAL_VALUE_LOW, PROVIDER_BUDGET_EXHAUSTED, DEADLINE, PROVIDER_RATE_LIMIT and PROVIDER_UNAVAILABLE, plus a documented local-work/solver limit when applicable. Never mark EXACT_MATRIX_COMPLETE on merely exhausted budget, missing distances, provider errors or unattempted classes.

Do not turn historical check counters into provider-call counters under the same undocumented names. Version/add fields or document the compatibility transition. Keep identity/provenance detail internal/opt-in unless a deliberately designed public freshness contract needs safe fields. Logs must exclude credentials, raw provider URLs/bodies and identity secrets.

## Gap analysis

| Classification | Finding |
| --- | --- |
| Already implemented | Phase 1 global <=300 provider admission, separate logical/provider diagnostics, controlled exhaustion; offline direct discovery, preservation of direct services, exact identity/date/bookability validation, non-reserved negative/error handling, interval DAG, mixed classes, partial evidence, direct-before-indirect order, best-five presentation, process cache/dedupe/concurrency/quota/abort protections |
| Partially implemented | Complete route eligibility but not fairness under a small actual-call budget; exhaustive matrix capability but no cost selector; useful progressive gap refinement outside the default matrix policy; optional class metadata filtering without a production metadata source; detailed provenance but no observation freshness contract; indirect planning/validation with heuristic caps |
| Missing after Phase 1 | Dynamic EXACT_MATRIX/ADAPTIVE_GRAPH; bounded high-value frontier across all direct trains; Redis; persistent latest/history; configurable departure-aware freshness; safe stale presentation/SWR; distributed dedupe/quotas; matrix coverage and unified stop reasons |
| Risk/conflict | 32768/8192 check policy is not the target; sequential early-train/early-station deepening can starve later opportunities; shared hits spend checks; SDK invocations are not external traffic; burst 120 and deadline 90s constrain matrices; session cache can outlive hot TTL; cold matrix cache churn exceeds 500 entries; default matrix lacks early sufficient-quality stopping; docs mix old and current semantics |

Additional audit cautions: the 64-state path cap can prune alternatives even with complete edge evidence; public responses currently lack observation timestamps; matrix recovery's request counter can include newly checked whole-leg classes after an initial RAC short-circuit, so its historical recoveryCalls name is not a strict count of non-whole intervals. Preserve meaning/document it rather than drawing incorrect provider or edge-coverage conclusions. Legacy train/date circuit-breaker behavior is not authority to infer V2 class support.

## Smallest safe implementation sequence

1. **Phase 1: actual-call budget and accounting boundary (implemented; see update above).** The original phase contract: add the request-owned <=300 provider budget, scoped transport admission/attribution, explicit exhaustion signaling, separate counters and mocked-transport tests. Preserve normalizers, graph edges, solver, local/shared caches and presentation. Stop fresh work cleanly and retain accumulated evidence; allow zero-cost fresh evidence reuse. Retire the 32768/8192 production-call policy instead of just changing its number. Keep separately named finite computation bounds. No Redis or engine rewrite is needed for this phase; do not claim adaptive search quality yet.
2. **Phase 2: cost selector and adaptive scheduler.** Compute full cost and additional miss cost per train; select EXACT_MATRIX when safe and ADAPTIVE_GRAPH otherwise. Reuse the existing route extraction/evaluate/intervalPaths seams, add route/class/candidate breadth before deepening, targeted gap refinement and explicit stop reasons. Replace hardcoded old call-count assertions with bounded real-transport and quality invariants; retain legacy truth regressions. Verify a cold 950-edge scope does not enumerate/fetch it exhaustively.
3. **Phase 3: observation envelope and freshness contracts.** Add timestamps/versioned validation and configurable freshness through interfaces/in-memory fakes first. Validate session reuse against freshness too. Define public age/source behavior before enabling stale display; maintain current-status semantics and exact unsupported bucket isolation.
4. **Phase 4: persistent latest store and Redis hot cache.** Choose/provision a separate writable store, migrations, retention and failure behavior. Add canonical namespacing, conditional latest upserts, remaining-TTL hydration and miss dedupe. Do not mutate the timetable DB. Add optional history only with a defined use and retention budget.
5. **Phase 5: distributed operation and demand-aware refresh.** Add cross-instance miss coordination/account quotas, refresh ownership and bounded background work; exercise cancellation/restart/lock-expiry failure cases. No blanket refresh sweeps or historical seat predictions.
6. **Phase 6: operational tuning and contract cleanup.** Measure cache freshness/search quality/call use, tune explicit policies, harmonize ranking/diagnostics/docs, and retain the best-five plus alternatives behavior. Migrate CLI/raw/internal entrypoints intentionally so no search path bypasses the global cap.

Phase 1 acceptance: no 301st outbound availability attempt for a search, including retry/concurrency cases; cache/store hits and inflight joins debit zero; successful dispatched attempts and failed dispatched attempts debit exactly once; invalid input/configuration and pre-dispatch cancellation debit zero; no quota double-charge; existing partial/full evidence invariants pass. The change must be testable without a real provider. Phase 2 is required before treating this as the completed quality architecture.

## Regression contract and existing coverage

| Requirement | Existing coverage / next additions |
| --- | --- |
| Late A-X AVAILABLE, X-Y WAITLIST/NOT_AVAILABLE, Y-B AVAILABLE/RAC; retain both without FULL | direct-matrix.test.ts and phase-d2-gap.test.ts; run the same shape under adaptive 300 and low remaining budgets |
| ALL permits A-X class1 + X-B class2 full same train | phase-c-recovery.test.ts, recovery-v2.test.ts, journey-recovery-v2.test.ts, direct-matrix.test.ts |
| Explicit classes never expand silently | phase-c-recovery.test.ts, phase-d2-strategy.test.ts, direct-matrix.test.ts |
| Fresh cache hit costs zero provider calls | availability-accounting.test.ts, availability-scheduler.test.ts, unsupported-evidence-cache.test.ts distinguish SDK/quota from checks; add actual-transport and persistent-store budget assertions |
| Twenty concurrent identical requests produce one external request | Extend scheduler/accounting/provenance dedupe tests with exactly twenty waiters, cancellation/ownership transfer, and a mocked outbound transport counter |
| Never exceed 300 across trains/stages/retries | Implemented Phase 1 mocked SDK/transport regressions; retain tests of generic configurable logical session limits |
| Small affordable matrix reaches 100% checked coverage | Current matrix tests assert complete distinct check counts; add selector/coverage test N=9,C=5 and quota/deadline/cache conditions |
| Large matrix chooses adaptive mode | Missing target regression N=20,C=5; prove no exhaustive fallback at the ceiling |
| Late route opportunities under limited resources | Current progressive/matrix late-stop tests; add route-wide/class/candidate fairness tests with <=300 actual misses |
| WAITLIST never inferred AVAILABLE, errors never negative inventory | normalizers.test.ts, availability-scheduler.test.ts, availability-provenance.test.ts, phase-c-recovery.test.ts and matrix canBook/unsupported cases |
| Keep physical concurrency, cache identity/TTL, cancellation, queue fairness and no late cache publication | availability-scheduler.test.ts, unsupported-evidence-cache.test.ts, production-hardening.test.ts, http-client-concurrency.test.ts |
| Preserve ordering, alternative variants and truthful best five | presentation.test.ts, journey-v2-api.test.ts, direct-matrix.test.ts |

New freshness/storage tests must cover exact TTL boundaries, no TTL reset on hits/hydration, stale evidence excluded from current FULL, late older writes, expiry during a search, Redis/database failure fallback, unknown/unsupported bucket isolation, and history never used as current inventory.

## Audit file inventory and verification

Inspected source areas and principal files (paths are relative to the repository):

- Docs/manifests/config: README.md; docs/direct-matrix-search.md; docs/cleanup-manifest.md; src/journey/presentation/README.md; package.json; package-lock.json; .env.example; src/config/api.ts, hardening.ts, railkit.ts. Secret .env values were not read.
- API/boundaries: src/api/main.ts, router.ts, search-protection.ts; src/api/services/journey-v2-service.ts, journey-v2-model.ts, protected-journey-service.ts.
- Provider/evidence: src/providers/railway-provider.ts, provider-quota.ts, availability-observation.ts, availability-evidence.ts; src/providers/railkit/railkit-provider.ts, railkit-client.ts, railkit-normalizers.ts, availability-scheduler.ts, availability-abort.ts; src/utils/availability-key.ts; src/domain/types/availability.ts, provider-failure.ts; src/domain/usage/provider-quota.ts; installed node_modules/railkit package metadata/source structure.
- V2 search: src/journey/availability/session.ts, inventory.ts, types.ts, orchestrator.ts; journey/orchestrator.ts, search-policy.ts, cli-runner.ts; recovery/recover.ts, paths.ts, types.ts, local-leg.ts; src/journey/types/journey-segment.ts; src/journey/presentation/index.ts.
- Timetable/planner: src/local-railway/database.ts, schema.ts; planner/v2/planner.ts, network.ts, ranking.ts, types.ts; scripts/provision-railway-db.mjs.
- Legacy/configured budgets: src/application/search-mode.ts, search-budget-orchestrator.ts, journey-recovery-engine.ts; src/journey/connection/provider-session.ts; src/domain/recovery/edges.ts, types.ts; src/journey/utils/search-budget.ts.
- Tests reviewed by content/targeted assertions: src/tests/availability-accounting.test.ts, availability-scheduler.test.ts, availability-provenance.test.ts, unsupported-evidence-cache.test.ts, production-hardening.test.ts, http-client-concurrency.test.ts; src/local-railway/tests/direct-matrix.test.ts, phase-c-recovery.test.ts, phase-d2-gap.test.ts, phase-d2-strategy.test.ts, journey-v2-api.test.ts, journey-cli-live.test.ts, presentation.test.ts, journey-recovery-v2.test.ts, journey-reserve-v2.test.ts, allocation-v3.test.ts; src/test-support/local-network-only.mjs.

The original documentation-only audit used existing offline tests and typecheck; its results are recorded below. Phase 1 has since been implemented as described above; Phases 2-6 remain proposals. Future sessions should record exact commands/results in their handoff and rerun the applicable evidence/accounting/recovery tests after each behavioral phase.

### Recorded audit verification

- Existing focused tests: **198 passed, 0 failed**. Command: `node --import ./src/test-support/local-network-only.mjs --import tsx --test src/tests/normalizers.test.ts src/tests/availability-accounting.test.ts src/tests/availability-scheduler.test.ts src/tests/availability-provenance.test.ts src/tests/unsupported-evidence-cache.test.ts src/tests/production-hardening.test.ts src/local-railway/tests/direct-matrix.test.ts src/local-railway/tests/phase-c-recovery.test.ts src/local-railway/tests/phase-d2-gap.test.ts src/local-railway/tests/presentation.test.ts`. External network calls were blocked; provider behavior was mocked.
- `npm run typecheck`: passed (`tsc --noEmit`).
- `git diff --check`: passed; Git emitted only the existing LF/CRLF conversion warnings. The new untracked document was also checked explicitly for trailing whitespace and all 50 local Markdown links resolved.
- A SHA-256 aggregate of every tracked/nonignored untracked file except this document matched the pre-write baseline: existing implementation, tests and prior uncommitted changes were preserved byte-for-byte.
- No live provider calls, commits, pushes or deployments. Full tests/build were not repeated for this documentation-only addition.

### Phase 1 implementation handoff

Files changed in Phase 1 (excluding unrelated pre-existing working-tree changes):

- Provider admission and evidence category: src/providers/availability-provider-budget.ts (new); src/providers/railkit/railkit-client.ts; src/providers/railkit/availability-abort.ts; src/providers/availability-observation.ts; src/domain/types/provider-failure.ts.
- Configuration: src/config/hardening.ts; .env.example.
- Shared search lifecycle: src/journey/availability/session.ts; src/journey/availability/types.ts; src/journey/availability/orchestrator.ts; src/journey/availability/journey/orchestrator.ts.
- API diagnostics and protected boundary: src/api/services/protected-journey-service.ts; src/api/services/journey-v2-service.ts; src/api/services/journey-v2-model.ts.
- CLI wrapper metadata: src/journey/availability/cli.ts; src/journey/availability/journey/cli-runner.ts.
- Regression coverage: src/tests/availability-provider-budget.test.ts (new, 20 tests); src/local-railway/tests/direct-matrix.test.ts; src/local-railway/tests/journey-cli-live.test.ts.
- Documentation: README.md; docs/direct-matrix-search.md; docs/AVAILABILITY-ENGINE.md.

Validation on the Phase 1 implementation:

- Focused offline suite: **237 passed, 0 failed**, including all 20 new provider-budget tests. Command: node --import ./src/test-support/local-network-only.mjs --import tsx --test src/tests/availability-provider-budget.test.ts src/tests/availability-accounting.test.ts src/tests/availability-scheduler.test.ts src/tests/availability-provenance.test.ts src/tests/unsupported-evidence-cache.test.ts src/local-railway/tests/direct-matrix.test.ts src/local-railway/tests/phase-c-recovery.test.ts src/local-railway/tests/phase-d2-gap.test.ts src/local-railway/tests/journey-recovery-v2.test.ts src/local-railway/tests/journey-v2-api.test.ts src/local-railway/tests/journey-cli-live.test.ts.
- npm test: **885 passed, 0 failed**, with the repository external-network guard.
- npm run typecheck: passed.
- npm run build: passed; no server was started.
- git diff --check: passed with only LF/CRLF conversion notices. Untracked/new documents and source were also scanned for trailing whitespace, and local document links resolved.
- No live provider calls, commits, pushes or deployments. Phase 2 was not started.
