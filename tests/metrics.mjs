import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl, readLogWithRotated, summarize } from '../lib/metrics.mjs';

const stats = summarize([
  { type: 'destructive_gate', decision: 'deny_outage', fixture: true },
  { type: 'destructive_gate', decision: 'allow', label: false },
  { type: 'destructive_gate', decision: 'deny_consent' },
]);
assert.equal(stats.total, 3);
assert.equal(stats.deny, 2);
assert.equal(stats.allow, 1);
assert.equal(stats.unlabeled, 2);
assert.equal(stats.canary, 1);
assert.equal(stats.useful_ratio, 0.6667);

/**
 * `readLogWithRotated` phải đọc CẢ thế hệ đã xoay.
 *
 * `makeRecorder` xoay `decisions.jsonl` → `.1` khi vượt trần byte. Nếu lớp đọc
 * chỉ đọc file sống thì số đo ÂM THẦM mất dữ liệu cũ đúng lúc xoay — và tệ hơn,
 * một operation mở ở `.1` mà đóng ở file sống sẽ trông như "rò", làm bất biến
 * vòng đời vỡ vì lý do nhân tạo.
 */
const dir = mkdtempSync(join(tmpdir(), 'jev-metrics-'));
try {
  const live = join(dir, 'decisions.jsonl');
  const rotated = `${live}.1`;

  // Chưa xoay: chỉ có file sống.
  writeFileSync(live, '{"type":"a","n":1}\n');
  assert.equal(
    parseJsonl(readLogWithRotated(live)).records.length, 1,
    'chưa xoay ⇒ chỉ đọc file sống, thiếu `.1` KHÔNG phải lỗi',
  );

  // Đã xoay: `.1` giữ dòng CŨ, file sống giữ dòng MỚI — thứ tự thời gian phải giữ.
  writeFileSync(rotated, '{"type":"a","n":1}\n{"type":"a","n":2}\n');
  writeFileSync(live, '{"type":"a","n":3}\n');
  const { records, malformed } = parseJsonl(readLogWithRotated(live));
  assert.equal(malformed, 0);
  assert.deepEqual(records.map((r) => r.n), [1, 2, 3], '`.1` đọc TRƯỚC file sống');

  // Bất biến then chốt: một operation mở ở `.1` và đóng ở file sống phải ghép được.
  writeFileSync(rotated, '{"type":"cost_governor","operation_id":"op1","kind":"start"}\n');
  writeFileSync(live, '{"type":"cost_governor","operation_id":"op1","kind":"finish"}\n');
  const ops = parseJsonl(readLogWithRotated(live)).records.filter((r) => r.operation_id === 'op1');
  assert.equal(ops.length, 2, 'operation xuyên thế hệ xoay phải thấy đủ hai đầu');
  assert.deepEqual(ops.map((r) => r.kind), ['start', 'finish']);

  // Lỗi đọc THẬT phải nổi lên, không bị nuốt như "chưa có file".
  mkdirSync(join(dir, 'a-directory.jsonl'));
  assert.throws(
    () => readLogWithRotated(join(dir, 'a-directory.jsonl')),
    (error) => error.code === 'EISDIR',
    'EACCES/EISDIR là lỗi thật — không được coi là "chưa có log"',
  );

  // Thiếu CẢ HAI thế hệ phải ném ENOENT: "chưa có log" ≠ "log rỗng". Nuốt lỗi ở
  // đây sẽ khiến CLI báo `total: 0` cho một đường dẫn gõ sai — đọc ra như "gate
  // chưa từng chạy".
  assert.throws(
    () => readLogWithRotated(join(dir, 'khong-ton-tai.jsonl')),
    (error) => error.code === 'ENOENT',
    'không có file nào ⇒ ENOENT, không trả chuỗi rỗng',
  );
  // Nhưng chỉ có `.1` (file sống chưa tạo) vẫn phải đọc được.
  const onlyRotated = join(dir, 'only-rotated.jsonl');
  writeFileSync(`${onlyRotated}.1`, '{"type":"a","n":7}\n');
  assert.deepEqual(
    parseJsonl(readLogWithRotated(onlyRotated)).records.map((r) => r.n), [7],
    'chỉ có `.1` ⇒ vẫn đọc được (không phải ENOENT)',
  );

  // File không đọc được (quyền) cũng phải nổi lên.
  if (process.getuid?.() !== 0) {
    const locked = join(dir, 'locked.jsonl');
    writeFileSync(locked, '{"type":"a"}\n');
    chmodSync(locked, 0o000);
    assert.throws(
      () => readLogWithRotated(locked),
      (error) => error.code === 'EACCES',
      'EACCES phải nổi lên',
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('metrics: PASS');
