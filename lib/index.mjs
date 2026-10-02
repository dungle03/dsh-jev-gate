/**
 * dsh-jev-gate — đưa Jev vào ba khoảnh khắc đắt giá của DSH.
 *
 * Triết lý (đúng như đã thống nhất):
 *   LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
 *   định sai gây tốn kém: cái này có nguy hiểm không, việc này xong chưa, có
 *   bằng chứng chưa, bước tiếp theo cần nghĩ nhiều không.
 *
 * Ba lớp, mỗi lớp độc lập và tắt được riêng:
 *   1. tools/pre-execute  — chặn tool có khả năng phá dữ liệu (noul `destructive`)
 *   2. agent/turn-stopping — hỏi complete + evidence khi model định dừng (noul)
 *   3. agent/request       — chọn reasoningEffort kèm lease (choice)
 *
 * Nguyên tắc bất di bất dịch: FAIL-OPEN. Jev lỗi, chậm, hay trả rác thì hành
 * động đi tiếp như chưa từng có Jev. Jev không được phép biến sự cố của nó
 * thành sự cố của workflow.
 */

import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createJev, describeError } from './jev-client.mjs';
import { isProvablyReadOnly } from './readonly.mjs';
import { catastrophicMatch } from './catastrophic.mjs';
import {
  clip,
  completionQuestion,
  destructiveQuestion,
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
  approachConfidenceThreshold: 0.3,
  contextFileThreshold: 0.6,
  contextCandidateLimit: 12,
  contextMaxFiles: 3,
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
   * Lớp 3 — mức nâng lên khi turn trước có tín hiệu thất bại đo được.
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
  gateTimeoutMs: 2_000,
  authorizationTimeoutMs: 4_000,
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
  jevGrepExcerptCap: 4_000,
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
   * Gate dựa vào Jev, mà Jev fail-open: 252/6.442 lần (3,9%) gọi thất bại và
   * lệnh đi thẳng. Với guard an toàn thì đó là lỗ hổng — API lỗi nghĩa là
   * `rm -rf /` chạy. Sàn này chạy TRƯỚC, thuần cú pháp, không mạng, nên không
   * có đường fail-open. Danh sách CỐ Ý hẹp: chỉ những gì không thể hoàn tác VÀ
   * không thể biện minh (`rm -rf /tmp/x` vẫn qua bình thường).
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
  enableAuthorizationOverride: true,
  enableCompletionCheck: true,
  enableEffortRouting: true,
  enableSpawnHint: true,
  enableContextTriage: true,
  enableFailureRecovery: true,
  enableQualityReview: true,
  enableJevgrepEscalation: true,
};

export const Config = z.object({
  destructiveThreshold: z.number().default(DEFAULTS.destructiveThreshold),
  completionThreshold: z.number().default(DEFAULTS.completionThreshold),
  evidenceThreshold: z.number().default(DEFAULTS.evidenceThreshold),
  executionThreshold: z.number().default(DEFAULTS.executionThreshold),
  approachConfidenceThreshold: z.number().default(DEFAULTS.approachConfidenceThreshold),
  contextFileThreshold: z.number().default(DEFAULTS.contextFileThreshold),
  contextCandidateLimit: z.number().default(DEFAULTS.contextCandidateLimit),
  contextMaxFiles: z.number().default(DEFAULTS.contextMaxFiles),
  failureMaxPerTurn: z.number().default(DEFAULTS.failureMaxPerTurn),
  completionMaxPerTurn: z.number().default(DEFAULTS.completionMaxPerTurn),
  effortDefault: z.string().default(DEFAULTS.effortDefault),
  effortEscalateTo: z.string().default(DEFAULTS.effortEscalateTo),
  effortEscalateToolErrors: z.number().default(DEFAULTS.effortEscalateToolErrors),
  effortEscalateTestFailures: z.number().default(DEFAULTS.effortEscalateTestFailures),
  reviewMinChangedLines: z.number().default(DEFAULTS.reviewMinChangedLines),
  reviewMaxPerTurn: z.number().default(DEFAULTS.reviewMaxPerTurn),
  reviewMaxDiffChars: z.number().default(DEFAULTS.reviewMaxDiffChars),
  reviewServerName: z.string().default(DEFAULTS.reviewServerName),
  reviewReportToAgent: z.boolean().default(DEFAULTS.reviewReportToAgent),
  gateTimeoutMs: z.number().default(DEFAULTS.gateTimeoutMs),
  authorizationTimeoutMs: z.number().default(DEFAULTS.authorizationTimeoutMs),
  stopTimeoutMs: z.number().default(DEFAULTS.stopTimeoutMs),
  effortTimeoutMs: z.number().default(DEFAULTS.effortTimeoutMs),
  spawnTimeoutMs: z.number().default(DEFAULTS.spawnTimeoutMs),
  contextTimeoutMs: z.number().default(DEFAULTS.contextTimeoutMs),
  failureTimeoutMs: z.number().default(DEFAULTS.failureTimeoutMs),
  jevGrepSearchTaskThreshold: z.number().default(DEFAULTS.jevGrepSearchTaskThreshold),
  jevGrepMaxPerTurn: z.number().default(DEFAULTS.jevGrepMaxPerTurn),
  jevGrepTimeoutMs: z.number().default(DEFAULTS.jevGrepTimeoutMs),
  jevGrepBackground: z.boolean().default(DEFAULTS.jevGrepBackground),
  jevGrepFailureBreaker: z.number().default(DEFAULTS.jevGrepFailureBreaker),
  jevGrepExcerptCap: z.number().default(DEFAULTS.jevGrepExcerptCap),
  enableDestructiveGate: z.boolean().default(DEFAULTS.enableDestructiveGate),
  enableReadOnlyPrefilter: z.boolean().default(DEFAULTS.enableReadOnlyPrefilter),
  enableCatastrophicFloor: z.boolean().default(DEFAULTS.enableCatastrophicFloor),
  enableGateVerdictCache: z.boolean().default(DEFAULTS.enableGateVerdictCache),
  gateVerdictCacheMax: z.number().default(DEFAULTS.gateVerdictCacheMax),
  gateVerdictCacheMargin: z.number().default(DEFAULTS.gateVerdictCacheMargin),
  enableAuthorizationOverride: z.boolean().default(DEFAULTS.enableAuthorizationOverride),
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

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const record = makeRecorder(cfg.logDir ?? DEFAULT_LOG_DIR);
  /**
   * Cảnh báo khoá config đã BỊ BỎ nhưng vẫn còn trong file của người dùng.
   *
   * `schemastery` bỏ qua khoá lạ một cách im lặng, nên người dùng còn đặt
   * `effortReuseConfidence: 0.9` sẽ tưởng nó vẫn có tác dụng — trong khi Lớp 3
   * giờ là luật tất định và không đọc khoá đó nữa. Im lặng ở đây là một cái bẫy
   * đúng loại plugin này sinh ra để tránh, nên nói thẳng ra.
   *
   * Chỉ log một lần lúc nạp, không phải mỗi lần chạy hook.
   */
  const RETIRED_CONFIG = ['effortReuseConfidence', 'effortMaxReuseSteps'];
  const retired = RETIRED_CONFIG.filter((key) => Object.hasOwn(config, key));
  if (retired.length) {
    const message = `[jev-gate] config bỏ qua ${retired.join(', ')}: Lớp 3 giờ dùng luật `
      + `tất định (effortDefault/effortEscalateTo/effortEscalateToolErrors/effortEscalateTestFailures). `
      + `Xoá khoá cũ khỏi cordis.patch.yml để tránh tưởng nhầm nó còn tác dụng.`;
    record({ type: 'retired_config', keys: retired });
    ctx.logger?.warn?.(message);
  }
  const jev = createJev({
    getApiKey: async () => (await ctx.credentials.resolve('TYPESAFE_API_KEY'))?.value,
    timeoutMs: cfg.gateTimeoutMs,
    record,
  });
  ctx.effect(() => jev.dispose);

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
    const candidates = cfg.enableContextTriage
      ? await listCandidateFiles(workspaceRootOf(agent, sessionOf(agent)), cfg.contextCandidateLimit, task)
      : [];

    let verdict;
    try {
      verdict = await jev.evaluate(
        preStepQuestion({
          task,
          candidates,
          includeApproach: cfg.enableSpawnHint,
        }),
        { signal, timeoutOverrideMs: cfg.contextTimeoutMs, agent },
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
      const approach = verdict.answers.approach?.choice;
      const confidence = verdict.answers.approach?.confidence;
      if (typeof approach !== 'string' || typeof confidence !== 'number') {
        logged.approach = 'fail_open';
      } else if (confidence < cfg.approachConfidenceThreshold) {
        // Ngưỡng chỉ để chặn case Jev trả conf rất thấp. Đo trên 10 case đã biết
        // đáp án: conf KHÔNG tương quan với đúng/sai — case đúng có conf từ 0.24,
        // case sai có conf 0.44. Nên ngưỡng 0.3 (không phải 0.5, vốn chặn oan
        // case scan ổ đĩa đúng với conf 0.42–0.48). Lưới an toàn, không phải bộ lọc.
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
        injected.push(
          `Jev suggests how to approach this task (${approach}, confidence `
          + `${confidence.toFixed(2)}): ${APPROACH_ADVICE[approach]} `
          + 'If that does not fit what you are actually seeing, ignore it and proceed as you judge best.',
        );
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
        injected.push(
          'Jev judged these files are worth reading before you start '
          + `(confidence ${keep.map((entry) => `${entry.path} ${entry.p.toFixed(2)}`).join(', ')}): `
          + `${keep.map((entry) => entry.path).join(', ')}. `
          + 'Read them first if that matches what you find; the list is a hint, not a restriction.',
        );
      }
    }

    hintedTurns.add(hintedKey);
    if (!injected.length) {
      record(logged, agent);
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
          content: [{ type: 'text', text: injected.join('\n\n') }],
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
       * gọi Jev, không đọc/ghi gì. Vì Jev fail-open 3,9% số lần (đo trên log
       * thật), nếu chỉ dựa vào Jev thì một lần timeout đúng lúc là `rm -rf /`
       * chạy thẳng. Sàn này bịt đúng khoảng đó.
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
            { signal: exec.signal, timeoutOverrideMs: cfg.gateTimeoutMs, agent: exec.agent },
          );
        } catch (error) {
          const message = describeError(error);
          record({ type: 'destructive_gate', tool: exec.name, decision: 'fail_open', error: message }, exec.agent);
          return next();
        }

        p = verdict.answers.destructive?.noul;
        if (typeof p !== 'number') {
          record({ type: 'destructive_gate', tool: exec.name, decision: 'fail_open', error: 'no noul answer' }, exec.agent);
          return next();
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
       * FAIL-CLOSED ở lớp này (ngược lớp 1): không chứng minh được → CHẶN. Không
       * có nhánh nào cho qua chỉ vì lỗi/thiếu dữ liệu. Tắt bằng
       * `enableAuthorizationOverride: false` cũng quay về hành vi chặn cũ.
       */
      let authorized = false;
      /** '' = chưa kiểm (tắt lớp), 'checked' = đã có phán quyết (deny). */
      let authorizationState = '';
      if (cfg.enableAuthorizationOverride) {
        // `collectUserRequest` CHỈ lấy tin nhắn thật của user (source.kind ===
        // 'user'), nên nội dung dán/output tool không tự cấp quyền xoá được.
        const userRequest = await collectUserRequest(exec.agent?.session, command);
        authorized = commandTargetsInUserRequest(userRequest, command);
        authorizationState = 'checked';
        if (authorized) {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'allow_authorized',
            p,
            command: clip(command, 400).text,
            ...(cacheHit ? { cached: true } : {}),
          }, exec.agent);
        } else {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'deny',
            p,
            authorization: 'not_proven',
            command: clip(command, 400).text,
            ...(cacheHit ? { cached: true } : {}),
          }, exec.agent);
        }
      }

      if (authorized) return next();

      if (!cfg.enableAuthorizationOverride) {
        record({
          type: 'destructive_gate',
          tool: exec.name,
          decision: 'deny',
          p,
          command: clip(command, 400).text,
          ...(cacheHit ? { cached: true } : {}),
        }, exec.agent);
      }
      const tail = authorizationState === 'checked'
        ? ' and the user\'s own request does not name its target.'
        : '.';
      return {
        kind: 'deny',
        reason:
          `Jev flagged this ${exec.name} call as destructive (p=${p.toFixed(2)}, `
          + `threshold ${cfg.destructiveThreshold})${tail}`
          + ' The body was not executed. If the action is genuinely intended, ask the '
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

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (!result?.isError) return decision;
      if (result.error?.info?.code === 'JEV_DESTRUCTIVE') return decision;
      noteSession(exec.agent);

      const turn = currentTurnOf(exec.agent);
      const failureKey = agentTurnKey(exec.agent, turn);
      const seen = failuresSeen.get(failureKey) ?? 0;
      if (seen >= cfg.failureMaxPerTurn) return decision;
      failuresSeen.set(failureKey, seen + 1);
      evictOldest(failuresSeen);

      const errorText = textOf(result.content).trim();
      if (!errorText) return decision;

      let verdict;
      try {
        verdict = await jev.evaluate(
          failureQuestion({
            goal: clip(taskOf(exec.agent, 'Unknown task') ?? 'Unknown task', 1_000).text,
            toolName: exec.name,
            command: rawCommandOf(exec.name, exec.arguments) ?? JSON.stringify(exec.arguments ?? {}).slice(0, 400),
            errorText: clip(errorText, 1_200).text,
          }),
          { signal: exec.signal, timeoutOverrideMs: cfg.failureTimeoutMs, agent: exec.agent },
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

      const recovery = verdict.answers.recovery?.choice;
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

      record({
        type: 'failure_recovery',
        turn,
        tool: exec.name,
        decision: 'hinted',
        recovery,
        confidence: verdict.answers.recovery?.confidence,
        error: clip(errorText, 300).text,
      }, exec.agent);
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          {
            id: randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: `The ${exec.name} call failed. Jev's read on the next move (${recovery}, confidence `
                + `${verdict.answers.recovery.confidence.toFixed(2)}): ${advice} `
                + 'Follow it only if it matches the error you can see; otherwise use your own judgement.',
            }],
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
     * Breaker đếm số lần hỏng LIÊN TIẾP (timeout/exit lỗi). Đủ ngưỡng thì tạm
     * tắt leo thang cho phần còn lại của phiên — thà im lặng còn hơn treo turn
     * lặp đi lặp lại. Lần thành công đầu tiên reset về 0.
     */
    let consecutiveFailures = 0;
    const breakerOpen = () => consecutiveFailures >= cfg.jevGrepFailureBreaker;

    /** Ngân sách còn VÀ breaker chưa mở. */
    const canEscalate = (key) => budgetLeft(key) && !breakerOpen();

    /**
     * Kết quả `jg` chạy NỀN, chờ được chèn ở lần `pre-step` kế tiếp.
     *
     * Key theo session để không lẫn giữa các agent. Mỗi entry là
     * `{ done, value }` — cờ `done` được set ĐỒNG BỘ trong `.then`, nên
     * `takeReadyHint` đọc được ngay ở lần gọi sau mà không cần chờ.
     */
    const pendingHints = new Map();
    const pendingKeyOf = (agent) => sessionKeyOf(agent) ?? 'unknown';

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
    const skipReasonFor = async (key, question) => {
      if (!canEscalate(key)) return breakerOpen() ? 'skip_breaker' : 'skip_budget';
      if (!question) return 'skip_no_task';
      if (!(await isJevgrepAvailable())) return 'skip_unavailable';
      return undefined;
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
      const skip = await skipReasonFor(key, question);
      if (skip) {
        log({ decision: skip });
        return undefined;
      }

      const result = await runJevgrep({
        question,
        root,
        timeoutMs: cfg.jevGrepTimeoutMs,
        signal,
      });
      if (!result.ok) {
        consecutiveFailures += 1;
        log({ decision: 'fail_open', error: result.error, consecutiveFailures });
        return undefined;
      }
      consecutiveFailures = 0; // thành công → đóng breaker lại

      const built = buildHint(result.text);
      if (!built) {
        log({ decision: 'skip_empty' });
        return undefined;
      }

      escalated.set(key, (escalated.get(key) ?? 0) + 1);
      evictOldest(escalated);
      log({ decision: 'hinted', files: built.fileList, background: false });
      return built.text;
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
     * Kết quả có thể "cũ" một nhịp (turn sau nhận gợi ý của turn trước). Chấp
     * nhận: `jg` tìm theo repo, không theo turn, và gợi ý vẫn là "đọc file X" —
     * hữu ích ở turn sau y như ở turn phát sinh.
     */
    const escalateInBackground = ({ agent, key, turn, root, reason, fallbackTask }) => {
      const started = Date.now();
      const log = makeLog(turn, reason, started, agent);
      const pendingKey = pendingKeyOf(agent);
      if (pendingHints.has(pendingKey)) return; // đang có một lần chạy dở

      const task = clip(taskOf(agent, fallbackTask ?? '') ?? '', 1_500).text;
      const question = buildJevgrepQuestion(task);
      if (!question) { log({ decision: 'skip_no_task' }); return; }
      if (!canEscalate(key)) {
        log({ decision: breakerOpen() ? 'skip_breaker' : 'skip_budget' });
        return;
      }

      /** Không truyền `signal` của hook: nó abort khi turn kết thúc, mà ta muốn
       *  tiến trình chạy tiếp qua turn. Ngân sách riêng do `jevGrepTimeoutMs` lo. */
      const promise = (async () => {
        if (!(await isJevgrepAvailable())) {
          log({ decision: 'skip_unavailable', background: true });
          return undefined;
        }
        const result = await runJevgrep({
          question, root, timeoutMs: cfg.jevGrepTimeoutMs, signal: undefined,
        });
        if (!result.ok) {
          consecutiveFailures += 1;
          log({ decision: 'fail_open', error: result.error, consecutiveFailures, background: true });
          return undefined;
        }
        consecutiveFailures = 0;
        const built = buildHint(result.text);
        if (!built) {
          log({ decision: 'skip_empty', background: true });
          return undefined;
        }
        escalated.set(key, (escalated.get(key) ?? 0) + 1);
        evictOldest(escalated);
        log({ decision: 'hinted', files: built.fileList, background: true });
        return built.text;
      })().catch(() => undefined);

      pendingHints.set(pendingKey, { done: false, value: undefined });
      promise.then((value) => {
        const entry = pendingHints.get(pendingKey);
        if (entry !== undefined) { entry.done = true; entry.value = value; }
      });
      log({ decision: 'started_background' });
    };

    /**
     * Lấy gợi ý nền đã xong (nếu có). KHÔNG chờ: chưa xong thì trả `undefined`
     * và lần `pre-step` sau thử lại.
     */
    const takeReadyHint = (agent) => {
      const pendingKey = pendingKeyOf(agent);
      const entry = pendingHints.get(pendingKey);
      if (entry === undefined || !entry.done) return undefined;
      pendingHints.delete(pendingKey);
      return entry.value;
    };

    // A. Task đọc ra là "tìm X ở đâu" → leo thang ngay ở step 1.
    ctx.on('agent/pre-step', async ({ turn, step, signal, agent }, next) => {
      const decision = await next();
      if (decision?.kind !== 'enter') return decision;

      /** Gợi ý nền đã sẵn sàng thì chèn — bất kể step nào. */
      const injectHint = (hint) => ({
        ...decision,
        messages: [
          ...(decision.messages ?? []),
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: hint }],
            source: { kind: SOURCE_KIND },
          },
        ],
      });

      const ready = takeReadyHint(agent);
      if (ready) return injectHint(ready);
      // Còn một lần chạy nền đang dở → không khởi động thêm.
      if (pendingHints.has(pendingKeyOf(agent))) return decision;

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
      // Chỉ fire đúng tại mốc ngưỡng; các lệnh dò tìm sau đó không fire lại.
      if (run > cfg.jevGrepSearchTaskThreshold) return decision;

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
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: hint }],
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
      checked.set(key, seen + 1);
      evictOldest(checked);

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

      const evidence = await collectEvidence(agent?.session);
      let verdict;
      try {
        /**
         * KHÔNG truyền `signal` của hook này xuống Jev.
         *
         * `agent/turn-stopping` chạy ĐÚNG LÚC turn đang dừng, nên `signal` của nó
         * đã abort (hoặc abort ngay sau đó). Truyền nó vào `AbortSignal.any` làm
         * fetch bị huỷ tức thì.
         *
         * Đo trên log thật: **48/49** lần `completion_check` fail đều là
         * `This operation was aborted` (cửa sổ 28/09 07:43→08:55). Lớp này vẫn
         * phải có ngân sách riêng — `stopTimeoutMs` — thay vì mượn signal đã chết.
         */
        verdict = await jev.evaluate(
          completionQuestion({
            goal: clip(goal, 1_500).text,
            recentEvidence: evidence.text,
            testSignal: evidence.testSignal,
          }),
          { timeoutOverrideMs: cfg.stopTimeoutMs, agent },
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
      const reason = missing
        ? `Jev assesses the original goal is not fully carried out (p=${complete.toFixed(2)}).`
        : `Jev assesses this goal needed execution but the claim is not backed by executed output `
          + `(p=${proven.toFixed(2)}).`;
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: `${reason} Before stopping, either finish the remaining work or run a command whose `
            + 'real output proves the result, then report that output. If the goal is genuinely '
            + 'complete and cannot be further verified in this environment, say so explicitly and stop.',
        }],
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

    ctx.on('agent/request', async ({ step, turn, agent }, next) => {
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

      /**
       * STICKY THEO TURN — chỉ tính lại khi sang turn mới.
       *
       * Vì sao bỏ hẳn classifier per-request: đo trên 120 request liên tiếp, cơ
       * chế cũ đổi mức **113/120 lần** (`low,high,low,high,…`) và 54,5% quyết
       * định có confidence < 0,5. Mỗi lần như vậy tốn một call Jev ~281ms nằm
       * TRÊN đường tới hạn của request chính. Đó là "vẽ việc": tốn tiền và độ
       * trễ để đổi một quyết định gần như ngẫu nhiên.
       */
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

      /**
       * Tính lại từ TÍN HIỆU ĐO ĐƯỢC của turn trước, không hỏi model.
       *
       * Research (arXiv 2505.00127, 2608.13571): tín hiệu đo được (retry, tool
       * error, test fail, diff size) thắng tín hiệu "đoán độ khó". Model hệ suy
       * luận trên việc dễ gần như không tăng accuracy khi nâng effort
       * (arXiv 2507.04023). Nên mặc định THẤP, chỉ nâng khi có bằng chứng cụ thể
       * rằng bước trước đã thất bại.
       */
      const signals = await turnSignals(sessionOf(agent), turn - 1);
      const escalate = signals.toolErrors >= cfg.effortEscalateToolErrors
        || signals.testFailures >= cfg.effortEscalateTestFailures;
      let effort = escalate ? cfg.effortEscalateTo : cfg.effortDefault;
      if (!supported.includes(effort)) {
        // Route không nhận mức mong muốn → lùi về mức hợp lệ gần nhất.
        effort = supported.includes(cfg.effortDefault) ? cfg.effortDefault : supported[0];
      }
      const reason = escalate
        ? (signals.testFailures >= cfg.effortEscalateTestFailures
          ? `test_failure:${signals.testFailures}`
          : `tool_errors:${signals.toolErrors}`)
        : 'clean_turn';
      lastEffort.set(key, { effort, turn, reason, reuses: 0 });
      record({
        type: 'effort_route',
        step,
        turn,
        route,
        decision: 'applied',
        effort,
        reason,
        signals,
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
      reviewed.set(key, seen + 1);
      evictOldest(reviewed);

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

      const diff = await buildTurnDiff(ctx, session, summary, eventSeq, signal);
      if (!diff.trim()) {
        record({ type: 'quality_review', turn, decision: 'skip_empty_diff' }, agent);
        return;
      }

      let result;
      try {
        result = await ctx.tools.execute({
          callId: `jev-gate-review-${randomUUID()}`,
          name: toolName,
          arguments: {
            task: clip(taskOf(agent, 'Complete the requested change.') ?? 'Complete the requested change.', 4_000).text,
            diff: clip(diff, cfg.reviewMaxDiffChars).text,
            repositoryContext: `Session cwd: ${summary.cwd}. `
              + `${summary.total} file(s) changed, ${summary.added} line(s) added, ${summary.deleted} line(s) deleted.`,
          },
          agent,
          signal,
        });
      } catch (error) {
        record({
          type: 'quality_review',
          turn,
          decision: 'fail_open',
          error: describeError(error),
        }, agent);
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
      if (cfg.reviewReportToAgent) agent?.steer?.({
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: `Jev Review scored this turn's changes (${summary.total} file(s), ${changedLines} line(s)): `
            + `${formatScores(scores)}. `
            + 'This is a quality signal for the work just done, not an instruction: use it to decide '
            + 'whether another justified improvement is warranted before you stop.',
        }],
        source: { kind: SOURCE_KIND },
      });
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
 * Ba tin, mỗi tin cắt 600 ký tự: đủ ngữ cảnh mà không nhồi cả hội thoại (tài
 * liệu TypeSafe: state thừa làm giảm độ chính xác).
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

/** Chuẩn hoá để so khớp: chữ thường, gộp mọi khoảng trắng (kể cả xuống dòng). */
const normalizeText = (text) => (typeof text === 'string' ? text : '').toLowerCase().replace(/\s+/gu, ' ').trim();

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
 * Provenance TẤT ĐỊNH: target của lệnh có xuất hiện trong yêu cầu THẬT của user
 * không? Thay cho call LLM `authorizationQuestion` (xem comment ở Lớp 1).
 *
 * Bất biến an toàn: chỉ trả `true` khi CHỨNG MINH được. Không có yêu cầu, không
 * trích được target, hoặc target không xuất hiện → `false` (caller CHẶN). Nếu
 * lệnh có nhiều target, TẤT CẢ phải xuất hiện — user chỉ nêu một phần thì lệnh
 * xoá nhiều hơn điều họ nói, đúng trường hợp phải chặn.
 *
 * So khớp: chuỗi con trên văn bản đã chuẩn hoá (chữ thường, gộp khoảng trắng),
 * có kiểm biên để `/tmp/gtest` KHÔNG khớp oan `/tmp/gtest-other`.
 */
export function commandTargetsInUserRequest(userRequestText, command) {
  const request = normalizeText(userRequestText);
  if (!request) return false;
  const targets = extractCommandTargets(command);
  if (!targets.length) return false;
  return targets.every((target) => requestNamesTarget(request, target));
}

/** Một target xuất hiện trong văn bản đã chuẩn hoá, có kiểm biên hai đầu. */
function requestNamesTarget(normalizedRequest, target) {
  const needle = normalizeText(target).replace(/\/+$/u, '');
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Biên: không để target khớp khi nó chỉ là TIỀN TỐ của một tên dài hơn.
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_.\\-\\/])${escaped}(?:$|[^\\p{L}\\p{N}_.\\-\\/])`, 'u');
  return pattern.test(normalizedRequest);
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
