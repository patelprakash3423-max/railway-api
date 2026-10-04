# Cleanup manifest

Original railway-engine is the retained historical reference.

|Classification|Examples|Decision and evidence|
|---|---|---|
|RUNTIME_REQUIRED|API, planner, allocation, recovery, presentation, provider|Retained unchanged except boundary hardening and dependency extraction.|
|TEST_REQUIRED|*.test.ts, synthetic CSV/JSON, CLI wrappers and fake providers|Retained: automated tests execute CLI entrypoints and import fakes. Fakes live in test-support.|
|BUILD_REQUIRED|package manifests, lockfiles, TypeScript/Next/ESLint configuration|Retained, made independent.|
|DEVELOPMENT_USEFUL|Importer/CSV, tested offline CLI commands|Retained; dataset regeneration and tested debugging entrypoints. No importer in production closure.|
|HISTORICAL_ARTIFACT|journey-live-output.txt, journey-v2-regression-live.txt, halt-analysis.json, validation reports, import/plan logs, raw RailPull exports, phase reports|Not migrated; no current runtime or automated test dependency.|
|GENERATED_ARTIFACT|node_modules, .next, dist, coverage, tsbuildinfo|Not migrated; regenerated independently.|
|UNREFERENCED|Superseded live terminal scripts and dated report generators below|Only old npm commands/docs referenced these; current API/offline suites replace terminal response captures. Removed commands too.|

Removed source helpers:
- `src/tests/test-trains-between.ts`
- `src/tests/test-availability-diagnostic.ts`
- `src/tests/test-availability.ts`
- `src/tests/test-journey-connection.ts`
- `src/tests/test-train-info.ts`
- `src/tests/test-provider-train.ts`
- `src/tests/test-provider-availability.ts`
- `src/tests/test-journey-same-train.ts`
- `src/tests/provider-test-runner.ts`
- `src/utils/playground.ts`
- `src/local-railway/tests/validate-v2.ts`
- `src/local-railway/tests/validate-v2-availability.ts`
- `src/local-railway/tests/validate-recovery-v2.ts`
- `src/local-railway/tests/validate-journey-recovery-v2.ts`

Uncertain usage retained: legacy application/connection/recovery modules remain because meaningful automated tests still import them; logger extraction alone is not proof they are disposable.

## Backend V2 stabilization cleanup

- Removed the ignored `.browser-test-provider-investigation/` directory (`inspect.mjs`, `live.ts`, and `live-results.json`). No backend source, test, package script, or documentation referenced it.
- Removed 70 ignored repository-root development logs. Validation logs are kept outside the repository.
- Removed compiler-confirmed unused test imports and the unused presentation-test `statuses` constant. Runtime behavior is unchanged.
- Retained all `.env.example` variables: each has backend code/test/script references. Real `.env` files remain ignored and are not part of the checkpoint.
- Existing ignore rules already cover investigation directories, logs, SQLite files and sidecars, dependencies, and build output; no additional ignore patterns were needed.
- Retained offline evaluation tools/reports, fixtures, legacy modules, the local timetable, and dependency/build directories. They are referenced, operationally required, reproducible output, or not proven obsolete; local databases and generated output remain untracked.
- Updated API documentation to distinguish zero-provider-call discovery from selected-route availability and the retained CLI matrix policy.
