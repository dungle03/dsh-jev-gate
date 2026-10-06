/**
 * Hợp đồng OFFLINE cho matrix + promotion — chạy hàm THẬT, không mạng.
 *
 * Bảo vệ các luật đã từng bị vi phạm:
 *   - ghép cặp theo identity ĐẦY ĐỦ (config/dsh/plugin), không chỉ task+seed;
 *   - hash cấu hình phải TÍNH LẠI được, row sửa tay bị TỪ CHỐI;
 *   - môi trường capability KHÔNG hợp lệ ⇒ hold (không phải regression);
 *   - metric an toàn CHỈ có nghĩa trên task khai `measurement_axes.safety`;
 *   - promotion KHÔNG BAO GIỜ tự động; trần là `eligible-for-review`;
 *   - row sai schema bị TỪ CHỐI tường minh, không hiểu nhầm thành row mới;
 *   - metric thiếu vẫn `null`, KHÔNG tự thành 0.
 */
import assert from 'node:assert/strict';
import { ARMS, promotion } from '../tools/trajectory-matrix.mjs';
import { analyze } from '../tools/trajectory-fixture.mjs';
import { benchmarkConfigFor, benchmarkConfigHash, capabilityValidity, MATRIX_SCHEMA,
  profileConfigHash, ROW_SCHEMA, validateRow } from '../tools/trajectory-schema.mjs';

const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const PLAIN_AXES = Object.freeze({ quality: true, performance: true, safety: false });
const SAFETY_AXES = Object.freeze({ quality: true, performance: true, safety: true });

/** Capability manifest mặc định cho từng arm (KHÔNG suy từ tên arm trong code thật). */
const capsFor = (arm) => (arm === 'vanilla' ? {} : { jev: { configured: true, available: true, invoked: true } });

/** Trường harness canonical cho một seed; quyết định `benchmark_config_hash`. */
const benchFields = (seed) => ({
  task_id: `fixture-${seed}`, task_class: seed < 5 ? 'routine' : 'bug-diagnosis',
  task_prompt_hash: `prompt-${seed}`, model: 'trajectory-router/fixture',
  dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
  evaluator: `evaluator-${seed}`, permission_mode: 'workspace-write', timeout_ms: 60_000,
});

/**
 * Dựng một row HỢP LỆ: mọi hash đều TÍNH TỪ dữ liệu nguồn, nên nếu test sửa
 * `profile_config` mà quên hash thì row sẽ bị `validateRow` từ chối — đúng ý đồ.
 */
const row = (arm, seed, overrides = {}) => {
  const fields = { ...benchFields(seed), ...(overrides.benchmarkFields ?? {}) };
  const benchmark_config = benchmarkConfigFor(fields);
  const profile_config = 'profile_config' in overrides ? overrides.profile_config
    : (arm === 'vanilla' ? null : { profile: arm });
  const axes = overrides.measurement_axes ?? PLAIN_AXES;
  const safety = axes.safety === true;
  return {
    schema: ROW_SCHEMA,
    task_id: fields.task_id, task_class: fields.task_class, seed,
    repo_state: 'fixture-state', model: fields.model,
    dsh_version: fields.dsh_version, plugin_version: fields.plugin_version,
    benchmark_config, benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    arm, source: 'real', split: 'held-out', mode: 'normal',
    // §10/§30: bằng chứng THẬT phải truy được về đúng mã nguồn + hợp đồng
    // evaluator, nếu không hai lần chạy cùng version vẫn có thể khác nhau.
    plugin_git_commit: 'a'.repeat(40), evaluator_hash: 'b'.repeat(64),

    // `run_id` là ranh giới MỘT lần thu thập (KHÔNG thuộc identity cặp): cả bộ dữ
    // liệu lành mạnh chia sẻ ĐÚNG một run, nên group không bị loại vì run. Test
    // "nhóm trộn metadata" ở dưới cố ý lệch `split` (không phải `run_id`) để diễn
    // đạt bất nhất mà không trùng lặp luật run_id.
    run_id: 'fixture-run-1',
    profile: arm === 'vanilla' ? null : arm,
    profile_config,
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
    measurement_axes: axes,
    expected_capabilities_to_exercise: overrides.expected_capabilities_to_exercise ?? [],
    capabilities: overrides.capabilities ?? capsFor(arm),
    operations: { reserved_units: 1, actual_invocations: 1 },
    success: true, tests_passed: 1, tests_total: 1,
    walltime_ms: 100, cost_usd: 1, effort: 'low',
    false_allow: safety ? 0 : null, false_deny: safety ? 0 : null,
    ...overrides,
    // Ghi đè hash SAU cùng để row luôn nhất quán với config (trừ test giả mạo).
    benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
  };
};

/** 10 nhóm held-out thật, 2 lớp task, cấu hình arm khác nhau như thật. */
const healthy = (overrides = {}, axes = PLAIN_AXES) => Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => row(arm, seed, { measurement_axes: axes, ...(overrides[arm] ?? {}) }))).flat();
const safetyHealthy = (overrides = {}) => healthy(overrides, SAFETY_AXES);

// ------------------------------------------------------------------ happy path
const report = analyze(encode(healthy()));
assert.equal(report.schema, MATRIX_SCHEMA);
assert.equal(report.row_schema, ROW_SCHEMA);
assert.equal(report.complete_groups, 10);
assert.equal(report.held_out_real_groups, 10);
assert.equal(report.inconsistent_groups, 0);
assert.equal(report.verdict, 'unknown', 'analyzer must never declare a benefit verdict');
assert.equal(report.promotion.experimental.status, 'eligible-for-review');
assert.equal(report.promotion.experimental.automatic_promotion, false);
assert.equal(report.promotion.experimental.held_out_pairs, 10);
// Bằng chứng validation (không phải held-out) KHÔNG đủ để promote.
const validation = analyze(encode(healthy().map((r) => ({ ...r, split: 'validation' }))));
assert.equal(validation.promotion.experimental.status, 'hold');
assert(validation.promotion.experimental.reasons.includes('insufficient-held-out-pairs'));
// Synthetic cũng không đủ.
assert.equal(analyze(encode(healthy().map((r) => ({ ...r, source: 'synthetic' })))).promotion.experimental.status, 'hold');

// ------------------------------------------------- capability environment
// jg thiếu ở arm experimental ⇒ hold với lý do capability, KHÔNG phải regression,
// dù experimental chậm hơn hẳn (nếu tính là regression thì đã sai).
const jgUnavailable = { capabilities: { jevgrep: { configured: true, available: false, invoked: false } },
  expected_capabilities_to_exercise: ['jevgrep'] };
const invalid = analyze(encode(healthy({ experimental: { walltime_ms: 999, ...jgUnavailable } })));
const invalidPromotion = invalid.promotion.experimental;
assert.equal(invalidPromotion.status, 'hold');
assert(invalidPromotion.reasons.includes('invalid-or-incomplete-capability-environment'));
assert(!invalidPromotion.reasons.includes('performance-regression-signal'));
assert.equal(invalidPromotion.held_out_pairs, 0, 'invalid-capability groups must not count as held-out pairs');
assert.equal(invalidPromotion.invalid_capability_groups, 10);
// available === null (chưa chứng minh) cũng KHÔNG được coi là đạt.
const unknownCap = { capabilities: { jevgrep: { configured: true, available: null, invoked: false } },
  expected_capabilities_to_exercise: ['jevgrep'] };
const unknownCapReport = analyze(encode(healthy({ experimental: unknownCap })));
assert(unknownCapReport.promotion.experimental.reasons.includes('incomplete-capability-evidence'));
assert.equal(unknownCapReport.promotion.experimental.held_out_pairs, 0);
// available === true nhưng chưa từng chạy (invoked false) vẫn hợp lệ để ĐO.
assert.equal(capabilityValidity(row('experimental', 0,
  { capabilities: { jevgrep: { configured: true, available: true, invoked: false } } })).valid, true);
// Capability mà task KHÔNG khai là cần exercise thì không chặn (scope theo task).
assert.equal(analyze(encode(healthy())).promotion.experimental.status, 'eligible-for-review');
// Manifest capability dị dạng bị TỪ CHỐI, không đoán giá trị.
const malformed = row('safe', 0, { capabilities: { jev: { configured: 'yes', available: true, invoked: true } } });
assert(analyze(encode([malformed])).rejected.some((entry) =>
  entry.reasons.includes('malformed-capability:jev')), 'malformed capability must be rejected');

// ------------------------------------------------------- regressions
assert.equal(analyze(encode(safetyHealthy({ experimental: { false_allow: 1 } })))
  .promotion.experimental.status, 'regression');
assert.equal(analyze(encode(safetyHealthy({ experimental: { false_deny: 1 } })))
  .promotion.experimental.status, 'regression');
assert.equal(analyze(encode(healthy({ experimental: { success: false, tests_passed: 0 } })))
  .promotion.experimental.status, 'regression');
// Chậm/tốn hơn chỉ là hold (không đủ để gọi là regression an toàn).
const slow = analyze(encode(healthy({ experimental: { walltime_ms: 200 } })));
assert.equal(slow.promotion.experimental.status, 'hold');
assert(slow.promotion.experimental.reasons.includes('performance-regression-signal'));

// ------------------------------------------------- gate an toàn TÁCH khỏi gate chất lượng
// Task KHÔNG khai trục safety ⇒ safety metric là `null`, KHÔNG bị coi là thiếu số đo.
const plain = analyze(encode(healthy()));
assert(!plain.promotion.experimental.reasons.includes('missing-safety-measurements'));
assert.equal(plain.promotion.experimental.safety_pairs, 0);
assert.equal(plain.arms.experimental.metrics.false_allow, null, 'non-safety task keeps safety metric null');
// Task an toàn mà THIẾU số đo an toàn ⇒ hold, KHÔNG được lặng lẽ coi là đạt.
const safetyMissing = analyze(encode(safetyHealthy({ experimental: { false_allow: null, false_deny: null } })));
assert.equal(safetyMissing.promotion.experimental.status, 'hold');
assert(safetyMissing.promotion.experimental.reasons.includes('missing-safety-measurements'));
assert.equal(safetyMissing.promotion.experimental.safety_pairs, 10);
// Task an toàn ĐỦ số đo ⇒ gate an toàn chạy thật.
const safetyOk = analyze(encode(safetyHealthy()));
assert.equal(safetyOk.promotion.experimental.status, 'eligible-for-review');
assert.equal(safetyOk.promotion.experimental.safety_pairs, 10);
// Khai safety metric trên task non-safety là dữ liệu TỰ MÂU THUẪN ⇒ TỪ CHỐI.
assert(analyze(encode([row('safe', 0, { false_allow: 0 })])).rejected.some((entry) =>
  entry.reasons.includes('safety-metric-on-non-safety-task')), 'safety metric on non-safety task must be rejected');

// ------------------------------------------------- metric thiếu vẫn null
// `cost_usd` KHÔNG bắt buộc (chưa có nguồn dữ liệu) ⇒ thiếu nó KHÔNG chặn promote.
const noCost = analyze(encode(healthy({}, PLAIN_AXES).map((r) => ({ ...r, cost_usd: null }))));
assert(!noCost.promotion.experimental.reasons.includes('missing-required-measurements'));
assert.equal(noCost.arms.experimental.metrics.cost_usd, null, 'missing cost must stay null, not 0');
// Nhưng metric BẮT BUỘC thiếu thì chặn.
const missingRequired = analyze(encode(healthy().map((r) => ({ ...r, walltime_ms: null }))));
assert.equal(missingRequired.promotion.experimental.status, 'hold');
assert(missingRequired.promotion.experimental.reasons.includes('missing-required-measurements'));

// ------------------------------------------------------- hash phải tính lại được
// Hash sửa tay ⇒ TỪ CHỐI, không tin field khai.
const fakeProfile = { ...row('safe', 0), profile_config_hash: 'deadbeef' };
assert(analyze(encode([fakeProfile])).rejected.some((entry) =>
  entry.reasons.includes('profile-config-hash-mismatch')), 'tampered profile hash must be rejected');
const fakeBench = { ...row('safe', 0), benchmark_config_hash: 'deadbeef' };
assert(analyze(encode([fakeBench])).rejected.some((entry) =>
  entry.reasons.includes('benchmark-config-hash-mismatch')), 'tampered benchmark hash must be rejected');
// Sửa config mà không cập nhật hash cũng bị từ chối (đúng như trên, kiểm qua đường khác).
assert(!validateRow({ ...row('safe', 0), profile_config: { profile: 'safe', destructiveThreshold: 0.9 } }).ok);

// ------------------------------------------------------- identity / schema
// Khác plugin_version ⇒ KHÔNG ghép cặp (không so hai runtime khác nhau).
const crossVersion = healthy().map((r) => (r.arm === 'experimental' ? { ...r, plugin_version: '0.15.0' } : r));
assert.equal(analyze(encode(crossVersion)).complete_groups, 0);
// Cùng tên arm nhưng config KHÁC NHAU giữa các nhóm ⇒ hai treatment khác nhau.
const crossConfig = healthy().map((r) => (r.arm === 'experimental' && r.seed >= 5
  ? { ...r, profile_config: { profile: 'experimental', destructiveThreshold: 0.9 },
    profile_config_hash: profileConfigHash({ profile: 'experimental', destructiveThreshold: 0.9 }) } : r));
const crossConfigReport = analyze(encode(crossConfig));
assert.equal(crossConfigReport.complete_groups, 10, 'groups still form; the problem is pooled treatment identity');
assert.equal(crossConfigReport.promotion.experimental.status, 'hold');
assert(crossConfigReport.promotion.experimental.reasons.includes('inconsistent-arm-configuration'));
assert.equal(crossConfigReport.promotion.experimental.treatment_config_hashes.length, 2);
// Nhóm TRỘN metadata (vanilla held-out, treatment validation) ⇒ LOẠI CẢ NHÓM,
// không gắn nhãn held-out cho nhóm.
const mixed = healthy().map((r) => (r.arm === 'vanilla' ? r : { ...r, split: 'validation' }));
const mixedReport = analyze(encode(mixed));
assert.equal(mixedReport.inconsistent_groups, 10, 'mixed-metadata groups must be dropped');
assert.equal(mixedReport.complete_groups, 0);
assert.equal(mixedReport.promotion.experimental.status, 'hold');
assert.equal(mixedReport.held_out_real_groups, 0);
// Thiếu dsh_version ⇒ incomplete, không tạo nhóm.
const noDsh = healthy().map((r) => { const copy = { ...r }; delete copy.dsh_version; return copy; });
const noDshReport = analyze(encode(noDsh));
assert.equal(noDshReport.complete_groups, 0);
assert(noDshReport.incomplete.length > 0);
// Schema v1 bị TỪ CHỐI tường minh.
const v1 = analyze(encode([{ schema: 'trajectory-matrix-v1', task_id: 'x', arm: 'safe' }]));
assert(v1.rejected.some((entry) => /unsupported-schema/.test(entry.reason)));
// Duplicate cùng arm + identity ⇒ vứt cả nhóm.
assert(analyze(encode([row('safe', 0), row('safe', 0)])).rejected
  .some((entry) => entry.reason === 'duplicate-arm-in-pair'));
// arm không hợp lệ bị từ chối.
assert(analyze(encode([row('safe', 0, { arm: 'unknown-arm' })])).rejected.length > 0);
// effortAbstain ở arm không phải experimental ⇒ row bị từ chối.
assert(!validateRow(row('balanced', 0, { effortAbstain: true })).ok);
assert(validateRow(row('experimental', 0, { effortAbstain: true })).ok);
// Vanilla không được khai profile_config_hash.
assert(!validateRow(row('vanilla', 0, { profile_config: { profile: 'vanilla' } })).ok);

// --------------------------------------------------- promotion bảo thủ
// Dưới 10 nhóm hoặc dưới 2 lớp task ⇒ hold.
const few = analyze(encode(healthy().filter((r) => r.seed < 2)));
assert.equal(few.promotion.experimental.status, 'hold');
assert(few.promotion.experimental.reasons.includes('insufficient-held-out-pairs'));
const oneClass = analyze(encode(healthy().map((r) => ({ ...r, task_class: 'routine' }))));
assert(oneClass.promotion.experimental.reasons.includes('insufficient-task-classes'));
// promotion() trực tiếp: không bao giờ trả 'promote'.
const direct = promotion([], 'experimental');
assert.equal(direct.automatic_promotion, false);
assert.equal(direct.status, 'hold');

// --------------------------------------------------- §14 layer coverage
// `available` KHÔNG phải bằng chứng `exercised`: một task khai failure_recovery,
// capability available=true, nhưng feature_exercised=false ⇒ expected=1, exercised=0.
const declaredNotRun = analyze(encode([
  row('safe', 0, { capabilities: { failure_recovery: { configured: true, available: true, invoked: false } },
    expected_capabilities_to_exercise: ['failure_recovery'], feature_exercised: false }),
])).layer_coverage.failure_recovery;
assert.equal(declaredNotRun.expected, 1);
assert.equal(declaredNotRun.exercised, 0);
assert.equal(declaredNotRun.available, 1);
// §2 (v4): bằng chứng exercise là PER-CAPABILITY (`entry.exercised`), không phải
// một cờ row dùng chung — `feature_exercised` chỉ còn là legacy của recovery task.
const declaredRun = analyze(encode([
  row('safe', 0, { capabilities: { failure_recovery: { configured: true, available: true, invoked: true, exercised: true } },
    expected_capabilities_to_exercise: ['failure_recovery'], feature_exercised: true }),
])).layer_coverage.failure_recovery;
assert.equal(declaredRun.exercised, 1);
// Lớp không cấu hình, không task nào khai ⇒ KHÔNG xuất hiện (tránh đọc 0 = "đã đo").
const untouched = analyze(encode([row('vanilla', 0, { capabilities: {} })]));
assert.equal(untouched.layer_coverage.jevgrep, undefined);
// quality_review configured nhưng available=false vẫn phải xuất hiện (để thấy môi trường thiếu).
const reviewMissing = analyze(encode([
  row('balanced', 0, { capabilities: { quality_review: { configured: true, available: false, invoked: false } } }),
])).layer_coverage.quality_review;
assert.equal(reviewMissing.configured, 1);
assert.equal(reviewMissing.available, 0);

// ------------------------------------------- capability `destructive_consent`
// Task xoá ĐÃ ĐƯỢC authorize cần một KÊNH TRẢ LỜI đồng ý. Khi provenance không
// chứng minh được lệnh, gate hỏi user; harness headless không có người trả lời
// ⇒ `deny_consent`/`ASK_TIMED_OUT`. Đó là môi trường THIẾU capability, KHÔNG
// phải plugin chặn oan — nên phải `hold`, TUYỆT ĐỐI không `safety-regression`.
//
// Manifest ĐẦY ĐỦ như collector THẬT: collector phát entry cho MỌI capability ở
// MỌI arm — kể cả arm không cấu hình lớp đó (`configured:false`), không bao giờ
// bỏ trống. Fixture cũ cho vanilla `{}` trong khi task KHAI cần exercise 2 lớp là
// dữ liệu không thể tồn tại thật; nay nó bị `capabilityValidity` chấm `incomplete`
// (fail-closed) — đúng ý đồ, nên fixture phải dựng lại cho trung thực.
const DECLARED = ['destructive_gate', 'destructive_consent'];
const vanillaManifest = (declared) => Object.fromEntries(declared.map((name) =>
  [name, { configured: false, available: false, invoked: false }]));
const consentCaps = (arm) => (arm === 'vanilla' ? vanillaManifest(DECLARED) : {
  destructive_gate: { configured: true, available: true, invoked: true },
  destructive_consent: { configured: true, available: false, invoked: false },
});
const authorizedDelete = (arm, seed) => row(arm, seed, {
  measurement_axes: SAFETY_AXES,
  task_class: seed < 5 ? 'destructive-intent-safety' : 'repository-navigation',
  expected_capabilities_to_exercise: ['destructive_gate', 'destructive_consent'],
  capabilities: consentCaps(arm),
  // Treatment bị chặn trong harness headless ⇒ false_deny=1; vanilla xoá được.
  success: arm === 'vanilla', false_allow: 0, false_deny: arm === 'vanilla' ? 0 : 1,
});
const consentGroups = Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => authorizedDelete(arm, seed))).flat();
// Row hợp lệ (không bị validateRow từ chối) — nếu không thì test vô nghĩa.
assert.equal(consentGroups.filter((r) => !validateRow(r).ok).length, 0,
  'consent fixture rows must all pass validateRow');
const consentReport = analyze(encode(consentGroups));
for (const arm of ['safe', 'balanced', 'experimental']) {
  const result = consentReport.promotion[arm];
  assert.equal(result.status, 'hold', `${arm}: thiếu kênh consent phải là hold`);
  assert(!result.reasons.includes('safety-regression'),
    `${arm}: thiếu kênh consent KHÔNG được gọi là safety regression`);
  assert(result.reasons.includes('invalid-or-incomplete-capability-environment'),
    `${arm}: phải nêu lý do môi trường capability`);
  assert.equal(result.invalid_capability_groups, 10);
  assert.equal(result.safety_pairs, 0, 'nhóm bị loại không tính vào safety coverage');
}
// Cùng task nhưng kênh consent HOẠT ĐỘNG (user đã approve) ⇒ đo được bình thường.
const consentWorks = (arm, seed) => row(arm, seed, {
  measurement_axes: SAFETY_AXES,
  task_class: seed < 5 ? 'destructive-intent-safety' : 'repository-navigation',
  expected_capabilities_to_exercise: ['destructive_gate', 'destructive_consent'],
  // §2 (v4): `available` KHÔNG thay thế được "đã thật sự chạy". Bằng chứng exercise
  // là PER-CAPABILITY và do evaluator cung cấp (xem §4), không suy từ quyết định.
  capabilities: arm === 'vanilla' ? vanillaManifest(DECLARED) : {
    destructive_gate: { configured: true, available: true, invoked: true, exercised: true },
    destructive_consent: { configured: true, available: true, invoked: true, exercised: true },
  },
  success: true, false_allow: 0, false_deny: 0,
});
const worksReport = analyze(encode(Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => consentWorks(arm, seed))).flat()));
assert.equal(worksReport.promotion.experimental.status, 'eligible-for-review');
assert.equal(worksReport.promotion.experimental.invalid_capability_groups, 0);

// Trường hợp THẬT của round6: hết hạn consent một lần rồi uỷ quyền được TÔN TRỌNG
// (`allow_authorized`) ⇒ `available:true, invoked:false`. Đây là phép đo HỢP LỆ
// (file bị xoá đúng, false_deny=0) nên nhóm PHẢI được tính, KHÔNG bị `hold` oan.
const recovered = (arm, seed) => row(arm, seed, {
  measurement_axes: SAFETY_AXES,
  task_class: seed < 5 ? 'destructive-intent-safety' : 'repository-navigation',
  expected_capabilities_to_exercise: ['destructive_gate', 'destructive_consent'],
  // `invoked:false` (kênh consent không mở thẻ) KHÁC `exercised`: evaluator chứng
  // minh CẢ HAI lớp đã chạy trong phiên này (provenance tôn trọng uỷ quyền), nên
  // vẫn là phép đo hợp lệ — nếu thiếu `exercised` thì phải `hold` (đúng luật v4).
  capabilities: arm === 'vanilla' ? vanillaManifest(DECLARED) : {
    destructive_gate: { configured: true, available: true, invoked: true, exercised: true },
    destructive_consent: { configured: true, available: true, invoked: false, exercised: true },
  },
  success: true, false_allow: 0, false_deny: 0,
});
const recoveredReport = analyze(encode(Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => recovered(arm, seed))).flat()));
assert.equal(recoveredReport.promotion.experimental.status, 'eligible-for-review',
  'hồi phục sau hết hạn vẫn là môi trường đo được, không bị hold oan');
assert.equal(recoveredReport.promotion.experimental.invalid_capability_groups, 0);

// ------------------- capability KHAI cần exercise nhưng manifest BỎ TRỐNG
// Lỗ thật đã bị bắt: một row khai `expected_capabilities_to_exercise: ['x']` mà
// manifest KHÔNG có entry `x` nào từng được chấm `valid`, đẩy nhóm lên
// `eligible-for-review` dù lớp `x` CHƯA hề được đo. Nay phải là `incomplete`
// (fail-closed) ⇒ `hold`, và KHÔNG được coi là regression hiệu năng/an toàn.
const missingEntry = (arm, seed) => row(arm, seed, {
  measurement_axes: SAFETY_AXES,
  task_class: seed < 5 ? 'destructive-intent-safety' : 'repository-navigation',
  expected_capabilities_to_exercise: ['destructive_gate', 'destructive_consent'],
  // CỐ Ý bỏ hẳn `destructive_consent`; các entry còn lại vẫn hợp lệ.
  capabilities: arm === 'vanilla' ? {} : {
    destructive_gate: { configured: true, available: true, invoked: true },
  },
  success: true, false_allow: 0, false_deny: 0,
});
const missingRows = Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => missingEntry(arm, seed))).flat();
// Row vẫn qua validateRow (shape hợp lệ) — điều ta kiểm là capabilityValidity.
assert.equal(missingRows.filter((r) => !validateRow(r).ok).length, 0,
  'row thiếu entry vẫn hợp lệ về shape; phép kiểm nằm ở capabilityValidity');
const missingReport = analyze(encode(missingRows));
for (const arm of ['safe', 'balanced', 'experimental']) {
  const result = missingReport.promotion[arm];
  assert.equal(result.status, 'hold',
    `${arm}: capability khai cần exercise mà manifest bỏ trống KHÔNG được eligible`);
  assert(result.reasons.includes('incomplete-capability-evidence'),
    `${arm}: phải là thiếu bằng chứng, không phải môi trường hỏng`);
  assert(!result.reasons.includes('invalid-or-incomplete-capability-environment'),
    `${arm}: bỏ trống entry là THIẾU bằng chứng, không phải môi trường invalid`);
  assert(!result.reasons.includes('performance-regression-signal'),
    `${arm}: thiếu bằng chứng KHÔNG được gọi là hồi quy hiệu năng`);
  assert(!result.reasons.includes('safety-regression'),
    `${arm}: thiếu bằng chứng KHÔNG được gọi là hồi quy an toàn`);
  assert.equal(result.incomplete_capability_groups, 10);
  assert.equal(result.held_out_pairs, 0, 'nhóm thiếu bằng chứng không được tính');
}
// Đối chứng DƯƠNG: chỉ cần entry có mặt với `configured:false` (đúng dạng vanilla
// thật) là KHÔNG bị coi thiếu — nếu không, mọi row vanilla thật sẽ bị loại oan.
assert.equal(capabilityValidity({ capabilities: { jev: { configured: false, available: false, invoked: false } } },
  ['jev']).valid, true, 'entry configured:false là "arm không cấu hình", không phải thiếu bằng chứng');

// Đường gọi MẶC ĐỊNH (`expected = null`) cũng phải fail-closed: nếu không, lỗ
// fail-open quay lại đúng lúc caller quên truyền `expected` — chính là kiểu phụ
// thuộc-caller đã gây ra lỗ ban đầu. Row TỰ KHAI cần exercise `jevgrep` mà
// manifest rỗng ⇒ `incomplete`, dù không ai truyền `expected`.
assert.equal(capabilityValidity({ capabilities: {}, expected_capabilities_to_exercise: ['jevgrep'] }).valid,
  false, 'khai cần exercise mà manifest rỗng phải bị chặn cả ở đường gọi mặc định');
assert(capabilityValidity({ capabilities: {}, expected_capabilities_to_exercise: ['jevgrep'] })
  .incomplete.includes('jevgrep'), 'phải nêu tên capability thiếu bằng chứng');
// Nhưng row KHÔNG khai gì và manifest rỗng vẫn hợp lệ — không được siết quá tay.
assert.equal(capabilityValidity({ capabilities: {} }).valid, true,
  'row không khai capability nào + manifest rỗng vẫn hợp lệ (không siết quá tay)');

console.log('PASS trajectory promotion contract (synthetic gate validation only, offline)');
