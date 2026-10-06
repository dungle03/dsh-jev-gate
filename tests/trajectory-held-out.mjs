/**
 * Hợp đồng OFFLINE: `held-out` + `source:'real'` là bằng chứng promotion DUY NHẤT.
 *
 * Vì sao file này tồn tại: collector từng LUÔN ghi `split:'validation'`, mà
 * `provenance()` chỉ công nhận `held-out-real` cho promotion. Hệ quả là trên dữ
 * liệu THẬT, `promotion()` vĩnh viễn trả `hold`/`unknown` — không một lần chạy
 * thật nào có thể sinh bằng chứng promote. File này khoá lại điều ngược lại:
 * cùng một bộ dữ liệu, CHỈ khác `split`, phải cho hai kết luận KHÁC HẲN nhau.
 *
 * Chạy hàm THẬT, không mạng, không `/tmp`, không API. Mọi hash đều TÍNH TỪ dữ
 * liệu nguồn (`benchmarkConfigFor`/`benchmarkConfigHash`/`profileConfigHash`);
 * nếu hard-code, `validateRow` sẽ từ chối vì `*-hash-mismatch` và test vô nghĩa.
 */
import assert from 'node:assert/strict';
import { ARMS, promotion } from '../tools/trajectory-matrix.mjs';
import { analyze } from '../tools/trajectory-fixture.mjs';
import { benchmarkConfigFor, benchmarkConfigHash, groupConsistency, profileConfigHash,
  provenance, ROW_SCHEMA, SPLITS, validateRow } from '../tools/trajectory-schema.mjs';

const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const PLAIN_AXES = Object.freeze({ quality: true, performance: true, safety: false });
/** Arm treatment (mọi arm trừ baseline `vanilla`). */
const TREATMENTS = ARMS.filter((arm) => arm !== 'vanilla');

/** Trường harness canonical cho một seed; quyết định `benchmark_config_hash`. */
const benchFields = (seed) => ({
  task_id: `heldout-fixture-${seed}`,
  // ≥2 lớp task là điều kiện BẮT BUỘC của promotion ⇒ trộn theo seed.
  task_class: seed < 5 ? 'routine' : 'bug-diagnosis',
  task_prompt_hash: `prompt-${seed}`, model: 'trajectory-router/fixture',
  dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
  evaluator: `evaluator-${seed}`, permission_mode: 'workspace-write', timeout_ms: 60_000,
});

/** Capability manifest mặc định cho từng arm (KHÔNG suy từ tên arm trong code thật). */
const capsFor = (arm) => (arm === 'vanilla' ? {} : { jev: { configured: true, available: true, invoked: true } });

/**
 * Dựng một row HỢP LỆ v2. Mọi hash TÍNH TỪ dữ liệu nguồn, ghi lại SAU override —
 * nên một fixture sai hash sẽ bị `validateRow` từ chối ngay, không lọt im lặng.
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
    repo_state: 'heldout-fixture-state', model: fields.model,
    dsh_version: fields.dsh_version, plugin_version: fields.plugin_version,
    benchmark_config, benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    arm, source: 'real', split: 'validation', mode: 'normal',
    // §10/§30: bằng chứng THẬT phải truy được về đúng mã nguồn + hợp đồng
    // evaluator, nếu không hai lần chạy cùng version vẫn có thể khác nhau.
    plugin_git_commit: 'a'.repeat(40), evaluator_hash: 'b'.repeat(64),

    // `run_id` là ranh giới MỘT lần thu thập (KHÔNG thuộc identity cặp): cả bộ dữ
    // liệu chia sẻ ĐÚNG một run. Ca "trộn split" ở §4 cố ý lệch `split`, không
    // phải `run_id`, nên vẫn diễn đạt bất nhất mà không trùng luật run_id.
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
    // Ghi đè hash SAU cùng để row luôn nhất quán với config đã resolve.
    benchmark_config_hash: benchmarkConfigHash(benchmark_config),
    profile_config_hash: profile_config === null ? null : profileConfigHash(profile_config),
  };
};

/**
 * 10 nhóm × 4 arm, `source:'real'`, mặc định `split:'validation'`.
 * Dùng ĐÚNG một mảng này cho mọi ca bên dưới, chỉ đổi `split` — nhờ vậy "cùng dữ
 * liệu, khác split" là sự thật kiểm chứng được, không phải hai fixture khác nhau.
 */
const REAL_ROWS = Array.from({ length: 10 }, (_, seed) =>
  ARMS.map((arm) => row(arm, seed))).flat();
const asSplit = (split) => REAL_ROWS.map((r) => ({ ...r, split }));

try {
  // ------------------------------------------------ §1 SPLITS + provenance
  assert.deepEqual([...SPLITS], ['train', 'validation', 'held-out', 'outage']);
  assert.equal(SPLITS.length, 4);
  assert.equal(provenance({ source: 'real', split: 'held-out' }), 'held-out-real');
  assert.equal(provenance({ source: 'real', split: 'validation' }), 'real');
  assert.equal(provenance({ source: 'real', split: 'train' }), 'real');
  assert.equal(provenance({ source: 'real', split: 'outage' }), 'real');
  // Nhãn `synthetic` THẮNG split: dữ liệu bịa không bao giờ là held-out thật.
  assert.equal(provenance({ source: 'synthetic', split: 'held-out' }), 'synthetic');

  // ------------------------------------------------ §2 validateRow từ chối split lạ
  for (const fixture of REAL_ROWS) {
    const check = validateRow(fixture);
    assert.equal(check.ok, true,
      `fixture ${fixture.task_id}/${fixture.arm} must be valid: ${check.reasons.join(', ')}`);
  }
  // Fixture phải dựa trên hash THẬT: sửa hash ⇒ bị từ chối (không hard-code được).
  // Dùng arm treatment (không phải vanilla) để lý do từ chối là ĐÚNG hash mismatch,
  // không phải luật "vanilla không được khai hash".
  const treatmentRow = REAL_ROWS.find((r) => r.arm === 'experimental');
  const tamperedProfile = validateRow({ ...treatmentRow, profile_config_hash: 'deadbeef' });
  assert.equal(tamperedProfile.ok, false);
  assert(tamperedProfile.reasons.includes('profile-config-hash-mismatch'));
  const tamperedBench = validateRow({ ...treatmentRow, benchmark_config_hash: 'deadbeef' });
  assert.equal(tamperedBench.ok, false);
  assert(tamperedBench.reasons.includes('benchmark-config-hash-mismatch'));
  const bogus = validateRow({ ...REAL_ROWS[0], split: 'bogus' });
  assert.equal(bogus.ok, false, "split 'bogus' must be rejected");
  assert(bogus.reasons.includes('unknown-split:bogus'));
  const noSplit = { ...REAL_ROWS[0] }; delete noSplit.split;
  const noSplitCheck = validateRow(noSplit);
  assert.equal(noSplitCheck.ok, false, 'missing split must be rejected');
  assert(noSplitCheck.reasons.includes('unknown-split:missing'));

  // ------------------------------------------------ §3 ĐIỂM MẤU CHỐT
  // CÙNG dữ liệu thật, split='validation' ⇒ pilot, KHÔNG phải bằng chứng promotion.
  const validationReport = analyze(encode(asSplit('validation')));
  assert.equal(validationReport.held_out_real_groups, 0,
    'validation rows must never count as held-out-real evidence');
  assert.equal(validationReport.complete_groups, 10, 'groups still form; the issue is provenance');
  assert.equal(validationReport.verdict, 'unknown');
  for (const arm of TREATMENTS) {
    assert.equal(validationReport.promotion[arm].status, 'hold',
      `${arm}: validation-only evidence must hold`);
    assert.equal(validationReport.promotion[arm].automatic_promotion, false);
    assert(validationReport.promotion[arm].reasons.includes('insufficient-held-out-pairs'),
      `${arm}: hold must be explained by insufficient held-out pairs`);
    assert.equal(validationReport.promotion[arm].held_out_pairs, 0);
  }
  // CÙNG dữ liệu, split='held-out' ⇒ lần đầu tiên đạt `eligible-for-review`.
  const heldOutReport = analyze(encode(asSplit('held-out')));
  assert.equal(heldOutReport.held_out_real_groups, 10,
    'held-out real groups must be counted — this was structurally unreachable before');
  assert.equal(heldOutReport.complete_groups, 10);
  assert.equal(heldOutReport.inconsistent_groups, 0);
  assert.equal(heldOutReport.verdict, 'unknown');
  for (const arm of TREATMENTS) {
    assert.equal(heldOutReport.promotion[arm].status, 'eligible-for-review',
      `${arm}: clean held-out evidence must be eligible-for-review`);
    assert.equal(heldOutReport.promotion[arm].held_out_pairs, 10);
    assert.equal(heldOutReport.promotion[arm].automatic_promotion, false);
  }

  // ------------------------------------------------ §4 nhóm TRỘN split bị LOẠI
  // Đúng ví dụ attachment: vanilla `held-out` + treatment `validation`. Nếu lấy
  // provenance từ row đầu tiên, cả nhóm sẽ bị gắn nhãn held-out — phải chặn.
  const mixedRows = REAL_ROWS.map((r) => ({ ...r, split: r.arm === 'vanilla' ? 'held-out' : 'validation' }));
  // Từng row TRỘN vẫn HỢP LỆ — nên nhóm bị loại là do NHẤT QUÁN NHÓM, không phải
  // vì fixture hỏng. Đây mới đúng điều cần chứng minh.
  for (const fixture of mixedRows) assert.equal(validateRow(fixture).ok, true);
  const seedZeroGroup = mixedRows.filter((r) => r.seed === 0);
  const consistency = groupConsistency(seedZeroGroup);
  assert.equal(consistency.consistent, false);
  assert(consistency.reasons.includes('inconsistent-group-split'),
    'mixed split must be reported as inconsistent-group-split');
  // Đối chứng DƯƠNG: nhóm đồng nhất split thì PHẢI nhất quán.
  assert.equal(groupConsistency(REAL_ROWS.filter((r) => r.seed === 0)).consistent, true);
  const mixedReport = analyze(encode(mixedRows));
  assert.equal(mixedReport.inconsistent_groups, 10, 'mixed-split groups must all be dropped');
  assert.equal(mixedReport.complete_groups, 0);
  assert.equal(mixedReport.held_out_real_groups, 0);
  assert.equal(mixedReport.rejected.length, 10, 'every mixed group must land in rejected');
  assert.equal(mixedReport.rejected.filter((entry) =>
    Array.isArray(entry.reasons) && entry.reasons.includes('inconsistent-group-split')).length, 10,
  'matrix must reject every mixed group with inconsistent-group-split');
  for (const arm of TREATMENTS) {
    assert.equal(mixedReport.promotion[arm].status, 'hold',
      `${arm}: a mixed-split group must never promote`);
    assert.equal(mixedReport.promotion[arm].held_out_pairs, 0);
    assert.equal(mixedReport.promotion[arm].automatic_promotion, false);
  }

  // ------------------------------------------------ §5 train/outage KHÔNG bao giờ là bằng chứng
  for (const split of ['train', 'outage']) {
    const report = analyze(encode(asSplit(split)));
    assert.equal(report.held_out_real_groups, 0, `${split} must never count as held-out-real`);
    assert.equal(report.verdict, 'unknown');
    for (const arm of TREATMENTS) {
      assert.equal(report.promotion[arm].status, 'hold', `${arm}: ${split} must hold`);
      assert.equal(report.promotion[arm].held_out_pairs, 0);
      assert.equal(report.promotion[arm].automatic_promotion, false);
    }
  }

  // ------------------------------------------------ §6 automatic_promotion LUÔN false
  for (const report of [validationReport, heldOutReport, mixedReport]) {
    for (const arm of TREATMENTS) {
      assert.equal(report.promotion[arm].automatic_promotion, false);
    }
  }
  const direct = promotion([], 'experimental');
  assert.equal(direct.automatic_promotion, false);
  assert.equal(direct.status, 'hold');

  console.log('PASS trajectory held-out provenance contract (real functions, offline)');
} catch (error) {
  console.error(`FAIL trajectory held-out provenance contract: ${error.message}`);
  process.exit(1);
}
