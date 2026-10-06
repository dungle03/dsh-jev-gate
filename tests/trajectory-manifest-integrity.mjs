/**
 * Hợp đồng OFFLINE: `verifyManifestAgainstRows` phải BẮT được manifest không khớp
 * với mảng row THẬT — chạy hàm thật, không mạng, không gọi model.
 *
 * Vì sao cần một file test riêng: manifest là "lời khai" về một lần thu thập, còn
 * file JSONL là bằng chứng. Nếu chỉ tin lời khai, một lần chạy dở (bị giết giữa
 * chừng, ghi thiếu row, trộn split) vẫn có thể qua cửa và trở thành kết luận.
 * Ở đây ta dựng row/manifest THẬT rồi cố tình làm lệch từng trường một, khẳng
 * định đúng vấn đề machine-readable được nêu ra — không có trường hợp nào lọt.
 */
import assert from 'node:assert/strict';
import { summarize } from '../tools/collect-trajectory.mjs';
import { canonicalJson, ROW_SCHEMA, verifyManifestAgainstRows } from '../tools/trajectory-schema.mjs';
import { TASKS, taskById } from '../tools/trajectory-tasks.mjs';

// ---------------------------------------------------------------- fixture row
// Dựng row qua ĐÚNG hàm `summarize` của collector (không tự bịa object): manifest
// kiểm trên dữ liệu mà collector thật sinh ra, không phải hình dạng tưởng tượng.
const task = taskById('navigation-marker-v1');
const events = [
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 1 } },
  { type: 'tool_call', callId: 'read-marker', tool: 'read', input: { file_path: 'marker.txt' } },
  { type: 'tool_result', callId: 'read-marker', status: 'completed', result: 'TRAJECTORY_OK_731' },
  { type: 'final', text: 'TRAJECTORY_OK_731' },
];
const decisions = [
  { type: 'boot', config: { profile: 'safe', enableJevgrepEscalation: false, enableQualityReview: true,
    enableCompletionCheck: true, effortAbstain: false } },
  { type: 'jev_ok', ms: 10, usage: { input_tokens: 5, output_tokens: 2 } },
];
const evaluation = await task.evaluate({ workspace: '/nonexistent', events, exitCode: 0, unchanged: true });

/** Row THẬT cho một (task, arm, seed, split) — mọi trường identity đều có. */
const makeRow = ({ arm, seed, split = 'validation', runId = 'run-1', taskOverride = task }) => summarize(
  events, decisions, {
    task: taskOverride, arm, seed, model: 'fixture', elapsed: 1, exitCode: 0, unchanged: true,
    dsh_version: '0.2.0-rc.2', evaluation, preflight: {}, run_id: runId, created_at: '2026-01-01T00:00:00.000Z',
    plugin_git_commit: 'commit-fixture', plugin_dirty_state: false, dsh_git_commit: null,
    model_endpoint_origin: 'fixture.example:443', split,
  });

// Một lần chạy hợp lệ: 2 task × 1 seed × 2 arm.
const rows = [
  makeRow({ arm: 'vanilla', seed: 1 }),
  makeRow({ arm: 'safe', seed: 1 }),
  makeRow({ arm: 'vanilla', seed: 1, taskOverride: taskById('routine-copy-v1') }),
  makeRow({ arm: 'safe', seed: 1, taskOverride: taskById('routine-copy-v1') }),
];
assert.equal(rows.length, 4);
assert.ok(rows.every((row) => row.schema === ROW_SCHEMA));
assert.ok(rows.every((row) => row.source === 'real'));

/** Manifest "chuẩn" khớp CHÍNH XÁC mảng row trên. */
const goodManifest = {
  status: 'complete', expected_rows: 4, written_rows: 4, run_id: 'run-1', split: 'validation',
  mode: 'normal', collector_version: '2', arms: ['vanilla', 'safe'],
  tasks: ['navigation-marker-v1', 'routine-copy-v1'], seeds: [1],
};
// Baseline: manifest đúng ⇒ KHÔNG vấn đề nào.
assert.deepEqual(verifyManifestAgainstRows(rows, goodManifest), { ok: true, problems: [] },
  'manifest khớp row phải trả ok:true, problems rỗng');
// `ok` phải là hàm của `problems`, không phải một cờ gán tay.
const baseline = verifyManifestAgainstRows(rows, goodManifest);
assert.equal(baseline.ok, baseline.problems.length === 0);

// ---------------------------------------------------------------- từng ca lệch
/** Khẳng định một biến thể manifest bị BẮT với đúng chuỗi vấn đề. */
const caught = (label, manifest, expected) => {
  const verdict = verifyManifestAgainstRows(rows, manifest);
  assert.equal(verdict.ok, false, `${label}: phải bị từ chối`);
  assert.ok(verdict.problems.includes(expected),
    `${label}: mong ${expected}, nhận ${JSON.stringify(verdict.problems)}`);
  return verdict;
};

// (1) THIẾU manifest hoàn toàn ⇒ không thể biết file có đầy đủ không.
assert.deepEqual(verifyManifestAgainstRows(rows, null), { ok: false, problems: ['no-run-manifest'] });
assert.deepEqual(verifyManifestAgainstRows(rows, undefined), { ok: false, problems: ['no-run-manifest'] });
// Mảng là hình dạng SAI của manifest (không phải object) ⇒ malformed, không được coi là hợp lệ.
assert.deepEqual(verifyManifestAgainstRows(rows, []), { ok: false, problems: ['malformed-run-manifest'] });
assert.deepEqual(verifyManifestAgainstRows(rows, 'complete'), { ok: false, problems: ['malformed-run-manifest'] });
// `rows` không phải mảng ⇒ coi như rỗng, KHÔNG ném (một input hỏng không được làm sập kiểm tra).
assert.ok(verifyManifestAgainstRows(null, goodManifest).problems.includes('manifest-written-rows-mismatch:4!=0'),
  'rows null phải bị coi là rỗng, không ném');

// (2) status != 'complete' ⇒ lần chạy dở, không tin được.
caught('status incomplete', { ...goodManifest, status: 'incomplete' }, 'incomplete-run-manifest');
caught('status rỗng', { ...goodManifest, status: '' }, 'incomplete-run-manifest');
caught('status thiếu', { ...goodManifest, status: undefined }, 'incomplete-run-manifest');

// (3) written_rows != số row THẬT ⇒ file bị cắt/sửa so với lời khai.
caught('written_rows lệch thật', { ...goodManifest, written_rows: 3 },
  'manifest-written-rows-mismatch:3!=4');
caught('written_rows thừa', { ...goodManifest, written_rows: 5 },
  'manifest-written-rows-mismatch:5!=4');
// written_rows khớp file nhưng KHÁC expected ⇒ thiếu row so với dự kiến.
caught('thiếu so với expected', { ...goodManifest, expected_rows: 8, written_rows: 4 },
  'manifest-wrote-fewer-rows-than-expected');
// Thiếu HẲN số đếm ⇒ không thể chứng minh đầy đủ.
caught('thiếu counts', { ...goodManifest, written_rows: undefined },
  'manifest-row-counts-missing');
caught('expected không phải int', { ...goodManifest, expected_rows: 4.5 },
  'manifest-row-counts-missing');

// (4) run_id lệch ⇒ row không thuộc lần chạy mà manifest khai.
caught('run_id lệch', { ...goodManifest, run_id: 'run-2' }, 'manifest-run-id-mismatch');
caught('run_id trống', { ...goodManifest, run_id: '  ' }, 'manifest-missing-run-id');
caught('run_id thiếu', { ...goodManifest, run_id: undefined }, 'manifest-missing-run-id');

// (5) TRỘN split trong mảng row ⇒ nhóm không thể gắn nhãn held-out.
const mixedSplit = [...rows.slice(0, 3), makeRow({ arm: 'safe', seed: 1, split: 'held-out' })];
assert.ok(verifyManifestAgainstRows(mixedSplit, goodManifest).problems.includes('rows-mixed-split'),
  'mảng trộn split phải bị bắt với rows-mixed-split');
// Row cùng split nhưng KHÁC manifest ⇒ lệch, không phải trộn.
caught('split lệch manifest', { ...goodManifest, split: 'held-out' }, 'manifest-split-mismatch');
// mode trộn cũng bị bắt (outage vs normal không được lẫn trong một lần chạy).
const mixedMode = [...rows.slice(0, 3),
  summarize(events, decisions, { task, arm: 'safe', seed: 1, model: 'fixture', elapsed: 1,
    exitCode: 0, unchanged: true, dsh_version: '0.2.0-rc.2', evaluation, preflight: {},
    run_id: 'run-1', mode: 'jev-outage', split: 'outage', plugin_git_commit: 'commit-fixture',
    plugin_dirty_state: false, model_endpoint_origin: 'fixture.example:443' })];
assert.ok(verifyManifestAgainstRows(mixedMode, goodManifest).problems.includes('rows-mixed-mode'),
  'mảng trộn mode phải bị bắt với rows-mixed-mode');
// collector_version trộn ⇒ hai collector khác nhau, không so được.
const mixedCollector = [...rows.slice(0, 3), { ...rows[3], collector_version: '9' }];
assert.ok(verifyManifestAgainstRows(mixedCollector, goodManifest).problems.includes('rows-mixed-collector-version'),
  'trộn collector_version phải bị bắt');

// (6) danh sách arm THIẾU một arm ⇒ manifest không phủ hết treatment trong file.
caught('arms thiếu', { ...goodManifest, arms: ['vanilla'] }, 'manifest-arms-mismatch');
caught('arms thừa', { ...goodManifest, arms: ['vanilla', 'safe', 'balanced'] }, 'manifest-arms-mismatch');
// Thứ tự arm trong manifest KHÔNG quan trọng (so như tập hợp).
assert.deepEqual(verifyManifestAgainstRows(rows, { ...goodManifest, arms: ['safe', 'vanilla'] }),
  { ok: true, problems: [] });

// (7) seeds lệch ⇒ row thuộc seed không được khai.
caught('seeds thiếu', { ...goodManifest, seeds: [] }, 'manifest-seeds-mismatch');
caught('seeds thừa', { ...goodManifest, seeds: [1, 2] }, 'manifest-seeds-mismatch');
caught('seeds khác giá trị', { ...goodManifest, seeds: [2] }, 'manifest-seeds-mismatch');

// (8) tasks lệch ⇒ manifest khai task không có trong file (hoặc ngược lại).
caught('tasks thiếu', { ...goodManifest, tasks: ['navigation-marker-v1'] }, 'manifest-tasks-mismatch');
caught('tasks thừa', { ...goodManifest, tasks: ['navigation-marker-v1', 'routine-copy-v1', 'bug-diagnosis-calc-v1'] },
  'manifest-tasks-mismatch');

// ---------------------------------------------------------------- nhiều lỗi cùng lúc
// Một manifest sai ở NHIỀU trường phải nêu HẾT, không dừng ở lỗi đầu tiên: người
// đọc cần thấy toàn cảnh để sửa một lần.
const manyProblems = verifyManifestAgainstRows(rows, {
  ...goodManifest, status: 'incomplete', written_rows: 2, run_id: 'other', arms: ['vanilla'],
});
assert.equal(manyProblems.ok, false);
for (const expected of ['incomplete-run-manifest', 'manifest-written-rows-mismatch:2!=4',
  'manifest-run-id-mismatch', 'manifest-arms-mismatch']) {
  assert.ok(manyProblems.problems.includes(expected),
    `phải nêu ${expected}, nhận ${JSON.stringify(manyProblems.problems)}`);
}

// ---------------------------------------------------------------- row không phải 'real'
// Row `source != 'real'` KHÔNG bị ràng buộc run_id (fixture/synthetic không có lần
// chạy thật). Điều này giữ đúng ranh giới: chỉ bằng chứng thật mới cần truy vết.
const syntheticRows = rows.map((row) => ({ ...row, source: 'fixture' }));
assert.deepEqual(verifyManifestAgainstRows(syntheticRows, { ...goodManifest, run_id: 'whatever' }),
  { ok: true, problems: [] }, 'row không real không bị ràng buộc run_id');
// Nhưng SỐ ĐẾM vẫn phải khớp, kể cả row không real.
assert.ok(verifyManifestAgainstRows(syntheticRows, { ...goodManifest, written_rows: 2 })
  .problems.includes('manifest-written-rows-mismatch:2!=4'));

// Row rỗng/falsy bị lọc trước khi đếm (một dòng JSONL hỏng không được kéo lệch phép đếm).
assert.deepEqual(verifyManifestAgainstRows([...rows, null, undefined], goodManifest),
  { ok: true, problems: [] }, 'row falsy phải bị lọc, không tính vào số đếm');

// Manifest có thêm trường lạ KHÔNG bị coi là lỗi (chỉ kiểm các trường đã khai).
assert.deepEqual(verifyManifestAgainstRows(rows, { ...goodManifest, extra_field: 'x' }),
  { ok: true, problems: [] });

// Tất định: cùng input ⇒ cùng kết quả (thứ tự problems ổn định).
const first = verifyManifestAgainstRows(rows, { ...goodManifest, status: 'incomplete', arms: ['vanilla'] });
const second = verifyManifestAgainstRows(rows, { ...goodManifest, status: 'incomplete', arms: ['vanilla'] });
assert.equal(canonicalJson(first), canonicalJson(second));

// Sanity: catalog thật đủ lớn để các ca tasks/arms ở trên có ý nghĩa.
assert.ok(TASKS.length >= 6);

console.log('PASS trajectory manifest integrity (real functions, offline, no API calls)');
