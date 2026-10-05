import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createHostResolver } from './host-resolver.mjs';
import { pathToFileURL } from 'node:url';

// Real host services; only external Jev/model responses and the UI answerer are fixtures.
const strict = process.argv.includes('--strict') || process.env.DSH_COMPAT_STRICT === '1';
const supported = '0.2.0-rc.2';
function hostPackage() {
  if (process.env.DSH_HOST_PACKAGE) return resolve(process.env.DSH_HOST_PACKAGE);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh');
    if (existsSync(bin)) {
      const pkg = join(dirname(dirname(realpathSync(bin))), 'package.json');
      if (existsSync(pkg)) return pkg;
    }
  }
  return join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
}
let pkg;
try {
  pkg = hostPackage();
  const metadata = JSON.parse(readFileSync(pkg, 'utf8'));
  assert.equal(metadata.name, '@deepseek-ai/dsh');
  if (!process.env.DSH_COMPAT_MASTER) assert.equal(metadata.version, process.env.DSH_EXPECT_VERSION ?? supported);
  console.log(`DSH COMPAT host=${metadata.name}@${metadata.version} entry=${join(dirname(pkg), metadata.bin.dsh)}`);
} catch (error) {
  console.log(`DSH COMPAT ${strict ? 'FAIL' : 'SKIP'}: ${error.message}`);
  process.exit(strict ? 1 : 0);
}
let phase = 'host imports';
process.on('uncaughtExceptionMonitor', (error) => {
  console.error(`DSH COMPAT FAIL phase=${phase}: ${error.message}`);
});
// A discovered host's workspace/resolver failure is never a local SKIP.
phase = 'workspace package discovery';
const resolveHost = createHostResolver(pkg, Boolean(process.env.DSH_COMPAT_MASTER));
const load = async (name) => {
  phase = `resolve @deepseek-ai/${name}`;
  const entry = resolveHost(name);
  phase = `import @deepseek-ai/${name}`;
  return import(pathToFileURL(entry).href);
};
// A present supported host with broken imports is a failure, never a skip.
const { Context } = await load('cordis');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolRuntime } = await load('dsh-tools');
const { LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm');
const { AgentRegistry, agentEvents } = await load('dsh-agent');
const { AgentLoop } = await load('dsh-agent-loop');
const { SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { UserQuestionService } = await load('dsh-user-questions');
const { apply } = await import('../lib/index.mjs');
const root = mkdtempSync(join(tmpdir(), 'jev-dsh-compat-'));
phase = 'construct Context and host services';
const ctx = new Context();
new SystemPrompt(ctx, {});
new ToolRuntime(ctx);
new LlmRuntime(ctx);
new SessionStore(ctx);
new SessionProjectionRegistry(ctx);
new AgentRegistry(ctx);
new UserQuestionService(ctx);
new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 2 });
ctx.provide('credentials', { resolve: async () => ({ value: 'compat-fixture-key' }) });
const requests = [];
const errors = [];
let generation = 0;
class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: {
      default: 'medium', efforts: ['low', 'medium', 'high'].map((id) => ({ id, name: id })),
    } };
  }
  async *stream(options) {
    requests.push(options);
    generation += 1;
    const block = { type: 'text', text: `compat generation ${generation}` };
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: block.text };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
ctx.llm.registerAdapter(['compat'], new ScriptedAdapter());
ctx.on('agent/error', ({ error }) => errors.push(error));
let stopping = 0;
ctx.on('agent/turn-stopping', ({ signal }) => {
  assert.equal(signal.aborted, false, 'host stopping boundary must still be live');
  stopping += 1;
});
const output = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => value };
let bodyCalls = 0;
ctx.tools.register({
  output,
  name: 'bash', description: 'Non-executing command fixture; never invokes a shell.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async () => { bodyCalls += 1; return { content: [{ type: 'text', text: 'fixture body' }] }; },
});
let reviewCalls = 0;
ctx.tools.register({
  output,
  name: 'mcp__jev-review__jev_review', description: 'Review transport fixture.',
  parameters: { type: 'object', properties: {
    task: { type: 'string' }, diff: { type: 'string' }, repositoryContext: { type: 'string' },
  }, required: ['task', 'diff', 'repositoryContext'] },
  execute: async (args) => {
    assert.match(args.diff, /compat/);
    reviewCalls += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ metrics: {
      correctness: { applicable: true, score: 8 },
    } }) }] };
  },
});
// Workspace evidence fixture is explicit; execution/validation remains the real ToolRuntime.
ctx.provide('workspaceChanges', {
  summary: () => ({ cwd: root, total: 1, added: 10, deleted: 0, files: [{ path: 'compat.js' }] }),
  diff: async () => ({ kind: 'text', path: 'compat.js', hunks: [{ oldStart: 1, oldLines: 0,
    newStart: 1, newLines: 1, lines: ['+const compat = true;'] }] }),
});
const nativeFetch = globalThis.fetch;
let completions = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
  const body = JSON.parse(init.body);
  if (body.questions.complete) completions += 1;
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
    if (q.type === 'noul') return [id, { type: 'noul', noul:
      id === 'destructive' || id === 'needs_execution' ? 1 : completions === 1 ? 0 : 1 }];
    const choice = Object.hasOwn(q.criteria, 'low') ? 'low' : Object.keys(q.criteria)[0];
    return [id, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
  }));
  return new Response(JSON.stringify({ model: 'jev-fixture', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
};
try {
  phase = 'plugin apply';
  apply(ctx, { logDir: root, enableSpawnHint: false, enableContextTriage: false,
    enableJevgrepEscalation: false, enableFailureRecovery: false,
    enableQualityReview: true, reviewMinChangedLines: 1, reviewReportToAgent: false });
  phase = 'AgentLoop.create / completion continuation / effort resolution';
  const agent = await ctx.agentLoop.create('compat-session', { provider: 'compat', model: 'scripted' }, { cwd: root });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the compatibility task and its actual executed evidence.' }], source: { kind: 'user' } }));
  let timer;
  try {
    await Promise.race([agent.whenIdle(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('real agent loop timeout')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(errors, []);
  assert.equal(generation, 2, 'completion continuation must re-enter the real agent loop');
  assert.equal(completions, 2);
  assert.equal(stopping, 2);
  assert(requests.every((request) => request.reasoningEffort === 'low'));
  assert.equal((await ctx.llm.resolveCallConfig({ provider: 'compat', model: 'scripted', reasoningEffort: 'high' })).reasoningEffort, 'high');
  console.log('PASS boot / completion continuation / real agent hooks / effort resolution');

  phase = 'UserQuestionService consent / ToolRuntime monotonic guard';
  let approve = false;
  let questions = 0;
  ctx.on('user-questions/request', (request) => {
    questions += 1;
    assert.equal(request.questions[0].intent.approve, 'Run it');
    return { answers: [{ id: request.questions[0].id, selected: [approve ? 'Run it' : 'Do not run it'] }] };
  });
  const execute = (command) => ctx.tools.execute({ name: 'bash', callId: `compat-${questions}`,
    arguments: { command }, agent, signal: new AbortController().signal });
  assert.equal((await execute('rm -rf /tmp/compat-consent')).isError, true);
  assert.equal(bodyCalls, 0);
  approve = true;
  assert.notEqual((await execute('rm -rf /tmp/compat-consent')).isError, true);
  assert.equal(bodyCalls, 1);
  // Downstream allow must not erase the monotonic catastrophic guard.
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  assert.equal((await execute('rm -rf /')).isError, true);
  assert.equal(bodyCalls, 1);
  assert.equal(questions, 2);
  console.log('PASS real consent service / monotonic guard (no shell commands executed)');

  phase = 'quality review through tools.execute';
  agent.session.append('workspace/changes', { turn: 3, cwd: root });
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 3, signal: new AbortController().signal });
  assert.equal(reviewCalls, 1, 'quality hook must execute through real host tool validation');
  console.log('PASS quality review hook / real tools.execute; review response and workspace evidence are fixtures');
} finally {
  globalThis.fetch = nativeFetch;
  await ctx.fiber.dispose();
  console.log(`DSH COMPAT artifacts=${root}; external Jev/model/UI responses are deterministic fixtures, not trajectory A/B`);
}
