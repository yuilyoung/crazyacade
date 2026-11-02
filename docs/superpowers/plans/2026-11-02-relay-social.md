# Relay and social play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox status.

**Goal:** Deliver a distinct team objective, shareable room configuration, and same-room rematches; reassess fixed benchmark.
**Architecture:** Pure relay module operates authoritative room state; index integrates lifecycle/rematches. Browser helpers parse/build safe invite URLs, render objectives and reset rounds. Existing classic/practice/auth/audio flows stay supported.
**Tech Stack:** Node22+,ws,vanillaJS/Canvas,PythonPlaywright; no dependencies.
**Spec:** docs/superpowers/specs/2026-11-02-relay-social-design.md

## Global Constraints
- Shared /workspace/crazyacade, baseline9bae5e3, authorizedmain push. Root commits after integration; workers do not commit.
- Preserve auth for normal games; relay and practice never alter ratings/results persistence.
- Existingclassic isdefault, omittedrules inherit existingroom; no live Supabase/deploy actions.
- Implementation workers own disjoint files and coordinate exact interface; tests first for rule/lifecycle changes.

## Review Focus
- Malformed/mismatched rules, practice/team coercion, auth & ranked exclusion.
- One star, no dead/bubbled pickup, no double capture, disconnect drop, safe respawn.
- Rematch resets all combat/objective fields and creates new matchUUID without old-save mutation.
- Departure during readiness and partial-room replacement preserve teams/player identities.
- Invite URL never exports secrets or overrides user's cosmetics; mobile objective avoids control shift.

### Task1: Relay rules and bot navigation
**Own:** Server/src/relay.js, Server/src/bots.js, Server/test/relay.test.js, additionalbot regression tests (bots.test.js).
**Interface:** initializeRelay(room) creates room.relay with {scores,goal:3,star,carrierId,nextSpawnTick,dropTick} and clears safe softcells. stepRelay(room) updates star/players, awardScore internally. dropRelayCarrier(room,playerId) before socket removal. relayResult(room,matchTicks=1200)->null|{draw?,winnerTeam?,reason,relayScores}. relayState(room)->public relay per spec ornull. Storage uses room.ruleSet, room.relay, player.respawnAt (undefined normally), player.deliveries(default0). Respawn determines original team slot coordinates as currentTEAM_SPAWNS. Caller runs stepRelay aftercombat/bubble expiry; initialize during creation/reset. Agents must avoid circularimports: relay may importawardScore, combat never importsrelay.
- [x] RED tests for exactlyonecarrier, guardstates, deliveryonce/5sreset, dropout,5srespawn+hazardwait,3points/time outcomes, softclearandclassicnoop.
- [x] Implementmodule, boundedbotgoalpaths withhazardpriority; keepnormalbotbehavior.
- [x] GREEN targetedtests, reportlimitations.

### Task2: Integration and rematch lifecycle
**Own:** Server/src/index.js,combat.js,rankings.js; new Server/test/relay-integration.test.js,rematch.test.js.
**Consumes:** Task1interface. Produce protocols exactspec, matchId,round,rematch,ranked.
- [x] RED realWS tests rulesvalidation/inheritance,auth/relaynonrank,rematchfullandpartial,disconnectready,repeatedvotes,matchid/counterreset.
- [x] Integraterelaycreation/step/state/result/disconnect,stats deliveriesscoreboard,rankingsguard.
- [x] Implementreset retainingplayerobjects/IDs/slots/sockets but resetallcombat, freshroster onlyatstart; snapshot oldresult before reset ifneeded.
- [x] GREEN targeted andfullserver whenTask1ready.

### Task3: Browser objectives, invites, ready flow
**Own:** Server/public/app.js,index.html,style.css,experience.js,newinvite.js; Server/test/invite.test.js ifhelperpure.
- [x] InviteURLhelperRED tests allowedvalues,roundtrip,encoding,notokens/hash,invalidfallback.
- [x] Rulechooseclassic/relay; duelforcesclassic; practicealways team andkeepsrule. QuickroomIDs include rule.
- [x] Drawstar/base/carrier,relay HUDgoal+respawn/deliverystats; instructions clear andnonrank label.
- [x] Share exactroom config withcopyfallback readonlyinput,disablepractice; parse fullquery before resetView.
- [x] Normalreplay sendsrematch once andshows votes; roundchange resetsguidance/result/controls withoutdisconnect. Keeppracticeinstantnewroom.
- [x] Syntax+helpers, rootbrowserverification.

### Task4: Root verification, benchmark and release
**Own:** scripts/*smoke.py andCI, docs exceptbenchmarkagentfile.
- [x] Adapt8-browser smoke for same-room readiness+refill; addrelaybrowser human objectivecapture/drop, AIpractice andinvite/mobile assertions.
- [x] Keeppractice/music/bridgechecks; integrationreviewfixes beforecomplete.
- [x] Record fixedrubricpostscore with concreteevidence, no fabricatedhumanmetrics.
- [x] UpdateREADME/protocol, commit,push,verifyremoteSHA, restartlocalPOC.

## Progress
- Previousworkcommitted9bae5e3, initialtreeclean. Useralreadyoptedintofullauto. Noapprovalcheckpointneeded.

- Task1: pure relay and bot35focusedtests green; Task2 full125server/helpertests green, independent lifecycle and fullcore review clean.
- Task3: invite8tests/experience/audio checks green; realLAN randomUUID absence reproduced and replaced by64bitgetRandomValues generation. UI independently reviewed without remaining findings.
- Final realChromium: relay invitation fallback/settings roundtrip, pickup→hitdrop→rescue→3captures→nonrank result→same8IDs rematch; deliverytutorial completion/reset and mobileAI carrier confirmed. Classic8browser partial4-person readiness+4-person refill passed. Fullpractice and audio lifecycle regressions passed. No pageerrors.
- Bridge2tests, AIguard5tests, workflow structure anddiff checks passed. Docker built and runtimechecked without hostports: nonroot, assets, ordinaryrelayauth, nonrank7botpractice.
- Benchmark02 fixedweights/subcriteria:5.775→6.45625; no humanplaytest/publicdeployment claims. Root commits/pushes this verified state and restarts localPOC.
