# Railway API

Independent Node 24.x API using a read-only local timetable and live RailKit availability. Planner V2, Allocation V3, inventory budgets/reserves, recovery and presentation rules are unchanged.

## Development and verification

```sh
nvm use
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
npm run dev:api
```

Configure local `.env` without committing it. `npm test` denies external network access and uses fake providers. Tests retain the independently owned API presentation fixture and synthetic datasets. CLI tools are retained because automated tests exercise their offline modes; never use `--live` in automated verification. Fake providers live under `src/test-support` and production startup does not import them.

## Production

```sh
npm ci
npm run provision:db
npm run build
npm prune --omit=dev
npm start
```

`npm start` verifies the DB checksum again, then executes `node dist/api/main.js`. No tsx runtime dependency is needed. Set provisioning variables in the process environment (the provisioning script does not load `.env`). API configuration reads the repository-root `.env` for local use. Compiled startup also resolves that root correctly.

`GET /health` returns `{requestId,status:"ok"}` without provider calls. RailKit configuration is checked once at search admission before planning, search admission, or availability checks, so health still works without a key. Missing, blank, placeholder, non-ASCII, or internally whitespace-containing keys return HTTP 503 with `PROVIDER_CONFIGURATION_ERROR` and no inventory claims. Local validation cannot establish whether a syntactically valid key is authentic, active, or authorized; that requires a provider response. Search requires `RAILKIT_API_KEY`, kept only in the server secret environment. `POST /api/journeys/v2/search` accepts `{from,to,date,classes,mode?,quota?}`; date is DD-MM-YYYY, classes is an array or ALL, mode defaults STANDARD, quota is GN. Responses contain results, presentation, summary and optional diagnostics. Station autocomplete is owned by the frontend; there is no station HTTP endpoint.

## SQLite deployment artifact

The SQLite file is ignored, never generated during startup, and always opened read-only. Set `LOCAL_RAILWAY_DB_PATH` (default `data/local-railway/railway.sqlite`) and `RAILWAY_DB_SHA256` to the exact expected SHA-256. Obtain the checksum with `shasum -a 256 data/local-railway/railway.sqlite`.

For a release, upload the existing snapshot as `railway.sqlite` to a versioned GitHub Release, record its SHA-256, and configure `RAILWAY_DB_ASSET_URL` with the HTTPS download URL for that specific release. Do not use a moving `latest` URL. The current downloader supports publicly accessible release assets; private release authentication is not implemented. Do not embed credentials in URLs.

`scripts/provision-railway-db.mjs` verifies an existing local DB without network or downloads a missing DB, verifies checksum/header, then atomically installs it. A mismatch fails closed and preserves any existing file. Download timeout is 60 seconds and size is capped at 256 MiB. There is no fake production URL. No writable persistent disk is needed for this immutable snapshot. Import/CSV tooling remains available for deliberate dataset regeneration outside the request path.

## Beta protection and proxy trust

Defaults (all configurable in `.env.example`): five searches per client per ten minutes, one concurrent search per client, three globally. Admission takes a search slot without reserving provider calls. Process-local monthly (10,000) and rolling burst (120 calls/10 minutes) quotas are checked and charged synchronously at the availability SDK boundary. Production RailKit quota is charged immediately before each availability SDK invocation, after local request validation and configuration, including invocations that subsequently fail. Local configuration/input failures before this boundary do not consume provider quota. No provider quota is charged for queueing, shared in-flight reuse, or shared cache hits. Injected providers without SDK-boundary instrumentation retain conservative adapter-invocation charging. Existing per-search limits remain QUICK 12, STANDARD 30, DEEP 40.

All counters, queue entries and cache entries are in memory, reset on process restart/deployment and are not shared across instances. Monthly usage also resets at UTC calendar-month boundaries. They are conservative beta protection, not authoritative RailKit account usage. Set limits below remaining account quota; use one Render instance. Multiple restarts/instances can bypass aggregate protection.

The HTTP boundary defaults to `SEARCH_CLIENT_IDENTITY_MODE=ANONYMOUS`. Socket addresses establish a network peer, not a user: multiple local browsers, NAT users, and headerless proxies may share one. All such requests rely on global search and provider protection and never enter a per-client bucket. Forwarding indicators (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`) always classify traffic as untrusted proxy traffic; their values are never used as identities.

`SEARCH_CLIENT_IDENTITY_MODE=DIRECT_PEER` is opt-in only for controlled direct-only deployments where the operator can assert that each socket peer represents one client. Distinct socket peers then receive separate per-client buckets; overlapping requests from the same peer retain per-client=1. IPv4-mapped peers normalize to the same IPv4 key, and source ports are ignored. This mode is unsuitable for Render, shared localhost browsers, NAT, or proxy ingress. For controlled local API tests, distinct simulated socket peers can exercise the direct policy; the anonymous default admits independent requests sharing localhost. No client-supplied user ID, cookie, request ID, body field or browser header is trusted as identity. This is accidental duplicate protection at a declared direct boundary, not authentication or defense against deliberate identity churn.

Start, completion and rejection logs carry only `clientIdentityClass` (ANONYMOUS_LOCAL, ANONYMOUS_DIRECT, UNTRUSTED_PROXY, UNKNOWN_PEER, DIRECT_PEER, or INTERNAL_CLIENT) and `perClientEnforced`. No IP, identity key or raw forwarding value is logged. There is no trusted-proxy identity implementation. Start/rejection protection snapshots distinguish global SDK quota usage from the rejected request's zero checks/invocations. Matching search parameters or a shared socket peer alone cannot establish whether requests came from a frontend duplicate or different users.

Availability SDK concurrency defaults to 2 (`RAILKIT_AVAILABILITY_MAX_CONCURRENT`). Waiting search owners rotate after each start; running work is not preempted. Identical train/from/to/date/class/quota requests share one SDK invocation across searches and provider instances. The shared cache defaults to 15 seconds (`RAILKIT_AVAILABILITY_CACHE_TTL_MS`) and 500 entries (`RAILKIT_AVAILABILITY_CACHE_MAX_ENTRIES`), evicts oldest insertions, and never serves expired entries. Only successfully normalized evidence with exactly one matching journey date and AVAILABLE, RAC, WAITLIST or NOT_AVAILABLE is cached. Errors, invalid/empty evidence, unsupported booking/class and local configuration failures are excluded. The raw SDK envelope is retained for raw-tool compatibility, validated through the same normalizer before caching, and cloned on reuse. Per-search cache semantics (including cached failures) remain unchanged.

Provider timeout: 15 seconds from execution start (queue time is covered by the search deadline). Overall search deadline: 90 seconds. AsyncLocalStorage supplies request-scoped abort signals to the SDK's fetch without altering URL, headers, response parsing or inventory semantics. Timed-out inventory remains provider-error/unknown, never WAITLIST or UNAVAILABLE. Search deadline returns structured 504, search rate/concurrency rejection returns 429; invocation-time quota exhaustion remains incomplete provider evidence through the existing provider-error response path. Client disconnect cancels its waiter. Shared transport is aborted only when no waiters remain or its execution timeout expires. An SDK ignoring abort retains its execution slot until its promise settles, preventing excess physical concurrency; a permanently stuck SDK can therefore exhaust capacity. Synchronous bounded planner work cannot be preempted mid-instruction; deadline is checked before provider work and before returning results. No partial inventory is fabricated.

Journey dates must be today through 60 days ahead, inclusive, in Asia/Kolkata calendar days. `MAX_BOOKING_HORIZON_DAYS` is configurable beta policy, not a permanent railway booking rule. Mode requires an actual string. Invalid input is rejected before provider work.

Set `CORS_ORIGIN` to a comma-separated allowlist of exact HTTP(S) origins (no trailing slash or wildcard). For local development, set `CORS_ORIGIN=http://localhost:3000,https://railway-website-sage.vercel.app` in `.env` and restart `npm run dev:api`. On Render, keep `CORS_ORIGIN=https://railway-website-sage.vercel.app`; existing single-origin settings remain supported. Empty/unset values grant no CORS permission, and previews are not automatically allowed. Allowed preflights return 204 with the matching origin, methods `POST, OPTIONS`, headers `Content-Type, X-Request-Id`, and `Vary: Origin`. CORS is not authentication. Logs include request ID, route/date/mode, duration and call counts; protect access and retention. No secrets or full provider URLs are intentionally logged.

## Availability diagnostics and admission logs

V2 diagnostics remain opt-in through `EXPOSE_SEARCH_DIAGNOSTICS` or `ENABLE_API_DIAGNOSTICS`. Existing fields remain compatible; none of the check counters prove external HTTP requests or provider billing.

| Field | Meaning |
| --- | --- |
| `attemptedAvailabilityChecks` | Distinct uncached availability checks admitted to the unchanged per-search budget, before adapter execution. |
| `actualSdkInvocations` | Availability SDK invocations attributed once to the active waiter initiating execution (shared followers record zero); observed immediately at the RailKit call boundary, after local validation/configuration and quota charging. Injected fake providers report zero. |
| `providerQueueWaits`, `providerQueueWaitMs` | Checks waiting for an execution slot and summed queue residence until start or cancellation; excludes time waiting on an already running shared call. |
| `sharedInflightHits`, `sharedCacheHits` | Cross-search exact in-flight joins and unexpired shared cache reuse. These still consume a distinct check in each search budget. |
| `providerRateLimited`, `providerTimeouts` | Checks with identifiable structural/normalized rate-limit evidence (including local quota denial), and identifiable provider execution timeouts. HTTP status is retained at the scoped transport boundary; errors without structural evidence are not classified by guessing message text. |
| `cacheHits` | Exact completed or in-flight reuse through `AvailabilitySession.get`; unchanged legacy semantics. Allocation's direct cache inspection/rehydration is not counted. |
| `providerSuccesses` | Checks yielding validated, matching-request/date inventory: AVAILABLE, RAC, WAITLIST, or NOT_AVAILABLE. This is not an HTTP-200 counter. |
| `providerErrors` | Existing check-level failure counter, including invalid/missing provider evidence and adapter validation failures; excludes separately counted unsupported-class and local configuration failures. |
| `localConfigurationFailures` | One for a rejected search's local configuration failure, recorded in its structured log; zero in successful search diagnostics. A standalone session latches a configuration failure once. |
| `unsupportedClassSkips` | Unique train/class pairs excluded by existing class eligibility filters during this search. Deduplicated across candidates/intervals; not a count of hypothetical HTTP requests saved. No class metadata is added by this instrumentation. |
| `availabilityCalls`, `budgetUsed`, internal `availabilityRequestsUsed` | Compatibility aliases for budgeted checks, not external calls. |
| `wholeLegCalls`, `recoveryCalls` | Existing breakdown of budgeted checks; their sum equals `availabilityCalls`. |
| `availableResponses`, `racResponses`, `waitlistResponses`, `unsupportedClassResponses` | Existing normalized outcome counters; unchanged. |
| `budgetLimit`, `budgetRemaining` | Existing check allowance and remaining checks; ceilings remain 12/30/40. |
| `discoveryCalls`, `trainInfoCalls` | Still zero in the local-schedule V2 API. |

`actualExternalRequests` is deliberately absent: entering SDK 5.0.3 or even delegating to `fetch` does not prove an HTTP request started on the wire. SDK invocation counts can differ from requests received or billed by RailKit. No global counter differences are used to estimate per-search activity.

`journey_v2_search_rejected` logs contain `requestId`, `code`, `failureCategory`, zero check/SDK counters, the check budget, and a `protection` snapshot. Categories identify local configuration failure, client search rate, client/global concurrency, or client capacity. Snapshots include current client searches/active count, global active count, monthly/burst usage, zero outstanding reservations, and configured limits; admission denials also include a zero requested reservation for compatibility. No credentials or raw provider error messages are logged. Local configuration failure occurs before search admission and charges neither search admission nor provider quota. Valid searches still pass all existing limit checks.

Completion logs include the new counters and `availabilityCallsMeaning: BUDGETED_CHECKS`. Error responses retain `{requestId,error:{code,message}}`; configuration failures are HTTP 503 rather than HTTP 200 with unverified schedule results. Health, endpoint paths, successful result structure, CORS, and request-ID behavior are unchanged. HTTP 429/5xx transport responses are now prevented from becoming availability or cache entries even if the SDK returns a success-shaped body. Existing structural failure categories are reused; unsupported-inventory meanings are unchanged.

## Render settings

- Runtime: Node
- Node: 24.x (`NODE_VERSION=24.x`)
- Root directory: repository root
- Build command: `npm ci --include=dev && npm run provision:db && npm run build && npm prune --omit=dev`
- Start command: `npm start`
- Health check: `/health`
- Set `HOST=0.0.0.0`; use Render's `PORT`.
- Set `RAILKIT_API_KEY`, `CORS_ORIGIN`, `RAILWAY_DB_ASSET_URL`, `RAILWAY_DB_SHA256` and protection limits.

GitHub upload, release asset publication and deployment are manual next steps. This repository contains no deployment credentials.
