import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createResultOutbox } from '../src/result-outbox.js';

const outboxUrl = new URL('../src/result-outbox.js', import.meta.url).href;
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poppop-lease-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function owner(t, directory) {
  const script = `import { createResultOutbox } from ${JSON.stringify(outboxUrl)};
    const box = createResultOutbox({ directory: process.argv[1] });
    await box.start(); process.send('ready'); setInterval(() => {}, 1000);
    process.on('message', async () => { await box.close(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  return child;
}
async function ready(child) {
  let timeout;
  try { await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('owner exited before ready'); }), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('owner startup timed out')), 3000); })]); }
  finally { clearTimeout(timeout); }
}

test('real processes cannot own the same directory while a live writer holds its OS lease', async t => {
  const dir = await directory(t), first = owner(t, dir); await ready(first);
  const second = createResultOutbox({ directory: dir }); t.after(() => second.close());
  await assert.rejects(second.start(), /lock|lease|writer/i);
  assert.equal((await fs.stat(path.join(dir, '.writer.lock'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
});

test('SIGKILL of the actual owning parent releases the OS lease and allows automatic restart', async t => {
  const dir = await directory(t), first = owner(t, dir); await ready(first);
  const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
  const restarted = createResultOutbox({ directory: dir }); t.after(() => restarted.close());
  await restarted.start();
  assert.equal(restarted.diagnostics().invalid, 0);
  assert.equal(await fs.readFile(path.join(dir, '.writer.lock'), 'utf8'), '');
  const concurrent = createResultOutbox({ directory: dir }); t.after(() => concurrent.close());
  await assert.rejects(concurrent.start(), /lock|lease|writer/i);
});

test('startup scan failure releases the acquired lease and permits a new owner', async t => {
  const dir = await directory(t);
  const failed = createResultOutbox({ directory: dir, fileSystem: { ...fs, readdir: async () => { throw Error('scan failed'); } } });
  t.after(() => failed.close()); await assert.rejects(failed.start(), /scan failed/);
  const healthy = createResultOutbox({ directory: dir }); t.after(() => healthy.close()); await healthy.start();
  assert.equal(healthy.diagnostics().invalid, 0);
});

test('normal close permits a new owner without unlinking or replacing the lock inode', async t => {
  const dir = await directory(t), first = createResultOutbox({ directory: dir }); t.after(() => first.close());
  await first.start(); const inode = (await fs.stat(path.join(dir, '.writer.lock'))).ino;
  await first.close(); await first.close();
  const second = createResultOutbox({ directory: dir }); t.after(() => second.close()); await second.start();
  assert.equal((await fs.stat(path.join(dir, '.writer.lock'))).ino, inode);
});

test('directory names are passed literally without shell interpolation', async t => {
  const base = await directory(t), dir = path.join(base, "space ' $(touch INJECTED) ; `touch INJECTED` ");
  const box = createResultOutbox({ directory: dir }); t.after(() => box.close()); await box.start();
  assert.equal(box.diagnostics().invalid, 0);
  assert.ok((await fs.readdir(dir)).includes('.writer.lock'));
  await assert.rejects(fs.stat(path.join(base, 'INJECTED')), { code: 'ENOENT' });
});

test('acquisition deadline terminates a helper that never acknowledges readiness', async t => {
  const { acquireDirectoryLease } = await import('../src/directory-lease.js');
  const dir = await directory(t); let helper;
  const started = Date.now();
  await assert.rejects(acquireDirectoryLease(dir, { timeoutMs: 30, closeTimeoutMs: 30, spawnProcess: () => {
    helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] }); return helper;
  } }), /acquisition timed out/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(helper.signalCode, 'SIGKILL');
});

test('close has a deadline even when the flock holder is stopped and its command does not inherit the lock', async t => {
  const { acquireDirectoryLease } = await import('../src/directory-lease.js');
  const dir = await directory(t); let helper;
  const lease = await acquireDirectoryLease(dir, { closeTimeoutMs: 30, spawnProcess: (...args) => { helper = spawn(...args); return helper; } });
  t.after(() => lease.close());
  helper.kill('SIGSTOP');
  const started = Date.now(); await lease.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(helper.signalCode, 'SIGKILL');
  const restarted = await acquireDirectoryLease(dir); t.after(() => restarted.close());
  restarted.assertHeld();
});

test('killing flock itself releases the OS lock even while its cat command still has the parent pipe', async t => {
  const { acquireDirectoryLease } = await import('../src/directory-lease.js');
  const dir = await directory(t); let helper;
  const lease = await acquireDirectoryLease(dir, { spawnProcess: (...args) => { helper = spawn(...args); return helper; } });
  t.after(() => lease.close());
  const exited = once(helper, 'exit'); helper.kill('SIGKILL'); await exited;
  assert.throws(() => lease.assertHeld(), /no longer held/);
  // cat has not received EOF yet. Without flock -o it would keep the lock here.
  const restarted = await acquireDirectoryLease(dir); t.after(() => restarted.close());
  restarted.assertHeld(); await lease.close();
});

test('a lock symlink is rejected without altering its target', async t => {
  const dir = await directory(t), target = path.join(dir, 'target');
  await fs.writeFile(target, 'preserve'); await fs.chmod(target, 0o644);
  await fs.symlink(target, path.join(dir, '.writer.lock'));
  const box = createResultOutbox({ directory: dir }); t.after(() => box.close());
  await assert.rejects(box.start(), { code: 'ELOOP' });
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});
