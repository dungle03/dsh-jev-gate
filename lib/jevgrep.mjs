/**
 * jevgrep — cầu nối từ jev-gate sang CLI `jg`.
 *
 * Vì sao có file này: Lớp 5 của plugin liệt kê ứng viên file bằng CÁCH ĐỌC TÊN
 * (readdir BFS + khớp token). Đo trên session thật `777a1746`: Lớp 5 hint
 * `weknora-dsh-setup-guide.md` ở 4 turn liên tiếp, và agent **không đọc file đó
 * một lần nào** (0/4). Tên file không đủ để model tin. `jg` trả về đúng thứ còn
 * thiếu — **nội dung verbatim** của file/hàm liên quan — nên nó thay được phần
 * yếu này thay vì chồng thêm một lớp mới.
 *
 * Ràng buộc thiết kế (giống mọi lớp khác của jev-gate):
 *
 *   1. FAIL-OPEN. `jg` thiếu, lỗi, timeout, hay trả rác → trả `undefined`, và
 *      việc đi tiếp như chưa từng có jevgrep. Không bao giờ ném lỗi ra ngoài.
 *   2. KHÔNG chặn. Module này chỉ chạy `jg` (đọc, không ghi file người dùng) và
 *      trả text để lớp gọi tự quyết định chèn hay không.
 *   3. KHÔNG hỏi credential trong chat. `jg` dùng credential đã lưu ở
 *      `~/.config/jevgrep/credentials.json`; module này không đọc file đó, chỉ
 *      chạy `jg` và để nó tự xử lý. Thiếu credential → `jg` báo lỗi → fail-open.
 *
 * `jg` là CLI, KHÔNG export module (`dist/` chỉ có `bin/index.js` +
 * `python-worker.mjs`), nên bắt buộc phải spawn tiến trình con.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { truncateText } from './policy.mjs';

/** Trần ký tự của đoạn trích chèn vào context. `jg` có thể trả cả file dài. */
export const DEFAULT_EXCERPT_CAP = 4_000;

/** Timeout mặc định cho một lần `jg`. Đo thật: ấm ~0.9s, nguội ~2.6s. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * `jg` có trên PATH không — dò một lần rồi nhớ.
 *
 * Quét thẳng các thư mục trong `PATH` bằng `fs`, KHÔNG qua shell.
 *
 * Bản đầu dùng `spawn('command', ['-v', 'jg'], { shell: true })`. Chạy đúng, và
 * không có injection vì mọi tham số là hằng — nhưng nó vẫn là một **interpreter
 * sink**: đẩy chuỗi qua shell để hỏi một câu mà hệ thống file trả lời được. Quét
 * `PATH` bỏ hẳn shell, bỏ một tiến trình con, và cho kết quả tất định.
 *
 * `jg` khai `os: [darwin, linux]` nên không cần xử lý `PATHEXT` của Windows.
 *
 * Kết quả `null` = chưa dò; `false` = đã dò và không có.
 */
let availableCache = null;

export function resetAvailabilityCache() {
  availableCache = null;
}

export async function isJevgrepAvailable() {
  if (availableCache !== null) return availableCache;
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const checks = dirs.map(async (dir) => {
    try {
      await access(join(dir, 'jg'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  availableCache = (await Promise.all(checks)).some(Boolean);
  return availableCache;
}

/**
 * Chạy `jg "<question>" [root]` và trả output thô.
 *
 * Trả `{ ok: true, text }` hoặc `{ ok: false, error }`. Không bao giờ ném.
 * `signal` của hook được truyền xuống để một turn bị huỷ thì tiến trình con chết
 * theo, không để lại orphan giữ CPU.
 */
export function runJevgrep({
  question,
  root,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  maxBuffer = 256 * 1024,
} = {}) {
  return new Promise((resolve) => {
    if (typeof question !== 'string' || !question.trim()) {
      resolve({ ok: false, error: 'empty question' });
      return;
    }
    if (signal?.aborted) {
      resolve({ ok: false, error: 'aborted' });
      return;
    }

    const args = ['--', question.trim()];
    if (typeof root === 'string' && root.trim()) args.push(root);

    let child;
    try {
      child = spawn('jg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    /** Giữ handle để `finish` gỡ được, mà không vướng tham chiếu vòng. */
    let timer;
    let onAbort;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* đã chết */ }
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* đã chết */ }
      finish({ ok: false, error: 'aborted' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        try { child.kill('SIGKILL'); } catch { /* đã chết */ }
        finish({ ok: false, error: 'output too large' });
      }
    });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2_000) stderr += chunk; });
    child.on('error', (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : 'spawn error' });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: `jg exited ${code}${stderr.trim() ? `: ${truncateText(stderr.trim(), 200)}` : ''}` });
        return;
      }
      finish({ ok: true, text: stdout });
    });
  });
}

/**
 * Bóc output của `jg` thành danh sách file + đoạn trích verbatim.
 *
 * Định dạng thật (đã chạy để lấy mẫu):
 *
 *   Jevgrep: 2 relevant files.
 *   AGENTS.md lookup (root and returned-file ancestors): none found.
 *   - "handler.js" — implementation, caller, helper; selected source ...
 *     Reading lead handle: lines 2-2
 *   - "auth.js" — helper; selected source ...
 *   End file list.
 *
 *   Source block "handler.js" lines 1-3:
 *   1: import ...
 *   End context.
 *
 * Parser KHÔNG được cứng theo định dạng này: nếu `jg` đổi format, ta vẫn muốn
 * lấy được phần "Source block" thay vì mất trắng. Nên đọc theo dấu hiệu, và có
 * đường lui là trả nguyên văn khi không nhận ra gì.
 *
 * Trả `undefined` khi output rỗng hoặc không có dấu hiệu nội dung nào.
 */
export function parseJevgrepOutput(text, cap = DEFAULT_EXCERPT_CAP) {
  if (typeof text !== 'string') return undefined;
  const raw = text.trim();
  if (!raw) return undefined;

  const files = [];
  const blocks = [];
  let current = null;

  for (const line of raw.split('\n')) {
    // `- "path" — mô tả` : dòng đầu của một file trong danh sách.
    const fileMatch = /^-\s+"(.+?)"\s*(?:—|-|:)\s*(.*)$/.exec(line);
    if (fileMatch) {
      files.push({ path: fileMatch[1], role: fileMatch[2].trim() });
      continue;
    }
    // `Source block "path" lines A-B:` : mở một khối trích nguồn verbatim.
    const blockMatch = /^Source block\s+"(.+?)"\s+lines\s+(\d+)-(\d+)\s*:?\s*$/.exec(line);
    if (blockMatch) {
      if (current) blocks.push(current);
      current = { path: blockMatch[1], from: Number(blockMatch[2]), to: Number(blockMatch[3]), lines: [] };
      continue;
    }
    if (current) {
      if (/^End context\.?$/.test(line.trim())) {
        blocks.push(current);
        current = null;
        continue;
      }
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  if (!files.length && !blocks.length) return undefined;

  const parts = [];
  for (const block of blocks) {
    const body = block.lines.join('\n').replace(/\s+$/, '');
    if (!body) continue;
    parts.push(`--- ${block.path} (lines ${block.from}-${block.to}) ---\n${body}`);
  }

  const excerpt = parts.length ? truncateText(parts.join("\n\n"), cap) : undefined;
  return { files, blocks, excerpt };
}

/**
 * Đoạn text này có phải một yêu cầu "tìm X nằm ở đâu" không.
 *
 * Dùng để quyết định có leo thang sang `jg` hay không. Đây là tiền lọc rẻ và cố
 * ý RỘNG — thà chạy `jg` thừa một lần còn hơn bỏ sót đúng ca cần. Từ khoá bám
 * theo chính mô tả skill `jevgrep` (chỗ nào / tìm file nào / where is / which
 * file / trace / locate).
 */
const SEARCH_TASK_PATTERNS = [
  /(?:^|[\s(])(?:chỗ nào|cho nao|ở đâu|o dau|nằm ở đâu|nam o dau)(?:[\s),.?]|$)/iu,
  /(?:^|[\s(])(?:tìm|tim)\b[^.\n]{0,40}\b(?:file|hàm|function|code|chỗ|logic|đâu)/iu,
  /(?:^|[\s(])(?:where|which file|what file|locate|find the code|trace)\b/iu,
  /(?:^|[\s(])(?:file nào|file nao|hàm nào|ham nao)\b/iu,
  /\b(?:implements?|handles?|xử lý|xu ly)\b[^.\n]{0,30}\b(?:ở đâu|where|file nào)\b/iu,
];

export function looksLikeSearchTask(task) {
  if (typeof task !== 'string' || !task.trim()) return false;
  const text = task.slice(0, 2_000);
  return SEARCH_TASK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Lệnh này có phải một lệnh DÒ TÌM thô (grep/find/rg/ack/ag) không.
 *
 * Dùng để phát hiện "vòng xoáy grep": agent chạy nhiều lệnh dò tìm liên tiếp mà
 * không tiến triển. Đo trên session `777a1746`: 152 lệnh dò tìm thô, 0 lần `jg`.
 */
const RAW_SEARCH_PATTERN = /(?<![\p{L}\p{N}_])(?:grep|rg|ripgrep|find|ack|ag)(?![\p{L}\p{N}_])/iu;

export function isRawSearchCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  return RAW_SEARCH_PATTERN.test(command);
}

/**
 * Dựng câu hỏi cho `jg` từ task của user.
 *
 * `jg` nhận MÔ TẢ HÀNH VI, không phải từ khoá — và task của user vốn đã là mô tả
 * hành vi. Nên việc duy nhất cần làm là gộp khoảng trắng và cắt trần. Cố ý KHÔNG
 * cắt đuôi mệnh lệnh ("... rồi sửa lại cho tôi"): regex đoán đuôi rất dễ cắt mất
 * phần mang nghĩa, mà lợi ích gần bằng không vì `jg` đọc cả câu.
 */
export function buildJevgrepQuestion(task, cap = 500) {
  if (typeof task !== 'string') return '';
  return truncateText(task.replace(/\s+/g, ' ').trim(), cap);
}
