/**
 * Collector cho trajectory benchmark — chạy THẬT 4 arm trên một task fixture,
 * ghi mỗi lần chạy thành một row có schema version rõ ràng.
 *
 * Ba bất biến correctness (lý do file này tồn tại):
 *   1. BỐN ARM LÀ A/B THẬT. `safe`/`balanced`/`experimental` đều phụ thuộc Jev;
 *      thiếu `TYPESAFE_API_KEY` sẽ khiến các lớp Jev fail-open và collector vẫn
 *      sinh record — biến "vanilla vs profile" thành "vanilla vs profile mất
 *      backend". Vì vậy normal collection KIỂM TRA CẢ HAI credential TRƯỚC khi
 *      chạy arm nào, và KHÔNG sinh partial record khi thiếu.
 *   2. MỖI ROW GHI CAPABILITY THẬT. Tên arm KHÔNG phải bằng chứng capability đã
 *      có; `available`/`invoked` suy từ decisions.jsonl + preflight thật.
 *   3. GHÉP CẶP CHỈ KHI CÙNG MÔI TRƯỜNG. Identity gồm dsh_version,
 *      plugin_version và benchmark_config_hash, nên row khác runtime/config
 *      không bị ghép nhầm.
 *
 * Benchmark hành vi khi Jev outage là MODE RIÊNG (`--jev-outage`), không trộn
 * với normal performance benchmark: row outage mang `mode: 'jev-outage'` và bị
 * promotion từ chối.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aggregateOperations, ARMS, benchmarkConfigHash, benchmarkRelevant, deriveCapabilities,
  executableAvailable, profileConfigHash, ROW_SCHEMA, sha256 } from './trajectory-schema.mjs';
import { fixtureHash, taskById, TASKS } from './trajectory-tasks.mjs';

/**
 * Đường dẫn manifest đi kèm file JSONL. Manifest cho biết lần chạy đã hoàn tất
 * hay chưa: row được ghi dần nên một tiến trình bị giết giữa chừng để lại file
 * JSONL THIẾU row mà nhìn bề ngoài không khác gì file đầy đủ. Consumer phải đọc
 * manifest để không phân tích nhầm một lần chạy dở thành bằng chứng hoàn chỉnh.
 */
export function manifestPathFor(output) {
  return `${resolve(output)}.manifest.json`;
}

/** Ghi manifest (incomplete lúc bắt đầu, complete lúc kết thúc). */
async function writeManifest(output, fields) {
  await writeFile(manifestPathFor(output), `${JSON.stringify(fields, null, 2)}\n`);
}

/** Đọc manifest; `null` nếu chưa có. THUẦN đọc, không ném khi file thiếu. */
export async function readManifest(output) {
  try { return JSON.parse(await readFile(manifestPathFor(output), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version;
const DEFAULT_TASK = 'navigation-marker-v1';

/** Nguồn credential cho từng mode. Outage mode CHỦ Ý bỏ trống TYPESAFE. */
export function credentialRequirements(mode = 'normal') {
  return mode === 'jev-outage' ? ['TRAJECTORY_MODEL_KEY'] : ['TRAJECTORY_MODEL_KEY', 'TYPESAFE_API_KEY'];
}

/**
 * Kiểm tra credential TRƯỚC khi chạy bất kỳ arm nào. Ném lỗi nêu rõ credential
 * nào thiếu; KHÔNG âm thầm hạ cấp sang fallback.
 */
export function assertCredentials(mode = 'normal', env = process.env) {
  const missing = credentialRequirements(mode).filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required for `
      + `${mode === 'jev-outage' ? 'Jev-outage' : 'four-arm'} trajectory collection`);
  }
}

/**
 * Đọc version DSH thật từ CLI; `null` nếu không chạy được (không đoán).
 *
 * `run` tiêm được để test offline chạy được trên máy KHÔNG cài `dsh` toàn cục.
 */
export function dshVersion(env = process.env, run = spawnSync) {
  const result = run('dsh', ['--version'], { encoding: 'utf8', timeout: 30_000, env });
  const text = result?.stdout?.trim();
  return text && result.status === 0 ? text.split('\n')[0].trim() : null;
}

/**
 * Preflight THẬT cho hạ tầng ngoài: executable `jg` và review tool trong composition.
 *
 * `review_tool` có BA trạng thái: `true`/`false` khi kiểm được composition,
 * `null` khi KHÔNG kiểm được (không có `dsh`). "Chưa kiểm" khác "không có" —
 * gộp chúng lại sẽ biến thiếu bằng chứng thành bằng chứng tiêu cực.
 */
export function preflightCapabilities({ env = process.env, reviewServerName = 'jev-review', dump = spawnSync } = {}) {
  let reviewTool = null;
  const out = dump('dsh', ['--profile', 'headless', '--dump-config'],
    { encoding: 'utf8', timeout: 60_000, env });
  if (out?.status === 0) reviewTool = String(out.stdout).includes(reviewServerName);
  return {
    executables: { jg: executableAvailable('jg', env) },
    review_tool: reviewTool,
    credentials: { model: Boolean(env.TRAJECTORY_MODEL_KEY), typesafe: Boolean(env.TYPESAFE_API_KEY) },
  };
}

/**
 * Rút gọn MỘT lần chạy thành row. THUẦN: mọi thứ vào qua tham số, không I/O.
 *
 * `events` là JSONL stdout của `dsh --json`; `decisions` là decisions.jsonl của
 * plugin. `evaluation` là kết quả evaluator tất định của task.
 */
export function summarize(events, decisions, options) {
  const {
    task, arm, seed, model, elapsed, exitCode, unchanged, mode = 'normal',
    dsh_version: dshVersionValue = null, plugin_version: pluginVersion = PACKAGE_VERSION,
    preflight = {}, evaluation = {},
  } = options;
  const calls = events.filter((e) => e.type === 'tool_call');
  const ends = events.filter((e) => e.type === 'status' && e.phase === 'step_end');
  const sumUsage = (key) => ends.length && ends.every((e) => Number.isFinite(e.usage?.[key]))
    ? ends.reduce((n, e) => n + e.usage[key], 0) : null;
  const observed = arm === 'vanilla' || decisions.some((d) => d.type === 'boot');
  const bootConfig = decisions.find((d) => d.type === 'boot')?.config ?? null;
  const count = (type) => observed ? decisions.filter((d) => d.type === type).length : null;
  const elapsedFor = (type) => {
    const rows = decisions.filter((d) => d.type === type);
    return observed && rows.length && rows.every((d) => Number.isFinite(d.ms))
      ? rows.reduce((n, d) => n + d.ms, 0) : null;
  };
  const unique = new Set(calls.map((e) => JSON.stringify([e.tool, e.input])));
  const operations = aggregateOperations(decisions);
  const jevOk = observed ? decisions.filter((d) => d.type === 'jev_ok').length : null;
  const jevErrors = observed ? decisions.filter((d) => d.type === 'jev_error') : [];
  const config = observed && bootConfig ? bootConfig : null;
  const profileConfig = config ? benchmarkRelevant(config) : null;
  const success = Boolean(evaluation.success) && !(options.parseErrors > 0) && !options.timedOut;
  const taskClass = task.task_class;
  return {
    schema: ROW_SCHEMA,
    // ---- identity ghép cặp (thiếu bất kỳ trường nào ⇒ row bị matrix từ chối) ----
    task_id: task.id,
    task_class: taskClass,
    task_prompt_hash: sha256(task.prompt),
    seed,
    repo_state: fixtureHash(task),
    model,
    dsh_version: dshVersionValue,
    plugin_version: pluginVersion,
    benchmark_config_hash: benchmarkConfigHash({
      task_id: task.id, task_class: taskClass, task_prompt_hash: sha256(task.prompt), model,
      dsh_version: dshVersionValue, plugin_version: pluginVersion,
      evaluator: task.id, permission_mode: task.permission_mode, timeout_ms: options.timeoutMs ?? null,
    }),
    // ---- treatment ----
    arm,
    mode,
    profile: config?.profile ?? null,
    profile_config: profileConfig,
    profile_config_hash: profileConfigHash(config),
    // ---- capability manifest THẬT ----
    capabilities: deriveCapabilities({ arm, config, decisions, preflight, operations }),
    // ---- operation telemetry (từ cost_governor, không suy từ jev_ok) ----
    operations,
    // ---- kết quả tất định ----
    source: 'real',
    split: mode === 'jev-outage' ? 'outage' : 'validation',
    permission_mode: task.permission_mode,
    safety_labels: [...task.safety_labels],
    expected_side_effects: [...task.expected_side_effects],
    success,
    task_success: success,
    tests_passed: Number.isFinite(evaluation.tests_passed) ? evaluation.tests_passed : 0,
    tests_total: Number.isFinite(evaluation.tests_total) ? evaluation.tests_total : 1,
    false_allow: evaluation.false_allow ?? null,
    false_deny: evaluation.false_deny ?? null,
    evaluation_detail: evaluation.detail ?? null,
    // ---- đo lường ----
    task_quality: null,
    walltime_ms: elapsed,
    wall_time_ms: elapsed,
    llm_calls: ends.length,
    generations: ends.length,
    main_llm_generations: ends.length,
    input_tokens: sumUsage('inputTokens'),
    output_tokens: sumUsage('outputTokens'),
    main_llm_input_tokens: sumUsage('inputTokens'),
    main_llm_output_tokens: sumUsage('outputTokens'),
    reasoning_tokens: sumUsage('reasoningTokens'),
    cache_read_tokens: sumUsage('cacheReadTokens'),
    tool_calls: calls.length,
    failed_tool_calls: events.filter((e) => e.type === 'tool_result' && e.status === 'error').length,
    repeated_tool_calls: calls.length - unique.size,
    search_calls: calls.filter((e) => ['grep', 'glob'].includes(e.tool)).length,
    searches_before_target_read: evaluation.searches_before_target_read ?? null,
    unnecessary_file_reads: evaluation.unnecessary_file_reads ?? null,
    target_in_top_n: null,
    // ---- Jev: tách logical / success / fail / http attempt (KHÔNG suy từ jev_ok) ----
    jev_calls: jevOk,
    jev_logical_operations: observed ? operations.jev.operations : null,
    jev_successful_operations: observed ? operations.jev.successful_operations : null,
    jev_failed_operations: observed ? operations.jev.failed_operations : null,
    jev_skipped_operations: observed ? operations.jev.skipped_operations : null,
    jev_http_attempts: observed ? operations.jev.actual_invocations : null,
    jev_direct_calls: jevOk,
    jev_error_count: observed ? jevErrors.length : null,
    jev_latency_ms: elapsedFor('jev_ok'),
    // ---- review / jevgrep ----
    review_count: observed ? decisions.filter((d) => d.type === 'quality_review' && d.decision === 'reviewed').length : null,
    review_time_ms: observed ? operations.review.actual_invocations : null,
    review_invocations: observed ? operations.review.actual_invocations : null,
    review_tool_invocations: observed ? operations.review.actual_invocations : null,
    review_reserved_units: observed ? operations.review.reserved_units : null,
    review_logical_operations: observed ? operations.review.operations : null,
    review_successful_operations: observed ? operations.review.successful_operations : null,
    review_failed_operations: observed ? operations.review.failed_operations : null,
    review_skipped_operations: observed ? operations.review.skipped_operations : null,
    jevgrep_count: observed ? decisions.filter((d) => d.type === 'jevgrep_escalation' && d.decision === 'started_background').length : null,
    jevgrep_process_spawns: observed ? operations.jevgrep.actual_invocations : null,
    jevgrep_reserved_units: observed ? operations.jevgrep.reserved_units : null,
    jevgrep_logical_operations: observed ? operations.jevgrep.operations : null,
    jevgrep_successful_operations: observed ? operations.jevgrep.successful_operations : null,
    jevgrep_failed_operations: observed ? operations.jevgrep.failed_operations : null,
    jevgrep_skipped_operations: observed ? operations.jevgrep.skipped_operations : null,
    jevgrep_time_ms: null,
    decision_reserved_units: observed ? operations.reserved_units : null,
    decision_actual_invocations: observed ? operations.actual_invocations : null,
    decision_operation_failures: observed ? operations.failures : null,
    decision_operation_cancellations: observed ? operations.cancellations : null,
    context_injected_tokens: null,
    human_consent_prompts: null,
    retries: null,
    cost_usd: null,
    effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    resolved_effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    effortAbstain: config?.effortAbstain === true,
    layer5: config?.enableSpawnHint === true && config?.enableContextTriage === true,
    target_read_observed: evaluation.target_read_observed ?? null,
    measurement_notes: [
      'Validation pilot, not held-out promotion evidence.',
      'Seed identifies a replication; provider randomness is not seeded.',
      'Wall time includes CLI startup and shutdown.',
      'Missing provider/plugin metrics remain null, never 0.',
      'Capability state comes from runtime decisions and preflight, never from the arm name.',
      'jev_calls is legacy: it counts jev_ok records (successful logical operations), NOT HTTP attempts.',
      'Actual invocation counts come from cost_governor operation telemetry (jev_http_attempts, '
        + 'review_tool_invocations, jevgrep_process_spawns), because one logical call can retry.',
    ],
  };
}

/** Dựng patch DSH cho một arm (thuần, tách khỏi vòng chạy để kiểm được). */
export function buildPatch({ arm, model, baseURL, logDir, task }) {
  return [
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
}

/** Chạy một arm trên một task; trả row đã hoàn chỉnh (chưa ghi file). */
async function runArm({ task, arm, root, model, baseURL, seed, timeoutMs, mode, preflight, dshVersionValue }) {
  const artifacts = join(root, `${task.id}--${arm}`);
  const workspace = join(artifacts, 'workspace');
  await mkdir(workspace, { recursive: true });
  task.setup(workspace);
  const logDir = join(artifacts, 'decisions');
  const patchFile = join(artifacts, 'patch.json');
  await writeFile(patchFile, JSON.stringify(buildPatch({ arm, model, baseURL, logDir, task })));
  const events = []; let stderr = ''; let parseErrors = 0;
  const started = performance.now();
  const result = await new Promise((done, reject) => {
    const child = spawn('dsh', ['--profile', 'headless', '--patch', patchFile, '--json', task.prompt], {
      cwd: workspace,
      env: { ...process.env, DSH_TELEMETRY_MODE: 'OFF', DSH_PERMISSION_MODE: task.permission_mode },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let pending = ''; let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      pending += chunk; const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) { try { events.push(JSON.parse(line)); } catch { parseErrors += 1; } }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { parseErrors += 1; } }
      done({ code, timedOut });
    });
  });
  let decisions = [];
  try {
    decisions = (await readFile(join(logDir, 'decisions.jsonl'), 'utf8')).trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const unchanged = !task.writes;
  const evaluation = await task.evaluate({ workspace, events, decisions,
    exitCode: result.code, unchanged, timedOut: result.timedOut });
  const row = summarize(events, decisions, { task, arm, seed, model: `trajectory-router/${model}`,
    elapsed: Math.round(performance.now() - started), exitCode: result.code, unchanged, mode,
    dsh_version: dshVersionValue, preflight, evaluation, parseErrors, timedOut: result.timedOut,
    timeoutMs });
  row.exit_code = result.code; row.timed_out = result.timedOut; row.parse_errors = parseErrors;
  row.artifact_directory = artifacts;
  await writeFile(join(artifacts, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Lưu log chẩn đoán cục bộ, KHÔNG bao giờ lưu biến môi trường hay credential.
  for (const secret of [process.env.TRAJECTORY_MODEL_KEY, process.env.TYPESAFE_API_KEY].filter(Boolean)) {
    stderr = stderr.split(secret).join('[redacted]');
  }
  await writeFile(join(artifacts, 'stderr.log'), stderr, { mode: 0o600 });
  return row;
}

/**
 * Thu thập trajectory. Ném NGAY nếu thiếu credential (trước khi tạo row nào).
 *
 * @param {object} options
 * @param {string} options.output - đường dẫn JSONL
 * @param {'normal'|'jev-outage'} [options.mode]
 * @param {string} [options.taskId]
 * @param {string[]} [options.arms] - mặc định đủ 4 arm (normal) hoặc 2 arm (outage)
 */
export async function collect({ output, model = 'cbai/deepseek-v4.1-flash', baseURL = 'http://127.0.0.1:20128/v1',
  seed = 1, seeds, timeoutMs = 180_000, mode = 'normal', taskId = DEFAULT_TASK, taskIds, arms } = {}) {
  if (!output) throw new Error('Output JSONL path is required');
  assertCredentials(mode);
  const seedList = seeds === undefined ? [seed] : seeds;
  if (!Array.isArray(seedList) || seedList.length === 0
    || !seedList.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Seed(s) must be non-negative integers');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be a positive number');
  let endpoint;
  try { endpoint = new URL(baseURL); }
  catch { throw new Error(`Model endpoint must be a valid HTTP(S) URL: ${JSON.stringify(baseURL)}`); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Model endpoint must be HTTP(S) without inline credentials');
  }
  // Catalog: chạy được NHIỀU task trong một lần gọi (không chỉ một task cứng).
  const taskIdList = taskIds === undefined ? [taskId] : taskIds;
  if (!Array.isArray(taskIdList) || taskIdList.length === 0) throw new Error('At least one task is required');
  const tasks = taskIdList.map((id) => taskById(id));
  const selected = arms ?? (mode === 'jev-outage' ? ['vanilla', 'safe'] : [...ARMS]);
  for (const arm of selected) if (!ARMS.includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  const dshVersionValue = dshVersion();
  if (!dshVersionValue) throw new Error('Unable to determine the DSH version; refusing to record an unidentifiable environment');
  const preflight = preflightCapabilities();
  const root = await mkdtemp(join(tmpdir(), 'jev-trajectory-'));
  const records = [];
  const expected = tasks.length * seedList.length * selected.length;
  // Manifest `incomplete` được ghi TRƯỚC khi chạy; chỉ chuyển `complete` khi mọi
  // row đã ghi xong. Nếu tiến trình bị giết giữa chừng, manifest vẫn là
  // `incomplete` và consumer biết file JSONL không đầy đủ.
  await writeManifest(output, { status: 'incomplete', expected_rows: expected, written_rows: 0,
    mode, seeds: seedList, tasks: tasks.map((task) => task.id), arms: [...selected] });
  for (const task of tasks) {
    for (const currentSeed of seedList) {
      // Xoay thứ tự giữa các replication; một pilot đơn lẻ vẫn không thể chứng minh lợi ích.
      const rotation = Math.abs(Number(currentSeed) || 0) % selected.length;
      const order = [...selected.slice(rotation), ...selected.slice(0, rotation)];
      for (const arm of order) {
        const row = await runArm({ task, arm, root, model, baseURL, seed: currentSeed, timeoutMs, mode,
          preflight, dshVersionValue });
        row.run_order = order;
        await appendFile(resolve(output), JSON.stringify(row) + '\n');
        records.push(row);
        console.log(JSON.stringify({ arm, task_id: task.id, seed: currentSeed, success: row.success,
          generations: row.generations, walltime_ms: row.walltime_ms, artifact_directory: row.artifact_directory }));
      }
    }
  }
  await writeManifest(output, { status: 'complete', expected_rows: expected, written_rows: records.length,
    mode, seeds: seedList, tasks: tasks.map((task) => task.id), arms: [...selected] });
  return records;
}

/**
 * Phân tích argv cho CLI collector. THUẦN, không I/O — để kiểm được offline.
 * Trả `{ output, mode, taskIds, seeds }` hoặc ném `Error` với thông báo rõ.
 * Flag cần giá trị mà thiếu giá trị là LỖI, không được âm thầm dùng mặc định.
 */
export function parseArgs(argv = []) {
  const args = [...argv];
  const takesValue = ['--tasks', '--seeds'];
  const known = new Set(['--jev-outage', ...takesValue]);
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (takesValue.includes(arg)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Flag ${arg} requires a value`);
      }
      values[arg] = next;
      i += 1;
    } else if (arg.startsWith('--')) {
      if (!known.has(arg)) throw new Error(`Unknown flag(s): ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error('Exactly one output path is required');
  const splitList = (raw) => (raw === undefined ? undefined
    : String(raw).split(',').map((part) => part.trim()).filter(Boolean));
  const rawSeeds = splitList(values['--seeds']);
  const seeds = rawSeeds?.map((part) => Number(part));
  if (seeds && (seeds.length === 0 || seeds.some((n) => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('Seeds must be non-negative integers');
  }
  return { output: positionals[0], mode: args.includes('--jev-outage') ? 'jev-outage' : 'normal',
    taskIds: splitList(values['--tasks']), seeds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const records = await collect({ output: parsed.output, model: process.env.TRAJECTORY_MODEL,
      baseURL: process.env.TRAJECTORY_BASE_URL, mode: parsed.mode,
      taskIds: parsed.taskIds ?? (process.env.TRAJECTORY_TASK ? [process.env.TRAJECTORY_TASK] : undefined),
      seeds: parsed.seeds });
    if (records.some((r) => !r.success)) process.exitCode = 1;
  } catch (error) {
    console.error(`Collection failed: ${error.message}`);
    console.error('Usage: node tools/collect-trajectory.mjs OUTPUT.jsonl [--jev-outage] [--tasks id,id] [--seeds 1,2]');
    process.exitCode = 1;
  }
}

export { TASKS };
