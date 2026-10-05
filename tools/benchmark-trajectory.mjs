/**
 * benchmark-trajectory.mjs — so sánh A/B theo TRAJECTORY (paired), chạy hoàn
 * toàn OFFLINE: chỉ ĐỌC một file JSONL, không mạng, không gọi Jev, KHÔNG chạy
 * lệnh shell nào.
 *
 * ## Vì sao có file này
 *
 * Một layer Jev có thể classify đúng mà vẫn làm agent chậm hơn: 90% đúng nhưng
 * mỗi hint thêm 500 ms + 200 token, còn model vốn đã chọn đúng 95%. Đo
 * accuracy của classifier KHÔNG phát hiện được regression đó. Phải đo
 * trajectory: wall-time, số call, token, cost, retry, kết quả test, và nhãn an
 * toàn — trên cùng một task/seed để hai arm so được với nhau.
 *
 * ## Bất biến trung thực (đọc trước khi sửa)
 *
 *   1. CHỈ so theo cặp. Một cặp là `(task_id, seed)`. Chỉ cặp có ĐỦ cả hai arm
 *      mới vào phép so. Thiếu một bên ⇒ cặp đó KHÔNG được lấp bằng arm còn lại.
 *   2. Thiếu đo thật ⇒ `unknown`, KHÔNG bao giờ là 0. Một chỉ số không có mẫu
 *      phải đọc được là "chưa đo", không phải "bằng không".
 *   3. Mẫu số 0 (ví dụ `tests_total = 0`) ⇒ `null`/`unknown`, không chia cho 0.
 *   4. KHÔNG suy ra lợi ích online từ fixture tổng hợp. Phán quyết
 *      `net_positive` chỉ được đưa ra khi mọi cặp dùng để so đều là bản ghi
 *      THẬT chạy trên split `held-out`. Nguồn `synthetic`/thiếu nguồn ⇒
 *      `verdict: unknown` kèm lý do — synthetic chỉ dùng để thử CÔNG CỤ, không
 *      phải để tuyên bố lợi ích.
 *   5. Chạy held-out thật là việc RIÊNG, phải thu thập riêng. Tool này không
 *      sinh dữ liệu, không chạy harness, không mở mạng.
 *   6. Nhãn an toàn là bất đối xứng: một `destructive_false_allow` ở arm điều
 *      trị là REGRESSION, không phải "trung bình vẫn tốt".
 *
 * ## Định dạng JSONL đầu vào
 *
 * Mỗi dòng một lần chạy:
 *
 * ```json
 * {
 *   "task_id": "t001",          // BẮT BUỘC — định danh task
 *   "seed": 1,                  // BẮT BUỘC — cùng task, khác seed KHÔNG ghép cặp
 *   "arm": "core",              // BẮT BUỘC — vanilla | core | experimental
 *   "split": "held-out",        // held-out | train | validation | ...
 *   "source": "real",           // real = đo thật; synthetic = fixture
 *   "walltime_ms": 126541,
 *   "llm_calls": 20, "jev_calls": 0, "tool_calls": 201,
 *   "input_tokens": 671174, "output_tokens": 234632, "cache_read_tokens": 2781312,
 *   "cost_usd": 1.23,
 *   "success": true, "tests_passed": 8, "tests_total": 15,
 *   "retries": 2, "consent_prompts": 0,
 *   "safety_label": "clean"     // clean | destructive_false_allow | ...
 * }
 * ```
 *
 * Chỉ số nào thiếu thì cứ thiếu: tool sẽ báo `unknown` cho chính chỉ số đó,
 * không bịa. `total_tokens` suy từ `input_tokens + output_tokens` khi thiếu;
 * `test_pass_rate` suy từ `tests_passed / tests_total`.
 *
 * ## Dùng
 *
 * ```
 * node tools/benchmark-trajectory.mjs trajectories.jsonl
 * node tools/benchmark-trajectory.mjs trajectories.jsonl --baseline vanilla --treatments core,experimental
 * node tools/benchmark-trajectory.mjs trajectories.jsonl --tolerance 0.05 --json
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROW_SCHEMA } from './trajectory-schema.mjs';

/** Ba arm của Phase 4: DSH thuần, DSH + core Jev, DSH + full Jev experimental. */
export const ARMS = Object.freeze(['vanilla', 'core', 'experimental']);
export const DEFAULT_BASELINE = 'vanilla';
export const DEFAULT_TREATMENTS = Object.freeze(['core', 'experimental']);

/** Nguồn bị coi là KHÔNG phải đo thật — không được suy ra lợi ích online. */
const SYNTHETIC_SOURCE = /(synthetic|illustrative|example|fixture|fake|made-?up|dummy|mock|toy|placeholder)/i;

/** Nhãn an toàn coi là thụt lùi khi arm điều trị cho phép lệnh nguy hiểm. */
const DANGEROUS_LABEL = /false[_-]?allow|unsafe[_-]?allow|catastrophic[_-]?(miss|false)|missed[_-]?catastrophic/i;

const round4 = (value) => (Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null);

/**
 * Bảng chỉ số. `direction: 'lower'` = nhỏ hơn tốt hơn; `'higher'` = lớn hơn tốt.
 * `aliases` để đọc được cả log cũ (`ms`, `jg`, `toolCalls`, …).
 */
export const METRICS = Object.freeze([
  { key: 'success', aliases: ['ok'], direction: 'higher' },
  { key: 'test_pass_rate', aliases: ['pass_rate'], direction: 'higher' },
  { key: 'walltime_ms', aliases: ['ms', 'walltime'], direction: 'lower' },
  { key: 'llm_calls', aliases: ['llmCalls'], direction: 'lower' },
  { key: 'jev_calls', aliases: ['jevCalls', 'jg'], direction: 'lower' },
  { key: 'tool_calls', aliases: ['toolCalls'], direction: 'lower' },
  { key: 'input_tokens', aliases: ['inputTokens'], direction: 'lower' },
  { key: 'output_tokens', aliases: ['outputTokens'], direction: 'lower' },
  { key: 'cache_read_tokens', aliases: ['cacheReadTokens'], direction: 'lower' },
  { key: 'total_tokens', aliases: ['totalTokens'], direction: 'lower' },
  { key: 'cost_usd', aliases: ['costUsd', 'cost'], direction: 'lower' },
  { key: 'retries', aliases: ['retry_count', 'retryCount'], direction: 'lower' },
  { key: 'consent_prompts', aliases: ['consentPrompts'], direction: 'lower' },
]);

/** Chỉ số dùng để phán quyết net-positive/regression. */
export const PRIMARY_METRICS = Object.freeze([
  'success', 'test_pass_rate', 'walltime_ms', 'llm_calls', 'jev_calls',
  'tool_calls', 'total_tokens', 'cost_usd', 'retries', 'consent_prompts',
]);

const METRIC_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Đọc trường thô theo tên chuẩn rồi tới alias. Trả `undefined` nếu không có. */
function rawField(record, key, aliases = []) {
  for (const name of [key, ...aliases]) {
    if (Object.hasOwn(record, name) && record[name] !== null && record[name] !== undefined) {
      return record[name];
    }
  }
  return undefined;
}

/** Ép về số hữu hạn; mọi thứ khác (kể cả `''`, `NaN`, `Infinity`) ⇒ `null`. */
function toNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Giá trị một chỉ số của một lần chạy. THUẦN. `null` = không đo được (⇒ unknown),
 * KHÔNG phải 0. Đây là điểm chống bịa số quan trọng nhất của tool.
 */
export function metricValue(record, key) {
  if (!isObj(record)) return null;
  // Chấp nhận cả bản ghi thô lẫn "phong bì" đã parse (dữ liệu nằm trong `.raw`).
  const source = isObj(record.raw) ? record.raw : record;
  const spec = METRIC_BY_KEY.get(key);
  if (!spec) return null;

  if (key === 'total_tokens') {
    const direct = toNum(rawField(source, 'total_tokens', ['totalTokens']));
    if (direct !== null) return direct >= 0 ? direct : null;
    const input = toNum(rawField(source, 'input_tokens', ['inputTokens']));
    const output = toNum(rawField(source, 'output_tokens', ['outputTokens']));
    return input !== null && output !== null && input >= 0 && output >= 0 ? input + output : null;
  }
  if (key === 'test_pass_rate') {
    const passed = toNum(rawField(source, 'tests_passed', ['pass', 'pass_', 'testsPassed']));
    const total = toNum(rawField(source, 'tests_total', ['total', 'testsTotal']));
    // Ưu tiên thành phần gốc (passed/total) vì đó là sự thật thô. Mẫu số 0/âm ⇒ null.
    if (passed !== null || total !== null) {
      return passed !== null && total !== null && total > 0 && passed >= 0 && passed <= total
        ? passed / total : null;
    }
    // Chỉ nhận tỉ lệ sẵn nếu không có thành phần gốc để kiểm tra.
    const direct = toNum(rawField(source, 'test_pass_rate', ['pass_rate', 'testPassRate']));
    return direct !== null && direct >= 0 && direct <= 1 ? direct : null;
  }
  if (key === 'success') {
    const value = rawField(source, 'success', ['ok']);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return null; // KHÔNG suy từ `rc` — mã thoát harness không phải kết quả task.
  }
  const value = toNum(rawField(source, key, spec.aliases));
  return value !== null && value >= 0 ? value : null;
}

/** Nguồn gốc bản ghi: `held-out-real` | `real` | `synthetic` | `unknown`. */
export function provenance(record) {
  if (!isObj(record)) return 'unknown';
  const source = typeof record.source === 'string' ? record.source.trim() : '';
  if (!source) return 'unknown';
  if (SYNTHETIC_SOURCE.test(source)) return 'synthetic';
  if (/^real$/i.test(source)) return record.split === 'held-out' ? 'held-out-real' : 'real';
  return 'unknown';
}

/**
 * Khoá ghép cặp: task_id + seed.
 *
 * Mã hoá bằng JSON mảng thay vì nối chuỗi với dấu phân cách: nối `a\0` + `2` và
 * `a` + `\0 2` sẽ cho cùng một khoá (giả cặp), còn JSON thì escape nên không lẫn.
 */
export function pairKey(record) {
  return JSON.stringify([String(record?.task_id), String(record?.seed)]);
}

/**
 * Parse JSONL trajectory. THUẦN — nhận chuỗi, trả cấu trúc; không I/O.
 *
 * Phân loại từng dòng thay vì ném: một dòng hỏng không làm mất cả tập đo. Bản
 * ghi trùng khoá `(task_id, seed, arm)` bị LOẠI HẾT khỏi `records` (không biết
 * bản nào là chuẩn) và báo riêng trong `duplicates`.
 */
export function parseTrajectories(text) {
  const all = [];
  const malformed = [];
  const incomplete = [];
  const unknownArm = [];
  const unsupportedSchema = [];
  let lineNo = 0;

  for (const raw of String(text ?? '').split('\n')) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      malformed.push({ line: lineNo, error: error?.message ?? 'JSON hỏng' });
      continue;
    }
    if (!isObj(row)) {
      malformed.push({ line: lineNo, error: 'không phải đối tượng' });
      continue;
    }
    // Row khai schema trajectory PHIÊN BẢN MỚI (do collector v2 ghi) không được
    // hiểu như row cũ: arm `safe`/`balanced` sẽ bị coi là "arm lạ" và cặp bị
    // ghép sai. Từ chối TƯỜNG MINH thay vì diễn giải sai. Row không khai schema
    // vẫn được xử lý như trước (tương thích ngược với dữ liệu cũ).
    if (typeof row.schema === 'string' && /^dsh-jev-gate-trajectory-/.test(row.schema)) {
      unsupportedSchema.push({ line: lineNo, schema: row.schema });
      continue;
    }
    const missing = [];
    if (typeof row.task_id !== 'string' || row.task_id === '') missing.push('task_id');
    if (row.seed === undefined || row.seed === null || row.seed === '') missing.push('seed');
    if (typeof row.arm !== 'string' || row.arm === '') missing.push('arm');
    if (missing.length > 0) {
      incomplete.push({ line: lineNo, missing });
      continue;
    }
    if (!ARMS.includes(row.arm)) {
      unknownArm.push({ line: lineNo, arm: row.arm });
      continue;
    }
    all.push({
      line: lineNo,
      task_id: row.task_id,
      seed: row.seed,
      arm: row.arm,
      split: typeof row.split === 'string' && row.split ? row.split : 'unspecified',
      source: typeof row.source === 'string' ? row.source : '',
      safety_label: typeof row.safety_label === 'string' ? row.safety_label : '',
      raw: row,
    });
  }

  // Trùng khoá (task_id, seed, arm): loại TẤT CẢ bản ghi trong nhóm trùng.
  // Khoá dựng bằng JSON mảng nên không thể giả cặp qua dấu phân cách trong id.
  const groups = new Map();
  for (const record of all) {
    const key = JSON.stringify([String(record.task_id), String(record.seed), record.arm]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const duplicates = [];
  const dropped = new Set();
  for (const group of groups.values()) {
    if (group.length > 1) {
      const { task_id, seed, arm } = group[0];
      duplicates.push({ task_id, seed, arm, lines: group.map((r) => r.line) });
      for (const record of group) dropped.add(record);
    }
  }
  const records = all.filter((record) => !dropped.has(record));

  return { records, malformed, incomplete, unknownArm, unsupportedSchema, duplicates };
}

/**
 * Gom bản ghi thành cặp theo `(task_id, seed)`. THUẦN.
 * Trả Map: key → `{ task_id, seed, byArm }`.
 */
export function groupPairs(records) {
  const pairs = new Map();
  for (const record of records) {
    const key = pairKey(record);
    if (!pairs.has(key)) {
      pairs.set(key, { task_id: record.task_id, seed: record.seed, byArm: {} });
    }
    pairs.get(key).byArm[record.arm] = record;
  }
  return pairs;
}

/** Thống kê một chỉ số trên các cặp: mean, delta, hướng. `n=0` ⇒ mọi thứ null. */
export function metricStats(samples, key, tolerance = 0) {
  const spec = METRIC_BY_KEY.get(key);
  const pairs = samples
    .map(({ baseline, treatment }) => ({
      baseline: metricValue(baseline, key),
      treatment: metricValue(treatment, key),
    }))
    .filter((pair) => pair.baseline !== null && pair.treatment !== null);

  const n = pairs.length;
  if (n === 0) {
    return {
      key, direction: spec.direction, n: 0,
      baseline_mean: null, treatment_mean: null, delta: null, delta_pct: null,
      effect: 'unknown',
    };
  }
  const mean = (pick) => pairs.reduce((acc, pair) => acc + pick(pair), 0) / n;
  const baselineMean = mean((pair) => pair.baseline);
  const treatmentMean = mean((pair) => pair.treatment);
  const delta = treatmentMean - baselineMean;
  const better = spec.direction === 'lower' ? delta < -tolerance : delta > tolerance;
  const worse = spec.direction === 'lower' ? delta > tolerance : delta < -tolerance;
  return {
    key,
    direction: spec.direction,
    n,
    baseline_mean: round4(baselineMean),
    treatment_mean: round4(treatmentMean),
    delta: round4(delta),
    delta_pct: baselineMean === 0 ? null : round4(delta / Math.abs(baselineMean)),
    effect: better ? 'better' : worse ? 'worse' : 'flat',
  };
}

/** Đếm nhãn an toàn trên các cặp và tìm thụt lùi ở arm điều trị. */
export function safetyStats(samples) {
  const tally = (pick) => {
    const out = {};
    for (const { baseline, treatment } of samples) {
      const label = (pick === 'baseline' ? baseline : treatment).safety_label || '(không nhãn)';
      out[label] = (out[label] ?? 0) + 1;
    }
    return out;
  };
  const baseline = tally('baseline');
  const treatment = tally('treatment');
  // Compare within each task/seed: equal aggregate counts can hide a new false-allow
  // on a different task from the baseline's false-allow.
  const regressions = [];
  for (const { baseline: before, treatment: after } of samples) {
    if (DANGEROUS_LABEL.test(after.safety_label ?? '')
      && !DANGEROUS_LABEL.test(before.safety_label ?? '')) {
      regressions.push({ label: after.safety_label, task_id: after.task_id, seed: after.seed });
    }
  }
  return { baseline, treatment, regressions };
}

/**
 * So một arm điều trị với baseline trên các cặp có đủ hai bên. THUẦN.
 *
 * `evidence`: mức bằng chứng của các cặp dùng để so —
 *   `held-out-real` | `real` | `synthetic` | `unknown` | `none`.
 * Chỉ `held-out-real` mới đủ điều kiện phán quyết lợi ích.
 */
export function compareArm(pairs, baselineArm, treatmentArm, { tolerance = 0 } = {}) {
  const samples = [];
  let incompletePairs = 0;
  for (const entry of pairs.values()) {
    const baseline = entry.byArm[baselineArm];
    const treatment = entry.byArm[treatmentArm];
    if (baseline && treatment) samples.push({ key: pairKey(baseline), baseline, treatment });
    else if (baseline || treatment) incompletePairs += 1;
  }

  const provs = new Set();
  for (const { baseline, treatment } of samples) {
    provs.add(provenance(baseline));
    provs.add(provenance(treatment));
  }
  let evidence;
  if (samples.length === 0) evidence = 'none';
  else if (provs.has('synthetic')) evidence = 'synthetic';
  else if (provs.has('unknown')) evidence = 'unknown';
  else if (provs.has('real')) evidence = 'real';
  else evidence = 'held-out-real';

  const metrics = {};
  for (const metric of METRICS) metrics[metric.key] = metricStats(samples, metric.key, tolerance);

  const safety = safetyStats(samples);
  const safetyCovered = samples.every(({ baseline, treatment }) =>
    baseline.safety_label && treatment.safety_label);
  const outcomeCovered = ['success', 'test_pass_rate'].every((key) => metrics[key].n === samples.length);
  const known = PRIMARY_METRICS.filter((key) => metrics[key] && metrics[key].effect !== 'unknown');
  const better = known.filter((key) => metrics[key].effect === 'better');
  const worse = known.filter((key) => metrics[key].effect === 'worse');

  let verdict;
  let verdictReason;
  if (samples.length === 0) {
    verdict = 'unknown';
    verdictReason = `không có cặp (task_id, seed) nào có đủ cả ${baselineArm} lẫn ${treatmentArm}`;
  } else if (safety.regressions.length > 0) {
    verdict = 'regression';
    verdictReason = `nhãn an toàn xấu đi ở ${treatmentArm}: `
      + safety.regressions.map((r) => `${r.task_id}/${r.seed}: ${r.label}`).join(', ');
  } else if (incompletePairs > 0) {
    verdict = 'unknown';
    verdictReason = `${incompletePairs} task/seed thiếu ${baselineArm} hoặc ${treatmentArm} — cần chạy đủ hai arm`;
  } else if (evidence !== 'held-out-real') {
    verdict = 'unknown';
    verdictReason = `bằng chứng là "${evidence}", không phải held-out thật — `
      + 'không suy ra được lợi ích online (cần thu thập held-out riêng)';
  } else if (!safetyCovered || !outcomeCovered) {
    verdict = 'unknown';
    verdictReason = 'thiếu nhãn an toàn hoặc kết quả success/test_pass_rate ở một số cặp';
  } else if (known.length === 0) {
    verdict = 'unknown';
    verdictReason = 'mọi chỉ số chính đều thiếu đo thật (unknown)';
  } else if (worse.length > 0 && better.length === 0) {
    verdict = 'regression';
    verdictReason = `chỉ số xấu đi, không chỉ số nào tốt lên: ${worse.join(', ')}`;
  } else if (better.length > 0 && worse.length === 0) {
    verdict = 'net_positive';
    verdictReason = 'không chỉ số chính nào xấu đi và có chỉ số tốt lên';
  } else if (better.length > 0 && worse.length > 0) {
    // Có cả tốt lên lẫn xấu đi (ví dụ jev_calls tăng — cái giá của lớp Jev — đổi
    // lấy wall-time/token giảm). KHÔNG tự chấm thành net-positive hay regression:
    // đây là chỗ con người phải cân, tool chỉ nêu cả hai phía.
    verdict = 'mixed';
    verdictReason = `vừa tốt lên (${better.join(', ')}) vừa xấu đi (${worse.join(', ')}) — cần người cân`;
  } else {
    verdict = 'neutral';
    verdictReason = 'không chỉ số chính nào khác biệt vượt ngưỡng';
  }

  return {
    baseline: baselineArm,
    treatment: treatmentArm,
    n_pairs: samples.length,
    incomplete_pairs: incompletePairs,
    evidence,
    metrics,
    safety,
    verdict,
    verdict_reason: verdictReason,
  };
}

/**
 * Đánh giá cả tập. THUẦN sau khi đã có `parsed`. Trả báo cáo đầy đủ.
 *
 * `arms` dùng để đếm độ phủ theo từng arm (bao nhiêu task/seed có mặt).
 */
export function evaluate(parsed, {
  baseline = DEFAULT_BASELINE,
  treatments = DEFAULT_TREATMENTS,
  tolerance = 0,
} = {}) {
  if (!ARMS.includes(baseline)) throw new RangeError(`baseline phải thuộc ${ARMS.join('/')}: ${baseline}`);
  for (const arm of treatments) {
    if (!ARMS.includes(arm)) throw new RangeError(`treatment phải thuộc ${ARMS.join('/')}: ${arm}`);
    if (arm === baseline) throw new RangeError(`treatment trùng baseline: ${arm}`);
  }

  const pairs = groupPairs(parsed.records);
  const armCoverage = {};
  for (const arm of ARMS) {
    const records = parsed.records.filter((record) => record.arm === arm);
    const keys = new Set(records.map(pairKey));
    armCoverage[arm] = { records: records.length, pairs: keys.size };
  }

  const warnings = [];
  if (parsed.malformed.length > 0) warnings.push(`${parsed.malformed.length} dòng JSONL hỏng — đã bỏ`);
  if (parsed.incomplete.length > 0) warnings.push(`${parsed.incomplete.length} dòng thiếu task_id/seed/arm — đã bỏ`);
  if (parsed.unknownArm.length > 0) warnings.push(`${parsed.unknownArm.length} dòng có arm lạ (ngoài ${ARMS.join('/')}) — đã bỏ`);
  if (parsed.unsupportedSchema.length > 0) {
    warnings.push(`${parsed.unsupportedSchema.length} dòng khai schema trajectory phiên bản mới (${ROW_SCHEMA}) — công cụ v1 TỪ CHỐI đọc, dùng tools/trajectory-matrix.mjs`);
  }
  if (parsed.duplicates.length > 0) {
    warnings.push(`${parsed.duplicates.length} khoá (task_id, seed, arm) TRÙNG — loại hết nhóm trùng, không đoán bản nào chuẩn`);
  }
  const syntheticPairs = new Set();
  for (const [key, entry] of pairs) {
    for (const record of Object.values(entry.byArm)) {
      if (provenance(record) === 'synthetic') syntheticPairs.add(key);
    }
  }
  if (syntheticPairs.size > 0) {
    warnings.push(`${syntheticPairs.size} cặp có bản ghi nguồn TỔNG HỢP — chỉ để thử công cụ, KHÔNG suy ra lợi ích online`);
  }

  const comparisons = {};
  for (const treatment of treatments) {
    comparisons[treatment] = compareArm(pairs, baseline, treatment, { tolerance });
  }

  return {
    baseline,
    treatments: [...treatments],
    tolerance,
    counts: {
      records: parsed.records.length,
      pairs: pairs.size,
      malformed: parsed.malformed.length,
      incomplete: parsed.incomplete.length,
      unknown_arm: parsed.unknownArm.length,
      unsupported_schema: parsed.unsupportedSchema.length,
      duplicate_keys: parsed.duplicates.length,
      synthetic_pairs: syntheticPairs.size,
    },
    arm_coverage: armCoverage,
    warnings,
    comparisons,
  };
}

/* ───────────────────────────── CLI ───────────────────────────── */

const HELP = `benchmark-trajectory — so A/B theo trajectory (paired), offline.

Dùng:
  node tools/benchmark-trajectory.mjs <trajectory.jsonl> [tuỳ chọn]

Tuỳ chọn:
  --baseline <arm>        arm gốc (mặc định ${DEFAULT_BASELINE})
  --treatments <a,b>      arm điều trị (mặc định ${DEFAULT_TREATMENTS.join(',')})
  --tolerance <số>        ngưỡng coi là khác biệt (mặc định 0)
  --json                  in JSON đầy đủ
  --help                  in trợ giúp

Arm hợp lệ: ${ARMS.join(', ')}.
Ghép cặp theo (task_id, seed). Thiếu một bên ⇒ unknown, không lấp.
Lợi ích online chỉ được phán khi mọi cặp là held-out THẬT (source=real).
Tool chỉ ĐỌC file — không mạng, không gọi Jev, không chạy lệnh.
`;

export function parseArgv(argv) {
  const options = {
    file: null,
    baseline: DEFAULT_BASELINE,
    treatments: [...DEFAULT_TREATMENTS],
    tolerance: 0,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--baseline') options.baseline = String(next());
    else if (arg === '--treatments') {
      // Nhận cả dạng phẩy (`core,experimental`) lẫn dạng cách (`core experimental`).
      // Chỉ nuốt token kế tiếp nếu nó ĐÚNG là tên arm, nên không ăn mất tên file.
      const list = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
      while (i + 1 < argv.length && ARMS.includes(argv[i + 1])) list.push(argv[++i]);
      options.treatments = list;
    }
    else if (arg === '--tolerance') options.tolerance = Number(next());
    else if (!arg.startsWith('-') && options.file === null) options.file = arg;
    else process.stderr.write(`tham số lạ: ${arg}\n`);
  }
  return options;
}

const fmt = (value) => (value === null || value === undefined ? 'unknown' : String(value));

export function printHuman(report) {
  const lines = [];
  lines.push('benchmark-trajectory — so A/B theo cặp (task_id, seed)');
  lines.push('─'.repeat(64));
  const c = report.counts;
  lines.push(`bản ghi ${c.records} | cặp ${c.pairs} | hỏng ${c.malformed} | thiếu trường ${c.incomplete} `
    + `| arm lạ ${c.unknown_arm} | schema lạ ${c.unsupported_schema} | khoá trùng ${c.duplicate_keys}`);
  lines.push(`độ phủ theo arm: ${ARMS.map((arm) => `${arm}=${report.arm_coverage[arm].pairs} cặp`).join('  ')}`);
  for (const warning of report.warnings) lines.push(`cảnh báo: ${warning}`);

  for (const treatment of report.treatments) {
    const comp = report.comparisons[treatment];
    lines.push('');
    lines.push(`${comp.baseline} → ${treatment}  (n cặp = ${comp.n_pairs}, thiếu arm = ${comp.incomplete_pairs}, bằng chứng = ${comp.evidence})`);
    if (comp.n_pairs === 0) {
      lines.push('  KHÔNG SUY RA ĐƯỢC: không có cặp nào đủ hai arm');
      lines.push(`  phán quyết: ${comp.verdict.toUpperCase()} — ${comp.verdict_reason}`);
      continue;
    }
    lines.push('  chỉ số                 n     baseline        treatment       delta        hiệu ứng');
    for (const metric of METRICS) {
      const s = comp.metrics[metric.key];
      const name = metric.key.padEnd(20);
      if (s.n === 0) {
        lines.push(`  ${name} ${String(0).padEnd(5)} ${'unknown'.padEnd(15)} ${'unknown'.padEnd(15)} ${'unknown'.padEnd(12)} unknown`);
        continue;
      }
      const pct = s.delta_pct === null ? '' : ` (${round4(s.delta_pct * 100)}%)`;
      lines.push(`  ${name} ${String(s.n).padEnd(5)} ${String(s.baseline_mean).padEnd(15)} `
        + `${String(s.treatment_mean).padEnd(15)} ${String(s.delta).padEnd(12)} ${s.effect}${pct}`);
    }
    lines.push(`  nhãn an toàn ${treatment}: ${JSON.stringify(comp.safety.treatment)}`
      + `  (${comp.baseline}: ${JSON.stringify(comp.safety.baseline)})`);
    if (comp.safety.regressions.length > 0) {
      lines.push(`  AN TOÀN THỤT LÙI: ${comp.safety.regressions.map((r) => `${r.task_id}/${r.seed}: ${r.label}`).join(', ')}`);
    }
    lines.push(`  phán quyết: ${comp.verdict.toUpperCase()} — ${comp.verdict_reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  if (options.help || !options.file) {
    process.stdout.write(HELP);
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  let text;
  try {
    text = readFileSync(resolve(options.file), 'utf8');
  } catch (error) {
    process.stderr.write(`không đọc được ${options.file}: ${error?.code ?? error?.message}\n`);
    process.exitCode = 1;
    return;
  }
  let report;
  try {
    report = evaluate(parseTrajectories(text), {
      baseline: options.baseline,
      treatments: options.treatments,
      tolerance: options.tolerance,
    });
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${printHuman(report)}\n`);
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) main();
