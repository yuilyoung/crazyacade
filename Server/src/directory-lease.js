import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// flock owns the descriptor; -o prevents its command from inheriting the lock.
// The command's stdin belongs to Node, so even SIGKILL of Node closes the pipe,
// ends cat, and lets flock exit. The shell program contains no interpolated data.
const HOLD_LEASE = "printf 'ready\\n'; exec /bin/cat >/dev/null";

/** Linux, local filesystem, one writer. Never unlink the persistent lock inode. */
export async function acquireDirectoryLease(directory, { timeoutMs = 2000, closeTimeoutMs = 1000, spawnProcess = spawn } = {}) {
  if (process.platform !== 'linux') throw Error('Result directory lease requires Linux flock');
  directory = path.resolve(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const lockFile = path.join(directory, '.writer.lock');
  const handle = await fs.open(lockFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Invalid result directory lock file');
    await handle.chmod(0o600);
  } finally { await handle.close(); }

  const child = spawnProcess('/usr/bin/flock', ['-n', '-o', '--', lockFile, '/bin/sh', '-c', HOLD_LEASE], { stdio: ['pipe', 'pipe', 'pipe'] });
  let held = false, finished = false, closePromise;
  const exited = new Promise(resolve => {
    const finish = () => { held = false; finished = true; resolve(); };
    child.once('exit', finish); child.once('error', finish);
  });
  // A rejected acquisition may close stdin before end() flushes. Never leak EPIPE.
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const waitForExit = async duration => {
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), duration); })]); }
    finally { clearTimeout(timer); }
  };
  const close = () => closePromise ??= (async () => {
    held = false; child.stdin.end();
    if (!finished && !await waitForExit(closeTimeoutMs)) {
      child.kill('SIGKILL');
      if (!await waitForExit(closeTimeoutMs)) throw Error('Result directory lease did not exit');
    }
  })();
  let timeout, onData, onExit, onError;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      onData = chunk => {
        output += chunk.toString('utf8');
        if (output === 'ready\n' && !finished) { held = true; resolve(); }
        else if (output.length >= 64) reject(Error('Invalid result directory lease handshake'));
      };
      onExit = () => reject(Error('Result directory writer lock is unavailable'));
      onError = () => reject(Error('Cannot launch result directory lease; Linux util-linux flock is required'));
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
      timeout = setTimeout(() => reject(Error('Result directory lease acquisition timed out')), timeoutMs);
    });
    return { close, assertHeld() { if (!held || finished) throw Error('Result directory writer lease is no longer held'); } };
  } catch (error) { await close(); throw error; }
  finally {
    clearTimeout(timeout);
    child.stdout.removeListener('data', onData); child.removeListener('exit', onExit); child.removeListener('error', onError);
    child.stdout.resume();
  }
}
