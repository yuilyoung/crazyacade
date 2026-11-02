# Playability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Enable immediate solo team practice and make learning/cooperative feedback readable, then report an evidence-based comparison.
**Architecture:** Keep authoritative Node.js/WebSocket combat. Bots submit ordinary inputs in isolated unranked rooms; the browser adds progressive guidance and optional local audio/accessibility settings.
**Tech Stack:** Node.js 22+, ws, vanilla JS/Canvas/Web Audio, Python Playwright.
**Spec:** docs/superpowers/specs/2026-11-02-playability-design.md

## Global Constraints

- Shared workspace /workspace/crazyacade; user has authorized main development and push. Workers do not commit; root integrates once.
- No dependency additions, paid APIs, new assets from the original game, or real Supabase mutations.
- Bots and people obey the same combat rules. Practice never changes rankings.
- Existing join selectors and live 8-person gameplay remain supported.

## Review Focus

- Forged practice fields cannot bypass ranked authentication or join another practice room.
- Practice disconnect/finished expiry releases capacity, no sockets required for bots.
- Bot bomb decisions have escape paths; no server exception in any map/item mode.
- Tutorial completion uses accepted server state and resets between matches.
- Optional audio/motion settings work without storage/audio APIs and do not capture focused button keyboard activation.

### Task 1: Bot decision module
**Files:** Create Server/src/bots.js, Server/test/bots.test.js.
**Interface:** `decideBotInput(room, player)` returns `{move?: 'up'|'down'|'left'|'right', placeOrb?: boolean, useDart?: boolean}`. Receives room {tick,players Map,solid Set,soft Set,orbs Map,waves array,items Map,itemMode,mode} and player combat properties. No mutation of player location/combat state.
- [x] Write failing tests for walls, movement, blast avoidance, safe bomb escape, trapped/no-action, ally rescue targeting and item-mode off.
- [x] Implement bounded BFS/navigation and deterministic decision variation using tick/slot; each bot evaluated at most once every 3 ticks by caller.
- [x] Run targeted tests; report limitations for honest product scoring.

### Task 2: Isolated practice lifecycle and counters
**Files:** Server/src/index.js, combat.js, pickups.js, rankings.js; new Server/test/practice.test.js and counter tests.
**Interface:** join.practice boolean; state.practice boolean; players[].isBot boolean and bombsPlaced/itemsCollected/rescues numbers; result.scoreboard[].rescues.
- [x] Red tests for one-human 7-bot start in production guest-off, auth untouched, malformed practice, private-room rejection, no ranking writes, max8 cleanup.
- [x] Implement unique practice rooms, validate before auth, skip all auth/persistence only in isolated practice, reject outside joins, guard finalizeMatch, remove room on owner close and close finished practice after120s.
- [x] Create socketless bot players in balanced teams and run normal movement/combat; serialize/broadcast handles no socket.
- [x] Increment accepted action counters and scoreboard rescues; test single rescue counted once.
- [x] Run server suite with Task1 available.

### Task 3: Practice/guide/feedback UI
**Files:** Server/public/app.js, index.html, style.css; optional helper experience.js.
**Interface:** consumes Task2 protocol, IDs specified by spec. Retain original selectors.
- [x] Parent writes browser acceptance assertions before implementation, sees current practice button absent.
- [x] Add dedicated practice button bypassing Supabase authentication, immediate replay, bot/nonrank labels and explanatory empty/wait states.
- [x] Add tutorial accepted movement/bomb/item checklist, collapse/reopen, team rescue countdown and result rescue recognition.
- [x] Add opt-in Web Audio cues, reduced motion preference/storage fallback, noncolor team cues and mobile sizing. Keep helpers separate if useful.
- [x] Run syntax check; root runs real Chromium new flow and existing 8-browser regression.

### Task 4: Comparison, integration, verification
**Files:** docs/Design/Competitive-Assessment.md, README.md, protocol/readiness/acceptance docs, scripts/practice-smoke.py, .github/workflows/*.yml.
- [x] Record criterion rubric and baseline scores, compare original qualitatively without current-market statistics.
- [x] Add new smoke to CI/AI validation/container verification as appropriate, preserve existing tests.
- [x] Verify server full suite, old and new browser smoke, bridge tests. Inspect desktop/mobile evidence.
- [x] Independent review of auth/ranking/lifecycle, bot behavior and accessibility; fix findings.
- [x] Update post scores only for verified delivered capabilities, explicitly separate fun hypothesis from user research.
- [x] Commit, push main, verify remote SHA; list deployment/user-playtest limitations.

## Execution ledger

- Baseline 6ce7407; clean tree. User opted into full auto earlier, continuing without new approval checkpoints.
- Files are separated between workers for useful parallel work; root owns integration/browser acceptance/docs.

### Task 5: Casual original music and richer effects (user steering)
**Files:** Server/public/audio.js; public app/experience/index/style integration; Server/test/audio.test.js; scripts/practice-smoke.py.
**Interface:** `createAudioDirector()` returns {get state(), async setEffectsEnabled(bool), async setMusicEnabled(bool), setEffectsVolume(0..1), setMusicVolume(0..1), playEffect(kind), setScene(scene), setHidden(bool), dispose()}. State {effectsEnabled,musicEnabled,effectsVolume,musicVolume,available}; scene lobby|battle|result. `scheduleMusicBar(context,destination,when,barIndex,scene)` and `scheduleEffect(context,destination,kind,when)` exported for offline audition; return source node arrays for cleanup. Effects move,bomb,wave,item,rescue,victory,defeat,draw,result.
- [x] Write meaningful scheduling/bounds/stop tests first, observe failure, implement no dependencies.
- [x] Original8bar major/pentatonic melody with chord/bass/percussion, scene-dependent tempo and arrangement; no identifiable reused tune.
- [x] Separate #music-toggle and existing #sound-toggle, range #music-volume/#effects-volume, explicit labels; independent muting and volumes; defaultOFF and no auto replay on reload.
- [x] Lazy AudioContext unlock only from user action, timer/source cleanup on mute/hidden/dispose, suppress gameplay event sounds while tab hidden, resume enabled music when visible.
- [x] Browser instrumentation verifies actual sound generation/mute/scene changes, offline render sample validates nonzero audio/no clipping; inspect/listen sample as available.

### Progress record

- Tasks1/2 implemented and independently reviewed. Bot chained explosions can remove soft shielding; regression fixed. Server76/76 passed before audio increment. Bots now display varied existing characters/skins (cosmetic only).
- Task3 implemented. Existing8-browser regression and full realtime practice round/replay passed in Chromium; mobile390px no overflow; explicit effects generated real oscillators, muted state generated none. Final-state accepted tutorial action bug corrected and isolated harness verified; next full practice run will include it.
- Task4 comparison drafted with fixed rubric. Prior POC4.84/10, original qualitative reference7.44; provisional delivered-design5.78. No human playtest claims. Bridge2 tests and AIguard5 tests passed.
- Task5 user requested BGM during work; new task added. UI music-button absence verifiedRED. Audio module and richer music/SFX implementation delegated; root owns audio-smoke/offlineWAV check and CI integration.

- Final verification: full88/88 server/client logic tests passed. Actual8-human smoke passed after audio integration; final practice smoke passed full round/replay and viewport-bound mobile controls; final audio smoke passed real suspend/resume, visibility, independentchannels and8bar OfflineAudioContext mix.
- Review fixes: server close/CLOSING capacity race fixed with deterministic test and40/40stress; AudioContext interruption now cancels/restarts enabled music, verified browser; BFCache restores defaultOFF director; mobile compact controls fit828px within844px and reserved rescue banner prevents layout shift.
- FinalDocker built and non-root runtime verified new audio/client assets, normal auth rejection and isolated7botpractice. Comparison post scores remain expert design judgment, no human playtest or public deployment claimed. Root integrates and publishes this verified state in the accompanying commit.
