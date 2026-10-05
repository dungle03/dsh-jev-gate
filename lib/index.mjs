/**
 * dsh-jev-gate — đưa Jev vào ba khoảnh khắc đắt giá của DSH.
 *
 * Triết lý (đúng như đã thống nhất):
 *   LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
 *   định sai gây tốn kém: cái này có nguy hiểm không, việc này xong chưa, có
 *   bằng chứng chưa, bước tiếp theo cần nghĩ nhiều không.
 *
 * Các lớp advisory có thể bỏ qua khi Jev lỗi; gate phá dữ liệu thì không.
 * Lớp 1 theo `gateFailureMode` (mặc định `ask`): khi Jev không trả lời, hỏi
 * user qua thẻ đồng ý và chặn nếu không có đồng ý thật. Sàn catastrophic
 * tất định còn được áp qua guard monotonic sau mọi pre-execute listener.
 */

import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createJev, describeError } from './jev-client.mjs';
import { isProvablyReadOnly } from './readonly.mjs';
import { catastrophicMatch } from './catastrophic.mjs';
import { resolveProfile } from './profiles.mjs';
import { collectFileEvidence, wrapRepositoryEvidence } from './evidence.mjs';
import { createJevgrepControl, keepBoundedHint, admitRepositoryHint } from './jevgrep-control.mjs';
import { planInjection, CONTEXT_PRIORITY, dedupeInjection, fingerprintOf } from './injection.mjs';
import {
  clip,
  completionQuestion,
  destructiveQuestion,
  effortAbstainQuestion,
  effortQuestion,
  EFFORT_MEANING,
  effortFloorFromSignals,
  effortRank,
  mapEffortAbstain,
  preStepQuestion,
  failureQuestion,
} from './policy.mjs';
import {
  buildJevgrepQuestion,
  isJevgrepAvailable,
  isRawSearchCommand,
  looksLikeSearchTask,
  parseJevgrepOutput,
  runJevgrep,
} from './jevgrep.mjs';

export const name = 'jev-gate';

/**
 * Producer-owned message source kind (session format v4).
 *
 * DSH v4 retired the bare string / `kind: 'plugin'` source pair: every producer
 * declares its own kind, and a plugin's kind is exactly `plugin:<name>`. The
 * value below is what DSH's own v3→v4 migration derives for rows written under
 * the old string form, so old and new logs read back under one shape.
 */
export const SOURCE_KIND = 'plugin:jev-gate';
/**
 * `llm` là BẮT BUỘC cho lớp effort: `supportedEffortsOf` gọi
 * `ctx.llm.resolveModelInfo(provider, model)` để biết model nhận những mức
 * reasoning nào. Thiếu nó thì `ctx.llm` là undefined và lớp effort im lặng
 * bỏ qua mọi step (log `skip_no_levels`) — đã từng xảy ra thật và chỉ phát
 * hiện được nhờ đọc `decisions.jsonl` sau khi chạy DSH thật.
 */
export const inject = ['tools', 'credentials', 'llm'];

/**
 * Thư mục log mặc định, tính một lần lúc nạp module.
 *
 * Có thể ghi đè qua config `logDir` — đó là đường để TEST cô lập: test nạp
 * `apply()` với một thư mục tạm, nên log kiểm định không lẫn vào log quyết định
 * thật của người dùng. Trước đây test và DSH thật ghi chung một file, làm mọi
 * số đo trên log phải lọc tay mới tách được.
 */
const DEFAULT_LOG_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'dsh-jev-gate');

/**
 * Ngưỡng mặc định, tách theo hậu quả của việc đoán sai (không dùng một số chung).
 *
 * `enableEffortRouting` BẬT sau khi đo cache thật trên máy này (2026-09-27).
 *
 * Phép đo: gửi cùng một prefix ~18k token qua nine-router tới cx/gpt-6-astra,
 * đổi effort giữa các lần, đọc `cached_tokens` từ streaming response.
 *   - Lần đầu chạm (prefix mới, effort mới): 0 HIT / 9 lần
 *   - Lần chạm thứ hai cùng cặp đó:          8 HIT / 9 lần
 *   - Đổi effort qua lại nhiều vòng:         HIT liên tục
 * Kết luận: đổi effort KHÔNG xoá cache của các effort khác. Cache được giữ
 * riêng theo (prefix, effort); chi phí thật chỉ là lần ĐẦU TIÊN chạm một
 * effort mới thì cold — tốn đúng bằng cold của một prefix mới (13.002 input
 * token thay vì 12.800 cache trong lần đo).
 *
 * Vì lease tối thiểu là 1 generation và mức effort chỉ đổi vài lần mỗi task,
 * số lần cold này nhỏ so với số generation tiết kiệm được reasoning token.
 * Chi tiết số đo: ~/.dsh/notes/jev-gate.md
 */
/**
 * Lời khuyên cho từng hướng tiếp cận. Viết bằng lời để model đọc và tự quyết,
 * không phải mệnh lệnh. Mỗi hướng phải nói rõ CÁCH LÀM, không chỉ nhãn.
 */
const APPROACH_ADVICE = {
  'one-command-scan':
    'One command already answers this, so run that single command and read its output directly '
    + 'instead of splitting the work across several steps or workers.',
  'scripted-analysis':
    'A short purpose-built script is the right tool here — write one script that walks the tree or '
    + 'ranks the candidates, then read its result, rather than issuing many separate commands.',
  'parallel-workers':
    'The work splits into independent areas, so consider delegating them with the `subagent` tool '
    + 'so they run in parallel instead of working through them one by one.',
  'guided-interview':
    'The request looks ambiguous, so confirm what the user actually wants before acting rather '
    + 'than guessing at the target.',
};

/**
 * Lời khuyên cho từng hướng phục hồi. Bốn tình huống khác nhau về bản chất nên
 * lời khuyên cũng phải khác về hành động, không chỉ khác nhãn.
 */
const RECOVERY_ADVICE = {
  retry:
    'This looks transient, so run the same call again once. If it fails the same way, treat it as '
    + 'a real failure and change approach instead of retrying again.',
  alternate:
    'The approach itself looks wrong, so change it: use a different tool, flag, path, or method '
    + 'rather than repeating the same call.',
  diagnose:
    'The cause is not yet known, so find out before acting again — read the source, the config, or '
    + 'the log that explains this failure.',
  'stop-and-report':
    'This is not something you can resolve alone, so stop and tell the user what is missing or '
    + 'what decision you need from them.',
};

/**
 * Bảng phân loại TẤT ĐỊNH cho các lỗi tool ĐÃ BIẾT — chạy TRƯỚC khi hỏi Jev.
 *
 * ## Vì sao (đo được)
 *
 * Phần lớn lỗi tool rơi vào một số lớp nhỏ mà cách xử lý đã rõ từ chính mã lỗi.
 * Hỏi Jev cho những ca đó là một round-trip thuần lãng phí, và tệ hơn: Jev có
 * thể khuyên `retry` cho một lỗi tất định (thiếu file, sai cú pháp) — đúng vòng
 * xoáy retry mà Lớp 6 sinh ra để chặn.
 *
 * ## Bảng (theo báo cáo §9, giữ nguyên thứ tự ưu tiên)
 *
 *   ETIMEDOUT / ECONNRESET  → retry      (lỗi tầng vận chuyển, có thể tạm thời)
 *   ENOENT                  → alternate  (đường dẫn/tên lệnh sai ⇒ đổi cách)
 *   EADDRINUSE              → alternate  (cổng đã bị chiếm ⇒ đổi cổng/cách)
 *   permission denied       → diagnose   (phải biết VÌ SAO trước khi làm lại)
 *   syntax error            → alternate  (cách viết sai ⇒ sửa cách)
 *
 * Ca nhập nhằng trong báo cáo ("diagnose/alternate", "stop/diagnose") được chốt
 * một nhãn để hành vi tất định: ENOENT/syntax ⇒ `alternate` (nguyên nhân đã rõ,
 * chỉ cần đổi cách), permission ⇒ `diagnose` (nguyên nhân chưa rõ: ai/đâu chặn).
 * `stop-and-report` KHÔNG bao giờ được suy ra tất định — dừng việc là quyết định
 * của agent, không phải của một regex.
 *
 * Lỗi KHÔNG khớp bảng nào rơi xuống đúng đường cũ: hỏi Jev (`ambiguous tail`).
 */
const DETERMINISTIC_FAILURES = [
  {
    recovery: 'retry',
    label: 'transient network/timeout',
    // Tầng vận chuyển: cùng lời gọi có thể thành công ở lần sau.
    pattern: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ENOTFOUND|socket hang up|connection reset|timed? ?out|timeout/i,
  },
  {
    recovery: 'alternate',
    label: 'missing path or command',
    pattern: /ENOENT|no such file or directory|command not found|not recognized as an internal or external command|is not recognized/i,
  },
  {
    recovery: 'alternate',
    label: 'address already in use',
    pattern: /EADDRINUSE|address already in use|port .{0,40}already in use/i,
  },
  {
    recovery: 'alternate',
    label: 'syntax error',
    pattern: /SyntaxError|syntax error|Unexpected token|unexpected end of (?:input|file)|parse error/i,
  },
  {
    recovery: 'diagnose',
    label: 'permission denied',
    pattern: /EACCES|EPERM|permission denied|operation not permitted|access is denied/i,
  },
];

/**
 * Phân loại tất định một lỗi tool. Trả `{ recovery, label }` khi khớp một lớp đã
 * biết, `undefined` khi phải hỏi Jev.
 *
 * THUẦN: không mạng, không state — export để test chạm thẳng bảng (cùng lý do
 * `evictOldest` được export).
 */
export function classifyDeterministicFailure(errorText, { toolName, command } = {}) {
  const text = typeof errorText === 'string' ? errorText : '';
  if (!text) return undefined;
  // Lỗi do chính plugin này sinh (gate chặn, consent từ chối) đã được xử lý
  // riêng ở handler — không bao giờ phân loại chúng ở đây.
  if (/JEV_[A-Z_]+/.test(text)) return undefined;
  for (const entry of DETERMINISTIC_FAILURES) {
    if (entry.pattern.test(text)) return { recovery: entry.recovery, label: entry.label };
  }
  return undefined;
}

/**
 * Chữ ký chuẩn hoá của một lần thất bại: `(tool, dạng lệnh, dấu vân tay lỗi)`.
 *
 * Dùng để nhận ra "cùng một lỗi lặp lại" — thứ mà `retry` không bao giờ giải
 * quyết được. Chuẩn hoá để hai lần lỗi giống nhau về BẢN CHẤT nhưng khác chi
 * tiết (số dòng, đường dẫn, tham số) vẫn cho cùng một chữ ký:
 *
 *   - tool: hạ chữ thường.
 *   - dạng lệnh: tên chương trình (bỏ thư mục) + tập cờ đã sắp xếp. Bỏ tham số
 *     cụ thể, vì `npm run deploy --env a` và `... --env b` là cùng một vòng xoáy.
 *   - dấu vân tay lỗi: hạ chữ thường, thay chuỗi trong nháy, đường dẫn và mọi số
 *     bằng ký hiệu trung tính, gộp khoảng trắng, cắt 160 ký tự. Đường dẫn bị thay
 *     vì cùng một lớp lỗi trên hai file khác nhau (`ENOENT /a` rồi `ENOENT /b`)
 *     vẫn là CÙNG một vòng xoáy: `retry` không cứu được cả hai.
 *
 * THUẦN: export để test.
 */
export function failureSignatureOf(toolName, command, errorText) {
  const tool = String(toolName ?? '').toLowerCase();
  const tokens = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const program = (tokens[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase();
  const flags = tokens.slice(1).filter((token) => token.startsWith('-')).sort().join(' ');
  const fingerprint = String(errorText ?? '')
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@+-]+)+/gi, '/…')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${tool}|${program} ${flags}|${fingerprint}`;
}

/**
 * Dấu vân tay của một task, dùng để biết kết quả `jg` chạy nền còn hợp lệ không.
 *
 * ## Vì sao (đo được)
 *
 * `jg` chạy nền có thể xong SAU khi user đã đổi task. Query A "authentication
 * middleware nằm ở đâu" chạy nền; user chuyển sang "debug billing webhook"; kết
 * quả A xong rồi bị chèn vào turn mới ⇒ context SAI + anchoring noise. Gợi ý
 * "đọc file X" của một task khác không hữu ích ở turn sau — nó kéo agent lệch
 * hướng.
 *
 * Chuẩn hoá trước khi băm để hai cách viết cùng một task cho cùng vân tay:
 * hạ chữ thường, bỏ dấu câu, gộp khoảng trắng. Trả `hash:prefix` — hash để so
 * bằng, prefix để đọc log mà biết nó thuộc task nào.
 *
 * THUẦN: export để test.
 */
export function taskFingerprint(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // FNV-1a 32-bit: đủ tách các task khác nhau, không cần crypto.
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${normalized.slice(0, 48)}`;
}

/**
 * Gốc workspace để liệt kê ứng viên file.
 *
 * `agent/pre-step` có `agent` (engine fuse `agent` vào mọi payload agent-scoped —
 * `dsh-agent/lib/index.js:242`), nhưng vẫn nhận `session` làm nguồn dự phòng vì
 * hook này chạy trước tool đầu tiên của turn. `session.header.cwd` là cách core
 * lấy cwd (`dsh-tool-fs/lib/index.js:174`).
 */
function workspaceRootOf(agent, session) {
  return agent?.session?.header?.cwd
    ?? agent?.cwd
    ?? session?.header?.cwd
    ?? process.cwd();
}

/**
 * Turn hiện tại của agent, dùng để giới hạn số lần phục hồi mỗi turn.
 *
 * `tools/post-execute` không mang `turn` trong payload (chỉ `exec` + `result`),
 * nên đọc từ session event gần nhất có `turn`.
 */
function currentTurnOf(agent) {
  const events = sessionEvents(agent?.session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turn = dataOf(events[index]).turn;
    if (Number.isSafeInteger(turn)) return turn;
  }
  return -1;
}

/** Tên file/thư mục không bao giờ hữu ích làm ngữ cảnh cho một task. */
const IGNORED_ENTRIES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', 'coverage', '.next', '.nuxt', '.cache', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.idea', '.vscode', '.DS_Store',
]);

/** Đuôi file ưu tiên: tài liệu định hướng mà model hay cần đọc trước. */
const PRIORITY_NAMES = [
  'README.md', 'README', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'Makefile', 'Dockerfile', 'tsconfig.json',
];

/** Token quá phổ biến để dùng làm tín hiệu khớp tên file. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'file', 'files',
  'code', 'task', 'when', 'then', 'than', 'them', 'they', 'have', 'has', 'was',
  'are', 'not', 'but', 'you', 'your', 'all', 'any', 'can', 'should', 'would',
  'sua', 'sửa', 'them', 'thêm', 'trong', 'cho', 'cua', 'của', 'voi', 'với',
  'mot', 'một', 'cac', 'các', 'nay', 'này', 'khi', 'lam', 'làm', 'duoc', 'được',
]);

/**
 * Liệt kê ứng viên file cho Lớp 5 — chỉ đọc TÊN, không đọc nội dung.
 *
 * Mục tiêu là giảm token đầu vào, nên việc liệt kê phải rẻ và phải THẬT SỰ chứa
 * file liên quan. Bản đầu chỉ đào hai tầng, và đo trên workspace thật thì bỏ sót
 * `src/auth/session.ts` (tầng 3) — trong khi `src/<module>/<file>` là cấu trúc
 * phổ biến nhất của mọi repo. Giờ duyệt theo chiều rộng tới `depth` tầng, có
 * trần số thư mục mở, và XẾP HẠNG ứng viên trước khi cắt:
 *
 *   1. tên file khớp token trong task (task nói "session" → ưu tiên `session.ts`)
 *   2. file định hướng (README, package.json, ...)
 *   3. nông hơn thì ưu tiên hơn
 *
 * Xếp hạng ở đây chỉ để chọn ra `limit` ứng viên đáng chấm nhất; Jev vẫn là thứ
 * quyết định file nào cần đọc. Đây là tiền lọc rẻ, không phải phán đoán.
 *
 * Không bao giờ ném lỗi: thư mục không đọc được thì trả [] và Lớp 5 tự tắt.
 */
async function listCandidateFiles(root, limit, task = '', depth = 4, maxDirs = 60) {
  const tokens = tokenize(task);
  const files = [];
  const queue = [{ dir: root, level: 0 }];
  let dirsOpened = 0;

  while (queue.length && dirsOpened < maxDirs) {
    const { dir, level } = queue.shift();
    dirsOpened += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_ENTRIES.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isFile()) {
        files.push({ absolute, level });
      } else if (entry.isDirectory() && level + 1 < depth) {
        queue.push({ dir: absolute, level: level + 1 });
      }
    }
  }

  const score = (file) => {
    const path = relative(root, file.absolute).toLowerCase();
    const base = path.split('/').pop() ?? '';
    let value = 0;
    for (const token of tokens) {
      if (base.includes(token)) value += 100;
      else if (path.includes(token)) value += 40;
    }
    if (PRIORITY_NAMES.some((name) => name.toLowerCase() === base)) value += 30;
    return value - file.level;
  };

  return files
    .sort((a, b) => score(b) - score(a) || a.absolute.localeCompare(b.absolute))
    .slice(0, limit)
    .map((file) => relative(root, file.absolute));
}

/** Token dài >=3 ký tự, đã bỏ stopword — tín hiệu khớp tên file. */
function tokenize(text) {
  return [...new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}
const DEFAULTS = {
  destructiveThreshold: 0.7,
  completionThreshold: 0.5,
  evidenceThreshold: 0.5,
  executionThreshold: 0.5,
  /**
   * Lớp 4 — ngưỡng lùi dựa trên `confidence` của câu `approach` (chỉ dùng khi
   * response KHÔNG kèm `probabilities`).
   *
   * Đo trên 10 case đã biết đáp án: `confidence` KHÔNG tương quan với đúng/sai
   * (case đúng conf 0.24, case sai conf 0.44), nên nó chỉ là lưới an toàn chứ
   * không phải bộ lọc. Cổng chính là `approachTopProbability` +
   * `approachProbabilityMargin` bên dưới, dùng phân phối giữa các nhánh.
   */
  approachConfidenceThreshold: 0.3,
  /**
   * Lớp 4 — ngưỡng ĐỈNH của phân phối để dám chèn gợi ý approach.
   *
   * Chỉ chèn khi nhánh thắng có xác suất >= ngưỡng này VÀ bỏ xa nhì
   * `approachProbabilityMargin`. Ví dụ trong bản thiết kế: parallel .86 /
   * script .22 / one .10 → chèn; .48 / .43 / .39 → im lặng. Triết lý: "không
   * chắc thì đừng bias model chính" — gợi ý sai ở step 1 neo model vào hướng
   * sai, tệ hơn không gợi ý.
   */
  approachTopProbability: 0.5,
  /**
   * Lớp 4 — khoảng cách tối thiểu giữa đỉnh và nhì để coi là "thắng rõ".
   * Cùng với `approachTopProbability` tạo thành cổng bằng chứng; thấp hơn thì
   * im lặng thay vì chèn một hướng gần như đoán bừa.
   */
  approachProbabilityMargin: 0.15,
  contextFileThreshold: 0.6,
  contextCandidateLimit: 12,
  contextMaxFiles: 3,
  /**
   * §8: kèm ĐOẠN TRÍCH THẬT của file vào câu hỏi Lớp 5 (imports/exports/dòng
   * khớp task) thay vì chỉ đưa tên. Chỉ có tác dụng khi `enableContextTriage`
   * bật. Tắt để quay về hành vi "đoán theo tên" cũ (để A/B).
   */
  contextEvidence: true,
  /**
   * §22: trần token văn bản plugin chèn vào context MỖI TURN (≈ chars/4). Các
   * lớp 4/5/6/7/8 đều chèn text; không có trần thì một turn dài cộng dồn thành
   * hàng nghìn token nhiễu. An toàn/consent/real-user KHÔNG bao giờ bị cắt.
   */
  maxPluginContextTokensPerTurn: 500,
  failureMaxPerTurn: 2,
  /**
   * Trần số lần Lớp 2 chạy trên CÙNG một turn.
   *
   * Đo trên log thật: một turn (turn=9) fire **16 lần liên tiếp**, lần nào Jev
   * cũng trả `complete=0.1`, và **không lần nào accept** — chỉ tốn tiền và chèn
   * 16 lời nhắc giống nhau vào context. Lớp 6 có `failureMaxPerTurn`, Lớp 7 có
   * `reviewMaxPerTurn`, nhưng Lớp 2 không có trần nào.
   *
   * Trần này KHÔNG cản tiến độ thật: khoá dedup là `agentId:turn`, nên turn
   * mới luôn là khoá mới và vẫn được kiểm bình thường. Nó chỉ cắt việc fire
   * lặp trên đúng một turn đang đứng yên.
   */
  completionMaxPerTurn: 2,
  /**
   * §16 — NGÂN SÁCH JEV DÙNG CHUNG THEO TURN/SESSION (mặc định 4/turn, 100/session).
   *
   * Vì sao cần: mỗi lớp đều có trần RIÊNG (`failureMaxPerTurn`,
   * `completionMaxPerTurn`, `reviewMaxPerTurn`, `jevGrepMaxPerTurn`), nhưng KHÔNG
   * có trần nào cho TỔNG số call Jev của một turn/session. Một turn dài có thể
   * cộng dồn: 1 effort + N recovery + 2 completion + review + jevgrep… Mỗi call
   * 250–500 ms nằm trên đường tới hạn, nên tổng overhead vượt xa latency mà nó
   * tiết kiệm được. Đây là trần TỔNG, bổ sung cho các trần theo-lớp (không thay
   * thế chúng).
   *
   * THỨ TỰ ƯU TIÊN (theo §16): safety > completion > failure recovery > effort
   * routing > advisory. Ngân sách cạn thì cắt từ dưới lên: advisory im lặng
   * trước, effort sau, rồi tới recovery/completion. **Lớp safety (destructive
   * gate) KHÔNG BAO GIỜ bị cắt** — nó vẫn chạy kể cả khi ngân sách đã cạn; nếu
   * không, hết tiền lại thành mở cửa cho lệnh nguy hiểm, đúng thứ plugin này
   * sinh ra để chặn. Safety cũng KHÔNG tiêu trần không-safety: gate chạy mọi
   * lệnh shell, tính chung thì một turn nhiều lệnh sẽ ăn hết ngân sách của
   * completion/effort (đã đo `turnUsed` tới 29 với trần 4).
   *
   * Các lớp TẤT ĐỊNH (Lớp 1 prefilter/floor, Lớp 3 `deterministic`, bộ phân loại
   * lỗi đã biết ở Lớp 6) vốn KHÔNG gọi Jev nên không bị ngân sách ảnh hưởng —
   * "lớp tất định = 0 call Jev" vẫn đúng.
   *
   * Đặt `jevMaxCallsPerTurn`/`jevMaxCallsPerSession` = 0 để tắt hẳn Jev cho các
   * lớp không-safety; `jevBudgetEnabled: false` để gỡ hoàn toàn cơ chế (mọi lớp
   * trở lại hành vi cũ).
   */
  jevBudgetEnabled: true,
  jevMaxCallsPerTurn: 4,
  jevMaxCallsPerSession: 100,
  maxDecisionCostPerTurn: 16,
  maxDecisionCostPerSession: 120,
  reviewMaxPerSession: 20,
  jevGrepMaxPerSession: 10,
  /**
   * Lớp 3 — mức effort mặc định khi turn trước sạch (không có tín hiệu thất bại).
   *
   * Vì sao mặc định THẤP: đo trên 120 request liên tiếp, cơ chế classifier cũ
   * dao động `low↔high` **113/120 lần** và 54,5% quyết định có confidence < 0,5.
   * Nghiên cứu ngoài (arXiv 2505.00127, 2507.04023) cho thấy model hệ suy luận
   * trên việc dễ gần như không tăng accuracy khi nâng effort. Nâng effort chỉ
   * đáng khi có bằng chứng CỤ THỂ rằng bước trước đã thất bại.
   */
  effortDefault: 'low',
  /**
   * Lớp 3 — nguồn quyết định effort.
   *
   *   - `'input'` (mặc định): mỗi LƯỢT user gửi, Jev đọc nội dung yêu cầu và
   *     chọn mức effort cho lượt đó (`effortQuestion`). Sticky trong turn nên
   *     chỉ tốn 1 call Jev/lượt. Jev lỗi → lùi `effortDefault`.
   *   - `'deterministic'`: luật tín hiệu cũ — mặc định `effortDefault`, nâng
   *     `effortEscalateTo` khi turn trước có tool error / test fail. Không gọi
   *     Jev.
   */
  effortDecision: 'input',
  /**
   * Lớp 3 — các mức Jev ĐƯỢC PHÉP chọn ở chế độ `input`.
   *
   * Operator chốt: Jev chỉ quyết `low` hay `high`; mọi trường hợp còn lại (Jev
   * lỗi, không có task, trả mức lạ) rơi về `effortFallback` (medium).
   *
   * Danh sách này được GIAO với dải `reasoningEfforts` của model. Model không
   * nhận một mức nào đó thì mức đó bị loại khỏi lựa chọn; nếu còn <2 mức hợp lệ
   * thì không hỏi Jev nữa (không có gì để chọn).
   */
  effortJevChoices: ['low', 'high'],
  /**
   * Lớp 3 — mức MẶC ĐỊNH của chế độ `input` khi Jev không quyết được.
   *
   * Đây là "phần còn lại" mà operator muốn: Jev chỉ đẩy lên `high` khi việc khó
   * và xuống `low` khi việc rõ ràng; còn lại giữ `medium`.
   */
  effortFallback: 'medium',
  /**
   * Lớp 3 — bật cơ chế ABSTAIN THẬT cho chế độ `input` (mặc định TẮT).
   *
   * Vấn đề: `effortQuestion` là một câu `choice` buộc Jev CHỌN một mức. Khi
   * `effortJevChoices` chỉ có `low`/`high`, API luôn trả về một cực — `medium`
   * chỉ xuất hiện khi Jev lỗi/không trả lời được, tức nó là DẤU HIỆU HỎNG chứ
   * không phải một quyết định. Đo trên 120 request thật: effort lật `low↔high`
   * 113/120 lần.
   *
   * Khi bật cờ này, host hỏi HAI câu `noul` độc lập trong MỘT request
   * (`effortAbstainQuestion`) — `routine` ("toàn bộ request có rõ ràng là
   * routine/máy móc không?") và `hard` ("để hoàn thành có cần giải quyết điều
   * chưa biết không?") — rồi tự ánh xạ (`mapEffortAbstain`):
   *   - routine mạnh, hard yếu  → mức THẤP NHẤT trong `effortJevChoices`
   *   - hard mạnh, routine yếu  → mức CAO NHẤT trong `effortJevChoices`
   *   - còn lại (cả hai mạnh/mâu thuẫn, hoặc cả hai yếu) → `effortFallback`
   *
   * Nhờ vậy `medium` trở thành một kết quả HỢP LỆ ("không đủ bằng chứng để
   * nghiêng về cực nào") thay vì một lỗi, và Jev không bị ép chọn cực. Chi phí
   * vẫn là 1 call Jev/lượt (API cho tới 64 câu/request).
   *
   * Mặc định TẮT để giữ nguyên hành vi đã đo (bộ 26 task, 26/26) — bật cờ này
   * là một thay đổi hành vi cần A/B riêng.
   *
   * ĐÃ A/B (2026-10-05) trên đúng bộ 26 nhãn, 3 lần lặp: bản câu `hard` đầu
   * tiên chỉ được **63/78** vì nó viết "the answer is not yet known and must be
   * found" — mô tả đúng việc "đọc file để tra một giá trị", nên task routine bị
   * abstain OAN. Sau khi viết lại câu `hard` (tách "điều QUYẾT ĐỊNH phải làm gì"
   * khỏi "tra một giá trị"): **78/78**, 0 abstain oan, ngang đường `choice`.
   * Trên 12 task "giữa", abstain khác `choice` **8/12 ca** — đúng ở chỗ `choice`
   * bị ép chọn cực với confidence thấp (0,01–0,55).
   */
  effortAbstain: false,
  /**
   * Lớp 3 — ngưỡng "mạnh" cho từng trục của chế độ abstain (chỉ dùng khi
   * `effortAbstain: true`). Hai ngưỡng TÁCH RIÊNG để hiệu chỉnh độ nhạy từng
   * trục độc lập: hạ `effortHardThreshold` để bắt các request nêu triệu chứng
   * cần chẩn đoán sớm hơn, mà không đụng tới trục routine.
   */
  effortRoutineThreshold: 0.5,
  effortHardThreshold: 0.5,
  /**
   * Lớp 3 — mức nâng lên khi turn trước có tín hiệu thất bại đo được.
   * Chỉ dùng ở chế độ `effortDecision: 'deterministic'`.
   */
  effortEscalateTo: 'high',
  /**
   * Lớp 3 — số tool error trong turn trước đủ để nâng effort.
   * Đây là tín hiệu ĐO ĐƯỢC (`tool/result` có `isError`/`error`), không phải
   * dự đoán độ khó — research nói tín hiệu đo được thắng tín hiệu đoán.
   */
  effortEscalateToolErrors: 2,
  /**
   * Lớp 3 — số dấu hiệu test fail trong turn trước đủ để nâng effort.
   * Một test fail là bằng chứng mạnh hơn hai tool error lặt vặt.
   */
  effortEscalateTestFailures: 1,
  /**
   * Lớp 7 — tự gọi `jev_review` khi turn kết thúc.
   * `reviewMinChangedLines` chặn review trên diff nhỏ (sửa typo, đổi 1 dòng).
   * `reviewMaxPerTurn` là trần cứng để hook không gọi lặp.
   */
  reviewMinChangedLines: 20,
  reviewMaxPerTurn: 1,
  reviewMaxDiffChars: 24_000,
  reviewServerName: 'jev-review',
  reviewReportToAgent: true,
  reviewMode: undefined,
  reviewContextReserveTokens: 120,
  reviewTimeoutMs: 15_000,
  gateTimeoutMs: 2_000,
  stopTimeoutMs: 6_000,
  effortTimeoutMs: 8_000,
  spawnTimeoutMs: 6_000,
  contextTimeoutMs: 6_000,
  failureTimeoutMs: 4_000,
  /**
   * Lớp 8 — leo thang sang `jg` (jevgrep) khi việc là "tìm X nằm ở đâu".
   *
   * Đo trên session thật `777a1746`: Lớp 5 hint file bằng TÊN ở 4 turn liên
   * tiếp, agent KHÔNG đọc file đó lần nào (0/4), trong khi cả session chạy 152
   * lệnh grep/find thô và 0 lần `jg`. Tên file không đủ để model tin; `jg` trả
   * NỘI DUNG verbatim nên nó bù đúng chỗ thiếu đó.
   *
   * Vì sao KHÔNG thay hẳn Lớp 5: `jg` đo thật ~0.9s ấm / ~2.6s nguội, cộng vào
   * step 1 của MỌI turn kể cả turn không phải việc tìm kiếm. Leo thang có điều
   * kiện giữ turn thường rẻ.
   *
   * `jevGrepSearchTaskThreshold`: số lệnh dò tìm thô liên tiếp (không có `jg`)
   * trong một turn thì kích hoạt leo thang. Đặt 0 để tắt nhánh "vòng xoáy".
   * `jevGrepMaxPerTurn`: trần cứng số lần leo thang mỗi turn.
   *
   * `jevGrepTimeoutMs`: ngân sách cho một lần `jg`; quá hạn thì fail-open.
   *
   * **Đo lại 2026-10-01, và con số cũ 12.000 SAI.** Đo `jg` thật trên repo này:
   *
   *   | Tình huống | Thời gian |
   *   |---|---|
   *   | cache lạnh (lần đầu cho một truy vấn) | **64s** |
   *   | cache ấm (cùng truy vấn) | 7,5–10,2s |
   *
   * Với trần 12s, `jg` KHÔNG BAO GIỜ thành công khi cache lạnh — và đo trên
   * log thật: **41/41 lần leo thang đều `fail_open`**, chưa lần nào chạy được.
   * Sau khi fix exit-code ở v0.7, lỗi chỉ chuyển từ `jg exited 2` sang `timeout`;
   * bản chất vẫn là chưa từng hoạt động.
   *
   * ## Đo lại 2026-10-01 (lần 2) — cache theo TỪNG TRUY VẤN, không theo repo
   *
   * Bản trước tưởng "cold 64s một lần cho cả repo". SAI. Đo `jg` thật:
   *
   *   | Tình huống | Thời gian |
   *   |---|---|
   *   | truy vấn đã hỏi (cache ấm) | 7,5–10,2s |
   *   | **truy vấn MỚI (chưa từng hỏi)** | **66s – 2m5s** |
   *
   * Mỗi truy vấn mới đều cold. Nghĩa là bất kỳ timeout nào trong hook AWAIT
   * cũng sai: thấp thì không bao giờ chạy được, cao thì treo turn tới 2 phút.
   * `jevGrepFailureBreaker: 3` × `jevGrepTimeoutMs: 70000` = **210s chặn turn**.
   *
   * ## Nên: chạy `jg` NGOÀI đường tới hạn
   *
   * `jg` bắt đầu chạy nền (không await), kết quả được chèn vào `agent/pre-step`
   * của lần chạm KẾ TIẾP. Turn không bao giờ chờ `jg`.
   *
   * `jevGrepTimeoutMs`: ngân sách cho tiến trình nền (không còn chặn turn nên
   * để rộng được). `jevGrepBackground: false` để quay về hành vi await cũ.
   */
  jevGrepSearchTaskThreshold: 3,
  jevGrepMaxPerTurn: 1,
  jevGrepTimeoutMs: 120_000,
  /** Chạy `jg` nền thay vì await trên đường tới hạn. Tắt để về hành vi cũ. */
  jevGrepBackground: true,
  /**
   * Số lần `jg` hỏng LIÊN TIẾP trước khi tạm tắt Lớp 8 cho phần còn lại của
   * phiên. Đặt 0 để tắt breaker (không khuyến nghị — đo được 41/41 lần hỏng).
   */
  jevGrepFailureBreaker: 3,
  jevGrepBreakerCooldownMs: 60_000,
  jevGrepMaxConcurrentPerSession: 1,
  jevGrepMaxConcurrentGlobal: 2,
  jevGrepPendingMax: 20,
  jevGrepExcerptCap: 4_000,
  /**
   * Nhánh A (leo thang vì task ĐỌC RA là "tìm X ở đâu") — mặc định TẮT.
   *
   * Báo cáo §11: leo thang không nên chỉ dựa trên "task nghe giống search". Đó
   * là suy đoán từ chuỗi, không phải bằng chứng agent đang mò. Nhánh B mới có
   * bằng chứng đo được: đã có `jevGrepSearchTaskThreshold` lệnh dò tìm thô liên
   * tiếp mà chưa xong. Nên mặc định chỉ nhánh B chạy.
   *
   * Bật lại để về hành vi cũ (leo thang ngay ở step 1 khi task tìm-kiếm).
   */
  jevGrepSearchTaskHeuristic: false,
  logDir: undefined,
  enableDestructiveGate: true,
  /**
   * Prefilter chỉ-đọc cho Lớp 1 (xem `lib/readonly.mjs`).
   *
   * Bật: lệnh chứng minh được là chỉ-đọc bỏ qua Jev. Tắt: mọi lệnh `bash` đều
   * qua Jev như trước — dùng khi nghi ngờ prefilter, hoặc để đo lại chi phí.
   */
  enableReadOnlyPrefilter: true,
  /**
   * Sàn tất định cho lệnh phá huỷ toàn hệ thống (`lib/catastrophic.mjs`).
   *
   * Gate dựa vào Jev, mà Jev lỗi: 252/6.442 lần (3,9%) gọi thất bại. Với
   * `gateFailureMode: 'auto_allow'` (hành vi cũ) một lần lỗi là `rm -rf /` chạy;
   * mặc định `ask` đã bịt đường đó, nhưng sàn này vẫn cần vì nó chặn TRƯỚC khi
   * khoá config được đọc — kể cả khi operator cố ý đặt `auto_allow`. Danh sách CỐ
   * Ý hẹp: chỉ những gì không thể hoàn tác VÀ không thể biện minh (`rm -rf /tmp/x`
   * vẫn qua bình thường).
   */
  enableCatastrophicFloor: true,
  /**
   * Cache verdict tất định cho Lớp 1 (gate phá dữ liệu).
   *
   * Vì sao: đo trên log thật, gate chạy 11.752 lần mà chỉ chặn 113 — gần như mọi
   * lần là một round-trip API để nghe lại điều đã nghe rồi. Trong số lệnh `allow`,
   * một phần đáng kể là chuỗi lệnh TRÙNG Y HỆT (`rm -rf /tmp/gtest` xuất hiện 17
   * lần). Verdict cho một lệnh byte-identical là tất định, nên hỏi lại Jev là lãng
   * phí thuần.
   *
   * An toàn: khoá gồm `(tool, command, cwd, declaredWorkdir)` với command
   * **byte-identical** (KHÔNG chuẩn hoá, KHÔNG bỏ khoảng trắng — chuẩn hoá chính là
   * nguồn lỗi). Cùng khoá ⇒ cùng một hành động ⇒ cùng verdict. Khác một ký tự ⇒
   * miss. Khoá KHÔNG gồm session (xem ghi chú ở `gateCacheKeyOf`): `p` là phán đoán
   * về hành động, còn phần phụ thuộc phiên (Lớp 1b) không được cache.
   *
   * Cache CHỈ lưu phán đoán `p` (đại lượng độc lập với hội thoại), KHÔNG lưu kết
   * cục cuối. Nhánh `p >= destructiveThreshold` vẫn chạy lại Lớp 1b (provenance,
   * tất định, không LLM) trên MỖI lần gọi — nên nếu user sau đó xác nhận đúng
   * target, lệnh vẫn được cho qua như khi không cache. Đây là lý do cache deny an
   * toàn: nó chỉ bỏ round-trip Jev, không đóng băng quyết định chặn.
   *
   * `fail_open` (Jev lỗi) KHÔNG BAO GIỜ được cache — lỗi tạm thời không được đóng
   * băng thành verdict.
   *
   * Trần bộ nhớ: `gateVerdictCacheMax` phần tử, eviction FIFO + LRU-touch khi hit.
   */
  enableGateVerdictCache: true,
  gateVerdictCacheMax: 500,
  /**
   * Dải sát ngưỡng KHÔNG được cache.
   *
   * Jev KHÔNG tất định: đo trên jev-1.13.0, `rm -f <file>` cho p vắt qua ngưỡng
   * 0,7 (`0.67, 0.68, 0.69, 0.70`). Nếu cache một lần rơi mẫu `< ngưỡng` (allow)
   * thì mọi lần sau phục vụ p cũ, BỎ QUA các mẫu `≥ ngưỡng` lẽ ra phải chặn —
   * cache biến deny thành allow. Nên chỉ cache khi `|p − threshold| > margin`
   * (verdict cách ngưỡng đủ xa để dao động không đổi kết quả).
   *
   * Margin 0,1 chừa 0,6–0,8: đo được dao động thật ~±0,02 quanh giá trị, nên
   * vùng này đủ rộng. Vẫn giữ phần lớn lợi ích (lệnh p rõ ràng 0.0x/0.9x).
   */
  gateVerdictCacheMargin: 0.1,
  /**
   * Lớp 1 — Jev KHÔNG trả lời được thì làm gì với một lệnh CÓ THỂ phá dữ liệu.
   *
   * Đo trên log thật: Jev lỗi 3,9% số lần (252/6.442). Với `auto_allow`, một
   * lần timeout đúng lúc là `rm -rf ~/projects/customer-data` chạy thẳng — sàn
   * catastrophic chỉ bịt được `rm -rf /`, không bịt được mọi lệnh phá dữ liệu
   * thật. Vì vậy mặc định là `ask`, không phải `auto_allow`.
   *
   *   - `ask`        (mặc định) hỏi user qua THẺ ĐỒNG Ý rồi chờ. Subagent,
   *                  thiếu kênh hỏi, hết hạn, từ chối → CHẶN (fail-closed).
   *                  Cùng ngữ nghĩa với Lớp 1b: im lặng không phải là đồng ý.
   *                  Nếu thẻ đồng ý bị tắt (`enableDestructiveConsent: false`)
   *                  thì không còn kênh hỏi → thoái hoá thành `block`.
   *   - `block`      → CHẶN cứng, không hỏi. Dùng khi không muốn thẻ nào cả.
   *   - `auto_allow` → hành vi fail-open cũ (hành động đi tiếp như chưa có Jev).
   *
   * Hai lớp chạy TRƯỚC và KHÔNG phụ thuộc khoá này: prefilter chỉ-đọc (lệnh
   * chứng minh được là chỉ-đọc không tới đây) và sàn catastrophic (`rm -rf /`
   * bị chặn trước khi khoá này được đọc).
   */
  gateFailureMode: 'ask',
  enableAuthorizationOverride: true,
  /**
   * Lớp 1b — hỏi user bằng THẺ NỔI khi agent tự đề nghị một hành động phá dữ liệu.
   *
   * Yêu cầu gốc của operator: yêu cầu CỦA USER là kiên quyết (bảo xoá là xoá),
   * nhưng khi AGENT tự đề nghị xoá giữa lúc chạy thì phải HỎI user và chờ đồng
   * ý — "đảm bảo k tự động xoá nếu user k cho phép".
   *
   * Hai nhánh tách bạch:
   *   - User nêu rõ hành động phá huỷ và đúng mọi target trong tin nhắn thật,
   *     không phủ định/trích dẫn/thảo luận mơ hồ → `allow_authorized`. Đây là "đồng ý là đồng ý".
   *   - Không chứng minh được user yêu cầu → trước đây chặn cứng; nay hỏi user
   *     qua thẻ nổi và CHỜ. Đồng ý → chạy; từ chối/timeout/lỗi → CHẶN.
   *
   * Vì sao dùng `ctx.userQuestions` chứ không phải `ctx.approval`: ở bản deploy
   * này `dsh-purge` đã vá `dsh-user-approval` thành auto-grant (mọi yêu cầu
   * approval trả `allowed-once` mà không hỏi ai) → nhánh đó KHÔNG thể lấy được
   * đồng ý thật. `dsh-user-questions` còn nguyên và là kênh hỏi user thật sự.
   */
  enableDestructiveConsent: true,
  /**
   * Lớp 1b — thời gian chờ user trả lời thẻ đồng ý, ms.
   *
   * Hết hạn → TỪ CHỐI (deny), không phải cho qua: im lặng không phải là đồng ý.
   * Mặc định 120s khớp timeout của `ask_user_question` (`dsh-tool-ask-user`).
   */
  consentTimeoutMs: 120_000,
  enableCompletionCheck: true,
  enableEffortRouting: true,
  // Chỉ bật advice nếu đo được lợi ích ròng trên hành trình agent.
  enableSpawnHint: false,
  /**
   * Lớp 5 — chọn file nạp vào context (mặc định TẮT).
   *
   * Vì sao TẮT: bản cũ chỉ đưa tên file, log thật ghi nhận gợi ý không đổi
   * hành vi agent (0/4 turn, session 777a1746). Bản mới đọc import/export và
   * dòng khớp task để Jev xếp hạng, nhưng chưa có A/B theo hành trình thực chứng
   * minh lợi ích ròng. Giữ mặc định tắt cho đến khi có phép đo đó.
   */
  enableContextTriage: false,
  enableFailureRecovery: true,
  enableQualityReview: true,
  /**
   * Lớp 8 — leo thang tìm nguồn bằng `jg`. MẶC ĐỊNH TẮT từ thay đổi này.
   *
   * ## Vì sao đổi mặc định (đo được, không phải sở thích)
   *
   * Báo cáo §11–§12: `jg` truy vấn MỚI cold mất 66s–2m5s, và trong log thật
   * **41/41 lần leo thang đều `fail_open`** — chưa từng trả về gợi ý nào, chỉ
   * tạo overhead. Luật pha 4 của báo cáo: chỉ lớp nào chứng minh được
   * net-positive mới được bật mặc định. Lớp 8 chưa chứng minh được, nên đưa về
   * experimental.
   *
   * Bật lại: `enableJevgrepEscalation: true` (cần skill `jevgrep` + `jg` trên
   * PATH). Khi bật, kết quả nền vẫn bị kiểm vân tay task/root trước khi chèn.
   */
  enableJevgrepEscalation: false,
};

export const Config = z.object({
  profile: z.union([z.const('custom'), z.const('safe'), z.const('balanced'), z.const('experimental')]).default('custom'),
  destructiveThreshold: z.number().min(0).max(1).default(DEFAULTS.destructiveThreshold),
  shadowGateThreshold: z.number().min(0).max(1),
  completionThreshold: z.number().min(0).max(1).default(DEFAULTS.completionThreshold),
  evidenceThreshold: z.number().min(0).max(1).default(DEFAULTS.evidenceThreshold),
  executionThreshold: z.number().min(0).max(1).default(DEFAULTS.executionThreshold),
  approachConfidenceThreshold: z.number().min(0).max(1).default(DEFAULTS.approachConfidenceThreshold),
  approachTopProbability: z.number().min(0).max(1).default(DEFAULTS.approachTopProbability),
  approachProbabilityMargin: z.number().min(0).max(1).default(DEFAULTS.approachProbabilityMargin),
  contextFileThreshold: z.number().min(0).max(1).default(DEFAULTS.contextFileThreshold),
  contextCandidateLimit: z.number().default(DEFAULTS.contextCandidateLimit),
  contextMaxFiles: z.number().default(DEFAULTS.contextMaxFiles),
  contextEvidence: z.boolean().default(DEFAULTS.contextEvidence),
  maxPluginContextTokensPerTurn: z.number().min(0).default(DEFAULTS.maxPluginContextTokensPerTurn),
  failureMaxPerTurn: z.number().default(DEFAULTS.failureMaxPerTurn),
  completionMaxPerTurn: z.number().default(DEFAULTS.completionMaxPerTurn),
  jevBudgetEnabled: z.boolean().default(DEFAULTS.jevBudgetEnabled),
  jevMaxCallsPerTurn: z.number().default(DEFAULTS.jevMaxCallsPerTurn),
  jevMaxCallsPerSession: z.number().min(0).default(DEFAULTS.jevMaxCallsPerSession),
  maxDecisionCostPerTurn: z.number().min(0).default(DEFAULTS.maxDecisionCostPerTurn),
  maxDecisionCostPerSession: z.number().min(0).default(DEFAULTS.maxDecisionCostPerSession),
  reviewMaxPerSession: z.number().min(0).default(DEFAULTS.reviewMaxPerSession),
  jevGrepMaxPerSession: z.number().min(0).default(DEFAULTS.jevGrepMaxPerSession),
  effortDefault: z.string().default(DEFAULTS.effortDefault),
  effortDecision: z.string().default(DEFAULTS.effortDecision),
  effortJevChoices: z.array(z.string()).default(DEFAULTS.effortJevChoices),
  effortFallback: z.string().default(DEFAULTS.effortFallback),
  effortAbstain: z.boolean().default(DEFAULTS.effortAbstain),
  effortRoutineThreshold: z.number().min(0).max(1).default(DEFAULTS.effortRoutineThreshold),
  effortHardThreshold: z.number().min(0).max(1).default(DEFAULTS.effortHardThreshold),
  effortEscalateTo: z.string().default(DEFAULTS.effortEscalateTo),
  effortEscalateToolErrors: z.number().default(DEFAULTS.effortEscalateToolErrors),
  effortEscalateTestFailures: z.number().default(DEFAULTS.effortEscalateTestFailures),
  reviewMinChangedLines: z.number().default(DEFAULTS.reviewMinChangedLines),
  reviewMaxPerTurn: z.number().default(DEFAULTS.reviewMaxPerTurn),
  reviewMaxDiffChars: z.number().default(DEFAULTS.reviewMaxDiffChars),
  reviewServerName: z.string().default(DEFAULTS.reviewServerName),
  reviewReportToAgent: z.boolean().default(DEFAULTS.reviewReportToAgent),
  reviewMode: z.union([z.const('telemetry'), z.const('agent-feedback')]),
  reviewContextReserveTokens: z.number().min(1).default(DEFAULTS.reviewContextReserveTokens),
  reviewTimeoutMs: z.number().min(1).default(DEFAULTS.reviewTimeoutMs),
  gateTimeoutMs: z.number().default(DEFAULTS.gateTimeoutMs),
  stopTimeoutMs: z.number().default(DEFAULTS.stopTimeoutMs),
  effortTimeoutMs: z.number().default(DEFAULTS.effortTimeoutMs),
  spawnTimeoutMs: z.number().default(DEFAULTS.spawnTimeoutMs),
  contextTimeoutMs: z.number().default(DEFAULTS.contextTimeoutMs),
  failureTimeoutMs: z.number().default(DEFAULTS.failureTimeoutMs),
  jevGrepSearchTaskThreshold: z.number().default(DEFAULTS.jevGrepSearchTaskThreshold),
  jevGrepMaxPerTurn: z.number().default(DEFAULTS.jevGrepMaxPerTurn),
  jevGrepTimeoutMs: z.number().default(DEFAULTS.jevGrepTimeoutMs),
  jevGrepBackground: z.boolean().default(DEFAULTS.jevGrepBackground),
  jevGrepFailureBreaker: z.number().min(0).default(DEFAULTS.jevGrepFailureBreaker),
  jevGrepBreakerCooldownMs: z.number().min(0).default(DEFAULTS.jevGrepBreakerCooldownMs),
  jevGrepMaxConcurrentPerSession: z.number().min(0).default(DEFAULTS.jevGrepMaxConcurrentPerSession),
  jevGrepMaxConcurrentGlobal: z.number().min(0).default(DEFAULTS.jevGrepMaxConcurrentGlobal),
  jevGrepPendingMax: z.number().min(0).default(DEFAULTS.jevGrepPendingMax),
  jevGrepExcerptCap: z.number().default(DEFAULTS.jevGrepExcerptCap),
  jevGrepSearchTaskHeuristic: z.boolean().default(DEFAULTS.jevGrepSearchTaskHeuristic),
  enableDestructiveGate: z.boolean().default(DEFAULTS.enableDestructiveGate),
  enableReadOnlyPrefilter: z.boolean().default(DEFAULTS.enableReadOnlyPrefilter),
  enableCatastrophicFloor: z.boolean().default(DEFAULTS.enableCatastrophicFloor),
  enableGateVerdictCache: z.boolean().default(DEFAULTS.enableGateVerdictCache),
  gateVerdictCacheMax: z.number().default(DEFAULTS.gateVerdictCacheMax),
  gateVerdictCacheMargin: z.number().min(0).max(1).default(DEFAULTS.gateVerdictCacheMargin),
  enableAuthorizationOverride: z.boolean().default(DEFAULTS.enableAuthorizationOverride),
  gateFailureMode: z
    .union([z.const('ask'), z.const('block'), z.const('auto_allow')])
    .default(DEFAULTS.gateFailureMode),
  enableDestructiveConsent: z.boolean().default(DEFAULTS.enableDestructiveConsent),
  consentTimeoutMs: z.number().default(DEFAULTS.consentTimeoutMs),
  enableCompletionCheck: z.boolean().default(DEFAULTS.enableCompletionCheck),
  enableEffortRouting: z.boolean().default(DEFAULTS.enableEffortRouting),
  enableSpawnHint: z.boolean().default(DEFAULTS.enableSpawnHint),
  enableContextTriage: z.boolean().default(DEFAULTS.enableContextTriage),
  enableFailureRecovery: z.boolean().default(DEFAULTS.enableFailureRecovery),
  enableQualityReview: z.boolean().default(DEFAULTS.enableQualityReview),
  enableJevgrepEscalation: z.boolean().default(DEFAULTS.enableJevgrepEscalation),
  // Không default: thiếu khoá thì `apply` tự dùng DEFAULT_LOG_DIR. Có mặt để
  // test trỏ log vào thư mục tạm, không làm bẩn log thật. Schemastery coi khoá
  // không `.required()` là optional, nên không khai default ở đây.
  logDir: z.string(),
});

/** Ghi log quyết định; lỗi ghi log không bao giờ được làm hỏng quyết định. */
/**
 * Ghi một dòng quyết định vào `decisions.jsonl`.
 *
 * `agent` là tham số TUỲ CHỌN: khi có, dòng log kèm `session` ngắn để tách được
 * agent chính với subagent.
 *
 * Vì sao cần: audit trên 23.045 dòng log thật cho thấy **không dòng nào có
 * `sessionId`/`agentId`**, nên không thể trả lời "hook X có tác dụng với agent
 * nào" hay xác minh rò state chéo agent từ log. Đây là khoảng trống quan sát có
 * thật, và nó chặn đúng câu hỏi quan trọng nhất: hook nào hiệu quả.
 *
 * Chỉ ghi KHOÁ đã rút gọn, không ghi nội dung session.
 */
function makeRecorder(logDir) {
  const logFile = join(logDir, 'decisions.jsonl');
  let ready;
  return (entry, agent) => {
    ready ??= mkdir(logDir, { recursive: true }).catch(() => {});
    const session = agent === undefined ? undefined : sessionKeyOf(agent);
    const row = session === undefined ? entry : { ...entry, session };
    ready
      .then(() => appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, { mode: 0o600 }))
      .catch(() => {});
  };
}

/**
 * Giữ `map` dưới trần `max` bằng cách xoá entry CŨ NHẤT trước.
 *
 * KHÔNG dùng `map.clear()`: nó xoá sạch mọi khoá, kể cả khoá của turn/agent đang
 * chạy, nên turn cũ fire lại. Đây là lỗi đã gặp thật ở Lớp 2 (log ghi 16 lần fire
 * trên cùng turn=9) và đã sửa ở đó. Lớp 3 và Lớp 7 cũng có bản sao của cùng logic
 * này; gom về một chỗ để ba nơi không lệch nhau.
 *
 * `Map` giữ thứ tự chèn, nên `keys()` duyệt từ cũ đến mới.
 *
 * Export để test trực tiếp: nó là hợp đồng chung của năm lớp, và một hồi quy ở
 * đây im lặng (chỉ lộ ra khi state vượt 200 entry — hiếm trong test thường).
 */
export function evictOldest(map, max = 200) {
  const excess = map.size - max;
  if (excess <= 0) return;
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= excess) break;
    map.delete(key);
    removed += 1;
  }
}

const rawCommandOf = (toolName, args) => {
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined;
  const command = args?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
};

/**
 * §16 — Thứ tự ưu tiên lớp Jev. Ngân sách cạn thì cắt từ dưới lên.
 *
 * `safety` là bất khả xâm phạm: hết ngân sách KHÔNG bao giờ chặn Lớp 1 (xem
 * `budgetAllows`). Xếp hạng ở đây chỉ quyết định AI bị cắt TRƯỚC khi turn/session
 * bận — không bao giờ cắt lớp trên để nhường lớp dưới.
 */
const JEV_LAYER_PRIORITY = Object.freeze({
  destructive_gate: 'safety',
  completion_check: 'completion',
  failure_recovery: 'recovery',
  effort_route: 'effort',
  approach_context: 'advisory',
  jevgrep_escalation: 'advisory',
});

/**
 * Hạng của từng mức ưu tiên (cao hơn = quan trọng hơn). `safety` không có hạng
 * vì nó không bao giờ bị cắt, nên không cần chừa chỗ cho nó.
 */
const JEV_PRIORITY_RANK = Object.freeze({
  completion: 3,
  recovery: 2,
  effort: 1,
  advisory: 0,
});

export function apply(ctx, config = {}) {
  const cfg = resolveProfile(config, DEFAULTS);
  const record = makeRecorder(cfg.logDir ?? DEFAULT_LOG_DIR);
  /**
   * Cảnh báo khoá config đã BỊ BỎ nhưng vẫn còn trong file của người dùng.
   *
   * `schemastery` giữ khoá lạ nhưng plugin không dùng chúng; người dùng còn đặt
   * `effortReuseConfidence: 0.9` sẽ tưởng nó vẫn có tác dụng — trong khi Lớp 3
   * giờ là luật tất định và không đọc khoá đó nữa. Im lặng ở đây là một cái bẫy
   * đúng loại plugin này sinh ra để tránh, nên nói thẳng ra.
   *
   * Chỉ log một lần lúc nạp, không phải mỗi lần chạy hook.
   */
  const RETIRED_CONFIG = {
    effortReuseConfidence: 'Lớp 3 giờ do Jev quyết theo nội dung tin nhắn user '
      + '(effortDecision/effortJevChoices/effortFallback) hoặc luật tất định '
      + '(effortDecision: deterministic + effortDefault/effortEscalateTo/'
      + 'effortEscalateToolErrors/effortEscalateTestFailures).',
    effortMaxReuseSteps: 'Lớp 3 sticky theo turn (không còn lease/tái dùng theo confidence).',
    authorizationTimeoutMs: 'Lớp 1b giờ dùng provenance tất định (không gọi LLM), '
      + 'nên không còn timeout cho call đó.',
  };
  const retired = Object.keys(RETIRED_CONFIG).filter((key) => Object.hasOwn(config, key));
  const unknown = Object.keys(config).filter((key) => !Object.hasOwn(DEFAULTS, key)
    && key !== 'profile' && key !== 'shadowGateThreshold' && !Object.hasOwn(RETIRED_CONFIG, key));
  if (unknown.length) {
    record({ type: 'unknown_config', keys: unknown });
    ctx.logger?.warn?.(`[jev-gate] config không nhận diện: ${unknown.join(', ')}`);
  }
  if (retired.length) {
    const details = retired.map((key) => `  • ${key}: ${RETIRED_CONFIG[key]}`).join('\n');
    const message = `[jev-gate] config bỏ qua ${retired.join(', ')} (đã ngừng dùng):\n${details}\n`
      + 'Xoá khoá cũ khỏi cordis.patch.yml để tránh tưởng nhầm nó còn tác dụng.';
    record({ type: 'retired_config', keys: retired });
    ctx.logger?.warn?.(message);
  }
  /**
   * §16 — NGÂN SÁCH JEV DÙNG CHUNG, ÉP Ở ĐÚNG MỘT CHỖ: bọc `createJev`.
   *
   * Mọi lớp gọi Jev qua `jev.evaluate` (Lớp 1 gate, Lớp 2 completion, Lớp 3
   * effort, Lớp 4/5 pre-step, Lớp 6 recovery) đều đi qua wrapper này, nên không
   * lớp nào lách được ngân sách mà không phải sửa từng call site. Các lớp TẤT
   * ĐỊNH (prefilter/floor, `effortDecision: deterministic`, bộ phân loại lỗi đã
   * biết) không gọi `evaluate` nên không bị đụng tới — "tất định = 0 call" giữ
   * nguyên.
   *
   * Vì sao ép ở tầng client chứ không ở từng lớp: một trần TỔNG chỉ đúng nếu
   * mọi đường đều bị đếm. Đặt ở mỗi lớp thì thêm lớp mới là thêm một lỗ rò.
   */
  const budgetTurnUsed = new Map();
  const budgetSessionUsed = new Map();
  const decisionTurnUsed = new Map();
  const decisionSessionUsed = new Map();
  const reviewSessionUsed = new Map();
  const grepSessionUsed = new Map();

  /**
   * Số slot CHỪA cho các lớp ưu tiên CAO HƠN còn bật, theo từng mức ưu tiên.
   *
   * Vì sao cần "chừa chỗ": ngân sách là một con số DÙNG CHUNG. Nếu lớp advisory
   * tiêu hết 4 call của turn thì lớp completion (ưu tiên cao hơn) bị chặn ở lần
   * chạy sau — đúng lúc `turn-stopping`, nơi nó quan trọng nhất. Trừ đi phần
   * chừa khiến lớp thấp TỰ NHƯỜNG: advisory bị cắt sớm nhất, đúng §16
   * "tắt advisory layers trước".
   *
   * Chỉ đếm lớp ĐANG BẬT: tắt `enableEffortRouting` thì effort không còn chiếm
   * slot chừa của lớp dưới. Mỗi lớp ưu tiên cao hơn chừa 1 slot (mức tối thiểu
   * để nó chạy được ít nhất một lần).
   *
   * Lớp 3 còn phải đang ở chế độ GỌI JEV mới tính: `effortDecision:
   * 'deterministic'` biến nó thành lớp tất định (0 call), nên nó không được
   * chiếm slot chừa — nếu không, advisory bị cắt sớm một cách vô cớ.
   */
  const higherPriorityReserve = (rank) => {
    let reserve = 0;
    if (JEV_PRIORITY_RANK.completion > rank && cfg.enableCompletionCheck) reserve += 1;
    if (JEV_PRIORITY_RANK.recovery > rank && cfg.enableFailureRecovery) reserve += 1;
    if (JEV_PRIORITY_RANK.effort > rank && cfg.enableEffortRouting
      && cfg.effortDecision !== 'deterministic') reserve += 1;
    if (JEV_PRIORITY_RANK.advisory > rank
      && (cfg.enableSpawnHint || cfg.enableContextTriage || cfg.enableJevgrepEscalation)) reserve += 1;
    return reserve;
  };

  /**
   * Được phép gọi Jev lớp này không? Trả `{ allowed, priority, ... }`.
   *
   * SAFETY (Lớp 1 destructive gate) KHÔNG BAO GIỜ bị chặn: hết ngân sách không
   * được biến thành "cho lệnh nguy hiểm chạy". Nó cũng KHÔNG tiêu trần không-
   * safety: gate chạy mọi lệnh shell, nếu tính chung thì một turn nhiều lệnh sẽ
   * ăn hết ngân sách của completion/effort. Safety chỉ ghi vào bộ đếm riêng.
   */
  const priorityOf = (layer) => JEV_LAYER_PRIORITY[layer] ?? 'advisory';
  const budgetAllows = (agent, turn, layer, category = 'direct', cost = 1) => {
    const priority = priorityOf(layer);
    if (!cfg.jevBudgetEnabled || priority === 'safety') {
      return { allowed: true, priority, category, cost,
        reason: cfg.jevBudgetEnabled ? 'safety_priority' : 'disabled' };
    }
    const sessionKey = sessionKeyOf(agent) ?? agent?.id ?? 'agent';
    const turnKey = `${sessionKey}:${Number.isSafeInteger(turn) ? turn : -1}`;
    const reserve = higherPriorityReserve(JEV_PRIORITY_RANK[priority] ?? 0);
    const turnCap = cfg.jevMaxCallsPerTurn;
    const sessionCap = cfg.jevMaxCallsPerSession;
    const turnUsed = budgetTurnUsed.get(turnKey) ?? 0;
    const sessionUsed = budgetSessionUsed.get(sessionKey) ?? 0;
    /**
     * Phép so phải CỘNG cả lần sắp tiêu (`+ 1`) LẪN phần chừa (`+ reserve`).
     *
     * Nếu chỉ so `đã dùng < trần − reserve` (cách cũ) thì hai lớp thấp CỘNG LẠI
     * vẫn ăn quá phần chừa: advisory 2 + recovery 3 = 5 > trần 4, và completion
     * bị chặn ở đúng lúc `turn-stopping` — đúng kiểu "hy sinh lớp ưu tiên cao để
     * giữ gợi ý" mà §16 cấm. Cộng `+ 1 + reserve` khiến mỗi lớp chỉ được tiêu
     * khi slot dành cho các lớp ưu tiên CAO HƠN vẫn còn nguyên.
     */
    const costTurnUsed = decisionTurnUsed.get(turnKey) ?? 0;
    const costSessionUsed = decisionSessionUsed.get(sessionKey) ?? 0;
    const costTurnCap = cfg.maxDecisionCostPerTurn ?? 16;
    const costSessionCap = cfg.maxDecisionCostPerSession ?? 120;
    const categoryUsed = category === 'review' ? (reviewSessionUsed.get(sessionKey) ?? 0)
      : category === 'jg' ? (grepSessionUsed.get(sessionKey) ?? 0) : sessionUsed;
    const categoryCap = category === 'review' ? (cfg.reviewMaxPerSession ?? 20)
      : category === 'jg' ? (cfg.jevGrepMaxPerSession ?? 10) : sessionCap;
    const usage = { priority, turnKey, sessionKey, turnUsed, sessionUsed, turnCap, sessionCap,
      reserve, category, categoryUsed, categoryCap, cost, costTurnUsed, costSessionUsed,
      costTurnCap, costSessionCap };
    if (category === 'direct' && turnUsed + 1 + reserve > turnCap) {
      return { ...usage, allowed: false, reason: 'turn_budget', budget: 'direct' };
    }
    if (category === 'direct' && sessionUsed + 1 + reserve > sessionCap) {
      return { ...usage, allowed: false, reason: 'session_budget', budget: 'direct' };
    }
    if (category !== 'direct' && categoryUsed + 1 > categoryCap) {
      return { ...usage, allowed: false, reason: `${category}_session_budget`, budget: category };
    }
    if (costTurnUsed + cost + reserve > costTurnCap) {
      return { ...usage, allowed: false, reason: 'turn_cost_budget', budget: 'total' };
    }
    if (costSessionUsed + cost + reserve > costSessionCap) {
      return { ...usage, allowed: false, reason: 'session_cost_budget', budget: 'total' };
    }
    return { ...usage, allowed: true, reason: 'admitted', budget: 'total' };
  };
  const budgetSpend = (verdict, agent, turn, layer) => {
    if (!verdict.allowed) return;
    /**
     * Safety KHÔNG tiêu ngân sách không-an-toàn — chỉ các lớp khác mới tiêu.
     *
     * Gate chạy cho MỌI lệnh shell và không bao giờ bị chặn, nên nếu nó cộng vào
     * cùng bộ đếm thì một turn nhiều lệnh sẽ đốt hết trần `jevMaxCallsPerTurn`
     * (log vận hành từng ghi `turnUsed=29` với trần 4) và âm thầm tắt
     * `completion_check`/effort — đúng kiểu "hy sinh lớp ưu tiên cao" mà §16 cấm.
     *
     * Số lần gate gọi Jev vẫn quan sát được: mỗi lần đều ghi một dòng
     * `destructive_gate` trong `decisions.jsonl`, nên không cần bộ đếm riêng.
     */
    if (verdict.priority === 'safety') return;
    const sessionKey = verdict.sessionKey ?? (sessionKeyOf(agent) ?? agent?.id ?? 'agent');
    const turnKey = verdict.turnKey ?? `${sessionKey}:${Number.isSafeInteger(turn) ? turn : -1}`;
    const category = verdict.category ?? 'direct';
    const touch = (map, key, amount) => {
      const value = (map.get(key) ?? 0) + amount;
      map.delete(key);
      map.set(key, value);
      evictOldest(map);
    };
    touch(decisionTurnUsed, turnKey, verdict.cost ?? 1);
    touch(decisionSessionUsed, sessionKey, verdict.cost ?? 1);
    if (category === 'review') touch(reviewSessionUsed, sessionKey, 1);
    if (category === 'jg') touch(grepSessionUsed, sessionKey, 1);
    if (category !== 'direct') return;
    touch(budgetTurnUsed, turnKey, 1);
    /**
     * `delete` + `set` đưa session ĐANG tiêu về CUỐI Map trước khi evict.
     *
     * Cùng lý do như `seenFor`: `evictOldest` xoá từ ĐẦU (FIFO), nên một session
     * hoạt động lâu nhưng được chèn sớm sẽ bị đẩy ra trước một session chết mới
     * chèn — và khi entry bị xoá, bộ đếm session của nó về 0, tức ngân sách
     * session bị RESET âm thầm (một lỗ rò đúng loại §16 sinh ra để bịt). Chạm
     * vào entry mỗi lần tiêu khiến eviction chỉ rơi vào session đã im lặng.
     *
     * Phải ĐỌC giá trị TRƯỚC khi xoá: đọc sau `delete` luôn ra 0 và bộ đếm sẽ
     * kẹt ở 1 — ngân sách session không bao giờ cạn.
     */
    const spent = (budgetSessionUsed.get(sessionKey) ?? 0) + 1;
    budgetSessionUsed.delete(sessionKey);
    budgetSessionUsed.set(sessionKey, spent);
    evictOldest(budgetSessionUsed);
  };

  // Check and pre-spend synchronously before any network/tool await.
  const takeDecisionCost = (agent, turn, layer, cost) => {
    const category = layer === 'quality_review' ? 'review' : layer === 'jevgrep' ? 'jg' : 'direct';
    const units = category === 'review' ? 2 : category === 'jg' ? (cost === 3 ? 3 : 8) : 1;
    const verdict = budgetAllows(agent, turn, layer, category, units);
    budgetSpend(verdict, agent, turn, layer);
    if (verdict.priority !== 'safety' && cfg.jevBudgetEnabled) {
      record({ type: 'cost_governor', layer, turn, ...verdict,
        decision: verdict.allowed ? 'reserved_cost' : 'skip_budget', category, cost: units }, agent);
    }
    return verdict;
  };
  const stoppingSignal = (signal, timeoutMs) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal && !signal.aborted ? AbortSignal.any([signal, timeout]) : timeout;
  };

  const jevClient = createJev({
    getApiKey: async () => (await ctx.credentials.resolve('TYPESAFE_API_KEY'))?.value,
    timeoutMs: cfg.gateTimeoutMs,
    record,
  });
  const jev = {
    model: jevClient.model,
    dispose: jevClient.dispose,
    /**
     * Cổng ngân sách trước mỗi call. Cạn ngân sách → KHÔNG gọi model, ghi log
     * `jev_budget` với `layer`/`decision`, rồi ném `JevBudgetError`.
     *
     * Ném (thay vì trả kết quả giả) là CỐ Ý: mọi call site đã có nhánh catch
     * "fail-open + dùng mặc định an toàn" cho tình huống Jev không trả lời được
     * — ngân sách cạn đúng là một dạng đó, nên lớp lùi về mặc định của nó mà
     * KHÔNG cần sửa từng call site. Không bao giờ bịa một câu trả lời giả để
     * lách ngưỡng.
     */
    evaluate: async (input, options = {}) => {
      const { agent, layer } = options;
      const turn = Number.isSafeInteger(options.turn) ? options.turn : currentTurnOf(agent);
      const verdict = takeDecisionCost(agent, turn, layer, 1);
      if (!verdict.allowed) {
        record({
          type: 'jev_budget',
          layer,
          priority: verdict.priority,
          decision: 'skip_budget',
          reason: verdict.reason,
          turn,
          turnUsed: verdict.turnUsed,
          turnCap: verdict.turnCap,
          sessionUsed: verdict.sessionUsed,
          sessionCap: verdict.sessionCap,
          reserve: verdict.reserve,
        }, agent);
        const error = new Error(
          `Jev budget exhausted (${verdict.reason}) for layer ${layer}; `
          + `turn ${verdict.turnUsed}/${verdict.turnCap}, session ${verdict.sessionUsed}/${verdict.sessionCap}`,
        );
        error.name = 'JevBudgetError';
        throw error;
      }
      return jevClient.evaluate(input, options);
    },
  };
  ctx.effect(() => jev.dispose);

  /**
   * CỜ ĐIỀU PHỐI LỚP 2 → LỚP 7 (P0, §10).
   *
   * `agent/turn-stopping` được dispatch TUẦN TỰ theo thứ tự đăng ký: Lớp 2
   * (đăng ký trước) chạy xong mới tới Lớp 7. Khi Lớp 2 quyết định turn CHƯA
   * xong và `steer` thêm việc, turn KHÔNG kết thúc — nhưng Lớp 7 vẫn được gọi
   * ngay sau đó trong CÙNG một lượt dispatch, nên nó sẽ review một diff dở
   * dang: vô nghĩa và tốn tiền.
   *
   * Cờ này ghi lại đúng lượt mà Lớp 2 vừa steer; Lớp 7 đọc rồi XOÁ (one-shot)
   * nên nó chỉ chặn đúng lần turn-stopping ngay sau một lần "continue", không
   * khoá turn vĩnh viễn. Khoá theo `agentId:turn` như ngân sách của hai lớp.
   * Vẫn `evictOldest` phòng trường hợp Lớp 7 tắt (khi đó không ai xoá cờ).
   */
  const continuedTurns = new Map();

  /**
   * §22 — NGÂN SÁCH VĂN BẢN PLUGIN CHÈN VÀO CONTEXT MỖI TURN.
   *
   * Sáu lớp đều chèn text (L4 approach, L5 file, L6 recovery, L8 jevgrep, L2
   * completion, L7 review). Mỗi mảnh 100–300 token; một turn dài cộng dồn thành
   * hàng nghìn token nhiễu. Mọi điểm chèn đi qua `admitContext`, hàm này trừ dần
   * hạn mức `maxPluginContextTokensPerTurn` của turn và trả về mảnh nào được
   * phép chèn.
   *
   * Bất biến: mảnh `safety`/`consent`/`real_user` KHÔNG BAO GIỜ bị bỏ — cạn hạn
   * mức không được biến một ràng buộc an toàn thành im lặng. Phần còn lại cắt
   * theo ưu tiên `recovery > completion > evidence > advisory`, mảnh bị bỏ ghi log.
   */
  const contextUsed = new Map();
  /**
   * §22 "semantic dedup — không bao giờ chèn cùng một gợi ý hai lần": khoá theo
   * turn, lưu vân tay nội dung đã chèn. L4 (approach) và L5 (bằng chứng) chèn ở
   * CÙNG một handler nên có thể trùng nhau; L8 pre-step/post-execute cũng có thể
   * phát lại cùng một hint. So khớp trên vân tay chuẩn hoá (bỏ khoảng trắng thừa,
   * hạ chữ) để hai chuỗi khác định dạng nhưng cùng nội dung vẫn bị coi là trùng.
   */
  const contextSeen = new Map();
  const contextReserved = new Map();
  const reserveReviewContext = (agent, turn) => {
    const key = agentTurnKey(agent, turn);
    const tokens = Math.max(6, Math.floor(cfg.reviewContextReserveTokens ?? 120));
    const held = contextReserved.get(key) ?? 0;
    if ((contextUsed.get(key) ?? 0) + held + tokens > cfg.maxPluginContextTokensPerTurn) return undefined;
    contextReserved.set(key, held + tokens);
    return { key, tokens, active: true };
  };
  const releaseReviewContext = (reservation) => {
    if (!reservation?.active) return;
    reservation.active = false;
    const left = (contextReserved.get(reservation.key) ?? 0) - reservation.tokens;
    if (left > 0) contextReserved.set(reservation.key, left);
    else contextReserved.delete(reservation.key);
  };
  const admitContext = (agent, turn, items, reservation) => {
    const key = agentTurnKey(agent, turn);
    const spent = contextUsed.get(key) ?? 0;
    const reserved = reservation?.active && reservation.key === key;
    const remaining = reserved ? reservation.tokens
      : Math.max(0, cfg.maxPluginContextTokensPerTurn - spent - (contextReserved.get(key) ?? 0));
    const seen = contextSeen.get(key) ?? new Set();
    const { fresh, deduped } = reserved ? { fresh: items, deduped: 0 }
      : dedupeInjection(items, new Set(seen));
    if (!fresh.length) {
      if (deduped) {
        record({ type: 'context_budget', turn, used: spent, cap: cfg.maxPluginContextTokensPerTurn, deduped }, agent);
      }
      return { kept: [], dropped: [], used: 0 };
    }
    /**
     * L4/L5 (`advisory`/`evidence`) chèn ở step 1, TRƯỚC khi biết turn này có
     * gặp lỗi (`recovery`) hay dừng non (`completion`) hay không. Nếu chúng ăn
     * hết hạn mức thì gợi ý phục hồi — hạng cao hơn — bị đẩy ra ngoài, ngược
     * §22. Nên lượt chỉ có hạng dưới `completion` bị giới hạn ở NỬA trần turn;
     * `recovery`/`completion`/`safety` dùng trọn phần còn lại.
     */
    const highest = fresh.reduce(
      (max, entry) => Math.max(max, CONTEXT_PRIORITY[entry?.kind] ?? CONTEXT_PRIORITY.advisory),
      CONTEXT_PRIORITY.advisory,
    );
    const reserve = reserved || highest >= CONTEXT_PRIORITY.completion
      ? 0
      : Math.min(Math.floor(cfg.maxPluginContextTokensPerTurn / 2), remaining);
    const plan = planInjection(fresh, remaining, reserve);
    releaseReviewContext(reserved ? reservation : undefined);
    for (const entry of plan.kept) {
      if ((CONTEXT_PRIORITY[entry.kind] ?? 0) >= CONTEXT_PRIORITY.completion) continue;
      const print = fingerprintOf(entry.text);
      if (print) seen.add(print);
    }
    contextSeen.set(key, seen);
    evictOldest(contextSeen);
    contextUsed.set(key, spent + plan.used);
    evictOldest(contextUsed);
    const truncated = plan.kept.filter((entry) => entry.truncated).map((entry) => entry.kind);
    if (plan.dropped.length || truncated.length || deduped) {
      record({
        type: 'context_budget',
        turn,
        used: spent + plan.used,
        cap: cfg.maxPluginContextTokensPerTurn,
        ...(plan.dropped.length ? { dropped: plan.dropped.map((entry) => entry.kind) } : {}),
        ...(truncated.length ? { truncated } : {}),
        ...(deduped ? { deduped } : {}),
      }, agent);
    }
    return plan;
  };

  /**
   * P0.3 — SÀN THIÊN TAI, LỚP THỨ HAI: `ctx.tools.guard` (monotonic).
   *
   * Lớp 1 đã có sàn tất định trong `tools/pre-execute`, nhưng đó là một
   * waterfall: listener đăng ký SAU có thể ghi đè quyết định `deny` của nó.
   * `ctx.tools.guard` là monotonic — DSH chạy guard SAU toàn bộ waterfall
   * (`dsh-tools/lib/index.js`: `const denialReason = decision.kind === "allow"
   * ? this.guardReason(exec) : decision.reason;`) và "no guard can force-allow a
   * call another guard denied". Nên đây là chốt chặn không thể bị vượt qua từ
   * bên trong pipeline pre-execute.
   *
   * Vì sao cần lớp hai dù đã có lớp một: gate dựa vào Jev, mà Jev đã fail
   * 252/6.442 lần (3,9%); chỉ cần một lần lỗi rơi vào nhánh mở là `rm -rf /`
   * chạy thẳng. Sàn này thuần cú pháp — không mạng, không Jev, không fail-open.
   *
   * Guard là hàm ĐỒNG BỘ nhận `exec` (đã parse, deep-freeze) và trả về chuỗi
   * để TỪ CHỐI (không trả gì = cho qua). Danh sách cố ý hẹp (xem
   * `catastrophic.mjs`): `rm -rf /tmp/x` và `rm -rf node_modules` vẫn qua.
   * Tôn trọng `enableCatastrophicFloor: false` (tắt hẳn sàn, như Lớp 1).
   * Thiếu `ctx.tools.guard` (host cũ, hoặc test không cấp tools) → im lặng bỏ
   * qua, không làm plugin chết.
   */
  if (cfg.enableCatastrophicFloor && typeof ctx.tools?.guard === 'function') {
    const disposeCatastrophicGuard = ctx.tools.guard((exec) => {
      const command = rawCommandOf(exec.name, exec.arguments);
      if (command === undefined) return undefined;
      const catastrophic = catastrophicMatch(command);
      if (catastrophic === undefined) return undefined;
      record({
        type: 'destructive_gate',
        tool: exec.name,
        decision: 'deny_catastrophic',
        layer: 'guard',
        pattern: catastrophic,
        command: clip(command, 400).text,
      }, exec.agent);
      return `Blocked by the deterministic catastrophic floor (pattern: ${catastrophic}). `
        + 'This command destroys data at the system level and cannot be recovered by '
        + 'ordinary means. The body was not executed. This guard is monotonic: it runs '
        + 'after every `tools/pre-execute` listener, and no later listener can allow it back.';
    });
    // Gắn vòng đời guard vào fiber của plugin để HMR/gỡ plugin không để lại rác.
    if (typeof disposeCatastrophicGuard === 'function') ctx.effect(() => disposeCatastrophicGuard);
  }

  /* ─── LỚP 4+5: chọn hướng tiếp cận + nạp file nào (một lần gọi Jev) ─── */
  /**
   * Ở step 1, hỏi Jev hai thứ trong CÙNG một request:
   *
   *   - `approach` (Lớp 4): hướng tiếp cận nào tối ưu nhất cho task?
   *   - `file_N` (Lớp 5): mỗi file ứng viên có cần đọc không?
   *
   * Gộp vì API Jev chấm song song các câu trong một request: 1 lần gọi trả cả
   * hai, nên Lớp 5 gần như không thêm độ trễ so với chỉ hỏi Lớp 4.
   *
   * Lớp 4 là `choice` chứ không phải `noul` (như bản đầu). Lý do là một lỗ hổng
   * đo được: với câu hỏi nhị phân "có nên spawn không?", khi đáp án là "không"
   * thì plugin IM LẶNG — model không nhận được gì, kể cả thông tin hữu ích như
   * "việc này chỉ cần một lệnh". Task scan ổ đĩa nhận p=0.21 → im lặng, trong
   * khi đúng ra nên nói "dùng một lệnh duy nhất". `choice` luôn cho một hướng.
   *
   * Lớp 5 là N câu `noul` độc lập chứ không một `choice` nhiều nhánh: danh sách
   * file sinh động theo từng repo, mà `choice.criteria` phải cố định trong code.
   * Plugin tự liệt kê ứng viên, Jev chỉ chấm, host so ngưỡng rồi cắt số lượng —
   * đúng mô hình "typed result mà host kiểm trước khi chạy".
   *
   * Vì sao chỉ GỢI Ý chứ không tự làm: API `agent` chỉ phơi `steer()` /
   * `followup()` / `send()` — không có cách gọi tool trực tiếp. Nên plugin chỉ
   * chèn được message, model tự quyết. Đây là giới hạn cứng của DSH, không phải
   * lựa chọn thiết kế.
   *
   * Chỉ chạy ở `step === 1` (mỗi turn một lần) — nếu không guard, mỗi step sẽ
   * chèn thêm một lời gợi ý và làm đầy context.
   */
  const hintedTurns = new Set();
  ctx.on('agent/pre-step', async ({ messages, turn, step, signal, agent }, next) => {
    notePrompt(agent, messages);
    if (agent) noteSession(agent);
    if (!cfg.enableSpawnHint && !cfg.enableContextTriage) return next();
    if (step !== 1) return next();

    const decision = await next();
    // Chỉ chèn khi step này thật sự vào (không bị chặn) và có message để đọc.
    if (decision?.kind !== 'enter') return decision;
    const hintedKey = agentTurnKey(agent, turn);
    if (hintedTurns.has(hintedKey)) return decision;
    evictOldest(hintedTurns);

    const task = clip(taskOf(agent, '') ?? '', 1_500).text;
    if (!task.trim()) return decision;

    /**
     * Ứng viên file chỉ liệt kê khi Lớp 5 bật. Danh sách rỗng vẫn hợp lệ: khi
     * đó request chỉ còn câu `approach`, đúng như hành vi cũ.
     */
    /**
     * §8 Stage 1+2: liệt kê ứng viên (tất định), rồi trích ĐOẠN BẰNG CHỨNG rẻ từ
     * chính file đó (imports/exports/dòng khớp task). Jev nhận cả hai trong
     * `state`, nên câu hỏi Lớp 5 không còn là "đoán theo tên file".
     */
    const contextRoot = cfg.enableContextTriage ? workspaceRootOf(agent, sessionOf(agent)) : undefined;
    const candidates = contextRoot
      ? await listCandidateFiles(contextRoot, cfg.contextCandidateLimit, task)
      : [];
    const evidence = cfg.enableContextTriage && cfg.contextEvidence && candidates.length
      ? await collectFileEvidence(contextRoot, candidates, tokenize(task))
      : {};

    let verdict;
    try {
      verdict = await jev.evaluate(
        preStepQuestion({
          task,
          candidates,
          evidence,
          includeApproach: cfg.enableSpawnHint,
        }),
        { signal, timeoutOverrideMs: cfg.contextTimeoutMs, agent, turn, layer: 'approach_context' },
      );
    } catch (error) {
      record({
        type: 'pre_step',
        turn,
        decision: 'fail_open',
        error: describeError(error),
      }, agent);
      return decision;
    }

    const injected = [];
    const logged = { type: 'pre_step', turn, candidates: candidates.length };

    if (cfg.enableSpawnHint) {
      const answer = verdict.answers.approach;
      const approach = answer?.choice;
      const confidence = answer?.confidence;
      const probabilities = answer?.probabilities;
      /**
       * Xếp hạng phân phối xác suất của câu `choice` (API luôn trả đủ
       * `probabilities` cho mọi nhánh, tổng ~1).
       */
      const ranked = probabilities && typeof probabilities === 'object'
        ? Object.entries(probabilities)
          .filter(([, p]) => typeof p === 'number')
          .sort((a, b) => b[1] - a[1])
        : [];
      if (typeof approach !== 'string') {
        logged.approach = 'fail_open';
      } else if (ranked.length >= 2) {
        /**
         * CỔNG BẰNG CHỨNG (mặc định): chỉ chèn khi phân phối cho thấy một
         * hướng THẮNG RÕ — đỉnh vượt ngưỡng VÀ bỏ xa nhì một khoảng margin.
         *
         * Vì sao không dùng `confidence`: đo trên log thật, conf KHÔNG tương
         * quan với đúng/sai (case đúng conf 0.24, case sai conf 0.44) nên nó
         * lọc được rất ít. Phân phối giữa các nhánh mới là thứ phân biệt
         * "Jev thực sự nghiêng về một hướng" với "Jev đoán bừa". Khi bằng
         * chứng không đủ, IM LẶNG an toàn hơn gợi ý — một gợi ý sai ở step 1
         * neo model vào hướng sai.
         */
        const [topKey, topProb] = ranked[0];
        const margin = topProb - ranked[1][1];
        if (topKey !== approach) {
          // `choice` không khớp argmax của phân phối → dữ liệu tự mâu thuẫn.
          logged.approach = 'fail_open';
          logged.error = 'choice_probability_mismatch';
        } else if (approach === 'no-op') {
          // Jev tự khai "không đủ bằng chứng" → tôn trọng, im lặng.
          logged.approach = 'silent_no_op';
          logged.approachChoice = approach;
          logged.topProbability = Number(topProb.toFixed(3));
          logged.margin = Number(margin.toFixed(3));
        } else if (!APPROACH_ADVICE[approach]) {
          logged.approach = 'fail_open';
          logged.error = 'unknown approach';
        } else if (topProb < cfg.approachTopProbability) {
          logged.approach = 'silent_insufficient_evidence';
          logged.approachChoice = approach;
          logged.topProbability = Number(topProb.toFixed(3));
          logged.margin = Number(margin.toFixed(3));
        } else if (margin < cfg.approachProbabilityMargin) {
          logged.approach = 'silent_ambiguous';
          logged.approachChoice = approach;
          logged.topProbability = Number(topProb.toFixed(3));
          logged.margin = Number(margin.toFixed(3));
        } else {
          logged.approach = 'hinted';
          logged.approachChoice = approach;
          logged.confidence = confidence;
          logged.topProbability = Number(topProb.toFixed(3));
          logged.margin = Number(margin.toFixed(3));
          injected.push({
            kind: 'advisory',
            text: `Jev suggests how to approach this task (${approach}): ${APPROACH_ADVICE[approach]} `
              + 'If that does not fit what you are actually seeing, ignore it and proceed as you judge best.',
          });
        }
      } else if (typeof confidence !== 'number') {
        logged.approach = 'fail_open';
      } else if (confidence < cfg.approachConfidenceThreshold) {
        /**
         * ĐƯỜNG LÙI (chỉ khi response không kèm `probabilities`): dùng ngưỡng
         * confidence cũ làm lưới an toàn. Giữ lại để không phá các stub/phiên
         * bản API cũ trả thiếu phân phối.
         */
        logged.approach = 'silent_low_confidence';
        logged.approachChoice = approach;
        logged.confidence = confidence;
      } else if (!APPROACH_ADVICE[approach]) {
        logged.approach = 'fail_open';
        logged.error = 'unknown approach';
      } else {
        logged.approach = 'hinted';
        logged.approachChoice = approach;
        logged.confidence = confidence;
        injected.push({
          kind: 'advisory',
          text: `Jev suggests how to approach this task (${approach}, confidence `
            + `${confidence.toFixed(2)}): ${APPROACH_ADVICE[approach]} `
            + 'If that does not fit what you are actually seeing, ignore it and proceed as you judge best.',
        });
      }
    }

    if (cfg.enableContextTriage && candidates.length) {
      const picked = [];
      candidates.forEach((path, index) => {
        const answer = verdict.answers[`file_${index}`];
        const p = answer?.noul;
        if (typeof p !== 'number') return;
        if (p >= cfg.contextFileThreshold) picked.push({ path, p });
      });
      // Xếp theo xác suất giảm dần rồi cắt: gửi 12 file "có thể cần" cũng là
      // đốt token, mà mục tiêu của lớp này là GIẢM token đầu vào.
      picked.sort((a, b) => b.p - a.p);
      const keep = picked.slice(0, cfg.contextMaxFiles);
      logged.context = keep.length ? 'hinted' : 'none_needed';
      logged.files = keep.map((entry) => ({ path: entry.path, p: Number(entry.p.toFixed(2)) }));
      if (keep.length) {
        /**
         * §8 Stage 4: chèn ĐOẠN BẰNG CHỨNG, không chỉ tên file. Bản cũ chỉ nêu
         * tên nên agent phải tự mở file để biết nó có liên quan không — log thật
         * cho thấy danh sách tên KHÔNG đổi hành vi. Kèm imports/exports/dòng khớp
         * task thì agent quyết được ngay mà không cần đọc lại.
         */
        const blocks = keep.map((entry) => {
          const excerpt = evidence[entry.path];
          const header = `${entry.path} (p=${entry.p.toFixed(2)})`;
          // `collectFileEvidence` đã định dạng sẵn thành chuỗi nhiều dòng; dùng
          // nguyên văn để `state` gửi Jev và phần chèn cho agent không thể lệch.
          const detail = excerpt ?? '';
          return detail ? `${header}\n${detail}` : header;
        });
        const withoutEvidence = keep.filter((entry) => !evidence[entry.path]).map((entry) => entry.path);
        injected.push({
          /**
           * `kind: 'evidence'` (không phải `advisory`): đoạn trích thật là thứ
           * đáng giá nhất của Lớp 5, phải xếp TRÊN gợi ý approach chung. Nếu để
           * cùng bậc `advisory`, gợi ý approach chèn trước sẽ thắng first-come và
           * đẩy bằng chứng ra ngoài ở trần mặc định 500 (đo thật: 84 + 171 > 250).
           * `truncatable: true` để khi chật ngân sách nó bị CẮT NGẮN chứ không bị
           * bỏ hẳn — một đoạn trích ngắn vẫn là bằng chứng.
           */
          kind: 'evidence',
          truncatable: true,
          /**
           * Câu miễn trừ (§23) đặt ở ĐẦU khối, không phải cuối: khi bị cắt ngắn
           * vì chật ngân sách, phần đuôi mất trước — mà một gợi ý advisory thiếu
           * câu "đây chỉ là gợi ý" sẽ bị đọc như mệnh lệnh.
           */
          text: wrapRepositoryEvidence(`${blocks.join('\n')}\n`
            + (withoutEvidence.length
              ? `(No local excerpt was available for: ${withoutEvidence.join(', ')} — those are name-only hints.) `
              : '')),
        });
      }
    }

    hintedTurns.add(hintedKey);
    if (!injected.length) {
      record(logged, agent);
      return decision;
    }

    /**
     * §22: L4 (`approach`) là `advisory`, L5 (`file` kèm bằng chứng) là
     * `evidence` — hạ tầng Lớp 1 (safety) không đi qua đường này. Cạn hạn mức thì
     * mảnh hạng thấp bị bỏ (có log); riêng bằng chứng file bị CẮT NGẮN chứ không
     * bỏ hẳn, vì nó là thứ đáng giá nhất của Lớp 5.
     */
    const admission = admitContext(agent, turn, injected.map((entry) => ({
      kind: entry.kind,
      text: entry.text,
      truncatable: entry.truncatable === true,
    })));
    const keptText = admission.kept.map((entry) => entry.text).join('\n\n');
    if (!keptText) {
      record({ ...logged, decision: 'hinted', context: 'budget_dropped' }, agent);
      return decision;
    }

    record({ ...logged, decision: 'hinted' }, agent);
    return {
      ...decision,
      messages: [
        ...(decision.messages ?? []),
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: keptText }],
          source: { kind: SOURCE_KIND },
        },
      ],
    };
  });

  /* ───────────────────────── Lớp 1: gate phá dữ liệu ───────────────────────── */
  if (cfg.enableDestructiveGate) {
    /**
     * Cache verdict tất định của Lớp 1 — xem `enableGateVerdictCache` ở DEFAULTS.
     *
     * Khoá: `${tool}\u0000${command}\u0000${cwd}\u0000${declaredWorkdir}`.
     * Dùng `\u0000` (NUL) làm dấu phân cách vì command/cwd là chuỗi tuỳ ý có thể
     * chứa `|`/`:`; NUL không thể có trong `exec.arguments.command` (JSON string
     * từ engine) nên hai bộ khoá khác nhau KHÔNG THỂ va nhau bằng cách dịch dấu
     * phân cách.
     *
     * `command` giữ NGUYÊN VĂN (byte-identical), không trim/collapse — chuẩn hoá
     * là nguồn lỗi.
     *
     * ## Vì sao cache TOÀN CỤC, không theo session
     *
     * `p` là phán đoán về **hành động** (chạy đúng chuỗi lệnh này trong đúng cwd
     * này có phá dữ liệu không) — nó KHÔNG phụ thuộc hội thoại. Thứ phụ thuộc
     * session là quyền của user (Lớp 1b), và Lớp 1b KHÔNG được cache: nó chạy lại
     * trên mỗi lần gọi. Nên dùng chung verdict `p` giữa các session không rò state
     * riêng của phiên nào.
     *
     * Đo trên log thật (`decisions.jsonl`, 11.854 dòng gate, 3.354 dòng Jev-eligible):
     * khoá toàn cục `(tool,command)` tiết kiệm **7,63%** call; thêm session vào
     * khoá chỉ còn **1,94%** — vì phần lớn lệnh trùng nằm ở CÙNG một phiên dài
     * (agent chạy `rtk node --test` 31 lần, `rm -rf /tmp/gtest` 17 lần). Theo
     * session là mất phần lớn lợi ích mà không thêm an toàn nào.
     *
     * `declaredWorkdir` nằm trong câu hỏi gửi Jev (`destructiveQuestion`) nên phải
     * nằm trong khoá: hai lệnh cùng chuỗi nhưng khác `workdir` là hai hành động
     * khác nhau, phải là hai entry (và đó là phía AN TOÀN — miss, không hit sai).
     *
     * ## Vì sao khoá này là ĐÚNG khoá an toàn
     *
     * `destructiveQuestion` chỉ gửi cho Jev `{tool, command, working_directory,
     * declared_workdir}` (cộng một `note` tĩnh), và `agent` KHÔNG vào request body
     * (`jev-client.mjs`: `agent` chỉ dùng để ghi log). Nên khoá cache trùng khít
     * với payload gửi Jev — hai lần cùng khoá là hai request giống hệt nhau, tức
     * cùng phân phối verdict. Đây là lý do không cần thêm session vào khoá.
     */
    const gateVerdictCache = new Map();
    const gateCacheKeyOf = (tool, command, cwd, declaredWorkdir) =>
      `${tool}\u0000${command}\u0000${cwd}\u0000${declaredWorkdir ?? ''}`;

    /**
     * Jev KHÔNG trả lời được (lỗi mạng/timeout/key, hoặc trả thiếu `noul`) cho
     * một lệnh đã lọt qua prefilter chỉ-đọc và sàn catastrophic.
     *
     * P0.2: trước đây nhánh này là `fail_open` cố định — lệnh đi tiếp như chưa
     * từng có gate. Sàn catastrophic chỉ bịt được `rm -rf /`, KHÔNG bịt được
     * `rm -rf ~/projects/customer-data`. Vì vậy mặc định nay là `ask`.
     *
     * Xem `gateFailureMode` ở DEFAULTS cho ba chế độ. Bất biến: cả ba nhánh đều
     * ghi log, và `ask` KHÔNG BAO GIỜ cho qua khi không lấy được đồng ý thật.
     */
    const onJevOutage = async ({ exec, command, next, reason }) => {
      if (exec.signal?.aborted) {
        record({ type: 'destructive_gate', tool: exec.name, decision: 'deny_outage', gate_failure: 'cancelled', command: clip(command, 400).text }, exec.agent);
        return {
          kind: 'deny',
          reason: 'The tool call was cancelled before Jev could classify it; the command was not executed.',
          info: { name: 'JevGateCancelled', code: 'JEV_GATE_UNAVAILABLE' },
        };
      }
      const requested = cfg.gateFailureMode ?? 'ask';
      /**
       * `ask` cần kênh thẻ đồng ý. Nếu operator đã TẮT thẻ
       * (`enableDestructiveConsent: false`) thì không còn kênh nào để hỏi, nên
       * `ask` thoái hoá thành `block` — vẫn fail-closed, và nhất quán với đường
       * chính (tắt consent → chặn cứng `JEV_DESTRUCTIVE`, không mở thẻ).
       */
      const mode = requested === 'ask' && !cfg.enableDestructiveConsent ? 'block' : requested;
      if (mode === 'auto_allow') {
        // Hành vi fail-open cũ. Giữ nguyên tên quyết định `fail_open` để chỉ số
        // `gate_useful_ratio` (lib/metrics.mjs) vẫn đọc được nhánh này.
        record({ type: 'destructive_gate', tool: exec.name, decision: 'fail_open', error: reason }, exec.agent);
        return next();
      }
      if (mode === 'block') {
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'deny',
          gate_failure: 'block',
          ...(requested !== mode ? { gate_failure_requested: requested } : {}),
          error: reason,
          command: clip(command, 400).text,
        }, exec.agent);
        const why = requested !== mode
          ? `gateFailureMode is "ask" but the consent card is disabled (enableDestructiveConsent: false)`
          : `gateFailureMode is "block"`;
        return {
          kind: 'deny',
          reason:
            `Jev is unavailable (${reason}) and ${why}, so this ${exec.name} `
            + 'call cannot be cleared. The body was not executed. If the action is genuinely '
            + 'intended, ask the user to confirm that exact target, then reissue it.',
          info: { name: 'JevGateUnavailable', code: 'JEV_GATE_UNAVAILABLE', error: reason },
        };
      }
      // `ask` (mặc định) — cùng kênh hỏi và cùng ngữ nghĩa fail-closed như Lớp 1b.
      // Subagent / thiếu kênh hỏi / hết hạn / từ chối → `unavailable`/`refused` → CHẶN.
      const consent = await askDestructiveConsent(ctx, exec, command, cfg.consentTimeoutMs);
      if (consent.decision === 'approved') {
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'allow_consented',
          gate_failure: 'ask',
          error: reason,
          command: clip(command, 400).text,
        }, exec.agent);
        return next();
      }
      record({
        type: 'destructive_gate',
        tool: exec.name,
        decision: 'deny_consent',
        gate_failure: 'ask',
        consent: consent.decision,
        ...(consent.reason ? { consent_reason: consent.reason } : {}),
        error: reason,
        command: clip(command, 400).text,
      }, exec.agent);
      const why = consent.decision === 'refused'
        ? `the user did not approve it (${consent.reason ?? 'refused'})`
        : `no consent channel was available (${consent.reason ?? 'unavailable'})`;
      return {
        kind: 'deny',
        reason:
          `Jev is unavailable (${reason}) and this ${exec.name} call cannot be proven safe, so it `
          + `was held for consent and ${why}. The body was not executed. A destructive action is `
          + 'only run with the user\'s explicit approval; silence is not approval.',
        info: {
          name: 'JevGateUnavailable',
          code: 'JEV_CONSENT_DENIED',
          consent: consent.decision,
          error: reason,
        },
      };
    };

    ctx.on('tools/pre-execute', async (exec, next) => {
      noteSession(exec.agent);
      const command = rawCommandOf(exec.name, exec.arguments);
      if (command === undefined) return next();

      /**
       * Prefilter cục bộ: lệnh chứng minh được là chỉ-đọc thì KHÔNG cần hỏi Jev.
       *
       * Đo trên log thật (2026-09-27 → 09-30): 5.675 call `destructive_gate`,
       * **80,7%** có `p ≤ 0.02` — tức phần lớn là round-trip API để nghe lại
       * điều suy ra được bằng phân tích cú pháp. Trần phủ sót đo trên 3.197
       * lệnh bash thật của máy này: **37,4%**.
       *
       * Đây KHÔNG phải nới lỏng bảo vệ: `isProvablyReadOnly` chỉ trả `true` khi
       * chứng minh được, và mọi nghi ngờ (heredoc, backtick, redirect ghi,
       * `$()`, `find -delete`, `sed -i`, trình thông dịch, lệnh lạ) đều rơi
       * xuống đường Jev như cũ. Bất biến an toàn được kiểm bằng corpus 215 lệnh
       * phá dữ liệu trong `tests/offline.mjs`.
       */
      /**
       * SÀN TẤT ĐỊNH — chạy TRƯỚC prefilter và TRƯỚC Jev.
       *
       * Đây là lớp duy nhất trong gate KHÔNG fail-open: nó không gọi mạng, không
       * gọi Jev, không đọc/ghi gì. Vì Jev lỗi 3,9% số lần (đo trên log thật),
       * nếu chỉ dựa vào Jev thì một lần timeout đúng lúc là `rm -rf /` chạy
       * thẳng. Sàn này bịt đúng khoảng đó.
       */
      if (cfg.enableCatastrophicFloor) {
        const catastrophic = catastrophicMatch(command);
        if (catastrophic !== undefined) {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'deny_catastrophic',
            pattern: catastrophic,
            command: clip(command, 400).text,
          }, exec.agent);
          return {
            kind: 'deny',
            reason:
              `Blocked by the deterministic catastrophic floor (pattern: ${catastrophic}). `
              + 'This command destroys data at the system level and cannot be recovered by '
              + 'ordinary means. The body was not executed. This check is pure syntax — it does '
              + 'not depend on Jev and cannot fail open.',
            info: { name: 'JevCatastrophicFloor', code: 'JEV_CATASTROPHIC', pattern: catastrophic },
          };
        }
      }

      if (cfg.enableReadOnlyPrefilter && isProvablyReadOnly(command)) {
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'allow_readonly',
          command: clip(command, 400).text,
        }, exec.agent);
        return next();
      }
      if (exec.signal?.aborted) {
        return onJevOutage({ exec, command, next, reason: 'tool call cancelled' });
      }

      const cwd = exec.agent?.cwd
        ?? exec.agent?.session?.cwd
        ?? process.cwd();

      /**
       * Tra cache TRƯỚC khi gọi Jev. `cacheHit` chỉ quyết định có bỏ round-trip
       * hay không; mọi nhánh quyết định phía dưới (ngưỡng, Lớp 1b, thông báo)
       * chạy Y HỆT như khi không cache.
       */
      let cacheHit = false;
      let p;
      const declaredWorkdir = exec.arguments?.workdir;
      if (cfg.enableGateVerdictCache) {
        const key = gateCacheKeyOf(exec.name, command, cwd, declaredWorkdir);
        const cached = gateVerdictCache.get(key);
        if (cached !== undefined) {
          cacheHit = true;
          p = cached;
          // LRU-touch: đưa khoá vừa dùng về cuối Map để `evictOldest` (xoá từ
          // đầu) không đẩy một entry đang hot ra trước entry nguội.
          gateVerdictCache.delete(key);
          gateVerdictCache.set(key, cached);
        }
      }

      if (!cacheHit) {
        let verdict;
        try {
          verdict = await jev.evaluate(
            destructiveQuestion({
              toolName: exec.name,
              command,
              cwd,
              declaredWorkdir,
            }),
            { signal: exec.signal, timeoutOverrideMs: cfg.gateTimeoutMs, agent: exec.agent, layer: 'destructive_gate' },
          );
        } catch (error) {
          const message = describeError(error);
          return onJevOutage({ exec, command, next, reason: message });
        }

        p = verdict.answers.destructive?.noul;
        if (typeof p !== 'number') {
          return onJevOutage({ exec, command, next, reason: 'no noul answer' });
        }
        /**
         * Cache phán đoán `p` — KHÔNG cache fail_open (cả hai nhánh trên đã
         * `return` trước khi tới đây), nên lỗi tạm thời không bao giờ bị đóng
         * băng thành verdict.
         *
         * KHÔNG cache khi `p` nằm sát ngưỡng (`|p − threshold| ≤ margin`): Jev
         * không tất định, nên verdict sát ngưỡng có thể dao động qua lại và cache
         * sẽ đóng băng một `allow` mà lần gieo lại là `deny`. Xem
         * `gateVerdictCacheMargin`.
         */
        const nearThreshold = Math.abs(p - cfg.destructiveThreshold) <= cfg.gateVerdictCacheMargin;
        if (cfg.enableGateVerdictCache && !nearThreshold) {
          gateVerdictCache.set(gateCacheKeyOf(exec.name, command, cwd, declaredWorkdir), p);
          evictOldest(gateVerdictCache, cfg.gateVerdictCacheMax);
        }
      }

      if (Number.isFinite(cfg.shadowGateThreshold) && cfg.shadowGateThreshold >= 0 && cfg.shadowGateThreshold <= 1) {
        record({
          type: 'destructive_gate_shadow',
          tool: exec.name,
          command: clip(command, 400).text,
          threshold: cfg.shadowGateThreshold,
          would_flag: p >= cfg.shadowGateThreshold,
          enforced_threshold: cfg.destructiveThreshold,
          enforced_flag: p >= cfg.destructiveThreshold,
          p,
          cached: cacheHit,
        }, exec.agent);
      }

      if (p < cfg.destructiveThreshold) {
        /**
         * Ghi kèm COMMAND, không chỉ `p`.
         *
         * Vì sao: bản ghi `allow` cũ chỉ có `{tool, decision:'allow', p}` nên
         * KHÔNG thể audit cái gì đã được cho qua — chỉ đếm được số lượng. Đo
         * trên log thật: 5.890 dòng `allow` mà không dòng nào trả lời được
         * "gate có bỏ lọt lệnh nguy hiểm nào không". Không có trường này thì
         * không đo được FNR thật của gate.
         *
         * Cắt 400 ký tự như bản ghi `deny` để giữ log đọc được. Có thể chứa
         * secret nếu lệnh có secret — chấp nhận, vì log đã `mode: 0o600` và bản
         * ghi `deny` vốn đã ghi command từ trước.
         */
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'allow',
          p,
          command: clip(command, 400).text,
          // `cached:true` chỉ xuất hiện khi hit — để đo tỉ lệ hit thật trên log
          // (đếm dòng có trường này / tổng dòng) mà không đổi schema dòng miss.
          ...(cacheHit ? { cached: true } : {}),
        }, exec.agent);
        return next();
      }

      /**
       * Lệnh đã bị coi là phá dữ liệu. Trước khi chặn, kiểm xem user có THẬT SỰ
       * yêu cầu đúng thứ này không — bằng PROVENANCE TẤT ĐỊNH, không hỏi LLM.
       *
       * Vì sao thay câu hỏi LLM (`authorizationQuestion`) bằng so khớp chuỗi:
       *   1. Rẻ hơn: đây là call LLM THỨ HAI trên đường tới hạn, chỉ để suy ra
       *      điều suy được tất định từ hội thoại. Bỏ nó cắt hẳn một round-trip
       *      mỗi lần gate chặn, và bỏ luôn `authorizationTimeoutMs` khỏi đường
       *      quyết định.
       *   2. Tất định: cùng hội thoại + cùng lệnh luôn cho cùng kết quả. LLM có
       *      thể đổi ý giữa hai lần chạy (đo được dao động trên API thật).
       *   3. Đúng hơn ở đúng thứ cần đúng: câu hỏi chỉ là "target của lệnh có
       *      xuất hiện trong lời user không". Một phép so khớp chuỗi con làm
       *      chính xác việc đó; LLM thêm biến thiên mà không thêm thông tin.
       *
       * Chỉ chặn khi hội đủ hai điều: phá dữ liệu VÀ không chứng minh được user
       * yêu cầu. Đây là chỗ sửa đúng phàn nàn "chặn cứng": user bảo xoá thì cho.
       *
       * FAIL-CLOSED ở lớp này: không chứng minh được → KHÔNG cho qua. Trước đây
       * lớp 1 fail-open còn lớp này fail-closed (hai chiều ngược nhau); từ P0.2
       * cả hai đều fail-closed theo mặc định `gateFailureMode: 'ask'`, nên một
       * lần Jev lỗi không còn là đường vòng qua gate. Tắt bằng
       * `enableAuthorizationOverride: false` cũng quay về hành vi chặn cũ.
       */
      if (cfg.enableAuthorizationOverride) {
        // `collectUserRequest` CHỈ lấy tin nhắn thật của user (source.kind ===
        // 'user'), nên nội dung dán/output tool không tự cấp quyền xoá được.
        const userRequest = await collectUserRequest(exec.agent?.session, command);
        const authorized = commandTargetsInUserRequest(userRequest, command);
        if (authorized) {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'allow_authorized',
            p,
            command: clip(command, 400).text,
            ...(cacheHit ? { cached: true } : {}),
          }, exec.agent);
          return next();
        }
      }

      if (!cfg.enableAuthorizationOverride) {
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'deny',
          p,
          command: clip(command, 400).text,
          ...(cacheHit ? { cached: true } : {}),
        }, exec.agent);
        return {
          kind: 'deny',
          reason:
            `Jev flagged this ${exec.name} call as destructive (p=${p.toFixed(2)}, `
            + `threshold ${cfg.destructiveThreshold}). The body was not executed. If the action `
            + 'is genuinely intended, ask the user to confirm that exact target, then reissue it.',
          info: { name: 'JevDestructiveGate', code: 'JEV_DESTRUCTIVE', probability: p },
        };
      }

      /**
       * Không chứng minh được user yêu cầu hành động này. Trước đây chặn cứng;
       * nay HỎI user qua thẻ nổi và CHỜ đồng ý (xem `askDestructiveConsent`).
       *
       * Đây là nhánh "agent tự đề nghị xoá" trong yêu cầu gốc: phải hỏi, và chỉ
       * chạy khi user đồng ý rõ ràng. Timeout/từ chối/thiếu kênh hỏi → CHẶN.
       */
      if (cfg.enableDestructiveConsent) {
        const consent = await askDestructiveConsent(ctx, exec, command, cfg.consentTimeoutMs);
        if (consent.decision === 'approved') {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'allow_consented',
            p,
            command: clip(command, 400).text,
            ...(cacheHit ? { cached: true } : {}),
          }, exec.agent);
          return next();
        }
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'deny_consent',
          p,
          consent: consent.decision,
          ...(consent.reason ? { consent_reason: consent.reason } : {}),
          command: clip(command, 400).text,
          ...(cacheHit ? { cached: true } : {}),
        }, exec.agent);
        const why = consent.decision === 'refused'
          ? `the user did not approve it (${consent.reason ?? 'refused'})`
          : `no consent channel was available (${consent.reason ?? 'unavailable'})`;
        return {
          kind: 'deny',
          reason:
            `Jev flagged this ${exec.name} call as destructive (p=${p.toFixed(2)}, `
            + `threshold ${cfg.destructiveThreshold}) and ${why}. The body was not executed. `
            + 'A destructive action is only run with the user\'s explicit approval; silence is '
            + 'not approval. If the action is genuinely intended, the user must confirm it.',
          info: {
            name: 'JevDestructiveConsent',
            code: 'JEV_CONSENT_DENIED',
            probability: p,
            consent: consent.decision,
          },
        };
      }

      // Consent tắt: giữ nguyên hành vi chặn cứng cũ (FAIL-CLOSED).
      record({
        type: 'destructive_gate',
        tool: exec.name,
        decision: 'deny',
        p,
        authorization: 'not_proven',
        command: clip(command, 400).text,
        ...(cacheHit ? { cached: true } : {}),
      }, exec.agent);
      return {
        kind: 'deny',
        reason:
          `Jev flagged this ${exec.name} call as destructive (p=${p.toFixed(2)}, `
          + `threshold ${cfg.destructiveThreshold}) and the user's own request does not name `
          + 'its target. The body was not executed. If the action is genuinely intended, ask the '
          + 'user to confirm that exact target, then reissue it.',
        info: { name: 'JevDestructiveGate', code: 'JEV_DESTRUCTIVE', probability: p },
      };
    }, { prepend: true });
  }

  /* ──────────── Lớp 6: tool lỗi thì làm gì tiếp (post-execute) ──────────── */
  /**
   * Hook `tools/post-execute` chạy sau khi tool có kết quả, và cả khi Lớp 1 vừa
   * chặn (nhánh deny của pre-execute đi qua `post-result` → finalize, xem
   * `dsh-tools/lib/index.js:3243`). Vì vậy phải tự lọc: một lệnh bị chính Lớp 1
   * chặn KHÔNG phải tool lỗi cần phục hồi — nó đã có thông báo riêng, và hỏi
   * thêm "retry/alternate?" ở đây sẽ mâu thuẫn với quyết định chặn.
   *
   * Cách nhận biết: `result.error.info.code` do plugin tự đặt là `JEV_DESTRUCTIVE`
   * (xem Lớp 1). Có mã đó thì bỏ qua.
   *
   * Gợi ý trả về qua `additionalContexts`, được engine splice vào batch kế tiếp
   * (`dsh-agent-loop/lib/index.js:1139`), nên model thấy nó ở step sau — khác
   * `agent.steer` (chèn vào inbox) nhưng cùng tác dụng.
   *
   * Giới hạn số lần mỗi turn (`failureMaxPerTurn`): nếu không, một lệnh lỗi lặp
   * lại sẽ sinh một gợi ý mỗi lần, đúng cái đang muốn tránh.
   */
  if (cfg.enableFailureRecovery) {
    const failuresSeen = new Map();
    /**
     * ĐẾM VÒNG XOÁY theo chữ ký thất bại, keyed theo session (không toàn cục).
     *
     * Trần `failureMaxPerTurn` chỉ chặn SỐ gợi ý mỗi turn — nó không biết hai lỗi
     * có GIỐNG NHAU không. Không có bộ đếm này thì Jev vẫn có thể khuyên `retry`
     * cho cùng một lỗi ở turn này qua turn khác: đúng vòng xoáy mà lớp sinh ra
     * để chặn.
     */
    const failureSignatures = new Map();

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (!result?.isError) return decision;
      const gateCode = result.error?.info?.code;
      if (['JEV_DESTRUCTIVE', 'JEV_CONSENT_DENIED', 'JEV_GATE_UNAVAILABLE', 'JEV_CATASTROPHIC'].includes(gateCode)) {
        return decision;
      }
      const errorText = textOf(result.content).trim();
      // Native guards deny after the waterfall and expose only the reason text.
      if (errorText.startsWith('Blocked by the deterministic catastrophic floor')) return decision;
      if (!errorText) return decision;
      noteSession(exec.agent);

      const turn = currentTurnOf(exec.agent);

      const command = rawCommandOf(exec.name, exec.arguments);
      /**
       * Đếm vòng xoáy TRƯỚC trần mỗi turn: một lỗi lặp lại vẫn là lặp lại kể cả
       * khi trần đã chặn gợi ý, nên lần sau vẫn phải biết mà nâng sàn.
       */
      const signatureKey = `${sessionKeyOf(exec.agent) ?? exec.agent?.id ?? 'agent'}|`
        + failureSignatureOf(exec.name, command, errorText);
      const repeats = failureSignatures.get(signatureKey) ?? 0;
      failureSignatures.set(signatureKey, repeats + 1);
      evictOldest(failureSignatures);

      const failureKey = agentTurnKey(exec.agent, turn);
      const seen = failuresSeen.get(failureKey) ?? 0;
      if (seen >= cfg.failureMaxPerTurn) return decision;
      failuresSeen.set(failureKey, seen + 1);
      evictOldest(failuresSeen);

      /**
       * 1. Lớp lỗi ĐÃ BIẾT → trả lời tất định, KHÔNG tốn round-trip Jev.
       * 2. Phần nhập nhằng → hỏi Jev như cũ.
       */
      const known = classifyDeterministicFailure(errorText, { toolName: exec.name, command });
      let recovery;
      let confidence;
      let origin;
      if (known) {
        recovery = known.recovery;
        origin = `deterministic:${known.label}`;
      } else {
        let verdict;
        try {
          verdict = await jev.evaluate(
            failureQuestion({
              goal: clip(taskOf(exec.agent, 'Unknown task') ?? 'Unknown task', 1_000).text,
              toolName: exec.name,
              command: command ?? JSON.stringify(exec.arguments ?? {}).slice(0, 400),
              errorText: clip(errorText, 1_200).text,
            }),
            { signal: exec.signal, timeoutOverrideMs: cfg.failureTimeoutMs, agent: exec.agent, turn, layer: 'failure_recovery' },
          );
        } catch (error) {
          record({
            type: 'failure_recovery',
            turn,
            tool: exec.name,
            decision: 'fail_open',
            error: describeError(error),
          }, exec.agent);
          return decision;
        }
        recovery = verdict.answers.recovery?.choice;
        confidence = verdict.answers.recovery?.confidence;
        origin = 'jev';
      }

      const advice = RECOVERY_ADVICE[recovery];
      if (!advice) {
        record({
          type: 'failure_recovery',
          turn,
          tool: exec.name,
          decision: 'fail_open',
          error: 'unknown recovery',
          recovery,
        }, exec.agent);
        return decision;
      }

      /**
       * 3. SÀN VÒNG XOÁY: cùng một lỗi lặp lại thì `retry` KHÔNG còn hợp lệ —
       * nâng lên `alternate`. Đây là chỗ chặn "retry → retry → retry".
       */
      let flooredFrom;
      if (recovery === 'retry' && repeats >= 1) {
        flooredFrom = 'retry';
        recovery = 'alternate';
      }

      record({
        type: 'failure_recovery',
        turn,
        tool: exec.name,
        decision: 'hinted',
        recovery,
        origin,
        ...(flooredFrom ? { floored_from: flooredFrom, repeats: repeats + 1 } : {}),
        ...(typeof confidence === 'number' ? { confidence } : {}),
        error: clip(errorText, 300).text,
      }, exec.agent);

      const lead = known
        ? `The ${exec.name} call failed. This is a known failure class (${known.label}), `
          + `so the next move is (${recovery}): ${advice}`
        : `The ${exec.name} call failed. Jev's read on the next move (${recovery}`
          + `${typeof confidence === 'number' ? `, confidence ${confidence.toFixed(2)}` : ''}): ${advice}`;
      const floorNote = flooredFrom
        ? ' This same failure already repeated, so retrying it again is not the move.'
        : '';
      /**
       * §22: gợi ý phục hồi xếp hạng `recovery` — dưới `safety`, trên mọi mảnh
       * advisory, nên nó chỉ bị bỏ khi hạn mức turn đã bị chính nó/vượt trần.
       */
      const admission = admitContext(exec.agent, turn, [{
        kind: 'recovery',
        text: `${lead}${floorNote} `
          + 'Follow it only if it matches the error you can see; otherwise use your own judgement.',
      }]);
      if (!admission.kept.length) return decision;
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: admission.kept[0].text }],
            source: { kind: SOURCE_KIND },
          },
        ],
      };
    });
  }

  /* ──────────── Lớp 8: leo thang sang jevgrep khi việc là "tìm ở đâu" ──────────── */
  /**
   * Đo trên session thật `777a1746` (nền tảng cho cả lớp này):
   *
   *   - Lớp 5 hint file bằng TÊN ở 4 turn liên tiếp → agent đọc file đó 0/4 lần.
   *   - Cả session: 152 lệnh grep/find/rg thô, 0 lần `jg`.
   *   - Run dò-tìm liên tiếp dài nhất mỗi turn: tìm-kiếm thật (turn 1,3,4,5,7,8)
   *     đều ≥3; turn trả lời ngắn (2,9,10) chỉ 1.
   *
   * Nên lớp này leo thang ở HAI thời điểm, cùng một hành động (`jg` một lần):
   *
   *   A. `agent/pre-step` step 1 — khi task của user đọc ra là "tìm X nằm ở đâu".
   *      Chạy trước khi agent kịp tiêu phí lệnh nào.
   *   B. `tools/post-execute` — khi đã có `jevGrepSearchTaskThreshold` lệnh dò
   *      tìm thô liên tiếp trong cùng turn. Bắt ca task không tự khai là tìm-kiếm
   *      nhưng thực tế agent đang mò.
   *
   * Cả hai đều: fail-open tuyệt đối, chỉ CHÈN gợi ý (kèm escape clause), trần
   * `jevGrepMaxPerTurn` mỗi turn, và bỏ qua nếu `jg` không có trên PATH.
   */
  if (cfg.enableJevgrepEscalation) {
    /**
     * Trạng thái key theo `agentId:turn`, KHÔNG theo `turn` trần.
     *
     * `turn` là số thứ tự bên trong một session, nên agent chính và mỗi subagent
     * đều có turn 1, 2, 3... riêng. Key theo `turn` trần sẽ cho subagent tiêu
     * chung ngân sách của agent chính (và ngược lại) — đúng loại lỗi Lớp 2 đã
     * gặp và đã sửa bằng khoá `agentId:turn`.
     */
    const escalated = new Map();
    const rawSearchRun = new Map();
    const keyOf = agentTurnKey;

    const budgetLeft = (key) => (escalated.get(key) ?? 0) < cfg.jevGrepMaxPerTurn;
    const control = createJevgrepControl({
      maxPerSession: cfg.jevGrepMaxConcurrentPerSession ?? 1,
      maxGlobal: cfg.jevGrepMaxConcurrentGlobal ?? 2,
      maxPending: cfg.jevGrepPendingMax ?? 20,
      failureThreshold: cfg.jevGrepFailureBreaker,
      cooldownMs: cfg.jevGrepBreakerCooldownMs ?? 60_000,
    });
    ctx.effect(() => () => {
      control.dispose();
      pendingHints.clear();
      staleHintCache.clear();
    });

    /**
     * CIRCUIT BREAKER — số lần `jg` hỏng LIÊN TIẾP trước khi tạm tắt Lớp 8.
     *
     * ## Vì sao cần (đo được, không phải lo xa)
     *
     * `jg` cache lạnh mất **64 giây** cho một truy vấn, cache ấm 7,5–10,2s. Hook
     * `agent/pre-step` AWAIT nó, nên mỗi lần leo thang cold là turn treo 64s.
     *
     * Đo trên log thật: **41/41 lần leo thang đều `fail_open`** — chưa từng chạy
     * được. Nghĩa là tới giờ Lớp 8 chỉ tạo overhead, chưa từng trả về gợi ý nào.
     * Với trần 12s cũ thì mọi lần cold đều chắc chắn timeout, mà vẫn trả giá 12s
     * mỗi lần.
     *
     * Breaker counts failures by session + root, then opens for a cooldown.
     * Only one half-open probe runs. Success closes; failure reopens.
     * Cancellation does not count, and threshold 0 disables the breaker.
     */
    // Breakers are scoped by session and repository in the shared controller.
    const canEscalate = (key) => budgetLeft(key);

    /**
     * Kết quả `jg` chạy NỀN, chờ được chèn ở lần `pre-step` kế tiếp.
     *
     * ## Vì sao có vân tay (đo được, đây là lỗi thật của bản trước)
     *
     * Bản trước key CHỈ theo session. `jg` chạy nền có thể xong sau khi user đã
     * đổi task, và kết quả cũ bị chèn vào turn mới — context sai + anchoring
     * noise. Đúng ca báo cáo §11: query "authentication middleware ở đâu" xong
     * sau khi user chuyển sang "debug billing webhook".
     *
     * Nên mỗi entry mang ĐỦ dấu vết của lần phát sinh: turn gốc, vân tay task
     * gốc, root, và câu hỏi đã gửi `jg`. Trước khi chèn, `takeReadyHint` so vân
     * tay task HIỆN TẠI với vân tay gốc — khác thì KHÔNG chèn. Gợi ý của task
     * khác không phải "hơi cũ", nó là SAI.
     *
     * ## Khoá = `session_id + hash(truy vấn chuẩn hoá)` (đo được, §11)
     *
     * Bản trước key CHỈ theo session, nên một lần chạy nền của task A đang dở
     * làm `pendingHints.has(sessionKey)` thành true → task B MỚI **không leo
     * thang được cho tới khi A chạy xong** (đo được: "task B escalation blocked
     * by old task A run: true"). Báo cáo §11 chỉ đúng: key phải là
     * `session_id + normalized_query_hash`, để mỗi truy vấn có ô riêng và task
     * mới không bị task cũ chặn.
     *
     * `{ done, value }` được set ĐỒNG BỘ trong `.then` nên `takeReadyHint` đọc
     * được ngay.
     */
    const pendingHints = new Map();
    /**
     * Kết quả nền của task CŨ đã xong nhưng KHÔNG được chèn (task hiện tại khác).
     *
     * §11: "no → **cache result, do not inject**". Bản trước VỨT kết quả; ở đây
     * cất lại theo đúng khoá `session|hash(truy vấn)`. Nếu user quay lại đúng
     * task đó, khoá hiện tại khớp lại và gợi ý được dùng — vẫn không bao giờ
     * chèn vào task khác. Có trần (`evictOldest`) để không phình state.
     */
    const staleHintCache = new Map();
    /** Khoá ô chờ: session + hash truy vấn đã chuẩn hoá (`taskFingerprint`). */
    const queryKeyOf = (agent, question, root = workspaceRootOf(agent, sessionOf(agent))) =>
      `${sessionKeyOf(agent) ?? 'unknown'}|${taskFingerprint(question)}|${root}`;

    /**
     * Dựng gợi ý từ output `jg` — THUẦN, không gọi mạng.
     */
    const buildHint = (text) => {
      const parsed = parseJevgrepOutput(text, cfg.jevGrepExcerptCap);
      if (!parsed?.excerpt) return undefined;
      const fileList = parsed.files.map((file) => file.path).slice(0, 5);
      return {
        fileList,
        text: 'Jev\'s source search already located the relevant code, so read these excerpts '
          + 'instead of grepping for it yourself'
          + `${fileList.length ? ` (${fileList.join(', ')})` : ''}:\n\n`
          + parsed.excerpt
          + '\n\nUse this as a starting point only if it matches what you find; '
          + 'verify against the real files before changing anything.',
      };
    };

    /**
     * Ghi log `jevgrep_escalation` — một cửa duy nhất cho mọi nhánh.
     */
    const makeLog = (turn, reason, started, agent) => (extra) => record({
      type: 'jevgrep_escalation',
      turn,
      reason,
      ms: Date.now() - started,
      ...extra,
    }, agent);

    /**
     * Kiểm tra điều kiện chung trước khi chạy `jg`. Trả `undefined` nếu OK, hoặc
     * chuỗi lý do skip.
     */
    const executeSearch = async ({ agent, key, turn, root, question, signal, log, background }) => {
      if (!canEscalate(key)) { log({ decision: 'skip_budget' }); return; }
      if (!question) { log({ decision: 'skip_no_task' }); return; }
      // Reserve synchronously, before availability checks or any other await.
      const slot = control.reserve({ session: sessionKeyOf(agent) ?? 'unknown', root, query: question, signal });
      if (slot.reason) {
        const { reason: decision, ...counts } = slot;
        log({ decision, ...counts, background });
        return;
      }
      let result;
      try {
        if (!(await isJevgrepAvailable())) { log({ decision: 'skip_unavailable', background }); return; }
        if (slot.signal.aborted) { log({ decision: 'skip_cancelled', background }); return; }
        const costVerdict = takeDecisionCost(agent, turn, 'jevgrep', 8);
        if (!costVerdict.allowed) {
          log({ decision: 'skip_cost', cost_reason: costVerdict.reason, background });
          return;
        }
        escalated.set(key, (escalated.get(key) ?? 0) + 1);
        evictOldest(escalated);
        if (background) log({ decision: 'started_background', origin_turn: turn,
          task_hash: taskFingerprint(clip(taskOf(agent, '') ?? '', 1_500).text) });
        result = await runJevgrep({ question, root, timeoutMs: cfg.jevGrepTimeoutMs, signal: slot.signal });
        if (!result.ok) return;
        const built = buildHint(result.text);
        if (!built) { log({ decision: 'skip_empty', background }); return; }
        log({ decision: 'hinted', files: built.fileList, background });
        return built.text;
      } catch (error) {
        result = { ok: false, error: String(error), cancelled: slot.signal.aborted };
      } finally {
        const failures = slot.finish(result);
        if (result && !result.ok) {
          log({ decision: result.cancelled || slot.signal.aborted ? 'skip_cancelled' : 'fail_open',
            error: result.error, consecutiveFailures: failures, background });
        }
      }
    };

    /**
     * Chạy `jg` cho task hiện tại và dựng gợi ý — ĐƯỜNG AWAIT (hành vi cũ).
     *
     * Trả `undefined` khi không có gì để chèn (thiếu `jg`, lỗi, timeout, output
     * rỗng, hết ngân sách).
     *
     * `fallbackTask` là đường lui cho nhánh B: trong luồng thật `agent/pre-step`
     * luôn chạy ở step 1 và ghi `lastSeenPrompt`, nhưng nếu vì lý do nào đó nó
     * chưa chạy thì lệnh dò tìm vừa chạy vẫn là manh mối tốt hơn là im lặng.
     */
    const escalate = async ({ agent, key, turn, root, reason, signal, fallbackTask }) => {
      const started = Date.now();
      const log = makeLog(turn, reason, started, agent);

      const task = clip(taskOf(agent, fallbackTask ?? '') ?? '', 1_500).text;
      const question = buildJevgrepQuestion(task);
      return executeSearch({ agent, key, turn, root, question, signal, log, background: false });
    };

    /**
     * KHỞI ĐỘNG `jg` CHẠY NỀN — không await, không chặn turn.
     *
     * ## Vì sao (đo được, lần thứ hai sửa lớp này)
     *
     * `jg` cache theo TỪNG TRUY VẤN, không theo repo: mỗi truy vấn mới cold
     * **66s–2m5s** (đo thật 2026-10-01). Hook `agent/pre-step` await nó nghĩa là
     * turn đứng im suốt thời gian đó. Với `jevGrepTimeoutMs: 70000` và breaker 3,
     * tổng có thể chặn turn **210 giây**.
     *
     * Nên: bắt đầu chạy nền, lưu Promise vào `pendingHints`. Lần `pre-step` kế
     * tiếp sẽ lấy kết quả nếu đã xong. Turn không bao giờ chờ.
     *
     * Kết quả có thể "cũ" một nhịp (turn sau nhận gợi ý của turn trước) — nhưng
     * CHỈ khi task chưa đổi. Vân tay task ở entry là điều kiện chèn; task đổi thì
     * kết quả bị vứt, không chèn (xem `takeReadyHint`).
     */
    const escalateInBackground = ({ agent, key, turn, root, reason, fallbackTask }) => {
      const started = Date.now();
      const log = makeLog(turn, reason, started, agent);

      const task = clip(taskOf(agent, fallbackTask ?? '') ?? '', 1_500).text;
      const question = buildJevgrepQuestion(task);
      if (!question) { log({ decision: 'skip_no_task' }); return; }
      // Khoá theo session + hash truy vấn: task MỚI không bị lần chạy của task CŨ
      // chặn (xem khối chú thích `pendingHints` ở trên).
      const pendingKey = queryKeyOf(agent, question, root);
      if (pendingHints.has(pendingKey)) return; // đang có một lần chạy dở CÙNG truy vấn
      if (!canEscalate(key)) {
        log({ decision: 'skip_budget' });
        return;
      }

      /** Dấu vết lần phát sinh — dùng để từ chối chèn nếu task đã đổi. */
      const origin = {
        turn,
        taskHash: taskFingerprint(task),
        root,
        query: question,
      };

      /** Không truyền `signal` của hook: nó abort khi turn kết thúc, mà ta muốn
       *  tiến trình chạy tiếp qua turn. Ngân sách riêng do `jevGrepTimeoutMs` lo. */
      const cap = cfg.jevGrepPendingMax ?? 20;
      for (const [cachedKey, cached] of pendingHints) {
        if (pendingHints.size < cap) break;
        if (cached.done) pendingHints.delete(cachedKey);
      }
      if (pendingHints.size >= cap) { log({ decision: 'skip_pending_cap' }); return; }
      const entry = { done: false, value: undefined, origin };
      pendingHints.set(pendingKey, entry);
      const promise = executeSearch({ agent, key, turn, root, question, log, background: true });
      promise.then((value) => {
        if (pendingHints.get(pendingKey) !== entry) return;
        if (value === undefined) { pendingHints.delete(pendingKey); return; }
        entry.done = true;
        entry.value = value;
      });
    };

    /**
     * Lấy gợi ý nền đã xong VÀ còn hợp lệ (nếu có). KHÔNG chờ.
     *
     * Điều kiện chèn — chặt hơn bản cũ (vốn chỉ kiểm `done`):
     *
     *   1. entry đã xong (`done`);
     *   2. vân tay task HIỆN TẠI khớp vân tay task GỐC đã sinh truy vấn;
     *   3. root hiện tại khớp root gốc (cùng repo mới nói cùng file).
     *
     * Vì khoá chờ là `session|hash(truy vấn)`, một session có thể có NHIỀU ô chờ
     * (task A chạy dở, task B đã xong). Quét theo tiền tố session rồi chọn ô khớp
     * task hiện tại — không "khoá cứng" vào một truy vấn.
     *
     * Không khớp ⇒ theo §11: **cache lại, KHÔNG chèn** (`staleHintCache`). Nếu
     * user quay lại đúng task đó thì dùng lại; còn thì nằm im. Mọi lần từ chối
     * đều ghi log để đo được.
     */
    const takeReadyHint = (agent) => {
      const sessionPrefix = `${sessionKeyOf(agent) ?? 'unknown'}|`;
      const currentTask = clip(taskOf(agent, '') ?? '', 1_500).text;
      const currentTaskHash = taskFingerprint(currentTask);
      const currentRoot = workspaceRootOf(agent, sessionOf(agent));

      for (const [pendingKey, entry] of pendingHints) {
        if (!pendingKey.startsWith(sessionPrefix)) continue;
        if (!entry.done) continue;
        pendingHints.delete(pendingKey);
        // Lần chạy nền hỏng/không có excerpt ⇒ không có gì để chèn, và cũng không
        // phải chuyện "cũ": đừng ghi `skip_stale` gây hiểu nhầm.
        if (entry.value === undefined) continue;

        const origin = entry.origin ?? {};
        const taskMatches = origin.taskHash !== undefined && origin.taskHash === currentTaskHash;
        const rootMatches = origin.root === undefined || origin.root === currentRoot;

        if (taskMatches && rootMatches) return entry.value;

        // Task/root đã đổi: cache kết quả (không vứt) nhưng TUYỆT ĐỐI không chèn.
        keepBoundedHint(staleHintCache, pendingKey, entry.value, cfg.jevGrepPendingMax ?? 20);
        record({
          type: 'jevgrep_escalation',
          turn: currentTurnOf(agent),
          reason: 'stale_background',
          decision: 'skip_stale',
          origin_turn: origin.turn,
          origin_task_hash: origin.taskHash,
          current_task_hash: currentTaskHash,
          root_matches: rootMatches,
        }, agent);
      }

      // Không có kết quả mới: nếu user quay lại đúng task đã cache thì dùng lại
      // (một lần), vẫn không bao giờ chèn sang task khác.
      const cachedKey = queryKeyOf(agent, buildJevgrepQuestion(currentTask), currentRoot);
      if (staleHintCache.has(cachedKey)) {
        const cached = staleHintCache.get(cachedKey);
        staleHintCache.delete(cachedKey);
        return cached;
      }
      return undefined;
    };

    // A. Task đọc ra là "tìm X ở đâu" → leo thang ngay ở step 1.
    //
    // Nhánh này là SUY ĐOÁN từ chuỗi task, không phải bằng chứng agent đang mò,
    // nên mặc định TẮT (`jevGrepSearchTaskHeuristic: false`) — báo cáo §11. Vẫn
    // đăng ký hook để lấy gợi ý NỀN đã sẵn sàng và chèn ở bất kỳ step nào.
    ctx.on('agent/pre-step', async ({ turn, step, signal, agent }, next) => {
      const decision = await next();
      if (decision?.kind !== 'enter') return decision;

      /** Gợi ý nền đã sẵn sàng thì chèn — bất kể step nào. Hạng `advisory` (§22). */
      const injectHint = (hint) => {
        const admitted = admitRepositoryHint(admitContext, wrapRepositoryEvidence, agent, turn, hint);
        if (!admitted) return decision;
        return {
          ...decision,
          messages: [
            ...(decision.messages ?? []),
            {
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: admitted }],
              source: { kind: SOURCE_KIND },
            },
          ],
        };
      };

      const ready = takeReadyHint(agent);
      if (ready) return injectHint(ready);
      if (!cfg.jevGrepSearchTaskHeuristic) return decision;
      // Không còn guard "session đang có lần chạy dở" ở đây: khoá chờ nay gồm
      // hash truy vấn, nên `escalateInBackground` tự chống trùng cho CÙNG truy
      // vấn mà không chặn task MỚI (lỗi báo cáo §11: task mới bị task cũ chặn).

      if (step !== 1) return decision;
      if (!looksLikeSearchTask(taskOf(agent, '') ?? '')) return decision;

      const params = {
        agent,
        key: keyOf(agent, turn),
        turn,
        root: workspaceRootOf(agent, sessionOf(agent)),
        reason: 'search_task',
      };
      if (cfg.jevGrepBackground) {
        escalateInBackground(params);       // KHÔNG await: turn không chờ
        return decision;
      }
      const hint = await escalate({ ...params, signal });
      return hint ? injectHint(hint) : decision;
    });

    // B. Nhiều lệnh dò tìm thô liên tiếp → leo thang (bắt ca task không tự khai).
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (cfg.jevGrepSearchTaskThreshold <= 0) return decision;
      if (exec.name !== 'bash' && exec.name !== 'pwsh') return decision;
      noteSession(exec.agent);

      const turn = currentTurnOf(exec.agent);
      const key = keyOf(exec.agent, turn);
      const command = rawCommandOf(exec.name, exec.arguments);
      if (command === undefined) return decision;

      // Lệnh KHÔNG phải dò tìm thì reset chuỗi: vòng xoáy là các lệnh LIÊN TIẾP.
      if (!isRawSearchCommand(command)) {
        rawSearchRun.set(key, 0);
        return decision;
      }
      const run = (rawSearchRun.get(key) ?? 0) + 1;
      rawSearchRun.set(key, run);
      evictOldest(rawSearchRun);
      if (run < cfg.jevGrepSearchTaskThreshold) return decision;
      // A transient cap/breaker skip must not consume this turn's search trigger.
      // Successful reservations are bounded by canEscalate and pending query keys.

      const hint = cfg.jevGrepBackground
        ? (escalateInBackground({
          agent: exec.agent,
          key,
          turn,
          root: workspaceRootOf(exec.agent, sessionOf(exec.agent)),
          reason: 'raw_search_run',
          fallbackTask: command,
        }), undefined)
        : await escalate({
          agent: exec.agent,
          key,
          turn,
          root: workspaceRootOf(exec.agent, sessionOf(exec.agent)),
          reason: 'raw_search_run',
          signal: exec.signal,
          // Lệnh dò tìm là manh mối yếu nhưng vẫn hơn im lặng, và chỉ dùng khi
          // `lastSeenPrompt`/`lastSeenGoal` đều rỗng (nhánh hiếm).
          fallbackTask: command,
        });
      if (!hint) return decision;
      const admitted = admitRepositoryHint(admitContext, wrapRepositoryEvidence, exec.agent, turn, hint);
      if (!admitted) return decision;
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: admitted }],
            source: { kind: SOURCE_KIND },
          },
        ],
      };
    });
  }

  /* ──────────────────── Lớp 2: kiểm hoàn thành khi sắp dừng ──────────────────── */
  if (cfg.enableCompletionCheck) {
    /**
     * Đếm số lần đã kiểm cho mỗi `agentId:turn`, thay cho `Set` chỉ-chạy-một-lần.
     *
     * Vì sao cần trần: bản trước dùng `Set` + `clear()` khi >200 entry. Một
     * session spawn nhiều subagent đẩy Set tới 200 nhanh, `clear()` xoá hết,
     * và turn cũ fire lại. Log thật ghi 16 lần fire trên cùng turn=9.
     *
     * Trần `completionMaxPerTurn` (mặc định 2) chặn việc đó mà không cản turn
     * mới: khoá gồm `turn`, nên mỗi turn vẫn có ngân sách riêng.
     */
    const checked = new Map();
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      noteSession(agent);
      const key = `${agent?.id ?? 'agent'}:${turn}`;
      const seen = checked.get(key) ?? 0;
      if (seen >= cfg.completionMaxPerTurn) return;

      /**
       * Nguồn "mục tiêu": goal nếu có, KHÔNG thì lấy task gần nhất của user.
       *
       * ## Vì sao phải có đường lui (đo trên log thật)
       *
       * Bản cũ `return` khi không có `agent.goal.objective`. Nhưng operator gần
       * như không dùng goal: đếm trên 162 session, chỉ có **8 sự kiện
       * `goal/change`** — và Lớp 2 KHÔNG chạy lần nào từ 29/09. Nó không phải
       * "fail 53%" mà là **code chết**: im lặng hoàn toàn 3 ngày.
       *
       * `taskOf` đã có sẵn (goal ưu tiên, rồi tới prompt thật của user), và nó
       * được `notePrompt` ghi lại từ `agent/pre-step`. Dùng nó làm đường lui thì
       * Lớp 2 mới thực sự chạy.
       *
       * Chỉ kiểm khi CÓ task: không có gì để đối chiếu thì im lặng, như cũ.
       */
      const goal = taskOf(agent, undefined);
      if (typeof goal !== 'string' || !goal.trim()) return;
      checked.set(key, seen + 1);
      evictOldest(checked);

      const evidence = await collectEvidence(agent?.session);
      let verdict;
      try {
        // Older hosts stop with an aborted signal; live signals still cancel the check.
        verdict = await jev.evaluate(
          completionQuestion({
            goal: clip(goal, 1_500).text,
            recentEvidence: evidence.text,
            testSignal: evidence.testSignal,
          }),
          { signal: stoppingSignal(signal, cfg.stopTimeoutMs),
            timeoutOverrideMs: cfg.stopTimeoutMs, agent, turn, layer: 'completion_check' },
        );
      } catch (error) {
        record({
          type: 'completion_check',
          turn,
          decision: 'fail_open',
          error: describeError(error),
        }, agent);
        return;
      }

      const complete = verdict.answers.complete?.noul;
      const proven = verdict.answers.evidence?.noul;
      const needsExecution = verdict.answers.needs_execution?.noul;
      if (typeof complete !== 'number' || typeof proven !== 'number' || typeof needsExecution !== 'number') {
        record({ type: 'completion_check', turn, decision: 'fail_open', error: 'missing answers' }, agent);
        return;
      }

      const missing = complete < cfg.completionThreshold;
      const needsProof = needsExecution >= cfg.executionThreshold;
      const unsupported = needsProof && proven < cfg.evidenceThreshold;
      if (!missing && !unsupported) {
        record({
          type: 'completion_check',
          turn,
          decision: 'accept',
          complete,
          proven,
          needsExecution,
        }, agent);
        return;
      }
      record({ type: 'completion_check', turn, decision: 'continue', complete, proven, needsExecution }, agent);
      /**
       * Báo cho Lớp 7 (chạy sau trong cùng lượt dispatch `agent/turn-stopping`)
       * rằng turn này KHÔNG kết thúc: vừa steer thêm việc. Không có cờ này thì
       * Lớp 7 review một diff dở dang — đúng lỗi §10 của bản review.
       */
      continuedTurns.set(key, true);
      evictOldest(continuedTurns);
      const reason = missing
        ? `Jev assesses the original goal is not fully carried out (p=${complete.toFixed(2)}).`
        : `Jev assesses this goal needed execution but the claim is not backed by executed output `
          + `(p=${proven.toFixed(2)}).`;
      /**
       * §22: hạng `completion` (chỉ dưới `safety`). Bị bỏ thì turn này cũng đã
       * có `record(completion_check, continue)` ở trên, nên hành vi không im lặng.
       */
      const admission = admitContext(agent, turn, [{
        kind: 'completion',
        text: `${reason} Before stopping, either finish the remaining work or run a command whose `
          + 'real output proves the result, then report that output. If the goal is genuinely '
          + 'complete and cannot be further verified in this environment, say so explicitly and stop.',
      }]);
      if (!admission.kept.length) return;
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: admission.kept[0].text }],
        source: { kind: SOURCE_KIND },
      });
    });
  }

  /* ──────────────────── Lớp 3: chọn effort theo turn ──────────────────── */
  /**
   * LUẬT TẤT ĐỊNH (2026-10-01) — bỏ classifier per-request.
   *
   * Lịch sử: lớp này từng gọi Jev ở MỌI request để đoán "bước tới cần nghĩ nhiều
   * không", rồi tái dùng theo confidence, rồi thêm trần tái dùng. Đo lại trên
   * 120 request liên tiếp (8 session thật):
   *
   *   - đổi mức **113/120 lần**, dãy `low,high,low,high,…` — gần như dao động
   *   - **54,5%** quyết định `applied` có confidence < 0,5
   *   - chiếm **55%** toàn bộ token Jev, và mỗi call nằm TRÊN đường tới hạn của
   *     request chính (~281ms serial)
   *
   * Nghĩa là lớp tốn kém nhất đang đổi một quyết định gần như ngẫu nhiên. Cả
   * "lease" (Jev trả 1 ở 97% lần) lẫn ngưỡng confidence đều là máy móc để che
   * một tín hiệu không có thật.
   *
   * Nghiên cứu ngoài xác nhận hướng: tín hiệu ĐO ĐƯỢC (tool error, test fail,
   * retry) thắng tín hiệu "đoán độ khó" (arXiv 2505.00127, 2608.13571); model
   * hệ suy luận trên việc dễ gần như không tăng accuracy khi nâng effort
   * (arXiv 2507.04023); router per-step chỉ thắng khi là model nhỏ đã TRAIN
   * (<5ms, arXiv 2603.07915) — không phải API classifier 1.180 token.
   *
   * Thiết kế mới: STICKY theo turn. Mặc định `effortDefault` (low); nâng lên
   * `effortEscalateTo` (high) chỉ khi turn TRƯỚC có bằng chứng thất bại đo được
   * (`turnSignals`: tool error / test fail). Sang turn mới mới tính lại. KHÔNG
   * gọi Jev. Đặt `enableEffortRouting: false` để tắt hẳn.
   *
   * CHẾ ĐỘ `input` (2026-10-04) — Jev chọn effort từ NỘI DUNG TIN NHẮN USER.
   *
   * Operator muốn: mỗi lượt user gửi, Jev đọc yêu cầu rồi quyết định lượt đó
   * chạy ở mức effort nào. Đây là chế độ mặc định mới.
   *
   * Khác biệt so với luật tất định cũ: quyết định dựa trên ĐỘ KHÓ CỦA YÊU CẦU
   * ("việc này cần nghĩ nhiều không?"), không phải tín hiệu thất bại của turn
   * trước. Đánh đổi đã biết (đo ở bản classifier 2026-09): dao động mức giữa các
   * lượt, ~281ms serial mỗi lượt, và 55% token Jev. Vì vậy lớp này:
   *
   *   - CHỈ gọi Jev khi SANG TURN MỚI (sticky trong turn) → mỗi lượt user 1 call,
   *     không phải mỗi step.
   *   - FAIL-OPEN về `effortDefault` (low): Jev lỗi/timeout/trả rác thì lượt vẫn
   *     chạy, không kẹt.
   *   - Bỏ qua hoàn toàn khi model không khai `reasoningEfforts`.
   *
   * Task text lấy từ `notePrompt` (hook `agent/pre-step` chạy TRƯỚC
   * `agent/request` trong cùng step), nên step 1 của turn đã có sẵn tin nhắn user.
   * Đặt `effortDecision: 'deterministic'` để quay lại luật tín hiệu cũ.
   */
  if (cfg.enableEffortRouting) {
    /**
     * Mức effort đang áp cho một agent, key theo session.
     *
     * KHÔNG key theo `route`: agent chính và subagent thường dùng CÙNG một model,
     * nên cùng `route` sẽ dùng chung state. Key theo session tách được chúng.
     */
    const lastEffort = new Map();
    const effortKeyOf = (agent) => sessionKeyOf(agent) ?? 'unknown';

    /**
     * Luật tất định cũ — giữ lại làm fallback và cho chế độ `deterministic`.
     * Mặc định low; nâng `effortEscalateTo` khi turn trước có bằng chứng thất bại.
     */
    const deterministicEffort = async (agent, turn, supported, signals) => {
      const measured = signals ?? await turnSignals(sessionOf(agent), turn - 1);
      const escalate = measured.toolErrors >= cfg.effortEscalateToolErrors
        || measured.testFailures >= cfg.effortEscalateTestFailures;
      let effort = escalate ? cfg.effortEscalateTo : cfg.effortDefault;
      if (!supported.includes(effort)) {
        effort = supported.includes(cfg.effortDefault) ? cfg.effortDefault : supported[0];
      }
      const reason = escalate
        ? (measured.testFailures >= cfg.effortEscalateTestFailures
          ? `test_failure:${measured.testFailures}`
          : `tool_errors:${measured.toolErrors}`)
        : 'clean_turn';
      return { effort, reason, signals: measured };
    };

    /**
     * Hỏi Jev mức effort cho YÊU CẦU hiện tại. Luôn trả một mức nằm trong
     * `supported`; mọi bất trắc (task rỗng, Jev lỗi, trả mức lạ) lùi về
     * `effortDefault`. Không bao giờ ném ra ngoài.
     */
    /**
     * Hỏi Jev mức effort cho YÊU CẦU hiện tại. Jev chỉ được chọn trong
     * `effortJevChoices` (mặc định low/high), giao với dải model nhận. Mọi bất
     * trắc (task rỗng, Jev lỗi, trả mức lạ) lùi về `effortFallback` (medium).
     * Không bao giờ ném ra ngoài.
     *
     * `choices` là tập hợp lệ đã giao sẵn ở nơi gọi; `fallback` đã được ép nằm
     * trong `supported` nên luôn áp được.
     */
    const jevEffort = async (agent, turn, supported, choices, fallback, signal, signals) => {
      const task = clip(taskOf(agent, '') ?? '', 2_000).text;
      if (!task.trim()) {
        return { effort: fallback, reason: 'no_task', signals: null };
      }
      const meaning = Object.fromEntries(
        choices.map((level) => [level, EFFORT_MEANING[level] ?? level]),
      );
      let verdict;
      try {
        verdict = await jev.evaluate(
          effortQuestion({
            task,
            progress: '',
            recentToolCalls: [],
            supportedEfforts: choices,
            effortMeaning: meaning,
            signals: signals ?? undefined,
          }),
          { signal, timeoutOverrideMs: cfg.effortTimeoutMs, agent, turn, layer: 'effort_route' },
        );
      } catch (error) {
        record({
          type: 'effort_route',
          step: undefined,
          turn,
          decision: 'fail_open',
          effort: fallback,
          error: describeError(error),
        }, agent);
        return { effort: fallback, reason: 'fail_open', signals: null };
      }
      const answer = verdict?.answers?.effort;
      const choice = typeof answer?.choice === 'string' ? answer.choice : '';
      const confidence = typeof answer?.confidence === 'number' ? answer.confidence : null;
      if (!choices.includes(choice)) {
        // Jev trả mức ngoài tập cho phép → lùi mặc định (không đoán bừa).
        return { effort: fallback, reason: 'invalid_choice', confidence, signals: null };
      }
      return { effort: choice, reason: 'jev', confidence, signals: null };
    };

    /**
     * Hỏi Jev mức effort ở chế độ ABSTAIN (`effortAbstain: true`).
     *
     * Khác `jevEffort`: KHÔNG đưa Jev một câu `choice` buộc phải chọn cực.
     * Thay vào đó gửi HAI câu `noul` độc lập trong MỘT request (routine, hard)
     * rồi HOST tự ánh xạ bằng `mapEffortAbstain`. Nhờ vậy `medium` (fallback)
     * là một kết quả HỢP LỆ khi hai trục không đủ mạnh để nghiêng về cực nào —
     * thay vì chỉ xuất hiện khi Jev lỗi.
     *
     * Trả `{effort, reason, routine, hard, signals}`; `reason` ∈
     * routine|hard|abstain|invalid_answer|no_choices|no_task|fail_open.
     */
    const jevEffortAbstain = async (agent, turn, supported, choices, fallback, signal, signals) => {
      const task = clip(taskOf(agent, '') ?? '', 2_000).text;
      if (!task.trim()) {
        return { effort: fallback, reason: 'no_task', signals: null };
      }
      let verdict;
      try {
        verdict = await jev.evaluate(
          effortAbstainQuestion({ task, signals: signals ?? undefined }),
          { signal, timeoutOverrideMs: cfg.effortTimeoutMs, agent, turn, layer: 'effort_route' },
        );
      } catch (error) {
        record({
          type: 'effort_route',
          step: undefined,
          turn,
          decision: 'fail_open',
          effort: fallback,
          error: describeError(error),
        }, agent);
        return { effort: fallback, reason: 'fail_open', signals: null };
      }
      const routine = verdict?.answers?.routine?.noul;
      const hard = verdict?.answers?.hard?.noul;
      const mapped = mapEffortAbstain({
        routine,
        hard,
        choices,
        fallback,
        routineThreshold: cfg.effortRoutineThreshold,
        hardThreshold: cfg.effortHardThreshold,
      });
      return { ...mapped, signals: null };
    };

    ctx.on('agent/request', async ({ step, turn, agent, signal }, next) => {
      // `agent/request` KHÔNG có `agent` trong payload ở một số đường nội bộ;
      // `sessionKeyOf` chịu được `undefined`. Ghi session nếu có để các lớp khác
      // (pre-step, turn-stopping) đọc lại được.
      if (agent) noteSession(agent);
      const downstream = await next();
      const route = `${downstream?.provider ?? ''}/${downstream?.model ?? ''}`;
      if (!downstream?.provider || !downstream?.model) return downstream;

      const supported = await supportedEffortsOf(ctx, downstream.provider, downstream.model);
      if (!supported.length) {
        record({ type: 'effort_route', step, decision: 'skip_no_levels', route, diagnostic: lastLookupDiagnostic }, agent);
        return downstream;
      }

      const key = effortKeyOf(agent);
      const prev = lastEffort.get(key);

      // STICKY THEO TURN: trong cùng một lượt user, mọi step dùng chung mức đã
      // chốt. Chỉ tính lại khi sang turn mới — nên Jev được hỏi 1 lần/lượt.
      if (prev && prev.turn === turn && supported.includes(prev.effort)) {
        record({
          type: 'effort_route',
          step,
          turn,
          route,
          decision: 'sticky',
          effort: prev.effort,
          reason: prev.reason,
          reusedFor: prev.reuses + 1,
        }, agent);
        prev.reuses += 1;
        return { ...downstream, reasoningEffort: prev.effort };
      }

      const useJev = cfg.effortDecision !== 'deterministic';
      /**
       * Tín hiệu thất bại ĐO ĐƯỢC của turn trước — tính MỘT lần, dùng cho cả
       * hai chế độ. Ở chế độ `input`, nó là bằng chứng THỨ CẤP: Jev đọc yêu cầu
       * user trước, còn đây là sàn không cho hạ xuống dưới điều thất bại thật
       * đòi hỏi. Ở chế độ `deterministic` nó là nguồn quyết định duy nhất.
       */
      const signals = await turnSignals(sessionOf(agent), turn - 1);
      const floor = effortFloorFromSignals(signals, {
        escalateTo: cfg.effortEscalateTo,
        escalateToolErrors: cfg.effortEscalateToolErrors,
        escalateTestFailures: cfg.effortEscalateTestFailures,
      });
      let decided;
      if (useJev) {
        /**
         * Tập mức Jev được chọn = (config `effortJevChoices`) ∩ (dải model nhận).
         * Fallback = `effortFallback` nếu model nhận, ngược lại mức hợp lệ đầu.
         * Dưới 2 lựa chọn thì hỏi Jev là vô nghĩa → dùng thẳng fallback.
         */
        const fallback = supported.includes(cfg.effortFallback)
          ? cfg.effortFallback
          : (supported.includes(cfg.effortDefault) ? cfg.effortDefault : supported[0]);
        const choices = cfg.effortJevChoices.filter((level) => supported.includes(level));
        /**
         * Hai chế độ con của `input`:
         *   - `effortAbstain: true`  → hai câu `noul` + host tự ánh xạ
         *     (`jevEffortAbstain`). `medium` trở thành abstain hợp lệ.
         *   - mặc định (`false`)     → một câu `choice` như cũ (`jevEffort`),
         *     giữ nguyên hành vi đã đo 26/26.
         * Cả hai đều cần >=2 mức hợp lệ; dưới thì hỏi Jev là vô nghĩa.
         */
        if (choices.length < 2) {
          decided = { effort: fallback, reason: 'no_choices', signals: null };
        } else if (cfg.effortAbstain) {
          decided = await jevEffortAbstain(agent, turn, supported, choices, fallback, signal, signals);
        } else {
          decided = await jevEffort(agent, turn, supported, choices, fallback, signal, signals);
        }
      } else {
        decided = await deterministicEffort(agent, turn, supported, signals);
      }

      /**
       * SÀN TÍN HIỆU: thất bại đo được chỉ được NÂNG mức, không bao giờ để mức
       * bị hạ xuống dưới điều nó đòi.
       *
       * Vì sao cần: ở chế độ `input`, Jev có thể đọc một yêu cầu ngắn gọn là
       * "dễ" trong khi turn trước vừa có 3 tool error — lúc đó bằng chứng đo
       * được phải thắng phỏng đoán độ khó. Chỉ áp khi mức đã chọn THẤP HƠN sàn
       * theo thứ tự `EFFORT_ORDER`; mức ngang hoặc cao hơn giữ nguyên. Sàn chỉ
       * áp nếu model thật sự nhận mức đó.
       */
      let floored = false;
      let effort = decided.effort;
      if (floor !== undefined && supported.includes(floor)) {
        const chosenRank = effortRank(effort);
        const floorRank = effortRank(floor);
        if (chosenRank !== undefined && floorRank !== undefined && chosenRank < floorRank) {
          effort = floor;
          floored = true;
        }
      }

      // Lưới an toàn cuối: mức phải nằm trong dải model nhận, nếu không về mặc định.
      if (!supported.includes(effort)) {
        effort = supported.includes(cfg.effortDefault) ? cfg.effortDefault : supported[0];
      }

      lastEffort.set(key, { effort, turn, reason: decided.reason, reuses: 0 });
      const source = useJev
        ? (cfg.effortAbstain ? 'jev_abstain' : 'jev_input')
        : 'deterministic';
      record({
        type: 'effort_route',
        step,
        turn,
        route,
        decision: 'applied',
        source,
        effort,
        reason: decided.reason,
        confidence: decided.confidence ?? undefined,
        ...(decided.routine === undefined ? {} : { routine: decided.routine }),
        ...(decided.hard === undefined ? {} : { hard: decided.hard }),
        signals: decided.signals ?? signals,
        ...(floored ? { floored_from: decided.effort, floor } : {}),
        reused: false,
      }, agent);
      return { ...downstream, reasoningEffort: effort };
    });
  }

  /* ────── Lớp 7: tự gọi jev_review khi turn kết thúc và có thay đổi thật ────── */
  /**
   * VÌ SAO CẦN LỚP NÀY.
   *
   * Đo trên 110 session thật: tool `mcp__jev-review__jev_review` **được đăng ký
   * và có trong prompt** (section `mcp:jev-review` do `dsh-mcp-client` chèn qua
   * `systemPrompt.section`), nhưng được gọi **1 lần duy nhất** — và đó là lần
   * tác giả plugin tự test. Trong công việc thật: **0 lần**.
   *
   * Nghĩa là "có tool" không bằng "tool được dùng". Mọi kênh Jev trừ
   * `dsh-jev-gate` đều thụ động: MCP tool, skill, CLI đều CHỜ agent quyết định
   * gọi. Chỉ hook engine là chạy tự động. Nên lớp này cắm `jev_review` vào hook.
   *
   * VÌ SAO KHÔNG GỌI MCP SERVER TRỰC TIẾP: MCP client của DSH đăng ký tool vào
   * `ctx.tools` dưới tên `mcp__<server>__<tool>`, nên gọi qua `ctx.tools.execute`
   * là đúng đường — không tự spawn tiến trình, không tự quản key, và đi qua
   * nguyên pipeline của DSH.
   *
   * BỐN CHỐT CHỐNG LẠM DỤNG (mỗi chốt đều cần, vì hook này chặn turn):
   *
   *   1. `isError` + chỉ khi turn THẬT SỰ kết thúc. Gọi khi turn còn tiếp thì
   *      review sẽ chạy trên code dở dang — vô nghĩa và tốn tiền.
   *   2. CHỈ turn chính, không phải subagent. Subagent không sở hữu workspace
   *      change và sẽ nhân số lần review lên theo số worker.
   *   3. CHỈ khi có thay đổi file thật, đủ lớn (`reviewMinChangedLines`). Review
   *      một diff rỗng hay một dòng sửa typo là đốt tiền không đổi lại gì.
   *   4. Trần `reviewMaxPerTurn` (1). Không có nó thì mỗi lần turn-stopping
   *      chạy lại là một lần gọi.
   *
   * FAIL-OPEN, như mọi lớp khác trừ 1b: thiếu tool, thiếu diff, lỗi mạng, hay
   * service vắng → im lặng bỏ qua. Review là lớp bổ sung, không phải điều kiện
   * để turn được kết thúc.
   *
   * KHÔNG đưa điểm số cho model tự "sửa cho điểm cao": kết quả review được ghi
   * log và (tuỳ chọn) đẩy về user qua `agent.steer` dưới dạng BÁO CÁO, không
   * phải mệnh lệnh. Điểm là bằng chứng, không phải mục tiêu để tối ưu.
   */
  if (cfg.enableQualityReview) {
    const reviewed = new Map();

    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      noteSession(agent);
      const key = `${agent?.id ?? 'agent'}:${turn}`;
      const seen = reviewed.get(key) ?? 0;
      if (seen >= cfg.reviewMaxPerTurn) return;

      /**
       * Chốt 0 (§10): turn KHÔNG thật sự kết thúc.
       *
       * Lớp 2 chạy trước trong cùng lượt dispatch `agent/turn-stopping` (dispatch
       * TUẦN TỰ theo thứ tự đăng ký). Nếu nó vừa `steer` thêm việc, turn sẽ
       * tiếp tục — review lúc này là review một diff dở dang: vô nghĩa và tốn
       * tiền. Cờ là one-shot: đọc rồi XOÁ, nên chỉ chặn đúng lần turn-stopping
       * ngay sau một lần "continue", không khoá turn vĩnh viễn.
       */
      if (continuedTurns.delete(key)) {
        record({ type: 'quality_review', turn, decision: 'skip_continued' }, agent);
        return;
      }

      // Chốt 2: chỉ turn chính. `delegationDepth > 0` là subagent.
      const session = agent?.session;
      if (session?.delegationDepth > 0) {
        record({ type: 'quality_review', turn, decision: 'skip_subagent' }, agent);
        return;
      }

      const found = workspaceSummaryOf(ctx, session);
      if (!found?.summary?.files?.length) {
        record({ type: 'quality_review', turn, decision: 'skip_no_changes' }, agent);
        return;
      }
      const { summary, seq: eventSeq } = found;
      // Chốt 3: diff phải đủ lớn để đáng review.
      const changedLines = (summary.added ?? 0) + (summary.deleted ?? 0);
      if (changedLines < cfg.reviewMinChangedLines) {
        record({
          type: 'quality_review',
          turn,
          decision: 'skip_too_small',
          changedLines,
          threshold: cfg.reviewMinChangedLines,
        }, agent);
        return;
      }

      const toolName = `mcp__${cfg.reviewServerName}__jev_review`;
      if (typeof ctx.tools?.get !== 'function' || ctx.tools.get(toolName, agent) === undefined) {
        record({ type: 'quality_review', turn, decision: 'skip_no_tool', tool: toolName }, agent);
        return;
      }

      const feedback = (cfg.reviewMode ?? (cfg.reviewReportToAgent ? 'agent-feedback' : 'telemetry')) === 'agent-feedback';
      const reservation = feedback && typeof agent?.steer === 'function'
        ? reserveReviewContext(agent, turn) : undefined;
      if (feedback && !reservation) {
        record({ type: 'quality_review', turn, decision: 'skip_context',
          reason: typeof agent?.steer === 'function' ? 'no_feedback_capacity' : 'no_feedback_receiver' }, agent);
        return;
      }
      try {
      const effectiveSignal = stoppingSignal(signal, cfg.reviewTimeoutMs ?? 15_000);
      const diff = await buildTurnDiff(ctx, session, summary, eventSeq, effectiveSignal);
      if (!diff.trim()) {
        record({ type: 'quality_review', turn, decision: 'skip_empty_diff' }, agent);
        return;
      }

      /**
       * Ngân sách chỉ bị tiêu khi review THẬT SỰ được gửi đi (§10).
       *
       * Mọi nhánh `skip_*` ở trên đã `return` trước dòng này, nên chúng không
       * còn ăn vào `reviewMaxPerTurn`. Đặt ngay trước `ctx.tools.execute` để
       * một lần gọi tool thực sự (kể cả khi tool trả `isError`) đúng bằng một
       * đơn vị ngân sách — đây là điểm duy nhất tốn tiền model.
       */
      // Recheck after diff's await: concurrent hooks may have reserved a call.
      const used = reviewed.get(key) ?? 0;
      if (used >= cfg.reviewMaxPerTurn || effectiveSignal.aborted) return;
      const costVerdict = takeDecisionCost(agent, turn, 'quality_review', 2);
      if (!costVerdict.allowed) {
        record({ type: 'quality_review', turn, decision: 'skip_budget',
          reason: costVerdict.reason, budget: costVerdict.budget }, agent);
        return;
      }
      reviewed.set(key, used + 1);
      evictOldest(reviewed);

      const result = await ctx.tools.execute({
          callId: `jev-gate-review-${randomUUID()}`,
          name: toolName,
          arguments: {
            task: clip(taskOf(agent, 'Complete the requested change.') ?? 'Complete the requested change.', 4_000).text,
            diff: clip(diff, cfg.reviewMaxDiffChars).text,
            repositoryContext: `Session cwd: ${summary.cwd}. `
              + `${summary.total} file(s) changed, ${summary.added} line(s) added, ${summary.deleted} line(s) deleted.`,
          },
          agent,
          signal: effectiveSignal,
        });

      if (effectiveSignal.aborted) {
        record({ type: 'quality_review', turn, decision: 'skip_cancelled',
          reason: describeError(effectiveSignal.reason) }, agent);
        return;
      }
      if (result?.isError) {
        record({
          type: 'quality_review',
          turn,
          decision: 'fail_open',
          error: textOf(result.content).slice(0, 200) || 'tool returned isError',
        }, agent);
        return;
      }

      const scores = parseReviewScores(textOf(result.content));
      record({
        type: 'quality_review',
        turn,
        decision: 'reviewed',
        changedLines,
        files: summary.total,
        scores,
      }, agent);
      if (feedback) {
        const admission = admitContext(agent, turn, [{
          kind: 'advisory',
          truncatable: true,
          text: `Jev Review scored this turn's changes (${summary.total} file(s), ${changedLines} line(s)): `
            + `${formatScores(scores)}. `
            + 'This is a quality signal for the work just done, not an instruction: use it to decide '
            + 'whether another justified improvement is warranted before you stop.',
        }], reservation);
        if (admission.kept.length) {
          agent?.steer?.({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: admission.kept[0].text }],
            source: { kind: SOURCE_KIND },
          });
        }
      }
      } catch (error) {
        record({ type: 'quality_review', turn, decision: 'fail_open', error: describeError(error) }, agent);
      } finally {
        releaseReviewContext(reservation);
      }
    });
  }

  record({ type: 'boot', model: jev.model, config: cfg });
}

/* ─────────────────────────── thu thập bằng chứng ─────────────────────────── */

/**
 * Các reasoning effort mà route này thật sự nhận.
 *
 * `agent/request` không nhận `agent`, nên phải tra qua service LLM của ctx.
 * API đúng là `llm.resolveModelInfo(provider, model)` → `info.reasoning.efforts`
 * còn `LlmResolvedModelInfo` (`dsh-llm/lib/types/types.d.ts:377`).
 * Trả [] nếu không tra được; lớp effort sẽ tự bỏ qua (fail-open) thay vì gửi
 * một effort mà model không nhận.
 */
async function supportedEffortsOf(ctx, provider, model) {
  const normalize = (found) => {
    if (!found) return [];
    if (Array.isArray(found)) {
      return found
        .map((level) => (typeof level === 'string' ? level : level?.id ?? level?.effort))
        .filter((effort) => typeof effort === 'string' && effort && effort !== 'off');
    }
    if (typeof found === 'object') {
      const inner = found.efforts;
      if (Array.isArray(inner)) return normalize(inner);
      return Object.keys(found).filter((key) => key && key !== 'off');
    }
    return [];
  };

  try {
    const info = await ctx.llm?.resolveModelInfo?.(provider, model);
    const levels = normalize(info?.reasoning ?? info?.reasoningEfforts);
    if (levels.length) return levels;
    // Chẩn đoán: tra được nhưng không có levels — ghi lại shape để biết vì sao.
    lastLookupDiagnostic = {
      ok: true,
      hasInfo: Boolean(info),
      infoKeys: info ? Object.keys(info).slice(0, 14) : [],
      reasoning: info?.reasoning ? Object.keys(info.reasoning) : null,
    };
  } catch (error) {
    lastLookupDiagnostic = {
      ok: false,
      error: describeError(error).slice(0, 200),
    };
  }
  return [];
}

/** Chẩn đoán lần tra effort gần nhất; ghi vào log khi skip. */
let lastLookupDiagnostic;

/**
 * Ngữ cảnh gần nhất đã thấy, ghi lại từ các hook CÓ agent.
 *
 * `agent/request` không nhận `agent` (payload chỉ `{turn, step, signal}`) và chạy
 * TRƯỚC tool đầu tiên của turn, nên ở step 1 nó không có gì để đọc. Hai nguồn bù:
 *
 *   - `agent/pre-step`: chạy trước `agent/request` trong cùng step, mang `messages`
 *     của user → lấy được task text ngay từ step 1.
 *   - `tools/pre-execute` và `agent/turn-stopping`: có `agent` → lấy session (goal,
 *     tool history) cho các step sau.
 *
 * Không sao chép dữ liệu: chỉ giữ tham chiếu session và chuỗi task gần nhất.
 */
/**
 * Trạng thái "lần cuối thấy" — PHẢI theo từng session, không được toàn cục.
 *
 * ## Vì sao (đây là lỗi thật đã đo, không phải lo xa)
 *
 * Bản trước dùng ba biến module-level (`let lastSeenSession`) làm singleton toàn
 * cục. DSH chạy nhiều agent cùng lúc — `dsh-experimental-agent-team` có trong
 * profile, và operator dùng `subagent` thật — nên agent này ghi đè trạng thái
 * của agent kia.
 *
 * Bằng chứng từ log thật `decisions.jsonl`: trong dãy `effort_route`, `turn`
 * **giảm 291 lần** (14 → 1 → 14 → 1) — dấu hiệu hai agent xen kẽ nhau. Mỗi lần
 * xen kẽ, hook của agent A có thể đọc `lastSeenPrompt`/`lastSeenGoal` do agent B
 * ghi, tức hỏi Jev về **task của agent khác**.
 *
 * Mức hại đo được (đừng phóng đại):
 *   - `workspaceRootOf` ưu tiên `agent.session.header.cwd` trước, nên **root vẫn
 *     đúng** dù state leak.
 *   - Guard `prev.turn === turn` trong Lớp 3 chặn được reuse chéo agent: đo được
 *     **0/291** lần reuse sai ngay sau một lần turn giảm.
 *   - Cái SAI thật là `task` text trong `pre_step`/`failure_recovery`/
 *     `jevgrep_escalation`: Jev bị hỏi về task của agent khác.
 *
 * ## Cách sửa
 *
 * State keyed theo danh tính session. `sessionKeyOf()` lấy id ổn định từ session
 * (hoặc từ agent khi session chưa có). Không có khoá ⇒ trả `undefined` và caller
 * chịu (fail-open), thay vì âm thầm dùng state của agent khác.
 *
 * Giữ trần `evictOldest` để một session dài không làm phình Map.
 */
const seenBySession = new Map();

/** Khoá ổn định cho một session. `undefined` khi không xác định được. */
function sessionKeyOf(agent, session) {
  const s = session ?? agent?.session;
  const id = s?.id ?? s?.header?.id ?? s?.header?.sessionId;
  if (typeof id === 'string' && id) return `session:${id}`;
  // Không có id: dùng agent id làm khoá dự phòng (tách agent chính/subagent).
  const agentId = agent?.id;
  if (typeof agentId === 'string' && agentId) return `agent:${agentId}`;
  // Cuối cùng: khoá theo chính ĐỐI TƯỢNG session. DSH thật luôn có id, nhưng
  // test và một số đường nội bộ thì không — và khoá theo object vẫn đúng hơn
  // nhiều so với một singleton dùng chung cho mọi agent.
  if (s !== undefined && s !== null && (typeof s === 'object' || typeof s === 'function')) {
    let weak = objectKeys.get(s);
    if (weak === undefined) {
      weak = `obj:${(objectKeySeq += 1)}`;
      objectKeys.set(s, weak);
    }
    return weak;
  }
  return undefined;
}

/**
 * Khoá `agent + turn` cho các trần theo-turn (gợi ý, phục hồi, leo thang).
 *
 * Phải gồm danh tính agent, không chỉ `turn`: agent chính và subagent đều đánh
 * số turn từ 1, nên khoá chỉ theo `turn` khiến chúng dùng chung ngân sách và
 * chặn nhau. Dùng `sessionKeyOf` (đã tách theo session) làm phần danh tính.
 */
function agentTurnKey(agent, turn) {
  return `${sessionKeyOf(agent) ?? agent?.id ?? 'agent'}:${turn}`;
}

/** Khoá theo đối tượng session, cho trường hợp session không có `id`. */
const objectKeys = new WeakMap();
let objectKeySeq = 0;

/**
 * Bản ghi trạng thái của một session, CHỈ ĐỌC — không tạo entry mới.
 *
 * Dùng cho mọi đường đọc (`sessionOf`, `taskOf`). Phải tách khỏi `seenFor`:
 * nếu đường đọc cũng tạo entry thì mỗi lần đọc là một lần ghi, và `evictOldest`
 * sẽ đẩy entry THẬT ra khỏi Map.
 *
 * Đây là lỗi thật đã đo: 250 agent chỉ-đọc (không ghi state) chạy qua
 * `agent/request` đủ để **evict task thật của một agent khác** — test tái hiện
 * cho `REAL_TASK_A` biến mất khỏi request gửi Jev.
 */
function seenEntryOf(agent, session) {
  const key = sessionKeyOf(agent, session);
  if (key === undefined) return undefined;
  return seenBySession.get(key);
}

/** Bản ghi trạng thái của một session; tạo mới khi chưa có (đường GHI). */
function seenFor(agent, session) {
  const key = sessionKeyOf(agent, session);
  if (key === undefined) return undefined;
  let entry = seenBySession.get(key);
  if (entry === undefined) {
    entry = { session: undefined, goal: undefined, prompt: undefined };
    seenBySession.set(key, entry);
    evictOldest(seenBySession);
    return entry;
  }
  /**
   * Chạm vào entry đang dùng ⇒ đưa nó về CUỐI Map.
   *
   * Map giữ thứ tự chèn, và `evictOldest` xoá từ ĐẦU. Nếu không chạm, eviction
   * là FIFO: một session đang hoạt động nhưng được chèn sớm vẫn bị đẩy ra trước
   * một session chết vừa được chèn. Đây là lỗi thật đã đo — agent A nạp task,
   * 250 session khác đi qua, task của A bị evict dù A vẫn đang làm việc.
   *
   * `delete` + `set` là cách đưa một khoá về cuối Map (Map không có `touch`).
   */
  seenBySession.delete(key);
  seenBySession.set(key, entry);
  return entry;
}

/**
 * Ghi session/goal của một agent. KHÔNG tạo entry nếu không có gì để ghi.
 *
 * Đây là chỗ chống evict thật: `agent/request` gọi hàm này cho MỌI agent, kể cả
 * agent chỉ chạy qua một lần. Nếu nó tạo entry rỗng cho mỗi lần gọi thì Map đầy
 * entry vô giá trị và `evictOldest` đẩy entry THẬT (có task) ra ngoài.
 *
 * Đo được: 250 agent đi qua `agent/request` đủ để `REAL_TASK_A` biến mất khỏi
 * request gửi Jev. Sửa bằng cách chỉ tạo entry khi thật sự có session hoặc goal.
 */
function noteSession(agent) {
  const hasSession = agent?.session !== undefined && agent.session !== null;
  const objective = agent?.goal?.objective;
  const hasGoal = typeof objective === 'string' && objective.trim();
  if (!hasSession && !hasGoal) return;

  const entry = seenFor(agent);
  if (entry === undefined) return;
  if (hasSession) entry.session = agent.session;
  if (hasGoal) entry.goal = objective;
}

/** Rút text từ `messages` của `agent/pre-step`. */
function notePrompt(agent, messages) {
  if (!Array.isArray(messages) || !messages.length) return;
  const parts = [];
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    // Chỉ tin nhắn THẬT của user. `messages` ở pre-step gồm cả runtime-context,
    // skill-catalog, agent-instructions, tool-jobs, và gợi ý do plugin này chèn
    // — tất cả đều role=user. Gộp hết sẽ lấy output tool làm "task của user".
    if (!isGenuineUserMessage(message)) continue;
    const content = message.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === 'string') parts.push(block.text);
      }
    }
  }
  const text = parts.join('\n').trim();
  if (!text) return;
  const entry = seenFor(agent);
  if (entry !== undefined) entry.prompt = text;
}

/**
 * Session của một agent (dùng cho `recentToolCalls`/`collectProgress`). CHỈ ĐỌC.
 *
 * Đọc thẳng `agent.session` — KHÔNG tra Map. Mọi caller đều có `agent` và engine
 * luôn fuse session vào payload agent-scoped (`dsh-agent/lib/index.js:242`), nên
 * tra Map chỉ thêm một đường phụ thuộc mà không thêm thông tin: nếu Map đã evict
 * entry thì hàm trả `undefined` dù agent vẫn cầm session của chính nó.
 *
 * Dự phòng qua Map cho đường cũ không truyền session.
 */
function sessionOf(agent) {
  if (agent?.session) return agent.session;
  return seenEntryOf(agent)?.session;
}

/** Task text gần nhất của một agent. `undefined` khi chưa biết. CHỈ ĐỌC. */
function taskOf(agent, fallback) {
  const entry = seenEntryOf(agent);
  return entry?.goal ?? entry?.prompt ?? fallback;
}

/**
 * Tin nhắn này có phải do user gõ không.
 *
 * DSH gắn `source.kind === 'user'` cho tin nhắn thật; mọi thứ máy sinh ra
 * (runtime-context, skill-catalog, agent-instructions, tool-jobs, ...) mang kind
 * khác. Plugin này tự chèn thì `source: 'jev-gate'` (một chuỗi).
 *
 * Không nhận diện được → coi là KHÔNG phải user. Thà bỏ sót còn hơn nhận nhầm
 * nội dung không tin cậy vào trường "yêu cầu của user".
 */
export function isGenuineUserMessage(message) {
  const source = message?.source;
  return source !== null && typeof source === 'object' && source.kind === 'user';
}

/**
 * Động từ/dấu hiệu của một yêu cầu xoá — tín hiệu yếu, chỉ dùng để xếp hạng.
 *
 * Dùng lookaround Unicode (`(?<![\p{L}\p{N}_])`) chứ KHÔNG dùng `\b`: `\b` của
 * JS chỉ hiểu ASCII word char, nên `xoá` (kết thúc bằng `á`) TRƯỢT trong khi
 * `xóa` (kết thúc bằng `a`) khớp — bỏ sót đúng cách viết phổ biến. Lookaround
 * dùng `\p{L}` nên khớp cả hai. Đo: `xoá`/`xóa`/`dọn`/`dẹp` đều khớp, mà
 * `form`/`firm`/`sửa` không khớp oan.
 */
const DELETE_HINT = /(?<![\p{L}\p{N}_])(rm|unlink|rmdir|xoá|xóa|delete|remove|dọn|dẹp|clean|wipe|purge)(?![\p{L}\p{N}_])/iu;

/**
 * Chọn bằng chứng cho câu hỏi authorization — XẾP HẠNG theo liên quan, KHÔNG
 * lấy N tin gần nhất.
 *
 * Vì sao không `slice(-3)`: nó quên yêu cầu ở tin thứ 4 trở đi. Đo trên hội
 * thoại 25 tin, yêu cầu xoá ở vị trí 10 → Jev nhận `unrelated` → CHẶN OAN.
 * Nới cửa sổ lên 10 tin cũng không giải được (hội thoại dài bao nhiêu cũng có
 * giới hạn); phải tìm theo NỘI DUNG, không theo VỊ TRÍ.
 *
 * Điểm xếp hạng, mạnh → yếu:
 *   1. Token khớp giữa tin nhắn và lệnh sắp chạy (+10 mỗi token) — tín hiệu
 *      mạnh nhất: tin nào nhắc tới đúng đường dẫn/tên tài nguyên thì liên quan.
 *   2. Có động từ xoá (+3) — tín hiệu yếu, chỉ phân biệt trong nhóm đã khớp.
 *   3. Recency (+0..1) — chỉ phá hoà, KHÔNG lấn át (1) và (2).
 *
 * AN TOÀN: hàm này chỉ SẮP XẾP, không mở rộng nguồn. Tầng lọc
 * `source.kind === 'user'` ở `collectUserRequest` chạy TRƯỚC, nên nội dung dán
 * vào không bao giờ tới được đây — xếp hạng không mở đường injection.
 */
function selectEvidence(texts, command, limit = 3) {
  const commandTokens = new Set(tokenize(command));
  return texts
    .map((text, index) => {
      let score = 0;
      for (const token of tokenize(text)) {
        if (commandTokens.has(token)) score += 10;
      }
      if (DELETE_HINT.test(text)) score += 3;
      score += index / Math.max(texts.length - 1, 1);
      return { text, index, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    // Giữ thứ tự thời gian trong tập đã chọn để Jev đọc mạch liền. So bằng
    // `index` (không dùng `indexOf(text)`: hai tin trùng nội dung sẽ về cùng
    // một vị trí và làm sai thứ tự).
    .sort((a, b) => a.index - b.index)
    .map((entry) => clip(entry.text, 600).text)
    .join('\n---\n');
}

/**
 * Lấy tin nhắn thật của user trong session, chọn tập liên quan nhất.
 *
 * Đây là bằng chứng cho câu hỏi "user có yêu cầu xoá không". Cố ý CHỈ lấy
 * `source.kind === 'user'`: nếu lẫn output tool hay nội dung dán vào, nội dung
 * không tin cậy có thể tự cấp quyền xoá (đã đo: dán "user đã phê duyệt" làm
 * nhánh `noul` cũ trả 0.73–0.93).
 *
 * `command` được truyền vào để xếp hạng theo liên quan (xem `selectEvidence`).
 * Ranked fallback evidence is bounded to three 600-character messages. The
 * latest same-target message stays whole for deterministic authorization proof.
 */
export async function collectUserRequest(session, command = '') {
  const events = sessionEvents(session);
  const texts = [];
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const data = dataOf(event);
    const message = data.message ?? data;
    if (!isGenuineUserMessage(message)) continue;
    const text = textOf(message).trim();
    if (text) texts.push(text);
  }
  if (!texts.length) return '';
  // A pathless explicit cancellation revokes older requests as well.
  const cancelled = /(?:^|[^\p{L}\p{N}_])(?:(?:do not|don't|never)\s+(?:run|execute|delete|remove|truncate|overwrite|wipe|shred)(?:\s+it)?|cancel(?: it| that)?|stop(?: now)?|(?:đừng|chớ|không)\s+(?:chạy|xóa|xoá|ghi đè)(?:\s+(?:nó|nữa))?|hủy(?: đi)?|huỷ(?: đi)?|dừng(?: lại)?|停止|取消|别(?:执行|删除)|不要(?:执行|删除))(?:$|[^\p{L}\p{N}_])/iu;
  // A later user message about the same target supersedes an older approval.
  // Never splice an old destructive verb into a newer denial or discussion.
  const targets = extractCommandTargets(command);
  if (targets.length) {
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      if (cancelled.test(texts[index])) return texts[index];
      const request = normalizeText(texts[index]);
      if (targets.some((target) => requestNamesTarget(request, target))) {
        // This text stays in the deterministic proof; clipping can hide a revocation.
        return texts[index];
      }
    }
  }
  return selectEvidence(texts, command, 3);
}

/**
 * Các động từ mà "target" là mọi đối số không phải cờ (đường dẫn/tên tài
 * nguyên). Cố ý HẸP: chỉ những lệnh mà việc trích target là rõ ràng. Lệnh lạ
 * rơi xuống `false` (fail-closed), không đoán bừa.
 */
const TARGET_VERBS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'mv', 'tee']);
/** Cờ có GIÁ TRỊ RIÊNG — giá trị đó không phải target (vd `truncate -s 0 f`). */
const VERB_VALUE_FLAGS = new Set(['-s', '--size', '-n', '--iterations', '-t', '--target-directory']);
/** Tiền tố trung tính: bỏ qua để tìm động từ thật (`sudo rm ...`). */
const NEUTRAL_PREFIX = new Set(['sudo', 'doas', 'env', 'command', 'nice', 'nohup', 'time']);

/** Normalize whitespace, preserving case-sensitive filesystem target identity. */
const normalizeText = (text) => (typeof text === 'string' ? text : '').replace(/\s+/gu, ' ').trim();

/** Bỏ cặp nháy bao ngoài của một token shell. */
const stripQuotes = (word) => word.replace(/^(['"])(.*)\1$/su, '$2');

/**
 * Trích các "target" của một lệnh shell mà nó có khả năng phá dữ liệu.
 *
 * Hỗ trợ tối thiểu các dạng phổ biến: `rm`/`rmdir`/`unlink`/`shred`/`truncate`/
 * `mv`/`tee <paths>`, `dd of=<path>`, `find <path> ... -delete`, và ghi đè
 * `> file` (KHÔNG tính `>>` — append không phá dữ liệu).
 *
 * Trả về [] khi KHÔNG trích được target rõ ràng (lệnh lạ, chỉ có cờ, không phải
 * chuỗi). Caller coi [] là "không chứng minh được" → CHẶN. Đây là chủ ý: đoán
 * bừa một target sẽ tạo cả allow nhầm lẫn deny nhầm, mà allow nhầm là không.
 */
function extractCommandTargets(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const targets = [];

  // `>` ghi đè — quét trên toàn lệnh vì redirect có thể nằm ở bất kỳ segment.
  for (const match of command.matchAll(/(?:^|[^>])>(?!>)\s*([^\s;&|]+)/gu)) {
    targets.push(match[1]);
  }

  for (const rawSegment of command.split(/[;&|\n]+/u)) {
    const words = rawSegment.trim().split(/\s+/u).map(stripQuotes).filter(Boolean);
    if (!words.length) continue;

    let index = 0;
    while (NEUTRAL_PREFIX.has(words[index]) && index + 1 < words.length) index += 1;
    const verb = words[index];

    if (verb === 'find') {
      // Chỉ tính khi có hành vi xoá; target = các đường dẫn ĐẦU (trước predicate
      // đầu tiên, tức token bắt đầu bằng `-`). Không lấy giá trị của `-name`.
      if (!/-delete\b|--delete\b|-exec\b/u.test(rawSegment)) continue;
      for (const word of words.slice(index + 1)) {
        if (word.startsWith('-')) break;
        targets.push(word);
      }
      continue;
    }

    if (verb === 'dd') {
      // Chỉ `of=` là ĐÍCH ghi đè; `if=` là nguồn đọc, không phải dữ liệu bị phá.
      for (const word of words.slice(index + 1)) {
        const match = /^of=(.+)$/u.exec(word);
        if (match) targets.push(match[1]);
      }
      continue;
    }

    if (!TARGET_VERBS.has(verb)) continue;
    // `tee -a` là append → không phá dữ liệu.
    if (verb === 'tee' && (words.includes('-a') || words.includes('--append'))) continue;

    for (let i = index + 1; i < words.length; i += 1) {
      const word = words[i];
      if (word.startsWith('-')) {
        if (VERB_VALUE_FLAGS.has(word)) i += 1; // bỏ luôn giá trị của cờ
        continue;
      }
      targets.push(word);
    }
  }

  return targets;
}

/**
 * ĐỘNG TỪ PHÁ DỮ LIỆU TƯỜNG MINH — điều kiện (1) của provenance.
 *
 * Tách khỏi `DELETE_HINT` (regex kia chỉ để XẾP HẠNG bằng chứng, nên cố ý rộng
 * và chấp nhận nhiễu). Ở đây là một CHỐT AN TOÀN: thiếu động từ thì không
 * chứng minh được ý định, kể cả target có xuất hiện.
 *
 * Vì sao cần: `source.kind === 'user'` chỉ chứng minh tin nhắn đến từ user,
 * KHÔNG chứng minh user đang ủy quyền. "Giải thích vì sao `rm -rf /tmp/x` nguy
 * hiểm" có target, có cả chữ `rm` — nhưng không phải một yêu cầu xoá. Bổ sung
 * nhóm ghi-đè (`ghi đè`/`overwrite`/`truncate`/`dd`) để `dd of=` và redirect `>`
 * vẫn chứng minh được, đúng như trước.
 */
// Positive proof: a direct imperative, optionally prefixed by a request marker.
// Ambiguous housekeeping verbs never establish deletion consent.
const DESTRUCTIVE_REQUEST = /^(?:(?:please|hãy|vui lòng)\s+)?(rm|rmdir|unlink|shred|truncate|wipe|purge|delete|remove|overwrite|dd|xoá|xóa|ghi\s*đè|ghi\s*đe)(?![\p{L}\p{N}_])\s+(?=\S)/iu;

function isExplicitDestructiveRequest(request, targets, command) {
  const prefix = DESTRUCTIVE_REQUEST.exec(request);
  if (!prefix) return false;
  const words = command.trim().split(/\s+/u);
  let index = 0;
  while (NEUTRAL_PREFIX.has(words[index]) && index + 1 < words.length) index += 1;
  const verb = words[index];
  const action = /^(?:overwrite|dd|ghi\s*đè|ghi\s*đe)$/iu.test(prefix[1]) ? 'overwrite'
    : /^truncate$/iu.test(prefix[1]) ? 'truncate'
      : /^(?:shred|wipe)$/iu.test(prefix[1]) ? 'shred' : 'delete';
  const actual = verb === 'truncate' ? 'truncate' : verb === 'shred' ? 'shred'
    : verb === 'dd' || verb === 'tee' || /[<>]/u.test(command) ? 'overwrite'
      : ['rm', 'rmdir', 'unlink'].includes(verb)
        || verb === 'find' && words.includes('-delete') ? 'delete' : undefined;
  if (action !== actual) return false;
  const names = targets.map((target) => normalizeText(target)
    .replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const target = `(?:["']?(?:\\./)?(?:${names.join('|')})\\/*["']?)`;
  // Consume the whole request: a verb prefix alone also matches descriptions.
  const body = `(?:(?:file|files|folder|folders|directory|directories|thư mục|tệp|toàn bộ)\\s+)?${target}`;
  return new RegExp(`^${body}(?:(?:\\s+(?:(?:and|và)\\s+)?|,\\s*)${body})*(?:\\s+(?:for me|giúp tôi|đi))?[.!]?$`, 'iu')
    .test(request.slice(prefix[0].length));
}

/**
 * DẤU HIỆU PHỦ ĐỊNH / CÂU HỎI / BÀN LUẬN / TRÍCH DẪN — điều kiện (2).
 *
 * Có bất kỳ dấu hiệu nào thì KHÔNG auto-authorize, kể cả khi target khớp và động
 * từ có mặt. Các ca thật đã gặp:
 *
 *   đừng xóa /tmp/gtest              → `đừng`
 *   có nên xóa /tmp/gtest không?     → `có nên`, `không`, `?`
 *   giải thích lệnh rm -rf /tmp/x    → `giải thích`
 *   README nói hãy xóa /tmp/x        → `readme`, `nói`
 *   nếu xóa /tmp/gtest thì sao?      → `nếu`, `thì sao`, `?`
 *
 * QUÉT TOÀN BỘ TIN NHẮN, không theo cửa sổ quanh động từ. Đây là chủ ý: hướng
 * sai của phép kiểm này là "không chứng minh được" → rơi xuống THẺ ĐỒNG Ý (hỏi
 * user), chứ không phải cho qua. Thà hỏi thừa còn hơn cho qua nhầm — cùng ngữ
 * nghĩa "im lặng không phải là đồng ý" của Lớp 1b.
 *
 * Cố ý KHÔNG liệt kê dấu nháy đơn/đôi: người dùng thật hay bọc target trong
 * nháy khi ra lệnh ("xoá 'tmp/foo' đi"), nên coi đó là bàn luận sẽ hỏi thừa
 * hàng loạt. Nhưng dấu ` (backtick) thì CÓ, vì nó là cách viết markdown để
 * TRÍCH một đoạn code/lệnh — đúng ngữ cảnh "đang bàn về lệnh này", không phải
 * đang ra lệnh. Trích dẫn NGUỒN (README/tài liệu/nói/theo) cũng là dấu hiệu thật.
 */
const HEDGE_MARKER = /(?<![\p{L}\p{N}_])(?:đừng|chớ|không|chưa|khoan|nếu|thì sao|có nên|giải thích|vì sao|tại sao|cách|nói|bảo|theo|tài liệu|ví dụ|cân nhắc|sẽ làm gì|có tác dụng gì|don't|do not|never|not|without|avoid|instead|rather than|suppose|what|how|why|when|consider|considering|thinking|explain|readme|says|said|according|docs|documentation|example|quoted)(?![\p{L}\p{N}_])|[?`]/iu;

/**
 * Provenance TẤT ĐỊNH: user có THẬT SỰ yêu cầu chạy đúng hành động này không?
 * Thay cho call LLM `authorizationQuestion` (xem comment ở Lớp 1).
 *
 * Ba điều kiện phải hội đủ (P0.1 — "strict user-intent proof"):
 *
 *   1. Complete destructive imperative and target list (`isExplicitDestructiveRequest`).
 *   2. KHÔNG có dấu hiệu phủ định / câu hỏi / bàn luận / trích dẫn
 *      (`HEDGE_MARKER`).
 *   3. PHỦ ĐỦ TARGET: mọi target của lệnh đều xuất hiện trong lời user.
 *
 * Bất biến an toàn: chỉ trả `true` khi CHỨNG MINH được cả ba. Không có yêu cầu,
 * thiếu động từ, có dấu hiệu hedge, không trích được target, hoặc target không
 * xuất hiện → `false` (caller chuyển sang THẺ ĐỒNG Ý, không cho qua). Nếu lệnh
 * có nhiều target, TẤT CẢ phải xuất hiện — user chỉ nêu một phần thì lệnh xoá
 * nhiều hơn điều họ nói, đúng trường hợp phải hỏi.
 *
 * Target identity is case-sensitive; request verbs remain case-insensitive.
 * Boundary matching keeps `/tmp/gtest` distinct from `/tmp/gtest-other`.
 */
export function commandTargetsInUserRequest(userRequestText, command) {
  const request = normalizeText(userRequestText);
  if (!request) return false;
  // A target parser for simple commands cannot prove what a compound shell
  // expression, expansion, redirection, or comment will actually execute.
  if (typeof command !== 'string' || /[;&|`$\n\\#{}]/u.test(command)
    || /(?:^|\s)-(?:exec|execdir|ok|okdir|fprint|fprint0|fprintf)(?:\s|$)/u.test(command)) return false;
  if (HEDGE_MARKER.test(request)) return false;
  const targets = extractCommandTargets(command);
  if (!targets.length || targets.some((target) => /[*?\[\]()]/u.test(target) || target.startsWith('~'))) return false;
  if (!isExplicitDestructiveRequest(request, targets, command)) return false;
  if (/[<>]/u.test(command) && !/^\s*(?:echo|printf)\s+[^<>]+\s>\s*[^<>\s]+\s*$/u.test(command)) return false;
  return targets.every((target) => requestNamesTarget(request, target));
}

/** Một target xuất hiện trong văn bản đã chuẩn hoá, có kiểm biên hai đầu. */
function requestNamesTarget(normalizedRequest, target) {
  const needle = normalizeText(target).replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // ./path and path, or /path and /path/, name the same target; descendants do not.
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_.\\-\\/])(?:\\./)?${escaped}\\/*(?:$|[^\\p{L}\\p{N}_.\\-\\/])`, 'u');
  return pattern.test(normalizedRequest);
}

/**
 * Thẻ ĐỒNG Ý cho hành động phá dữ liệu do AGENT tự đề nghị (Lớp 1b).
 *
 * ## Vì sao tồn tại
 *
 * Yêu cầu gốc: yêu cầu CỦA USER là kiên quyết — user bảo xoá thì xoá. Nhưng khi
 * AGENT tự đề nghị xoá giữa lúc chạy, nó phải HỎI user và CHỜ đồng ý; tuyệt đối
 * không tự xoá khi user chưa cho phép. Provenance tất định
 * (`commandTargetsInUserRequest`) đã xử nhánh đầu; đây là nhánh sau: không
 * chứng minh được user yêu cầu → xin đồng ý thay vì chặn cứng.
 *
 * ## Vì sao là thẻ nổi qua `ctx.userQuestions`, không phải `ctx.approval`
 *
 * `ctx.approval` (đường `{kind:'ask'}` của `tools/pre-execute`) ở bản deploy này
 * đã bị `dsh-purge` vá thành auto-grant: `dsh-user-approval/lib/index.js:173-178`
 * trả thẳng `"allowed-once"` mà không hỏi ai. Nghĩa là nhánh đó KHÔNG thể lấy
 * được đồng ý thật — hỏi cũng như không. `dsh-user-questions` còn nguyên, và
 * đúng là kênh hỏi user thật (thẻ nổi, có thể gõ trả lời). Nên dùng nó.
 *
 * ## Trả gì
 *
 *   - `{ decision: 'approved' }` — user chọn đúng nhãn đồng ý, không gõ thêm gì.
 *   - `{ decision: 'refused', reason }` — user từ chối, bỏ qua thẻ, hoặc hết hạn.
 *   - `{ decision: 'unavailable', reason }` — không có kênh hỏi user: subagent
 *     (`session.delegationDepth > 0`), chưa có client, service vắng, lỗi bất ngờ.
 *
 * Caller coi `refused` và `unavailable` như nhau: CHẶN. Không nhánh nào cho qua
 * chỉ vì thiếu kênh hỏi — đây là lớp FAIL-CLOSED.
 *
 * Chỉ nhãn đồng ý CHÍNH XÁC, chọn đúng một, không kèm văn bản tự gõ, mới tính là
 * đồng ý — cùng quy tắc với `dsh-plan-mode` (`item.selected.length === 1 &&
 * item.selected[0] === APPROVE_LABEL && item.custom === undefined`).
 */
const CONSENT_ID = 'jev-destructive-consent';
const CONSENT_APPROVE = 'Run it';
const CONSENT_REFUSE = 'Do not run it';

async function askDestructiveConsent(ctx, exec, command, timeoutMs) {
  if (exec?.agent === undefined) {
    return { decision: 'unavailable', reason: 'no agent to ask' };
  }
  /**
   * SUBAGENT → không có kênh hỏi user thật, phải CHẶN.
   *
   * Cùng chốt với Lớp 7 (`session.delegationDepth > 0` là subagent). Nếu không
   * kiểm ở đây, một subagent vẫn `ctx.get('userQuestions')` được và thẻ sẽ nổi
   * trên phiên cha — nhưng đó là quyết định của người dùng về một hành động mà
   * subagent tự đề nghị, không phải về yêu cầu của chính họ. Với gate thì hướng
   * an toàn là TỪ CHỐI: subagent không được tự lấy đồng ý thay user.
   */
  if (exec.agent.session?.delegationDepth > 0) {
    return { decision: 'unavailable', reason: 'subagent cannot ask the user' };
  }
  let service;
  try {
    // `strict=false`: service tuỳ chọn — thiếu thì trả `undefined`, không ném.
    service = ctx.get('userQuestions', false);
  } catch {
    service = undefined;
  }
  if (service === undefined
    || (typeof service.ask !== 'function' && typeof service.askTimed !== 'function')) {
    return { decision: 'unavailable', reason: 'no user-questions channel' };
  }
  const question = {
    id: CONSENT_ID,
    header: 'Destructive action',
    question: `Allow this ${exec.name} command to run?`,
    detail: clip(command, 2_000).text,
    options: [
      { label: CONSENT_APPROVE, description: 'Run the command exactly as shown.' },
      { label: CONSENT_REFUSE, description: 'Block it. The command will not run.' },
    ],
    // `intent` bắt buộc để thẻ có nút đồng ý/từ chối nổi bật; `detail` là bắt
    // buộc khi có `intent` (service tự kiểm, ném BAD_INTENT nếu thiếu).
    intent: { kind: 'jev-destructive-consent', approve: CONSENT_APPROVE, callId: exec.callId },
  };
  const request = { questions: [question], agent: exec.agent, signal: exec.signal };
  let answer;
  try {
    // Ưu tiên `askTimed`: có countdown + client giữ claim, hết hạn trả
    // `{pending:true}` thay vì treo mãi. Thiếu `askTimed`/`callId` thì dùng
    // `ask` trực tiếp (như `dsh-plan-mode`).
    answer = typeof service.askTimed === 'function' && exec.callId !== undefined
      ? await service.askTimed(request, exec.callId, timeoutMs)
      : await service.ask(request);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'ASK_CANCELLED' || code === 'ASK_TIMED_OUT' || code === 'ASK_ABORTED') {
      return { decision: 'refused', reason: code };
    }
    return { decision: 'unavailable', reason: code || error?.name || 'ask failed' };
  }
  if (answer?.pending === true) return { decision: 'refused', reason: 'ASK_TIMED_OUT' };
  const item = Array.isArray(answer?.answers)
    ? answer.answers.find((entry) => entry?.id === CONSENT_ID)
    : undefined;
  const approved = Array.isArray(item?.selected)
    && item.selected.length === 1
    && item.selected[0] === CONSENT_APPROVE
    && item.custom === undefined;
  return approved ? { decision: 'approved' } : { decision: 'refused', reason: 'not approved' };
}

/** Dữ liệu của một event nằm trong `.data`; mỗi loại event có shape riêng. */
const dataOf = (event) => (event && typeof event === 'object' ? event.data ?? {} : {});

function sessionEvents(session) {
  if (!session) return [];
  for (const read of ['snapshotEvents', 'ownEvents']) {
    try {
      const events = session[read]?.();
      if (Array.isArray(events)) return events;
    } catch {
      /* thử reader kế tiếp */
    }
  }
  return [];
}

async function collectEvidence(session) {
  const events = sessionEvents(session);
  const parts = [];
  let testSignal;

  // Câu trả lời cuối của assistant là bằng chứng cho các goal hoàn thành bằng
  // văn bản (giải thích, tóm tắt, soạn thảo). Bỏ nó đi thì Jev không thể phân
  // biệt "đã viết xong" với "chưa làm gì".
  const finalAnswer = events
    .filter((event) => event?.type === 'assistant/message')
    .slice(-1)
    .map((event) => textOf(dataOf(event).message ?? dataOf(event)))
    .filter(Boolean)
    .join('\n');
  if (finalAnswer) parts.push(`- final assistant reply: ${clip(finalAnswer, 900).text}`);

  const toolResults = events.filter((event) => event?.type === 'tool/result').slice(-6);
  for (const event of toolResults) {
    const data = dataOf(event);
    const text = textOf(data.message ?? data.result ?? data);
    if (!text) continue;
    parts.push(`- ${data.name ?? 'tool'} output: ${clip(text, 700).text}`);
    if (!testSignal && /(pass|fail|error|exit code|ok\b|✓|✗)/i.test(text)) testSignal = clip(text, 300).text;
  }
  return { text: parts.join('\n') || '(no work recorded yet)', testSignal };
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  const blocks = value?.content;
  if (Array.isArray(blocks)) {
    return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
  }
  // Một content block đơn lẻ (`{ type: 'text', text }`) — `result.content` của
  // tool là mảng block, không phải message có `.content`, nên phải nhận cả hai.
  if (typeof value?.text === 'string') return value.text;
  return '';
}

/**
 * Tín hiệu ĐO ĐƯỢC của một turn, dùng cho Lớp 3 (chọn effort).
 *
 * Trả:
 *   - `toolErrors`   : số `tool/result` có `isError`/`error` (tool thất bại thật)
 *   - `testFailures` : số lần một TRÌNH CHẠY TEST thật sự báo fail
 *
 * ## Vì sao phải biết LỆNH NÀO sinh ra output
 *
 * Bản đầu chỉ quét text của mọi `tool/result` để tìm chữ `FAIL`. Đo trên 1.762
 * `tool/result` thật: **45 khớp, và 45/45 là FALSE POSITIVE (100%)** — không
 * lần nào là test fail thật. Lý do: khi agent `cat` một file test, `grep` trong
 * log, hay đọc output cũ, chữ `FAIL` trong NỘI DUNG bị tính là test fail.
 *
 * Hậu quả thật, đo được ngay sau khi restart: một turn đọc file test bị chấm
 * `reason: test_failure:6` và đẩy lên `high` — đúng kiểu "nâng effort vô cớ"
 * mà thiết kế này sinh ra để tránh.
 *
 * Nên phải nối `tool/result` với `tool/call` tương ứng (`toolCallId`) và CHỈ
 * xét khi chính lệnh đó là một trình chạy test. Chữ `FAIL` trong output của
 * `cat`/`grep`/`read` không nói gì về việc code có đúng không.
 */
async function turnSignals(session, turn) {
  if (!Number.isFinite(turn)) return { toolErrors: 0, testFailures: 0 };
  const events = sessionEvents(session);
  /** callId → command, để biết output thuộc về lệnh nào. */
  const commandOf = new Map();
  for (const event of events) {
    if (event?.type !== 'tool/call') continue;
    const data = dataOf(event);
    const args = data.arguments ?? {};
    const command = typeof args.command === 'string' ? args.command : '';
    if (data.callId !== undefined) commandOf.set(data.callId, command);
  }
  let toolErrors = 0;
  let testFailures = 0;
  for (const event of events) {
    if (event?.type !== 'tool/result') continue;
    const data = dataOf(event);
    if (Number.isFinite(data.turn) && data.turn !== turn) continue;
    const message = data.message ?? {};
    if (message.isError === true || data.error !== undefined) {
      /**
       * ABORT không phải "tool thất bại".
       *
       * `data.error` có mặt ở cả hai trường hợp: tool chạy và lỗi thật, VÀ tool
       * bị HUỶ giữa đường (người dùng dừng turn, timeout, abort signal). Trường
       * hợp sau không nói gì về việc bước trước khó hay không — nó chỉ nói turn
       * bị dừng. Đếm nó là `toolErrors` làm Lớp 3 nâng `high` vô cớ.
       *
       * Đo trên dữ liệu thật: `AbortError`/`ABORTED` chiếm phần lớn `data.error`.
       * Nên loại rõ ràng theo `code`/`name` của lỗi.
       */
      const errCode = data.error?.code ?? data.error?.name ?? '';
      const aborted = message.error?.name === 'AbortError'
        || errCode === 'AbortError' || errCode === 'ABORTED'
        || errCode === 'TimeoutError';
      if (aborted) continue;
      toolErrors += 1;
      continue;
    }
    /**
     * `toolCallId` nằm trong `data.message`, KHÔNG phải `data`.
     *
     * Shape thật (đọc từ session v4): `data = {turn, step, message}`, và
     * `message = {role, source, toolCallId, content, isError, id}`. Bản đầu đọc
     * `data.toolCallId` nên luôn `undefined` → phép nối hỏng HOÀN TOÀN, đo được
     * **0/1.787 lần nối thành công** → tính năng im lặng không làm gì.
     *
     * Đây đúng loại lỗi "đọc sai field thì thất bại im lặng" đã ghi ở đầu repo.
     * Lấy cả hai đường (`message.toolCallId` và `message.source.callId`) để
     * không phụ thuộc một field.
     */
    const callId = message.toolCallId ?? message.source?.callId;
    const command = commandOf.get(callId) ?? '';
    if (!TEST_RUNNER_PATTERN.test(command)) continue;
    const text = textOf(message) ?? '';
    if (TEST_FAILURE_PATTERN.test(text)) testFailures += 1;
  }
  return { toolErrors, testFailures };
}

/**
 * Lệnh này có phải TRÌNH CHẠY TEST không.
 *
 * Bắt buộc phải có: nếu không, chữ `FAIL` nằm trong nội dung file mà agent đọc
 * sẽ bị tính là test fail (đo được: 45/45 false positive).
 *
 * Nhận các trình chạy test phổ biến. Cố ý KHÔNG nhận `node`/`python3` trần —
 * chỉ khi có cờ/subcommand test thật (`--test`, `-m pytest`, `go test`, …).
 */
const TEST_RUNNER_PATTERN = new RegExp([
  String.raw`\bnode\s+--test\b`,
  String.raw`\bnpm\s+(?:run\s+)?test\b`,
  String.raw`\bnpm\s+t\b`,
  String.raw`\b(?:pnpm|yarn)\s+(?:run\s+)?test\b`,
  String.raw`\bpytest\b`,
  String.raw`\bpython[0-9.]*\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`\bjest\b`,
  String.raw`\bvitest\b`,
  String.raw`\bmocha\b`,
  String.raw`\bgo\s+test\b`,
  String.raw`\bcargo\s+test\b`,
  String.raw`\brspec\b`,
  String.raw`\bphpunit\b`,
  String.raw`\bdotnet\s+test\b`,
  String.raw`\bmvn\s+test\b`,
  String.raw`\bgradle\s+test\b`,
  String.raw`\bmake\s+test\b`,
  String.raw`\brtk\s+test\b`,
].join('|'), 'i');

/**
 * Dấu hiệu test/kiểm tra THẤT BẠI trong output tool.
 *
 * Cố ý hẹp để không nhận nhầm: chỉ các chuỗi mà trình chạy test thật sự in ra
 * khi fail. `passed` không tính. Một dòng `FAIL` đứng riêng cũng tính.
 */
const TEST_FAILURE_PATTERN = /(^|\n)\s*(FAIL|FAILED|not ok)\b|\btests? failed\b|\b\d+ (?:tests? )?failed\b|\bAssertionError\b|\bexit code [1-9]\d*\b/i;

/* ───────────────── Lớp 7: đọc workspace change + điểm review ───────────────── */

/**
 * Tóm tắt thay đổi file của turn hiện tại, qua service `workspaceChanges` do
 * plugin `dsh-workspace-changes` cung cấp.
 *
 * Service chỉ phơi `summary(sessionId, seq)` — cần `seq` của event
 * `workspace/changes` gần nhất. Lấy từ chính session: event đó được append ở
 * cuối turn (`dsh-workspace-changes/lib/index.js:897`), nên event cuối cùng
 * thuộc loại này là của turn đang kết thúc.
 *
 * Trả `{ summary, seq }` — **kèm `seq` của EVENT**, không chỉ summary.
 *
 * Vì sao phải trả cả `seq`: `service.diff(sessionId, seq, index)` tra record
 * theo seq của **event**, không theo seq của từng file. `WorkspaceChangedFile`
 * (provider 0.2.0-rc.2) chỉ có `path/display/added/deleted/binary/oversized`,
 * KHÔNG có `seq` — `changedFile()` không hề sinh field đó. Bản 0.4.0 đọc
 * `summary.files[i].seq ?? 0` nên luôn tra seq 0, provider trả `undefined`,
 * diff rỗng, và Lớp 7 chết ở `skip_empty_diff` (đo trên 16.905 dòng log thật:
 * 66 lần fire, **0 lần `reviewed`**).
 *
 * Trả `undefined` khi service vắng, chưa có event, hay session chưa từng ghi
 * thay đổi — mọi trường hợp đều là "không có gì để review", không phải lỗi.
 */
function workspaceSummaryOf(ctx, session) {
  if (!session?.id) return undefined;
  /**
   * `workspaceChanges` KHÔNG nằm trong `inject` của plugin: nó là service tuỳ
   * chọn, do một plugin khác (`dsh-workspace-changes`) cung cấp. Đưa nó vào
   * `inject` sẽ làm cả plugin không nạp khi service vắng.
   *
   * `ctx.get(name, false)` là cách đọc service tuỳ chọn: `strict=false` trả
   * `undefined` thay vì ném lỗi khi service chưa có. (`ctx.inject([...], cb)` là
   * loader plugin bất đồng bộ, KHÔNG phải service getter — dùng nó ở đây sẽ
   * luôn trả `undefined`.)
   */
  let service;
  try {
    service = ctx.get('workspaceChanges', false);
  } catch {
    return undefined;
  }
  if (typeof service?.summary !== 'function') return undefined;
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type !== 'workspace/changes') continue;
    const seq = events[index].seq;
    if (!Number.isSafeInteger(seq)) continue;
    try {
      const summary = service.summary(session.id, seq);
      if (!summary) return undefined;
      return { summary, seq };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Ghép unified diff của mọi file đã đổi trong turn, có trần ký tự.
 *
 * `workspaceChanges.diff(sessionId, seq, index, signal)` trả về diff của MỘT
 * file theo chỉ số trong `summary.files`. Ghép lại thành một diff duy nhất để
 * `jev_review` nhìn thấy toàn cảnh thay vì từng file rời rạc.
 *
 * `eventSeq` là seq của event `workspace/changes` (từ `workspaceSummaryOf`),
 * KHÔNG phải `files[i].seq` — provider tra record theo seq của event và
 * `WorkspaceChangedFile` không có field `seq`.
 *
 * Cắt theo trần vì `jev_review` có giới hạn input riêng và sẽ từ chối request
 * quá lớn. File lỗi/không đọc được thì bỏ qua, không làm hỏng cả review.
 */
async function buildTurnDiff(ctx, session, summary, eventSeq, signal) {
  let service;
  try {
    service = ctx.get('workspaceChanges', false);
  } catch {
    return '';
  }
  if (typeof service?.diff !== 'function') return '';
  if (!Number.isSafeInteger(eventSeq)) return '';
  const chunks = [];
  let budget = 24_000;
  for (let index = 0; index < summary.files.length && budget > 0; index += 1) {
    let fileDiff;
    try {
      fileDiff = await service.diff(session.id, eventSeq, index, signal);
    } catch {
      continue;
    }
    const text = renderFileDiff(fileDiff, summary.files[index]);
    if (!text) continue;
    chunks.push(text.slice(0, budget));
    budget -= text.length;
  }
  return chunks.join('\n');
}

/** Render một `WorkspaceFileDiff` thành hunk unified-diff dạng text. */
function renderFileDiff(fileDiff, file) {
  if (!fileDiff) return '';
  const path = fileDiff.path ?? file?.path ?? 'unknown';
  if (fileDiff.kind !== 'text') return `--- ${path} (binary or non-text change)`;
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of fileDiff.hunks ?? []) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...(hunk.lines ?? []));
  }
  return lines.join('\n');
}

/**
 * Rút điểm số từ kết quả `jev_review`.
 *
 * Tool trả JSON một dòng (`content[0].text`). Chỉ lấy các metric `applicable`
 * và có điểm số — metric `applicable: false` nghĩa là Jev không đủ ngữ cảnh để
 * chấm, nên đưa vào báo cáo sẽ gây hiểu nhầm.
 *
 * Trả `undefined` khi không parse được; lớp gọi vẫn ghi log quyết định.
 */
function parseReviewScores(text) {
  try {
    const parsed = JSON.parse(text);
    const metrics = parsed?.metrics;
    if (!metrics || typeof metrics !== 'object') return undefined;
    const out = {};
    for (const [name, metric] of Object.entries(metrics)) {
      if (metric?.applicable === true && typeof metric.score === 'number') out[name] = metric.score;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Điểm review thành một dòng ngắn để chèn vào message. */
function formatScores(scores) {
  if (!scores) return 'no scored metrics returned';
  return Object.entries(scores).map(([name, score]) => `${name} ${score}/10`).join(', ');
}
