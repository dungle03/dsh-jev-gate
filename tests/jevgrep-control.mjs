import assert from 'node:assert/strict';
import { createJevgrepControl, keepBoundedHint, admitRepositoryHint } from '../lib/jevgrep-control.mjs';
import { runJevgrep, resetAvailabilityCache } from '../lib/jevgrep.mjs';
import { apply } from '../lib/index.mjs';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = (session = 'a', root = '/repo', query = 'task') => ({ session, root, query });
const control = createJevgrepControl();
const first = control.reserve(input());
assert.equal(control.reserve(input()).reason, 'skip_duplicate');
assert.equal(control.reserve(input('a', '/repo', 'new')).reason, 'skip_concurrency');
assert.equal(first.signal.aborted, true);
const second = control.reserve(input('b'));
assert.equal(control.reserve(input('c')).reason, 'skip_concurrency');
first.finish({ ok: false, cancelled: true });
first.finish({ ok: false });
const latest = control.reserve(input('a', '/repo', 'new'));
assert.ok(latest.signal);
latest.finish({ ok: true });
second.finish({ ok: true });
control.dispose();
assert.equal(control.reserve(input()).reason, 'skip_cancelled');

let clock = 0;
const breaker = createJevgrepControl({ now: () => clock });
for (let count = 0; count < 3; count++) breaker.reserve(input()).finish({ ok: false });
assert.equal(breaker.reserve(input()).reason, 'skip_breaker');
const isolated = breaker.reserve(input('a', '/other'));
isolated.finish({ ok: true });
const otherSession = breaker.reserve(input('b'));
otherSession.finish({ ok: true });
clock = 60_000;
const probe = breaker.reserve(input());
assert.ok(probe.signal);
assert.equal(breaker.reserve(input()).reason, 'skip_duplicate');
probe.finish({ ok: false });
assert.equal(breaker.reserve(input()).reason, 'skip_breaker');
clock += 60_000;
breaker.reserve(input()).finish({ ok: true });
breaker.reserve(input()).finish({ ok: false, cancelled: true });
breaker.reserve(input()).finish({ ok: true });
breaker.dispose();

const disabled = createJevgrepControl({ failureThreshold: 0 });
for (let count = 0; count < 10; count++) disabled.reserve(input()).finish({ ok: false });
const active = disabled.reserve(input());
disabled.dispose();
assert.equal(active.signal.aborted, true);
active.finish({ ok: false, cancelled: true });
const zero = createJevgrepControl({ maxPending: 0 });
assert.equal(zero.reserve(input()).reason, 'skip_pending_cap');
zero.dispose();

const hints = new Map();
for (let count = 0; count < 100; count++) keepBoundedHint(hints, String(count), 'done', 20);
assert.equal(hints.size, 20);
assert.equal(hints.has('0'), false);
const wrap = (text) => `<repository-evidence>\n${text}\n</repository-evidence>`;
const admit = (_agent, _turn, items) => ({ kept: items });
assert.equal(admitRepositoryHint(admit, wrap, {}, 1, 'text'), wrap('text'));
assert.equal(admitRepositoryHint((_a, _t, items) => ({ kept: [{ ...items[0], truncated: true }] }), wrap, {}, 1, 'text'), undefined);
assert.equal(admitRepositoryHint((_a, _t, items) => ({ kept: [{ ...items[0], text: items[0].text.slice(0, -4) }] }), wrap, {}, 1, 'text'), undefined);
assert.equal(admitRepositoryHint(() => ({ kept: [] }), wrap, {}, 1, 'text'), undefined);
const aborted = new AbortController();
aborted.abort();
assert.deepEqual(await runJevgrep({ question: 'task', signal: aborted.signal }), { ok: false, error: 'aborted', cancelled: true });
const sandbox = await mkdtemp(join(tmpdir(), 'jevgrep-control-'));
const savedPath = process.env.PATH;
try {
  const executable = join(sandbox, 'jg');
  await writeFile(executable, `#!${process.execPath}\nimport('node:fs').then(({writeFileSync}) => {\nconst query=process.argv[3];\nif(query==='hang') { writeFileSync(process.argv[4], String(process.pid)); setInterval(()=>{},1000); }\nelse if(query==='overflow') { process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000); }\nelse { process.stdout.write('source evidence'); process.exitCode=query==='incomplete'?2:query==='cancel'?130:0; }\n});\n`);
  await chmod(executable, 0o755);
  process.env.PATH = `${sandbox}:${savedPath ?? ''}`;
  assert.equal((await runJevgrep({ question: 'incomplete' })).incomplete, true);
  assert.equal((await runJevgrep({ question: 'cancel' })).cancelled, true);
  assert.equal((await runJevgrep({ question: 'overflow', maxBuffer: 1000 })).error, 'output too large');
  const pidFile = join(sandbox, 'pid');
  const timed = await runJevgrep({ question: 'hang', root: pidFile, timeoutMs: 500 });
  assert.equal(timed.error, 'timeout after 500ms');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const cancel = new AbortController();
  const running = runJevgrep({ question: 'hang', root: pidFile, signal: cancel.signal });
  cancel.abort();
  assert.equal((await running).cancelled, true);

  const spawnLog = join(sandbox, 'spawns');
  await writeFile(executable, `#!${process.execPath}\nimport('node:fs').then(({appendFileSync}) => {\nappendFileSync(${JSON.stringify(spawnLog)}, 'spawn\\n');\nprocess.stdout.write('Jevgrep: 1 relevant files.\\n- "auth.js" - implementation\\nSource block "auth.js" lines 1-1:\\n1: verifyToken();\\nEnd context.\\n');\n});\n`);
  resetAvailabilityCache();
  const handlers = {};
  const effects = [];
  const ctx = {
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    effect: (effect) => { effects.push(effect()); },
    logger: { info() {}, warn() {}, error() {} },
    credentials: { resolve: async () => undefined },
    get: () => undefined,
  };
  await apply(ctx, {
    logDir: sandbox,
    enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
    enableSpawnHint: false, enableContextTriage: false, enableFailureRecovery: false,
    enableQualityReview: false, enableJevgrepEscalation: true,
    jevGrepSearchTaskHeuristic: true, jevGrepBackground: false,
    maxDecisionCostPerSession: 8, maxDecisionCostPerTurn: 8,
    maxPluginContextTokensPerTurn: 500,
  });
  const agent = { id: 'layer8-cost-test', cwd: sandbox, session: { snapshotEvents: () => [] } };
  const request = (turn) => ({ agent, turn, step: 1, signal: new AbortController().signal,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'where is verifyToken handled' }] }] });
  const next = async () => ({ kind: 'enter' });
  const hooks = handlers['agent/pre-step'];
  await hooks[0](request(1), next);
  const admitted = await hooks.at(-1)(request(1), next);
  assert.match(admitted.messages[0].content[0].text, /<repository-evidence>/);
  assert.match(admitted.messages[0].content[0].text, /<\/repository-evidence>/);
  await hooks[0](request(2), next);
  const skipped = await hooks.at(-1)(request(2), next);
  assert.equal(skipped.messages, undefined);
  assert.equal((await readFile(spawnLog, 'utf8')).trim(), 'spawn');
  for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose();

  // A temporary global cap at the threshold must allow a later same-turn retry.
  const retryHandlers = {};
  const retryEffects = [];
  await apply({ ...ctx,
    on: (name, handler) => { (retryHandlers[name] ??= []).push(handler); },
    effect: (effect) => { retryEffects.push(effect()); },
  }, {
    logDir: sandbox,
    enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
    enableSpawnHint: false, enableContextTriage: false, enableFailureRecovery: false,
    enableQualityReview: false, enableJevgrepEscalation: true,
    jevGrepSearchTaskHeuristic: false, jevGrepBackground: false,
    jevGrepMaxConcurrentGlobal: 1, jevGrepSearchTaskThreshold: 3,
    maxDecisionCostPerSession: 16, maxDecisionCostPerTurn: 16,
    maxPluginContextTokensPerTurn: 500,
  });
  const busyControl = createJevgrepControl();
  const busy = busyControl.reserve(input('busy'));
  const retryAgent = { id: 'layer8-retry-test', cwd: sandbox, session: { snapshotEvents: () => [] } };
  const search = { name: 'bash', arguments: { command: 'rg verifyToken' }, agent: retryAgent,
    signal: new AbortController().signal };
  const post = retryHandlers['tools/post-execute'].at(-1);
  try {
    for (let count = 0; count < 3; count++) await post(search, {}, async () => ({}));
    assert.equal((await readFile(spawnLog, 'utf8')).trim().split('\n').length, 1);
    busy.finish({ ok: true });
    const retry = await post(search, {}, async () => ({}));
    assert.match(retry.additionalContexts[0].content[0].text, /<repository-evidence>/);
    await post(search, {}, async () => ({}));
    assert.equal((await readFile(spawnLog, 'utf8')).trim().split('\n').length, 2);
  } finally {
    busy.finish({ ok: true });
    busyControl.dispose();
    for (const dispose of retryEffects.reverse()) if (typeof dispose === 'function') dispose();
  }
} finally {
  process.env.PATH = savedPath;
  await rm(sandbox, { recursive: true, force: true });
}
console.log('jevgrep control regression: passed');
