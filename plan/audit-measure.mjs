#!/usr/bin/env node
/**
 * Tái lập mọi số liệu trong plan/audit-2026-10-16.md từ log quyết định thật.
 *
 *   node plan/audit-measure.mjs [đường-dẫn-log]
 *
 * Mặc định đọc `$XDG_DATA_HOME/dsh-jev-gate/decisions.jsonl`
 * (tức `~/.local/share/dsh-jev-gate/decisions.jsonl`).
 *
 * Script CHỈ ĐỌC. Không ghi log, không gọi mạng, không chạm repo.
 * Chạy lại sau khi log xoay vòng sẽ ra số khác — đó là mục đích: báo cáo
 * ghi kèm cửa sổ thời gian, và script này là cách kiểm chứng lại cửa sổ đó.
 *
 *   node plan/audit-measure.mjs --assert [đường-dẫn-log]
 *
 * `--assert` biến các BẤT BIẾN (không phải con số) thành điều kiện thoát:
 * thoát 1 nếu bất biến nào vỡ. Số liệu thô luôn trôi theo log đang sống nên
 * KHÔNG bao giờ được assert; chỉ assert những quan hệ phải luôn đúng với MỌI
 * cửa sổ log, kể cả log cũ viết trước khi sửa:
 *   - vòng đời operation cân: `reserved_cost + skip_budget == operation_finished`
 *     (mỗi operation mở bằng `reserved_cost` hoặc `skip_budget`), không có
 *     `operation_finished` mồ côi hay trùng lặp;
 *   - mọi dòng `allow_readonly` KHÔNG bị clip vẫn chứng minh lại được là chỉ-đọc;
 *   - mọi dòng chặn cứng đều kèm `command` để audit được.
 * Độ phủ `turn` trên dòng gate chỉ được IN RA, không assert: log cũ (trước khi
 * sửa §6.8) hợp lệ mà thiếu `turn`, nên assert nó sẽ báo động giả.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isProvablyReadOnly } from '../lib/readonly.mjs';
import { readLogWithRotated } from '../lib/metrics.mjs';

const ASSERT = process.argv.includes('--assert');
const problems = [];
const invariant = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const DEFAULT_LOG = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'dsh-jev-gate',
  'decisions.jsonl',
);

const path = (ASSERT ? process.argv.filter((a) => a !== '--assert') : process.argv)[2] ?? DEFAULT_LOG;

/**
 * Chưa có log ⇒ KHÔNG phải lỗi, ở CẢ hai chế độ.
 *
 * Log quyết định là dữ liệu RUNTIME: máy CI sạch hoặc máy mới cài chưa từng chạy
 * DSH thì chưa có file. Bất biến là mệnh đề trên log ĐANG CÓ — không có log thì
 * chưa có gì để vi phạm. Thoát 0 kèm ghi chú để `npm test` và `verify.sh` chạy
 * được ở mọi nơi, thay vì đỏ vì thiếu dữ liệu.
 *
 * Trước đây chỉ chế độ `--assert` tha lỗi này, còn chế độ thường `throw` — nghĩa
 * là nối script vào `npm test` sẽ làm CI đỏ trên máy không có log, đúng thứ mà
 * việc nối này nhằm tránh.
 */
let rows;
try {
  // `readLogWithRotated` đọc CẢ `decisions.jsonl.1` — thiếu nó thì số đo tụt đúng
  // lúc log xoay, và bất biến vòng đời operation vỡ vì một op mở ở `.1` đóng ở
  // file sống (nhìn như "rò" trong khi mã đúng).
  rows = readLogWithRotated(path)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
} catch (error) {
  if (error.code !== 'ENOENT') throw error; // hỏng thật (EACCES, JSON vỡ) thì phải đỏ
  console.log(`${ASSERT ? 'ASSERT: ' : ''}bỏ qua — chưa có log tại ${path}`);
  console.log('  (log là dữ liệu runtime; máy chưa chạy DSH thì chưa có gì để kiểm)\n');
  process.exit(0);
}

const by = (type) => rows.filter((row) => row.type === type);
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

function section(title) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

// ── 1. Cửa sổ + census ──────────────────────────────────────────────────────
section('1. Cửa sổ log và census theo type');
console.log(`file      : ${path}`);
console.log(`tổng dòng : ${rows.length}`);
console.log(`cửa sổ    : ${rows[0]?.at}  →  ${rows[rows.length - 1]?.at}`);
const census = {};
for (const row of rows) census[row.type] = (census[row.type] ?? 0) + 1;
for (const [type, n] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(20)} ${String(n).padStart(6)}`);
}

// ── 2. Lớp 1 — destructive gate ────────────────────────────────────────────
section('2. Lớp 1 — destructive_gate');
const gate = by('destructive_gate');
const decisions = {};
for (const row of gate) decisions[row.decision] = (decisions[row.decision] ?? 0) + 1;
console.log(`tổng dòng gate: ${gate.length}`);
for (const [decision, n] of Object.entries(decisions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${decision.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, gate.length)}`);
}
const hardDeny = (decisions.deny ?? 0) + (decisions.deny_catastrophic ?? 0) + (decisions.deny_outage ?? 0);
console.log(`  → chặn cứng (deny/deny_catastrophic/deny_outage): ${hardDeny}`);
console.log(`  → cached:true                                   : ${gate.filter((r) => r.cached).length}`);

// BẤT BIẾN: mọi dòng chặn cứng phải kèm `command` để audit được (đo được trên
// log cũ: 555/555 dòng `fail_open` rỗng `command` — đã sửa, giữ test này).
const denyRows = gate.filter((r) => ['deny', 'deny_catastrophic', 'deny_outage', 'deny_consent'].includes(r.decision));
const denyNoCommand = denyRows.filter((r) => typeof r.command !== 'string' || !r.command.trim());
invariant('mọi dòng deny có `command`', denyNoCommand.length === 0, `${denyNoCommand.length} dòng thiếu`);

// KHÔNG assert độ phủ `turn`: log viết trước khi sửa §6.8 hợp lệ mà thiếu `turn`.
const gateNoTurn = gate.filter((r) => r.turn === undefined);
console.log(`  → dòng gate thiếu \`turn\` (log cũ, không assert): ${gateNoTurn.length}`);

const withCommand = gate.filter((r) => typeof r.command === 'string');
console.log(`  → dòng có 'command'   : ${withCommand.length}`);
console.log(`  → bị clip ở 400 ký tự : ${withCommand.filter((r) => r.command.length >= 400).length}`);

const ps = gate.filter((r) => typeof r.p === 'number').map((r) => r.p);
ps.sort((a, b) => a - b);
console.log(`\nphân bố p (n=${ps.length}): min ${ps[0]} · median ${quantile(ps, 0.5)} · max ${ps[ps.length - 1]}`);
console.log(`  p ≤ 0.02 : ${ps.filter((x) => x <= 0.02).length}  (${pct(ps.filter((x) => x <= 0.02).length, ps.length)})`);
console.log(`  p ≥ 0.50 : ${ps.filter((x) => x >= 0.5).length}`);
console.log('  đáy:', [0.01, 0.02, 0.03, 0.04, 0.05].map((k) => `p=${k}:${ps.filter((x) => Math.abs(x - k) < 0.005).length}`).join(' '));

const nearThreshold = gate.filter((r) => typeof r.p === 'number' && r.p >= 0.5);
if (nearThreshold.length) {
  console.log('\n  các dòng p ≥ 0.5 (điểm mù heredoc):');
  for (const row of nearThreshold) {
    console.log(`    p=${row.p} ${String(row.decision).padEnd(16)} ${String(row.command).slice(0, 80).replace(/\n/g, ' ')}`);
  }
}

// ── 3. Độ phủ prefilter ───────────────────────────────────────────────────
section('3. Độ phủ prefilter chỉ-đọc (lib/readonly.mjs)');
const allowed = gate.filter((r) => r.decision === 'allow' && typeof r.command === 'string');
const caught = allowed.filter((r) => isProvablyReadOnly(r.command));
const readonlyRows = gate.filter((r) => r.decision === 'allow_readonly');
console.log(`lệnh 'allow' (đã lọt Jev)          : ${allowed.length}`);
console.log(`  prefilter LẼ RA bắt được          : ${caught.length}  (${pct(caught.length, allowed.length)})`);
console.log(`dòng 'allow_readonly' (đã bắt sẵn)  : ${readonlyRows.length}`);
const stillCatchable = readonlyRows.filter((r) => typeof r.command === 'string' && isProvablyReadOnly(r.command));
// Chỉ kiểm lại được những dòng KHÔNG bị clip: bản ghi cắt ở 400 ký tự nên phần đuôi
// (chính là phần khiến prefilter kết luận được) đã mất. Đếm riêng phần bị cắt thay vì
// tính nó là lệch — đo được: mọi dòng 'allow_readonly' không chứng minh lại được đều bị clip.
const roUnclipped = readonlyRows.filter((r) => typeof r.command === 'string' && r.command.length < 400);
const roClipped = readonlyRows.filter((r) => typeof r.command === 'string' && r.command.length >= 400);
const roReproven = roUnclipped.filter((r) => isProvablyReadOnly(r.command));
console.log(`  kiểm lại được (không bị clip)     : ${roUnclipped.length}  → chứng minh lại được ${roReproven.length}`
  + `  (${roReproven.length === roUnclipped.length ? 'OK' : 'LỆCH'})`);
// BẤT BIẾN AN TOÀN: mọi lệnh prefilter đã cho qua (không bị clip) phải chứng
// minh lại được là chỉ-đọc. Vỡ = prefilter đã cho qua thứ nó không chứng minh nổi.
invariant('allow_readonly không-clip chứng minh lại được', roReproven.length === roUnclipped.length,
  `${roUnclipped.length - roReproven.length} dòng không chứng minh lại được`);
console.log(`  bị clip ở 400 (không kiểm lại được): ${roClipped.length}`);
console.log(`  (tổng chứng minh lại được          : ${stillCatchable.length})`);

// ── 4. Độ trễ + token ─────────────────────────────────────────────────────
section('4. Độ trễ và token (jev_ok)');
const ok = by('jev_ok');
const latencies = ok.map((r) => r.ms).filter((n) => typeof n === 'number').sort((a, b) => a - b);
console.log(`call thành công: ${ok.length}`);
console.log(`ms  p50 ${quantile(latencies, 0.5)} · p95 ${quantile(latencies, 0.95)} · p99 ${quantile(latencies, 0.99)} · max ${latencies[latencies.length - 1]}`);
const tokens = ok.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0);
console.log(`input token tổng: ${tokens}  ⇒  $${((tokens / 1e9) * 42).toFixed(4)} ở $42/Btok (output miễn phí)`);
console.log('\ntheo lớp:');
const layers = {};
for (const row of ok) {
  const layer = row.layer ?? '(none)';
  layers[layer] ??= { n: 0, tokens: 0 };
  layers[layer].n += 1;
  layers[layer].tokens += row.usage?.input_tokens ?? 0;
}
for (const [layer, s] of Object.entries(layers).sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${layer.padEnd(20)} n=${String(s.n).padStart(4)} tokens=${String(s.tokens).padStart(8)} avg=${Math.round(s.tokens / s.n)}`);
}

// ── 5. Lỗi + gián đoạn người dùng ─────────────────────────────────────────
section('5. Lỗi Jev và gián đoạn người dùng');
const errors = by('jev_error');
const errLayers = {};
for (const row of errors) errLayers[row.layer] = (errLayers[row.layer] ?? 0) + 1;
console.log(`jev_error: ${errors.length}  theo lớp: ${JSON.stringify(errLayers)}`);
console.log(`  TimeoutError : ${errors.filter((r) => /TimeoutError/.test(r.message ?? '')).length}`);
console.log(`  abort hook   : ${errors.filter((r) => /thrown object/.test(r.message ?? '')).length}`);
console.log(`  ENETUNREACH  : ${errors.filter((r) => /ENETUNREACH/.test(r.message ?? '')).length}`);
for (const row of errors.filter((r) => /TimeoutError/.test(r.message ?? ''))) {
  console.log(`    ${String(row.layer).padEnd(18)} ms=${String(row.ms).padStart(6)}`);
}

const interruptions = gate.filter((r) => r.decision === 'allow_consented' || r.decision === 'deny_consent');
console.log(`\ngián đoạn người dùng: ${interruptions.length} (${pct(interruptions.length, gate.length)})`);
const cause = {};
for (const row of interruptions) {
  const key = /TimeoutError/.test(row.error ?? '') ? 'timeout'
    : /256 KiB/.test(row.error ?? '') ? 'payload-256KiB'
      : /ENETUNREACH/.test(row.error ?? '') ? 'ENETUNREACH'
        : 'user-refused';
  cause[key] = (cause[key] ?? 0) + 1;
}
for (const [key, n] of Object.entries(cause)) console.log(`  ${key.padEnd(16)} ${n}`);

// ── 6. Ngân sách ──────────────────────────────────────────────────────────
section('6. Ngân sách (cost_governor)');
const cg = by('cost_governor');
const cgDecisions = {};
for (const row of cg) cgDecisions[row.decision] = (cgDecisions[row.decision] ?? 0) + 1;
console.log(`cost_governor: ${cg.length}  ${JSON.stringify(cgDecisions)}`);

/**
 * Sổ sách vòng đời operation — đối chiếu theo `operation_id`, KHÔNG theo tổng đếm.
 *
 * Mỗi operation mở bằng `reserved_cost` HOẶC `skip_budget` (cả hai đều gọi
 * `beginOperation`), rồi đóng bằng đúng một `operation_finished`. Nên đẳng thức
 * đúng là `reserved_cost + skip_budget == operation_finished` — so mỗi
 * `reserved_cost` với `operation_finished` là SAI (lần đầu chạy assert đã báo
 * động giả đúng vì lý do này).
 *
 * Hai hướng hỏng có ý nghĩa KHÁC NHAU:
 *   - finish mà không có start  ⇒ đóng sổ hai lần (hồi quy thật, phải chặn);
 *   - start mà không có finish  ⇒ RÒ ngân sách: lượt giữ chỗ không bao giờ trả
 *     lại, làm cạn `jevMaxCallsPerSession` một cách vô hình.
 */
const starts = new Set();
for (const row of cg) {
  if (row.decision === 'reserved_cost' || row.decision === 'skip_budget') starts.add(row.operation_id);
}
const finishes = cg.filter((r) => r.decision === 'operation_finished').map((r) => r.operation_id);
const finishSet = new Set(finishes);
const doubleClose = finishes.filter((id) => !starts.has(id));
const leaked = [...starts].filter((id) => !finishSet.has(id));
const duplicated = finishes.length - finishSet.size;
console.log(`vòng đời: start ${starts.size} (reserved ${cgDecisions.reserved_cost ?? 0} + skip ${cgDecisions.skip_budget ?? 0})`
  + ` · finish ${finishes.length} ⇒ ${starts.size === finishes.length ? 'cân' : 'LỆCH'}`);
console.log(`  finish KHÔNG có start (đóng hai lần): ${doubleClose.length}`);
console.log(`  start KHÔNG có finish (RÒ ngân sách) : ${leaked.length}  ${leaked.length ? leaked.map((id) => String(id).slice(0, 8)).join(' ') : ''}`);
if (duplicated > 0) console.log(`  operation_finished trùng operation_id: ${duplicated}`);

// BẤT BIẾN CHẶT: đóng sổ hai lần là hồi quy thật (một operation đóng đúng một lần).
invariant('không có `operation_finished` mồ côi (đóng hai lần)', doubleClose.length === 0,
  `${doubleClose.length} dòng: ${doubleClose.slice(0, 3).map((id) => String(id).slice(0, 8)).join(' ')}`);
invariant('không có `operation_finished` trùng lặp', duplicated === 0, `${duplicated} dòng trùng`);

/**
 * Rò (`start` không có `finish`) chỉ IN RA, KHÔNG assert.
 *
 * Đo được 1/1.106 trên log thật (op `e52d2e16`, gate 15/10 15:42:15 — có
 * `actual_invocation` rồi im lặng). Hai nguyên nhân hợp lệ khiến nó xảy ra mà
 * KHÔNG phải lỗi logic: (a) tiến trình chết giữa chừng; (b) `makeRecorder` ghi
 * log qua chuỗi promise có `.catch(() => {})` — một lần ghi hỏng bị nuốt im.
 * Vì cả hai đều không phải hồi quy mã, assert sẽ báo động giả trên log cũ.
 * Nhưng nó vẫn là chỉ số sức khoẻ: rò nhiều = ngân sách bị ăn vô hình.
 */
if (leaked.length > 0) {
  console.log(`  ⚠ rò vòng đời: ${leaked.length}/${starts.size} (${pct(leaked.length, starts.size)})`
    + ' — tiến trình chết hoặc một lần ghi log bị nuốt, không phải lỗi logic');
}

const invocations = cg.filter((r) => r.decision === 'actual_invocation');
const safety = invocations.filter((r) => r.reason === 'safety_priority');
const admitted = invocations.filter((r) => r.reason === 'admitted');
console.log(`\nactual_invocation: ${invocations.length}`);
console.log(`  safety_priority (miễn ngân sách, reserved_units=0): ${safety.length}  (${pct(safety.length, invocations.length)})`);
console.log(`  admitted (đi qua ngân sách thật)                  : ${admitted.length}`);
const admittedLayers = {};
for (const row of admitted) admittedLayers[row.layer] = (admittedLayers[row.layer] ?? 0) + 1;
console.log(`  theo lớp: ${JSON.stringify(admittedLayers)}`);
const turnUsed = admitted.map((r) => r.turnUsed).filter((n) => typeof n === 'number');
if (turnUsed.length) {
  console.log(`  turnUsed max: ${Math.max(...turnUsed)} (trần jevMaxCallsPerTurn=4) ⇒ ${Math.max(...turnUsed) > 4 ? 'VƯỢT' : 'chưa bao giờ chạm trần'}`);
}

const groups = new Map();
for (const row of invocations) {
  if (!row.session || !Number.isInteger(row.turn)) continue;
  const key = `${row.session}:${row.turn}`;
  groups.set(key, (groups.get(key) ?? 0) + 1);
}
const histogram = {};
for (const n of groups.values()) histogram[n] = (histogram[n] ?? 0) + 1;
console.log(`\ncall theo (session, turn): ${groups.size} nhóm · max ${Math.max(...groups.values())}`);
console.log('  histogram:', Object.entries(histogram).map(([k, v]) => `${k}→${v}`).join(' '));

// ── 7. Các lớp advisory ───────────────────────────────────────────────────
section('7. Các lớp advisory');
for (const type of ['completion_check', 'quality_review', 'failure_recovery', 'effort_route', 'jev_budget', 'context_budget']) {
  const sub = by(type);
  const d = {};
  for (const row of sub) d[row.decision ?? '(none)'] = (d[row.decision ?? '(none)'] ?? 0) + 1;
  console.log(`${type.padEnd(20)} n=${String(sub.length).padStart(5)}  ${JSON.stringify(d)}`);
}
const fresh = by('effort_route').filter((r) => r.decision === 'applied');
const freshEffort = {};
for (const row of fresh) freshEffort[row.effort] = (freshEffort[row.effort] ?? 0) + 1;
console.log(`\neffort FRESH (không sticky): ${fresh.length}  ${JSON.stringify(freshEffort)}`);

console.log('\n(script chỉ đọc — không sửa gì)\n');

if (ASSERT) {
  if (problems.length === 0) {
    console.log(`ASSERT: ${'TẤT CẢ BẤT BIẾN GIỮ'} (3 bất biến, log ${rows.length} dòng)\n`);
    process.exit(0);
  }
  console.log(`ASSERT: ${problems.length} BẤT BIẾN VỠ\n`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log('');
  process.exit(1);
}
