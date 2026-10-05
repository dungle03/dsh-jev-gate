/**
 * Hợp đồng OFFLINE cho collector — chạy hàm THẬT, không mạng, không gọi Jev.
 *
 * Trọng tâm là các bất biến correctness đã từng sai:
 *   - thiếu credential ⇒ NÉM LỖI ngay, KHÔNG sinh record một phần;
 *   - outage mode là mode riêng, chỉ cần model key;
 *   - `jev_calls` KHÔNG được suy từ `jev_ok` khi có operation telemetry;
 *   - capability manifest phản ánh runtime thật, không suy từ tên arm;
 *   - identity ghép cặp đủ trường.
 */
import assert from 'node:assert/strict';
import { assertCredentials, collect, credentialRequirements, dshVersion, parseArgs, preflightCapabilities, summarize }
  from '../tools/collect-trajectory.mjs';
import { manifestWarning } from '../tools/trajectory-matrix.mjs';
import { aggregateOperations, deriveCapabilities, identityOf, validateRow, ROW_SCHEMA }
  from '../tools/trajectory-schema.mjs';
import { TASKS, taskById } from '../tools/trajectory-tasks.mjs';

// ---------------------------------------------------------------- credentials
// Normal four-arm collection phụ thuộc CẢ HAI credential: thiếu một cái là lỗi.
assert.deepEqual(credentialRequirements('normal'), ['TRAJECTORY_MODEL_KEY', 'TYPESAFE_API_KEY']);
assert.deepEqual(credentialRequirements('jev-outage'), ['TRAJECTORY_MODEL_KEY']);
assert.throws(() => assertCredentials('normal', {}), /TRAJECTORY_MODEL_KEY/);
assert.throws(() => assertCredentials('normal', { TRAJECTORY_MODEL_KEY: 'x' }), /TYPESAFE_API_KEY/);
assert.throws(() => assertCredentials('normal', { TYPESAFE_API_KEY: 'x' }), /TRAJECTORY_MODEL_KEY/);
// Cả hai có ⇒ đi qua, KHÔNG âm thầm hạ cấp.
assert.doesNotThrow(() => assertCredentials('normal', { TRAJECTORY_MODEL_KEY: 'x', TYPESAFE_API_KEY: 'y' }));
// Outage mode chỉ cần model key, nhưng vẫn phải có.
assert.doesNotThrow(() => assertCredentials('jev-outage', { TRAJECTORY_MODEL_KEY: 'x' }));
assert.throws(() => assertCredentials('jev-outage', {}), /TRAJECTORY_MODEL_KEY/);
// Thông báo lỗi nêu ĐÚNG credential thiếu, không nói chung chung.
assert.throws(() => assertCredentials('normal', { TRAJECTORY_MODEL_KEY: 'x' }),
  (error) => /TYPESAFE_API_KEY/.test(error.message) && !/TRAJECTORY_MODEL_KEY is/.test(error.message));

// ---------------------------------------------------------------- summarize
const task = taskById('navigation-marker-v1');
const events = [
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 1 } },
  { type: 'tool_call', callId: 'read-marker', tool: 'read', input: { file_path: 'marker.txt' } },
  { type: 'tool_result', callId: 'read-marker', status: 'completed', result: 'TRAJECTORY_OK_731' },
  { type: 'final', text: 'TRAJECTORY_OK_731' },
];
const decisions = [
  // Config safe THẬT: jevgrep tắt, review/completion bật — không suy từ tên arm.
  { type: 'boot', config: { profile: 'safe', enableJevgrepEscalation: false, enableQualityReview: true,
    enableCompletionCheck: true, effortAbstain: false } },
  { type: 'jev_ok', ms: 10, usage: { input_tokens: 5, output_tokens: 2 } },
  // Một logical operation retry 3 lần HTTP ⇒ actual_invocations 3, jev_ok chỉ 1.
  { type: 'cost_governor', category: 'direct', invocation_kind: 'http_request', operation_id: 'op-1',
    reserved_units: 1, actual_invocations: 0, completed: false, cancelled: false, failure: null, elapsed_ms: 1, decision: 'reserved_cost' },
  { type: 'cost_governor', category: 'direct', invocation_kind: 'http_request', operation_id: 'op-1',
    reserved_units: 1, actual_invocations: 3, completed: true, cancelled: false, failure: null, elapsed_ms: 30, decision: 'operation_finished' },
];
const evaluation = await task.evaluate({ workspace: '/nonexistent', events, exitCode: 0, unchanged: true });
const baseOptions = { task, arm: 'safe', seed: 1, model: 'fixture', elapsed: 1, exitCode: 0,
  unchanged: true, dsh_version: '0.2.0-rc.2', evaluation, preflight: {} };
const row = summarize(events, decisions, baseOptions);

assert.equal(row.schema, ROW_SCHEMA);
assert.equal(row.success, true);
assert.equal(row.task_success, true);
assert.equal(row.input_tokens, 10);
assert.equal(row.reasoning_tokens, null);
assert.equal(row.false_allow, null);
assert.equal(row.arm, 'safe');
assert.equal(row.mode, 'normal');
assert.equal(row.profile, 'safe');
// Capability THẬT: safe KHÔNG bật jevgrep, nên `configured: false` dù arm tên "safe".
assert.equal(row.capabilities.jevgrep.configured, false);
assert.equal(row.capabilities.jev.configured, true);
assert.equal(row.capabilities.jev.available, true);
assert.equal(row.capabilities.jev.invoked, true);
// Operation metric lấy từ telemetry, KHÔNG từ số `jev_ok`.
assert.equal(row.jev_calls, 1);
assert.equal(row.jev_logical_operations, 1);
assert.equal(row.jev_http_attempts, 3);
assert.equal(row.decision_actual_invocations, 3);
assert.equal(row.decision_reserved_units, 1);
// review/jevgrep tách logical/successful/failed y như jev (item 7), KHÔNG suy từ
// jev_ok: trong fixture này không có operation tool_execution/process_spawn nào.
assert.equal(row.review_logical_operations, 0);
assert.equal(row.review_successful_operations, 0);
assert.equal(row.review_failed_operations, 0);
assert.equal(row.review_tool_invocations, 0);
assert.equal(row.jevgrep_logical_operations, 0);
assert.equal(row.jevgrep_successful_operations, 0);
assert.equal(row.jevgrep_failed_operations, 0);
assert.equal(row.jevgrep_process_spawns, 0);
// Identity đủ trường ⇒ matrix ghép được.
assert.notEqual(identityOf(row), null);
assert.equal(validateRow(row).ok, true, validateRow(row).reasons.join(','));

// Vanilla KHÔNG khai profile/config (không được bịa config cho arm không plugin).
const vanilla = summarize(events, [], { ...baseOptions, arm: 'vanilla' });
assert.equal(vanilla.profile, null);
assert.equal(vanilla.profile_config, null);
assert.equal(vanilla.profile_config_hash, null);
assert.equal(vanilla.capabilities.jev.configured, false);
assert.equal(vanilla.jev_calls, 0);
assert.equal(validateRow(vanilla).ok, true, validateRow(vanilla).reasons.join(','));
// Vanilla thiếu dsh_version ⇒ identity null ⇒ row bị từ chối.
assert.equal(identityOf({ ...vanilla, dsh_version: null }), null);

// Parse lỗi / timeout ⇒ KHÔNG thành công (không che giấu môi trường hỏng).
assert.equal(summarize(events, decisions, { ...baseOptions, parseErrors: 1 }).success, false);
assert.equal(summarize(events, decisions, { ...baseOptions, timedOut: true }).success, false);
// Evaluator thất bại ⇒ success false dù CLI exit 0.
assert.equal(summarize(events, decisions, { ...baseOptions, evaluation: { success: false, tests_passed: 0, tests_total: 1 } }).success, false);

// ---------------------------------------------------- capability manifest
// Thiếu jg ⇒ `available: false`; thiếu bằng chứng ⇒ `null` (KHÔNG đoán true).
const jgMissing = deriveCapabilities({ arm: 'experimental',
  config: { enableJevgrepEscalation: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'jevgrep_escalation', decision: 'skip_unavailable' }],
  preflight: { executables: { jg: false }, review_tool: null } });
assert.equal(jgMissing.jevgrep.available, false);
assert.equal(jgMissing.jevgrep.configured, true);
const reviewUnknown = deriveCapabilities({ arm: 'balanced',
  config: { enableQualityReview: true },
  decisions: [{ type: 'boot', config: {} }], preflight: { executables: {}, review_tool: null } });
assert.equal(reviewUnknown.quality_review.available, null);
assert.equal(reviewUnknown.quality_review.invoked, false);
// Có bằng chứng chạy thật ⇒ invoked true.
const reviewRan = deriveCapabilities({ arm: 'balanced',
  config: { enableQualityReview: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'quality_review', decision: 'reviewed' }],
  preflight: {} });
assert.equal(reviewRan.quality_review.available, true);
assert.equal(reviewRan.quality_review.invoked, true);
// Jev lỗi key ⇒ available false (bằng chứng runtime, không phải suy đoán).
const jevBad = deriveCapabilities({ arm: 'safe', config: { enableCompletionCheck: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'jev_error', message: 'Jev API key invalid' }],
  preflight: {} });
assert.equal(jevBad.completion_check.available, false);

// ---------------------------------------------------- operation aggregation
const operations = aggregateOperations([
  { type: 'cost_governor', category: 'jg', invocation_kind: 'process_spawn', operation_id: 'a',
    reserved_units: 8, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 5 },
  // Đặt chỗ nhưng cạn ngân sách ⇒ skipped, KHÔNG phải failed.
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'b',
    reserved_units: 0, actual_invocations: 0, completed: false, cancelled: false, failure: 'budget', elapsed_ms: 0 },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'c',
    reserved_units: 2, actual_invocations: 1, completed: false, cancelled: true, failure: null, elapsed_ms: 9 },
  // Review chạy xong thật ⇒ successful (KHÔNG tính là failed).
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'd',
    reserved_units: 2, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 12 },
  // jg đã spawn nhưng lỗi thật ⇒ failed (actual_invocations > 0), KHÁC skipped.
  { type: 'cost_governor', category: 'jg', invocation_kind: 'process_spawn', operation_id: 'e',
    reserved_units: 8, actual_invocations: 1, completed: false, cancelled: false, failure: 'exit-2', elapsed_ms: 40 },
]);
assert.equal(operations.operations, 5);
assert.equal(operations.actual_invocations, 4);
assert.equal(operations.failures, 1);
assert.equal(operations.cancellations, 1);
assert.equal(operations.skipped, 1);
assert.equal(operations.jevgrep.operations, 2);
assert.equal(operations.jevgrep.actual_invocations, 2);
assert.equal(operations.jevgrep.successful_operations, 1);
assert.equal(operations.jevgrep.failed_operations, 1);
assert.equal(operations.jevgrep.skipped_operations, 0);
assert.equal(operations.review.operations, 3);
assert.equal(operations.review.actual_invocations, 2);
assert.equal(operations.review.skipped_operations, 1);
assert.equal(operations.review.successful_operations, 1);
assert.equal(operations.review.failed_operations, 0);

// ---------------------------------------------------- preflight / version
assert.equal(dshVersion(), '0.2.0-rc.2');
const preflight = preflightCapabilities();
assert.equal(typeof preflight.executables.jg, 'boolean');
// headless composition KHÔNG có jev-review ⇒ review_tool phải là false, không phải đoán.
assert.equal(preflight.review_tool, false);

// ---------------------------------------------------- task catalog contract
// Collector phải chạy được NHIỀU task/nhiều seed trong một lần gọi, và từ chối
// input sai TRƯỚC khi spawn bất cứ tiến trình nào.
process.env.TRAJECTORY_MODEL_KEY = process.env.TRAJECTORY_MODEL_KEY || 'x';
process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || 'y';
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', taskIds: ['does-not-exist'] }),
  /Unknown trajectory task/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', taskIds: [] }), /At least one task/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', seeds: [-1] }), /Seed/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', seeds: [] }), /Seed/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', seeds: [1.5] }), /Seed/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', timeoutMs: 0 }), /Timeout/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', baseURL: 'ftp://x/' }), /HTTP/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', baseURL: 'http://u:p@h/' }), /credential/);
// baseURL hỏng phải là lỗi rõ ràng, KHÔNG phải TypeError: Invalid URL thô.
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', baseURL: 'not-a-url' }),
  /valid HTTP\(S\) URL/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', baseURL: '' }), /valid HTTP\(S\) URL/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', arms: ['nope'] }), /Unknown arm/);
// Cùng catalog dùng bởi collector: mọi task_id đều resolve được.
assert.ok(TASKS.length >= 6);

// ---------------------------------------------------- CLI argv parser (thuần)
// Flag cần giá trị mà thiếu giá trị phải là LỖI, không âm thầm dùng mặc định;
// --tasks không được nuốt flag kế tiếp thành task id.
const bare = parseArgs(['out.jsonl']);
assert.equal(bare.output, 'out.jsonl');
assert.equal(bare.mode, 'normal');
assert.equal(bare.taskIds, undefined);
assert.equal(bare.seeds, undefined);
assert.deepEqual(parseArgs(['out.jsonl', '--tasks', 'a,b', '--seeds', '1,2']),
  { output: 'out.jsonl', mode: 'normal', taskIds: ['a', 'b'], seeds: [1, 2] });
assert.equal(parseArgs(['out.jsonl', '--jev-outage']).mode, 'jev-outage');
assert.equal(parseArgs(['--tasks', 'a', 'out.jsonl']).output, 'out.jsonl');
assert.throws(() => parseArgs(['out.jsonl', '--tasks']), /requires a value/);
assert.throws(() => parseArgs(['out.jsonl', '--seeds']), /requires a value/);
assert.throws(() => parseArgs(['out.jsonl', '--tasks', '--seeds', '1']), /requires a value/);
assert.throws(() => parseArgs(['out.jsonl', '--bogus']), /Unknown flag/);
assert.throws(() => parseArgs(['--tasks', 'a']), /output path/);
assert.throws(() => parseArgs(['a.jsonl', 'b.jsonl']), /output path/);
assert.throws(() => parseArgs(['out.jsonl', '--seeds', '-1']), /Seeds/);
assert.throws(() => parseArgs(['out.jsonl', '--seeds', 'x']), /Seeds/);
assert.throws(() => parseArgs(['out.jsonl', '--seeds', '']), /Seeds/);

// ---------------------------------------------------- run manifest (completeness)
// Row ghi dần nên file JSONL thiếu row trông không khác file đầy đủ; manifest
// phải nói rõ lần chạy có hoàn tất không.
assert.equal(manifestWarning(null), 'no-run-manifest: completeness of this JSONL was not recorded');
assert.match(manifestWarning({ status: 'incomplete', expected_rows: 8, written_rows: 3 }), /incomplete-run-manifest/);
assert.match(manifestWarning({ status: 'complete', expected_rows: 8, written_rows: 3 }), /wrote 3 of 8/);
assert.equal(manifestWarning({ status: 'complete', expected_rows: 8, written_rows: 8 }), null);
assert.equal(manifestWarning({ status: 'complete' }), null);

console.log('PASS trajectory collector contract (real functions, offline, no API calls)');
