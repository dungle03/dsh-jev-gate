import { randomUUID } from 'node:crypto';

export function stoppingSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && !signal.aborted ? AbortSignal.any([signal, timeout]) : timeout;
}

// Logical reservations are never refunded; invocation counts are not token usage.
export function beginOperation(record, fields, now = Date.now) {
  const operation_id = randomUUID();
  const started = now();
  let invocations = 0;
  let finished = false;
  const emit = (extra) => {
    try {
      record({ type: 'cost_governor', ...fields, operation_id,
        invoked: invocations > 0, actual_invocations: invocations,
        completed: false, cancelled: false, failure: null,
        elapsed_ms: Math.max(0, now() - started), ...extra });
    } catch { /* Telemetry must never change execution or cleanup. */ }
  };
  emit({ decision: fields.allowed ? 'reserved_cost' : 'skip_budget' });
  return {
    invoke() {
      if (finished) return;
      invocations += 1;
      emit({ decision: 'actual_invocation' });
    },
    finish({ completed = false, cancelled = false, failure = null } = {}) {
      if (finished) return;
      finished = true;
      emit({ decision: 'operation_finished', completed, cancelled, failure });
    },
  };
}
