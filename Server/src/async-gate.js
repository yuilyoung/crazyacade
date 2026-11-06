function gateError(code) {
  const error = new Error(code);
  error.code = code;
  if (code === 'gate_aborted') error.name = 'AbortError';
  return error;
}

// This semaphore bounds asynchronous I/O; it never blocks the event loop.
export function createAsyncGate({ capacity = 4, maxPending = 32 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new TypeError('Gate limits must be valid integers');
  }
  const pending = [];
  let active = 0, rejected = 0, closed = false;

  function rejectRequest(code) { rejected++; return Promise.reject(gateError(code)); }

  function start(entry) {
    entry.signal?.removeEventListener('abort', entry.abort);
    active++;
    // Defer execution so synchronous errors take the same release path as I/O.
    Promise.resolve().then(() => entry.task(entry.signal)).then(
      value => finish(entry, entry.resolve, value),
      error => finish(entry, entry.reject, error)
    );
  }

  function finish(entry, settle, value) {
    active--;
    if (!closed && pending.length) start(pending.shift());
    settle(value);
  }

  return {
    run(task, { signal } = {}) {
      if (closed) return rejectRequest('gate_closed');
      if (signal?.aborted) return rejectRequest('gate_aborted');
      if (typeof task !== 'function') return Promise.reject(new TypeError('Gate task must be a function'));
      if (active >= capacity && pending.length >= maxPending) return rejectRequest('gate_full');
      return new Promise((resolve, reject) => {
        const entry = { task, signal, resolve, reject };
        if (active < capacity) { start(entry); return; }
        entry.abort = () => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1);
          signal.removeEventListener('abort', entry.abort);
          rejected++;
          reject(gateError('gate_aborted'));
        };
        pending.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
      });
    },
    close() {
      closed = true;
      for (const entry of pending.splice(0)) {
        entry.signal?.removeEventListener('abort', entry.abort);
        rejected++;
        entry.reject(gateError('gate_closed'));
      }
    },
    snapshot() { return { active, pending: pending.length, capacity, maxPending, rejected, closed }; }
  };
}
