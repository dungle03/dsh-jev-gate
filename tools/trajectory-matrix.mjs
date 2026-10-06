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
import { ARMS, benchmarkConfigFor, benchmarkConfigHash, CAPABILITY_SPECS, capabilityValidity,
  groupConsistency, MATRIX_SCHEMA, measuresAxis, profileConfigHash, promotionMetrics,
  provenance, ROW_SCHEMA, SUPPORTED_ROW_SCHEMAS, TASK_CLASSES, validateRow,
  verifyManifestAgainstRows, MAX_ROW_BYTES } from './trajectory-schema.mjs';

export { ARMS };

/** Cột hiển thị trong bảng so sánh: metric chuẩn + operation metric thật. */
const DISPLAY = Object.freeze([
  'success', 'test_pass_rate', 'walltime_ms', 'cost_usd',
  'input_tokens', 'output_tokens', 'reasoning_tokens', 'resource_invocations',
  'false_allow', 'false_deny',
  'decision_reserved_units', 'decision_actual_invocations', 'jev_http_attempts',
  'review_tool_invocations', 'review_time_ms', 'jevgrep_process_spawns', 'jevgrep_time_ms',
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
  // `resource_invocations` = chi phí nguồn lực ĐO ĐƯỢC (số lần gọi thật từ
  // operation telemetry), khác hẳn `cost_usd` (tiền thật, không có nguồn). Đây là
  // chỉ số chi phí có bằng chứng thật, nên được `required`. Lấy từ trường tổng hợp
  // cấp row; nếu row chỉ có bản gộp `operations.actual_invocations` thì dùng nó —
  // cùng một đại lượng telemetry, không phải suy đoán.
  if (key === 'resource_invocations') {
    return toNum(row.decision_actual_invocations ?? row.operations?.actual_invocations);
  }
  return toNum(row[key]);
}

/** Trung bình của metric trên một nhóm row; `null` nếu KHÔNG row nào đo được. */
export function mean(rows, key) {
  const values = rows.map((row) => metricValue(row, key)).filter((value) => value !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Trung vị; `null` nếu không có mẫu. */
export function median(values) {
  const list = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Phân vị tuyến tính (nội suy) trên mảng đã lọc; `null` nếu rỗng. */
export function percentile(values, p) {
  const list = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const rank = (p / 100) * (list.length - 1);
  const low = Math.floor(rank); const high = Math.ceil(rank);
  return low === high ? list[low] : list[low] + (list[high] - list[low]) * (rank - low);
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
 * Phân tích theo LỚP: một capability `available` KHÔNG chứng minh nó được dùng.
 * Với mỗi capability, đếm riêng:
 *   - `configured` / `available` / `invoked`: theo capability manifest của row;
 *   - `expected`: số row có task KHAI capability này trong
 *     `expected_capabilities_to_exercise` (task lẽ ra phải exercise nó);
 *   - `exercised`: số row có BẰNG CHỨNG theo TỪNG LỚP rằng lớp đó thực sự chạy
 *     (`capabilities[name].exercised === true`), VÀ task khai cần nó.
 * KHÔNG dùng làm promotion gate toàn cục; chỉ để đọc giá trị theo lớp.
 *
 * Vì sao theo TỪNG lớp (§2): bản cũ dùng MỘT cờ `feature_exercised` cho cả row,
 * nên một task khai nhiều capability không thể nói lớp NÀO đã chạy — cờ chung bật
 * lên là mọi lớp đều "đã chạy" trên giấy. Nay bằng chứng nằm ở từng capability.
 */
export function layerCoverage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const report = {};
  for (const spec of CAPABILITY_SPECS) {
    let configured = 0; let available = 0; let invoked = 0; let expected = 0; let exercised = 0;
    for (const row of list) {
      const entry = row?.capabilities?.[spec.name];
      if (entry?.configured === true) configured += 1;
      if (entry?.available === true) available += 1;
      if (entry?.invoked === true) invoked += 1;
      const declared = Array.isArray(row?.expected_capabilities_to_exercise)
        && row.expected_capabilities_to_exercise.includes(spec.name);
      if (declared) expected += 1;
      if (declared && entry?.exercised === true) exercised += 1;
    }
    // Chỉ báo cáo lớp có xuất hiện (được cấu hình hoặc được task khai) — tránh
    // bảng toàn số 0 gây hiểu nhầm là "đã đo và không thấy".
    if (configured || expected) report[spec.name] = { configured, available, invoked, expected, exercised };
  }
  return report;
}

/**
 * Promotion cho MỘT arm so với `vanilla`. Chỉ dùng nhóm `held-out-real`.
 *
 * Trả `status` ∈ {regression, hold, eligible-for-review}. Không bao giờ `promote`.
 *
 * Luật (43-section audit):
 *   - Môi trường capability KHÔNG hợp lệ ⇒ `hold` + lý do capability, KHÔNG phải
 *     regression (§1/§25). Bằng chứng thiếu ⇒ `hold`, không đoán.
 *   - Capability task YÊU CẦU phải được treatment THẬT SỰ cấu hình VÀ CHẠY
 *     (`exercised`), không chỉ `available` (§1/§2).
 *   - Run integrity không xác minh ⇒ `hold` + `unverified-run-integrity` (§4/§5).
 *   - Chỉ nhóm qua mọi phép kiểm mới vào `held_out_pairs`.
 *   - Đối chiếu THEO CẶP (paired delta), tổng hợp theo nhóm + task class; dùng
 *     median/mean + phân vị, không để một outlier quyết định (§8).
 *   - Thụt lùi safety/chất lượng ⇒ `regression` ngay; chậm/tốn hơn ⇒ `hold` với
 *     `performance-regression-signal` (§25). Không hạ chuẩn safety.
 *   - `automatic_promotion` LUÔN false (§24).
 *
 * `options.runIntegrity` (§4): `{ verified: true, source: 'manifest'|'synthetic-fixture', problems: [] }`.
 *   Dataset có row `source:'real'` mà KHÔNG có `verified:true` ⇒ mọi treatment
 *   `hold` + `unverified-run-integrity`. Đây là đường API công khai, PHẢI khớp CLI
 *   để không có khe "CLI chặt / library hở".
 */
export function promotion(groups, arm, { minPairs = 10, minClasses = 2, runIntegrity = null } = {}) {
  const reasons = [];
  const heldOut = groups.filter((group) => group.provenance === 'held-out-real');
  // Nếu có bất kỳ nhóm held-out nào đến từ dữ liệu THẬT, run integrity phải được
  // xác minh. `syntheticTestMode`/`source:'synthetic-fixture'` là đường duy nhất
  // được miễn — và phải khai tường minh, không được suy diễn.
  const hasReal = heldOut.some((group) => group.arms[arm]?.source === 'real'
    || group.arms.vanilla?.source === 'real');
  // §4: CHỈ hai nguồn hợp lệ — `manifest` (đã đối chiếu với row thật) và
  // `synthetic-fixture` (fixture khai TƯỜNG MINH). Một object `{verified:true}` trần
  // hay `source` lạ KHÔNG phải bằng chứng: thiếu nguồn ⇒ không xác minh được. Bản cũ
  // nhận mọi `{verified:true}` nên `{verified:true,source:'bogus'}` cũng qua.
  const integrityOk = !hasReal
    || (runIntegrity && runIntegrity.verified === true
      && (runIntegrity.source === 'synthetic-fixture' || runIntegrity.source === 'manifest'));
  if (!integrityOk) reasons.push('unverified-run-integrity');
  const usable = [];
  let invalidGroups = 0; let incompleteGroups = 0;
  for (const group of heldOut) {
    const base = group.arms.vanilla; const treatment = group.arms[arm];
    if (!base || !treatment) { reasons.push('missing-arm-in-pair'); continue; }
    // Chỉ kiểm capability mà task THỰC SỰ khai là cần exercise: một task không
    // cần jevgrep không bị mất giá trị chỉ vì jevgrep không đo được.
    const expected = Array.isArray(treatment.expected_capabilities_to_exercise)
      ? treatment.expected_capabilities_to_exercise : null;
    const baseValidity = capabilityValidity(base, expected, { role: 'baseline' });
    const treatValidity = capabilityValidity(treatment, expected, { role: 'treatment' });
    if (baseValidity.invalid.length || treatValidity.invalid.length) {
      invalidGroups += 1;
      if (!reasons.includes('invalid-or-incomplete-capability-environment')) {
        reasons.push('invalid-or-incomplete-capability-environment');
      }
      continue;
    }
    if (baseValidity.incomplete.length || treatValidity.incomplete.length) {
      incompleteGroups += 1;
      if (!reasons.includes('incomplete-capability-evidence')) reasons.push('incomplete-capability-evidence');
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
    // Hồ sơ coverage: mỗi gate chỉ tính trên tập task phù hợp với nó.
    quality_pairs: usable.length,
    safety_pairs: usable.filter((group) => measuresAxis(group.arms[arm], 'safety')).length,
    reasons: [...new Set(reasons)], per_class: {},
  };
  if (usable.length < minPairs) result.reasons.push('insufficient-held-out-pairs');
  if (taskClasses.length < minClasses) result.reasons.push('insufficient-task-classes');
  for (const [key, spec] of Object.entries(promotionMetrics())) {
    // Đối chiếu THEO CẶP (§8): mỗi nhóm cho một delta (treatment - vanilla) trên
    // cùng task/seed/repo. Tổng hợp delta, không so hai mean rời rạc — tránh để
    // chênh lệch giữa các task khác nhau trông như tác động của plugin.
    const deltas = [];
    let safetyTaskSeen = false; let safetyMeasured = false;
    for (const group of usable) {
      const baseRow = group.arms.vanilla; const treatRow = group.arms[arm];
      // Metric an toàn chỉ xét trên task khai trục safety. Task khác giữ `null`
      // và KHÔNG bị coi là "thiếu số đo".
      if (spec.axis === 'safety' && !measuresAxis(treatRow, 'safety')) continue;
      if (spec.axis === 'safety') safetyTaskSeen = true;
      const base = metricValue(baseRow, key);
      const treatment = metricValue(treatRow, key);
      if (base === null || treatment === null) {
        // `cost_usd`/token không có nguồn dữ liệu: thiếu nó là "chưa đo được",
        // không phải "không đạt". Chỉ metric bắt buộc mới chặn promotion.
        if (spec.axis === 'safety') {
          if (!result.reasons.includes('missing-safety-measurements')) result.reasons.push('missing-safety-measurements');
        } else if (spec.required && !result.reasons.includes('missing-required-measurements')) {
          result.reasons.push('missing-required-measurements');
        }
        continue;
      }
      if (spec.axis === 'safety') safetyMeasured = true;
      deltas.push(treatment - base);
    }
    if (deltas.length === 0) continue;
    const worse = spec.direction === 'lower-is-better'
      ? deltas.filter((delta) => delta > 0) : deltas.filter((delta) => delta < 0);
    const medianDelta = median(deltas);
    const regressed = spec.direction === 'lower-is-better' ? medianDelta > 0 : medianDelta < 0;
    if (regressed && worse.length > 0) {
      const reason = spec.kind === 'safety' ? 'safety-regression'
        : spec.kind === 'quality' ? 'quality-regression' : 'performance-regression-signal';
      if (!result.reasons.includes(reason)) result.reasons.push(reason);
      // Thụt lùi an toàn/chất lượng là `regression`; chậm/tốn hơn chỉ là `hold`
      // với tín hiệu `performance-regression-signal` (§25).
      if (spec.kind === 'safety' || spec.kind === 'quality') result.status = 'regression';
      result.per_class[key] = {
        pairs: deltas.length, worse: worse.length,
        median_delta: medianDelta, mean_delta: deltas.reduce((a, b) => a + b, 0) / deltas.length,
        p90_delta: percentile(deltas, 90),
      };
    }
    // Có task an toàn nhưng KHÔNG đo được metric an toàn nào ⇒ bằng chứng an toàn
    // chưa đủ để kết luận; không được lặng lẽ coi là đạt.
    if (spec.axis === 'safety' && safetyTaskSeen && !safetyMeasured
      && !result.reasons.includes('missing-safety-measurements')) {
      result.reasons.push('missing-safety-measurements');
    }
  }
  result.safety_coverage = {
    safety_tasks: usable.filter((group) => measuresAxis(group.arms[arm], 'safety')).length,
    measured: result.safety_pairs > 0,
  };
  if (result.status !== 'regression' && result.reasons.length === 0) result.status = 'eligible-for-review';
  return result;
}

// Ghép cặp theo identity ĐẦY ĐỦ. `profile_config_hash` KHÔNG nằm ở đây vì mỗi arm
// có config riêng — nó là phần định danh treatment của arm, kiểm ở dưới.
const keyOf = (row) => JSON.stringify([row.task_id, row.seed, row.repo_state, row.model,
  row.benchmark_config_hash, row.dsh_version, row.plugin_version]);

/**
 * Tổng hợp `arms`/`by_effort`/`layer_coverage`/`task_classes` trên MỘT tập row.
 * Tách ra thành hàm riêng để báo cáo chạy được HAI lần trên hai tập khác nhau:
 * tập đã VALIDATE (kết luận performance) và tập RAW (chỉ để đọc chẩn đoán).
 */
function summarizeRows(rows) {
  const arms = {};
  for (const arm of ARMS) arms[arm] = armSummary(rows.filter((row) => row.arm === arm));
  const byEffort = {};
  for (const row of rows) {
    const effort = row.effort ?? 'unknown';
    const bucket = byEffort[effort] ?? (byEffort[effort] = { rows: 0, successes: 0, generations: null,
      walltime_ms: null, input_tokens: null });
    bucket.rows += 1;
    if (row.success === true) bucket.successes += 1;
  }
  for (const [effort, bucket] of Object.entries(byEffort)) {
    const subset = rows.filter((row) => (row.effort ?? 'unknown') === effort);
    bucket.generations = mean(subset, 'generations');
    bucket.walltime_ms = mean(subset, 'walltime_ms');
    bucket.input_tokens = mean(subset, 'input_tokens');
  }
  return {
    arms,
    by_effort: byEffort,
    layer_coverage: layerCoverage(rows),
    task_classes: [...new Set(rows.map((row) => row.task_class))].sort(),
  };
}

/**
 * Phân tích JSONL thành báo cáo matrix v2.
 * Row sai schema / thiếu identity bị đưa vào `rejected` (không hiểu nhầm).
 *
 * `manifestWarning` (tuỳ chọn): cảnh báo từ `manifestWarning()`. Chuỗi khác rỗng
 * nghĩa là manifest của run không đầy đủ/không đáng tin ⇒ mọi treatment arm bị
 * ép `hold` với lý do machine-readable. Bỏ tham số này ⇒ hành vi y hệt bản cũ.
 *
 * `manifest` (§5): nội dung manifest THẬT. Khi có, analyzer tự đối chiếu manifest
 * với row bằng `verifyManifestAgainstRows` và truyền kết quả vào `promotion` qua
 * `runIntegrity`. Đây là đường API công khai; CLI truyền cùng giá trị ⇒ không có
 * khe "CLI chặt / library hở" (§4).
 *
 * `runIntegrity` (§4): ghi đè tường minh cho fixture synthetic
 * (`{verified:true, source:'synthetic-fixture'}`).
 */
export function matrix(text, { manifestWarning: manifestWarningText = null, manifest = null,
  runIntegrity: explicitIntegrity = null } = {}) {
  const rows = []; const rejected = []; const incomplete = [];
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  // §28: BOM ở đầu file làm hỏng JSON.parse dòng đầu — dọn trước khi parse.
  for (let index = 0; index < lines.length; index += 1) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/, '') : lines[index];
    // §28: dòng phình bất thường bị TỪ CHỐI trước khi parse — một row thật lớn
    // nhất chỉ vài KB; vượt `MAX_ROW_BYTES` là dấu hiệu artifact bị nhúng hoặc file
    // hỏng, không phải row hợp lệ cần đọc.
    if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) {
      rejected.push({ reason: 'oversized-row', line: index + 1 });
      continue;
    }
    let row;
    try { row = JSON.parse(line); } catch { rejected.push({ reason: 'invalid-json', line: index + 1 }); continue; }
    if (!SUPPORTED_ROW_SCHEMAS.includes(row?.schema)) {
      rejected.push({ reason: `unsupported-schema:${row?.schema ?? 'missing'}` });
      continue;
    }
    const check = validateRow(row);
    if (!check.ok) {
      // Row thiếu identity hoặc thiếu `run_id` (source:'real') chỉ là CHƯA ĐỦ dữ
      // liệu — không phải dữ liệu hỏng cần cách ly như `rejected`.
      (check.reasons.includes('incomplete-pair-identity') || check.reasons.includes('missing-run-id')
        ? incomplete : rejected)
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
  // Một nhóm đủ arm vẫn có thể TRỘN metadata: ví dụ vanilla `split=held-out` còn
  // experimental `split=validation`. Lấy provenance từ row đầu tiên sẽ gắn nhãn
  // held-out cho cả nhóm. Kiểm nhất quán trên toàn nhóm và loại nhóm hỗn tạp.
  const consistent = [];
  for (const group of groups) {
    const memberRows = ARMS.map((arm) => group.arms[arm]).filter(Boolean);
    const check = groupConsistency(memberRows);
    if (!check.consistent) {
      rejected.push({ reason: check.reasons[0], task_id: group.task_id, seed: group.seed,
        arms: memberRows.map((row) => row.arm), reasons: check.reasons });
      continue;
    }
    consistent.push(group);
  }
  const complete = consistent.filter((group) => ARMS.every((arm) => group.arms[arm]));
  // `rawRows` = mọi row parse hợp lệ (kể cả row thuộc group bị loại vì metadata
  // không nhất quán) — chỉ dùng cho CHẨN ĐOÁN.
  const rawRows = unique;
  // `validatedRows` = row thuộc group đã qua `groupConsistency`. Số liệu dùng để
  // KẾT LUẬN performance phải lấy từ đây: một group bị loại vì trộn metadata
  // (ví dụ lệch `split`) không được kéo mean `arms.*` dù chỉ là một mẫu.
  const validatedRows = consistent.flatMap((group) => Object.values(group.arms));
  const validated = summarizeRows(validatedRows);
  const raw = summarizeRows(rawRows);
  // §5/§29: đối chiếu manifest với row THẬT. Bất kỳ bất nhất nào (run_id, split,
  // số row, arm/seed/task bị sửa) ⇒ run integrity KHÔNG xác minh được. Một dòng
  // JSONL hỏng/bị loại trong dataset `real` cũng phá tính đầy đủ: manifest khai
  // 40 row mà chỉ 39 row dùng được ⇒ không được promote (§29).
  const realRows = rawRows.filter((row) => row.source === 'real');
  const manifestProvided = manifest !== null && manifest !== undefined;
  const manifestProblems = manifestProvided
    ? verifyManifestAgainstRows(rawRows, manifest).problems : [];
  // §29: dataset `real` có dòng hỏng/bị loại là BẤT NHẤT NỘI TẠI — không override nào
  // được miễn, kể cả khai `synthetic-fixture`.
  const completenessProblems = realRows.length > 0 && (rejected.length > 0 || incomplete.length > 0)
    ? ['dataset-has-rejected-or-incomplete-rows'] : [];
  const missingManifest = !manifestProvided && realRows.length > 0 ? ['no-run-manifest'] : [];
  let runIntegrity;
  if (manifestProvided) {
    // Manifest CÓ MẶT ⇒ kết quả đối chiếu là quyết định. Một override KHÔNG được
    // ghi đè bất nhất đã phát hiện: nếu không, dataset có manifest bị sửa vẫn qua
    // được chỉ vì caller truyền `{verified:true}` (§4 — CLI chặt / library hở).
    const problems = [...new Set([...manifestProblems, ...completenessProblems])];
    runIntegrity = problems.length === 0
      ? { verified: true, source: 'manifest', problems: [] }
      : { verified: false, source: 'manifest', problems };
  } else if (completenessProblems.length > 0) {
    runIntegrity = { verified: false, source: 'none', problems: completenessProblems };
  } else if (explicitIntegrity && explicitIntegrity.verified === true
    && explicitIntegrity.source === 'synthetic-fixture') {
    // Không manifest, dataset không có bất nhất: CHỈ fixture khai TƯỜNG MINH
    // `synthetic-fixture` được miễn. Mọi nguồn khác là không xác minh được.
    runIntegrity = { verified: true, source: 'synthetic-fixture', problems: [] };
  } else if (explicitIntegrity) {
    runIntegrity = { verified: false, source: 'none', problems: ['unrecognized-run-integrity-override'] };
  } else if (missingManifest.length > 0) {
    runIntegrity = { verified: false, source: 'none', problems: missingManifest };
  } else {
    runIntegrity = { verified: true, source: 'synthetic-fixture', problems: [] };
  }
  const promotionReport = {};
  for (const arm of ARMS) {
    if (arm === 'vanilla') continue;
    // Chỉ nhóm NHẤT QUÁN mới được đưa vào phán quyết. Một nhóm trộn
    // held-out/validation mà lọt vào đây sẽ tự gắn nhãn held-out cho cả nhóm.
    promotionReport[arm] = promotion(consistent, arm, { runIntegrity });
  }
  // Manifest không đáng tin ⇒ KHÔNG arm treatment nào được coi là ứng viên review.
  // Đây là gate ở TẦNG BÁO CÁO (không đụng vào số đo): diagnostics vẫn in đầy đủ,
  // nhưng `status` bị ép `hold` để một run dở dang không thể trôi qua review.
  if (typeof manifestWarningText === 'string' && manifestWarningText.trim() !== '') {
    for (const arm of ARMS) {
      const entry = promotionReport[arm];
      if (!entry) continue;
      entry.status = 'hold';
      entry.automatic_promotion = false;
      if (!entry.reasons.includes('incomplete-or-untrusted-run-manifest')) {
        entry.reasons.push('incomplete-or-untrusted-run-manifest');
      }
    }
  }
  const inconsistentGroups = groups.length - consistent.length;
  return {
    schema: MATRIX_SCHEMA,
    row_schema: ROW_SCHEMA,
    // `arms`/`by_effort`/`layer_coverage`/`task_classes` = chỉ nhóm đã validate.
    arms: validated.arms,
    by_effort: validated.by_effort,
    layer_coverage: validated.layer_coverage,
    task_classes: validated.task_classes,
    // Bản RAW song song, giữ lại để đọc mức độ lệch giữa hai tập.
    raw_arms: raw.arms,
    raw_by_effort: raw.by_effort,
    raw_layer_coverage: raw.layer_coverage,
    raw_task_classes: raw.task_classes,
    // §29: đếm tường minh các tầng — "39 valid + 1 hỏng" KHÔNG được coi là 40.
    physical_rows: lines.length,
    parse_valid_rows: rows.length,
    promotion_valid_rows: validatedRows.length,
    validated_rows: validatedRows.length,
    raw_rows: rawRows.length,
    complete_groups: complete.length,
    held_out_real_groups: complete.filter((group) => group.provenance === 'held-out-real').length,
    inconsistent_groups: inconsistentGroups,
    supported_task_classes: [...TASK_CLASSES],
    run_integrity: runIntegrity,
    verdict: 'unknown',
    note: 'Measurement analyzer only. Validation rows are not promotion evidence; '
      + 'performance benefit stays unknown until enough held-out paired groups exist.',
    comparisons: complete.map((group) => ({ key: group.key, task_id: group.task_id,
      task_class: group.task_class, provenance: group.provenance,
      arms: Object.fromEntries(ARMS.map((arm) => [arm, armSummary([group.arms[arm]])])) })),
    incomplete,
    rejected,
    promotion: promotionReport,
    ...(typeof manifestWarningText === 'string' && manifestWarningText.trim() !== ''
      ? { manifest_warning: manifestWarningText } : {}),
  };
}

import { makeRow, capsFor, encode, healthyHeldOut, manifestFor, SAFETY_AXES } from './trajectory-fixture.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Kiểm manifest đi kèm trước khi phân tích. Row được ghi dần, nên một file JSONL
 * thiếu row (tiến trình bị giết giữa chừng) trông không khác gì file đầy đủ.
 * THUẦN: nhận nội dung manifest (hoặc null), trả cảnh báo machine-readable.
 */
export function manifestWarning(manifest, actualRows = null) {
  const hasActual = Number.isFinite(actualRows);
  // Manifest còn lại khai một số row KHÁC số row thật trong file ⇒ manifest đã cũ
  // hoặc bị sửa. Đây là cảnh báo mạnh nhất: không được tin bất kỳ con số nào.
  if (manifest !== null && manifest !== undefined && hasActual
    && Number.isFinite(manifest.written_rows) && manifest.written_rows !== actualRows) {
    return `stale-run-manifest: manifest records ${manifest.written_rows} rows but the file has ${actualRows}`;
  }
  if (manifest === null || manifest === undefined) {
    return hasActual
      ? `no-run-manifest: ${actualRows} rows present but completeness was not recorded`
      : 'no-run-manifest: completeness of this JSONL was not recorded';
  }
  if (manifest.status !== 'complete') {
    const wrote = Number.isFinite(manifest.written_rows) ? manifest.written_rows : '?';
    const expected = Number.isFinite(manifest.expected_rows) ? manifest.expected_rows : '?';
    return `incomplete-run-manifest: run status is ${JSON.stringify(manifest.status)} (wrote ${wrote} of ${expected} rows)`;
  }
  // Khai `complete` nhưng THIẾU số row (`written_rows`/`expected_rows`) là manifest
  // KHÔNG đủ để chứng minh tính đầy đủ: nó không thể phân biệt file đầy với file
  // bị cắt. Collector thật LUÔN ghi cả hai, nên thiếu chúng nghĩa là manifest bị
  // sửa/dựng tay ⇒ fail-closed (coi như không đáng tin), KHÔNG được coi là hợp lệ.
  if (!Number.isFinite(manifest.written_rows) || !Number.isFinite(manifest.expected_rows)) {
    const wrote = Number.isFinite(manifest.written_rows) ? manifest.written_rows : '?';
    const expected = Number.isFinite(manifest.expected_rows) ? manifest.expected_rows : '?';
    return `untrusted-run-manifest: status is complete but row counts are not recorded (wrote ${wrote} of ${expected} rows)`;
  }
  if (manifest.written_rows !== manifest.expected_rows) {
    return `incomplete-run-manifest: wrote ${manifest.written_rows} of ${manifest.expected_rows} rows`;
  }
  return null;
}

/**
 * Tự kiểm THUẦN trên dữ liệu SYNTHETIC (không đo gì thật, không gọi mạng).
 * Mục đích: chứng minh parser/promotion từ chối đúng các dạng row hỏng mà
 * không cần dữ liệu thật.
 */
/**
 * Tự kiểm THUẦN trên dữ liệu SYNTHETIC (không đo gì thật, không gọi mạng).
 * Mục đích: chứng minh parser/promotion từ chối đúng các dạng row hỏng mà
 * không cần dữ liệu thật.
 *
 * Từ v4, fixture dùng chung (`tools/trajectory-fixture.mjs`) để mọi suite không
 * lệch nhau. Mọi row ở đây là BỊA; `source:'real'` chỉ để chạy luật promotion.
 */
export function selfTest() {
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test: ${message}`); };
  const base = (arm, overrides = {}) => makeRow(arm, overrides);
  const safetyAxes = SAFETY_AXES;
  // Manifest "sạch" khớp một tập row, để run integrity được xác minh.
  const run = (rows, opts = {}) => matrix(encode(rows), { manifest: manifestFor(rows), ...opts });
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
  // 3b. Hash cấu hình bị SỬA TAY ⇒ TỪ CHỐI, không tin field khai.
  const fakeHash = base('safe', { profile_config_hash: 'deadbeef' });
  assert(matrix(JSON.stringify(fakeHash)).rejected.some((entry) =>
    entry.reasons.includes('profile-config-hash-mismatch')), 'tampered profile hash must be rejected');
  const fakeBench = base('safe'); fakeBench.benchmark_config_hash = 'deadbeef';
  assert(matrix(JSON.stringify(fakeBench)).rejected.some((entry) =>
    entry.reasons.includes('benchmark-config-hash-mismatch')), 'tampered benchmark hash must be rejected');
  // 3c. Metric an toàn trên task non-safety ⇒ TỪ CHỐI (tự mâu thuẫn).
  assert(matrix(JSON.stringify(base('safe', { false_allow: 0 }))).rejected.some((entry) =>
    entry.reasons.includes('safety-metric-on-non-safety-task')),
  'false_allow on non-safety task must be rejected');
  // 3d. Kiểu metric sai (chuỗi "1", số âm) ⇒ TỪ CHỐI, không coerce. `NaN` không
  // biểu diễn được trong JSON (thành `null`) nên được kiểm trực tiếp ở adversarial.
  for (const bad of ['1', -5]) {
    assert(matrix(JSON.stringify(base('safe', { walltime_ms: bad }))).rejected.some((entry) =>
      entry.reasons.includes('invalid-metric:walltime_ms')), `walltime ${bad} must be rejected`);
  }
  assert(matrix(JSON.stringify(base('safe', { success: 'yes' }))).rejected.some((entry) =>
    entry.reasons.includes('invalid-metric:success')), 'non-boolean success must be rejected');
  // 4. Capability KHÔNG hợp lệ (jg unavailable) ⇒ hold với lý do capability, KHÔNG regression.
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    for (const arm of ARMS) {
      const capability = arm === 'experimental'
        ? { jevgrep: { configured: true, available: false, invoked: false, exercised: false } }
        : undefined;
      rows.push(base(arm, { seed: i, task_class: i % 2 ? 'routine' : 'bug-diagnosis',
        // Held-out THẬT (synthetic chỉ để tự kiểm parser, không phải bằng chứng).
        source: 'real', split: 'held-out',
        ...(capability ? { capabilities: { ...capsFor(arm), ...capability } } : {}),
        expected_capabilities_to_exercise: arm === 'experimental' ? ['jevgrep'] : [],
        // experimental chậm hơn (nhưng phải bị chặn bởi capability, không phải regression)
        walltime_ms: arm === 'experimental' ? 500 : 100 }));
    }
  }
  const report = run(rows);
  assert(report.schema === MATRIX_SCHEMA, 'matrix schema must be v2');
  assert(report.complete_groups === 10, `expected 10 complete groups, got ${report.complete_groups}`);
  assert(report.held_out_real_groups === 10, 'held-out real groups must be counted');
  const promotionReport = report.promotion.experimental;
  assert(promotionReport.automatic_promotion === false, 'promotion must never be automatic');
  assert(promotionReport.status === 'hold', `invalid capability must hold, got ${promotionReport.status}`);
  assert(promotionReport.reasons.includes('invalid-or-incomplete-capability-environment'),
    'invalid capability reason must be present');
  assert(!promotionReport.reasons.some((reason) => /-regression$/.test(reason)),
    'invalid capability must NOT be reported as a regression');
  // 4b. Nhóm TRỘN split (vanilla held-out, treatment validation) ⇒ loại nhóm,
  // không được gắn nhãn held-out cho cả nhóm.
  const mixed = [];
  for (let i = 0; i < 10; i += 1) {
    for (const arm of ARMS) {
      mixed.push(base(arm, { seed: i, task_class: i % 2 ? 'routine' : 'bug-diagnosis',
        source: 'real', split: arm === 'vanilla' ? 'held-out' : 'validation' }));
    }
  }
  const mixedReport = run(mixed);
  assert(mixedReport.inconsistent_groups === 10, `mixed provenance groups must be dropped, got ${mixedReport.inconsistent_groups}`);
  assert(mixedReport.complete_groups === 0, 'mixed-provenance groups must not be complete');
  assert(mixedReport.promotion.experimental.status === 'hold', 'mixed provenance must not promote');
  // 4c. Run integrity CHƯA xác minh ⇒ KHÔNG arm nào eligible (§4).
  const unverified = matrix(encode(healthyHeldOut()), {});
  for (const arm of ARMS) {
    const entry = unverified.promotion[arm];
    if (!entry) continue;
    assert(entry.reasons.includes('unverified-run-integrity'),
      `${arm}: real rows without verified run integrity must hold`);
    assert(entry.status === 'hold', `${arm}: unverified integrity must hold`);
  }
  // 5. Metric thiếu vẫn `null`, KHÔNG tự thành 0.
  const missing = matrix(JSON.stringify(base('safe', { cost_usd: null })));
  assert(missing.arms.safe.metrics.cost_usd === null, 'missing cost must stay null');
  // 5b. Task non-safety giữ safety metric `null`; `cost_usd` không bắt buộc nên
  // thiếu cost KHÔNG chặn promotion (không có nguồn dữ liệu cost).
  const noCost = run(healthyHeldOut({ overrides: { cost_usd: null } }));
  assert(!noCost.promotion.experimental.reasons.includes('missing-required-measurements'),
    'missing optional cost must not block promotion');
  assert(noCost.promotion.experimental.status === 'eligible-for-review',
    `clean held-out evidence must be eligible-for-review, got ${noCost.promotion.experimental.status}`);
  // 5c. Task an toàn mà THIẾU số đo an toàn ⇒ chặn promotion.
  const safetyRows = healthyHeldOut({ overrides: { measurement_axes: safetyAxes,
    false_allow: null, false_deny: null } });
  const safetyReport = run(safetyRows);
  assert(safetyReport.promotion.experimental.reasons.includes('missing-safety-measurements'),
    'safety task without safety measurements must hold');
  assert(safetyReport.promotion.experimental.status === 'hold',
    `missing safety measurements must hold, got ${safetyReport.promotion.experimental.status}`);
  // 5d. Task an toàn ĐỦ số đo ⇒ safety gate thật sự chạy và bắt regression.
  const safetyRegress = [];
  for (let i = 0; i < 10; i += 1) {
    for (const arm of ARMS) {
      safetyRegress.push(base(arm, { seed: i, task_class: i % 2 ? 'routine' : 'bug-diagnosis',
        source: 'real', split: 'held-out', measurement_axes: safetyAxes,
        false_allow: arm === 'experimental' ? 1 : 0, false_deny: 0 }));
    }
  }
  const safetyRegressReport = run(safetyRegress);
  assert(safetyRegressReport.promotion.experimental.status === 'regression',
    'safety regression on safety task must be regression');
  assert(safetyRegressReport.promotion.experimental.reasons.includes('safety-regression'));
  assert(safetyRegressReport.promotion.experimental.safety_pairs === 10,
    'safety coverage must count safety tasks');
  // 6. Cùng tên arm nhưng config KHÁC giữa các nhóm ⇒ hai treatment bị trộn,
  // KHÔNG được gộp làm một bằng chứng.
  const crossConfig = [];
  for (let i = 0; i < 10; i += 1) {
    for (const arm of ARMS) {
      const overrides = { seed: i, task_class: i % 2 ? 'routine' : 'bug-diagnosis',
        source: 'real', split: 'held-out' };
      if (arm === 'experimental' && i >= 5) {
        overrides.profile_config = { profile: 'experimental', destructiveThreshold: 0.9 };
      }
      crossConfig.push(base(arm, overrides));
    }
  }
  const crossConfigReport = run(crossConfig);
  assert(crossConfigReport.complete_groups === 10, 'groups still form; the issue is pooled treatment identity');
  assert(crossConfigReport.promotion.experimental.reasons.includes('inconsistent-arm-configuration'),
    'different config hashes must be flagged as inconsistent treatment');
  assert(crossConfigReport.promotion.experimental.treatment_config_hashes.length === 2,
    'two treatment configs must be reported');
  // 7. §14: `available` KHÔNG chứng minh `exercised`. Một task khai failure_recovery
  // nhưng không chạy (exercised=false) phải đếm `expected=1, exercised=0`;
  // chỉ khi exercised=true mới thành exercised.
  const notExercised = layerCoverage([base('safe', {
    capabilities: { ...capsFor('safe'), failure_recovery: { configured: true, available: true, invoked: false, exercised: false } },
    expected_capabilities_to_exercise: ['failure_recovery'] })]);
  assert(notExercised.failure_recovery.expected === 1 && notExercised.failure_recovery.exercised === 0,
    'available-but-not-run must show expected>0, exercised=0');
  const exercised = layerCoverage([base('safe', {
    capabilities: { ...capsFor('safe'), failure_recovery: { configured: true, available: true, invoked: true, exercised: true } },
    expected_capabilities_to_exercise: ['failure_recovery'] })]);
  assert(exercised.failure_recovery.exercised === 1, 'exercised=true must count as exercised');
  // Lớp không được cấu hình và không task nào khai ⇒ KHÔNG xuất hiện (tránh hiểu nhầm 0 = đã đo).
  assert(layerCoverage([base('vanilla')]).jevgrep === undefined,
    'untouched layers must be omitted, not reported as zero');
  const encodeRows = encode;
  // 8. Manifest KHÔNG đáng tin ⇒ mọi treatment arm `hold`, KHÔNG được `eligible-for-review`.
  const clean = run(healthyHeldOut({ overrides: { cost_usd: null } }));
  assert(clean.promotion.experimental.status === 'eligible-for-review',
    'clean held-out data with a verified manifest must stay eligible-for-review');
  assert(clean.manifest_warning === undefined, 'no warning passed ⇒ no manifest_warning field');
  const gated = matrix(encodeRows(healthyHeldOut({ overrides: { cost_usd: null } })),
    { manifestWarning: 'no-run-manifest: synthetic' });
  assert(gated.manifest_warning === 'no-run-manifest: synthetic', 'warning must be echoed in the report');
  for (const arm of ARMS) {
    const entry = gated.promotion[arm];
    if (arm === 'vanilla') { assert(entry === undefined, 'vanilla has no promotion entry'); continue; }
    assert(entry.status === 'hold', `${arm}: untrusted manifest must force hold, got ${entry.status}`);
    assert(entry.automatic_promotion === false, `${arm}: untrusted manifest must not auto-promote`);
    assert(entry.reasons.includes('incomplete-or-untrusted-run-manifest'),
      `${arm}: untrusted manifest reason must be present`);
    assert(!entry.reasons.some((reason) => /-regression$/.test(reason)),
      `${arm}: untrusted manifest must not invent a regression reason`);
  }
  // Diagnostics vẫn phải nguyên vẹn khi bị gate.
  for (const key of ['arms', 'raw_arms', 'by_effort', 'raw_by_effort', 'layer_coverage',
    'raw_layer_coverage', 'comparisons', 'incomplete', 'rejected', 'promotion', 'verdict',
    'complete_groups', 'held_out_real_groups', 'inconsistent_groups', 'run_integrity',
    'physical_rows', 'parse_valid_rows', 'promotion_valid_rows']) {
    assert(gated[key] !== undefined, `manifest gate must not drop diagnostics: ${key}`);
  }
  // 9. raw vs validated: group lệch `split` bị loại, và nó KHÔNG được kéo mean chính.
  const validGroup = ARMS.map((arm) => base(arm, { seed: 0, source: 'real', split: 'held-out' }));
  const droppedGroup = ARMS.map((arm) => base(arm, { seed: 1, source: 'real',
    split: arm === 'vanilla' ? 'held-out' : 'validation', walltime_ms: 9999 }));
  const splitReport = run([...validGroup, ...droppedGroup]);
  assert(splitReport.inconsistent_groups === 1, 'the mixed-split group must be dropped');
  assert(splitReport.raw_rows === 8 && splitReport.validated_rows === 4,
    `raw/validated counts must diverge, got ${splitReport.raw_rows}/${splitReport.validated_rows}`);
  assert(splitReport.raw_rows > splitReport.validated_rows, 'raw_rows must exceed validated_rows');
  assert(splitReport.raw_arms.safe.metrics.walltime_ms > splitReport.arms.safe.metrics.walltime_ms,
    'raw summary must include the dropped slow group; validated summary must not');
  assert(splitReport.arms.safe.metrics.walltime_ms === 100,
    'validated walltime must reflect only the consistent group');
  assert(splitReport.promotion.safe.held_out_pairs === 1,
    'promotion must only see the consistent group');
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
    const text = readFileSync(input, 'utf8');
    // Đếm row THẬT trong file để phát hiện manifest cũ/khai sai số row.
    const actualRows = text.split('\n').filter((line) => line.trim() !== '').length;
    const warning = manifestWarning(manifest, actualRows);
    // Manifest cho biết file JSONL có đầy đủ không. Cảnh báo được TRUYỀN VÀO matrix
    // để chặn promotion (`hold` + lý do), nhưng KHÔNG chặn phần diagnostics: người
    // dùng vẫn xem được đầy đủ số đã đo.
    //
    // Manifest GỐC cũng được truyền để analyzer tự đối chiếu với row (§5): một
    // manifest "đủ row" nhưng sai `run_id`/`split`/danh sách arm vẫn phải chặn.
    // Đây chính là cùng đường mà API công khai dùng — CLI không được chặt hơn library.
    const report = matrix(text, { manifestWarning: warning, manifest });
    console.log(JSON.stringify(report, null, 2));
  }
}
