/**
 * Hợp đồng OFFLINE (FIX 2): arm từ hai LẦN THU THẬP khác nhau KHÔNG BAO GIỜ được
 * ghép thành một treatment.
 *
 * Vì sao file này tồn tại: `run_id` là RANH GIỚI của một lần thu thập, KHÔNG nằm
 * trong khoá ghép cặp (`identityOf`). Hai lần chạy CÙNG task/seed (khác `run_id`)
 * vì thế rơi vào CÙNG một group — và chính vì thế `groupConsistency` mới phát hiện
 * được rằng group đã trộn arm của hai lần chạy và loại nó (`inconsistent-group-run-id`).
 * Nếu `run_id` được đưa vào khoá ghép cặp, hai lần chạy sẽ tách thành hai group
 * riêng và sự trộn lẫn trở nên VÔ HÌNH — đúng lỗi cần chặn.
 *
 * File này khoá lại bốn bất biến:
 *   (a) 4 arm CÙNG `run_id` ⇒ group hợp lệ (0 inconsistent, 10 held-out-real groups);
 *   (b) một arm khác `run_id` ⇒ group bị LOẠI với `inconsistent-group-run-id`, và
 *       group lệch run_id KHÔNG BAO GIỜ là bằng chứng promotion (`held_out_real_groups: 0`);
 *   (c) row `source:'real'` thiếu `run_id` ⇒ `missing-run-id`, xếp vào `incomplete`
 *       (CHƯA ĐỦ dữ liệu), KHÔNG phải `rejected` (dữ liệu hỏng);
 *   (d) fixture `source:'synthetic'` KHÔNG bắt buộc `run_id` — bỏ trống hoặc tự đặt
 *       một giá trị tường minh đều hợp lệ.
 *
 * Chạy hàm THẬT, offline, không mạng, không `/tmp`, không API. Mọi hash đều TÍNH TỪ
 * dữ liệu nguồn (`benchmarkConfigFor`/`benchmarkConfigHash`/`profileConfigHash`);
 * nếu hard-code, `validateRow` sẽ từ chối vì `*-hash-mismatch` và test vô nghĩa.
 */
import assert from 'node:assert/strict';
import { ARMS } from '../tools/trajectory-matrix.mjs';
import { analyze } from '../tools/trajectory-fixture.mjs';
import { benchmarkConfigFor, benchmarkConfigHash, groupConsistency, profileConfigHash,
  ROW_SCHEMA, validateRow } from '../tools/trajectory-schema.mjs';

const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const PLAIN_AXES = Object.freeze({ quality: true, performance: true, safety: false });
const TREATMENTS = ARMS.filter((arm) => arm !== 'vanilla');
/** Một run_id duy nhất cho "lần thu thập lành mạnh" — cả group phải chia sẻ nó. */
const RUN_ONE = 'fixture-run-1';

/** Trường harness canonical cho một seed; quyết định `benchmark_config_hash`. */
const benchFields = (seed) => ({
  task_id: `run-integrity-fixture-${seed}`,
  // ≥2 lớp task là điều kiện của promotion ⇒ trộn theo seed (để positive control chạy).
  task_class: seed < 5 ? 'routine' : 'bug-diagnosis',
  task_prompt_hash: `prompt-${seed}`, model: 'trajectory-router/fixture',
  dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
  evaluator: `evaluator-${seed}`, permission_mode: 'workspace-write', timeout_ms: 60_000,
});

/** Capability manifest mặc định cho từng arm (KHÔNG suy từ tên arm trong code thật). */
const capsFor = (arm) => (arm === 'vanilla' ? {} : { jev: { configured: true, available: true, invoked: true } });

/**
 * Dựng một row HỢP LỆ v2, mặc định `source:'real'` + `run_id: RUN_ONE`. Mọi hash
 * TÍNH TỪ dữ liệu nguồn, ghi lại SAU override — nên một fixture sai hash sẽ bị
 * `validateRow` từ chối ngay.
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
    repo_state: 'run-integrity-state', model: fields.model,
    dsh_version: fields.dsh_version, plugin_version: fields.plugin_version,
    benchmark_config, benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    arm, source: 'real', split: 'held-out', mode: 'normal',
    // §10/§30: bằng chứng THẬT phải truy được về đúng mã nguồn + hợp đồng
    // evaluator, nếu không hai lần chạy cùng version vẫn có thể khác nhau.
    plugin_git_commit: 'a'.repeat(40), evaluator_hash: 'b'.repeat(64),

    run_id: RUN_ONE,
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
    // Ghi đè hash SAU cùng để row luôn nhất quán với config đã resolve.
    benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
  };
};

/** 10 group held-out thật, mỗi group đủ 4 arm, tất cả chia sẻ `RUN_ONE`. */
const dataset = (overrides = {}) => Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => row(arm, seed, overrides[arm] ?? {}))).flat();

try {
  // -------------------------------------------- (a) cùng run_id ⇒ group hợp lệ
  const clean = dataset();
  for (const fixture of clean) {
    assert.equal(validateRow(fixture).ok, true,
      `fixture ${fixture.task_id}/${fixture.arm} phải hợp lệ: ${validateRow(fixture).reasons.join(', ')}`);
  }
  // Đối chứng trực tiếp trên hàm nhóm: 4 arm cùng run_id ⇒ KHÔNG có vấn đề.
  assert.equal(groupConsistency(clean.filter((r) => r.seed === 0)).consistent, true);
  const cleanReport = analyze(encode(clean));
  assert.equal(cleanReport.inconsistent_groups, 0,
    'bốn arm chia sẻ một run_id KHÔNG được coi là bất nhất');
  assert.equal(cleanReport.complete_groups, 10);
  assert.equal(cleanReport.held_out_real_groups, 10);
  assert.equal(cleanReport.rejected.length, 0);
  // Positive control: run_id hợp lệ không được làm hỏng promotion.
  assert.equal(cleanReport.promotion.experimental.held_out_pairs, 10);
  assert.equal(cleanReport.promotion.experimental.automatic_promotion, false);

  // --------------------------------- (b) một arm khác run_id ⇒ LOẠI cả group
  // `balanced` mang run_id của một lần thu thập KHÁC, ở MỌI group — nên cả 10 group
  // đều trộn hai lần chạy và phải bị loại.
  const mixedRuns = dataset({ balanced: { run_id: 'fixture-run-2' } });
  // Từng row TRỘN vẫn HỢP LỆ ⇒ group bị loại là do NHẤT QUÁN NHÓM, không phải
  // fixture hỏng. Đây mới đúng điều cần chứng minh.
  for (const fixture of mixedRuns) {
    assert.equal(validateRow(fixture).ok, true,
      `row ${fixture.task_id}/${fixture.arm} vẫn phải hợp lệ: ${validateRow(fixture).reasons.join(', ')}`);
  }
  const seedZero = mixedRuns.filter((r) => r.seed === 0);
  const mixedConsistency = groupConsistency(seedZero);
  assert.equal(mixedConsistency.consistent, false);
  assert(mixedConsistency.reasons.includes('inconsistent-group-run-id'),
    'group trộn run_id phải được báo là inconsistent-group-run-id');
  const mixedReport = analyze(encode(mixedRuns));
  assert.equal(mixedReport.inconsistent_groups, 10, 'mọi group trộn run_id phải bị loại');
  assert.equal(mixedReport.complete_groups, 0);
  // KHÔNG bao giờ là bằng chứng promotion.
  assert.equal(mixedReport.held_out_real_groups, 0,
    'group trộn run_id KHÔNG bao giờ được tính là held-out-real');
  assert.equal(mixedReport.rejected.length, 10, 'mọi group trộn run_id phải rơi vào rejected');
  assert.equal(mixedReport.rejected.filter((entry) =>
    Array.isArray(entry.reasons) && entry.reasons.includes('inconsistent-group-run-id')).length, 10,
  'matrix phải loại mọi group trộn run_id với inconsistent-group-run-id');
  for (const arm of TREATMENTS) {
    assert.equal(mixedReport.promotion[arm].status, 'hold',
      `${arm}: group trộn run_id KHÔNG bao giờ được promote`);
    assert.equal(mixedReport.promotion[arm].held_out_pairs, 0);
    assert.equal(mixedReport.promotion[arm].automatic_promotion, false);
  }

  // ---------------------- (c) row real THIẾU run_id ⇒ missing-run-id, incomplete
  const noRunId = { ...row('safe', 0) };
  delete noRunId.run_id;
  const noRunIdCheck = validateRow(noRunId);
  assert.equal(noRunIdCheck.ok, false, 'row real thiếu run_id KHÔNG được hợp lệ');
  assert(noRunIdCheck.reasons.includes('missing-run-id'),
    'lý do phải là missing-run-id');
  // Các lý do KHÁC vẫn nguyên (không bị lý do mới lấn át) — row này chỉ thiếu run_id.
  assert.equal(noRunIdCheck.reasons.length, 1);
  const noRunIdReport = analyze(encode([noRunId]));
  assert.equal(noRunIdReport.rejected.length, 0,
    'thiếu run_id là CHƯA ĐỦ dữ liệu, KHÔNG phải dữ liệu hỏng cần cách ly như rejected');
  assert.equal(noRunIdReport.incomplete.length, 1,
    'row real thiếu run_id phải rơi vào incomplete');
  assert(noRunIdReport.incomplete[0].reasons.includes('missing-run-id'));
  assert.equal(noRunIdReport.complete_groups, 0);
  assert.equal(noRunIdReport.held_out_real_groups, 0);

  // ------------------------- (d) synthetic KHÔNG bắt buộc run_id — cả hai đều hợp lệ
  const syntheticNoRun = { ...row('safe', 0, { source: 'synthetic' }) };
  delete syntheticNoRun.run_id;
  assert.equal(validateRow(syntheticNoRun).ok, true,
    `synthetic được phép bỏ trống run_id: ${validateRow(syntheticNoRun).reasons.join(', ')}`);
  const syntheticWithRun = row('safe', 0, { source: 'synthetic', run_id: 'synthetic-run-9' });
  assert.equal(validateRow(syntheticWithRun).ok, true,
    `synthetic được phép tự đặt run_id: ${validateRow(syntheticWithRun).reasons.join(', ')}`);
  // Dù có run_id, synthetic KHÔNG BAO GIỜ là bằng chứng promotion.
  assert.equal(analyze(encode([syntheticWithRun])).held_out_real_groups, 0);

  console.log('PASS trajectory run-integrity contract (real functions, offline)');
} catch (error) {
  console.error(`FAIL trajectory run-integrity contract: ${error.message}`);
  process.exit(1);
}
