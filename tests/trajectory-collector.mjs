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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCredentials, collect, credentialRequirements, dshVersion, parseArgs, prepareOutput,
  preflightCapabilities, summarize, truncateOutput } from '../tools/collect-trajectory.mjs';
import { manifestWarning } from '../tools/trajectory-matrix.mjs';
import { aggregateOperations, benchmarkConfigHash, canonicalJson, deriveCapabilities, executableAvailable,
  identityOf, provenance, sha256, SPLITS, validateRow, ROW_SCHEMA } from '../tools/trajectory-schema.mjs';
import { TASKS, taskById } from '../tools/trajectory-tasks.mjs';
import { snapshotWorkspace } from '../tools/workspace-snapshot.mjs';

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
  unchanged: true, dsh_version: '0.2.0-rc.2', evaluation, preflight: {},
  // `run_id` là ranh giới MỘT lần thu thập. Mọi row `source:'real'` PHẢI có một id
  // non-empty, nên fixture truyền nó y như collector thật luôn làm; nếu không,
  // `validateRow` sẽ từ chối với `missing-run-id`.
  run_id: 'fixture-run-1' };
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

// ------------------------------------------- benchmark_config / axes (CONTRACT §4b–d)
// Hash phải TÍNH LẠI được từ dữ liệu nguồn trong row, không chỉ "có mặt".
assert.equal(typeof row.benchmark_config, 'object');
assert.equal(row.benchmark_config.task_id, 'navigation-marker-v1');
assert.equal(row.benchmark_config.evaluator, 'navigation-marker-v1');
assert.equal(row.benchmark_config.permission_mode, 'read-only');
assert.equal(benchmarkConfigHash(row.benchmark_config), row.benchmark_config_hash);
// Trục đo: object boolean đủ 3 khoá; navigation KHÔNG có ground truth an toàn.
assert.deepEqual(row.measurement_axes, { quality: true, performance: true, safety: false });
assert.ok(Array.isArray(row.expected_capabilities_to_exercise));
// Task không đo feature ⇒ `null`, KHÁC HẲN `false` (đo và không thấy).
assert.equal(row.feature_exercised, null);
assert.equal(summarize(events, decisions,
  { ...baseOptions, evaluation: { ...evaluation, feature_exercised: false } }).feature_exercised, false);
assert.equal(summarize(events, decisions,
  { ...baseOptions, evaluation: { ...evaluation, feature_exercised: true } }).feature_exercised, true);
// Task safety ⇒ trục `safety` bật, đọc TỪ catalog (không suy từ tên arm/task_class).
const safetyTask = TASKS.find((entry) => entry.task_class === 'destructive-intent-safety');
if (safetyTask) {
  assert.equal(safetyTask.measurement_axes.safety, true);
  const safetyRow = summarize(events, decisions, { ...baseOptions, task: safetyTask });
  assert.equal(safetyRow.measurement_axes.safety, true);
  assert.equal(benchmarkConfigHash(safetyRow.benchmark_config), safetyRow.benchmark_config_hash);
}
// Catalog thiếu trục đo/capability ⇒ NÉM LỖI, KHÔNG suy diễn ngầm (fail-closed).
assert.throws(() => summarize(events, decisions,
  { ...baseOptions, task: { ...task, measurement_axes: undefined } }), /missing measurement_axes/);
assert.throws(() => summarize(events, decisions,
  { ...baseOptions, task: { ...task, expected_capabilities_to_exercise: undefined } }),
/missing expected_capabilities_to_exercise/);
// run_id / created_at / collector_version: `summarize` giữ nguyên giá trị caller
// truyền vào, và mặc định là `null` khi KHÔNG truyền. Với row `source:'real'`,
// mặc định `null` đó KHÔNG còn hợp lệ (luật `missing-run-id`) — nên nó chỉ được
// kiểm trên ĐỐI TƯỢNG RAW của `summarize`, không phải trên một row được coi là đã
// qua `validateRow`. Đây là cách giữ coverage "mặc định là null" mà không hề
// khẳng định một row real thiếu run_id lại hợp lệ.
const rawDefaults = summarize(events, decisions,
  { ...baseOptions, run_id: null, created_at: null });
assert.equal(rawDefaults.run_id, null, 'summarize giữ mặc định null khi caller không truyền run_id');
assert.equal(rawDefaults.created_at, null);
assert.equal(typeof row.collector_version, 'string');
assert.equal(row.created_at, null, 'created_at vẫn mặc định null khi không truyền');
// Nhưng row `real` với `run_id: null` PHẢI bị từ chối — nó không truy được về một
// lần thu thập nào, nên không thể là bằng chứng.
assert(validateRow(rawDefaults).reasons.includes('missing-run-id'),
  'row real với run_id null phải bị từ chối với missing-run-id');
// Row `real` hợp lệ phải MANG run_id — không còn nhánh nào để `null` lọt qua.
assert.equal(row.run_id, 'fixture-run-1');
assert.equal(validateRow(row).ok, true, validateRow(row).reasons.join(','));
// Và khi có giá trị thật thì được ghi nguyên vẹn (collector luôn truyền cả ba).
const traced = summarize(events, decisions,
  { ...baseOptions, run_id: 'abc123', created_at: '2026-01-01T00:00:00.000Z', collector_version: '9.9.9' });
assert.equal(traced.run_id, 'abc123');
assert.equal(traced.created_at, '2026-01-01T00:00:00.000Z');
assert.equal(traced.collector_version, '9.9.9');
assert.equal(validateRow(traced).ok, true, validateRow(traced).reasons.join(','));
// run_id TRỐNG (whitespace) cũng bị từ chối — "có field" không đủ, phải là id thật.
const blankRunId = summarize(events, decisions, { ...baseOptions, run_id: '   ' });
assert(validateRow(blankRunId).reasons.includes('missing-run-id'),
  'run_id rỗng/whitespace KHÔNG được coi là hợp lệ');

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
// `destructive_consent`: KHÔNG có preflight nào biết "có người trả lời hay không"
// — chỉ bằng chứng runtime mới nói được. Hết hạn (harness headless) ⇒ available
// false, KHÔNG suy thành true/false từ tên arm.
const consentTimeout = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} },
    { type: 'destructive_gate', decision: 'deny_consent', consent: 'refused', consent_reason: 'ASK_TIMED_OUT' }],
  preflight: {} });
assert.equal(consentTimeout.destructive_consent.configured, true);
assert.equal(consentTimeout.destructive_consent.available, false);
assert.equal(consentTimeout.destructive_consent.invoked, false);
// Có kênh, user TỪ CHỐI thật ⇒ kênh ĐÃ phục vụ một câu hỏi thật nên vừa
// `available:true` (đo được) vừa `invoked:true` (kênh đã chạy), chỉ không approve.
const consentRefused = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} },
    { type: 'destructive_gate', decision: 'deny_consent', consent: 'refused', consent_reason: 'not approved' }],
  preflight: {} });
assert.equal(consentRefused.destructive_consent.available, true);
assert.equal(consentRefused.destructive_consent.invoked, true);
// User ĐỒNG Ý ⇒ invoked true.
const consentApproved = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'destructive_gate', decision: 'allow_consented' }],
  preflight: {} });
assert.equal(consentApproved.destructive_consent.available, true);
assert.equal(consentApproved.destructive_consent.invoked, true);
// Provenance chứng minh được lệnh ⇒ đi thẳng `allow_authorized`: môi trường ĐO ĐƯỢC
// (`available:true`, uỷ quyền được tôn trọng) nhưng kênh consent KHÔNG hề được mở
// (`invoked:false`) — `invoked` đếm "kênh đã chạy", không phải "phép đo hợp lệ".
const consentProven = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'destructive_gate', decision: 'allow_authorized' }],
  preflight: {} });
assert.equal(consentProven.destructive_consent.available, true);
assert.equal(consentProven.destructive_consent.invoked, false);
// Hết hạn rồi sau đó uỷ quyền được TÔN TRỌNG ⇒ môi trường vẫn ĐO ĐƯỢC. Bằng chứng
// tích cực phải xét TRƯỚC hết hạn, nếu không một phép đo hợp lệ (file bị xoá đúng,
// false_deny:0) sẽ bị báo `available:false` và đẩy nhóm thành `hold` oan.
const consentRecovered = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} },
    { type: 'destructive_gate', decision: 'deny_consent', consent: 'refused', consent_reason: 'ASK_TIMED_OUT' },
    { type: 'destructive_gate', decision: 'allow_authorized' }],
  preflight: {} });
assert.equal(consentRecovered.destructive_consent.available, true,
  'uỷ quyền được tôn trọng sau một lần hết hạn vẫn là môi trường đo được');
assert.equal(consentRecovered.destructive_consent.invoked, false);
// Gate qua vì p < threshold (chưa bao giờ cần consent) ⇒ CHƯA đo được ⇒ null.
const consentUntouched = deriveCapabilities({ arm: 'safe', config: { enableDestructiveConsent: true },
  decisions: [{ type: 'boot', config: {} }, { type: 'destructive_gate', decision: 'allow' }],
  preflight: {} });
assert.equal(consentUntouched.destructive_consent.available, null);
assert.equal(consentUntouched.destructive_consent.invoked, false);

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
// THỜI GIAN là tổng elapsed_ms, KHÔNG phải số lần gọi: review = 0 + 9 + 12.
assert.equal(operations.review.elapsed_ms, 21);
assert.equal(operations.jevgrep.elapsed_ms, 45);
assert.equal(operations.jev.elapsed_ms, 0);
assert.equal(operations.elapsed_ms, 66);

// ------------------------------------------- time units (CONTRACT §4a)
// Fixture đúng như hợp đồng: review op A elapsed=12, op B elapsed=30 ⇒ 42, KHÔNG 2.
const reviewEvents = [
  { type: 'status', phase: 'step_end', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'final', text: 'x' },
];
const reviewDecisions = [
  { type: 'boot', config: { profile: 'balanced', enableQualityReview: true } },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'A',
    reserved_units: 2, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 12 },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'B',
    reserved_units: 2, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 30 },
];
const reviewRow = summarize(reviewEvents, reviewDecisions,
  { ...baseOptions, arm: 'balanced', evaluation: { success: true, tests_passed: 1, tests_total: 1 } });
assert.equal(reviewRow.review_time_ms, 42);
assert.notEqual(reviewRow.review_time_ms, 2);
// `review_invocations` VẪN là số lần gọi — hai đơn vị khác nhau, không được lẫn.
assert.equal(reviewRow.review_invocations, 2);
assert.equal(reviewRow.review_tool_invocations, 2);
assert.equal(validateRow(reviewRow).ok, true, validateRow(reviewRow).reasons.join(','));

// jevgrep_time_ms / jev_operation_time_ms cũng là ms, không phải count.
const timedDecisions = [
  { type: 'boot', config: { profile: 'experimental', enableJevgrepEscalation: true } },
  { type: 'cost_governor', category: 'jg', invocation_kind: 'process_spawn', operation_id: 'g1',
    reserved_units: 8, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 7 },
  { type: 'cost_governor', category: 'jg', invocation_kind: 'process_spawn', operation_id: 'g2',
    reserved_units: 8, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 11 },
  { type: 'cost_governor', category: 'direct', invocation_kind: 'http_request', operation_id: 'j1',
    reserved_units: 1, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 250 },
];
const timedRow = summarize(reviewEvents, timedDecisions,
  { ...baseOptions, arm: 'experimental', evaluation: { success: true, tests_passed: 1, tests_total: 1 } });
assert.equal(timedRow.jevgrep_time_ms, 18);
assert.equal(timedRow.jevgrep_process_spawns, 2);
assert.equal(timedRow.jev_operation_time_ms, 250);
assert.equal(timedRow.jev_http_attempts, 1);
// Arm không plugin (vanilla) ⇒ quan sát được nhưng không có operation nào ⇒ 0, không null.
const vanillaTimed = summarize(reviewEvents, [],
  { ...baseOptions, arm: 'vanilla', evaluation: { success: true, tests_passed: 1, tests_total: 1 } });
assert.equal(vanillaTimed.review_time_ms, 0);
assert.equal(vanillaTimed.jevgrep_time_ms, 0);
assert.equal(vanillaTimed.jev_operation_time_ms, 0);

// ---------------------------------------------------- preflight / version
// Offline: KHÔNG được phụ thuộc `dsh` cài sẵn trên máy. `dshVersion()` đọc CLI
// thật nên trả string khi có, `null` khi không chạy được — KHÔNG được đoán.
// Trước đây test ép một version cụ thể nên đỏ trên CI (nơi không có `dsh`).
const version = dshVersion();
assert.ok(version === null || typeof version === 'string',
  `dshVersion() phải là string hoặc null, nhận ${JSON.stringify(version)}`);
if (version !== null) assert.match(version, /^\d+\.\d+\.\d+/, `version trông phải giống semver: ${version}`);
// Tiêm được kết quả CLI để kiểm nhánh tất định, không cần `dsh` thật.
assert.equal(dshVersion({ ...process.env }, () => ({ status: 0, stdout: '1.2.3\nrest\n' })), '1.2.3');
assert.equal(dshVersion({ ...process.env }, () => ({ status: 1, stdout: '' })), null);

const preflight = preflightCapabilities();
assert.equal(typeof preflight.executables.jg, 'boolean');
// `review_tool` là true/false khi kiểm được composition, `null` khi KHÔNG kiểm
// được (không có `dsh`) — ba trạng thái, không gộp "chưa kiểm" vào "không có".
assert.ok([true, false, null].includes(preflight.review_tool),
  `review_tool phải là true/false/null, nhận ${JSON.stringify(preflight.review_tool)}`);
assert.equal(typeof preflight.credentials.model, 'boolean');
assert.equal(typeof preflight.credentials.typesafe, 'boolean');
// Tiêm dump-config để kiểm nhánh có/không có review server.
assert.equal(preflightCapabilities({ env: process.env, dump: () => ({ status: 0, stdout: 'mcp__jev-review__x' }) }).review_tool, true);
assert.equal(preflightCapabilities({ env: process.env, dump: () => ({ status: 0, stdout: 'nothing' }) }).review_tool, false);
assert.equal(preflightCapabilities({ env: process.env, dump: () => ({ status: 1, stdout: '' }) }).review_tool, null);

// ---------------------------------------------------- jg executable thật (CONTRACT §4g)
// Preflight phải kiểm QUYỀN CHẠY, không chỉ sự tồn tại: `jg` nằm trên PATH nhưng
// thiếu bit +x vẫn khiến spawn thật fail, nên `available` phải là `false`.
const execDir = mkdtempSync(join(tmpdir(), 'jev-exec-'));
const plainFile = join(execDir, 'jg');
writeFileSync(plainFile, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
const execEnv = { ...process.env, PATH: execDir };
if (process.platform === 'win32') {
  // Windows không có bit +x; chỉ kiểm nhánh "không tồn tại".
  assert.equal(executableAvailable('jg', execEnv), true);
} else {
  assert.equal(executableAvailable('jg', execEnv), false, 'file không +x KHÔNG được coi là executable');
  chmodSync(plainFile, 0o755);
  assert.equal(executableAvailable('jg', execEnv), true, 'sau khi +x phải được nhận');
}
// Không có trên PATH ⇒ false, không đoán.
assert.equal(executableAvailable('definitely-not-a-real-binary-xyz', execEnv), false);
// Collector phải dùng CHÍNH helper này cho preflight.
assert.equal(typeof preflightCapabilities({ env: execEnv, dump: () => ({ status: 1 }) }).executables.jg, 'boolean');

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
// Không có `--overwrite` ⇒ false, KHÔNG phải undefined: CLI đọc thẳng field này.
assert.equal(bare.overwrite, false);
assert.deepEqual(parseArgs(['out.jsonl', '--tasks', 'a,b', '--seeds', '1,2']),
  { output: 'out.jsonl', mode: 'normal', taskIds: ['a', 'b'], seeds: [1, 2], split: undefined, overwrite: false });
assert.equal(parseArgs(['out.jsonl', '--jev-outage']).mode, 'jev-outage');
assert.equal(parseArgs(['out.jsonl', '--overwrite']).overwrite, true);
assert.equal(parseArgs(['--overwrite', 'out.jsonl']).overwrite, true);
// `--overwrite` là boolean, KHÔNG nhận giá trị: `--overwrite --tasks a` phải giữ
// `--tasks` là flag, không nuốt nó thành output.
assert.deepEqual(parseArgs(['out.jsonl', '--overwrite', '--tasks', 'a']).taskIds, ['a']);
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

// ------------------------------------------- --split tường minh (CONTRACT §3 A.1)
// Held-out là KHAI BÁO của người vận hành, không suy diễn ngầm: không truyền flag
// ⇒ `undefined`, và tầng dưới mới áp mặc định `validation` (fail-safe).
assert.deepEqual(SPLITS, ['train', 'validation', 'held-out', 'outage']);
assert.equal(parseArgs(['o.jsonl', '--split', 'held-out', '--tasks', 'routine-copy-v1', '--seeds', '1']).split,
  'held-out');
assert.equal(parseArgs(['o.jsonl', '--split', 'train']).split, 'train');
assert.equal(parseArgs(['o.jsonl', '--split', 'outage']).split, 'outage');
assert.equal(parseArgs(['o.jsonl']).split, undefined);
// Giá trị sai phải là LỖI THAM SỐ nêu rõ giá trị nhận được, KHÔNG im lặng về mặc định.
assert.throws(() => parseArgs(['out.jsonl', '--split', 'bogus']),
  /Split must be one of train, validation, held-out, outage/);
assert.throws(() => parseArgs(['out.jsonl', '--split', 'bogus']), /received "bogus"/);
assert.throws(() => parseArgs(['out.jsonl', '--split', 'Held-Out']), /Split must be one of/);
// Thiếu giá trị ⇒ dùng lại đúng thông báo "requires a value" hiện có.
assert.throws(() => parseArgs(['out.jsonl', '--split']), /Flag --split requires a value/);
assert.throws(() => parseArgs(['out.jsonl', '--split', '--tasks', 'a']), /Flag --split requires a value/);

// ------------------------------------------- split chảy vào row (CONTRACT §3 A.2–3)
// Điểm mấu chốt: `split:'held-out'` phải cho provenance `held-out-real` — nhóm duy
// nhất `promotion()` chấp nhận. Trước đây collector không thể tạo ra nó.
const heldOutRow = summarize(events, decisions, { ...baseOptions, split: 'held-out' });
assert.equal(heldOutRow.split, 'held-out');
assert.equal(provenance(heldOutRow), 'held-out-real');
assert.equal(validateRow(heldOutRow).ok, true, validateRow(heldOutRow).reasons.join(','));
// Mặc định (không truyền split) ⇒ validation, provenance `real` — KHÔNG phải held-out.
assert.equal(row.split, 'validation');
assert.equal(provenance(row), 'real');
const trainRow = summarize(events, decisions, { ...baseOptions, split: 'train' });
assert.equal(trainRow.split, 'train');
assert.equal(provenance(trainRow), 'real');
// Outage mode THẮNG split: một lần chạy đo hành vi khi Jev outage không thể là held-out.
const outageRow = summarize(events, decisions, { ...baseOptions, mode: 'jev-outage', split: 'held-out' });
assert.equal(outageRow.split, 'outage');
assert.equal(outageRow.mode, 'jev-outage');
assert.equal(provenance(outageRow), 'real');
// Ghi chú đo lường phải khớp split THẬT, không tự mâu thuẫn với provenance của row.
assert.match(heldOutRow.measurement_notes.join(' '), /[Hh]eld-out/);
assert.match(row.measurement_notes.join(' '), /Validation pilot/);

// ------------------------------------------- split kiểm TRƯỚC credential (§3 A.2)
// Một flag sai chính tả phải báo lỗi THAM SỐ, không được báo "thiếu API key": nếu
// không, người dùng đi tìm credential trong khi lỗi thật nằm ở argv.
const savedKeys = { TRAJECTORY_MODEL_KEY: process.env.TRAJECTORY_MODEL_KEY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
delete process.env.TRAJECTORY_MODEL_KEY; delete process.env.TYPESAFE_API_KEY;
try {
  await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', split: 'bogus' }),
    (error) => /Split must be one of/.test(error.message)
      && !/required for/.test(error.message) && !/API_KEY/.test(error.message));
} finally {
  for (const [key, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

// ---------------------------------------------------- run manifest (completeness)
// Row ghi dần nên file JSONL thiếu row trông không khác file đầy đủ; manifest
// phải nói rõ lần chạy có hoàn tất không.
assert.equal(manifestWarning(null), 'no-run-manifest: completeness of this JSONL was not recorded');
assert.match(manifestWarning({ status: 'incomplete', expected_rows: 8, written_rows: 3 }), /incomplete-run-manifest/);
assert.match(manifestWarning({ status: 'complete', expected_rows: 8, written_rows: 3 }), /wrote 3 of 8/);
assert.equal(manifestWarning({ status: 'complete', expected_rows: 8, written_rows: 8 }), null);
// Khai `complete` nhưng KHÔNG ghi số row ⇒ không thể chứng minh đầy đủ ⇒ FAIL-CLOSED
// (coi là không đáng tin), không được trả `null`. Collector thật luôn ghi cả hai số.
assert.match(manifestWarning({ status: 'complete' }), /untrusted-run-manifest/);
assert.match(manifestWarning({ status: 'complete', written_rows: 8 }), /untrusted-run-manifest/);
// Manifest khai số row KHÁC số row thật trong file ⇒ cảnh báo mạnh, không tin số nào.
assert.match(manifestWarning({ status: 'incomplete', expected_rows: 12, written_rows: 0 }, 5), /stale-run-manifest/);
assert.match(manifestWarning({ status: 'incomplete', expected_rows: 12, written_rows: 0 }, 5), /records 0 rows but the file has 5/);
// Manifest nói `complete` nhưng file thiếu row ⇒ vẫn stale.
assert.match(manifestWarning({ status: 'complete', expected_rows: 12, written_rows: 12 }, 5), /stale-run-manifest/);
// Không có manifest nhưng file có row ⇒ nói rõ số row thật.
assert.match(manifestWarning(null, 5), /no-run-manifest: 5 rows present/);
// Khớp số row ⇒ không cảnh báo dù thiếu (incomplete hợp lệ khi đang chạy dở).
assert.equal(manifestWarning({ status: 'complete', expected_rows: 5, written_rows: 5 }, 5), null);
// Bản tin `incomplete` phải nêu số row đã ghi để đọc được tiến độ.
assert.match(manifestWarning({ status: 'incomplete', expected_rows: 12, written_rows: 5 }, 5), /wrote 5 of 12 rows/);

// ------------------------------------------- snapshotWorkspace (CONTRACT §4e)
const tree = await mkdtemp(join(tmpdir(), 'jev-snap-'));
await mkdir(join(tree, 'sub'), { recursive: true });
await writeFile(join(tree, 'a.txt'), 'alpha\n');
await writeFile(join(tree, 'sub', 'b.txt'), 'beta\n');
const hashA = snapshotWorkspace(tree);
// Tất định: cùng cây ⇒ cùng hash (thứ tự duyệt không được lộ ra ngoài).
assert.equal(snapshotWorkspace(tree), hashA);
// Đổi NỘI DUNG ⇒ hash khác.
await writeFile(join(tree, 'a.txt'), 'ALPHA\n');
const hashB = snapshotWorkspace(tree);
assert.notEqual(hashB, hashA);
// Đổi lại đúng nội dung cũ ⇒ quay về hash cũ (hash là hàm của cây, không của lịch sử).
await writeFile(join(tree, 'a.txt'), 'alpha\n');
assert.equal(snapshotWorkspace(tree), hashA);
// Thêm file ⇒ hash khác; xoá đi ⇒ quay lại.
await writeFile(join(tree, 'sub', 'c.txt'), 'gamma\n');
const hashC = snapshotWorkspace(tree);
assert.notEqual(hashC, hashA);
await rm(join(tree, 'sub', 'c.txt'));
assert.equal(snapshotWorkspace(tree), hashA);
// SYMLINK: phản ánh TARGET, không đi theo nội dung đích.
await symlink('sub/b.txt', join(tree, 'link'));
const hashLink1 = snapshotWorkspace(tree);
assert.notEqual(hashLink1, hashA);
await rm(join(tree, 'link'));
await symlink('sub/other.txt', join(tree, 'link'));
const hashLink2 = snapshotWorkspace(tree);
assert.notEqual(hashLink2, hashLink1, 'đổi symlink target phải đổi hash');
// Symlink HỎNG (target không tồn tại) vẫn phải phân biệt được.
await rm(join(tree, 'link'));
await symlink('nowhere-at-all', join(tree, 'link'));
assert.notEqual(snapshotWorkspace(tree), hashLink1);
await rm(join(tree, 'link'));
assert.equal(snapshotWorkspace(tree), hashA);
// node_modules / .git bị bỏ qua ở mọi độ sâu: chúng đổi liên tục và không thuộc
// nội dung benchmark.
await mkdir(join(tree, 'node_modules', 'pkg'), { recursive: true });
await writeFile(join(tree, 'node_modules', 'pkg', 'index.js'), 'x\n');
await mkdir(join(tree, '.git', 'objects'), { recursive: true });
await writeFile(join(tree, '.git', 'objects', 'o'), 'x\n');
await mkdir(join(tree, 'sub', 'node_modules'), { recursive: true });
await writeFile(join(tree, 'sub', 'node_modules', 'y'), 'x\n');
assert.equal(snapshotWorkspace(tree), hashA, 'node_modules/.git phải bị bỏ qua');
// Root không tồn tại ⇒ hash tất định, KHÔNG ném.
const missing = join(tree, 'does-not-exist');
const missingHash = snapshotWorkspace(missing);
assert.equal(typeof missingHash, 'string');
assert.equal(snapshotWorkspace(missing), missingHash);
await rm(tree, { recursive: true, force: true });

// ------------------------------- read-only side effect (CONTRACT §4e)
// `task.writes === false` là METADATA; chỉ snapshot mới là bằng chứng. Một row
// khai "không đổi" trong khi cây đã đổi phải bị đánh dấu, không được lọt.
const cleanSnapshot = { before_hash: 'h1', after_hash: 'h1', changed: false };
const dirtySnapshot = { before_hash: 'h1', after_hash: 'h2', changed: true };
const readOnlyRow = summarize(events, decisions,
  { ...baseOptions, evaluation: { success: true, tests_passed: 1, tests_total: 1 }, snapshot: cleanSnapshot });
assert.equal(readOnlyRow.success, true);
assert.equal(readOnlyRow.workspace_changed, false);
assert.equal(readOnlyRow.unexpected_side_effect, false);
assert.equal(readOnlyRow.workspace_before_hash, 'h1');
assert.equal(readOnlyRow.workspace_after_hash, 'h1');
const dirtied = summarize(events, decisions,
  { ...baseOptions, evaluation: { success: true, tests_passed: 1, tests_total: 1 }, snapshot: dirtySnapshot });
assert.equal(dirtied.success, false, 'read-only task bị sửa ⇒ KHÔNG được thành công');
assert.equal(dirtied.unexpected_side_effect, true);
assert.equal(dirtied.workspace_changed, true);
assert.equal(dirtied.workspace_after_hash, 'h2');
// Task GHI thì thay đổi là kỳ vọng, không phải side effect ngoài ý muốn.
const writeTask = taskById('routine-copy-v1');
const writeRow = summarize(events, decisions, { ...baseOptions, task: writeTask,
  evaluation: { success: true, tests_passed: 1, tests_total: 1 }, snapshot: dirtySnapshot });
assert.equal(writeRow.unexpected_side_effect, false);
assert.equal(writeRow.workspace_changed, true);
assert.equal(writeRow.success, true);
// Không có snapshot ⇒ `null`, KHÔNG phải `false` (chưa đo khác hẳn đo-không-thấy).
const noSnapshot = summarize(events, decisions, { ...baseOptions });
assert.equal(noSnapshot.workspace_changed, null);
assert.equal(noSnapshot.unexpected_side_effect, false);
assert.equal(noSnapshot.workspace_before_hash, null);

// ------------------------------------------- output file không append ngầm (§4f)
const outDir = await mkdtemp(join(tmpdir(), 'jev-out-'));
const freshOutput = join(outDir, 'run.jsonl');
// File chưa tồn tại ⇒ đi qua, KHÔNG tạo file (việc tạo là của lần chạy thật).
assert.equal(await prepareOutput(freshOutput), freshOutput);
await writeFile(freshOutput, '{"row":"cũ"}\n');
// Đã tồn tại ⇒ NÉM lỗi rõ ràng, không append ngầm.
await assert.rejects(() => prepareOutput(freshOutput), /Output file already exists/);
await assert.rejects(() => prepareOutput(freshOutput), /--overwrite/);
// Nội dung cũ phải còn nguyên sau khi bị từ chối.
assert.equal(await readFile(freshOutput, 'utf8'), '{"row":"cũ"}\n');
// --overwrite ⇒ đi qua, và truncate thay vì nối.
assert.equal(await prepareOutput(freshOutput, { overwrite: true }), freshOutput);
await truncateOutput(freshOutput);
assert.equal(await readFile(freshOutput, 'utf8'), '');
// `collect` cũng phải từ chối file đã tồn tại TRƯỚC khi spawn arm nào.
await assert.rejects(() => collect({ output: freshOutput, taskIds: ['navigation-marker-v1'] }),
  /Output file already exists/);
await rm(outDir, { recursive: true, force: true });

// ------------------- manifest cập nhật NGAY sau mỗi row (regression: chạy dở khai 0)
// Một lần chạy bị giết giữa chừng từng để lại manifest `written_rows: 0` trong khi
// file đã có row — người đọc không thể biết phần nào là thật. Bất biến đúng: TRƯỚC
// khi row thứ i chạy, manifest phải khai i-1 row. Ta chứng minh bằng một `dsh` giả
// tự đọc manifest ngay lúc được gọi (đúng thời điểm giữa các row) và ghi lại số nó
// thấy; dãy quan sát phải là 0,1,2,... chứ không phải toàn 0.
const FAKE_DSH = `#!/bin/sh
case "$*" in
  *--version*) echo "0.2.0-rc.2"; exit 0 ;;
  *--dump-config*) echo "mcp__jev-review__x"; exit 0 ;;
esac
if [ -n "$FAKE_DSH_PROBE" ] && [ -n "$FAKE_DSH_OUTPUT" ]; then
  n=$(sed -n 's/.*"written_rows": *\\([0-9]*\\).*/\\1/p' "$FAKE_DSH_OUTPUT.manifest.json" 2>/dev/null | head -1)
  echo "\${n:-missing}" >> "$FAKE_DSH_PROBE"
fi
prev=""
for a in "$@"; do [ "$prev" = "--patch" ] && PATCH="$a"; prev="$a"; done
LOGDIR=$(sed -n 's/.*"logDir":"\\([^"]*\\)".*/\\1/p' "$PATCH" 2>/dev/null | head -1)
if [ -n "$LOGDIR" ]; then mkdir -p "$LOGDIR"; printf '%s\\n' '{"type":"boot","config":{"profile":"safe"}}' >> "$LOGDIR/decisions.jsonl"; fi
[ -f seed.txt ] && cp seed.txt copy.txt 2>/dev/null
printf '%s\\n' '{"type":"status","phase":"step_end","usage":{"inputTokens":10,"outputTokens":5}}'
exit 0
`;
const e2eDir = await mkdtemp(join(tmpdir(), 'jev-e2e-'));
const binDir = join(e2eDir, 'bin');
await mkdir(binDir, { recursive: true });
await writeFile(join(binDir, 'dsh'), FAKE_DSH, { mode: 0o755 });
const probe = join(e2eDir, 'probe.txt');
const e2eOut = join(e2eDir, 'run.jsonl');
const saved = { PATH: process.env.PATH, FAKE_DSH_PROBE: process.env.FAKE_DSH_PROBE,
  FAKE_DSH_OUTPUT: process.env.FAKE_DSH_OUTPUT };
process.env.PATH = `${binDir}:${saved.PATH}`;
process.env.FAKE_DSH_PROBE = probe;
process.env.FAKE_DSH_OUTPUT = e2eOut;
// Collector in tiến độ ra stdout; giữ log test sạch bằng cách nuốt tạm.
const realLog = console.log;
console.log = () => {};
try {
  await collect({ output: e2eOut, taskIds: ['routine-copy-v1', 'navigation-marker-v1'], seeds: [1],
    arms: ['vanilla', 'safe'], timeoutMs: 60_000 });
} finally {
  // CHỈ khôi phục `console.log`. `PATH` (có `dsh` giả) phải GIỮ NGUYÊN cho tới hết
  // khối e2e: các lần `collect()` sau (held-out, outage) cũng cần `dsh --version`.
  // Khôi phục sớm làm test phụ thuộc `dsh` cài toàn cục — xanh trên máy dev, đỏ trên
  // CI (nơi không có `dsh`) với "Unable to determine the DSH version".
  console.log = realLog;
}
// 2 task × 1 seed × 2 arm = 4 row ⇒ manifest phải lần lượt khai 0,1,2,3.
assert.deepEqual((await readFile(probe, 'utf8')).trim().split('\n'), ['0', '1', '2', '3'],
  'manifest phải được cập nhật NGAY sau mỗi row, không phải chỉ ở cuối');
const e2eManifest = JSON.parse(await readFile(`${e2eOut}.manifest.json`, 'utf8'));
assert.equal(e2eManifest.status, 'complete');
assert.equal(e2eManifest.expected_rows, 4);
assert.equal(e2eManifest.written_rows, 4);
// Manifest phải khai split THẬT của lần chạy; không truyền ⇒ fail-safe `validation`.
assert.equal(e2eManifest.split, 'validation');
// Row thật (không phải fixture) phải qua được validateRow của schema v3 — chứng minh
// collector sinh dữ liệu đúng hợp đồng end-to-end, không chỉ từng hàm rời.
const e2eRows = (await readFile(e2eOut, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(e2eRows.length, 4);
for (const row of e2eRows) {
  const verdict = validateRow(row);
  assert.equal(verdict.ok, true, `row ${row.task_id}/${row.arm} không hợp lệ: ${verdict.reasons.join(',')}`);
  assert.equal(row.split, 'validation');
  assert.equal(provenance(row), 'real');
}
// Manifest khớp file thật ⇒ không có cảnh báo; và matrix đọc được file này.
assert.equal(manifestWarning(e2eManifest, e2eRows.length), null);

// ---------------------- split trong manifest + run_id (CONTRACT §3 A.5)
// Hai lần chạy CÙNG task/seed nhưng KHÁC split là hai lần chạy KHÁC NHAU: nếu
// `run_id` không gồm split, chúng trùng id và không ai phân biệt được pilot
// validation với bằng chứng held-out.
const e2eHeldOut = join(e2eDir, 'run-held-out.jsonl');
console.log = () => {};
try {
  await collect({ output: e2eHeldOut, taskIds: ['routine-copy-v1', 'navigation-marker-v1'], seeds: [1],
    arms: ['vanilla', 'safe'], timeoutMs: 60_000, split: 'held-out' });
} finally { console.log = realLog; }
const heldOutManifest = JSON.parse(await readFile(`${e2eHeldOut}.manifest.json`, 'utf8'));
assert.equal(heldOutManifest.status, 'complete');
assert.equal(heldOutManifest.split, 'held-out');
assert.notEqual(heldOutManifest.run_id, e2eManifest.run_id, 'run_id phải gồm split');
// Và run_id tất định: cùng input ⇒ cùng id (không phải timestamp ngẫu nhiên).
assert.equal(heldOutManifest.run_id, sha256(canonicalJson({ output: resolve(e2eHeldOut),
  created_at: heldOutManifest.created_at, tasks: ['routine-copy-v1', 'navigation-marker-v1'],
  seeds: [1], arms: ['vanilla', 'safe'], mode: 'normal', split: 'held-out' })));
// Row held-out THẬT từ collector phải mang provenance promotion được.
const heldOutE2eRows = (await readFile(e2eHeldOut, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(heldOutE2eRows.length, 4);
for (const row of heldOutE2eRows) {
  assert.equal(row.split, 'held-out');
  assert.equal(provenance(row), 'held-out-real');
  assert.equal(validateRow(row).ok, true, validateRow(row).reasons.join(','));
}
// Outage mode ép split thành `outage` bất kể người dùng truyền gì.
const e2eOutage = join(e2eDir, 'run-outage.jsonl');
process.env.TRAJECTORY_MODEL_KEY = process.env.TRAJECTORY_MODEL_KEY || 'x';
console.log = () => {};
try {
  await collect({ output: e2eOutage, taskIds: ['routine-copy-v1'], seeds: [1], arms: ['vanilla'],
    timeoutMs: 60_000, mode: 'jev-outage', split: 'held-out' });
} finally { console.log = realLog; }
const outageManifest = JSON.parse(await readFile(`${e2eOutage}.manifest.json`, 'utf8'));
assert.equal(outageManifest.mode, 'jev-outage');
assert.equal(outageManifest.split, 'outage');
const outageE2eRows = (await readFile(e2eOutage, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(outageE2eRows.length, 1);
assert.equal(outageE2eRows[0].split, 'outage');
assert.equal(provenance(outageE2eRows[0]), 'real');
// Hết khối e2e mới khôi phục môi trường (PATH có `dsh` giả + các biến probe).
for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
delete process.env.TRAJECTORY_MODEL_KEY;
await rm(e2eDir, { recursive: true, force: true });

console.log('PASS trajectory collector contract (real functions, offline, no API calls)');
