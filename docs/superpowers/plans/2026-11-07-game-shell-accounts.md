# Game Shell and Member Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each deliverable and review its behavior.

**Goal:** Turn the scrolling POC into separate playable game screens, repair fullscreen/motion, and add registered accounts and private history.
**Architecture:** Keep the authoritative Node/WebSocket engine. A screen controller owns navigation; account client owns credentials/session; private HTTP APIs own account projections. Presentation interpolation never changes game rules.
**Tech Stack:** Node24, browser ES modules/Canvas, Supabase Auth/Postgres, Python Playwright.
**Spec:** docs/superpowers/specs/2026-11-07-game-shell-accounts-design.md

## Global Constraints
- Preserve production guest denial and account-free private AI/training.
- No actual payment processing; no payment credentials/card storage.
- Shared files have one owner: root owns HTML/CSS/app/display; account agent owns new account modules/http/Supabase migration; motion agent owns motion timeline/render tests.
- Preserve server-authoritative inputs/results, accessibility/reduced motion, reconnect and rematch behavior.
- Keep real public deployment/Supabase verification distinct from local fixtures.

## Review Focus
- Auth session expiry/signout/in-flight operations must not switch identity silently.
- Loading/error/cancel/back navigation must leave a usable screen and avoid duplicate joins.
- Fullscreen/ESC/rotation must retain visible arena and reachable controls.
- Remote snapshot gaps/turns/teleports must not interpolate through blocked cells or move hazards.
- Empty account history must differ from missing database configuration and query failure.

### Task 1: Registered account and private records
Files: new Server/public/account-client.js; new Server/src/accounts.js; Server/src/http.js; Supabase/migrations/20261107_member_accounts.sql; new focused tests.
Interfaces: createAccountClient({fetch,storage,now}).configure(config),getSession(),getAccessToken(),signUp(email,password,nickname),signIn(email,password),signOut(),getAccount(),updateProfile({nickname}). GET /api/account and PATCH /api/account/profile require server-verified member bearer identity.
- [x] Reproduce missing signup/private endpoints; test refresh, auth isolation, body validation, safe errors, separate unavailable/empty history.
- [x] Implement member sessions, authenticated profile/statistics/match and read-only payment history, migration with RLS/grants.
- [x] Run focused client/HTTP tests and isolated DB validation; independent review.

### Task 2: Continuous movement presentation
Files: Server/public/motion-timeline.js and relevant tests; renderer only if needed.
- [x] Reproduce80ms travel followed by idle at100/200ms snapshots and interruptions.
- [x] Implement bounded cadence-aware visual interpolation with preserved reset/hazard/accessibility semantics.
- [x] Verify continuity, turn, stop, lag, teleport and reduced motion with deterministic clocks; independent review.

### Task 3: Screen flow and fullscreen
Files: new Server/public/game-shell.js, shell.css, member-panel.js; existing index.html/app.js/display.js; new screen tests and scripts/game-shell-smoke.py.
Interfaces: createGameShell({document,onNavigate,onPlay,onLeave,onAccount}).show(screen),sync({state,connecting,recovering,queueBusy}),setStatus(message,error),destroy(). Screen panels preserve existing game DOM IDs and app handlers.
- [x] Capture baseline fullscreen/viewport failure and add screen transition assertions.
- [x] Implement title/login/lobby/loadout/maps/connecting/waiting/battle/results/profile/ranking screens and dedicated navigation; wire account and existing join/recovery/rematch lifecycle.
- [x] Keep fullscreen target as the app shell so dialogs/results/navigation remain visible; sync native fullscreen exit and resize.
- [x] Test real browser keyboard/touch/fullscreen/configured-account fixture, no page scroll during game, reconnect and rematch.

### Task 4: Integration, service evidence and delivery
- [x] Run server/helper suite plus relevant browser flows and migration checks; inspect screenshots.
- [x] Independent review of final diff, correct findings, record measured scope and remaining external setup.
- [x] Update README/Render/Supabase instructions and score interpretation; deliver the verified change through the authorized main commit/push workflow.
