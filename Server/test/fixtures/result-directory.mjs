import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

export const createResultDirectory = () => mkdtemp(path.join(tmpdir(), 'arena-result-test-'));

export async function stopResultServer(proc, directory) {
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = once(proc, 'exit'); proc.kill(); await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
