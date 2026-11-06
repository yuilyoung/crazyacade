import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildMatchPayload, persistMatchPayload } from './supabase.js';
import { isRankedMatch } from './ranked-policy.js';
import { acquireDirectoryLease } from './directory-lease.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownTemporary = new RegExp(`^\\.${uuid.source.slice(1, -1)}\\.${uuid.source.slice(1, -1)}\\.tmp$`, 'i');

/** Single-process queue. Its directory must be on a persistent, private volume. */
export function createResultOutbox({ directory = path.resolve('data/results'), persist = persistMatchPayload, onStatus = () => {},
  retryDelays = [1000, 2000, 5000, 10000, 30000], capacity = 1000, concurrency = 2, maxBytes = 32768,
  now = Date.now, fileSystem = fs, leaseFactory = acquireDirectoryLease } = {}) {
  const records = new Map(), reservations = new Map(), completed = new Map(), active = new Set(), rejected = new Set(), invalidIds = new Set();
  let mutations = Promise.resolve(), timer, started = false, closing = false, paused = false, invalid = 0, orphanedTemporary = 0;
  let lease, starting, closePromise;
  const filename = matchId => path.join(directory, `${matchId}.json`);
  const emit = record => { try { onStatus({ matchId: record.matchId, status: record.status, attempts: record.attempts }); } catch { /* Observers cannot corrupt durable delivery. */ } };
  const rejectAdmission = (matchId, error) => {
    // A conflicting duplicate must not overwrite a legitimate job's status.
    if (!records.has(matchId) && !reservations.has(matchId) && !completed.has(matchId)) {
      rejected.add(matchId);
      if (rejected.size > capacity) rejected.delete(rejected.values().next().value);
      if (typeof matchId === 'string') emit({ matchId, status: 'failed', attempts: 0 });
    }
    return error;
  };
  const serial = fn => { const operation = mutations.then(fn); mutations = operation.catch(() => {}); return operation; };
  const directorySync = async () => { const handle = await fileSystem.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
  async function write(record) {
    lease?.assertHeld?.();
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > maxBytes) throw new Error('Result record size exceeds limit');
    const temporary = path.join(directory, `.${record.matchId}.${crypto.randomUUID()}.tmp`);
    let handle, installed = false;
    try {
      handle = await fileSystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await fileSystem.rename(temporary, filename(record.matchId)); installed = true; await directorySync();
    } catch (error) {
      // A failed directory fsync may leave the final file present. Retain that
      // record as failed instead of allowing another admission to overwrite it.
      if (installed) error.resultInstalled = true;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fileSystem.unlink(temporary).catch(() => {});
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!started || paused || closing) return;
    const pending = [...records.values()].filter(record => record.status !== 'failed' && !active.has(record.matchId));
    pending.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    for (const record of pending) {
      if (active.size >= concurrency) break;
      if (record.nextAttemptAt > now()) {
        timer = setTimeout(schedule, Math.max(1, record.nextAttemptAt - now())); timer.unref?.(); break;
      }
      active.add(record.matchId);
      void deliver(record);
    }
  }
  async function deliver(record) {
    try {
      const prepared = await serial(async () => {
        if (paused || closing) return false;
        record.attempts++; record.status = 'saving'; await write(record); emit(record);
        return true;
      });
      // Shutdown can begin while the durable attempt metadata is flushing.
      if (!prepared || paused || closing) return;
      await persist(record.payload);
      await serial(async () => {
        await fileSystem.unlink(filename(record.matchId)); await directorySync(); records.delete(record.matchId);
        completed.set(record.matchId, { payload: JSON.stringify(record.payload), attempts: record.attempts });
        if (completed.size > capacity) completed.delete(completed.keys().next().value);
        emit({ ...record, status: 'saved' });
      });
    } catch (error) {
      await serial(async () => {
        record.status = error.retryable === true ? 'retrying' : 'failed';
        record.nextAttemptAt = now() + retryDelays[Math.min(Math.max(0, record.attempts - 1), retryDelays.length - 1)];
        try { await write(record); } catch { record.status = 'failed'; }
        emit(record);
      });
    } finally { active.delete(record.matchId); schedule(); }
  }
  function validateRecord(value, file) {
    if (!value || value.version !== 1 || !uuid.test(value.matchId) || file !== `${value.matchId}.json` ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0 ||
      !['saving', 'retrying', 'failed'].includes(value.status)) throw Error('Invalid stored record');
    const p = value.payload;
    const normalized = buildMatchPayload({ id: p.p_room_id, matchId: p.p_match_id, mode: p.p_mode, result: p.p_result,
      participants: p.p_participants.map(item => ({ userId: item.user_id, team: item.team, score: item.score })) });
    if (p.p_match_id !== value.matchId || !p.p_participants.length || !isDeepStrictEqual(normalized, p) ||
      !isDeepStrictEqual(Object.keys(value).sort(), ['version', 'matchId', 'payload', 'attempts', 'nextAttemptAt', 'status'].sort())) throw Error('Invalid stored payload');
    return { version: 1, matchId: value.matchId, payload: normalized, attempts: value.attempts, nextAttemptAt: now(), status: 'saving' };
  }
  return {
    start() {
      if (started || starting || closing) return Promise.reject(Error('Result outbox already started or closed'));
      starting = (async () => {
        try {
          await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 }); await fileSystem.chmod(directory, 0o700);
          lease = await leaseFactory(directory);
          for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
            if (entry.name === '.writer.lock' && entry.isFile()) continue;
            if (entry.isFile() && ownTemporary.test(entry.name)) { orphanedTemporary++; continue; }
            try {
              if (!entry.isFile() || !uuid.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json') || records.size >= capacity) throw Error('Invalid result filename');
              const file = path.join(directory, entry.name), stat = await fileSystem.lstat(file);
              if (!stat.isFile() || stat.size > maxBytes) throw Error('Invalid result file');
              const record = validateRecord(JSON.parse(await fileSystem.readFile(file, 'utf8')), entry.name);
              records.set(record.matchId, record);
            } catch { invalid++; if (entry.name.endsWith('.json') && uuid.test(entry.name.slice(0, -5))) invalidIds.add(entry.name.slice(0, -5)); }
          }
          if (closing) throw Error('Result outbox closed during startup');
          lease?.assertHeld?.(); started = true; schedule();
        } catch (error) {
          closing = true;
          await lease?.close();
          throw error;
        }
      })();
      return starting;
    },
    enqueue(snapshot) {
      let matchId = snapshot?.matchId;
      try {
        if (!started || closing) throw Error('Result outbox is not accepting results');
        lease?.assertHeld?.();
        if (!uuid.test(matchId) || !isRankedMatch(snapshot)) throw Error('Invalid ranked result');
        // Capture before yielding to another enqueue or the disk mutation lock.
        const payload = buildMatchPayload(snapshot);
        if (!payload.p_participants.length) throw Error('No verified result participants');
        if (invalidIds.has(matchId)) throw Error('Existing invalid result file requires repair');
        const existing = records.get(matchId), done = completed.get(matchId), reserved = reservations.get(matchId);
        const payloadKey = JSON.stringify(payload), prior = reserved?.payloadKey ?? (existing ? JSON.stringify(existing.payload) : done?.payload);
        if (prior) {
          if (prior !== payloadKey) throw Error('Conflicting result for match ID');
          if (reserved) return reserved.operation;
          emit(existing ?? { matchId, status: 'saved', attempts: done.attempts });
          return Promise.resolve();
        }
        if (records.size + reservations.size + invalid >= capacity) throw Error('Result outbox capacity exceeded');
        const record = { version: 1, matchId, payload, attempts: 0, nextAttemptAt: now(), status: 'saving' };
        if (Buffer.byteLength(JSON.stringify(record)) > maxBytes) throw Error('Result record size exceeds limit');
        // Reserve synchronously, before joining the asynchronous mutation queue.
        const reservation = { payloadKey };
        reservations.set(matchId, reservation);
        reservation.operation = serial(async () => {
          try {
            await write(record);
            reservations.delete(matchId);
            rejected.delete(matchId); records.set(matchId, record); emit(record);
          } catch (error) {
            if (error.resultInstalled) { reservations.delete(matchId); record.status = 'failed'; records.set(matchId, record); emit(record); }
            throw error;
          } finally { reservations.delete(matchId); }
        }).then(() => { schedule(); }, error => { throw rejectAdmission(matchId, error); });
        return reservation.operation;
      } catch (error) {
        return Promise.reject(rejectAdmission(matchId, error));
      }
    },
    diagnostics() {
      const values = [...records.values()];
      const pending = values.filter(r => r.status === 'saving').length + reservations.size, retrying = values.filter(r => r.status === 'retrying').length;
      const failed = values.filter(r => r.status === 'failed').length + rejected.size;
      return { status: failed || retrying || invalid || orphanedTemporary ? 'degraded' : 'ok', pending, retrying, failed, invalid, active: active.size, capacity, orphanedTemporary };
    },
    pause() { paused = true; clearTimeout(timer); },
    close() {
      paused = true; closing = true; clearTimeout(timer);
      return closePromise ??= (async () => {
        try {
          await starting?.catch(() => {});
          await mutations;
          while (active.size) await new Promise(resolve => setTimeout(resolve, 10));
          await mutations;
        } finally { await lease?.close(); }
      })();
    }
  };
}
