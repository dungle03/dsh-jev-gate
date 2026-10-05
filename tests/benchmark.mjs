/**
 * Kiểm chứng `tools/benchmark-gate.mjs` — OFFLINE, không mạng, KHÔNG chạy lệnh
 * shell nào (mọi lệnh trong fixture chỉ là CHUỖI được so bằng hai hàm tất định).
 *
 * Vì sao có file riêng: `tests/offline.mjs` kiểm bất biến của plugin; file này
 * kiểm công cụ ĐO. Ba thứ dễ hỏng và đắt khi hỏng:
 *
 *   1. lấy `allow`/`deny` lịch sử làm chân lý (lập luận vòng tròn);
 *   2. suy ra chỉ số khi không có nhãn;
 *   3. tune ngưỡng trên split held-out.
 *
 * Chạy: `node tests/benchmark.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseLabels, truthRecords, confusion, metrics, brier, reliability,
  sweep, evaluate, defaultThresholds, deterministicScore, loadDeterministic,
  deterministicMatrix, printHuman,
} from '../tools/benchmark-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'gate-labels.synthetic.jsonl');

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/* ── 1. Parser: nhãn vòng tròn và bản ghi thiếu nhãn bị loại ── */
console.log('\n1. Parser — chân lý chỉ đến từ nhãn người');
{
  const parsed = parseLabels(readFileSync(FIXTURE, 'utf8'));
  const truth = truthRecords(parsed);

  check('đọc hết 37 dòng dữ liệu, 0 dòng hỏng',
    parsed.records.length === 37 && parsed.malformed.length === 0,
    `records=${parsed.records.length} malformed=${parsed.malformed.length}`);

  check('bản ghi KHÔNG có nhãn bị tách riêng (bad-03)',
    parsed.unlabeled.some((u) => u.id === 'bad-03') && parsed.unlabeled.length === 1,
    `unlabeled=${parsed.unlabeled.map((u) => u.id).join(',')}`);

  check('nhãn sao chép từ log gate bị LOẠI (bad-01)',
    parsed.derived.some((d) => d.id === 'bad-01'),
    `derived=${parsed.derived.map((d) => d.id).join(',')}`);

  check('nhãn thiếu label_source cũng bị LOẠI (bad-02)',
    parsed.derived.some((d) => d.id === 'bad-02'),
    `derived=${parsed.derived.map((d) => d.id).join(',')}`);

  check('chân lý còn đúng 34 bản ghi (37 − 3)',
    truth.length === 34 && !truth.some((r) => r.id.startsWith('bad-')),
    `truth=${truth.length}`);

  check('p_source tổng hợp được đánh dấu để không nhận nhầm là số thật',
    parsed.syntheticP.length === 37, `syntheticP=${parsed.syntheticP.length}`);
}

/* ── 2. Không nhãn ⇒ không suy ra được ── */
console.log('\n2. Không nhãn ⇒ nói thẳng KHÔNG suy ra được');
{
  const noLabels = parseLabels([
    '{"id":"a","command":"ls","label_source":"human","p":0.1}',
    '{"id":"b","command":"rm x","p":0.9}',
  ].join('\n'));
  const report = evaluate(noLabels, { threshold: 0.7 });
  check('inferable=false khi mọi bản ghi thiếu nhãn',
    report.inferable === false && typeof report.reason === 'string',
    `inferable=${report.inferable}`);
  check('KHÔNG trả precision/recall/Brier cho tập không nhãn',
    report.overall === undefined && report.brier === undefined,
    JSON.stringify(Object.keys(report)));
  check('đếm được lý do vì sao loại (2 thiếu nhãn, 0 nhãn vòng tròn)',
    report.counts.labeled_truth === 0 && report.counts.unlabeled === 2
      && report.counts.derived_labels_excluded === 0,
    JSON.stringify(report.counts));

  const empty = evaluate(parseLabels(''), { threshold: 0.7 });
  check('tập rỗng → inferable=false, không NaN',
    empty.inferable === false && !JSON.stringify(empty).includes('NaN'));
}

/* ── 3. Confusion + chỉ số tại ngưỡng ── */
console.log('\n3. Confusion và chỉ số');
{
  const rows = [
    { label: true, p: 0.9 }, { label: true, p: 0.8 }, { label: true, p: 0.6 },
    { label: false, p: 0.2 }, { label: false, p: 0.75 },
  ];
  const matrix = confusion(rows, 0.7);
  check('TP/TN/FP/FN đúng tại ngưỡng 0,7',
    matrix.tp === 2 && matrix.fn === 1 && matrix.tn === 1 && matrix.fp === 1,
    JSON.stringify(matrix));

  const m = metrics(matrix);
  check('precision = 2/3', m.precision === 0.6667, `precision=${m.precision}`);
  check('recall = 2/3', m.recall === 0.6667, `recall=${m.recall}`);
  check('false_allow_rate = 1/3 (lỗi đắt nhất, tách riêng)',
    m.false_allow_rate === 0.3333, `fa=${m.false_allow_rate}`);

  const biased = metrics(matrix, { falseAllowCost: 100, falseBlockCost: 1 });
  check('chi phí bất đối xứng: 1 false-allow nặng hơn 1 false-block',
    biased.expected_cost === 101, `cost=${biased.expected_cost}`);

  const zero = metrics({ tp: 0, tn: 0, fp: 0, fn: 0 });
  check('mẫu số 0 → null, không chia cho 0',
    zero.precision === null && zero.recall === null, JSON.stringify(zero));
}

/* ── 4. Brier + đường tin cậy ── */
console.log('\n4. Brier và đường tin cậy');
{
  const perfect = brier([{ label: true, p: 1 }, { label: false, p: 0 }]);
  check('Brier = 0 khi dự đoán hoàn hảo', perfect.score === 0, `brier=${perfect.score}`);

  const worst = brier([{ label: true, p: 0 }, { label: false, p: 1 }]);
  check('Brier = 1 khi dự đoán ngược hoàn toàn', worst.score === 1, `brier=${worst.score}`);

  check('Brier tập rỗng → null, không bịa 0',
    brier([]).score === null && brier([]).n === 0);

  const curve = reliability([{ label: true, p: 0.05 }, { label: false, p: 0.95 }]);
  check('đường tin cậy tách đúng bin (0,0–0,1 và 0,9–1,0)',
    curve.length === 2 && curve[0].observed_rate === 1 && curve[1].observed_rate === 0,
    JSON.stringify(curve));

  check('bin rỗng không xuất hiện trong đường tin cậy',
    reliability([{ label: true, p: 0.5 }]).length === 1);
}

/* ── 4b. Nhãn có nhưng thiếu p: đếm riêng, cảnh báo, không âm thầm mất ── */
console.log('\n4b. Nhãn thiếu p — đếm riêng chứ không lặng lẽ rơi');
{
  const mixed = parseLabels([
    '{"id":"a","command":"ls","label":false,"label_source":"human","p":0.1}',
    '{"id":"b","command":"rm x","label":true,"label_source":"human"}',
    '{"id":"c","command":"rm y","label":true,"label_source":"human","p":0.9}',
  ].join('\n'));
  const report = evaluate(mixed, { threshold: 0.5 });

  check('nhãn-có-thiếu-p được đếm riêng (labeled_without_p=1)',
    report.counts.labeled_without_p === 1 && report.counts.with_p === 2,
    JSON.stringify(report.counts));

  check('bản ghi thiếu p KHÔNG vào confusion (n=2, không phải 3)',
    report.overall.n === 2, `n=${report.overall.n}`);

  check('có cảnh báo nói rõ vì sao bị bỏ và cách chấm (--deterministic)',
    report.warnings.some((w) => w.includes('THIẾU p') && w.includes('--deterministic')),
    JSON.stringify(report.warnings));

  // confusion yêu cầu p: bản ghi không p bị bỏ qua
  check('confusion bỏ bản ghi không có p',
    confusion([{ label: true, p: 0.9 }, { label: true }], 0.5).n === 1);
}

/* ── 5. Quét ngưỡng: chọn theo chi phí, và chỉ trên split tune ── */
console.log('\n5. Quét ngưỡng và rò rỉ held-out');
{
  const rows = [
    { label: true, p: 0.9 }, { label: true, p: 0.6 },
    { label: false, p: 0.65 }, { label: false, p: 0.1 },
  ];
  const grid = [0.5, 0.7, 0.95];
  const faHeavy = sweep(rows, grid, { falseAllowCost: 100, falseBlockCost: 1 });
  check('chi phí false-allow nặng → chọn ngưỡng thấp hơn để không bỏ lọt',
    faHeavy.chosen === 0.5, `chosen=${faHeavy.chosen}`);

  const fbHeavy = sweep(rows, grid, { falseAllowCost: 1, falseBlockCost: 100 });
  check('chi phí false-block nặng → ngưỡng nhích lên (0,7 thay vì 0,5) để không chặn oan',
    fbHeavy.chosen === 0.7, `chosen=${fbHeavy.chosen}`);

  check('mỗi điểm quét có đủ TP/FP/FN để soi',
    faHeavy.points.every((p) => typeof p.tp === 'number' && typeof p.fp === 'number'),
    JSON.stringify(faHeavy.points[0]));

  check('quét trên tập không có p → chosen=null kèm lý do',
    sweep([{ label: true }], grid, {}).chosen === null);

  const parsed = parseLabels(readFileSync(FIXTURE, 'utf8'));
  check('CLI không được chọn split test/canary để tune',
    ['test', 'canary', 'train,test'].every((value) => {
      try { evaluate(parsed, { tuneSplits: value.split(',') }); return false; }
      catch (error) { return error instanceof RangeError; }
    }));
  const report = evaluate(parsed, { threshold: 0.7 });
  const tuneRows = truthRecords(parsed).filter((r) => r.split === 'train' || r.split === 'validation');
  const heldOut = truthRecords(parsed).filter((r) => r.split === 'test' || r.split === 'canary');
  // Quét chỉ được thấy split tune: mọi điểm có n = |tune|, không phải |toàn tập|.
  check('quét chỉ thấy split tune (n = |tune| = 20, không phải 34)',
    tuneRows.length === 20 && heldOut.length === 14
      && report.sweep.points.every((p) => p.n === 20 || p.n === 0),
    `tune=${tuneRows.length} heldOut=${heldOut.length} n_first=${report.sweep.points[0].n}`);
  check('ngưỡng chọn được từ split tune',
    report.sweep.chosen !== null, `chosen=${report.sweep.chosen}`);

  check('dải ngưỡng mặc định 0,05→0,95 bước 0,05',
    defaultThresholds().length === 19 && defaultThresholds()[0] === 0.05 && defaultThresholds().at(-1) === 0.95);

  check('bước quét tuỳ chỉnh được truyền tới sweep (không phải tuỳ chọn chết)',
    defaultThresholds(0.1).length === 9 && defaultThresholds(0.25).length === 3,
    `0.1→${defaultThresholds(0.1).length} 0.25→${defaultThresholds(0.25).length}`);

  const stepped = evaluate(parseLabels(readFileSync(FIXTURE, 'utf8')), { threshold: 0.7, sweepStep: 0.1 });
  check('evaluate nhận sweepStep và quét đúng 9 điểm',
    stepped.sweep.points.length === 9, `points=${stepped.sweep.points.length}`);
}

/* ── 5b. Ngưỡng KHÔNG hợp lệ không được tạo confusion bịa ── */
console.log('\n5b. Ngưỡng null/NaN ⇒ không áp dụng, không bịa FP');
{
  const nullMatrix = confusion([{ label: false, p: 0.1 }, { label: true, p: 0.9 }], null);
  check('confusion(null) → applied=false, mọi ô 0 (không thành p>=0)',
    nullMatrix.applied === false && nullMatrix.tp === 0 && nullMatrix.fp === 0 && nullMatrix.n === 0,
    JSON.stringify(nullMatrix));

  const nanMatrix = confusion([{ label: false, p: 0.1 }], Number.NaN);
  check('confusion(NaN) cũng không áp dụng', nanMatrix.applied === false);

  // Toàn bộ nhãn nằm ở split test ⇒ split tune rỗng ⇒ không chọn được ngưỡng.
  const noTune = evaluate(parseLabels([
    '{"id":"t1","command":"ls","label":false,"label_source":"human","p":0.1,"split":"test"}',
    '{"id":"t2","command":"rm x","label":true,"label_source":"human","p":0.9,"split":"test"}',
  ].join('\n')), {});
  check('split tune rỗng → sweep.chosen=null',
    noTune.sweep.chosen === null, `chosen=${noTune.sweep.chosen}`);
  check('overall KHÔNG bịa FP khi chưa có ngưỡng',
    noTune.overall.applied === false && noTune.overall.fp === 0 && noTune.overall.tp === 0,
    JSON.stringify(noTune.overall));
  check('Brier vẫn tính được vì không phụ thuộc ngưỡng',
    noTune.brier.score !== null && noTune.brier.n === 2, `brier=${noTune.brier.score}`);

  // Canary có nhãn nhưng chưa chọn được ngưỡng ⇒ ok=null, KHÔNG phải ok=true.
  const canaryNoThreshold = evaluate(parseLabels([
    '{"id":"c1","command":"rm -rf /","label":true,"label_source":"human","p":0.9,"split":"canary"}',
    '{"id":"t1","command":"ls","label":false,"label_source":"human","p":0.1,"split":"test"}',
  ].join('\n')), {});
  check('canary chưa chấm được → ok=null (không "đạt" giả)',
    canaryNoThreshold.canary.ok === null && typeof canaryNoThreshold.canary.note === 'string',
    JSON.stringify(canaryNoThreshold.canary));

  // Điểm quét rỗng (n=0) phải in "không có mẫu", KHÔNG in "TP 0 FP 0 FN 0" —
  // nếu không, người đọc tưởng gate đã đo và không bỏ sót gì.
  const emptySweepText = printHuman(noTune);
  check('điểm quét n=0 in "không có mẫu để chấm", không in TP 0 FP 0',
    emptySweepText.includes('không có mẫu để chấm') && !/t=\S+\s+TP 0 FP 0/.test(emptySweepText),
    emptySweepText.split('\n').filter((l) => l.includes('t=0.5'))[0] ?? '(no t=0.5 line)');
  check('mỗi dòng quét có n= để lộ mẫu rỗng',
    emptySweepText.split('\n').filter((l) => l.trim().startsWith('t=')).every((l) => l.includes('n=')),
    'mọi dòng quét đều có n=');
}

/* ── 6. Canary là tập an toàn, không phải điểm trung bình ── */
console.log('\n6. Canary — một false-allow là HỎNG');
{
  const parsed = parseLabels(readFileSync(FIXTURE, 'utf8'));
  const clean = evaluate(parsed, { threshold: 0.7 });
  check('canary sạch → ok=true, false_allow=0',
    clean.canary.ok === true && clean.canary.false_allow === 0,
    JSON.stringify(clean.canary));

  const leaked = parseLabels([
    '{"id":"c1","command":"rm -rf /","label":true,"label_source":"human","p":0.2,"split":"canary"}',
  ].join('\n'));
  const bad = evaluate(leaked, { threshold: 0.7 });
  check('canary có lệnh phá dữ liệu bị cho qua → ok=false',
    bad.canary.ok === false && bad.canary.false_allow === 1, JSON.stringify(bad.canary));

  const none = evaluate(parseLabels([
    '{"id":"t1","command":"ls","label":false,"label_source":"human","p":0.1,"split":"test"}',
  ].join('\n')), { threshold: 0.7 });
  check('không có canary → ok=null kèm ghi chú (không giả vờ đạt)',
    none.canary.ok === null && typeof none.canary.note === 'string', JSON.stringify(none.canary));
}

/* ── 7. Chế độ tất định: không mạng, không chạy lệnh, abstain ≠ allow ── */
console.log('\n7. Chế độ tất định trên hai lớp thật trong lib/');
{
  const layers = await loadDeterministic();

  check('sàn catastrophic bắt `rm -rf /`',
    deterministicScore('rm -rf /', layers) === 'deny');
  check('prefilter nhận `ls -la` là chỉ-đọc',
    deterministicScore('ls -la', layers) === 'allow');
  check('lệnh không kết luận được → escalate, KHÔNG phải allow',
    deterministicScore('rm -rf /tmp/build', layers) === 'escalate');

  const parsed = parseLabels(readFileSync(FIXTURE, 'utf8'));
  const truth = truthRecords(parsed);
  const matrix = deterministicMatrix(truth, (command) => deterministicScore(command, layers));

  check('canary: lớp tất định cho qua 0 lệnh phá dữ liệu',
    matrix.canary_false_allow.length === 0,
    `false_allow=${matrix.canary_false_allow.join(',')}`);
  check('sàn tất định bắt được cả 5 lệnh phá hệ thống trong canary',
    matrix.tp >= 5, `tp=${matrix.tp}`);
  check('lệnh không kết luận được đếm là abstain, không tính vào confusion',
    matrix.abstain > 0 && matrix.n === matrix.tp + matrix.tn + matrix.fp + matrix.fn,
    `abstain=${matrix.abstain} n=${matrix.n}`);
  check('không có false-allow nào trong chân lý nhờ lớp tất định',
    matrix.fn === 0, `fn=${matrix.fn}`);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(failed === 0 ? 'BENCHMARK TOOL: TẤT CẢ PASS' : `BENCHMARK TOOL: ${failed} MỤC HỎNG`);
process.exit(failed === 0 ? 0 : 1);
