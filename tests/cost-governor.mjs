import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';
import { CONTEXT_PRIORITY, dedupeInjection, fingerprintOf, planInjection } from '../lib/injection.mjs';

const source = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
const budgetSource = source.slice(source.indexOf('  const budgetTurnUsed ='), source.indexOf('  const jevClient ='));
const ranks = { completion: 3, recovery: 2, effort: 1, advisory: 0 };
const layers = { destructive_gate: 'safety', completion_check: 'completion', failure_recovery: 'recovery', effort_route: 'effort' };
function governor(overrides = {}) {
  const rows = [];
  const cfg = { jevBudgetEnabled: true, jevMaxCallsPerTurn: 4, jevMaxCallsPerSession: 100,
    maxDecisionCostPerTurn: 16, maxDecisionCostPerSession: 120,
    reviewMaxPerSession: 20, jevGrepMaxPerSession: 10, ...overrides };
  const take = new Function('cfg', 'sessionKeyOf', 'evictOldest', 'record', 'JEV_LAYER_PRIORITY', 'JEV_PRIORITY_RANK',
    `${budgetSource}\nreturn takeDecisionCost;`)(cfg, (a) => a.session.id, () => {}, (r) => rows.push(r), layers, ranks);
  return { take, rows };
}
const agent = { id: 'a', session: { id: 's' } };
{
  const { take, rows } = governor({ maxDecisionCostPerTurn: 8 });
  assert.equal(take(agent, 1, 'jevgrep').cost, 8);
  assert.equal(take(agent, 1, 'completion_check').reason, 'turn_cost_budget');
  assert.equal(take(agent, 2, 'jevgrep', 3).cost, 3);
  assert.equal(take(agent, 2, 'quality_review', 1).cost, 2);
  assert.equal(rows.at(-1).category, 'review');
  assert.equal(rows.at(-1).costTurnUsed, 3);
}
{
  const { take } = governor({ jevMaxCallsPerTurn: 1, jevMaxCallsPerSession: 1 });
  assert.equal(take(agent, 1, 'quality_review', 2).allowed, true);
  assert.equal(take(agent, 1, 'completion_check').allowed, true);
  assert.equal(take(agent, 2, 'completion_check').reason, 'session_budget');
  assert.equal(take(agent, 2, 'jevgrep', 3).allowed, true);
}
{
  const { take } = governor({ reviewMaxPerSession: 1, jevGrepMaxPerSession: 1 });
  assert.equal(take(agent, 1, 'quality_review').allowed, true);
  assert.equal(take(agent, 2, 'quality_review').reason, 'review_session_budget');
  assert.equal(take(agent, 1, 'jevgrep', 3).allowed, true);
  assert.equal(take(agent, 2, 'jevgrep', 3).reason, 'jg_session_budget');
}
{
  const { take } = governor({ maxDecisionCostPerSession: 4 });
  assert.equal(take(agent, 1, 'quality_review').allowed, true);
  assert.equal(take(agent, 2, 'quality_review').allowed, true);
  assert.equal(take(agent, 3, 'completion_check').reason, 'session_cost_budget');
  for (let i = 0; i < 20; i++) assert.equal(take(agent, 3, 'destructive_gate').allowed, true);
  assert.equal(take({ session: { id: 'other' } }, 1, 'completion_check').allowed, true);
}
{
  const { take } = governor({ maxDecisionCostPerTurn: 8 });
  const accepted = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve(take(agent, 1, 'quality_review').allowed)));
  assert.equal(accepted.filter(Boolean).length, 4);
}
{
  const { take } = governor({ jevBudgetEnabled: false, maxDecisionCostPerTurn: 0, reviewMaxPerSession: 0 });
  assert.equal(take(agent, 1, 'quality_review').allowed, true);
}

// A held feedback quota must survive ordinary higher-priority injections.
{
  const contextSource = source.slice(source.indexOf('  const contextUsed ='), source.indexOf('\n  /**\n   * P0.3'));
  const context = new Function('cfg', 'agentTurnKey', 'dedupeInjection', 'CONTEXT_PRIORITY', 'fingerprintOf',
    'planInjection', 'evictOldest', 'record', `${contextSource}\nreturn {reserveReviewContext, releaseReviewContext, admitContext};`)(
    { maxPluginContextTokensPerTurn: 200, reviewContextReserveTokens: 120 },
    (a, t) => `${a.id}:${t}`, dedupeInjection, CONTEXT_PRIORITY, fingerprintOf, planInjection, () => {}, () => {});
  const reservation = context.reserveReviewContext(agent, 1);
  assert.ok(reservation);
  assert.equal(context.reserveReviewContext(agent, 1), undefined);
  assert.equal(context.admitContext(agent, 1, [{ kind: 'recovery', text: 'x'.repeat(320) }]).used, 80);
  assert.equal(context.admitContext(agent, 1, [{ kind: 'completion', text: 'ordinary' }]).kept.length, 0);
  const feedback = context.admitContext(agent, 1, [{ kind: 'advisory', text: 'review '.repeat(100), truncatable: true }], reservation);
  assert.equal(feedback.kept.length, 1);
  assert.equal(feedback.used, 120);
  assert.equal(reservation.active, false);
  const next = context.reserveReviewContext(agent, 2);
  context.releaseReviewContext(next);
  context.releaseReviewContext(next);
  assert.ok(context.reserveReviewContext(agent, 2));
}

const dirs = [];
function fixture(overrides = {}, execute, diff) {
  const logDir = mkdtempSync(join(tmpdir(), 'cost-governor-'));
  dirs.push(logDir);
  const handlers = {};
  const calls = [];
  const summary = { cwd: '/tmp', total: 1, added: 50, deleted: 5, files: [{ path: 'sample.mjs' }] };
  const session = { id: `s-${dirs.length}`, header: { cwd: '/tmp' }, snapshotEvents: () => [
    { type: 'workspace/changes', seq: 500, data: { turn: 1 } },
  ] };
  const agent = { id: `a-${dirs.length}`, session, goal: { objective: 'Implement a calculator' },
    steered: [], steer(m) { this.steered.push(m); } };
  const ctx = {
    on(name, fn) { (handlers[name] ??= []).push(fn); }, effect() {}, logger: { warn() {} },
    credentials: { resolve: async () => ({ value: 'test' }) },
    get(name) { return name === 'workspaceChanges' ? { summary: () => summary,
      diff: diff ?? (async () => ({ kind: 'text', path: 'sample.mjs', hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
      ] })) } : undefined; },
    tools: { get: () => ({}), execute: async (input) => {
      calls.push(input);
      if (execute) return execute(input);
      return { content: [{ type: 'text', text: '{"metrics":{"correctness":{"applicable":true,"score":8}}}' }] };
    } },
  };
  apply(ctx, { logDir, enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
    enableQualityReview: true, enableContextTriage: false, enableSpawnHint: false,
    enableJevgrepEscalation: false, ...overrides });
  return { calls, agent, handlers, stop: (signal = new AbortController().signal, turn = 1) =>
    handlers['agent/turn-stopping'][0]({ agent, turn, signal }) };
}
try {
  const zero = fixture({ maxPluginContextTokensPerTurn: 0, reviewMode: 'agent-feedback' });
  await zero.stop();
  assert.equal(zero.calls.length, 0);
  const telemetry = fixture({ maxPluginContextTokensPerTurn: 0, reviewMode: 'telemetry' });
  await telemetry.stop(AbortSignal.abort());
  assert.equal(telemetry.calls.length, 1);
  assert.equal(telemetry.calls[0].signal.aborted, false);
  assert.equal(telemetry.agent.steered.length, 0);
  const legacy = fixture({ reviewReportToAgent: false, maxPluginContextTokensPerTurn: 0 });
  await legacy.stop();
  assert.equal(legacy.calls.length, 1);
  const feedback = fixture({ maxPluginContextTokensPerTurn: 120, reviewContextReserveTokens: 120 });
  await feedback.stop(AbortSignal.abort());
  assert.equal(feedback.calls.length, 1);
  assert.equal(feedback.agent.steered.length, 1);
  assert.match(feedback.agent.steered[0].content[0].text, /correctness 8\/10/);
  assert.ok(feedback.agent.steered[0].content[0].text.length <= 480);
  const concurrent = fixture({ maxPluginContextTokensPerTurn: 1000 });
  await Promise.all(Array.from({ length: 8 }, () => concurrent.stop()));
  assert.equal(concurrent.calls.length, 1);
  const ctrl = new AbortController();
  const cancelled = fixture({ reviewMode: 'telemetry' }, async ({ signal }) => {
    ctrl.abort();
    assert.equal(signal.aborted, true);
    throw signal.reason;
  });
  await cancelled.stop(ctrl.signal);
  assert.equal(cancelled.calls.length, 1);
  assert.equal(cancelled.agent.steered.length, 0);
  const ignored = new AbortController();
  const late = fixture({}, async () => {
    ignored.abort();
    return { content: [{ type: 'text', text: '{}' }] };
  });
  await late.stop(ignored.signal);
  assert.equal(late.calls.length, 1);
  assert.equal(late.agent.steered.length, 0);
  const timeout = fixture({ reviewMode: 'telemetry', reviewTimeoutMs: 20 }, async ({ signal }) => {
    await new Promise((resolve) => { const timer = setTimeout(resolve, 200);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    assert.equal(signal.aborted, true);
    throw signal.reason;
  });
  await timeout.stop();
  const realFetch = globalThis.fetch;
  try {
    let networkCalls = 0;
    globalThis.fetch = async (_url, { signal, body }) => {
      networkCalls++;
      assert.equal(signal.aborted, false);
      const questions = JSON.parse(body).questions;
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((id) =>
        [id, { type: 'noul', noul: id === 'needs_execution' ? 0 : 1 }])), usage: {} }), { status: 200 });
    };
    const completion = fixture({ enableQualityReview: false, enableCompletionCheck: true });
    await completion.stop(AbortSignal.abort());
    assert.equal(networkCalls, 1);
    const cancelling = new AbortController();
    globalThis.fetch = async (_url, { signal }) => {
      networkCalls++;
      cancelling.abort();
      assert.equal(signal.aborted, true);
      throw signal.reason;
    };
    const live = fixture({ enableQualityReview: false, enableCompletionCheck: true });
    await live.stop(cancelling.signal);
    assert.equal(networkCalls, 2);
    assert.equal(live.agent.steered.length, 0);
  } finally { globalThis.fetch = realFetch; }
  let diffAttempts = 0;
  const failedDiff = fixture({ maxPluginContextTokensPerTurn: 120 }, undefined, async () => {
    diffAttempts++;
    throw new Error('diff unavailable');
  });
  await failedDiff.stop();
  await failedDiff.stop();
  assert.equal(diffAttempts, 2);
  assert.equal(failedDiff.calls.length, 0);
  console.log('cost-governor: all checks passed');
} finally {
  // Recorder writes are queued; let them settle before removing temporary logs.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
