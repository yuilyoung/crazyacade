# Service activation follow-up

> **For agentic workers:** Use the existing full-auto authorization; execute and verify the tasks without an additional design approval. Work in the existing isolated cloud checkout.

**Goal:** Make the deployed game's remaining Supabase setup executable in one step and distinguish a running server from working member services.

**Architecture:** Keep Node.js and Supabase. Generate one transactional SQL bundle from the canonical schema/migrations; preserve existing records on repeat installation. Provide a bounded, cached, read-only service check, separate from Render's process readiness check. No payment charging, paid resources or account creation by the agent.

**Constraints:** Node 22+, no new dependency; keys remain server-only except the intended public anon key. Do not claim real deployment or Supabase verification without observed results. External dashboard writes require an available authorized connection; none is currently attached. Public health checks expose status codes only, never remote bodies, keys or user rows.

## Tasks

- [x] DB: reproduce repeated-install failures/data changes; make base policies repeat-safe and statistics backfill apply only to newly created counters. Generate `Supabase/setup.sql` with one transaction and notify schema reload. Add disposable PostgreSQL checks for fresh/partial/repeated installation, preserved records and restrictive final RLS. Check generated output in CI.
- [x] Services: add `createServiceDiagnostics({ env, fetchImpl, timeoutMs, cacheMs, now })` in `Server/src/service-diagnostics.js`. Return `status` plus checks for configuration, Auth Email/signup, schema and result RPC discovery. Use only GET/HEAD; share concurrent calls, cache 30 seconds, bound response reading/time. Add `GET/HEAD /health/services` (200 ready, 503 otherwise), leaving `/health/ready` independent. Test missing/wrong keys, provider outages/timeouts, missing schema/RPC, email disabled, safe output and caching.
- [x] Activation handoff: document exact SQL/Auth URL steps and status interpretation. Verify Node suite, database integration, HTTP checks and member/game acceptance affected by the change. Independent review; prepare the verified change for the authorized main push. Record what remains blocked by external access.

## Review focus

Repeat setup must not reset imported scores or private records. A failed bundled setup must roll back. Empty REST results must not mean absent tables. A database key alone must not report Email signup available. Diagnostic requests must not write records or leak provider error content, including on redirects/timeouts.

## Verification record

- Baseline Node suite: 642/642 passed. After changes: 655/655 passed.
- New diagnostics HTTP tests first failed on absent route/public secret exposure; additional boundary tests first reproduced malformed-RPC rejection, stalled body not cancelled and unrelated multiline config rejection. All 13 now pass.
- Real disposable PostgreSQL: initial repeated-policy and imported-stat failures reproduced, then full migration/RLS/Elo/concurrent-result suite and fresh/partial/repeated setup/data-preservation/forced rollback tests passed.
- Chromium member protocol fixture: 9 checkpoints passed, including session refresh, private history, nickname persistence, reconnect and delayed logout.
- Chromium battle viewports: 1440x900, 1280x720, 390x844 and 844x390 passed movement, bombs, 8-player AI arena, native fullscreen/Escape and no JS errors.
- Unity bridge tests: 5 passed. AI change guard tests: 5 passed. Generated SQL check and diff whitespace check passed.
- Independent final code review: approved with no Critical/Important blockers. Reviewer HTTP test rerun needed socket privileges; root's escalated HTTP and full suite runs passed.
- Live Render status is user-reported. Real Supabase SQL application, Email settings/delivery, authenticated Internet match storage and remote CI/deployment remain unverified. No external credentials attached; remote hosts remain denied by applied policy. Draft allows only the Render game and selected Supabase project hosts; review/save/publish is required to activate it.
