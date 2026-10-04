/**
 * Chỉ số QUAN SÁT cho gate — đọc `decisions.jsonl` và trả lời câu hỏi mà việc
 * đếm thuần không trả lời được: **gate đang chạy mà có chặn gì không?**
 *
 * ## Vì sao cần
 *
 * Log thật (43.730 dòng, 02/10) cho thấy `destructive_gate` chạy 11.633 lần
 * nhưng chỉ có 113 `deny` — tức gate gần như chỉ tốn một round-trip API để nói
 * "cho qua". Đếm số lần chạy (`total`) không lộ ra điều đó; tỉ lệ deny/total thì
 * lộ ngay. Đây là chỉ số để biết lớp này có đáng tồn tại không, chứ không phải
 * để tối ưu.
 *
 * ## Thiết kế
 *
 * `summarize(records)` là hàm THUẦN: nhận mảng bản ghi đã parse → trả object
 * thống kê. Không đọc file, không đọc giờ, không I/O — nên test offline được mà
 * không phải dựng log thật. CLI ở cuối file chỉ là lớp mỏng đọc file rồi gọi nó.
 *
 * File này KHÔNG được hook vào vòng chạy của plugin: nó chỉ đọc log. Thêm nó
 * vào đường tới hạn sẽ biến một công cụ đo thành overhead — đúng loại lỗi mà cả
 * dự án này sinh ra để tránh.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Loại bản ghi mà gate ghi cho mỗi lần chạy (mọi nhánh đều dùng chung `type`). */
const GATE_TYPE = 'destructive_gate';

/**
 * Nhánh CHẶN — gate trả `kind: 'deny'`, lệnh không chạy.
 *
 * `deny` / `deny_catastrophic`: gate tự phán lệnh phá dữ liệu.
 * `auth_fail_closed`: lệnh ĐÃ bị phán phá dữ liệu, chỉ hỏi thêm quyền user và
 *   lỗi → giữ nguyên hành vi chặn. Vẫn là một lần CHẶN thật, nên tính vào deny;
 *   nếu tách riêng sẽ làm `total = allow + deny + fail_open` không còn đúng và
 *   người đọc log phải tự cộng tay.
 */
const DENY_DECISIONS = new Set(['deny', 'deny_catastrophic', 'auth_fail_closed', 'deny_consent']);

/** Nhánh CHO QUA — kể cả `allow_readonly` (prefilter) và `allow_authorized`. */
const ALLOW_DECISIONS = new Set(['allow', 'allow_readonly', 'allow_authorized', 'allow_consented']);

const round4 = (value) => Math.round(value * 10_000) / 10_000;

/**
 * Thống kê `destructive_gate` từ một mảng bản ghi đã parse. THUẦN.
 *
 * `useful_ratio = deny / total` — phần trăm lần gate chạy mà thực sự CHẶN được
 * gì. `0` khi chưa có bản ghi (không trả `NaN`: một chỉ số không có mẫu phải
 * đọc được là "không có dữ liệu", không phải "hỏng").
 *
 * `decisions` giữ phân bố thô để chẩn đoán khi tỉ lệ bất thường (ví dụ
 * `fail_open` tăng vọt ⇒ Jev đang lỗi, không phải gate đang nhạy).
 */
export function summarize(records) {
  const list = Array.isArray(records) ? records : [];
  let total = 0;
  let allow = 0;
  let deny = 0;
  let failOpen = 0;
  let other = 0;
  const decisions = {};

  for (const record of list) {
    if (record === null || typeof record !== 'object') continue;
    if (record.type !== GATE_TYPE) continue;
    total += 1;
    const decision = typeof record.decision === 'string' && record.decision ? record.decision : '(none)';
    decisions[decision] = (decisions[decision] ?? 0) + 1;
    if (DENY_DECISIONS.has(decision)) deny += 1;
    else if (decision === 'fail_open') failOpen += 1;
    else if (ALLOW_DECISIONS.has(decision)) allow += 1;
    else other += 1;
  }

  const usefulRatio = total === 0 ? 0 : deny / total;
  return {
    total,
    allow,
    deny,
    fail_open: failOpen,
    other,
    useful_ratio: round4(usefulRatio),
    gate_useful_ratio: round4(usefulRatio),
    decisions,
  };
}

/**
 * Parse JSONL thành mảng bản ghi, đếm dòng hỏng thay vì ném.
 *
 * Log là append-only và có thể bị cắt giữa dòng khi tiến trình chết; một dòng
 * hỏng không được làm mất toàn bộ số đo. Trả `malformed` để người đọc biết mẫu
 * có sạch không.
 */
export function parseJsonl(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/** Đường dẫn log mặc định — cùng quy tắc với `lib/index.mjs`. */
export function defaultLogPath(env = process.env, home = homedir()) {
  const base = env?.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(base, 'dsh-jev-gate', 'decisions.jsonl');
}

function main() {
  const target = process.argv[2] || defaultLogPath();
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    process.stderr.write(`không đọc được log: ${target} (${error?.code ?? error?.message ?? 'lỗi'})\n`);
    process.exitCode = 1;
    return;
  }
  const { records, malformed } = parseJsonl(text);
  const stats = summarize(records);
  process.stdout.write(`${JSON.stringify(malformed ? { ...stats, malformed } : stats)}\n`);
}

/**
 * Chạy CLI khi file được gọi trực tiếp (`node lib/metrics.mjs`), không chạy khi
 * được `import` từ test.
 */
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) main();
