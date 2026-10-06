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
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { artifactHashes, assertCredentials, COLLECTOR_VERSION, collect, credentialRequirements,
  dshInstallRoot, dshVersion, evaluatorHashFor, gitCommit, gitDirty, modelEndpointOrigin, parseArgs,
  incompatibleArmPairs, prepareOutput, preflightCapabilities, rotationOrder, SEED_NOTE, sumUsage, summarize, taskCatalogHash,
  truncateOutput } from '../tools/collect-trajectory.mjs';
import { manifestWarning } from '../tools/trajectory-matrix.mjs';
import { aggregateOperations, benchmarkConfigHash, canonicalJson, deriveCapabilities, executableAvailable,
  identityOf, provenance, sha256, SPLITS, validateOperationTelemetry, validateRow,
  verifyManifestAgainstRows, ROW_SCHEMA } from '../tools/trajectory-schema.mjs';
import { fixtureHash, TASKS, taskById } from '../tools/trajectory-tasks.mjs';
import { confinementProblems, diffWorkspaces, escapesWorkspaceRoot, snapshotWorkspace,
  snapshotWorkspaceDetail } from '../tools/workspace-snapshot.mjs';

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
  run_id: 'fixture-run-1',
  // Identity bổ sung (CONTRACT §2): row `real` bắt buộc có plugin_git_commit; nếu
  // thiếu, validateRow từ chối `missing-plugin-git-commit`. Fixture truyền giá trị
  // như collector thật — nơi nó lấy từ `git rev-parse HEAD` của plugin.
  plugin_git_commit: 'fixture-plugin-commit', plugin_dirty_state: false,
  dsh_git_commit: null, model_endpoint_origin: 'fixture.example:443' };
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

// ------------------------------------------- row identity mới (CONTRACT §2, §6, §10–12)
// Mọi row `real` phải mang đủ dấu vết để TÁI LẬP: commit plugin, hash evaluator,
// trạng thái cây, commit dsh, origin endpoint, phiên bản collector, cache mode.
assert.equal(row.source, 'real');
assert.equal(row.plugin_git_commit, 'fixture-plugin-commit');
assert.equal(row.plugin_dirty_state, false);
assert.equal(row.dsh_git_commit, null);
assert.equal(row.model_endpoint_origin, 'fixture.example:443');
assert.equal(row.cache_mode, 'cold');
assert.equal(row.collector_version, COLLECTOR_VERSION);
assert.equal(COLLECTOR_VERSION, '2');
// `evaluator_hash` phải TÍNH LẠI được từ dữ liệu nguồn task, KHÔNG từ function.toString().
assert.equal(row.evaluator_hash, evaluatorHashFor(task));
assert.equal(row.evaluator_hash,
  sha256(canonicalJson({ task_id: 'navigation-marker-v1',
    evaluator_version: task.evaluator_version ?? null,
    prompt_hash: sha256(task.prompt), fixture_hash: fixtureHash(task) })));
assert.equal(typeof row.evaluator_hash, 'string');
assert.equal(row.evaluator_hash.length, 64);
// Thiếu plugin_git_commit ⇒ từ chối; cây bẩn ⇒ từ chối (không nhận bằng chứng
// không tái lập được).
assert(validateRow({ ...row, plugin_git_commit: '' }).reasons.includes('missing-plugin-git-commit'),
  'row real thiếu plugin_git_commit phải bị từ chối');
assert(validateRow({ ...row, plugin_dirty_state: true }).reasons.includes('unreproducible-plugin-state'),
  'cây plugin bẩn phải bị từ chối');
assert(validateRow({ ...row, evaluator_hash: '' }).reasons.includes('missing-evaluator-hash'),
  'row real thiếu evaluator_hash phải bị từ chối');
// artifacts: hash NỘI DUNG file bằng chứng; workspace_* nhận sẵn hash từ snapshot
// (không băm lại lần hai — chúng đã là hash của cây workspace).
assert.equal(row.artifacts, null);
const withArtifacts = summarize(events, decisions,
  { ...baseOptions, artifacts: artifactHashes({ eventsText: 'e', decisionsText: 'd',
    beforeHash: 'b', afterHash: 'a' }) });
assert.equal(withArtifacts.artifacts.events_sha256, sha256('e'));
assert.equal(withArtifacts.artifacts.decisions_sha256, sha256('d'));
assert.equal(withArtifacts.artifacts.workspace_before_sha256, 'b');
assert.equal(withArtifacts.artifacts.workspace_after_sha256, 'a');
assert.equal(artifactHashes({}).events_sha256, null);
assert.equal(artifactHashes({}).decisions_sha256, null);
assert.equal(artifactHashes({}).workspace_before_sha256, null);
// held_out_declaration: chỉ có khi split held-out, và nêu rõ ai khai.
assert.equal(row.held_out_declaration, null);
const heldOut = summarize(events, decisions,
  { ...baseOptions, split: 'held-out', held_out_declaration: { declared: true,
    declared_at: '2026-01-01T00:00:00.000Z', task_catalog_hash: taskCatalogHash([task]),
    plugin_commit: 'fixture-plugin-commit', reason: 'operator-declared' } });
assert.equal(heldOut.split, 'held-out');
assert.equal(heldOut.held_out_declaration.declared, true);
assert.equal(heldOut.held_out_declaration.reason, 'operator-declared');
assert.equal(heldOut.held_out_declaration.task_catalog_hash, taskCatalogHash([task]));
// Provider metadata: nhiệt độ/model/origin + ghi chú seed (seed KHÔNG phải seed
// lấy mẫu của provider — nó chỉ xoay THỨ TỰ arm và định danh fixture).
assert.equal(row.provider.model, 'fixture');
assert.equal(row.provider.model_endpoint_origin, 'fixture.example:443');
assert.equal(row.provider.seed, 1);
assert.equal(row.provider.seed_note, SEED_NOTE);
assert.match(SEED_NOTE, /ORDER|thứ tự/i);
const warmed = summarize(events, decisions, { ...baseOptions, temperature: 0.2 });
assert.equal(warmed.provider.temperature, 0.2);
assert.equal(summarize(events, decisions, baseOptions).provider.temperature, null);

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

// ------------------------------------------- exercised evidence (CONTRACT §4)
// `exercised` là câu trả lời của EVALUATOR ("agent có thật sự làm điều này?"),
// KHÁC `available`/`invoked` (môi trường/kênh). Nó phải được truyền từ evaluation
// vào manifest, và mặc định `null` khi evaluator không khai (chưa đo ≠ không làm).
const exercisedTask = taskById('destructive-authorized-delete-v1');
const exercisedRow = summarize(events, decisions, { ...baseOptions, task: exercisedTask,
  evaluation: { success: true, tests_passed: 1, tests_total: 1,
    exercised_capabilities: { destructive_gate: true, destructive_consent: false } } });
assert.equal(exercisedRow.capabilities.destructive_gate.exercised, true);
assert.equal(exercisedRow.capabilities.destructive_consent.exercised, false);
// Capability KHÔNG được khai ⇒ `null`, không bị suy thành true/false.
assert.equal(exercisedRow.capabilities.completion_check.exercised, null);
// Không có evaluation.exercised_capabilities ⇒ mọi entry `null` (không bịa).
const noExerciseRow = summarize(events, decisions, { ...baseOptions, task: exercisedTask,
  evaluation: { success: true, tests_passed: 1, tests_total: 1 } });
for (const entry of Object.values(noExerciseRow.capabilities)) {
  assert.equal(entry.exercised, null, 'thiếu khai báo ⇒ exercised null');
}
// Tên lạ trong exercised_capabilities bị BỎ QUA (không thêm capability không tồn tại).
const strayExercise = summarize(events, decisions, { ...baseOptions, task: exercisedTask,
  evaluation: { success: true, tests_passed: 1, tests_total: 1,
    exercised_capabilities: { not_a_capability: true, destructive_gate: true } } });
assert.equal(strayExercise.capabilities.not_a_capability, undefined);
assert.equal(strayExercise.capabilities.destructive_gate.exercised, true);
// Legacy `feature_exercised` chỉ áp cho task khai ĐÚNG MỘT capability kỳ vọng —
// nếu không, một boolean không nói được nó thuộc capability nào.
const singleExpected = TASKS.find((t) => t.expected_capabilities_to_exercise?.length === 1);
if (singleExpected) {
  const legacyRow = summarize(events, decisions, { ...baseOptions, task: singleExpected,
    evaluation: { success: true, tests_passed: 1, tests_total: 1, feature_exercised: true } });
  assert.equal(legacyRow.capabilities[singleExpected.expected_capabilities_to_exercise[0]].exercised, true);
}
// Task nhiều capability + chỉ có feature_exercised ⇒ KHÔNG suy gán (mơ hồ).
const multiExpected = TASKS.find((t) => (t.expected_capabilities_to_exercise?.length ?? 0) > 1);
if (multiExpected) {
  const ambiguousRow = summarize(events, decisions, { ...baseOptions, task: multiExpected,
    evaluation: { success: true, tests_passed: 1, tests_total: 1, feature_exercised: true } });
  for (const name of multiExpected.expected_capabilities_to_exercise) {
    assert.equal(ambiguousRow.capabilities[name].exercised, null,
      'một boolean không đủ để gán cho nhiều capability');
  }
}

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
// Mỗi operation THẬT trong `decisions.jsonl` do `beginOperation()` phát ra là một
// chuỗi ba dòng: `reserved_cost` → `actual_invocation` → `operation_finished`.
// `finish()` LUÔN phát dòng kết thúc, nên một fixture thiếu nó mô tả một chuỗi
// KHÔNG THỂ tồn tại và bị `validateOperationTelemetry` báo `missing-terminal-event`
// (đúng như thiết kế §16). Giữ fixture khớp với luồng thật.
const reviewDecisions = [
  { type: 'boot', config: { profile: 'balanced', enableQualityReview: true } },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'A',
    reserved_units: 2, actual_invocations: 0, completed: false, cancelled: false, failure: null, elapsed_ms: 0, decision: 'reserved_cost' },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'A',
    reserved_units: 2, actual_invocations: 1, completed: false, cancelled: false, failure: null, elapsed_ms: 12, decision: 'actual_invocation' },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'A',
    reserved_units: 2, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 12, decision: 'operation_finished' },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'B',
    reserved_units: 2, actual_invocations: 0, completed: false, cancelled: false, failure: null, elapsed_ms: 0, decision: 'reserved_cost' },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'B',
    reserved_units: 2, actual_invocations: 1, completed: false, cancelled: false, failure: null, elapsed_ms: 30, decision: 'actual_invocation' },
  { type: 'cost_governor', category: 'review', invocation_kind: 'tool_execution', operation_id: 'B',
    reserved_units: 2, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 30, decision: 'operation_finished' },
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
    reserved_units: 8, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 7, decision: 'operation_finished' },
  { type: 'cost_governor', category: 'jg', invocation_kind: 'process_spawn', operation_id: 'g2',
    reserved_units: 8, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 11, decision: 'operation_finished' },
  { type: 'cost_governor', category: 'direct', invocation_kind: 'http_request', operation_id: 'j1',
    reserved_units: 1, actual_invocations: 1, completed: true, cancelled: false, failure: null, elapsed_ms: 250, decision: 'operation_finished' },
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

// ---------------------------------------------------- sumUsage (CONTRACT §17)
// Token phải TRUNG THỰC: chỉ cộng sự kiện usage ĐÃ BIẾT, bỏ qua hình dạng lạ,
// KHÔNG cộng hai lần sự kiện luỹ kế, và trả `null` khi không có bằng chứng nào.
// "Chưa đo" (null) khác hẳn "đo được 0".
// (a) TĂNG dần: cộng dồn các `step_end`.
assert.deepEqual(sumUsage([
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 1 } },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 4, outputTokens: 2 } },
]), { input_tokens: 14, output_tokens: 3, reasoning_tokens: null, cache_read_tokens: null });
// (b) LUỸ KẾ: một sự kiện mang TỔNG; lấy MAX, không cộng dồn (cộng sẽ nhân đôi).
assert.deepEqual(sumUsage([
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 100, outputTokens: 7 } },
]), { input_tokens: 100, output_tokens: 7, reasoning_tokens: null, cache_read_tokens: null });
// Luỹ kế tăng dần qua nhiều mốc ⇒ vẫn là TỔNG cuối, không phải tổng các mốc.
assert.deepEqual(sumUsage([
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 100 } },
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 250 } },
]).input_tokens, 250);
// (c) TRÙNG LẶP: cùng một sự kiện tăng phát hai lần (retry/ghi lặp) ⇒ chỉ tính MỘT.
assert.equal(sumUsage([
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
]).input_tokens, 10);
// (d) KHÔNG có bằng chứng ⇒ null (KHÔNG phải 0).
assert.equal(sumUsage([]), null);
assert.equal(sumUsage([{ type: 'final', text: 'x' }]), null);
assert.equal(sumUsage(null), null);
// Hình dạng lạ (không có usage) bị BỎ QUA, không làm hỏng phép cộng.
assert.equal(sumUsage([{ type: 'status', phase: 'step_end' },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 3 } }]).input_tokens, 3);
// Event usage KHÔNG nhận diện được (type lạ, không phải cumulative) bị bỏ qua hoàn
// toàn: ta không biết nó là tăng hay tổng, nên cộng vào là đoán.
assert.equal(sumUsage([{ type: 'mystery', usage: { inputTokens: 999 } }]), null);
assert.equal(sumUsage([{ type: 'mystery', usage: { inputTokens: 999 } },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 1 } }]).input_tokens, 1);
// Trùng lặp KHÔNG có danh tính: hai event giống khít nhau bị coi là một bản ghi lặp
// (một số tăng chân thực không trùng cả payload lẫn usage một cách ngẫu nhiên).
assert.equal(sumUsage([
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10 } },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10 } },
]).input_tokens, 10);
// Trùng lặp LUỸ KẾ (final phát lại): lấy max ⇒ vẫn là tổng cuối, không nhân đôi.
assert.equal(sumUsage([
  { type: 'usage_summary', usage: { inputTokens: 100 } },
  { type: 'usage_summary', usage: { inputTokens: 100 } },
]).input_tokens, 100);
// TRỘN tăng + luỹ kế: hai nguồn được tính RIÊNG rồi mỗi khoá chọn MỘT nguồn —
// ưu tiên nguồn tăng (tổng các generation đã đo trực tiếp). KHÔNG bao giờ cộng
// hai nguồn, vì chúng chồng lấn nhau (đếm trùng).
const mixedUsage = sumUsage([
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
  { type: 'status', phase: 'step_end', generation: 'g2', usage: { inputTokens: 5 } },
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 100 } },
]);
assert.equal(mixedUsage.input_tokens, 15, 'ưu tiên nguồn tăng; không cộng hai nguồn');
// Kết quả phải ĐỘC LẬP THỨ TỰ event (luỹ kế đến trước không được thổi phồng).
assert.deepEqual(sumUsage([
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 100 } },
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
  { type: 'status', phase: 'step_end', generation: 'g2', usage: { inputTokens: 5 } },
]), mixedUsage, 'tổng không được phụ thuộc thứ tự event');
// Khoá KHÔNG có bằng chứng tăng nào ⇒ mới dùng luỹ kế cho khoá đó.
const perKeyUsage = sumUsage([
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 100, outputTokens: 7 } },
]);
assert.equal(perKeyUsage.input_tokens, 10, 'khoá có nguồn tăng ⇒ dùng nguồn tăng');
assert.equal(perKeyUsage.output_tokens, 7, 'khoá chỉ có luỹ kế ⇒ dùng luỹ kế');
// Luỹ kế báo thiếu cũng KHÔNG được hạ tổng đã đo trực tiếp.
assert.equal(sumUsage([
  { type: 'status', phase: 'step_end', generation: 'g1', usage: { inputTokens: 10 } },
  { type: 'status', phase: 'step_end', generation: 'g2', usage: { inputTokens: 5 } },
  { type: 'usage_summary', cumulative: true, usage: { inputTokens: 3 } },
]).input_tokens, 15, 'không được HẠ tổng đã đo xuống theo báo cáo luỹ kế nhỏ hơn');
// Row lấy token TỪ `sumUsage`: fixture có 10 input ⇒ row phải khớp (đã kiểm ở trên),
// và khi KHÔNG có usage nào thì token là null chứ không 0.
const noUsageRow = summarize([{ type: 'final', text: 'x' }], decisions, baseOptions);
assert.equal(noUsageRow.input_tokens, null);
assert.equal(noUsageRow.output_tokens, null);

// ------------------------------------------- operation telemetry wiring (§16)
// Telemetry bất khả ⇒ row KHÔNG được coi là thành công, và vấn đề phải HIỆN trên
// row. Nếu chỉ lặng lẽ hạ `success`, consumer vẫn đọc được metric "sạch" và kết
// luận trên dữ liệu không đáng tin.
const brokenTelemetry = [
  { type: 'boot', config: { profile: 'safe' } },
  // Vừa completed vừa cancelled ⇒ bất khả.
  { type: 'cost_governor', category: 'direct', invocation_kind: 'http_request', operation_id: 'bad-1',
    reserved_units: 1, actual_invocations: 1, completed: true, cancelled: true, failure: null, elapsed_ms: 5 },
];
assert.equal(validateOperationTelemetry(brokenTelemetry).ok, false);
const brokenRow = summarize(events, brokenTelemetry,
  { ...baseOptions, evaluation: { success: true, tests_passed: 1, tests_total: 1 } });
assert.equal(brokenRow.success, false, 'telemetry bất khả ⇒ row không được thành công');
assert.ok(brokenRow.operation_telemetry_problems.length > 0);
// Vấn đề giữ NGUYÊN hình dạng machine-readable của schema: {operation_id, problem}.
assert.ok(brokenRow.operation_telemetry_problems.some(
  (p) => p.operation_id === 'bad-1' && /completed-and-cancelled/.test(p.problem)),
  `vấn đề phải nêu đúng dạng: ${JSON.stringify(brokenRow.operation_telemetry_problems)}`);
// Telemetry NHẤT QUÁN ⇒ rỗng, và row thành công bình thường.
assert.deepEqual(row.operation_telemetry_problems, []);
assert.equal(validateOperationTelemetry(decisions).ok, true);

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

// ------------------- §21: task-capability contract PHẢI kiểm TRƯỚC khi spawn
// Task cần `failure_recovery` mà profile `safe` tắt hẳn ⇒ lần chạy `safe` KHÔNG
// BAO GIỜ đo được capability đó. Chạy tiếp chỉ tốn tiền sinh row mà analyzer buộc
// phải loại, nên collector phải DỪNG trước khi gọi model.
const recoveryTask = TASKS.find((t) => t.expected_capabilities_to_exercise.includes('failure_recovery'));
assert.ok(recoveryTask, 'catalog phải có task cần failure_recovery');
const pairs = incompatibleArmPairs([recoveryTask], ['vanilla', 'safe', 'balanced', 'experimental']);
assert.deepEqual(pairs, [{ task_id: recoveryTask.id, arm: 'safe', capability: 'failure_recovery',
  configKey: 'enableFailureRecovery' }], 'safe tắt failure_recovery ⇒ cặp không đo được');
// `vanilla` LUÔN miễn: baseline không plugin, không cần exercise gì.
assert.deepEqual(incompatibleArmPairs([recoveryTask], ['vanilla']), []);
// Task không khai capability ⇒ không cặp nào, bất kể arm.
const plainTask = TASKS.find((t) => t.expected_capabilities_to_exercise.length === 0);
assert.ok(plainTask, 'catalog phải có task không cần capability');
assert.deepEqual(incompatibleArmPairs([plainTask], ['vanilla', 'safe', 'balanced', 'experimental']), []);
// Và `collect()` phải TỪ CHỐI trước khi spawn (mặc định fail-closed), nêu rõ cặp.
await assert.rejects(
  () => collect({ output: '/tmp/nope.jsonl', taskIds: [recoveryTask.id], arms: ['vanilla', 'safe'] }),
  /Task-capability contract violated before any model call.*safe.*failure_recovery/);
// Override tường minh ⇒ đi tiếp (analyzer sẽ xử theo nhánh (B)).
const allowSrc = await readFile(new URL('../tools/collect-trajectory.mjs', import.meta.url), 'utf8');
assert.match(allowSrc, /allowIncompatibleArms/, 'collect phải nhận override tường minh');
assert.match(allowSrc, /--allow-incompatible-arms/, 'CLI phải có flag override');

// ------------------------------------------- định danh môi trường (§6, §10–12)
// `gitCommit`/`gitDirty` PHẢI trả `null` khi không đọc được — "chưa kiểm" khác
// "sạch", và gộp chúng sẽ biến môi trường không xác định thành bằng chứng tái lập.
assert.equal(gitCommit('/x', () => ({ status: 0, stdout: 'abc123\n' })), 'abc123');
assert.equal(gitCommit('/x', () => ({ status: 128, stdout: '' })), null);
assert.equal(gitCommit('/x', () => ({ status: 0, stdout: '   \n' })), null);
assert.equal(gitDirty('/x', () => ({ status: 0, stdout: ' M a.mjs\n' })), true);
assert.equal(gitDirty('/x', () => ({ status: 0, stdout: '' })), false);
assert.equal(gitDirty('/x', () => ({ status: 128, stdout: '' })), null);
// `modelEndpointOrigin`: chỉ host+path, KHÔNG bao giờ lộ key trong query/userinfo.
assert.equal(modelEndpointOrigin('http://127.0.0.1:20128/v1'), '127.0.0.1:20128/v1');
assert.equal(modelEndpointOrigin('https://api.example.com/v1/'), 'api.example.com/v1');
assert.equal(modelEndpointOrigin('https://api.example.com/v1?api_key=SECRET'), 'api.example.com/v1');
assert.equal(modelEndpointOrigin('https://user:pass@api.example.com/v1'), 'api.example.com/v1');
assert.equal(modelEndpointOrigin('ftp://api.example.com/v1'), null);
assert.equal(modelEndpointOrigin('not-a-url'), null);
assert.equal(modelEndpointOrigin(''), null);
// `evaluatorHashFor` TÍNH LẠI được từ dữ liệu task, KHÔNG phải `function.toString()`.
// Đổi một byte trong fixture ⇒ hash đổi; cùng task ⇒ hash ổn định.
assert.equal(evaluatorHashFor(task), evaluatorHashFor(task));
assert.notEqual(evaluatorHashFor(task), evaluatorHashFor({ ...task, prompt: `${task.prompt} x` }));
assert.notEqual(evaluatorHashFor(task), evaluatorHashFor({ ...task, fixture: { ...task.fixture, extra: 'x' } }));
assert.notEqual(evaluatorHashFor(task), evaluatorHashFor({ ...task, evaluator_version: 'v2' }));
// Catalog hash: đổi id/prompt/version của BẤT KỲ task nào ⇒ đổi hash.
assert.equal(taskCatalogHash([task]), taskCatalogHash([task]));
assert.notEqual(taskCatalogHash([task]), taskCatalogHash([task, TASKS.find((t) => t.id !== task.id)]));
// `dshInstallRoot` trả null hoặc một thư mục thật — không đoán.
const dshRoot = dshInstallRoot();
assert.ok(dshRoot === null || typeof dshRoot === 'string');

// ------------------------------------------- đọc git THẬT (không qua seam)
// Các ca trên dùng seam để kiểm LOGIC; ở đây gọi hàm với `spawnSync` thật để
// chứng minh đường đọc git hoạt động thật (offline, chỉ chạm repo cục bộ).
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const realCommit = gitCommit(repoRoot);
// Repo này là git checkout nên commit phải đọc được (hex), nhưng nếu môi trường
// không phải checkout thì `null` cũng hợp lệ — điều KHÔNG được phép là đoán bừa.
assert.ok(realCommit === null || /^[0-9a-f]{7,40}$/.test(realCommit),
  `commit thật phải là hex hoặc null, nhận ${realCommit}`);
// Trạng thái cây phải là boolean (repo thật) hoặc null (không phải repo) — không
// bao giờ là giá trị khác. Cây sạch hay bẩn phụ thuộc lúc chạy nên không khẳng
// định một giá trị cụ thể (sẽ đỏ trên CI sạch).
const realDirty = gitDirty(repoRoot);
assert.ok(realDirty === true || realDirty === false || realDirty === null,
  `trạng thái cây phải là boolean hoặc null, nhận ${realDirty}`);
// Thư mục không phải git repo ⇒ cả hai trả null (KHÔNG đoán, KHÔNG ném).
assert.equal(gitCommit(tmpdir()), null);
assert.equal(gitDirty(tmpdir()), null);

// ------------------------------------------- từ chối cây plugin bẩn (§6)
// Cây bẩn ⇒ mã nguồn đã chạy KHÁC commit đã khai, nên số đo không tái lập. Mặc
// định TỪ CHỐI; override tường minh mới cho ghi, và row vẫn mang cờ dirty.
const dirtyGit = (cmd, args) => {
  if (args.includes('rev-parse')) return { status: 0, stdout: 'commit-abc\n', stderr: '' };
  if (args.includes('status')) return { status: 0, stdout: ' M tools/x.mjs\n', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
};
const noCommitGit = (cmd, args) => {
  if (args.includes('rev-parse')) return { status: 128, stdout: '', stderr: 'not a repo' };
  if (args.includes('status')) return { status: 128, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
};
// Không đọc được commit ⇒ TỪ CHỐI ghi row (chốt chặn quan trọng nhất).
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', gitRun: noCommitGit }),
  /refusing to record a row that cannot be traced to a source revision/);
// Cây bẩn ⇒ TỪ CHỐI kèm hướng dẫn override.
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', gitRun: dirtyGit }),
  /dirty; refusing to record unreproducible evidence/);
await assert.rejects(() => collect({ output: '/tmp/nope.jsonl', gitRun: dirtyGit }), /--allow-dirty-plugin/);
// Nhánh "cây sạch đi qua" được chứng minh end-to-end ở khối e2e bên dưới (fakeGit
// trả `status` rỗng): ở đó collector chạy hết và ghi row với plugin_dirty_state:false.

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
  { output: 'out.jsonl', mode: 'normal', taskIds: ['a', 'b'], seeds: [1, 2], split: undefined,
    temperature: undefined, arms: undefined, overwrite: false, allowDirtyPlugin: false,
    allowIncompatibleArms: false });
// §22: người vận hành ĐƯỢC chọn tập con arm; tên sai là lỗi THAM SỐ, không im lặng.
assert.deepEqual(parseArgs(['out.jsonl', '--arms', 'vanilla,safe']).arms, ['vanilla', 'safe']);
assert.equal(parseArgs(['out.jsonl']).arms, undefined);
assert.throws(() => parseArgs(['out.jsonl', '--arms', 'nope']), /Unknown arm/);
assert.throws(() => parseArgs(['out.jsonl', '--arms', '']), /at least one arm/);
assert.throws(() => parseArgs(['out.jsonl', '--arms']), /requires a value/);
// `--temperature` phải là SỐ hữu hạn; giá trị rác là lỗi tham số, không im lặng.
assert.equal(parseArgs(['out.jsonl', '--temperature', '0.2']).temperature, 0.2);
assert.throws(() => parseArgs(['out.jsonl', '--temperature', 'hot']), /Temperature must be a finite number/);
assert.throws(() => parseArgs(['out.jsonl', '--temperature']), /Flag --temperature requires a value/);
// `--allow-dirty-plugin` là boolean: mặc định false, có mặt ⇒ true.
assert.equal(parseArgs(['out.jsonl']).allowDirtyPlugin, false);
assert.equal(parseArgs(['out.jsonl', '--allow-dirty-plugin']).allowDirtyPlugin, true);
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

// ------------------------------- snapshot CHI TIẾT + diff fail-closed (§18)
// Hash trần chỉ nói "cây đổi"; §18 đòi hỏi biết ĐỔI CÁI GÌ để caller read-only
// từ chối thành công khi có bất kỳ thay đổi nào NGOÀI tập mong đợi.
const detailTree = await mkdtemp(join(tmpdir(), 'jev-diff-'));
await mkdir(join(detailTree, 'sub'), { recursive: true });
await writeFile(join(detailTree, 'keep.txt'), 'keep\n');
await writeFile(join(detailTree, '.hidden'), 'secret\n');
const beforeDetail = snapshotWorkspaceDetail(detailTree);
// File ẩn phải được ghi nhận như entry bình thường (không lọc bỏ).
assert.ok('.hidden' in beforeDetail.entries, 'file ẩn phải có trong snapshot');
assert.equal(beforeDetail.entries['.hidden'].kind, 'file');
// TẠO file ⇒ `created`.
await writeFile(join(detailTree, 'new.txt'), 'n\n');
const createdDetail = snapshotWorkspaceDetail(detailTree);
const createdDiff = diffWorkspaces(beforeDetail, createdDetail);
assert.deepEqual(createdDiff.created, ['new.txt']);
assert.deepEqual(createdDiff.deleted, []);
assert.equal(createdDiff.changed, true);
assert.ok(createdDiff.paths.includes('new.txt'));
// XOÁ file ⇒ `deleted`.
await rm(join(detailTree, 'new.txt'));
assert.deepEqual(diffWorkspaces(beforeDetail, snapshotWorkspaceDetail(detailTree)).created, []);
await rm(join(detailTree, 'keep.txt'));
const deletedDiff = diffWorkspaces(beforeDetail, snapshotWorkspaceDetail(detailTree));
assert.deepEqual(deletedDiff.deleted, ['keep.txt']);
assert.equal(deletedDiff.changed, true);
// ĐỔI TÊN hiện ra như cặp xoá+tạo (sự thật quan sát được), KHÔNG đoán là rename.
await writeFile(join(detailTree, 'keep.txt'), 'keep\n');
await rm(join(detailTree, 'keep.txt'));
await writeFile(join(detailTree, 'renamed.txt'), 'keep\n');
const renameDiff = diffWorkspaces(beforeDetail, snapshotWorkspaceDetail(detailTree));
assert.deepEqual(renameDiff.created, ['renamed.txt']);
assert.deepEqual(renameDiff.deleted, ['keep.txt']);
// ĐỔI NỘI DUNG nhị phân (một byte) ⇒ `modified`.
await writeFile(join(detailTree, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
const binBefore = snapshotWorkspaceDetail(detailTree);
await writeFile(join(detailTree, 'bin.dat'), Buffer.from([0, 1, 2, 4]));
const binDiff = diffWorkspaces(binBefore, snapshotWorkspaceDetail(detailTree));
assert.deepEqual(binDiff.modified, ['bin.dat']);
assert.equal(binDiff.changed, true);
// ĐỔI QUYỀN ⇒ `permission_changed` (không cần nội dung đổi).
const permBefore = snapshotWorkspaceDetail(detailTree);
chmodSync(join(detailTree, 'renamed.txt'), 0o600);
const permDiff = diffWorkspaces(permBefore, snapshotWorkspaceDetail(detailTree));
assert.ok(permDiff.permission_changed.includes('renamed.txt'),
  `chmod phải hiện ra: ${JSON.stringify(permDiff)}`);
assert.ok(permDiff.paths.includes('renamed.txt'));
// ĐỔI TARGET SYMLINK ⇒ `symlink_changed`.
await symlink('renamed.txt', join(detailTree, 'ln'));
const lnBefore = snapshotWorkspaceDetail(detailTree);
await rm(join(detailTree, 'ln'));
await symlink('bin.dat', join(detailTree, 'ln'));
const lnDiff = diffWorkspaces(lnBefore, snapshotWorkspaceDetail(detailTree));
assert.deepEqual(lnDiff.symlink_changed, ['ln']);
// ĐỔI KIỂU (file → thư mục) ⇒ `type_changed`.
const typeBefore = snapshotWorkspaceDetail(detailTree);
await rm(join(detailTree, 'renamed.txt'));
await mkdir(join(detailTree, 'renamed.txt'));
const typeDiff = diffWorkspaces(typeBefore, snapshotWorkspaceDetail(detailTree));
assert.deepEqual(typeDiff.type_changed, ['renamed.txt']);
// Cây KHÔNG đổi ⇒ `changed: false` và mọi danh sách rỗng.
const same = diffWorkspaces(snapshotWorkspaceDetail(detailTree), snapshotWorkspaceDetail(detailTree));
assert.equal(same.changed, false);
assert.deepEqual(same.paths, []);
// Thêm THƯ MỤC rỗng ⇒ vẫn là thay đổi (thư mục là một phần của cây).
const dirBefore = snapshotWorkspaceDetail(detailTree);
await mkdir(join(detailTree, 'newdir'));
assert.ok(diffWorkspaces(dirBefore, snapshotWorkspaceDetail(detailTree)).created.includes('newdir'));
// PATH CONFINEMENT: symlink trỏ RA NGOÀI root phải bị bắt, dù target chưa tồn tại.
assert.equal(escapesWorkspaceRoot(detailTree, 'ln', '../outside.txt'), true);
assert.equal(escapesWorkspaceRoot(detailTree, 'ln', '/etc/passwd'), true);
assert.equal(escapesWorkspaceRoot(detailTree, 'sub/ln', 'inside.txt'), false);
assert.equal(escapesWorkspaceRoot(detailTree, 'ln', 'renamed.txt'), false);
await rm(join(detailTree, 'ln'));
await symlink('../../escape.txt', join(detailTree, 'ln'));
const escaped = confinementProblems(detailTree, snapshotWorkspaceDetail(detailTree));
assert.equal(escaped.length, 1);
assert.equal(escaped[0].path, 'ln');
// Symlink nội bộ ⇒ KHÔNG báo vi phạm.
await rm(join(detailTree, 'ln'));
await symlink('bin.dat', join(detailTree, 'ln'));
assert.deepEqual(confinementProblems(detailTree, snapshotWorkspaceDetail(detailTree)), []);
await rm(detailTree, { recursive: true, force: true });

// ------------------------------- thứ tự arm đối xứng (CONTRACT §12–13)
// Seed xoay THỨ TỰ arm (không phải seed lấy mẫu của provider). Qua N seed, mỗi arm
// phải xuất hiện ở mỗi vị trí gần như đều nhau: chênh lệch ≤ 1.
const fourArms = ['vanilla', 'safe', 'balanced', 'experimental'];
assert.deepEqual(rotationOrder(fourArms, 0), ['vanilla', 'safe', 'balanced', 'experimental']);
assert.deepEqual(rotationOrder(fourArms, 1), ['safe', 'balanced', 'experimental', 'vanilla']);
assert.deepEqual(rotationOrder(fourArms, 2), ['balanced', 'experimental', 'vanilla', 'safe']);
assert.deepEqual(rotationOrder(fourArms, 3), ['experimental', 'vanilla', 'safe', 'balanced']);
// Seed lớn hơn số arm phải quay vòng (modulo), không tràn.
assert.deepEqual(rotationOrder(fourArms, 4), rotationOrder(fourArms, 0));
const positions = new Map(fourArms.map((arm) => [arm, Array(fourArms.length).fill(0)]));
for (let seed = 0; seed < fourArms.length; seed += 1) {
  rotationOrder(fourArms, seed).forEach((arm, index) => { positions.get(arm)[index] += 1; });
}
for (const [arm, counts] of positions) {
  const spread = Math.max(...counts) - Math.min(...counts);
  assert.ok(spread <= 1, `arm ${arm} phải cân bằng qua các vị trí, lệch ${spread}`);
  assert.equal(counts.reduce((n, c) => n + c, 0), fourArms.length);
}

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
// PATH CONFINEMENT (§18): symlink thoát root ⇒ row KHÔNG được thành công, kể cả
// khi cây "không đổi" bên trong. Đây là side effect ra ngoài phạm vi fixture, và
// nó phải HIỆN thành dữ liệu (không chỉ hạ một boolean).
const escapedSnapshot = { before_hash: 'h1', after_hash: 'h1', changed: false,
  confinement_problems: [{ path: 'ln', target: '../../etc/passwd' }] };
const escapedRow = summarize(events, decisions,
  { ...baseOptions, evaluation: { success: true, tests_passed: 1, tests_total: 1 }, snapshot: escapedSnapshot });
assert.equal(escapedRow.success, false, 'symlink thoát root ⇒ row không thành công');
assert.deepEqual(escapedRow.workspace_confinement_problems, [{ path: 'ln', target: '../../etc/passwd' }]);
// Không có vi phạm ⇒ mảng rỗng (đo và không thấy), KHÔNG phải null.
assert.deepEqual(readOnlyRow.workspace_confinement_problems, []);

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
// Seam git TẤT ĐỊNH cho test offline. Chính việc chạy test này đang sửa repo, nên
// cây plugin THẬT gần như luôn bẩn; phụ thuộc trạng thái cây thật sẽ khiến test
// xanh/đỏ theo máy. `gitRun` là seam TƯỜNG MINH của collector (không phải mock code
// đang kiểm): toàn bộ logic đọc commit/dirty vẫn chạy thật, chỉ nguồn git là giả.
const fakeGit = (cmd, args) => {
  if (args.includes('rev-parse')) return { status: 0, stdout: 'e2e-plugin-commit\n', stderr: '' };
  if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: 'unknown git subcommand' };
};
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
    arms: ['vanilla', 'safe'], timeoutMs: 60_000, gitRun: fakeGit });
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
// Manifest mở rộng (§5, §22, §29): đủ trường để TỰ KIỂM bằng verifyManifestAgainstRows.
assert.equal(e2eManifest.mode, 'normal');
assert.equal(e2eManifest.collector_version, COLLECTOR_VERSION);
assert.deepEqual(e2eManifest.arms, ['vanilla', 'safe']);
assert.deepEqual([...e2eManifest.tasks].sort(), ['navigation-marker-v1', 'routine-copy-v1']);
assert.deepEqual(e2eManifest.seeds, [1]);
assert.equal(typeof e2eManifest.run_id, 'string');
// expected_rows phải suy từ arm ĐÃ CHỌN (2), không phải cả 4 arm của catalog.
assert.equal(e2eManifest.expected_rows, 2 * 1 * 2);
assert.deepEqual(verifyManifestAgainstRows(e2eRows, e2eManifest),
  { ok: true, problems: [] }, 'manifest phải qua verifyManifestAgainstRows');
// Row THẬT từ collector phải mang đủ identity mới, lấy từ git (qua seam).
for (const row of e2eRows) {
  assert.equal(row.plugin_git_commit, 'e2e-plugin-commit');
  assert.equal(row.plugin_dirty_state, false);
  assert.equal(row.cache_mode, 'cold');
  assert.equal(row.collector_version, COLLECTOR_VERSION);
  assert.equal(typeof row.evaluator_hash, 'string');
  assert.equal(row.evaluator_hash, evaluatorHashFor(taskById(row.task_id)));
  assert.equal(row.artifacts.workspace_before_sha256.length, 64);
  assert.equal(row.artifacts.workspace_after_sha256.length, 64);
  assert.equal(row.artifacts.events_sha256.length, 64);
  assert.equal(row.held_out_declaration, null);
  assert.equal(row.model_endpoint_origin, modelEndpointOrigin('http://127.0.0.1:20128/v1'));
  // Nhiệt độ không đặt ⇒ null, KHÔNG bịa 0.
  assert.equal(row.provider.temperature, null);
  assert.equal(row.provider.seed_note, SEED_NOTE);
}
// CÔ LẬP giữa các arm (§14): `routine-copy-v1` ghi copy.txt; mutation đó chỉ được
// thấy trong workspace của CHÍNH arm đó. Nếu hai arm dùng chung workspace, arm sau
// sẽ nhìn thấy file arm trước để lại và "tái lập" trở thành giả.
const routineRows = e2eRows.filter((row) => row.task_id === 'routine-copy-v1');
assert.equal(routineRows.length, 2);
const dirs = routineRows.map((row) => row.artifact_directory);
assert.equal(new Set(dirs).size, 2, 'mỗi (task, seed, arm) phải có artifact dir riêng');
// Chứng minh KHÔNG rò rỉ state: hash workspace TRƯỚC khi chạy của cả hai arm phải
// BẰNG NHAU — cùng một fixture nguyên bản. Nếu arm sau thừa hưởng copy.txt arm
// trước để lại, hash "before" của nó sẽ khác và bất biến này sập.
assert.equal(routineRows[0].artifacts.workspace_before_sha256,
  routineRows[1].artifacts.workspace_before_sha256,
  'hai arm phải khởi đầu từ fixture nguyên bản giống hệt nhau');
for (const row of routineRows) {
  assert.ok(row.artifact_directory.includes(`seed${row.seed}--${row.arm}`),
    `tên artifact phải gồm cả seed lẫn arm: ${row.artifact_directory}`);
  // Mỗi workspace có copy.txt RIÊNG do arm đó tạo; không rò rỉ sang arm khác.
  const own = await readFile(join(row.artifact_directory, 'workspace', 'copy.txt'), 'utf8');
  assert.equal(own, 'ROUTINE_SEED_42\n');
  // decisions.jsonl là log RIÊNG của từng arm. Vanilla (không plugin) KHÔNG có log;
  // arm plugin có. Sự khác biệt này tự nó chứng minh log không dùng chung.
  const logPath = join(row.artifact_directory, 'decisions.jsonl');
  if (row.arm === 'vanilla') {
    assert.equal(existsSync(logPath), false, 'arm không plugin không được có decisions.jsonl');
  } else {
    assert.ok((await readFile(logPath, 'utf8')).trim().length > 0,
      `arm ${row.arm} phải có decisions.jsonl riêng`);
  }
}
// Row navigation (read-only) không bị arm nào chạm ⇒ workspace_changed false.
for (const row of e2eRows.filter((r) => r.task_id === 'navigation-marker-v1')) {
  assert.equal(row.workspace_changed, false);
  assert.equal(row.unexpected_side_effect, false);
}

// ---------------------- split trong manifest + run_id (CONTRACT §3 A.5)
// Hai lần chạy CÙNG task/seed nhưng KHÁC split là hai lần chạy KHÁC NHAU: nếu
// `run_id` không gồm split, chúng trùng id và không ai phân biệt được pilot
// validation với bằng chứng held-out.
const e2eHeldOut = join(e2eDir, 'run-held-out.jsonl');
console.log = () => {};
try {
  await collect({ output: e2eHeldOut, taskIds: ['routine-copy-v1', 'navigation-marker-v1'], seeds: [1],
    arms: ['vanilla', 'safe'], timeoutMs: 60_000, split: 'held-out', gitRun: fakeGit });
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
  // Khai báo held-out phải có và nêu RÕ cơ sở: danh mục task, revision plugin,
  // thời điểm khai. Thiếu nó thì một row held-out không chứng minh được tính độc lập.
  assert.equal(row.held_out_declaration.declared, true);
  assert.equal(row.held_out_declaration.reason, 'operator-declared');
  assert.equal(row.held_out_declaration.plugin_commit, 'e2e-plugin-commit');
  assert.equal(row.held_out_declaration.declared_at, heldOutManifest.created_at);
  assert.equal(row.held_out_declaration.task_catalog_hash,
    taskCatalogHash(['routine-copy-v1', 'navigation-marker-v1'].map((id) => taskById(id))));
}
// Row validation (không held-out) KHÔNG được mang khai báo held-out.
assert.ok(e2eRows.every((row) => row.held_out_declaration === null));

// ---------------------- override cây bẩn tường minh (§6)
// Khi người vận hành CHỦ ĐỘNG chấp nhận, collector ghi được — nhưng row PHẢI mang
// `plugin_dirty_state:true`, và `validateRow` từ chối nó với `unreproducible-plugin-state`.
// Đây là ranh giới: override cho phép GHI, không cho phép giả vờ tái lập được.
const e2eDirty = join(e2eDir, 'run-dirty.jsonl');
console.log = () => {};
try {
  await collect({ output: e2eDirty, taskIds: ['navigation-marker-v1'], seeds: [1], arms: ['vanilla'],
    timeoutMs: 60_000, allowDirtyPlugin: true, temperature: 0.3, gitRun: dirtyGit });
} finally { console.log = realLog; }
const dirtyRows = (await readFile(e2eDirty, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(dirtyRows.length, 1);
assert.equal(dirtyRows[0].plugin_dirty_state, true);
assert.equal(dirtyRows[0].plugin_git_commit, 'commit-abc');
// Nhiệt độ TƯỜNG MINH phải chảy vào metadata provider (không bị bỏ quên trên đường).
assert.equal(dirtyRows[0].provider.temperature, 0.3);
assert.ok(validateRow(dirtyRows[0]).reasons.includes('unreproducible-plugin-state'),
  'override phải để lại cờ dirty cho consumer tự loại');

// ---------------------- thứ tự arm trong row (CONTRACT §12–13)
// `run_order` phải là hoán vị xoay của arm ĐÃ CHỌN theo seed — đủ để người đọc
// kiểm lại tính đối xứng, không chỉ tin collector.
for (const row of e2eRows) {
  assert.deepEqual(row.run_order, rotationOrder(['vanilla', 'safe'], row.seed));
  assert.equal(row.run_order.length, 2);
}

// Outage mode ép split thành `outage` bất kể người dùng truyền gì.
const e2eOutage = join(e2eDir, 'run-outage.jsonl');
process.env.TRAJECTORY_MODEL_KEY = process.env.TRAJECTORY_MODEL_KEY || 'x';
console.log = () => {};
try {
  await collect({ output: e2eOutage, taskIds: ['routine-copy-v1'], seeds: [1], arms: ['vanilla'],
    timeoutMs: 60_000, mode: 'jev-outage', split: 'held-out', gitRun: fakeGit });
} finally { console.log = realLog; }
const outageManifest = JSON.parse(await readFile(`${e2eOutage}.manifest.json`, 'utf8'));
assert.equal(outageManifest.mode, 'jev-outage');
assert.equal(outageManifest.split, 'outage');
const outageE2eRows = (await readFile(e2eOutage, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(outageE2eRows.length, 1);
assert.equal(outageE2eRows[0].split, 'outage');
assert.equal(provenance(outageE2eRows[0]), 'real');
// Outage manifest cũng phải tự-kiểm được, và expected_rows suy từ 1 arm đã chọn.
assert.equal(outageManifest.expected_rows, 1 * 1 * 1);
assert.equal(outageManifest.written_rows, 1);
assert.deepEqual(outageManifest.arms, ['vanilla']);
assert.deepEqual(verifyManifestAgainstRows(outageE2eRows, outageManifest), { ok: true, problems: [] });
// Manifest held-out cũng qua verifyManifestAgainstRows (run_id, split, tasks, seeds khớp).
assert.deepEqual(verifyManifestAgainstRows(heldOutE2eRows, heldOutManifest), { ok: true, problems: [] });
// Hết khối e2e mới khôi phục môi trường (PATH có `dsh` giả + các biến probe).
for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
delete process.env.TRAJECTORY_MODEL_KEY;
await rm(e2eDir, { recursive: true, force: true });

console.log('PASS trajectory collector contract (real functions, offline, no API calls)');
