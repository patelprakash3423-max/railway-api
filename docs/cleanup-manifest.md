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
