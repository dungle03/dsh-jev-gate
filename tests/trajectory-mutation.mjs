/**
 * §35 — Mutation test cho AN TOÀN promotion.
 *
 * Xuất phát từ MỘT dataset "khỏe" đạt `eligible-for-review`, rồi lần lượt phá
 * từng bất biến. Với MỌI mutation thuộc trường integrity-critical, `eligible-
 * for-review` PHẢI biến mất. Nếu một mutation mà trạng thái KHÔNG đổi, đó là lỗ
 * fail-open và test này thất bại.
 *
 * Không mock. Offline, tất định.
 */
import assert from 'node:assert/strict';
import { matrix } from '../tools/trajectory-matrix.mjs';
import { makeRow, healthyHeldOut, manifestFor, encode, analyze } from '../tools/trajectory-fixture.mjs';

const TREATMENTS = ['safe', 'balanced', 'experimental'];
let mutations = 0;
let blocked = 0;

/** Dataset nền: held-out thật, manifest khớp, mọi metric bắt buộc đủ. */
const baselineRows = healthyHeldOut();
const baselineManifest = manifestFor(baselineRows);
const baselineText = encode(baselineRows);

// Xác nhận ĐIỂM XUẤT PHÁT thật sự eligible — nếu không, mọi mutation vô nghĩa.
{
  const report = matrix(baselineText, { manifest: baselineManifest });
  for (const arm of TREATMENTS) {
    assert.equal(report.promotion[arm].status, 'eligible-for-review',
      `điểm xuất phát: ${arm} phải eligible trước khi mutation`);
  }
  assert.equal(report.run_integrity.verified, true, 'điểm xuất phát: run integrity phải verified');
}

/**
 * Áp một mutation rồi khẳng định `eligible-for-review` BIẾN MẤT ở mọi treatment.
 * `mutate` nhận (rows, manifest) và trả về `{rows, manifest}` (có thể sửa tại chỗ
 * bản sao — ta luôn clone trước).
 */
function mutation(label, mutate) {
  const rows = baselineRows.map((row) => ({ ...row }));
  const manifest = { ...baselineManifest };
  const next = mutate(rows, manifest) ?? { rows, manifest };
  const report = matrix(encode(next.rows), { manifest: next.manifest });
  mutations += 1;
  for (const arm of TREATMENTS) {
    const verdict = report.promotion[arm];
    assert.notEqual(verdict.status, 'eligible-for-review',
      `[${label}] ${arm} vẫn eligible sau mutation — LỖ FAIL-OPEN (reasons: ${verdict.reasons.join(', ')})`);
    assert.equal(verdict.automatic_promotion, false, `[${label}] ${arm} không được tự động promote`);
  }
  blocked += 1;
  return report;
}

/** Xoá một trường khỏi MỌI row treatment. */
const dropFromTreatments = (rows, key) => {
  for (const row of rows) if (row.arm !== 'vanilla') delete row[key];
};
/** Đặt một trường trên MỌI row treatment. */
const setOnTreatments = (rows, key, value) => {
  for (const row of rows) if (row.arm !== 'vanilla') row[key] = value;
};

// ── 1. Xoá trường định danh nguồn (không truy được revision/evaluator) ──────────
mutation('delete-plugin-git-commit', (rows) => { dropFromTreatments(rows, 'plugin_git_commit'); });
mutation('delete-evaluator-hash', (rows) => { dropFromTreatments(rows, 'evaluator_hash'); });
mutation('delete-dsh-version', (rows) => { dropFromTreatments(rows, 'dsh_version'); });
mutation('delete-repo-state', (rows) => { dropFromTreatments(rows, 'repo_state'); });
mutation('delete-task-id', (rows) => { dropFromTreatments(rows, 'task_id'); });
mutation('delete-run-id', (rows) => { dropFromTreatments(rows, 'run_id'); });
// ── 2. Làm cây nguồn dirty ⇒ không tái lập được ────────────────────────────────
mutation('set-plugin-dirty', (rows) => { setOnTreatments(rows, 'plugin_dirty_state', true); });
// ── 3. Phá hash cấu hình ──────────────────────────────────────────────────────
mutation('stale-profile-hash', (rows) => { setOnTreatments(rows, 'profile_config_hash', 'f'.repeat(64)); });
mutation('stale-benchmark-hash', (rows) => { setOnTreatments(rows, 'benchmark_config_hash', 'e'.repeat(64)); });
// ── 4. Trộn run / split / mode / commit / evaluator / endpoint ────────────────
mutation('mixed-run-id', (rows) => { rows[0].run_id = 'other-run'; });
mutation('mixed-split', (rows) => { rows[0].split = 'validation'; });
mutation('mixed-mode', (rows) => { rows[0].mode = 'jev-outage'; });
mutation('mixed-plugin-commit', (rows) => { rows[0].plugin_git_commit = 'c'.repeat(40); });
mutation('mixed-evaluator-hash', (rows) => { rows[0].evaluator_hash = 'd'.repeat(64); });
mutation('mixed-model-endpoint', (rows) => { rows[0].model_endpoint_origin = 'https://other.example/v1'; });
mutation('mixed-task-class', (rows) => { rows[0].task_class = 'multi-file-coding'; });
// ── 5. Vô hiệu hoá capability (available=false / exercised=false / bỏ entry) ──
mutation('capability-available-false', (rows) => {
  for (const row of rows) {
    if (row.arm === 'vanilla') continue;
    row.expected_capabilities_to_exercise = ['jevgrep'];
    row.capabilities = { ...row.capabilities, jevgrep: { configured: true, available: false, invoked: false } };
  }
});
mutation('capability-not-exercised', (rows) => {
  for (const row of rows) {
    if (row.arm === 'vanilla') continue;
    row.expected_capabilities_to_exercise = ['jevgrep'];
    row.capabilities = { ...row.capabilities, jevgrep: { configured: true, available: true, invoked: true, exercised: false } };
  }
});
mutation('capability-not-configured', (rows) => {
  for (const row of rows) {
    if (row.arm === 'vanilla') continue;
    row.expected_capabilities_to_exercise = ['jevgrep'];
    row.capabilities = { ...row.capabilities, jevgrep: { configured: false, available: false, invoked: false } };
  }
});
mutation('capability-entry-removed', (rows) => {
  for (const row of rows) {
    if (row.arm === 'vanilla') continue;
    row.expected_capabilities_to_exercise = ['jevgrep'];
    const next = { ...row.capabilities };
    delete next.jevgrep;
    row.capabilities = next;
  }
});
// ── 6. Phá số đo an toàn ─────────────────────────────────────────────────────
mutation('safety-metric-on-non-safety-task', (rows) => { setOnTreatments(rows, 'false_allow', 0); });
mutation('missing-safety-measurement', (rows) => {
  for (const row of rows) {
    row.measurement_axes = { quality: true, performance: true, safety: true };
    if (row.arm !== 'vanilla') { row.false_allow = null; row.false_deny = null; }
  }
});
mutation('safety-regression', (rows) => {
  for (const row of rows) {
    row.measurement_axes = { quality: true, performance: true, safety: true };
    row.false_allow = 0; row.false_deny = 0;
    if (row.arm !== 'vanilla') row.false_allow = 1;
  }
});
// ── 7. Phá metric bắt buộc (quality / performance) ───────────────────────────
mutation('quality-regression', (rows) => { setOnTreatments(rows, 'success', false); });
mutation('missing-walltime', (rows) => { dropFromTreatments(rows, 'walltime_ms'); });
mutation('negative-walltime', (rows) => { setOnTreatments(rows, 'walltime_ms', -1); });
// ── 8. Phá manifest ─────────────────────────────────────────────────────────
mutation('manifest-missing', () => ({ rows: baselineRows.map((row) => ({ ...row })), manifest: null }));
mutation('manifest-run-id-mismatch', (rows, manifest) => { manifest.run_id = 'other-run'; });
mutation('manifest-written-rows-mismatch', (rows, manifest) => { manifest.written_rows = manifest.written_rows - 1; });
mutation('manifest-expected-rows-mismatch', (rows, manifest) => { manifest.expected_rows = manifest.expected_rows + 4; });
mutation('manifest-arms-mismatch', (rows, manifest) => { manifest.arms = ['vanilla', 'safe']; });
mutation('manifest-seeds-mismatch', (rows, manifest) => { manifest.seeds = [999]; });
mutation('manifest-split-mismatch', (rows, manifest) => { manifest.split = 'validation'; });
mutation('manifest-status-incomplete', (rows, manifest) => { manifest.status = 'incomplete'; });
// ── 9. Thêm row hỏng (dataset không còn đầy đủ) ──────────────────────────────
mutation('add-corrupt-row', (rows, manifest) => {
  const next = [...rows, { ...rows[0] }];
  return { rows: next, manifest };
});
// §28: một dòng PHÌNH (artifact nhúng) làm dataset mất tính đầy đủ ⇒ không eligible.
mutation('add-oversized-row', (rows, manifest) => {
  const next = [...rows, { ...rows[0], detail: 'y'.repeat(300000) }];
  return { rows: next, manifest };
});
// ── 10. Phá telemetry operation ─────────────────────────────────────────────
mutation('operation-telemetry-problems', (rows) => {
  for (const row of rows) {
    if (row.arm === 'vanilla') continue;
    row.operation_telemetry_problems = [{ operation_id: 'op1', problem: 'completed-and-cancelled' }];
    row.success = false;
  }
});

// ── Đối chứng: mutation "vô hại" KHÔNG được làm mất eligible ─────────────────
// Thêm một row metadata KHÔNG thuộc identity (ví dụ `created_at`) không được đổi
// phán quyết — nếu không, test sẽ "chặn quá tay" và mất giá trị chẩn đoán.
{
  const rows = baselineRows.map((row) => ({ ...row, created_at: '2026-01-01T00:00:00.000Z' }));
  const report = matrix(encode(rows), { manifest: manifestFor(rows) });
  for (const arm of TREATMENTS) {
    assert.equal(report.promotion[arm].status, 'eligible-for-review',
      `đối chứng: thêm created_at (không thuộc identity) KHÔNG được đổi phán quyết ${arm}`);
  }
  // Và `cache_mode` ĐỔI ĐỒNG NHẤT trên toàn bộ run vẫn là một treatment hợp lệ
  // (đổi chế độ cache là đổi điều kiện đo, không phải trộn dữ liệu).
  const warm = baselineRows.map((row) => ({ ...row, cache_mode: 'warm' }));
  assert.equal(analyze(encode(warm), { manifest: manifestFor(warm) }).promotion.experimental.status,
    'eligible-for-review', 'đối chứng: cache_mode đổi đồng nhất vẫn hợp lệ');
  mutations += 1; blocked += 1;
}

console.log(`PASS trajectory mutation (${blocked}/${mutations} mutations blocked promotion, offline)`);
