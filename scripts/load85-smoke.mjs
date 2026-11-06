#!/usr/bin/env node
// Localhost evidence only. Run from any directory with Server dependencies installed:
// node scripts/load85-smoke.mjs --output docs/Design/evidence/benchmark85-load.json
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_LIMITS } from '../Server/src/runtime.js';

const require = createRequire(new URL('../Server/package.json', import.meta.url));
const WebSocket = require('ws');
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { durationSeconds: 60, output: path.join(root, 'docs/Design/evidence/benchmark85-load.json') };
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index], value = process.argv[++index];
  if (name === '--duration-seconds') options.durationSeconds = Number(value);
  else if (name === '--output' && value) options.output = path.resolve(value);
  else throw new Error('Usage: load85-smoke.mjs [--duration-seconds 1..90] [--output filename]');
}
assert.ok(Number.isInteger(options.durationSeconds) && options.durationSeconds >= 1 && options.durationSeconds <= 90);

function distribution(values) {
  assert.ok(values.length > 0, 'A measured distribution must contain observations');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, min: sorted[0], p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) };
}

async function until(predicate, description, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await sleep(10);
  }
}

async function sourceFingerprint() {
  const files = (await readdir(path.join(root, 'Server/src'))).filter(name => name.endsWith('.js')).map(name => `Server/src/${name}`);
  files.push('Server/public/map-catalog.js', 'Server/public/arena-geometry.js', 'Server/public/cosmetics.js');
  const digest = createHash('sha256');
  for (const name of files.sort()) { digest.update(name); digest.update(await readFile(path.join(root, name))); }
  return { algorithm: 'sha256', serverSourceAndSharedCatalogDigest: digest.digest('hex'), fileCount: files.length };
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arena-load85-'));
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', ALLOW_DEV_GUESTS: 'true',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', RESULT_OUTBOX_DIR: directory };
  // A caller's test-only limit overrides must not alter the recorded defaults.
  for (const key of Object.keys(env)) if (key.startsWith('RUNTIME_')) delete env[key];
  const child = spawn(process.execPath, ['src/index.js'], { cwd: path.join(root, 'Server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startup = '', stderrBytes = 0, port, spawnFailure;
  const peers = new Set();
  child.stdout.on('data', data => {
    startup = (startup + data.toString()).slice(-4096);
    port ??= Number(/listening on 127\.0\.0\.1:(\d+)/.exec(startup)?.[1]) || undefined;
  });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.on('error', error => { spawnFailure = error.code ?? 'spawn_failed'; });

  async function metrics() {
    const response = await fetch(`http://127.0.0.1:${port}/health/runtime`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200, 'Runtime diagnostics remain available');
    return response.json();
  }

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = { ws, state: null, playerId: null, errors: [], stateCount: 0, bytesReceived: 0,
      closeCode: null, pendingPing: null, rtts: [], sentPings: 0, sentInputs: 0, missedPingSlots: 0 };
    peers.add(peer);
    ws.on('message', raw => {
      peer.bytesReceived += raw.length;
      const message = JSON.parse(raw);
      if (message.type === 'joined') peer.playerId = message.playerId;
      if (message.type === 'state') { peer.state = message; peer.stateCount++; }
      if (message.type === 'error' && peer.errors.length < 8) peer.errors.push(message.code);
      if (message.type === 'pong' && peer.pendingPing !== null) {
        if (peer.rtts.length >= 128) throw new Error('RTT sample bound exceeded');
        peer.rtts.push(performance.now() - peer.pendingPing); peer.pendingPing = null;
      }
    });
    ws.on('close', code => { peer.closeCode = code; });
    ws.on('error', () => { if (peer.errors.length < 8) peer.errors.push('socket_error'); });
    await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
    return peer;
  }

  function send(peer, message) {
    assert.equal(peer.ws.readyState, WebSocket.OPEN, 'Measured peer remains connected');
    peer.ws.send(JSON.stringify(message));
  }

  function ping(peer) {
    if (peer.pendingPing !== null) { peer.missedPingSlots++; return; }
    peer.pendingPing = performance.now(); peer.sentPings++; send(peer, { type: 'ping' });
  }

  async function closePeers(group) {
    for (const peer of group) if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close(1000, 'Load phase complete');
    await until(() => group.every(peer => peer.ws.readyState === WebSocket.CLOSED), 'client cleanup', 5000);
    for (const peer of group) peers.delete(peer);
  }

  async function cleanMetrics() {
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await metrics();
      if (result.connections === 0 && result.rooms === 0 && result.queuedPlayers === 0 && result.authActive === 0 && result.authPending === 0) return result;
      await sleep(20);
    }
    assert.fail('Connections, rooms, queue and authentication resources did not return to zero');
  }

  async function limitsPhase() {
    const before = await cleanMetrics(), sockets = [];
    for (let index = 0; index < DEFAULT_RUNTIME_LIMITS.maxConnections + 1; index++) sockets.push(await connect());
    const rejected = sockets.at(-1);
    await until(() => rejected.closeCode !== null, 'connection-cap rejection');
    assert.equal(rejected.closeCode, 1013);
    const atConnectionLimit = await metrics();
    assert.equal(atConnectionLimit.connections, DEFAULT_RUNTIME_LIMITS.maxConnections);
    ping(sockets[0]); await until(() => sockets[0].rtts.length === 1, 'accepted peer at connection cap');
    await closePeers(sockets); await cleanMetrics();

    const waiting = [];
    for (let index = 0; index < DEFAULT_RUNTIME_LIMITS.maxRooms + 1; index++) {
      const peer = await connect(); waiting.push(peer);
      send(peer, { type: 'join', roomId: `capacity-${index}`, mode: 'team', humanSlots: 8, ruleSet: 'harmony' });
      await until(() => peer.playerId || peer.errors.length > 0, 'room admission response');
    }
    assert.deepEqual(waiting.at(-1).errors, ['room_unavailable']);
    assert.ok(waiting.slice(0, -1).every(peer => peer.playerId && peer.errors.length === 0));
    const atRoomLimit = await metrics(); assert.equal(atRoomLimit.rooms, DEFAULT_RUNTIME_LIMITS.maxRooms);
    await closePeers(waiting);
    return { connectionLimit: DEFAULT_RUNTIME_LIMITS.maxConnections, extraConnectionCloseCode: rejected.closeCode,
      connectionRejections: atConnectionLimit.connectionsRejected - before.connectionsRejected,
      admittedPeerPingMsAtLimit: sockets[0].rtts[0], roomLimit: DEFAULT_RUNTIME_LIMITS.maxRooms,
      extraRoomError: waiting.at(-1).errors[0], cleanup: await cleanMetrics() };
  }

  try {
    await until(() => port || child.exitCode !== null || spawnFailure, 'server startup');
    assert.ok(port && child.exitCode === null && !spawnFailure, 'Isolated server starts successfully');
    const initial = await metrics(), fingerprintBefore = await sourceFingerprint(), clients = [];
    const startedAt = new Date().toISOString();
    for (let index = 0; index < 64; index++) {
      const peer = await connect(); clients.push(peer);
      send(peer, { type: 'join', roomId: `load-${Math.floor(index / 8)}`, mode: 'team', humanSlots: 8,
        ruleSet: Math.floor(index / 8) % 2 ? 'harmony' : 'relay', itemMode: true, mapId: 'garden', name: `Load${index}` });
      await until(() => peer.playerId || peer.errors.length > 0, 'load client admission');
      assert.deepEqual(peer.errors, []);
    }
    await until(() => clients.every(peer => peer.state?.phase === 'playing' && peer.state.players.length === 8), 'eight active eight-player rooms');
    const baseline = await metrics(); assert.equal(baseline.connections, 64); assert.equal(baseline.rooms, 8);
    const samples = [], inputCounts = {}, runtimeStart = performance.now();
    let lastTick = -1, samplerFailure, sampling = true, missedInputBatches = 0;
    const sampler = (async () => {
      while (sampling) {
        try {
          const snapshot = await metrics();
          if (snapshot.ticks !== lastTick) {
            assert.ok(samples.length < 1024, 'Runtime sampling stays bounded');
            samples.push({ elapsedMs: performance.now() - runtimeStart, ...snapshot }); lastTick = snapshot.ticks;
          }
        } catch (error) { samplerFailure = error; return; }
        await sleep(100);
      }
    })();
    const inputBatches = options.durationSeconds * 5;
    for (let batch = 0; batch < inputBatches; batch++) {
      await sleep(Math.max(0, runtimeStart + batch * 200 - performance.now()));
      if (performance.now() - (runtimeStart + batch * 200) > 200) missedInputBatches++;
      for (let index = 0; index < clients.length; index++) {
        const offset = (batch + index) % 20;
        const action = offset === 0 ? 'place_orb' : offset === 5 ? 'use_dart' : offset === 10 ? 'pass_star' : ['left', 'up', 'right', 'down'][(batch + index) % 4];
        send(clients[index], { type: 'input', action }); clients[index].sentInputs++;
        inputCounts[action] = (inputCounts[action] ?? 0) + 1;
        if (batch % 5 === 0) ping(clients[index]);
      }
      if (batch % 50 === 0) console.log(`Load measurement ${Math.floor(batch / 5)}/${options.durationSeconds}s: 64 clients in 8 rooms`);
    }
    await sleep(Math.max(0, runtimeStart + options.durationSeconds * 1000 - performance.now()));
    const measuredDurationMs = performance.now() - runtimeStart;
    sampling = false; await sampler;
    if (samplerFailure) throw samplerFailure;
    await until(() => clients.every(peer => peer.pendingPing === null), 'all measurement ping replies');
    const afterLoad = await metrics(), loadRtts = clients.flatMap(peer => peer.rtts);
    assert.equal(clients.reduce((sum, peer) => sum + peer.sentInputs, 0), 64 * inputBatches);
    assert.equal(loadRtts.length, 64 * options.durationSeconds, 'Every scheduled ping receives a reply');
    assert.ok(clients.every(peer => peer.closeCode === null && peer.errors.length === 0 && peer.state.phase === 'playing'));
    assert.ok(afterLoad.ticks - baseline.ticks >= options.durationSeconds * 8, 'Gameplay ticks keep progressing');
    assert.equal(afterLoad.messagesRejected - baseline.messagesRejected, 0, 'Normal traffic is within the receive limit');
    const baselineClientSummary = clients.map(peer => ({ states: peer.stateCount, bytesReceived: peer.bytesReceived,
      inputCount: peer.sentInputs, pingCount: peer.sentPings, finalGameTick: peer.state.tick }));

    // A separate real flood does not contaminate the steady-load distributions.
    const floodBefore = await metrics(), attacker = await connect(), fairnessStart = clients.map(peer => peer.rtts.length);
    for (let index = 0; index < 100; index++) send(attacker, { type: 'ping' });
    await until(() => attacker.closeCode !== null, 'flood policy disconnect');
    assert.equal(attacker.closeCode, 1008);
    const fairnessTickStart = clients.map(peer => peer.state.tick);
    for (let batch = 0; batch < 15; batch++) {
      for (const peer of clients) {
        send(peer, { type: 'input', action: ['left', 'up', 'right', 'down'][batch % 4] });
        if (batch % 5 === 0) ping(peer);
      }
      await sleep(200);
    }
    await until(() => clients.every(peer => peer.pendingPing === null), 'healthy ping replies after flood');
    const fairnessRtts = clients.flatMap((peer, index) => peer.rtts.slice(fairnessStart[index]));
    assert.equal(fairnessRtts.length, 64 * 3);
    assert.ok(clients.every((peer, index) => peer.state.tick > fairnessTickStart[index] && peer.closeCode === null));
    const floodAfter = await metrics();
    const flood = { closeCode: attacker.closeCode, rejectedMessages: floodAfter.messagesRejected - floodBefore.messagesRejected,
      rateLimitedSockets: floodAfter.rateLimitedSockets - floodBefore.rateLimitedSockets,
      healthyPeers: 64, healthyRttMs: distribution(fairnessRtts), everyRoomAdvanced: true };
    await closePeers([...clients, attacker]);
    const afterLoadCleanup = await cleanMetrics();
    const capacity = await limitsPhase();
    const fingerprintAfter = await sourceFingerprint();
    assert.deepEqual(fingerprintAfter, fingerprintBefore, 'Measured production sources did not change during the run');
    const shutdownStartedAt = performance.now();
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'clean server shutdown after resource cleanup', 3000);
    const shutdown = { signal: 'SIGTERM', durationMs: performance.now() - shutdownStartedAt, exitCode: child.exitCode,
      signalCode: child.signalCode, forced: false, activeRoomsBeforeSignal: capacity.cleanup.rooms,
      connectionsBeforeSignal: capacity.cleanup.connections, configuredDrainDeadlineMs: DEFAULT_RUNTIME_LIMITS.drainMs };
    assert.equal(child.exitCode, 0, 'Empty server shuts down cleanly without a forced signal');
    assert.equal(stderrBytes, 0, 'Server emitted no stderr during the run');
    const evidence = {
      schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), success: true,
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      workingTreeModified: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
      source: fingerprintBefore,
      environment: { node: process.version, platform: process.platform, architecture: process.arch,
        osRelease: os.release(), logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(), loopback: true, clientAndServerShareHost: true, developmentGuests: true, resultStorage: 'disabled' },
      limits: DEFAULT_RUNTIME_LIMITS,
      workload: { requestedDurationSeconds: options.durationSeconds, measuredDurationMs, clients: 64, rooms: 8,
        humansPerRoom: 8, automatedClients: true, humanParticipants: 0, bots: 0,
        ruleSets: { relayRooms: 4, harmonyRooms: 4 }, map: 'garden',
        inputsPerClientPerSecond: 5, pingsPerClientPerSecond: 1, inputCounts, missedInputBatches,
        sentInputs: 64 * inputBatches, sentPings: clients.reduce((sum, peer) => sum + peer.sentPings, 0) - 64 * 3 },
      measured: { pingRttMs: distribution(loadRtts), runtimeTickDelta: afterLoad.ticks - baseline.ticks,
        sampledTickDurationMs: distribution(samples.map(sample => sample.tickDurationMs)),
        sampledTickLagMs: distribution(samples.map(sample => sample.tickLagMs)),
        lifetimeTickMaxDurationMs: afterLoad.tickMaxDurationMs, lifetimeTickMaxLagMs: afterLoad.tickMaxLagMs,
        rssBytes: { initial: initial.rssBytes, beforeLoad: baseline.rssBytes, afterLoad: afterLoad.rssBytes,
          sampledPeak: Math.max(...samples.map(sample => sample.rssBytes)), afterLoadCleanup: afterLoadCleanup.rssBytes },
        perClient: baselineClientSummary, runtimeBeforeLoad: baseline, runtimeAfterLoad: afterLoad },
      sampling: { intervalMs: 100, maximumRuntimeSamples: 1024, maximumRttSamples: 8192,
        note: 'Tick percentiles sample the latest public metric once per distinct tick observed; missed ticks are not reconstructed.', samples },
      floodFairness: flood, capacity, afterLoadCleanup, finalCleanup: capacity.cleanup, shutdown,
      limitations: [
        'One localhost Node process and colocated clients; these results do not establish public-network or production capacity.',
        'No external authentication, ranked-profile reads, or result storage requests are exercised in development guest mode.',
        'The separate flood phase checks healthy peer progress. Actual paused-reader eviction is covered by Server/test/runtime-network.test.js, not measured by this script.',
        'No CPU affinity or host isolation is applied; external workload can influence latency and memory observations.'
      ]
    };
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ output: path.relative(root, options.output), durationSeconds: options.durationSeconds,
      pingRttMs: evidence.measured.pingRttMs, sampledPeakRssBytes: evidence.measured.rssBytes.sampledPeak,
      finalConnections: evidence.finalCleanup.connections, finalRooms: evidence.finalCleanup.rooms }));
  } finally {
    for (const peer of peers) peer.ws.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await sleep(20);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await sleep(20);
      }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
