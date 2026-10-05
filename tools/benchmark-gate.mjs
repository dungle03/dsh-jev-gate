/**
 * benchmark-gate.mjs — đo và hiệu chỉnh ngưỡng gate phá dữ liệu trên một tập
 * NHÃN NGƯỜI, chạy hoàn toàn OFFLINE (không mạng, không gọi Jev, không chạy
 * shell nào).
 *
 * ## Vì sao có file này
 *
 * `lib/metrics.mjs` đếm được `deny/total` trên log thật, nhưng `allow`/`deny`
 * trong log KHÔNG phải nhãn đúng: gate tự phán rồi tự ghi lại phán đoán của
 * chính nó. Lấy tỉ lệ đó làm "độ chính xác" là lập luận vòng tròn — đo được
 * bao nhiêu `deny` không nói được gate BỎ LỌT bao nhiêu lệnh phá dữ liệu.
 *
 * File này trả lời câu hỏi đó bằng một đường độc lập: người gán nhãn cho từng
 * lệnh (`label`), còn `p` là xác suất model đã ghi lại. Hai thứ đó tách rời
 * nhau, nên confusion matrix mới có nghĩa.
 *
 * ## Bất biến trung thực (đọc trước khi sửa)
 *
 *   1. Nhãn PHẢI do người gán. `label_source` phải khai nguồn độc lập với gate;
 *      nhãn sao chép từ `allow`/`deny`/`decision` của log bị LOẠI khỏi mọi phép
 *      đo và báo riêng — không có cờ nào bật lại được.
 *   2. Không nhãn ⇒ không suy ra được gì. Thiếu nhãn thì tool trả
 *      `inferable:false` và lý do, KHÔNG lấy hành vi lịch sử lấp vào chỗ trống.
 *   3. Ngưỡng chỉ được chọn trên split tune (`train`/`validation`). Split
 *      `test` và `canary` là held-out: chỉ ĐỌC kết quả tại ngưỡng đã chọn.
 *   4. `canary` là tập an toàn: một `false_allow` trong đó là HỎNG, không phải
 *      "trung bình vẫn tốt".
 *   5. Tool không chạy lệnh. Nó chỉ so chuỗi với hai hàm tất định đã có
 *      (`catastrophicMatch`, `isProvablyReadOnly`).
 *
 * ## Định dạng JSONL đầu vào
 *
 * Mỗi dòng một đối tượng:
 *
 * ```json
 * {
 *   "id": "d001",                    // tuỳ chọn
 *   "command": "rm -rf /tmp/build",  // BẮT BUỘC — nguyên văn lệnh
 *   "label": true,                   // BẮT BUỘC — true = lệnh phá dữ liệu
 *   "label_source": "human",         // BẮT BUỘC — nguồn gán nhãn, phải độc lập
 *   "p": 0.83,                       // xác suất model chấm (cần cho quét ngưỡng)
 *   "p_source": "jev-1.13.0",        // tuỳ chọn — nguồn của p
 *   "split": "test"                  // train | validation | test | canary
 * }
 * ```
 *
 * `p` có thể thiếu: bản ghi có `label` nhưng thiếu `p` KHÔNG vào confusion
 * (không áp được ngưỡng lên một điểm không có điểm số), không vào Brier/đường
 * tin cậy, và không tham gia quét ngưỡng — nhưng được ĐẾM RIÊNG và cảnh báo để
 * khoảng trống không âm thầm biến mất. Muốn chấm cả những bản ghi đó, dùng
 * `--deterministic` (chấm bằng hai lớp tất định, không cần `p`).
 *
 * ## Dùng
 *
 * ```
 * node tools/benchmark-gate.mjs tests/fixtures/gate-labels.synthetic.jsonl
 * node tools/benchmark-gate.mjs labels.jsonl --json
 * node tools/benchmark-gate.mjs labels.jsonl --threshold 0.7 --fa-cost 100 --fb-cost 1
 * node tools/benchmark-gate.mjs labels.jsonl --deterministic
 * ```
 *
 * `--deterministic` chấm bằng hai lớp tất định thật trong `lib/` thay vì đọc
 * `p`, để đo đúng phần gate không phụ thuộc Jev. Lệnh không kết luận được
 * (`escalate`) đi tiếp sang Jev và KHÔNG bị tính là allow.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');

/** Loại `label_source` bị coi là vòng tròn — sao chép từ chính quyết định gate. */
const DERIVED_LABEL = /(allow|deny|decision|gate|auto|history|log|policy|record)/i;

/** Loại `p_source` bị coi là không phải đo thật. */
const SYNTHETIC_P = /(synthetic|illustrative|example|fixture|fake|made-?up|dummy)/i;

const TUNE_SPLITS = ['train', 'validation'];
const round4 = (value) => (Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null);

/**
 * Parse JSONL nhãn. THUẦN — nhận chuỗi, trả cấu trúc; không I/O, không mạng.
 *
 * Phân loại từng dòng thay vì ném: một dòng hỏng không được làm mất cả tập đo.
 * Trả kèm `unlabeled`, `derived`, `malformed` để người đọc biết mẫu có sạch.
 */
export function parseLabels(text) {
  const records = [];
  const malformed = [];
  const unlabeled = [];
  const derived = [];
  const syntheticP = [];
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
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      malformed.push({ line: lineNo, error: 'không phải đối tượng' });
      continue;
    }
    const id = typeof row.id === 'string' && row.id ? row.id : `line:${lineNo}`;
    const record = {
      id,
      line: lineNo,
      command: typeof row.command === 'string' ? row.command : '',
      label: row.label === true ? true : row.label === false ? false : null,
      label_source: typeof row.label_source === 'string' ? row.label_source : '',
      p: typeof row.p === 'number' && Number.isFinite(row.p) ? row.p : null,
      p_source: typeof row.p_source === 'string' ? row.p_source : '',
      split: typeof row.split === 'string' && row.split ? row.split : 'unspecified',
    };
    if (record.p !== null && (record.p < 0 || record.p > 1)) {
      malformed.push({ line: lineNo, error: `p ngoài [0,1]: ${record.p}` });
      continue;
    }
    if (record.label === null) {
      unlabeled.push({ id, line: lineNo });
    } else if (!record.label_source) {
      // Có nhãn nhưng không khai nguồn: không chứng minh được là độc lập.
      derived.push({ id, line: lineNo, label_source: '(thiếu)' });
    } else if (DERIVED_LABEL.test(record.label_source)) {
      derived.push({ id, line: lineNo, label_source: record.label_source });
    }
    if (record.p_source && SYNTHETIC_P.test(record.p_source)) {
      syntheticP.push({ id, p_source: record.p_source });
    }
    records.push(record);
  }

  return { records, malformed, unlabeled, derived, syntheticP };
}

/** Bản ghi dùng được làm CHÂN LÝ: có nhãn người, không phải nhãn vòng tròn. */
export function truthRecords(parsed) {
  const bad = new Set([...parsed.unlabeled, ...parsed.derived].map((entry) => entry.id));
  return parsed.records.filter((record) => !bad.has(record.id));
}

/**
 * Confusion matrix tại một ngưỡng. Lớp dương = "lệnh phá dữ liệu".
 *
 * Quy ước: `deny` khi `p >= threshold`. `fn` = lệnh phá dữ liệu bị CHO QUA —
 * đây là lỗi đắt nhất, nên nó luôn đứng riêng chứ không gộp vào "sai".
 *
 * Ngưỡng KHÔNG hợp lệ (null/NaN — ví dụ chưa chọn được ngưỡng vì split tune
 * rỗng) trả về `applied:false` và mọi ô bằng 0. Nếu không chặn ở đây thì
 * `p >= null` sẽ thành `p >= 0` và biến mọi bản ghi thành "bị chặn" — một
 * confusion bịa hoàn toàn.
 */
export function confusion(records, threshold) {
  const usable = typeof threshold === 'number' && Number.isFinite(threshold);
  if (!usable) return { tp: 0, tn: 0, fp: 0, fn: 0, n: 0, applied: false };
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const record of records) {
    if (typeof record.label !== 'boolean' || typeof record.p !== 'number') continue;
    const flagged = record.p >= threshold;
    if (record.label === true) {
      if (flagged) tp += 1; else fn += 1;
    } else if (flagged) fp += 1; else tn += 1;
  }
  return { tp, tn, fp, fn, n: tp + tn + fp + fn, applied: true };
}

/**
 * Chỉ số suy từ confusion. `null` khi mẫu số bằng 0 — "không có dữ liệu" phải
 * đọc được khác "bằng 0".
 *
 * CỐ Ý KHÁC `lib/metrics.mjs`: file đó trả `0` cho mẫu số rỗng
 * (`total === 0 ? 0 : deny / total`). Ở đây chấm điểm một bộ nhãn nên
 * precision=0 và "chưa có mẫu" là hai chuyện khác nhau: `0` sẽ bị đọc thành
 * "gate bỏ sót hết", còn `null` buộc người đọc thấy là chưa đo được. Đổi lại,
 * mọi chỗ tiêu thụ phải tự xử `null` (xem `printHuman`).
 */
export function metrics(matrix, { falseAllowCost = 100, falseBlockCost = 1 } = {}) {
  const { tp, tn, fp, fn, n, applied = true } = matrix;
  const safe = (num, den) => (den === 0 ? null : num / den);
  return {
    tp, tn, fp, fn, n,
    applied,
    precision: round4(safe(tp, tp + fp)),
    recall: round4(safe(tp, tp + fn)),
    false_allow_rate: round4(safe(fn, tp + fn)),
    false_block_rate: round4(safe(fp, fp + tn)),
    specificity: round4(safe(tn, tn + fp)),
    accuracy: round4(safe(tp + tn, n)),
    expected_cost: falseAllowCost * fn + falseBlockCost * fp,
    cost_weights: { false_allow: falseAllowCost, false_block: falseBlockCost },
  };
}

/**
 * Brier score trên các bản ghi có CẢ nhãn lẫn `p`. `null` khi không có mẫu —
 * không bịa 0 cho tập rỗng.
 */
export function brier(records) {
  const usable = records.filter((r) => typeof r.label === 'boolean' && typeof r.p === 'number');
  if (usable.length === 0) return { score: null, n: 0 };
  const sum = usable.reduce((acc, r) => acc + (r.p - (r.label ? 1 : 0)) ** 2, 0);
  return { score: round4(sum / usable.length), n: usable.length };
}

/** Đường tin cậy: mỗi bin 0,1 — dự đoán trung bình so với tần suất thật. */
export function reliability(records, bins = 10) {
  const usable = records.filter((r) => typeof r.label === 'boolean' && typeof r.p === 'number');
  const buckets = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, n: 0, sum_p: 0, positives: 0 }));
  for (const record of usable) {
    const index = Math.min(bins - 1, Math.floor(record.p * bins));
    const bucket = buckets[index];
    bucket.n += 1;
    bucket.sum_p += record.p;
    if (record.label === true) bucket.positives += 1;
  }
  return buckets
    .filter((bucket) => bucket.n > 0)
    .map((bucket) => ({
      bin: `${round4(bucket.lo)}–${round4(bucket.lo + 1 / bins)}`,
      n: bucket.n,
      mean_predicted: round4(bucket.sum_p / bucket.n),
      observed_rate: round4(bucket.positives / bucket.n),
    }));
}

/**
 * Quét ngưỡng. CHỈ nhận bản ghi thuộc split tune — người gọi phải lọc trước;
 * hàm này không tự lọc để không che mất việc tune nhầm trên held-out.
 */
export function sweep(records, thresholds, cost) {
  const points = thresholds.map((threshold) => {
    const matrix = confusion(records, threshold);
    return { threshold, ...metrics(matrix, cost) };
  });
  const usable = points.filter((point) => point.n > 0);
  if (usable.length === 0) return { points, chosen: null, reason: 'không có bản ghi có cả nhãn và p trong split tune' };
  const best = usable.reduce((a, b) => {
    if (b.expected_cost !== a.expected_cost) return b.expected_cost < a.expected_cost ? b : a;
    // Hoà chi phí: ưu tiên ít false-allow hơn, rồi ngưỡng thấp hơn (bảo thủ hơn).
    const fa = (x) => (x.false_allow_rate ?? 0);
    if (fa(b) !== fa(a)) return fa(b) < fa(a) ? b : a;
    return b.threshold < a.threshold ? b : a;
  });
  return { points, chosen: best.threshold, chosen_point: best, reason: null };
}

/** Dải ngưỡng mặc định: 0,05 → 0,95 bước 0,05. */
export function defaultThresholds(step = 0.05) {
  const out = [];
  for (let t = step; t <= 1 - step + 1e-9; t += step) out.push(round4(t));
  return out;
}

/**
 * Chấm một lệnh bằng hai lớp TẤT ĐỊNH thật trong `lib/` — không mạng, không
 * chạy lệnh, chỉ so chuỗi.
 *
 *   deny     — sàn catastrophic bắt được (mất dữ liệu tầng hệ thống)
 *   allow    — chứng minh được chỉ-đọc, bỏ qua Jev
 *   escalate — không kết luận; đi tiếp sang Jev, KHÔNG phải allow
 */
export function deterministicScore(command, { catastrophicMatch, isProvablyReadOnly }) {
  if (catastrophicMatch(command) !== undefined) return 'deny';
  if (isProvablyReadOnly(command)) return 'allow';
  return 'escalate';
}

/** Nạp hai lớp tất định thật. Tách riêng để test bơm bản giả được. */
export async function loadDeterministic() {
  const catastrophic = await import(`${pathToFileURL(join(LIB, 'catastrophic.mjs')).href}?b=${Date.now()}`);
  const readonly = await import(`${pathToFileURL(join(LIB, 'readonly.mjs')).href}?b=${Date.now()}`);
  return {
    catastrophicMatch: catastrophic.catastrophicMatch,
    isProvablyReadOnly: readonly.isProvablyReadOnly,
  };
}

/** Confusion cho lớp tất định: `escalate` là ABSTAIN, không tính là allow. */
export function deterministicMatrix(records, score) {
  let tp = 0; let tn = 0; let fp = 0; let fn = 0; let abstain = 0;
  const canaryFalseAllow = [];
  const details = [];
  for (const record of records) {
    if (typeof record.label !== 'boolean') continue;
    const verdict = score(record.command);
    details.push({ id: record.id, command: record.command, label: record.label, verdict });
    if (verdict === 'escalate') { abstain += 1; continue; }
    const flagged = verdict === 'deny';
    if (record.label === true) {
      if (flagged) tp += 1; else fn += 1;
    } else if (flagged) fp += 1; else tn += 1;
    if (record.split === 'canary' && record.label === true && verdict === 'allow') {
      canaryFalseAllow.push(record.id);
    }
  }
  return { tp, tn, fp, fn, n: tp + tn + fp + fn, abstain, canary_false_allow: canaryFalseAllow, details };
}

/**
 * Đánh giá cả tập: tổng, theo split, Brier, đường tin cậy, và canary.
 *
 * `threshold` là ngưỡng ĐÃ CHỌN (từ split tune). Hàm này không chọn ngưỡng —
 * chọn là việc của `sweep` trên split tune, để held-out không bị rò.
 */
export function evaluate(parsed, { threshold, cost = {}, tuneSplits = TUNE_SPLITS, sweepStep = 0.05 } = {}) {
  if (!Array.isArray(tuneSplits) || !tuneSplits.length
    || tuneSplits.some((split) => !TUNE_SPLITS.includes(split))) {
    throw new RangeError('tuneSplits must contain only train and/or validation');
  }
  const warnings = [];
  const truth = truthRecords(parsed);
  const inferable = truth.length > 0;

  if (parsed.malformed.length > 0) warnings.push(`${parsed.malformed.length} dòng JSONL hỏng — đã bỏ`);
  if (parsed.unlabeled.length > 0) warnings.push(`${parsed.unlabeled.length} bản ghi KHÔNG có nhãn — bỏ khỏi mọi phép đo`);
  if (parsed.derived.length > 0) {
    warnings.push(
      `${parsed.derived.length} bản ghi có nhãn lấy từ quyết định gate (label_source khớp allow/deny/decision/…) — `
      + 'LOẠI khỏi chân lý, không có cờ nào bật lại được',
    );
  }
  if (parsed.syntheticP.length > 0) {
    warnings.push(`${parsed.syntheticP.length} bản ghi có p_source tổng hợp — số dưới đây KHÔNG phải đo Jev thật`);
  }
  const withoutP = truth.filter((r) => typeof r.p !== 'number').length;
  if (withoutP > 0) {
    warnings.push(
      `${withoutP} bản ghi có nhãn nhưng THIẾU p — không áp được ngưỡng nên KHÔNG vào confusion/Brier; `
      + 'dùng --deterministic để chấm cả những bản ghi này',
    );
  }

  if (!inferable) {
    return {
      inferable: false,
      reason: 'không có bản ghi nào có nhãn người độc lập — KHÔNG suy ra được precision/recall/Brier',
      counts: countsOf(parsed, truth),
      warnings,
      threshold: threshold ?? null,
    };
  }

  const splits = [...new Set(truth.map((r) => r.split))].sort();
  const bySplit = {};
  for (const split of splits) {
    const subset = truth.filter((r) => r.split === split);
    bySplit[split] = {
      ...metrics(confusion(subset, threshold), cost),
      brier: brier(subset),
    };
  }

  const tuning = truth.filter((r) => tuneSplits.includes(r.split));
  const sweepResult = sweep(tuning, defaultThresholds(sweepStep), cost);

  const canary = truth.filter((r) => r.split === 'canary');
  const canaryMatrix = confusion(canary, threshold);
  let canaryReport;
  if (canary.length === 0) {
    canaryReport = { records: 0, ok: null, note: 'không có bản ghi canary — không kiểm được tập an toàn' };
  } else if (!canaryMatrix.applied) {
    // Chưa chọn được ngưỡng ⇒ chưa kiểm được canary. Trả `null`, KHÔNG trả
    // `ok:true`: một canary "đạt" vì chưa hề chấm là kết luận an toàn giả.
    canaryReport = { records: canary.length, ok: null, note: 'chưa chọn được ngưỡng — chưa kiểm được canary' };
  } else {
    canaryReport = { records: canary.length, false_allow: canaryMatrix.fn, ok: canaryMatrix.fn === 0 };
  }

  return {
    inferable: true,
    ground_truth: 'nhãn người khai trong JSONL (label + label_source độc lập với gate)',
    counts: countsOf(parsed, truth),
    warnings,
    threshold,
    overall: metrics(confusion(truth, threshold), cost),
    by_split: bySplit,
    brier: brier(truth),
    reliability: reliability(truth),
    sweep: sweepResult,
    canary: canaryReport,
  };
}

function countsOf(parsed, truth) {
  const withoutP = truth.filter((r) => typeof r.p !== 'number');
  return {
    records: parsed.records.length,
    labeled_truth: truth.length,
    unlabeled: parsed.unlabeled.length,
    derived_labels_excluded: parsed.derived.length,
    malformed: parsed.malformed.length,
    with_p: truth.length - withoutP.length,
    labeled_without_p: withoutP.length,
  };
}

/* ───────────────────────────── CLI ───────────────────────────── */

const HELP = `benchmark-gate — đo/ hiệu chỉnh ngưỡng gate phá dữ liệu, offline.

Dùng:
  node tools/benchmark-gate.mjs <labels.jsonl> [tuỳ chọn]

Tuỳ chọn:
  --threshold <0..1>   ngưỡng cần báo cáo (mặc định: ngưỡng tốt nhất từ split tune)
  --sweep <bước>       bước quét ngưỡng (mặc định 0.05)
  --fa-cost <số>       chi phí một false-allow (mặc định 100)
  --fb-cost <số>       chi phí một false-block (mặc định 1)
  --tune-splits <csv>  split dùng để CHỌN ngưỡng (mặc định train,validation)
  --deterministic      chấm bằng hai lớp tất định thật trong lib/ thay vì đọc p
  --json               in JSON đầy đủ
  --help               in trợ giúp

Nhãn phải do người gán (label_source độc lập với gate). Nhãn sao chép từ
allow/deny bị loại. Không có nhãn ⇒ tool nói thẳng là không suy ra được.
`;

function parseArgv(argv) {
  const options = {
    file: null,
    threshold: null,
    sweepStep: 0.05,
    falseAllowCost: 100,
    falseBlockCost: 1,
    tuneSplits: TUNE_SPLITS,
    deterministic: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--deterministic') options.deterministic = true;
    else if (arg === '--threshold') options.threshold = Number(next());
    else if (arg === '--sweep') options.sweepStep = Number(next());
    else if (arg === '--fa-cost') options.falseAllowCost = Number(next());
    else if (arg === '--fb-cost') options.falseBlockCost = Number(next());
    else if (arg === '--tune-splits') options.tuneSplits = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (!arg.startsWith('-') && options.file === null) options.file = arg;
    else process.stderr.write(`tham số lạ: ${arg}\n`);
  }
  return options;
}

const fmt = (value) => (value === null ? 'n/a' : String(value));

export function printHuman(report) {
  const lines = [];
  lines.push('benchmark-gate — gate phá dữ liệu, chân lý = nhãn người');
  lines.push('─'.repeat(64));

  if (!report.inferable) {
    lines.push(`KHÔNG SUY RA ĐƯỢC: ${report.reason}`);
    lines.push(`  bản ghi: ${report.counts.records}, có nhãn dùng được: ${report.counts.labeled_truth}, `
      + `không nhãn: ${report.counts.unlabeled}, nhãn vòng tròn bị loại: ${report.counts.derived_labels_excluded}`);
    for (const warning of report.warnings) lines.push(`  cảnh báo: ${warning}`);
    return lines.join('\n');
  }

  const counts = report.counts;
  lines.push(`bản ghi ${counts.records} | nhãn dùng được ${counts.labeled_truth} | có p ${counts.with_p} | `
    + `không nhãn ${counts.unlabeled} | nhãn vòng tròn bị loại ${counts.derived_labels_excluded} | hỏng ${counts.malformed}`);
  if (counts.labeled_without_p > 0) {
    lines.push(`nhãn có nhưng THIẾU p: ${counts.labeled_without_p} — không vào confusion (xem cảnh báo)`);
  }
  for (const warning of report.warnings) lines.push(`cảnh báo: ${warning}`);

  lines.push('');
  lines.push(`ngưỡng báo cáo: ${fmt(report.threshold)}   (quét trên split tune: ${report.sweep.chosen ?? 'không chọn được'})`);
  const o = report.overall;
  if (!o.applied) {
    lines.push('KHÔNG có ngưỡng để báo cáo — confusion/Brier tại ngưỡng không áp dụng được.');
    lines.push(`      Brier (không phụ thuộc ngưỡng) ${fmt(report.brier.score)} (n=${report.brier.n})`);
  } else {
    lines.push(`tổng: TP ${o.tp}  TN ${o.tn}  FP ${o.fp}  FN ${o.fn}`);
    lines.push(`      precision ${fmt(o.precision)}  recall ${fmt(o.recall)}  `
      + `false_allow ${fmt(o.false_allow_rate)}  false_block ${fmt(o.false_block_rate)}`);
    lines.push(`      chi phí kỳ vọng ${o.expected_cost} (fa=${o.cost_weights.false_allow}, fb=${o.cost_weights.false_block})`);
    lines.push(`      Brier ${fmt(report.brier.score)} (n=${report.brier.n})`);
  }

  lines.push('');
  lines.push('theo split:');
  for (const [split, m] of Object.entries(report.by_split)) {
    if (!m.applied) {
      lines.push(`  ${split.padEnd(12)} (không áp dụng ngưỡng)  Brier ${fmt(m.brier.score)} (n=${m.brier.n})`);
      continue;
    }
    lines.push(`  ${split.padEnd(12)} TP ${m.tp} TN ${m.tn} FP ${m.fp} FN ${m.fn}  `
      + `P ${fmt(m.precision)} R ${fmt(m.recall)}  Brier ${fmt(m.brier.score)} (n=${m.brier.n})`);
  }

  lines.push('');
  if (report.canary.ok === null) lines.push(`canary: ${report.canary.note}`);
  else lines.push(`canary: ${report.canary.records} bản ghi, false-allow ${report.canary.false_allow} — `
    + `${report.canary.ok ? 'ĐẠT' : 'HỎNG'}`);

  lines.push('');
  lines.push(`quét ngưỡng (${report.sweep.points.length} điểm):`);
  for (const point of report.sweep.points) {
    const mark = point.threshold === report.sweep.chosen ? ' ←' : '';
    // n=0: chưa có mẫu để áp ngưỡng. In thẳng ra thay vì TP 0 FP 0 FN 0 —
    // nếu không, người đọc tưởng gate đo được "không bỏ sót gì".
    const body = point.n === 0
      ? 'không có mẫu để chấm'
      : `TP ${point.tp} FP ${point.fp} FN ${point.fn}  `
        + `R ${fmt(point.recall)} FA ${fmt(point.false_allow_rate)}  cost ${point.expected_cost}`;
    lines.push(`  t=${String(point.threshold).padEnd(5)} n=${String(point.n).padEnd(4)} ${body}${mark}`);
  }

  lines.push('');
  lines.push('đường tin cậy (p dự đoán → tần suất phá dữ liệu thật):');
  for (const bin of report.reliability) {
    lines.push(`  ${bin.bin.padEnd(12)} n=${String(bin.n).padEnd(4)} dự đoán ${fmt(bin.mean_predicted)}  thật ${fmt(bin.observed_rate)}`);
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

  const parsed = parseLabels(text);
  const cost = { falseAllowCost: options.falseAllowCost, falseBlockCost: options.falseBlockCost };

  if (options.deterministic) {
    const score = await loadDeterministic();
    const truth = truthRecords(parsed);
    const matrix = deterministicMatrix(truth, (command) => deterministicScore(command, score));
    const report = {
      mode: 'deterministic (lib/catastrophic.mjs + lib/readonly.mjs, không mạng, không chạy lệnh)',
      inferable: truth.length > 0,
      reason: truth.length > 0 ? null : 'không có bản ghi có nhãn người',
      counts: countsOf(parsed, truth),
      warnings: [],
      matrix: { tp: matrix.tp, tn: matrix.tn, fp: matrix.fp, fn: matrix.fn, n: matrix.n },
      metrics: metrics(matrix, cost),
      abstain: matrix.abstain,
      canary_false_allow: matrix.canary_false_allow,
      details: matrix.details,
    };
    if (parsed.unlabeled.length > 0) report.warnings.push(`${parsed.unlabeled.length} bản ghi không nhãn`);
    if (parsed.derived.length > 0) report.warnings.push(`${parsed.derived.length} nhãn vòng tròn bị loại`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`chế độ TẤT ĐỊNH (không gọi Jev, không chạy lệnh)\n${'─'.repeat(64)}\n`);
      process.stdout.write(`nhãn dùng được ${truth.length} | không kết luận (→ Jev) ${matrix.abstain}\n`);
      process.stdout.write(`TP ${matrix.tp}  TN ${matrix.tn}  FP ${matrix.fp}  FN ${matrix.fn}\n`);
      process.stdout.write(`precision ${fmt(report.metrics.precision)}  recall ${fmt(report.metrics.recall)}  `
        + `false_allow ${fmt(report.metrics.false_allow_rate)}\n`);
      if (matrix.canary_false_allow.length > 0) {
        process.stdout.write(`HỎNG canary: lớp tất định cho qua lệnh phá dữ liệu: ${matrix.canary_false_allow.join(', ')}\n`);
      }
    }
    return;
  }

  // Chọn ngưỡng trên split tune trước, rồi báo cáo held-out tại ngưỡng đó.
  const tuning = evaluate(parsed, { cost, tuneSplits: options.tuneSplits, sweepStep: options.sweepStep });
  const threshold = options.threshold ?? tuning.sweep?.chosen ?? null;
  const report = { ...evaluate(parsed, { threshold, cost, tuneSplits: options.tuneSplits, sweepStep: options.sweepStep }), cost };
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(`${printHuman(report)}\n`);
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) main();
