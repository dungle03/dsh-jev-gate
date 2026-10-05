import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ARMS } from './trajectory-matrix.mjs';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = 'The navigation marker is TRAJECTORY_OK_731.\n';
const task = 'Read marker.txt using a file tool. Reply with exactly its navigation marker. Do not modify files or run shell commands.';
const hash = (text) => createHash('sha256').update(text).digest('hex');
export function summarize(events, decisions, { arm, seed, model, elapsed, exitCode, unchanged }) {
  const calls = events.filter((e) => e.type === 'tool_call');
  const ends = events.filter((e) => e.type === 'status' && e.phase === 'step_end');
  const sumUsage = (key) => ends.length && ends.every((e) => Number.isFinite(e.usage?.[key]))
    ? ends.reduce((n, e) => n + e.usage[key], 0) : null;
  const final = events.filter((e) => e.type === 'final').at(-1);
  const readsMarker = (e) => e.tool === 'read' && typeof e.input?.file_path === 'string'
    && /(?:^|[\\/])marker\.txt$/.test(e.input.file_path);
  const targetRead = calls.findIndex(readsMarker);
  const readResult = targetRead >= 0 && typeof calls[targetRead].callId === 'string'
    && calls[targetRead].callId.length > 0 && events.some((e) => e.type === 'tool_result'
      && e.callId === calls[targetRead].callId && e.status === 'completed'
      && typeof e.result === 'string' && e.result.includes('TRAJECTORY_OK_731'));
  const ok = exitCode === 0 && unchanged && readResult && final?.text?.trim() === 'TRAJECTORY_OK_731';
  const observed = arm === 'vanilla' || decisions.some((d) => d.type === 'boot');
  const count = (type) => observed ? decisions.filter((d) => d.type === type).length : null;
  const elapsedFor = (type) => {
    const rows = decisions.filter((d) => d.type === type);
    return observed && rows.every((d) => Number.isFinite(d.ms)) ? rows.reduce((n, d) => n + d.ms, 0) : null;
  };
  const unique = new Set(calls.map((e) => JSON.stringify([e.tool, e.input])));
  const reads = calls.filter((e) => e.tool === 'read');
  return { task_id: 'navigation-marker-v1', seed, repo_state: hash(fixture), model, arm,
    source: 'real', split: 'validation', task_class: 'repository-navigation',
    success: Boolean(ok), task_success: Boolean(ok), tests_passed: ok ? 1 : 0, tests_total: 1,
    task_quality: null, walltime_ms: elapsed, wall_time_ms: elapsed,
    llm_calls: ends.length, generations: ends.length, main_llm_generations: ends.length,
    input_tokens: sumUsage('inputTokens'), output_tokens: sumUsage('outputTokens'),
    main_llm_input_tokens: sumUsage('inputTokens'), main_llm_output_tokens: sumUsage('outputTokens'),
    reasoning_tokens: sumUsage('reasoningTokens'), cache_read_tokens: sumUsage('cacheReadTokens'),
    tool_calls: calls.length, failed_tool_calls: events.filter((e) => e.type === 'tool_result' && e.status === 'error').length,
    repeated_tool_calls: calls.length - unique.size,
    search_calls: calls.filter((e) => ['grep', 'glob'].includes(e.tool)).length,
    searches_before_target_read: targetRead >= 0 ? calls.slice(0, targetRead).filter((e) => ['grep', 'glob'].includes(e.tool)).length : null,
    unnecessary_file_reads: reads.filter((e) => !readsMarker(e)).length,
    target_in_top_n: null,
    jev_calls: count('jev_ok'), jev_direct_calls: count('jev_ok'), jev_latency_ms: elapsedFor('jev_ok'),
    review_count: observed ? decisions.filter((d) => d.type === 'quality_review' && d.decision === 'reviewed').length : null,
    review_time_ms: null, jevgrep_count: observed ? decisions.filter((d) => d.type === 'jevgrep_escalation' && d.decision === 'started_background').length : null,
    jevgrep_time_ms: null, context_injected_tokens: null, human_consent_prompts: null,
    false_allow: null, false_deny: null, retries: null, cost_usd: null,
    effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    resolved_effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    effortAbstain: arm === 'experimental', layer5: arm === 'experimental',
    measurement_notes: ['Validation pilot, not held-out promotion evidence.',
      'Seed identifies a replication; provider randomness is not seeded.',
      'Wall time includes CLI startup and shutdown.', 'Missing provider/plugin metrics remain null.'],
    target_read_observed: targetRead >= 0,
  };
}
export async function collect({ output, model = 'cbai/deepseek-v4.1-flash', baseURL = 'http://127.0.0.1:20128/v1', seed = 1, timeoutMs = 180_000 } = {}) {
  if (!output) throw new Error('Output JSONL path is required');
  if (!process.env.TRAJECTORY_MODEL_KEY) throw new Error('TRAJECTORY_MODEL_KEY is required for the explicit model route');
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Seed and timeout are invalid');
  const endpoint = new URL(baseURL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Model endpoint must be HTTP(S) without inline credentials');
  const root = await mkdtemp(join(tmpdir(), 'jev-trajectory-'));
  const records = [];
  // Rotate order across replications; a single pilot still cannot establish benefit.
  const rotation = Math.abs(Number(seed) || 0) % ARMS.length;
  const order = [...ARMS.slice(rotation), ...ARMS.slice(0, rotation)];
  for (const arm of order) {
    const artifacts = join(root, arm); const cwd = join(artifacts, 'workspace');
    await mkdir(cwd, { recursive: true }); await writeFile(join(cwd, 'marker.txt'), fixture);
    const logDir = join(artifacts, 'decisions');
    const patch = [
      { id: 'bili-native', disabled: true }, { id: 'otel', disabled: true },
      { id: 'session-telemetry-otel', disabled: true }, { id: 'agent-instructions', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { 'trajectory-router': {
        displayName: 'Explicit trajectory route', apiKeyEnv: 'TRAJECTORY_MODEL_KEY', api: 'openai-completions', baseURL,
        models: [{ id: model, name: model, contextWindow: 1000000,
          reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
      } } } },
      { id: 'agent-default-model', config: { provider: 'trajectory-router', model, reasoningEffort: 'off' } },
      ...(arm === 'vanilla' ? [] : [{ insert: [{ id: 'jev-gate', name: join(plugin, 'lib/index.mjs'),
        config: { profile: arm, logDir, reviewMode: 'telemetry', jevGrepTimeoutMs: 30_000 } }] }]),
    ];
    const patchFile = join(artifacts, 'patch.json'); await writeFile(patchFile, JSON.stringify(patch));
    const events = []; let stderr = ''; let parseErrors = 0;
    const started = performance.now();
    const result = await new Promise((done, reject) => {
      const child = spawn('dsh', ['--profile', 'headless', '--patch', patchFile, '--json', task], {
        cwd, env: { ...process.env, DSH_TELEMETRY_MODE: 'OFF', DSH_PERMISSION_MODE: 'read-only' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let pending = ''; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        pending += chunk; const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) if (line.trim()) { try { events.push(JSON.parse(line)); } catch { parseErrors += 1; } }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { parseErrors += 1; } } done({ code, timedOut }); });
    });
    let decisions = [];
    try { decisions = (await readFile(join(logDir, 'decisions.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const unchanged = await readFile(join(cwd, 'marker.txt'), 'utf8') === fixture;
    const row = summarize(events, decisions, { arm, seed, model: `trajectory-router/${model}`, elapsed: Math.round(performance.now() - started), exitCode: result.code, unchanged });
    row.exit_code = result.code; row.timed_out = result.timedOut; row.parse_errors = parseErrors;
    if (parseErrors || result.timedOut) { row.success = false; row.task_success = false; row.tests_passed = 0; }
    row.run_order = order;
    row.artifact_directory = artifacts;
    await writeFile(join(artifacts, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // Persist diagnostic logs locally, never environment variables or API credentials.
    for (const secret of [process.env.TRAJECTORY_MODEL_KEY, process.env.TYPESAFE_API_KEY].filter(Boolean)) stderr = stderr.split(secret).join('[redacted]');
    await writeFile(join(artifacts, 'stderr.log'), stderr, { mode: 0o600 });
    await appendFile(resolve(output), JSON.stringify(row) + '\n'); records.push(row);
    console.log(JSON.stringify({ arm, success: row.success, generations: row.generations, walltime_ms: row.walltime_ms, artifact_directory: artifacts }));
  }
  return records;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output || process.argv.length > 3) { console.error('Usage: node tools/collect-trajectory.mjs OUTPUT.jsonl'); process.exitCode = 1; }
  else try { const records = await collect({ output, model: process.env.TRAJECTORY_MODEL, baseURL: process.env.TRAJECTORY_BASE_URL }); if (records.some((r) => !r.success)) process.exitCode = 1; }
  catch (error) { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; }
}
