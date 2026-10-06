/**
 * Hợp đồng OFFLINE cho TÍNH TOÀN VẸN CỦA SUMMARY — hai điều dễ vỡ nhất:
 *
 *  (1) MANIFEST GATE: một run có manifest thiếu / `status != complete` / khai sai
 *      số row (`written_rows != actual`) là run KHÔNG ĐÁNG TIN. Báo cáo vẫn phải
 *      in ĐẦY ĐỦ diagnostics (người dùng cần xem phần đã đo), nhưng KHÔNG treatment
 *      arm nào được phép ở `eligible-for-review` — phải bị ép `hold` với lý do
 *      machine-readable `incomplete-or-untrusted-run-manifest`, và TUYỆT ĐỐI không
 *      được bịa ra `*-regression` (manifest nói "chưa tin được", không nói "tệ hơn").
 *
 *  (2) RAW vs VALIDATED: số performance dùng để KẾT LUẬN (`arms`, `by_effort`,
 *      `layer_coverage`, `task_classes`) chỉ được tính trên các group đã qua
 *      `groupConsistency`. Một group bị loại vì trộn metadata (ví dụ lệch `split`)
 *      — dù cực chậm — KHÔNG được kéo mean của báo cáo chính. Bản `raw_*` giữ lại
 *      đúng những row đó để đọc mức độ lệch, nhưng không tham gia kết luận.
 *
 * Chạy hàm THẬT, offline, không mạng, không API. Mọi hash TÍNH TỪ dữ liệu nguồn
 * (`benchmarkConfigFor`/`benchmarkConfigHash`/`profileConfigHash`); hard-code hash
 * sẽ khiến `validateRow` từ chối với `*-hash-mismatch` và test trở nên vô nghĩa.
 * Mọi row `source:'real'` PHẢI có `run_id` non-empty — `run_id` là boundary của
 * một run, không phải thứ tuỳ chọn.
 */
import assert from 'node:assert/strict';
import { ARMS, manifestWarning } from '../tools/trajectory-matrix.mjs';
import { analyze } from '../tools/trajectory-fixture.mjs';
import { benchmarkConfigFor, benchmarkConfigHash, profileConfigHash,
  ROW_SCHEMA } from '../tools/trajectory-schema.mjs';

const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const countRows = (text) => text.split('\n').filter((line) => line.trim() !== '').length;
const PLAIN_AXES = Object.freeze({ quality: true, performance: true, safety: false });
/** Arm treatment (mọi arm trừ baseline `vanilla`) — chỉ chúng có mục promotion. */
const TREATMENTS = ARMS.filter((arm) => arm !== 'vanilla');

/** Trường harness canonical cho một seed; quyết định `benchmark_config_hash`. */
const benchFields = (seed) => ({
  task_id: `summary-fixture-${seed}`,
  // ≥2 lớp task là điều kiện BẮT BUỘC của promotion ⇒ trộn theo seed.
  task_class: seed < 5 ? 'routine' : 'bug-diagnosis',
  task_prompt_hash: `prompt-${seed}`, model: 'trajectory-router/fixture',
  dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
  evaluator: `evaluator-${seed}`, permission_mode: 'workspace-write', timeout_ms: 60_000,
});

/** Capability manifest mặc định cho từng arm (vanilla không cấu hình lớp nào). */
const capsFor = (arm) => (arm === 'vanilla' ? {} : { jev: { configured: true, available: true, invoked: true } });

/**
 * Dựng một row HỢP LỆ v2. `run_id` non-empty cho MỌI row `source:'real'` (ở đây
 * toàn bộ fixture đều là real). Hash TÍNH TỪ dữ liệu nguồn và ghi lại SAU override.
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
    repo_state: 'summary-fixture-state', model: fields.model,
    dsh_version: fields.dsh_version, plugin_version: fields.plugin_version,
    benchmark_config, benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    arm, source: 'real', split: 'held-out', mode: 'normal',
    // §10/§30: bằng chứng THẬT phải truy được về đúng mã nguồn + hợp đồng
    // evaluator, nếu không hai lần chạy cùng version vẫn có thể khác nhau.
    plugin_git_commit: 'a'.repeat(40), evaluator_hash: 'b'.repeat(64),

    run_id: `summary-fixture-run-${seed}`,
    profile: arm === 'vanilla' ? null : arm,
    profile_config,
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
    measurement_axes: axes,
    expected_capabilities_to_exercise: [],
    capabilities: capsFor(arm),
    operations: { reserved_units: 1, actual_invocations: 1 },
    success: true, tests_passed: 1, tests_total: 1,
    walltime_ms: 100, cost_usd: 1, effort: 'low',
    false_allow: safety ? 0 : null, false_deny: safety ? 0 : null,
    ...overrides,
    // Ghi đè hash SAU cùng để row luôn nhất quán với config đã resolve.
    benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
  };
};

/** 10 nhóm × 4 arm, held-out, `source:'real'` — bằng chứng promotion SẠCH. */
const CLEAN_ROWS = Array.from({ length: 10 }, (_, seed) => ARMS.map((arm) => row(arm, seed))).flat();
const CLEAN_TEXT = encode(CLEAN_ROWS);
const CLEAN_ACTUAL_ROWS = countRows(CLEAN_TEXT);

try {
  // ============================================ §1 MANIFEST GATE (fix 1)
  // Đối chứng DƯƠNG trước tiên: KHÔNG warning ⇒ dữ liệu sạch phải đạt eligible.
  const cleanReport = analyze(CLEAN_TEXT);
  assert.equal(cleanReport.complete_groups, 10, 'clean fixture must form 10 complete groups');
  assert.equal(cleanReport.held_out_real_groups, 10, 'clean fixture must be held-out-real');
  assert.equal(cleanReport.promotion.experimental.status, 'eligible-for-review',
    'clean held-out data with NO manifest warning must stay eligible-for-review');
  assert.equal(cleanReport.manifest_warning, undefined,
    'no warning passed ⇒ report must not carry manifest_warning');
  for (const arm of TREATMENTS) {
    assert.equal(cleanReport.promotion[arm].automatic_promotion, false,
      `${arm}: promotion must never be automatic, even when eligible`);
  }

  // Bốn dạng manifest, tính bằng chính `manifestWarning()` THẬT của sản phẩm.
  const missingManifest = manifestWarning(null, CLEAN_ACTUAL_ROWS);
  assert.equal(typeof missingManifest, 'string', 'missing manifest must warn');
  assert(missingManifest.startsWith('no-run-manifest'), `unexpected warning: ${missingManifest}`);
  const incompleteManifest = manifestWarning(
    { status: 'incomplete', written_rows: CLEAN_ACTUAL_ROWS, expected_rows: CLEAN_ACTUAL_ROWS + 12 },
    CLEAN_ACTUAL_ROWS);
  assert.equal(typeof incompleteManifest, 'string', 'incomplete manifest must warn');
  assert(incompleteManifest.startsWith('incomplete-run-manifest'),
    `unexpected warning: ${incompleteManifest}`);
  // Manifest CŨ: khai `complete` nhưng số row ghi KHÔNG khớp file thật.
  const staleManifest = manifestWarning(
    { status: 'complete', written_rows: CLEAN_ACTUAL_ROWS + 5, expected_rows: CLEAN_ACTUAL_ROWS + 5 },
    CLEAN_ACTUAL_ROWS);
  assert.equal(typeof staleManifest, 'string', 'stale manifest must warn');
  assert(staleManifest.startsWith('stale-run-manifest'), `unexpected warning: ${staleManifest}`);
  // Manifest ĐẦY ĐỦ & HỢP LỆ: `written_rows === actual === expected`, status complete.
  const completeManifest = { status: 'complete', written_rows: CLEAN_ACTUAL_ROWS, expected_rows: CLEAN_ACTUAL_ROWS };
  assert.equal(manifestWarning(completeManifest, CLEAN_ACTUAL_ROWS), null,
    'a complete, count-matching manifest must NOT warn');
  // Manifest khai `complete` nhưng KHÔNG ghi số row là FAIL-OPEN: nó không thể phân
  // biệt file đầy với file bị cắt. Collector thật LUÔN ghi cả hai ⇒ thiếu chúng
  // nghĩa là manifest bị dựng tay, phải bị coi là KHÔNG đáng tin (không được null).
  const noCountManifest = manifestWarning({ status: 'complete' }, CLEAN_ACTUAL_ROWS);
  assert.equal(typeof noCountManifest, 'string', 'a count-less complete manifest must warn');
  assert(noCountManifest.startsWith('untrusted-run-manifest'), `unexpected warning: ${noCountManifest}`);
  const partialCountManifest = manifestWarning({ status: 'complete', written_rows: CLEAN_ACTUAL_ROWS },
    CLEAN_ACTUAL_ROWS);
  assert.equal(typeof partialCountManifest, 'string',
    'a complete manifest missing expected_rows must warn (cannot prove completeness)');

  for (const [label, warning] of [['missing', missingManifest], ['incomplete', incompleteManifest],
    ['stale', staleManifest], ['no-counts', noCountManifest], ['partial-counts', partialCountManifest]]) {
    const gated = analyze(CLEAN_TEXT, { manifestWarning: warning });
    // Cùng dữ liệu, chỉ khác manifest ⇒ kết luận phải đảo chiều.
    assert.equal(gated.manifest_warning, warning, `${label}: warning must be echoed in the report`);
    for (const arm of TREATMENTS) {
      const entry = gated.promotion[arm];
      assert.equal(entry.status, 'hold', `${label}/${arm}: untrusted manifest must force hold, got ${entry.status}`);
      assert.equal(entry.automatic_promotion, false, `${label}/${arm}: must not auto-promote`);
      assert(entry.reasons.includes('incomplete-or-untrusted-run-manifest'),
        `${label}/${arm}: machine-readable reason must be present`);
      assert(!entry.reasons.some((reason) => /-regression$/.test(reason)),
        `${label}/${arm}: manifest must not invent a regression reason`);
    }
    // `vanilla` không có mục promotion — gate không được tạo ra một mục rỗng.
    assert.equal(gated.promotion.vanilla, undefined, `${label}: vanilla has no promotion entry`);
    // Diagnostics PHẢI còn nguyên khi bị gate (đây là điều kiện của fix 1).
    for (const key of ['arms', 'raw_arms', 'by_effort', 'raw_by_effort', 'layer_coverage',
      'raw_layer_coverage', 'comparisons', 'incomplete', 'rejected', 'promotion', 'verdict',
      'complete_groups', 'held_out_real_groups', 'inconsistent_groups', 'task_classes',
      'raw_task_classes', 'validated_rows', 'raw_rows']) {
      assert.notEqual(gated[key], undefined, `${label}: manifest gate must not drop diagnostics: ${key}`);
    }
    // Diagnostics vẫn ĐÚNG: số nhóm và số row không bị gate làm biến mất.
    assert.equal(gated.complete_groups, 10, `${label}: group diagnostics must survive the gate`);
    assert.equal(gated.raw_rows, CLEAN_ACTUAL_ROWS, `${label}: raw row count must survive the gate`);
    assert.equal(gated.raw_arms.experimental.rows, 10, `${label}: raw arm diagnostics must survive`);
  }

  // Case (iv): manifest hợp lệ ⇒ `manifestWarning` trả null ⇒ promotion chạy bình thường.
  const validWarning = manifestWarning(completeManifest, CLEAN_ACTUAL_ROWS);
  assert.equal(validWarning, null);
  const validReport = analyze(CLEAN_TEXT, { manifestWarning: validWarning });
  assert.equal(validReport.manifest_warning, undefined,
    'a null warning must not be recorded as manifest_warning');
  for (const arm of TREATMENTS) {
    assert.equal(validReport.promotion[arm].status, 'eligible-for-review',
      `${arm}: a valid manifest must not disturb promotion`);
    assert(!validReport.promotion[arm].reasons.includes('incomplete-or-untrusted-run-manifest'),
      `${arm}: a valid manifest must not add the untrusted-manifest reason`);
  }

  // ============================================ §2 RAW vs VALIDATED (fix 3)
  // 1 group HỢP LỆ (walltime 100) + 1 group bị LOẠI vì lệch `split` (walltime 9999).
  // Row của group bị loại vẫn parse HỢP LỆ — nó chỉ thua ở tính nhất quán NHÓM.
  const validGroup = ARMS.map((arm) => row(arm, 0, { split: 'held-out', walltime_ms: 100 }));
  const droppedGroup = ARMS.map((arm) => row(arm, 1, {
    split: arm === 'vanilla' ? 'held-out' : 'validation', walltime_ms: 9999,
  }));
  const splitReport = analyze(encode([...validGroup, ...droppedGroup]));

  assert.equal(splitReport.inconsistent_groups, 1, 'the mixed-split group must be dropped');
  assert.equal(splitReport.complete_groups, 1, 'only the consistent group may be complete');
  assert.equal(splitReport.rejected.filter((entry) =>
    Array.isArray(entry.reasons) && entry.reasons.includes('inconsistent-group-split')).length, 1,
  'the dropped group must be rejected with inconsistent-group-split');

  // Đếm: 8 row parse hợp lệ, nhưng chỉ 4 row thuộc group đã validate.
  assert.equal(splitReport.raw_rows, 8, 'raw_rows must count every parse-valid row');
  assert.equal(splitReport.validated_rows, 4, 'validated_rows must count only consistent-group rows');
  assert(splitReport.raw_rows > splitReport.validated_rows, 'raw_rows must exceed validated_rows');

  for (const arm of ARMS) {
    // Bản RAW thấy cả hai mẫu ⇒ mean = (100 + 9999) / 2 = 5049.5.
    assert.equal(splitReport.raw_arms[arm].metrics.walltime_ms, 5049.5,
      `${arm}: raw summary must include the dropped slow group`);
    assert.equal(splitReport.raw_arms[arm].rows, 2, `${arm}: raw arm must hold both rows`);
    // Bản VALIDATED chỉ thấy group hợp lệ ⇒ mean = 100. Đây là con số được kết luận.
    assert.equal(splitReport.arms[arm].metrics.walltime_ms, 100,
      `${arm}: validated summary must exclude the dropped slow group`);
    assert.equal(splitReport.arms[arm].rows, 1, `${arm}: validated arm must hold only the valid row`);
    assert(splitReport.raw_arms[arm].metrics.walltime_ms > splitReport.arms[arm].metrics.walltime_ms,
      `${arm}: the dropped slow group must move raw but not validated`);
  }
  // `by_effort` và `layer_coverage` cũng phải theo cùng luật validated/raw.
  assert.equal(splitReport.by_effort.low.walltime_ms, 100, 'validated by_effort must exclude dropped rows');
  assert.equal(splitReport.raw_by_effort.low.walltime_ms, 5049.5, 'raw by_effort must include dropped rows');
  assert.equal(splitReport.by_effort.low.rows, 4, 'validated by_effort row count');
  assert.equal(splitReport.raw_by_effort.low.rows, 8, 'raw by_effort row count');
  assert.equal(splitReport.raw_task_classes.length, 1, 'both groups share one task class');
  // Promotion chỉ được thấy group hợp lệ: 1 cặp held-out, và group bị loại (validation)
  // không được tính là held-out-real.
  assert.equal(splitReport.held_out_real_groups, 1, 'only the consistent held-out group counts');
  for (const arm of TREATMENTS) {
    assert.equal(splitReport.promotion[arm].held_out_pairs, 1,
      `${arm}: promotion must only use the consistent group`);
    assert.equal(splitReport.promotion[arm].status, 'hold',
      `${arm}: a single held-out pair is below minPairs, so promotion holds`);
  }

  // Kết hợp cả hai fix: gate manifest KHÔNG được làm biến mất bản raw.
  const gatedSplit = analyze(encode([...validGroup, ...droppedGroup]), { manifestWarning: 'x' });
  assert.equal(gatedSplit.raw_arms.safe.metrics.walltime_ms, 5049.5,
    'raw diagnostics must survive the manifest gate');
  assert.equal(gatedSplit.arms.safe.metrics.walltime_ms, 100,
    'validated summary must stay validated under the manifest gate');
  assert.equal(gatedSplit.promotion.safe.status, 'hold', 'manifest gate must hold');
  assert(gatedSplit.promotion.safe.reasons.includes('incomplete-or-untrusted-run-manifest'),
    'manifest gate reason must be present alongside the real measurement reasons');

  console.log('PASS trajectory summary integrity contract (real functions, offline)');
} catch (error) {
  console.error(`FAIL trajectory summary integrity contract: ${error.message}`);
  process.exit(1);
}
