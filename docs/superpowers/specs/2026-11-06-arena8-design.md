# 8-player arena space and fairness

Approved goal: complete the enlarged 4 vs 4 arena following the map comparison, automatically verify and push. Baseline: 7234286. This changes our POC; original Nexon board dimensions have not been independently verified.

## Binding behavior

Normal team rooms (human, practice bots, ranked, classic, relay, harmony and party) use outer 15×13, interior 13×11. Duel and both guided training modes retain exact legacy 13×11 layouts and timing. Do not add a new game mode. Keep themes, assets, controls, progression, auth and persistence behavior.

Shared geometry lives in `Server/public/arena-geometry.js`:
- `LEGACY_ARENA = {width:13,height:11}` and `TEAM_ARENA = {width:15,height:13}`, frozen.
- `resolveArena(value)` accepts a descriptor or `value.arena`, recognizes only these two complete pairs and otherwise returns legacy. Missing arena never implies large based on mode.
- `arenaForMode(mode, training=false)` returns team only for team and falsy training.
- `spawnPoints(value)` returns eight ordered frozen [x,y] pairs: legacy x1/11 y1,3,7,9; large x1/13 y1,4,8,11.
- `arenaCenter(value)` returns {x:6,y:5} or {x:7,y:6}; `arenaBases(value)` returns `{blue:{x:1,y:centerY},pink:{x:width-2,y:centerY}}`.
- `insideArena(value,x,y)` checks strict interior bounds.
- `tideGateGroups(value)` returns a deeply frozen ordered array of `{id,cells}` records, A first (`id:"a"`), B second (`id:"b"`), with string cell keys. Legacy: `[{id:"a",cells:["4,5","8,5"]},{id:"b",cells:["6,3","6,7"]}]`; large: `[{id:"a",cells:["5,6","9,6"]},{id:"b",cells:["7,4","7,8"]}]`. Existing catalog `TIDEGATES` remains the legacy export.
- `createLayout(mapId,mode,{arena=arenaForMode(mode)}={})` still returns exactly `{solid,soft}`. Legacy explicit arena preserves current membership AND insertion order. Invalid map/mode still rejects.

Rooms choose arena once before layout creation. The authoritative snapshot includes a fresh allowlisted `arena:{width,height}`. Rematch/party retains correct geometry. Both initial and per-lesson training resets explicitly request legacy. When installing a fresh layout, clear old map-feature state before initialization so old gate cleanup cannot remove fresh permanent walls.

All movement, explosion, dart, hazard, bot search, relay center/bases/respawn/pass and map-feature coordinates derive from room geometry. Preserve 100ms ticks, 20-tick bomb fuse and bubble timeout, movement cooldown 2/default and 1/fast, range 3/default through 7/max, five-bomb cap. No artificial timing relaxation or state injection to make browser tests pass.

## Expanded layout

All borders solid. Interior permanent walls:
- Garden/Lagoon/Candy: {4,6,8,10}×{2,4,8,10} plus {3,11}×{4,8}.
- Harbor: {4,10}×{2,4,8,10} plus {6,8}×{4,8}.
- Festival: {4,10}×{4,5,7,8} plus {6,8}×{2,10}.

Crates mirror each seed through x→14-x and y→12-y:
- Garden (4,5),(5,2),(5,4),(5,5).
- Lagoon (4,5),(5,4),(5,5),(6,5).
- Candy (5,2),(5,4),(5,5),(6,5).
- Harbor (5,2),(5,4),(5,5),(6,2).
- Festival (4,2),(5,2),(6,4).

Populate output sets deterministically x-major/y-minor. Preserve Harbor gate schedule and occupancy deferral. In every gate phase, walls/crates/spawns reflect across both axes; the initial free graph is connected, has no articulation or dead-end cell, each spawn has ≥2 immediate exits, ≥10 free cells within three moves and a two-move escape from its own range-3 blast. Initial free cells are 107 for first three maps, 113 for Harbor with one group closed, 119 for Festival. Own-half reachability is at least 48 cells for each team. Open starts allow meeting without breaking crates; symmetry is not proof of human win-rate balance.

## Presentation and compatibility

Browser logical tile size remains 60: 900×780 normal team and 780×660 legacy. Server arena overrides lobby selections; lobby selects mode/training geometry. Update floors, y inversion, clearing, pass guides, capture/replay bounds, scaled markers and map miniatures. CSS wrapper aspect ratio follows geometry in portrait, landscape, focus, fullscreen and party layouts. Keep controls usable (≥44 CSS px touch targets), visible important markers (≥10 CSS px) and no clipped board at tested viewports. Timeline tile caps follow resolved board area, with absent geometry legacy. Social cards and appearance-preview dimensions do not change.

Unity source compatibility is included: consume arena and solid DTOs; dynamically rebuild online floor and authoritative solid/soft terrain, center world positions and frame the board. Preserve offline legacy bootstrap defaults. Clear superseded network terrain safely; no per-frame full rebuild. Unity editor/build is unavailable here: source review is evidence, not a claimed WebGL build or runtime validation.

## Verification and completion

Behavioral unit/integration tests prove legacy fingerprints, geometry fallback/invalid descriptors, all new layout graph invariants and both gate phases, far-edge movement/darts/blasts/relay/AI, rematch/party and guided training geometry. Existing tests must retain their gameplay meaning. Update actual browser routes to use dynamic dimensions and real prepositioning rather than changing gameplay timing.

Run the full Node suite, focused real-browser regressions for classic/relay/harmony/training/party/motion, actual eight-client edge interactions and solo bot play, and desktop/mobile/landscape/high-DPI checks. Capture genuine screenshots and metrics. Build and smoke-test the final Docker image against exact served source hashes. Broad independent branch review precedes integration. Fast-forward clean main and push without force; verify remote SHA. Report any unavailable Unity/public Supabase/real-human testing honestly. Do not invent a new benchmark score.
