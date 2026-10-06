/**
 * §34 — Bộ ĐỐI KHÁNG: 35 phản-ví-dụ phải bị chặn khỏi `eligible-for-review`.
 *
 * Vì sao cần: mọi suite khác kiểm "đường đúng chạy được". Suite này kiểm điều
 * ngược lại — dữ liệu GIẢ/BỎ DỞ/TRỘN/HỎNG có thể trôi qua promotion hay không.
 * Mỗi mục tự dựng counterexample, chạy hàm THẬT (`matrix`/`promotion`/
 * `validateRow`/`validateOperationTelemetry`) rồi khẳng định:
 *   - KHÔNG arm treatment nào đạt `eligible-for-review`, VÀ
 *   - lý do nêu ra đúng loại (không gọi môi trường invalid là `*-regression`).
 *
 * Không mock. Offline, tất định.
 */
import assert from 'node:assert/strict';
import { CAPABILITY_SPECS, promotionMetrics, validateOperationTelemetry,
  validateRow } from '../tools/trajectory-schema.mjs';
import { matrix } from '../tools/trajectory-matrix.mjs';
import { makeRow, healthyHeldOut, manifestFor, encode, analyze,
  SYNTHETIC_INTEGRITY } from '../tools/trajectory-fixture.mjs';

const TREATMENTS = ['safe', 'balanced', 'experimental'];
let checked = 0;

/** Chạy analyzer thật trên JSONL; khẳng định không arm nào eligible. */
function assertNotEligible(text, label, options = {}) {
  const report = matrix(text, { runIntegrity: options.runIntegrity ?? null, ...options.matrix });
  for (const arm of TREATMENTS) {
    const verdict = report.promotion[arm];
    if (!verdict) continue;
    assert.notEqual(verdict.status, 'eligible-for-review',
      `[${label}] ${arm} KHÔNG được eligible-for-review (reasons: ${verdict.reasons.join(', ')})`);
    assert.equal(verdict.automatic_promotion, false, `[${label}] ${arm} không tự động promote`);
  }
  checked += 1;
  return report;
}

/** Khẳng định một phép kiểm tầng row bắt được lý do mong đợi. */
function assertRowRejected(row, label, reason) {
  const check = validateRow(row);
  assert.equal(check.ok, false, `[${label}] row phải bị validateRow từ chối`);
  assert(check.reasons.some((entry) => entry === reason || entry.startsWith(`${reason}:`)),
    `[${label}] phải nêu lý do "${reason}", nhận: ${check.reasons.join(', ')}`);
  checked += 1;
}

/** Dataset "khỏe" làm nền, có run-integrity hợp lệ để không bị chặn vì manifest. */
function healthyText(overrides = {}) {
  const rows = healthyHeldOut({ overrides });
  return { rows, text: encode(rows) };
}

// ─────────────────────────────────────────────────────────────── nhóm A: capability
// 1. Task khai cần exercise capability `x` mà manifest THIẾU hẳn entry `x`.
{
  const rows = healthyHeldOut({ overrides: { expected_capabilities_to_exercise: ['jevgrep'] } });
  const broken = rows.map((row) => (row.arm === 'vanilla' ? row
    : { ...row, capabilities: { ...row.capabilities, jevgrep: undefined } }));
  const report = assertNotEligible(encode(broken), 'capability-missing-entry');
  assert(report.promotion.experimental.reasons.includes('incomplete-capability-evidence'),
    'thiếu entry capability ⇒ thiếu bằng chứng (không phải regression)');
}
// 2. Treatment khai cần capability nhưng `configured:false` (chưa bật lớp).
{
  const overrides = { expected_capabilities_to_exercise: ['jevgrep'],
    capabilities: undefined };
  const rows = healthyHeldOut().map((row) => (row.arm === 'vanilla' ? row
    : { ...row, expected_capabilities_to_exercise: ['jevgrep'],
      capabilities: { ...row.capabilities, jevgrep: { configured: false, available: false, invoked: false } } }));
  const report = assertNotEligible(encode(rows), 'capability-not-configured');
  assert(report.promotion.experimental.reasons.includes('invalid-or-incomplete-capability-environment'),
    'treatment chưa cấu hình lớp task yêu cầu ⇒ môi trường invalid');
  assert(!report.promotion.experimental.reasons.some((reason) => /-regression$/.test(reason)),
    'môi trường invalid KHÔNG được gọi là regression');
  void overrides;
}
// 3. `available:null` (chưa chứng minh) không được coi là đạt.
{
  const rows = healthyHeldOut().map((row) => (row.arm === 'vanilla' ? row
    : { ...row, expected_capabilities_to_exercise: ['jevgrep'],
      capabilities: { ...row.capabilities, jevgrep: { configured: true, available: null, invoked: false } } }));
  const report = assertNotEligible(encode(rows), 'capability-available-unknown');
  assert(report.promotion.experimental.reasons.includes('incomplete-capability-evidence'));
}
// 4. `available:true` nhưng CHƯA chứng minh đã chạy (`exercised !== true`).
{
  const rows = healthyHeldOut().map((row) => (row.arm === 'vanilla' ? row
    : { ...row, expected_capabilities_to_exercise: ['jevgrep'],
      capabilities: { ...row.capabilities, jevgrep: { configured: true, available: true, invoked: true, exercised: false } } }));
  const report = assertNotEligible(encode(rows), 'capability-not-exercised');
  assert(report.promotion.experimental.reasons.includes('incomplete-capability-evidence'),
    'available≠exercised: chưa chạy thật ⇒ thiếu bằng chứng');
  checked += 1; // đối chứng: `exercised:true` thì mới qua
  const okRows = healthyHeldOut().map((row) => (row.arm === 'vanilla' ? row
    : { ...row, expected_capabilities_to_exercise: ['jevgrep'],
      capabilities: { ...row.capabilities, jevgrep: { configured: true, available: true, invoked: true, exercised: true } } }));
  const ok = analyze(encode(okRows), { runIntegrity: undefined, manifest: manifestFor(okRows) });
  assert.equal(ok.promotion.experimental.status, 'eligible-for-review',
    'đối chứng: đã exercise thật thì được eligible');
}

// ─────────────────────────────────────────────────────── nhóm B: hash / cấu hình
// 5. Hash profile bị GIẢ MẠO (không tính lại được từ `profile_config`).
{
  const row = makeRow('experimental', { profile_config_hash: 'f'.repeat(64) });
  assertRowRejected(row, 'tampered-profile-hash', 'profile-config-hash-mismatch');
}
// 6. ĐỔI một khoá hành vi RUNTIME trong `profile_config` nhưng GIỮ hash cũ.
//    Đây là lỗ "đổi config mà hash không đổi": trước đây chỉ 22/76 khoá runtime
//    được hash, nên sửa `reviewTimeoutMs` (hay `jevMaxCallsPerTurn`, ...) KHÔNG
//    làm hash đổi ⇒ hai treatment khác nhau bị ghép cặp như một. Nay mọi khoá
//    hành vi đều vào hash, nên một row sửa config mà quên hash PHẢI bị từ chối.
{
  const base = makeRow('experimental');
  for (const key of ['reviewTimeoutMs', 'jevMaxCallsPerTurn', 'completionThreshold',
    'gateVerdictCacheMax', 'jevGrepMaxConcurrentGlobal']) {
    const tampered = { ...base, profile_config: { ...base.profile_config, [key]: 999 } };
    assertRowRejected(tampered, `runtime-config-changed-hash-stale:${key}`, 'profile-config-hash-mismatch');
  }
  // Đối chứng: hash ĐÚNG theo config mới ⇒ row hợp lệ (đổi config là đổi treatment,
  // không phải lỗi), nên không được "chặn quá tay".
  const fresh = makeRow('experimental', { profile_config: { profile: 'experimental', reviewTimeoutMs: 999 } });
  assert.equal(validateRow(fresh).ok, true, 'config đổi KÈM hash đúng phải hợp lệ (là treatment khác)');
  checked += 1;
}

// ────────────────────────────────────────────────────────── nhóm C: manifest / run
// 7. Không có manifest cho dữ liệu `real`.
{
  assertNotEligible(encode(healthyHeldOut()), 'missing-manifest');
}
// 8. Manifest "cũ": khai `written_rows` khác số row thật trong file.
{
  const rows = healthyHeldOut();
  const manifest = manifestFor(rows, { written_rows: rows.length - 1 });
  assertNotEligible(encode(rows), 'stale-manifest', { matrix: { manifest } });
}
// 9. Manifest `complete` nhưng THIẾU số row (không khai counts).
{
  const rows = healthyHeldOut();
  const manifest = manifestFor(rows);
  delete manifest.expected_rows;
  delete manifest.written_rows;
  assertNotEligible(encode(rows), 'manifest-missing-counts', { matrix: { manifest } });
}
// 10. `run_id` trong manifest KHÁC `run_id` của row.
{
  const rows = healthyHeldOut();
  const manifest = manifestFor(rows, { run_id: 'other-run' });
  assertNotEligible(encode(rows), 'manifest-run-id-mismatch', { matrix: { manifest } });
}
// 11. Trộn hai `run_id` khác nhau trong cùng một dataset ⇒ nhóm bất nhất.
{
  const rows = healthyHeldOut().map((row, index) => (index % 8 === 0 ? { ...row, run_id: 'run-b' } : row));
  const report = assertNotEligible(encode(rows), 'mixed-run-id', { matrix: { manifest: manifestFor(rows) } });
  assert(report.inconsistent_groups > 0, 'trộn run_id phải làm nhóm bất nhất');
}
// 12. Trộn `split` (held-out vs validation) trong cùng nhóm.
{
  const rows = healthyHeldOut().map((row, index) => (index % 4 === 0 ? { ...row, split: 'validation' } : row));
  const report = assertNotEligible(encode(rows), 'mixed-split', { matrix: { manifest: manifestFor(rows) } });
  assert(report.inconsistent_groups > 0, 'trộn split phải làm nhóm bất nhất');
}
// 13. Trộn `mode` (normal vs jev-outage).
{
  const rows = healthyHeldOut().map((row, index) => (index % 4 === 0 ? { ...row, mode: 'jev-outage' } : row));
  assertNotEligible(encode(rows), 'mixed-mode', { matrix: { manifest: manifestFor(rows) } });
}
// 14. Trộn `plugin_git_commit` — hai revision khác nhau không phải một treatment.
{
  const rows = healthyHeldOut().map((row, index) => (index % 8 === 0 ? { ...row, plugin_git_commit: 'c'.repeat(40) } : row));
  assertNotEligible(encode(rows), 'mixed-plugin-commit', { matrix: { manifest: manifestFor(rows) } });
}
// 15. Cây nguồn DIRTY ⇒ bằng chứng không tái lập được.
{
  const row = makeRow('experimental', { source: 'real', plugin_dirty_state: true });
  assertRowRejected(row, 'dirty-plugin-state', 'unreproducible-plugin-state');
}
// 16. Trùng arm trong cùng một cặp (identity) ⇒ dữ liệu bị trộn.
{
  const rows = healthyHeldOut();
  const duplicated = [...rows, rows[1]];
  const report = assertNotEligible(encode(duplicated), 'duplicate-arm-in-pair',
    { matrix: { manifest: manifestFor(rows) } });
  assert(report.rejected.some((entry) => entry.reason === 'duplicate-arm-in-pair'),
    'trùng arm phải bị loại tường minh');
}
// 17. Trùng cả row (lặp nguyên văn).
{
  const rows = healthyHeldOut();
  const report = assertNotEligible(encode([...rows, rows[0], rows[0]]), 'duplicate-row',
    { matrix: { manifest: manifestFor(rows) } });
  assert(report.rejected.some((entry) => entry.reason === 'duplicate-arm-in-pair'));
}
// 18. Một dòng JSONL HỎNG (không parse được).
{
  const rows = healthyHeldOut();
  const text = `${encode(rows)}\n{ this is not json`;
  const report = assertNotEligible(text, 'invalid-json-line', { matrix: { manifest: manifestFor(rows) } });
  assert(report.rejected.some((entry) => entry.reason === 'invalid-json'),
    'dòng hỏng phải bị loại với lý do invalid-json');
}
// 18b. §28: một dòng PHÌNH BẤT THƯỜNG (artifact bị nhúng nguyên vào row) phải bị
// TỪ CHỐI tường minh, không được parse im lặng như row bình thường.
{
  const rows = healthyHeldOut();
  const oversized = JSON.stringify(makeRow('experimental', { detail: 'x'.repeat(300000) }));
  const report = assertNotEligible(`${encode(rows)}\n${oversized}`, 'oversized-row',
    { matrix: { manifest: manifestFor(rows) } });
  assert(report.rejected.some((entry) => entry.reason === 'oversized-row'),
    'dòng vượt MAX_ROW_BYTES phải bị loại với lý do oversized-row');
}
// 19. Schema KHÔNG hỗ trợ (v1 cũ).
{
  const rows = healthyHeldOut().map((row) => ({ ...row, schema: 'dsh-jev-gate-trajectory-v1' }));
  const report = assertNotEligible(encode(rows), 'unsupported-schema', { matrix: { manifest: manifestFor(rows) } });
  assert(report.rejected.some((entry) => entry.reason.startsWith('unsupported-schema')),
    'schema lạ phải bị từ chối tường minh');
}
// 20. Thiếu trường định danh ghép cặp (ví dụ `dsh_version`).
{
  const row = makeRow('experimental', { dsh_version: undefined });
  delete row.dsh_version;
  assertRowRejected(row, 'missing-identity-field', 'incomplete-pair-identity');
}
// 21. Metric ÂM.
{
  assertRowRejected(makeRow('experimental', { walltime_ms: -1 }), 'negative-metric', 'invalid-metric:walltime_ms');
}
// 22. Metric KHÔNG HỮU HẠN (Infinity / NaN). JSON không mang được NaN nên thử trực tiếp.
{
  const inf = makeRow('experimental', { walltime_ms: Infinity });
  assertRowRejected(inf, 'infinite-metric', 'invalid-metric:walltime_ms');
  const nan = makeRow('experimental', { walltime_ms: Number.NaN });
  assertRowRejected(nan, 'nan-metric', 'invalid-metric:walltime_ms');
}
// 23. Metric an toàn trên task KHÔNG khai trục safety ⇒ tự mâu thuẫn.
{
  assertRowRejected(makeRow('experimental', { false_allow: 0 }), 'safety-metric-on-non-safety-task',
    'safety-metric-on-non-safety-task');
}
// 24. Task CÓ trục safety nhưng THIẾU số đo an toàn ⇒ hold (không eligible).
{
  const rows = healthyHeldOut({ overrides: { measurement_axes: { quality: true, performance: true, safety: true } } })
    .map((row) => (row.arm === 'vanilla' ? row : { ...row, false_allow: null, false_deny: null }));
  const report = assertNotEligible(encode(rows), 'missing-safety-measurement',
    { matrix: { manifest: manifestFor(rows) } });
  assert(report.promotion.experimental.reasons.includes('missing-safety-measurements'),
    'thiếu số đo an toàn ⇒ hold với lý do riêng');
}
// 25. `evaluator_hash` khác nhau giữa hai lần chạy ⇒ không pool làm một treatment.
{
  const rows = healthyHeldOut().map((row, index) => (index % 8 === 0 ? { ...row, evaluator_hash: 'd'.repeat(64) } : row));
  assertNotEligible(encode(rows), 'evaluator-version-mismatch', { matrix: { manifest: manifestFor(rows) } });
}
// 26. `repo_state` (hash định nghĩa task/fixture) khác ⇒ không phải cùng task.
{
  const rows = healthyHeldOut().map((row, index) => (index % 8 === 0 ? { ...row, repo_state: 'other-state' } : row));
  assertNotEligible(encode(rows), 'task-definition-hash-mismatch', { matrix: { manifest: manifestFor(rows) } });
}
// 27. Run THIẾU arm (chỉ vanilla+safe) nhưng manifest khai đủ 4 arm.
{
  const rows = healthyHeldOut().filter((row) => row.arm === 'vanilla' || row.arm === 'safe');
  const manifest = manifestFor(rows, { arms: ['vanilla', 'safe', 'balanced', 'experimental'] });
  const report = assertNotEligible(encode(rows), 'partial-arm-run', { matrix: { manifest } });
  assert(report.run_integrity.verified === false,
    'manifest khai 4 arm nhưng dataset chỉ có 2 ⇒ run integrity KHÔNG xác minh được');
  assert(report.promotion.safe.reasons.includes('unverified-run-integrity'),
    'thiếu arm so với manifest ⇒ hold với lý do run integrity');
  // Đối chứng §22: run CHỈ 2 arm là hợp lệ NẾU manifest khai đúng subset đó.
  const subsetManifest = manifestFor(rows);
  const subsetReport = matrix(encode(rows), { manifest: subsetManifest });
  assert.equal(subsetReport.run_integrity.verified, true,
    'manifest khai đúng 2 arm đã chọn ⇒ integrity verified');
  assert.equal(subsetReport.promotion.safe.status, 'eligible-for-review',
    'run 2 arm với manifest trung thực vẫn đánh giá được safe vs vanilla');
}
// 28. `expected_rows` SAI so với số row thật.
{
  const rows = healthyHeldOut();
  const manifest = manifestFor(rows, { expected_rows: rows.length + 4 });
  assertNotEligible(encode(rows), 'wrong-expected-rows', { matrix: { manifest } });
}
// 29. Manifest khai SAI tập arm đã chọn.
{
  const rows = healthyHeldOut();
  const manifest = manifestFor(rows, { arms: ['vanilla', 'safe'] });
  assertNotEligible(encode(rows), 'wrong-selected-arms', { matrix: { manifest } });
}
// 30. Endpoint model KHÁC nhau giữa các arm ⇒ không cùng môi trường.
{
  const rows = healthyHeldOut().map((row, index) => (index % 4 === 0
    ? { ...row, model_endpoint_origin: 'https://other.example/v1' } : row));
  assertNotEligible(encode(rows), 'provider-endpoint-mismatch', { matrix: { manifest: manifestFor(rows) } });
}

// ───────────────────────────────────────────────── nhóm D: operation / token telemetry
// 31. Hai sự kiện kết thúc mâu thuẫn cho CÙNG một operation.
{
  const decisions = [
    { type: 'cost_governor', operation_id: 'op1', decision: 'reserved_cost', actual_invocations: 1 },
    { type: 'cost_governor', operation_id: 'op1', decision: 'operation_finished', completed: true, cancelled: true },
  ];
  const result = validateOperationTelemetry(decisions);
  assert.equal(result.ok, false, '[op-telemetry-conflict] completed+cancelled phải bị bắt');
  assert(result.problems.some((entry) => entry.problem === 'completed-and-cancelled'));
  checked += 1;
  // Và một row mang telemetry hỏng KHÔNG được coi là thành công.
  const row = makeRow('experimental', { operations: { reserved_units: 1, actual_invocations: 1 },
    operation_telemetry_problems: result.problems });
  const report = assertNotEligible(encode([row]), 'op-telemetry-conflict-row');
  assert(report.promotion.experimental.status !== 'eligible-for-review');
}
// 32. Operation ĐÃ gọi thật nhưng THIẾU sự kiện kết thúc.
{
  const decisions = [
    { type: 'cost_governor', operation_id: 'op2', decision: 'reserved_cost', actual_invocations: 0 },
    { type: 'cost_governor', operation_id: 'op2', decision: 'actual_invocation', actual_invocations: 2 },
  ];
  const result = validateOperationTelemetry(decisions);
  assert.equal(result.ok, false, '[op-telemetry-no-terminal] thiếu terminal phải bị bắt');
  assert(result.problems.some((entry) => entry.problem === 'missing-terminal-event'));
  checked += 1;
}
// 33. Token usage BẤT NHẤT: tổng đã dùng mà số lần gọi giảm / giá trị âm.
{
  const negative = validateOperationTelemetry([
    { type: 'cost_governor', operation_id: 'op3', decision: 'reserved_cost', actual_invocations: 1 },
    { type: 'cost_governor', operation_id: 'op3', decision: 'operation_finished', elapsed_ms: -5, completed: true },
  ]);
  assert.equal(negative.ok, false, '[token-telemetry-inconsistent] elapsed âm phải bị bắt');
  assert(negative.problems.some((entry) => entry.problem === 'negative-elapsed-ms'));
  // Số lần gọi GIẢM giữa hai emit (đếm lùi) cũng là bất khả.
  const decreasing = validateOperationTelemetry([
    { type: 'cost_governor', operation_id: 'op4', decision: 'actual_invocation', actual_invocations: 3 },
    { type: 'cost_governor', operation_id: 'op4', decision: 'actual_invocation', actual_invocations: 1 },
  ]);
  assert.equal(decreasing.ok, false, '[token-telemetry-decreasing] đếm lùi phải bị bắt');
  assert(decreasing.problems.some((entry) => entry.problem === 'actual-invocations-decreased'));
  checked += 1;
}
// 33b. ROW mang `operation_telemetry_problems` phải bị `validateRow` TỪ CHỐI, và
//      dataset chứa row đó KHÔNG được promotion. Đây là lỗ fail-open thật đã bị
//      bắt ở đợt audit §40: collector GHI field này nhưng analyzer trước đây
//      KHÔNG đọc, nên row telemetry hỏng vẫn đi tới `eligible-for-review`.
{
  const problems = [{ operation_id: 'op9', problem: 'completed-with-failure' }];
  assertRowRejected(makeRow('experimental', { operation_telemetry_problems: problems }),
    'op-telemetry-problems-row', 'operation-telemetry-inconsistent');
  const rows = healthyHeldOut();
  const broken = rows.map((row) => (row.arm === 'experimental'
    ? { ...row, operation_telemetry_problems: problems } : row));
  const report = assertNotEligible(encode(broken), 'op-telemetry-problems-dataset',
    { matrix: { manifest: manifestFor(broken) } });
  // §23: lỗi ở experimental KHÔNG được làm safe/balanced mất tư cách.
  assert.equal(report.promotion.experimental.status, 'hold');
}

// ───────────────────────────────────────────── nhóm E: workspace / side-effect
// 34 + 35. Thoát khỏi workspace (symlink ra ngoài) và side-effect NGOÀI tập mong đợi.
//     Hai hành vi này được evaluator của task chịu trách nhiệm phát hiện; ở tầng
//     analyzer, một row khai `unexpected_side_effect` phải khiến nhóm không eligible.
{
  const rows = healthyHeldOut().map((row) => (row.arm === 'vanilla' ? row
    : { ...row, success: false, tests_passed: 0, unexpected_side_effect: true }));
  const report = assertNotEligible(encode(rows), 'unexpected-side-effect',
    { matrix: { manifest: manifestFor(rows) } });
  assert.equal(report.promotion.experimental.status, 'regression',
    'side-effect ngoài mong đợi là hồi quy chất lượng thật, không chỉ hold');
}
// Đối chứng: bộ đo KHÔNG được "chặn quá tay" một dataset thật sự hợp lệ.
{
  const rows = healthyHeldOut();
  const report = matrix(encode(rows), { manifest: manifestFor(rows) });
  assert.equal(report.promotion.experimental.status, 'eligible-for-review',
    'đối chứng: dataset hợp lệ phải đạt eligible-for-review');
  assert.equal(report.run_integrity.verified, true, 'đối chứng: manifest khớp ⇒ integrity verified');
  checked += 1;
}

// 36. §4 "CLI chặt / library hở": override `runIntegrity` do CALLER truyền KHÔNG
//     được phép ghi đè bất nhất manifest đã phát hiện. Lỗ thật đã bắt ở audit §40:
//     dataset có manifest bị sửa vẫn `eligible-for-review` chỉ vì caller truyền
//     `{verified:true, source:'synthetic-fixture'}` — override nuốt mất problems.
{
  const rows = healthyHeldOut();
  const text = encode(rows);
  // 36a. manifest SAI run_id + override synthetic-fixture ⇒ vẫn phải hold.
  const badRunId = matrix(text, {
    manifest: manifestFor(rows, { run_id: 'other-run' }), runIntegrity: SYNTHETIC_INTEGRITY,
  });
  for (const arm of TREATMENTS) {
    assert.notEqual(badRunId.promotion[arm].status, 'eligible-for-review',
      `[integrity-override-tampered-manifest] ${arm}: override KHÔNG được cứu manifest sai run_id`);
  }
  assert(badRunId.run_integrity.problems.includes('manifest-run-id-mismatch'),
    'bất nhất manifest vẫn phải hiện trong run_integrity.problems');
  // 36b. manifest khai thiếu arm + override ⇒ vẫn phải hold.
  const badArms = matrix(text, {
    manifest: manifestFor(rows, { arms: ['vanilla', 'safe'] }), runIntegrity: SYNTHETIC_INTEGRITY,
  });
  assert.equal(badArms.promotion.experimental.status, 'hold',
    '[integrity-override-manifest-arms] khai thiếu arm ⇒ hold dù có override');
  // 36c. manifest `status:'incomplete'` + override ⇒ vẫn phải hold.
  const badStatus = matrix(text, {
    manifest: manifestFor(rows, { status: 'incomplete' }), runIntegrity: SYNTHETIC_INTEGRITY,
  });
  assert.equal(badStatus.promotion.experimental.status, 'hold',
    '[integrity-override-manifest-status] manifest chưa hoàn tất ⇒ hold dù có override');
  // 36d. override nguồn LẠ (`{verified:true, source:'bogus'}`) không phải bằng chứng.
  const bogus = matrix(text, { runIntegrity: { verified: true, source: 'bogus' } });
  assert.equal(bogus.promotion.experimental.status, 'hold',
    '[integrity-override-unknown-source] nguồn integrity lạ ⇒ không xác minh được');
  assert(bogus.promotion.experimental.reasons.includes('unverified-run-integrity'),
    'nguồn integrity lạ phải nêu `unverified-run-integrity`');
  // 36e. override TRẦN `{verified:true}` (không nguồn) cũng không phải bằng chứng.
  const bare = matrix(text, { runIntegrity: { verified: true } });
  assert.equal(bare.promotion.experimental.status, 'hold',
    '[integrity-override-bare] `{verified:true}` trần không có `source` ⇒ hold');
  // Đối chứng: override synthetic-fixture trên dataset KHÔNG manifest vẫn hợp lệ
  // (đây là đường fixture dùng), nên siết trên không chặn oan fixture.
  const syntheticOk = matrix(encode(healthyHeldOut()), { runIntegrity: SYNTHETIC_INTEGRITY });
  assert.equal(syntheticOk.promotion.experimental.status, 'eligible-for-review',
    'đối chứng: fixture synthetic hợp lệ vẫn eligible');
  checked += 6;
}

// ────────────────────────────────────────────────────────── meta: bảng lý do đủ dùng
{
  // Mọi metric khai trong `promotionMetrics()` phải có `axis` hợp lệ — nếu thêm
  // metric mới mà quên phân loại, bảng đối kháng ở trên sẽ mù với nó.
  for (const [key, spec] of Object.entries(promotionMetrics())) {
    assert(['quality', 'performance', 'safety'].includes(spec.axis), `${key} phải có axis hợp lệ`);
    assert(typeof spec.required === 'boolean', `${key} phải khai required rõ ràng`);
  }
  // Mọi capability trong CAPABILITY_SPECS phải có `name` duy nhất (bảng dùng làm khoá).
  const names = CAPABILITY_SPECS.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length, 'tên capability phải duy nhất');
  checked += 2;
}

console.log(`PASS trajectory adversarial (${checked} counterexamples, real functions, offline)`);
