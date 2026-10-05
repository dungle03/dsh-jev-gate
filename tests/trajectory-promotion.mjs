/**
 * Hợp đồng OFFLINE cho matrix + promotion — chạy hàm THẬT, không mạng.
 *
 * Bảo vệ các luật đã từng bị vi phạm:
 *   - ghép cặp theo identity ĐẦY ĐỦ (config/dsh/plugin), không chỉ task+seed;
 *   - môi trường capability KHÔNG hợp lệ ⇒ hold (không phải regression);
 *   - promotion KHÔNG BAO GIỜ tự động; trần là `eligible-for-review`;
 *   - row sai schema bị TỪ CHỐI tường minh, không hiểu nhầm thành row mới;
 *   - metric thiếu vẫn `null`, KHÔNG tự thành 0.
 */
import assert from 'node:assert/strict';
import { ARMS, matrix, promotion } from '../tools/trajectory-matrix.mjs';
import { capabilityValidity, MATRIX_SCHEMA, ROW_SCHEMA, validateRow } from '../tools/trajectory-schema.mjs';

const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const jg = (available, invoked) => ({ jevgrep: { configured: true, available, invoked } });
const jev = () => ({ jev: { configured: true, available: true, invoked: true } });

/** 10 nhóm held-out thật, 2 lớp task, cấu hình arm khác nhau như thật. */
const baseRow = (arm, seed, overrides = {}) => ({
  schema: ROW_SCHEMA,
  task_id: `fixture-${seed}`,
  task_class: seed < 5 ? 'routine' : 'bug-diagnosis',
  seed, repo_state: 'fixture-state', model: 'trajectory-router/fixture',
  dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
  benchmark_config_hash: 'harness-hash',
  arm, source: 'real', split: 'held-out', mode: 'normal',
  profile: arm === 'vanilla' ? null : arm,
  profile_config: arm === 'vanilla' ? null : { profile: arm },
  profile_config_hash: arm === 'vanilla' ? null : `profile-hash-${arm}`,
  capabilities: arm === 'experimental' ? jg(true, true) : jev(),
  operations: { reserved_units: 1, actual_invocations: 1 },
  success: true, tests_passed: 1, tests_total: 1,
  walltime_ms: 100, cost_usd: 1, false_allow: 0, false_deny: 0,
  ...overrides,
});
const healthy = (overrides = {}) => Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => baseRow(arm, seed, overrides[arm] ?? {}))).flat();

// ------------------------------------------------------------------ happy path
const report = matrix(encode(healthy()));
assert.equal(report.schema, MATRIX_SCHEMA);
assert.equal(report.row_schema, ROW_SCHEMA);
assert.equal(report.complete_groups, 10);
assert.equal(report.held_out_real_groups, 10);
assert.equal(report.verdict, 'unknown', 'analyzer must never declare a benefit verdict');
assert.equal(report.promotion.experimental.status, 'eligible-for-review');
assert.equal(report.promotion.experimental.automatic_promotion, false);
// Bằng chứng validation (không phải held-out) KHÔNG đủ để promote.
const validation = matrix(encode(healthy().map((row) => ({ ...row, split: 'validation' }))));
assert.equal(validation.promotion.experimental.status, 'hold');
assert(validation.promotion.experimental.reasons.includes('insufficient-held-out-pairs'));
// Synthetic cũng không đủ.
assert.equal(matrix(encode(healthy().map((row) => ({ ...row, source: 'synthetic' })))).promotion.experimental.status, 'hold');

// ------------------------------------------------- capability environment
// jg thiếu ở arm experimental ⇒ hold với lý do capability, KHÔNG phải regression,
// dù experimental chậm hơn hẳn (nếu tính là regression thì đã sai).
const invalid = matrix(encode(healthy({ experimental: { walltime_ms: 999, capabilities: jg(false, false) } })));
const invalidPromotion = invalid.promotion.experimental;
assert.equal(invalidPromotion.status, 'hold');
assert(invalidPromotion.reasons.includes('invalid-or-incomplete-capability-environment'));
assert(!invalidPromotion.reasons.includes('performance-regression'));
assert.equal(invalidPromotion.held_out_pairs, 0, 'invalid-capability groups must not count as held-out pairs');
assert.equal(invalidPromotion.invalid_capability_groups, 10);
// available === null (chưa chứng minh) cũng KHÔNG được coi là đạt.
const unknownCap = matrix(encode(healthy({ experimental: { capabilities: jg(null, false) } })));
assert(unknownCap.promotion.experimental.reasons.includes('incomplete-capability-evidence'));
assert.equal(unknownCap.promotion.experimental.held_out_pairs, 0);
// available === true nhưng chưa từng chạy (invoked false) vẫn hợp lệ để ĐO,
// nhưng không được coi là "đã dùng" — kiểm ở manifest.
assert.equal(capabilityValidity(baseRow('experimental', 0, { capabilities: jg(true, false) })).valid, true);

// ------------------------------------------------------- regressions
assert.equal(matrix(encode(healthy({ experimental: { false_allow: 1 } }))).promotion.experimental.status, 'regression');
assert.equal(matrix(encode(healthy({ experimental: { false_deny: 1 } }))).promotion.experimental.status, 'regression');
assert.equal(matrix(encode(healthy({ experimental: { success: false, tests_passed: 0 } }))).promotion.experimental.status, 'regression');
// Chậm/tốn hơn chỉ là hold (không đủ để gọi là regression an toàn).
assert.equal(matrix(encode(healthy({ experimental: { walltime_ms: 200 } }))).promotion.experimental.status, 'hold');
assert(matrix(encode(healthy({ experimental: { walltime_ms: 200 } }))).promotion.experimental.reasons
  .includes('performance-regression'));

// ------------------------------------------------- metric thiếu vẫn null
const missing = matrix(encode(healthy({ experimental: { cost_usd: null, false_allow: null } })));
assert.equal(missing.promotion.experimental.status, 'hold');
assert(missing.promotion.experimental.reasons.includes('missing-required-measurements'));
assert.equal(missing.arms.experimental.metrics.cost_usd, null, 'missing cost must stay null, not 0');
assert.equal(missing.arms.experimental.metrics.false_allow, null);

// ------------------------------------------------------- identity / schema
// Khác plugin_version ⇒ KHÔNG ghép cặp (không so hai runtime khác nhau).
const crossVersion = healthy().map((row) => row.arm === 'experimental' ? { ...row, plugin_version: '0.15.0' } : row);
assert.equal(matrix(encode(crossVersion)).complete_groups, 0);
// Cùng tên arm nhưng config KHÁC NHAU giữa các nhóm ⇒ hai treatment khác nhau,
// KHÔNG được gộp làm một bằng chứng.
const crossConfig = healthy().map((row) => row.arm === 'experimental' && row.seed >= 5
  ? { ...row, profile_config_hash: 'other' } : row);
const crossConfigReport = matrix(encode(crossConfig));
assert.equal(crossConfigReport.complete_groups, 10, 'groups still form; the problem is pooled treatment identity');
assert.equal(crossConfigReport.promotion.experimental.status, 'hold');
assert(crossConfigReport.promotion.experimental.reasons.includes('inconsistent-arm-configuration'));
// Thiếu dsh_version ⇒ incomplete, không tạo nhóm.
const noDsh = healthy().map((row) => { const copy = { ...row }; delete copy.dsh_version; return copy; });
const noDshReport = matrix(encode(noDsh));
assert.equal(noDshReport.complete_groups, 0);
assert(noDshReport.incomplete.length > 0);
// Schema v1 bị TỪ CHỐI tường minh.
const v1 = matrix(encode([{ schema: 'trajectory-matrix-v1', task_id: 'x', arm: 'safe' }]));
assert(v1.rejected.some((entry) => /unsupported-schema/.test(entry.reason)));
// Duplicate cùng arm + identity ⇒ vứt cả nhóm.
assert(matrix(encode([baseRow('safe', 0), baseRow('safe', 0)])).rejected
  .some((entry) => entry.reason === 'duplicate-arm-in-pair'));
// arm không hợp lệ bị từ chối.
assert(matrix(encode([baseRow('safe', 0, { arm: 'unknown-arm' })])).rejected.length > 0);
// effortAbstain ở arm không phải experimental ⇒ row bị từ chối.
assert(!validateRow(baseRow('balanced', 0, { effortAbstain: true })).ok);
assert(validateRow(baseRow('experimental', 0, { effortAbstain: true, ...jg(true, true) })).ok);
// Vanilla không được khai profile_config_hash.
assert(!validateRow(baseRow('vanilla', 0, { profile_config_hash: 'x' })).ok);

// --------------------------------------------------- promotion bảo thủ
// Dưới 10 nhóm hoặc dưới 2 lớp task ⇒ hold.
const few = matrix(encode(healthy().filter((row) => row.seed < 2)));
assert.equal(few.promotion.experimental.status, 'hold');
assert(few.promotion.experimental.reasons.includes('insufficient-held-out-pairs'));
const oneClass = matrix(encode(healthy().map((row) => ({ ...row, task_class: 'routine' }))));
assert(oneClass.promotion.experimental.reasons.includes('insufficient-task-classes'));
// promotion() trực tiếp: không bao giờ trả 'promote'.
const direct = promotion([], 'experimental');
assert.equal(direct.automatic_promotion, false);
assert.equal(direct.status, 'hold');

console.log('PASS trajectory promotion contract (synthetic gate validation only, offline)');
