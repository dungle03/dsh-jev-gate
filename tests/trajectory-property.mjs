/**
 * §36 — Property / invariant tests (offline, deterministic, hàng trăm ca).
 *
 * Kiểm những bất biến phải đúng với MỌI dataset, không chỉ vài ví dụ. Sinh ca
 * bằng seed tất định (LCG nội bộ) nên chạy lại cho cùng kết quả — không phụ thuộc
 * thời gian hay mạng.
 *
 * Sáu bất biến:
 *   1. Bỏ bằng chứng KHÔNG BAO GIỜ cải thiện trạng thái.
 *   2. Trường hợp lệ → unknown/null KHÔNG BAO GIỜ biến `hold` thành `eligible`.
 *   3. Thêm hồi quy an toàn KHÔNG BAO GIỜ cải thiện trạng thái.
 *   4. Đổi cấu hình treatment KHÔNG được âm thầm giữ nguyên treatment identity.
 *   5. Trộn run KHÔNG được làm TĂNG số cặp held-out.
 *   6. Thêm row hỏng KHÔNG được làm TĂNG số bằng chứng eligible.
 */
import assert from 'node:assert/strict';
import { matrix } from '../tools/trajectory-matrix.mjs';
import { capabilityValidity, profileConfigHash } from '../tools/trajectory-schema.mjs';
import { makeRow, healthyHeldOut, manifestFor, encode, analyze } from '../tools/trajectory-fixture.mjs';

const TREATMENTS = ['safe', 'balanced', 'experimental'];
/** Bậc thứ tự trạng thái: số nhỏ = bằng chứng mạnh hơn. */
const RANK = { regression: 0, 'eligible-for-review': 1, hold: 2 };
let cases = 0;

/** Sinh số giả ngẫu nhiên tất định (LCG) — không dùng Math.random. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const analyzeRows = (rows, options = {}) => analyze(encode(rows), options);

// ── Bất biến 1 + 5 + 6: bỏ bằng chứng / trộn run / thêm row hỏng ─────────────
// Với mỗi ca, so `held_out_pairs` và `status` trước/sau: bằng chứng chỉ được GIẢM
// hoặc giữ nguyên, không bao giờ tăng.
for (let seed = 1; seed <= 40; seed += 1) {
  const random = rng(seed);
  const pairs = 2 + Math.floor(random() * 9);
  const rows = healthyHeldOut({ pairs });
  const manifest = manifestFor(rows);
  const before = matrix(encode(rows), { manifest });

  // (a) Bỏ bằng chứng: xoá manifest ⇒ trạng thái không được tốt hơn.
  const noManifest = matrix(encode(rows), {});
  for (const arm of TREATMENTS) {
    assert(RANK[noManifest.promotion[arm].status] >= RANK[before.promotion[arm].status],
      `[drop-evidence] ${arm} không được cải thiện khi bỏ manifest`);
  }
  // (b) Trộn run: đổi run_id một row ⇒ số cặp held-out không được TĂNG.
  const mixed = rows.map((row, index) => (index === 0 ? { ...row, run_id: 'other' } : row));
  const mixedReport = matrix(encode(mixed), { manifest: manifestFor(mixed) });
  assert(mixedReport.promotion.experimental.held_out_pairs <= before.promotion.experimental.held_out_pairs,
    '[mixed-run] trộn run không được làm tăng số cặp');
  // (c) Thêm row hỏng: eligible evidence không được tăng.
  const corrupt = matrix(`${encode(rows)}\nnot-json`, { manifest });
  assert(corrupt.promotion.experimental.held_out_pairs <= before.promotion.experimental.held_out_pairs,
    '[corrupt-row] thêm row hỏng không được làm tăng bằng chứng');
  cases += 3;
}

// ── Bất biến 2: trường hợp lệ → unknown/null không bao giờ hold→eligible ─────
{
  const rows = healthyHeldOut({ pairs: 4 });
  const holdRows = rows.map((row) => (row.arm === 'vanilla' ? row
    : { ...row, capabilities: { ...row.capabilities, jevgrep: { configured: true, available: null, invoked: false } },
      expected_capabilities_to_exercise: ['jevgrep'] }));
  const holdReport = matrix(encode(holdRows), { manifest: manifestFor(holdRows) });
  assert.equal(holdReport.promotion.experimental.status, 'hold', 'điểm xuất phát phải là hold');
  // Đổi `null` → `undefined` (vắng mặt) và → `false` (phủ định) đều KHÔNG được
  // biến hold thành eligible: cả hai vẫn là "chưa chứng minh".
  for (const value of [undefined, false]) {
    const mutated = holdRows.map((row) => (row.arm === 'vanilla' ? row
      : { ...row, capabilities: { ...row.capabilities,
        jevgrep: { configured: true, available: value, invoked: false } } }));
    const report = matrix(encode(mutated), { manifest: manifestFor(mutated) });
    assert.notEqual(report.promotion.experimental.status, 'eligible-for-review',
      `[unknown-capability:${String(value)}] không được biến hold thành eligible`);
    cases += 1;
  }
}

// ── Bất biến 3: thêm hồi quy an toàn không bao giờ cải thiện ─────────────────
for (let seed = 1; seed <= 25; seed += 1) {
  const random = rng(seed * 7919);
  const pairs = 2 + Math.floor(random() * 8);
  const rows = healthyHeldOut({ pairs, overrides: { measurement_axes: { quality: true, performance: true, safety: true } } });
  const before = matrix(encode(rows), { manifest: manifestFor(rows) });
  // Tiêm false_allow vào MỘT treatment ⇒ không được tốt hơn trước đó.
  const withRegression = rows.map((row) => (row.arm === 'experimental' ? { ...row, false_allow: 1 } : row));
  const after = matrix(encode(withRegression), { manifest: manifestFor(withRegression) });
  assert(RANK[after.promotion.experimental.status] <= RANK[before.promotion.experimental.status],
    '[safety-regression] thêm hồi quy an toàn không được cải thiện trạng thái');
  cases += 1;
}

// ── Bất biến 4: đổi cấu hình treatment không giữ nguyên identity ─────────────
{
  const rows = healthyHeldOut({ pairs: 5 });
  const before = matrix(encode(rows), { manifest: manifestFor(rows) });
  // Đổi config ở MỘT NỬA số nhóm experimental ⇒ hai treatment bị trộn.
  let experimentalSeen = 0;
  const mixedConfig = rows.map((row) => {
    if (row.arm !== 'experimental') return row;
    experimentalSeen += 1;
    if (experimentalSeen % 2 !== 0) return row;
    const profileConfig = { profile: 'experimental', reviewTimeoutMs: 12345 };
    return { ...row, profile_config: profileConfig, profile_config_hash: profileConfigHash(profileConfig) };
  });
  const report = matrix(encode(mixedConfig), { manifest: manifestFor(mixedConfig) });
  assert(report.promotion.experimental.reasons.includes('inconsistent-arm-configuration')
    || report.promotion.experimental.held_out_pairs < before.promotion.experimental.held_out_pairs,
    '[config-change] đổi config phải làm treatment identity khác (không âm thầm gộp)');
  assert.notEqual(report.promotion.experimental.status, 'eligible-for-review',
    '[config-change] trộn hai treatment không được eligible');
  cases += 1;
}

// ── Bất biến bổ sung: capabilityValidity đơn điệu theo bằng chứng ────────────
// Thêm bằng chứng (exercised) chỉ được làm kết quả TỐT LÊN hoặc giữ nguyên, và
// bỏ bằng chứng chỉ được làm XẤU ĐI hoặc giữ nguyên — không bao giờ ngược lại.
{
  const names = ['jevgrep', 'failure_recovery', 'quality_review'];
  for (const name of names) {
    const base = { capabilities: { [name]: { configured: true, available: true, invoked: true } },
      expected_capabilities_to_exercise: [name] };
    const notExercised = capabilityValidity(base, [name], { role: 'treatment' });
    const exercised = capabilityValidity({ ...base,
      capabilities: { [name]: { configured: true, available: true, invoked: true, exercised: true } } },
    [name], { role: 'treatment' });
    assert.equal(notExercised.valid, false, `${name}: chưa exercise phải invalid/incomplete`);
    assert.equal(exercised.valid, true, `${name}: đã exercise phải hợp lệ`);
    cases += 1;
  }
}

console.log(`PASS trajectory property (${cases} generated cases, real functions, offline)`);
