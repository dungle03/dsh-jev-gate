/**
 * Bộ phân tích trajectory — CHỈ ĐỌC. Không chạy task, không bật feature, không
 * sinh bằng chứng A/B.
 *
 * Vì sao bản này khác bản cũ (v1):
 *   - v1 ghép cặp chỉ theo task_id+seed+repo_state+model, nên hai row cùng tên
 *     arm nhưng khác DSH/plugin/config bị coi là MỘT treatment. v2 ghép theo
 *     identity đầy đủ (gồm `benchmark_config_hash`, `dsh_version`,
 *     `plugin_version`) và TỪ CHỐI row thiếu trường.
 *   - v1 đếm `jev_calls` từ `jev_ok`; một logical call retry 3 lần HTTP vẫn ra
 *     "1 call". v2 lấy số thật từ operation telemetry
 *     (`actual_invocations`), tách logical / success / fail / http attempt.
 *   - v1 có thể coi "arm thiếu capability" là regression hiệu năng. v2 phân
 *     biệt: môi trường capability KHÔNG hợp lệ ⇒ `hold` với lý do riêng, không
 *     phải regression.
 *   - Parser TỪ CHỐI schema không hỗ trợ thay vì hiểu nhầm row cũ thành row mới.
 *
 * Promotion vẫn bảo thủ: không bao giờ tự promote; trần là `eligible-for-review`.
 */
import { ARMS, capabilityValidity, MATRIX_SCHEMA, promotionMetrics,
  provenance, ROW_SCHEMA, SUPPORTED_ROW_SCHEMAS, TASK_CLASSES, validateRow } from './trajectory-schema.mjs';

export { ARMS };

/** Cột hiển thị trong bảng so sánh: metric chuẩn + operation metric thật. */
const DISPLAY = Object.freeze([
  'success', 'test_pass_rate', 'walltime_ms', 'cost_usd', 'false_allow', 'false_deny',
  'decision_reserved_units', 'decision_actual_invocations', 'jev_http_attempts',
  'review_tool_invocations', 'jevgrep_process_spawns',
  'decision_operation_failures', 'decision_operation_cancellations',
]);

const toNum = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Một metric thiếu là `null`, KHÔNG phải 0 — người đọc thấy ngay là chưa đo. */
export function metricValue(row, key) {
  if (key === 'test_pass_rate') {
    const passed = toNum(row.tests_passed); const total = toNum(row.tests_total);
    return passed !== null && total !== null && total > 0 ? passed / total : null;
  }
  return toNum(row[key]);
}

/** Trung bình của metric trên một nhóm row; `null` nếu KHÔNG row nào đo được. */
export function mean(rows, key) {
  const values = rows.map((row) => metricValue(row, key)).filter((value) => value !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const sum = (rows, key) => {
  const values = rows.map((row) => toNum(row[key])).filter((value) => value !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

/** Tổng hợp một arm: trung bình metric + tổng operation metric. */
export function armSummary(rows) {
  const metrics = {};
  for (const key of DISPLAY) metrics[key] = mean(rows, key);
  return {
    rows: rows.length,
    successes: rows.filter((row) => row.success === true).length,
    metrics,
    operations: {
      reserved_units: sum(rows, 'decision_reserved_units'),
      actual_invocations: sum(rows, 'decision_actual_invocations'),
      jev_http_attempts: sum(rows, 'jev_http_attempts'),
      review_tool_invocations: sum(rows, 'review_tool_invocations'),
      jevgrep_process_spawns: sum(rows, 'jevgrep_process_spawns'),
      failures: sum(rows, 'decision_operation_failures'),
      cancellations: sum(rows, 'decision_operation_cancellations'),
    },
  };
}

/**
 * Promotion cho một arm so với `vanilla`. Chỉ dùng nhóm `held-out-real`.
 *
 * Trả `status` ∈ {regression, hold, eligible-for-review}. Không bao giờ
 * `promote`. Môi trường capability không hợp lệ ⇒ `hold` với
 * `invalid-or-incomplete-capability-environment` — KHÔNG tính là regression.
 */
export function promotion(groups, arm, { minPairs = 10, minClasses = 2 } = {}) {
  const reasons = [];
  const heldOut = groups.filter((group) => group.provenance === 'held-out-real');
  const usable = [];
  let invalidGroups = 0; let incompleteGroups = 0;
  for (const group of heldOut) {
    const base = group.arms.vanilla; const treatment = group.arms[arm];
    if (!base || !treatment) { reasons.push('missing-arm-in-pair'); continue; }
    const baseValidity = capabilityValidity(base); const treatValidity = capabilityValidity(treatment);
    if (baseValidity.invalid.length || treatValidity.invalid.length) {
      invalidGroups += 1;
      reasons.push('invalid-or-incomplete-capability-environment');
      continue;
    }
    if (baseValidity.incomplete.length || treatValidity.incomplete.length) {
      incompleteGroups += 1;
      reasons.push('incomplete-capability-evidence');
      continue;
    }
    usable.push(group);
  }
  const taskClasses = [...new Set(usable.map((group) => group.task_class))];
  // Cùng tên arm nhưng `profile_config_hash` khác giữa các nhóm nghĩa là nhiều
  // treatment bị trộn — không được coi là một bằng chứng duy nhất.
  const treatmentConfigs = new Set(usable.map((group) => group.arms[arm]?.profile_config_hash ?? null));
  if (treatmentConfigs.size > 1) reasons.push('inconsistent-arm-configuration');
  const result = {
    status: 'hold', automatic_promotion: false,
    held_out_pairs: usable.length, task_classes: taskClasses.length,
    min_pairs: minPairs, min_classes: minClasses,
    invalid_capability_groups: invalidGroups, incomplete_capability_groups: incompleteGroups,
    treatment_config_hashes: [...treatmentConfigs],
    reasons: [...new Set(reasons)], per_class: {},
  };
  if (usable.length < minPairs) result.reasons.push('insufficient-held-out-pairs');
  if (taskClasses.length < minClasses) result.reasons.push('insufficient-task-classes');
  for (const [key, spec] of Object.entries(promotionMetrics())) {
    for (const group of usable) {
      const base = metricValue(group.arms.vanilla, key);
      const treatment = metricValue(group.arms[arm], key);
      if (base === null || treatment === null) {
        if (!result.reasons.includes('missing-required-measurements')) result.reasons.push('missing-required-measurements');
        continue;
      }
      const regressed = spec.direction === 'lower-is-better' ? treatment > base : treatment < base;
      if (regressed) {
        const reason = spec.kind === 'safety' ? 'safety-regression'
          : spec.kind === 'quality' ? 'quality-regression' : 'performance-regression';
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
        // Thụt lùi an toàn/chất lượng là `regression`; chậm/tốn hơn chỉ là `hold`.
        if (spec.kind === 'safety' || spec.kind === 'quality') result.status = 'regression';
        const bucket = result.per_class[group.task_class] ?? (result.per_class[group.task_class] = {});
        bucket[key] = { vanilla: base, [arm]: treatment, regressed: true };
      }
    }
  }
  if (result.status !== 'regression' && result.reasons.length === 0) result.status = 'eligible-for-review';
  return result;
}

// Ghép cặp theo identity ĐẦY ĐỦ. `profile_config_hash` KHÔNG nằm ở đây vì mỗi arm
// có config riêng — nó là phần định danh treatment của arm, kiểm ở dưới.
const keyOf = (row) => JSON.stringify([row.task_id, row.seed, row.repo_state, row.model,
  row.benchmark_config_hash, row.dsh_version, row.plugin_version]);

/**
 * Phân tích JSONL thành báo cáo matrix v2.
 * Row sai schema / thiếu identity bị đưa vào `rejected` (không hiểu nhầm).
 */
export function matrix(text) {
  const rows = []; const rejected = []; const incomplete = [];
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { rejected.push({ reason: 'invalid-json' }); continue; }
    if (!SUPPORTED_ROW_SCHEMAS.includes(row?.schema)) {
      rejected.push({ reason: `unsupported-schema:${row?.schema ?? 'missing'}` });
      continue;
    }
    const check = validateRow(row);
    if (!check.ok) {
      (check.reasons.includes('incomplete-pair-identity') ? incomplete : rejected)
        .push({ schema: row.schema, task_id: row.task_id ?? null, arm: row.arm ?? null, reasons: check.reasons });
      continue;
    }
    rows.push(row);
  }
  // Duplicate (cùng arm + cùng identity) là dấu hiệu dữ liệu bị trộn ⇒ vứt cả nhóm.
  // Cùng arm nhưng `profile_config_hash` khác ⇒ hai treatment khác nhau, cũng vứt.
  const byIdentity = new Map();
  for (const row of rows) {
    const key = `${keyOf(row)}|${row.arm}`;
    if (byIdentity.has(key)) { byIdentity.set(key, null); rejected.push({ reason: 'duplicate-arm-in-pair', arm: row.arm, task_id: row.task_id }); }
    else byIdentity.set(key, row);
  }
  const unique = [...byIdentity.values()].filter(Boolean);
  const groupsMap = new Map();
  for (const row of unique) {
    const key = keyOf(row);
    if (!groupsMap.has(key)) groupsMap.set(key, { key, task_id: row.task_id, task_class: row.task_class,
      seed: row.seed, model: row.model, dsh_version: row.dsh_version, plugin_version: row.plugin_version,
      benchmark_config_hash: row.benchmark_config_hash,
      provenance: provenance(row), arms: {} });
    groupsMap.get(key).arms[row.arm] = row;
  }
  const groups = [...groupsMap.values()];
  const complete = groups.filter((group) => ARMS.every((arm) => group.arms[arm]));
  const arms = {};
  for (const arm of ARMS) {
    const armRows = unique.filter((row) => row.arm === arm);
    arms[arm] = armSummary(armRows);
  }
  const byEffort = {};
  for (const row of unique) {
    const effort = row.effort ?? 'unknown';
    const bucket = byEffort[effort] ?? (byEffort[effort] = { rows: 0, successes: 0, generations: null,
      walltime_ms: null, input_tokens: null });
    bucket.rows += 1;
    if (row.success === true) bucket.successes += 1;
  }
  for (const [effort, bucket] of Object.entries(byEffort)) {
    const subset = unique.filter((row) => (row.effort ?? 'unknown') === effort);
    bucket.generations = mean(subset, 'generations');
    bucket.walltime_ms = mean(subset, 'walltime_ms');
    bucket.input_tokens = mean(subset, 'input_tokens');
  }
  const promotionReport = {};
  for (const arm of ARMS) {
    if (arm === 'vanilla') continue;
    promotionReport[arm] = promotion(groups, arm);
  }
  return {
    schema: MATRIX_SCHEMA,
    row_schema: ROW_SCHEMA,
    arms,
    complete_groups: complete.length,
    held_out_real_groups: complete.filter((group) => group.provenance === 'held-out-real').length,
    task_classes: [...new Set(unique.map((row) => row.task_class))].sort(),
    supported_task_classes: [...TASK_CLASSES],
    verdict: 'unknown',
    note: 'Measurement analyzer only. Validation rows are not promotion evidence; '
      + 'performance benefit stays unknown until enough held-out paired groups exist.',
    comparisons: complete.map((group) => ({ key: group.key, task_id: group.task_id,
      task_class: group.task_class, provenance: group.provenance,
      arms: Object.fromEntries(ARMS.map((arm) => [arm, armSummary([group.arms[arm]])])) })),
    by_effort: byEffort,
    incomplete,
    rejected,
    promotion: promotionReport,
  };
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Kiểm manifest đi kèm trước khi phân tích. Row được ghi dần, nên một file JSONL
 * thiếu row (tiến trình bị giết giữa chừng) trông không khác gì file đầy đủ.
 * THUẦN: nhận nội dung manifest (hoặc null), trả cảnh báo machine-readable.
 */
export function manifestWarning(manifest) {
  if (manifest === null || manifest === undefined) {
    return 'no-run-manifest: completeness of this JSONL was not recorded';
  }
  if (manifest.status !== 'complete') {
    return `incomplete-run-manifest: run status is ${JSON.stringify(manifest.status)}`;
  }
  if (Number.isFinite(manifest.expected_rows) && Number.isFinite(manifest.written_rows)
    && manifest.written_rows !== manifest.expected_rows) {
    return `incomplete-run-manifest: wrote ${manifest.written_rows} of ${manifest.expected_rows} rows`;
  }
  return null;
}

/**
 * Tự kiểm THUẦN trên dữ liệu SYNTHETIC (không đo gì thật, không gọi mạng).
 * Mục đích: chứng minh parser/promotion từ chối đúng các dạng row hỏng mà
 * không cần dữ liệu thật.
 */
export function selfTest() {
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test: ${message}`); };
  const RS = ROW_SCHEMA;
  const base = (arm, overrides = {}) => ({
    schema: RS, task_id: 'synthetic-task', task_class: 'routine', seed: 1,
    repo_state: 'fixturehash', model: 'trajectory-router/synthetic', dsh_version: '0.2.0-rc.2',
    plugin_version: '0.14.0', benchmark_config_hash: 'benchhash', arm, source: 'synthetic',
    split: 'held-out', profile: arm === 'vanilla' ? null : arm,
    profile_config: arm === 'vanilla' ? null : { profile: arm },
    profile_config_hash: arm === 'vanilla' ? null : `hash-${arm}`,
    capabilities: { jev: { configured: arm !== 'vanilla', available: true, invoked: true } },
    operations: { reserved_units: 1, actual_invocations: 1, jev: { actual_invocations: 1 } },
    success: true, tests_passed: 1, tests_total: 1, false_allow: 0, false_deny: 0,
    walltime_ms: 100, cost_usd: 0, effort: 'low', ...overrides,
  });
  // 1. Row v1 (schema cũ) bị TỪ CHỐI, không hiểu nhầm thành row mới.
  const v1 = matrix(JSON.stringify({ schema: 'trajectory-matrix-v1', task_id: 'x', arm: 'safe' }));
  assert(v1.rejected.some((entry) => /unsupported-schema/.test(entry.reason)), 'v1 schema must be rejected');
  // 2. Row thiếu identity ⇒ incomplete, KHÔNG bị ghép cặp.
  const noVersion = base('safe'); delete noVersion.dsh_version;
  const incompleteReport = matrix(JSON.stringify(noVersion));
  assert(incompleteReport.incomplete.length === 1, 'row missing dsh_version must be incomplete');
  assert(incompleteReport.complete_groups === 0, 'incomplete row must not form a group');
  // 3. Duplicate (cùng identity + cùng arm) bị vứt, không thành hai treatment.
  const dup = [base('safe'), base('safe')].map((row) => JSON.stringify(row)).join('\n');
  assert(matrix(dup).rejected.some((entry) => entry.reason === 'duplicate-arm-in-pair'), 'duplicate must be rejected');
  // 4. Capability KHÔNG hợp lệ (jg unavailable) ⇒ hold với lý do capability, KHÔNG regression.
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    for (const arm of ARMS) {
      const capability = arm === 'experimental'
        ? { jevgrep: { configured: true, available: false, invoked: false } }
        : { jev: { configured: arm !== 'vanilla', available: true, invoked: true } };
      rows.push(base(arm, { seed: i, task_class: i % 2 ? 'routine' : 'bug-diagnosis',
        // Held-out THẬT (synthetic chỉ để tự kiểm parser, không phải bằng chứng).
        source: 'real', split: 'held-out',
        capabilities: capability,
        // experimental chậm hơn (nhưng phải bị chặn bởi capability, không phải regression)
        walltime_ms: arm === 'experimental' ? 500 : 100,
        profile_config_hash: arm === 'vanilla' ? null : `hash-${arm}` }));
    }
  }
  const report = matrix(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert(report.schema === MATRIX_SCHEMA, 'matrix schema must be v2');
  assert(report.complete_groups === 10, `expected 10 complete groups, got ${report.complete_groups}`);
  assert(report.held_out_real_groups === 10, 'held-out real groups must be counted');
  const promotionReport = report.promotion.experimental;
  assert(promotionReport.automatic_promotion === false, 'promotion must never be automatic');
  assert(promotionReport.status === 'hold', `invalid capability must hold, got ${promotionReport.status}`);
  assert(promotionReport.reasons.includes('invalid-or-incomplete-capability-environment'),
    'invalid capability reason must be present');
  assert(!promotionReport.reasons.includes('performance-regression'),
    'invalid capability must NOT be reported as a performance regression');
  // 5. Metric thiếu vẫn `null`, KHÔNG tự thành 0.
  const missing = matrix(JSON.stringify(base('safe', { cost_usd: null, false_allow: null })));
  assert(missing.arms.safe.metrics.cost_usd === null, 'missing cost must stay null');
  assert(missing.arms.safe.metrics.false_allow === null, 'missing false_allow must stay null');
  // 6. Cùng arm nhưng config khác ⇒ KHÔNG ghép thành một treatment.
  const diffConfig = [base('safe'), base('safe', { seed: 2, profile_config_hash: 'other' })];
  assert(matrix(diffConfig.map((row) => JSON.stringify(row)).join('\n')).complete_groups === 0,
    'different config hashes must not pair');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (input === '--self-test') {
    try { selfTest(); console.log('trajectory-matrix self-test: PASS (synthetic, not measured A/B)'); }
    catch (error) { console.error(`trajectory-matrix self-test: FAIL — ${error.message}`); process.exitCode = 1; }
  } else if (!input || input.startsWith('--')) {
    console.error('Usage: node tools/trajectory-matrix.mjs TRAJECTORIES.jsonl | --self-test');
    process.exitCode = 1;
  } else {
    const manifestPath = `${resolve(input)}.manifest.json`;
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const report = matrix(readFileSync(input, 'utf8'));
    const warning = manifestWarning(manifest);
    // Manifest cho biết file JSONL có đầy đủ không; cảnh báo rõ nhưng KHÔNG chặn
    // phân tích (người dùng vẫn xem được phần đã đo).
    if (warning) report.manifest_warning = warning;
    console.log(JSON.stringify(report, null, 2));
  }
}
