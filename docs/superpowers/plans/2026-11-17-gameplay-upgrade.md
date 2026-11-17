# Gameplay Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Improve capture/escape, continuous walking, map identity, real pickup feedback and map audio; schedule tested daily improvements and deployment.
**Architecture:** Extend the existing authoritative Node engine and presentation-only Canvas timeline. Reuse isolated proposal/validation GitHub jobs and explicitly dispatch CI for the published SHA.
**Tech Stack:** Node >=22, Canvas2D, Web Audio, Python Playwright, GitHub Actions, Render.
**Spec:** ../specs/2026-11-17-gameplay-upgrade-design.md (approved by user: 진행해).

## Global Constraints
- Keep independent artwork/audio and existing gameplay authority.
- Preserve mute defaults, reduced motion, pickup caps 5/7/1, safe symmetric spawns.
- Existing cloud checkout is isolated; no worktree is needed.
- Never claim remote activation or a score without measured evidence.

## Review Focus
- Reconnect/map changes must not replay capture, pickup or wall sounds.
- Cooldown, bubbles and network delays must not emit wall collisions.
- Reduced motion keeps essential state without animated decorations.
- Daily edits must not weaken protected tests or overwrite a newer main.
- Bot-authored commits require explicit CI dispatch and matching deployment SHA.

### Task 1: Presentation and pickup feedback
Files: Server/public/motion-timeline.js, visuals.js, arena-renderer.js, Server/test/motion-timeline.test.js, scripts/movement-quality.mjs.
- [x] Add failing coverage for stop envelope, continuous phase and capture state.
- [x] Preserve walking history at cell boundaries and expose bounded fade at start/stop.
- [x] Add capture entry, trapped breathing and escape deformation/particles; retain static reduced-motion state.
- [x] Measure the fixed score and actual browser frame sample; report raw data and limits.

### Task 2: Maps and items
Files: Server/public/map-catalog.js, arena-renderer.js, experience.js; Server/test/map-catalog.test.js, gameplay.test.js.
- [x] Add failing map identity/preview and actual capacity/range/speed checks.
- [x] Share map palette/structure description between miniatures and arena; draw distinct solid-cell landmarks.
- [x] Add explicit item upgrade feedback using authoritative before/after capabilities.
- [x] Verify symmetry, connectivity and actual item gameplay without changing caps.

### Task 3: Audio and collisions
Files: Server/public/audio.js, experience.js; Server/src/match-engine.js, index.js; Server/test/audio.test.js and gameplay.test.js.
- [x] Test distinct map scores, capture/escape/collision voices and false collision exclusions.
- [x] Expose wallHits from actual solid/soft/border movement rejection and wire throttled effects.
- [x] Implement setMap(mapId), map tempo/key/timbre and truthful transition sounds.
- [x] Run audio, engine, accessibility and browser checks.

### Task 4: Daily automation
Files: .github/workflows/ai-roles.yml, .github/scripts/ai_changes.py, daily_publish.py and tests; docs/Operations/GitHub-Automation.md.
- [x] Test main SHA guard, protected-test changes and failed validation behavior.
- [x] Schedule UTC 00:00, retain manual mode, bound daily task to approved backlog or reproduced bug.
- [x] Publish only tested proposal after unchanged-base check, explicitly dispatch/poll exact-SHA CI, then check existing Render deployment.
- [x] Verify local automation tests; test remote capability and report any external blockers without inventing credentials.

### Task 5: Integration
- [x] Run full server suite, AI guard tests, actual browser flow and movement measurements.
- [x] Review changes and resolve issues; update operational docs and reusable cloud instructions.
- [x] Report local versus remote outcomes separately. Remote API access is Forbidden; actual remote activation remains unverified.
