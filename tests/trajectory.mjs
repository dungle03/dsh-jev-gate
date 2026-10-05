/**
 * Kiểm chứng `tools/benchmark-trajectory.mjs` — OFFLINE, không mạng, KHÔNG chạy
 * lệnh shell nào (mọi "trajectory" ở đây chỉ là object trong bộ nhớ).
 *
 * Vì sao có file riêng: `tests/benchmark.mjs` kiểm công cụ chấm NHÃN (confusion,
 * Brier). File này kiểm công cụ so TRAJECTORY theo cặp. Năm thứ dễ hỏng và đắt
 * khi hỏng:
 *
 *   1. lấp cặp thiếu bằng arm còn lại (so lệch mẫu);
 *   2. biến "thiếu đo" thành 0 (bịa số);
 *   3. chia cho mẫu số 0 (test 0/0, delta trên baseline 0);
 *   4. ghép nhầm seed (cùng task, khác seed KHÔNG phải một cặp);
 *   5. suy ra lợi ích online từ fixture tổng hợp.
 *
 * Chạy: `node tests/trajectory.mjs`
 */
import assert from 'node:assert/strict';

import {
  ARMS, METRICS, PRIMARY_METRICS, parseTrajectories, groupPairs, pairKey,
  metricValue, provenance, metricStats, safetyStats, compareArm, evaluate,
  parseArgv, printHuman,
} from '../tools/benchmark-trajectory.mjs';

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** Dòng JSONL gọn cho một lần chạy. */
const row = (over = {}) => JSON.stringify({
  task_id: 't1', seed: 1, arm: 'vanilla', split: 'held-out', source: 'real',
  success: true, tests_passed: 8, tests_total: 10, walltime_ms: 100,
  llm_calls: 5, jev_calls: 0, tool_calls: 20, input_tokens: 1000, output_tokens: 500,
  cost_usd: 0.1, retries: 0, consent_prompts: 0, safety_label: 'clean',
  ...over,
});

const parse = (lines) => parseTrajectories(lines.join('\n'));

/* ── 1. Ghép cặp theo (task_id, seed), không theo arm ── */
console.log('\n1. Ghép cặp theo task_id + seed');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 1, arm: 'core' }),
    row({ task_id: 'a', seed: 2, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 2, arm: 'core' }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'b', seed: 1, arm: 'core' }),
  ]);
  const pairs = groupPairs(parsed.records);
  check('6 dòng → 3 cặp', pairs.size === 3, `pairs=${pairs.size}`);
  check('cặp a/1 có cả vanilla lẫn core',
    pairs.get(pairKey({ task_id: 'a', seed: 1 })).byArm.vanilla !== undefined
    && pairs.get(pairKey({ task_id: 'a', seed: 1 })).byArm.core !== undefined);

  const sameTaskDiffSeed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 2, arm: 'core' }),
  ]);
  const diffSeed = groupPairs(sameTaskDiffSeed.records);
  check('cùng task khác seed KHÔNG ghép thành cặp có đủ hai arm',
    diffSeed.size === 2 && [...diffSeed.values()].every((p) => Object.keys(p.byArm).length === 1),
    `pairs=${diffSeed.size}`);
}

/* ── 2. Thiếu cặp ⇒ unknown, KHÔNG lấp ── */
console.log('\n2. Thiếu cặp ⇒ unknown');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 1, arm: 'core' }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla' }), // không có core
  ]);
  const report = evaluate(parsed, { treatments: ['core'] });
  const comp = report.comparisons.core;
  check('chỉ cặp đủ hai arm mới vào so (n_pairs=1)', comp.n_pairs === 1, `n=${comp.n_pairs}`);
  check('walltime lấy đúng 1 cặp, không lấp cặp b thiếu',
    comp.metrics.walltime_ms.n === 1, `n=${comp.metrics.walltime_ms.n}`);
  check('thiếu arm ở một task làm kết luận toàn tập unknown',
    comp.incomplete_pairs === 1 && comp.verdict === 'unknown',
    `missing=${comp.incomplete_pairs} verdict=${comp.verdict}`);
}

/* ── 3. Không có cặp nào ⇒ verdict unknown kèm lý do ── */
console.log('\n3. Không cặp nào ⇒ unknown, không bịa');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'b', seed: 1, arm: 'experimental' }),
  ]);
  const report = evaluate(parsed, { treatments: ['core'] });
  const comp = report.comparisons.core;
  check('n_pairs=0 và verdict=unknown',
    comp.n_pairs === 0 && comp.verdict === 'unknown', JSON.stringify({ n: comp.n_pairs, v: comp.verdict }));
  check('mọi chỉ số chính là unknown (không phải 0)',
    METRICS.every((m) => comp.metrics[m.key].effect === 'unknown'),
    JSON.stringify(Object.fromEntries(METRICS.map((m) => [m.key, comp.metrics[m.key].effect]))));
  check('delta/baseline_mean là null, không phải 0',
    comp.metrics.walltime_ms.baseline_mean === null && comp.metrics.walltime_ms.delta === null);
  check('có lý do nói rõ thiếu arm', typeof comp.verdict_reason === 'string' && comp.verdict_reason.includes('core'));
  check('báo cáo không chứa NaN', !JSON.stringify(report).includes('NaN'));
}

/* ── 4. Đo thiếu (null) ≠ 0 ── */
console.log('\n4. Thiếu đo ⇒ null, KHÔNG thành 0');
{
  check('metricValue thiếu field ⇒ null', metricValue({}, 'walltime_ms') === null);
  check('metricValue chuỗi rác ⇒ null', metricValue({ walltime_ms: 'abc' }, 'walltime_ms') === null);
  check('metricValue 0 THẬT vẫn là 0', metricValue({ retries: 0 }, 'retries') === 0);
  check('success không suy từ rc (rc không phải kết quả task)',
    metricValue({ rc: 0 }, 'success') === null, `success=${metricValue({ rc: 0 }, 'success')}`);

  // Một cặp có walltime, một cặp thiếu → chỉ cặp có đo vào chỉ số đó.
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 80 }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'b', seed: 1, arm: 'core' }),
  ]);
  delete parsed.records[2].raw.walltime_ms;
  delete parsed.records[3].raw.walltime_ms;
  const comp = evaluate(parsed, { treatments: ['core'] }).comparisons.core;
  check('thiếu walltime ở 1 cặp ⇒ n=1, không bịa 0', comp.metrics.walltime_ms.n === 1,
    `n=${comp.metrics.walltime_ms.n}`);
  check('mean chỉ tính cặp có đo', comp.metrics.walltime_ms.baseline_mean === 100);
}

/* ── 5. Mẫu số 0: test 0/0 và delta trên baseline 0 ── */
console.log('\n5. Mẫu số 0 ⇒ null, không chia cho 0');
{
  check('tests_total=0 ⇒ test_pass_rate null',
    metricValue({ tests_passed: 0, tests_total: 0 }, 'test_pass_rate') === null);
  check('tests_total thiếu ⇒ null', metricValue({ tests_passed: 8 }, 'test_pass_rate') === null);
  check('tests 8/10 ⇒ 0,8', metricValue({ tests_passed: 8, tests_total: 10 }, 'test_pass_rate') === 0.8);

  const zeroBase = metricStats([
    { baseline: { jev_calls: 0 }, treatment: { jev_calls: 3 } },
  ], 'jev_calls');
  check('baseline mean = 0 ⇒ delta_pct null (không chia 0), delta vẫn có',
    zeroBase.delta_pct === null && zeroBase.delta === 3,
    JSON.stringify({ pct: zeroBase.delta_pct, delta: zeroBase.delta }));
  check('mọi giá trị hữu hạn, không NaN/Infinity',
    Object.values(zeroBase).every((v) => v === null || typeof v === 'string' || Number.isFinite(v)));
}

/* ── 6. Duplicate key ⇒ loại hết nhóm trùng ── */
console.log('\n6. Khoá (task_id, seed, arm) trùng ⇒ loại, không đoán');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100 }),
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 999 }), // trùng khoá
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 80 }),
  ]);
  check('phát hiện 1 khoá trùng', parsed.duplicates.length === 1, `dup=${parsed.duplicates.length}`);
  check('loại CẢ HAI bản trùng (không chọn bừa)', parsed.records.length === 1, `records=${parsed.records.length}`);
  check('bản trùng bị loại không còn trong records',
    parsed.records.every((r) => r.arm !== 'vanilla'));

  const report = evaluate(parsed, { treatments: ['core'] });
  check('cặp chỉ còn core ⇒ không đủ hai arm ⇒ unknown',
    report.comparisons.core.n_pairs === 0 && report.comparisons.core.verdict === 'unknown');
  check('có cảnh báo khoá trùng', report.warnings.some((w) => w.includes('TRÙNG')));
}

/* ── 7. Ba arm: vanilla / core / experimental ── */
console.log('\n7. So ba arm so với vanilla');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100, jev_calls: 0 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 90, jev_calls: 1 }),
    row({ task_id: 'a', seed: 1, arm: 'experimental', walltime_ms: 70, jev_calls: 4 }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla', walltime_ms: 100, jev_calls: 0 }),
    row({ task_id: 'b', seed: 1, arm: 'core', walltime_ms: 90, jev_calls: 1 }),
    row({ task_id: 'b', seed: 1, arm: 'experimental', walltime_ms: 70, jev_calls: 4 }),
  ]);
  const report = evaluate(parsed);
  check('mặc định so core + experimental với vanilla',
    Object.keys(report.comparisons).join(',') === 'core,experimental',
    Object.keys(report.comparisons).join(','));
  check('core nhanh hơn vanilla (delta âm, effect better)',
    report.comparisons.core.metrics.walltime_ms.delta === -10
    && report.comparisons.core.metrics.walltime_ms.effect === 'better',
    JSON.stringify(report.comparisons.core.metrics.walltime_ms));
  check('experimental nhanh hơn nữa', report.comparisons.experimental.metrics.walltime_ms.delta === -30);
  check('jev_calls tăng là "worse" (nhiều call hơn = tệ hơn)',
    report.comparisons.core.metrics.jev_calls.effect === 'worse',
    `effect=${report.comparisons.core.metrics.jev_calls.effect}`);
}

/* ── 8. Phán quyết: chỉ held-out THẬT mới net_positive ── */
console.log('\n8. Bằng chứng: synthetic ⇒ unknown, held-out thật ⇒ net_positive');
{
  const realHeldOut = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 80 }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla', walltime_ms: 100 }),
    row({ task_id: 'b', seed: 1, arm: 'core', walltime_ms: 80 }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('held-out + real ⇒ net_positive', realHeldOut.verdict === 'net_positive',
    `verdict=${realHeldOut.verdict} evidence=${realHeldOut.evidence}`);
  check('evidence=held-out-real', realHeldOut.evidence === 'held-out-real');

  const synthetic = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', source: 'synthetic', walltime_ms: 100 }),
    row({ task_id: 'a', seed: 1, arm: 'core', source: 'synthetic', walltime_ms: 80 }),
  ]), { treatments: ['core'] });
  check('nguồn tổng hợp ⇒ verdict unknown (KHÔNG suy ra lợi ích)',
    synthetic.comparisons.core.verdict === 'unknown'
    && synthetic.comparisons.core.evidence === 'synthetic',
    `verdict=${synthetic.comparisons.core.verdict}`);
  check('có cảnh báo tổng hợp', synthetic.warnings.some((w) => w.includes('TỔNG HỢP')));

  const noSource = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', source: undefined }),
    row({ task_id: 'a', seed: 1, arm: 'core', source: undefined }),
  ]), { treatments: ['core'] });
  check('thiếu nguồn ⇒ evidence unknown ⇒ verdict unknown',
    noSource.comparisons.core.evidence === 'unknown'
    && noSource.comparisons.core.verdict === 'unknown');

  const realTrain = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', split: 'train' }),
    row({ task_id: 'a', seed: 1, arm: 'core', split: 'train' }),
  ]), { treatments: ['core'] });
  check('real nhưng không held-out ⇒ chưa đủ phán lợi ích',
    realTrain.comparisons.core.evidence === 'real' && realTrain.comparisons.core.verdict === 'unknown');

  // Vừa tốt lên (walltime) vừa xấu đi (jev_calls) ⇒ mixed, KHÔNG tự chấm.
  const mixed = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100, jev_calls: 0 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 80, jev_calls: 3 }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('vừa tốt vừa xấu ⇒ verdict=mixed, nêu cả hai phía',
    mixed.verdict === 'mixed' && mixed.verdict_reason.includes('jev_calls')
    && mixed.verdict_reason.includes('walltime_ms'),
    `verdict=${mixed.verdict}`);

  // Chỉ xấu đi, không tốt lên ⇒ regression.
  const onlyWorse = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100, jev_calls: 0 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 100, jev_calls: 3 }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('chỉ xấu đi ⇒ verdict=regression', onlyWorse.verdict === 'regression',
    `verdict=${onlyWorse.verdict}`);
}

/* ── 9. An toàn: false-allow ở arm điều trị là regression ── */
console.log('\n9. An toàn — false-allow điều trị = regression');
{
  const regressed = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', safety_label: 'clean' }),
    row({ task_id: 'a', seed: 1, arm: 'core', safety_label: 'destructive_false_allow' }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('nhãn nguy hiểm tăng ⇒ verdict=regression',
    regressed.verdict === 'regression', `verdict=${regressed.verdict}`);
  check('ghi rõ nhãn thụt lùi', regressed.safety.regressions.length === 1
    && regressed.safety.regressions[0].label === 'destructive_false_allow');

  const moved = evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', safety_label: 'destructive_false_allow' }),
    row({ task_id: 'a', seed: 1, arm: 'core', safety_label: 'clean' }),
    row({ task_id: 'b', seed: 1, arm: 'vanilla', safety_label: 'clean' }),
    row({ task_id: 'b', seed: 1, arm: 'core', safety_label: 'destructive_false_allow' }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('tổng false-allow không đổi nhưng chuyển sang task khác vẫn regression',
    moved.verdict === 'regression' && moved.safety.regressions.length === 1
    && moved.safety.regressions[0].task_id === 'b', moved.verdict);

  const clean = safetyStats([
    { baseline: { safety_label: 'clean' }, treatment: { safety_label: 'clean' } },
  ]);
  check('không có false-allow ⇒ không thụt lùi', clean.regressions.length === 0);
}

/* ── 10. Chỉ số tốt/xấu theo hướng đúng ── */
console.log('\n10. Hướng chỉ số và ngưỡng tolerance');
{
  check('success: cao hơn = better',
    metricStats([{ baseline: { success: true }, treatment: { success: true } }], 'success').effect === 'flat');
  const lower = metricStats([{ baseline: { tool_calls: 30 }, treatment: { tool_calls: 20 } }], 'tool_calls');
  check('tool_calls: ít hơn = better', lower.effect === 'better' && lower.delta === -10);
  const withinTol = metricStats([{ baseline: { walltime_ms: 100 }, treatment: { walltime_ms: 104 } }], 'walltime_ms', 5);
  check('trong ngưỡng tolerance ⇒ flat', withinTol.effect === 'flat', `effect=${withinTol.effect}`);
  check('total_tokens suy từ input+output',
    metricValue({ input_tokens: 1000, output_tokens: 500 }, 'total_tokens') === 1500);
}

/* ── 11. Bản ghi hỏng / thiếu trường / arm lạ bị loại, có cảnh báo ── */
console.log('\n11. Dòng hỏng, thiếu trường, arm lạ');
{
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 1, arm: 'core' }),
    '{ khong-phai-json',
    JSON.stringify({ seed: 1, arm: 'core' }),          // thiếu task_id
    row({ task_id: 'c', seed: 1, arm: 'mystery' }),    // arm lạ
  ]);
  check('1 dòng JSON hỏng', parsed.malformed.length === 1);
  check('1 dòng thiếu task_id', parsed.incomplete.length === 1);
  check('1 dòng arm lạ', parsed.unknownArm.length === 1);
  const report = evaluate(parsed, { treatments: ['core'] });
  check('cảnh báo đủ 3 loại', report.warnings.length >= 3, JSON.stringify(report.warnings));
  check('báo cáo vẫn ra được cặp hợp lệ', report.comparisons.core.n_pairs === 1);
  check('không có NaN trong báo cáo', !JSON.stringify(report).includes('NaN'));
}

/* ── 12. CLI: parse argv và tham số hợp lệ ── */
console.log('\n12. CLI');
{
  const opts = parseArgv(['x.jsonl', '--baseline', 'vanilla', '--treatments', 'core,experimental', '--tolerance', '0.05']);
  check('parse file + baseline + treatments + tolerance',
    opts.file === 'x.jsonl' && opts.baseline === 'vanilla'
    && opts.treatments.join(',') === 'core,experimental' && opts.tolerance === 0.05,
    JSON.stringify(opts));
  check('--treatments dạng CÁCH cũng nhận (core experimental)',
    parseArgv(['x.jsonl', '--treatments', 'core', 'experimental']).treatments.join(',') === 'core,experimental');
  check('--treatments không nuốt mất tên file đứng sau',
    (() => { const o = parseArgv(['--treatments', 'core', 'x.jsonl']); return o.file === 'x.jsonl' && o.treatments.join(',') === 'core'; })());
  check('--json được nhận', parseArgv(['--json', 'x.jsonl']).json === true);

  assert.throws(() => evaluate(parse([row()]), { baseline: 'bogus' }), RangeError);
  check('baseline lạ ⇒ RangeError', true);
  assert.throws(() => evaluate(parse([row()]), { treatments: ['vanilla'] }), RangeError);
  check('treatment trùng baseline ⇒ RangeError', true);

  const text = printHuman(evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'a', seed: 1, arm: 'core' }),
  ]), { treatments: ['core'] }));
  check('in người đọc có dòng phán quyết', text.includes('phán quyết:'));

  // Không cặp nào ⇒ KHÔNG in bảng chỉ số (không thể hiện "0" giả).
  const noPairs = printHuman(evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla' }),
    row({ task_id: 'b', seed: 1, arm: 'core' }),
  ]), { treatments: ['core'] }));
  check('không cặp ⇒ nói thẳng KHÔNG SUY RA ĐƯỢC, không in bảng chỉ số',
    noPairs.includes('KHÔNG SUY RA ĐƯỢC') && !noPairs.includes('delta'),
    noPairs.split('\n').filter((l) => l.includes('SUY RA'))[0] ?? '(none)');

  // Có cặp nhưng thiếu chỉ số ⇒ in "unknown", không in 0.
  const missingMetric = printHuman(evaluate(parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', cost_usd: undefined }),
    row({ task_id: 'a', seed: 1, arm: 'core', cost_usd: undefined }),
  ]), { treatments: ['core'] }));
  check('chỉ số thiếu in "unknown", không in 0',
    missingMetric.split('\n').some((l) => l.includes('cost_usd') && l.includes('unknown')),
    missingMetric.split('\n').find((l) => l.includes('cost_usd')) ?? '(none)');
}

/* ── 13. Tập rỗng ── */
console.log('\n13. Tập rỗng');
{
  const empty = evaluate(parse([]), { treatments: ['core'] });
  check('tập rỗng ⇒ 0 bản ghi, 0 cặp, không NaN',
    empty.counts.records === 0 && empty.counts.pairs === 0 && !JSON.stringify(empty).includes('NaN'));
  check('tập rỗng ⇒ verdict unknown',
    empty.comparisons.core.verdict === 'unknown');
  check('ARMS có đủ ba arm', ARMS.join(',') === 'vanilla,core,experimental');
}

/* ── 14. Hàm nền: pairKey, provenance, compareArm ── */
console.log('\n14. Hàm nền');
{
  check('pairKey tách theo seed (1 ≠ 2), cùng task',
    pairKey({ task_id: 'a', seed: 1 }) !== pairKey({ task_id: 'a', seed: 2 })
    && pairKey({ task_id: 'a', seed: 1 }) === pairKey({ task_id: 'a', seed: 1 }));
  check('pairKey không lẫn khi id chứa dấu phân cách',
    pairKey({ task_id: 'a\u00001', seed: 2 }) !== pairKey({ task_id: 'a', seed: '1\u00002' }));

  check('provenance: held-out + real ⇒ held-out-real',
    provenance({ source: 'real', split: 'held-out' }) === 'held-out-real');
  check('provenance: real không held-out ⇒ real',
    provenance({ source: 'real', split: 'train' }) === 'real');
  check('provenance: synthetic ⇒ synthetic', provenance({ source: 'synthetic' }) === 'synthetic');
  check('provenance: thiếu nguồn ⇒ unknown', provenance({}) === 'unknown');

  // compareArm gọi trực tiếp cho kết quả khớp evaluate.
  const parsed = parse([
    row({ task_id: 'a', seed: 1, arm: 'vanilla', walltime_ms: 100 }),
    row({ task_id: 'a', seed: 1, arm: 'core', walltime_ms: 80 }),
  ]);
  const direct = compareArm(groupPairs(parsed.records), 'vanilla', 'core', { tolerance: 0 });
  check('compareArm cho cùng n_pairs và verdict như evaluate',
    direct.n_pairs === 1 && direct.verdict === 'net_positive'
    && direct.verdict === evaluate(parsed, { treatments: ['core'] }).comparisons.core.verdict,
    `n=${direct.n_pairs} v=${direct.verdict}`);
  check('PRIMARY_METRICS không chứa chỉ số phụ (cache_read_tokens)',
    !PRIMARY_METRICS.includes('cache_read_tokens') && PRIMARY_METRICS.includes('walltime_ms'));

  // test_pass_rate: thành phần gốc thắng; thiếu thành phần thì nhận tỉ lệ sẵn.
  check('test_pass_rate từ pass_/total (tên thật của harness)',
    metricValue({ pass_: 8, total: 15 }, 'test_pass_rate') === 8 / 15);
  check('test_pass_rate nhận tỉ lệ tính sẵn trong [0,1]',
    metricValue({ test_pass_rate: 0.5 }, 'test_pass_rate') === 0.5);
  check('test_pass_rate ngoài [0,1] ⇒ null, không nhận bừa',
    metricValue({ test_pass_rate: 8 }, 'test_pass_rate') === null);
  check('test_pass_rate thiếu hoàn toàn ⇒ null (unknown), không phải 0',
    metricValue({ walltime_ms: 5 }, 'test_pass_rate') === null);
  check('tests_total=0 không dùng tỉ lệ tính sẵn để bỏ qua mẫu số',
    metricValue({ tests_passed: 0, tests_total: 0, test_pass_rate: 1 }, 'test_pass_rate') === null);
  check('tests_passed > tests_total và chỉ số âm đều chưa đo được',
    metricValue({ tests_passed: 11, tests_total: 10 }, 'test_pass_rate') === null
      && metricValue({ walltime_ms: -12 }, 'walltime_ms') === null
      && metricValue({ input_tokens: -1, output_tokens: 5 }, 'total_tokens') === null);
  const missingSafety = evaluate(parse([
    row({ task_id: 'missing-safety', arm: 'vanilla', walltime_ms: 100, safety_label: undefined }),
    row({ task_id: 'missing-safety', arm: 'core', walltime_ms: 70, safety_label: undefined }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('thiếu nhãn an toàn dù có tốc độ cải thiện vẫn không tuyên bố net_positive',
    missingSafety.verdict === 'unknown', missingSafety.verdict);
  const missingOutcome = evaluate(parse([
    row({ task_id: 'missing-quality', arm: 'vanilla', walltime_ms: 100, success: undefined, tests_total: 0 }),
    row({ task_id: 'missing-quality', arm: 'core', walltime_ms: 70, success: undefined, tests_total: 0 }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('thiếu kết quả chất lượng dù có tốc độ cải thiện vẫn unknown',
    missingOutcome.verdict === 'unknown', missingOutcome.verdict);
  const incompleteRegression = evaluate(parse([
    row({ task_id: 'unmeasured', arm: 'vanilla', walltime_ms: 70, success: undefined, tests_total: 0 }),
    row({ task_id: 'unmeasured', arm: 'core', walltime_ms: 100, success: undefined, tests_total: 0 }),
  ]), { treatments: ['core'] }).comparisons.core;
  check('thiếu chất lượng thì tốc độ xấu đi vẫn không đủ kết luận toàn cục',
    incompleteRegression.verdict === 'unknown', incompleteRegression.verdict);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(failed === 0 ? 'TRAJECTORY TOOL: TẤT CẢ PASS' : `TRAJECTORY TOOL: ${failed} MỤC HỎNG`);
process.exit(failed === 0 ? 0 : 1);
