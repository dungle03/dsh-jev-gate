const globalRuns = new Set();

export function createJevgrepControl({
  maxPerSession = 1,
  maxGlobal = 2,
  maxPending = 20,
  failureThreshold = 3,
  cooldownMs = 60_000,
  now = Date.now,
} = {}) {
  const runs = new Set();
  const breakers = new Map();
  let disposed = false;
  const breakerKey = (session, root) => JSON.stringify([session, root]);

  const reserve = ({ session, root, query, signal }) => {
    if (disposed || signal?.aborted) return { reason: 'skip_cancelled' };
    // Drop rather than queue. Cancel superseded work before admitting new work.
    for (const run of runs) {
      if (run.session !== session) continue;
      if (run.root === root && run.query === query) return { reason: 'skip_duplicate' };
      run.controller.abort();
    }
    if (runs.size >= maxPending) return { reason: 'skip_pending_cap' };
    const sessionActive = [...globalRuns].filter((run) => run.session === session).length;
    if (sessionActive >= maxPerSession || globalRuns.size >= maxGlobal) {
      return { reason: 'skip_concurrency', session_active: sessionActive, global_active: globalRuns.size };
    }

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
      for (const run of runs) run.controller.abort();
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
