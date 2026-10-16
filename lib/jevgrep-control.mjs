const globalRuns = new Set();
const globalPending = new Map();
const releaseWaiters = new Set();

export function createJevgrepControl({
  maxPerSession = 1,
  maxGlobal = 2,
  maxPending = 20,
  failureThreshold = 3,
  cooldownMs = 60_000,
  now = Date.now,
} = {}) {
  if (maxPerSession !== 0 && maxPerSession !== 1) {
    throw new RangeError('jevGrepMaxConcurrentPerSession must be 0 or 1 (latest-query-wins)');
  }
  const runs = new Set();
  const breakers = new Map();
  const pending = globalPending;
  const owner = Symbol();
  const clearPending = (session, ready = false) => {
    const entry = pending.get(session);
    if (!entry) return;
    pending.delete(session);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(ready);
  };
  const defer = (session, signal) => new Promise((resolve) => {
    clearPending(session);
    const entry = { signal, resolve, owner };
    entry.onAbort = () => { if (pending.get(session) === entry) clearPending(session); };
    pending.set(session, entry);
    signal?.addEventListener('abort', entry.onAbort, { once: true });
  });
  const releasePending = () => {
    if (disposed || !pending.size || globalRuns.size >= maxGlobal) return;
    for (const [session, entry] of pending) {
      if (entry.owner !== owner || [...globalRuns].some((run) => run.session === session)) continue;
      clearPending(session, true);
      break;
    }
  };
  let disposed = false;
  releaseWaiters.add(releasePending);
  const breakerKey = (session, root) => JSON.stringify([session, root]);

  const reserve = ({ session, root, query, signal, wait = false }) => {
    if (disposed || signal?.aborted) return { reason: 'skip_cancelled' };
    // The newest request supersedes a deferred request even if admission is full.
    clearPending(session);
    if (runs.size >= maxPending) return { reason: 'skip_pending_cap' };
    for (const run of globalRuns) {
      if (run.session !== session) continue;
      if (run.root === root && run.query === query && !run.controller.signal.aborted) return { reason: 'skip_duplicate' };
      run.controller.abort();
    }
    const sessionActive = [...globalRuns].filter((run) => run.session === session).length;
    if (sessionActive >= maxPerSession || globalRuns.size >= maxGlobal) {
      return { reason: 'skip_concurrency', session_active: sessionActive, global_active: globalRuns.size,
        ...(wait && maxPerSession > 0 && sessionActive ? { ready: defer(session, signal) } : {}) };
    }
    clearPending(session);

    const key = breakerKey(session, root);
    let breaker = breakers.get(key);
    if (failureThreshold > 0 && breaker?.openedAt !== undefined) {
      if (breaker.probe || now() - breaker.openedAt < cooldownMs) {
        return { reason: 'skip_breaker' };
      }
      breaker.probe = true;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const run = { session, root, query, controller };
    runs.add(run);
    globalRuns.add(run);
    let released = false;
    return {
      signal: controller.signal,
      finish(result) {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', onAbort);
        runs.delete(run);
        globalRuns.delete(run);
        for (const release of releaseWaiters) release();
        if (failureThreshold <= 0) return;
        if (!result || result.cancelled || controller.signal.aborted) {
          if (breaker) breaker.probe = false;
          return;
        }
        if (result.ok) {
          breakers.delete(key);
          return;
        }
        breaker ??= { failures: 0 };
        breaker.failures += 1;
        if (breaker.probe || breaker.failures >= failureThreshold) breaker.openedAt = now();
        breaker.probe = false;
        breakers.set(key, breaker);
        return breaker.failures;
      },
    };
  };

  return {
    reserve,
    dispose() {
      disposed = true;
      releaseWaiters.delete(releasePending);
      for (const run of runs) run.controller.abort();
      for (const [session, entry] of pending) if (entry.owner === owner) clearPending(session);
      breakers.clear();
    },
  };
}

export function keepBoundedHint(map, key, value, cap = 20) {
  if (cap <= 0) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

export function admitRepositoryHint(admit, wrap, agent, turn, hint) {
  const text = wrap(hint);
  const admission = admit(agent, turn, [{ kind: 'evidence', text }]);
  const kept = admission.kept[0];
  // A truncated envelope has lost its trust boundary. Drop it in full.
  return kept && !kept.truncated && kept.text === text ? text : undefined;
}
