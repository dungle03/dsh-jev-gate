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
import { createJev } from './jev-client.mjs';
import {
  clip,
  authorizationQuestion,
  completionQuestion,
  destructiveQuestion,
  effortQuestion,
  preStepQuestion,
  failureQuestion,
  EFFORT_MEANING,
} from './policy.mjs';

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
   * Ngưỡng confidence để tái dùng quyết định effort cho step kế (Lớp 3).
   * Đo trên 1.225 cặp step: conf 0.6 → step sau giữ nguyên 88%, chỉ đoán sai
   * 8% (bỏ sót TĂNG 4,3%). Đặt 1.0 để tắt hẳn việc tái dùng.
   */
  effortReuseConfidence: 0.6,
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
  logDir: undefined,
  enableDestructiveGate: true,
  enableAuthorizationOverride: true,
  enableCompletionCheck: true,
  enableEffortRouting: true,
  enableSpawnHint: true,
  enableContextTriage: true,
  enableFailureRecovery: true,
  enableQualityReview: true,
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
  effortReuseConfidence: z.number().default(DEFAULTS.effortReuseConfidence),
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
  enableDestructiveGate: z.boolean().default(DEFAULTS.enableDestructiveGate),
  enableAuthorizationOverride: z.boolean().default(DEFAULTS.enableAuthorizationOverride),
  enableCompletionCheck: z.boolean().default(DEFAULTS.enableCompletionCheck),
  enableEffortRouting: z.boolean().default(DEFAULTS.enableEffortRouting),
  enableSpawnHint: z.boolean().default(DEFAULTS.enableSpawnHint),
  enableContextTriage: z.boolean().default(DEFAULTS.enableContextTriage),
  enableFailureRecovery: z.boolean().default(DEFAULTS.enableFailureRecovery),
  enableQualityReview: z.boolean().default(DEFAULTS.enableQualityReview),
  // Không default: thiếu khoá thì `apply` tự dùng DEFAULT_LOG_DIR. Có mặt để
  // test trỏ log vào thư mục tạm, không làm bẩn log thật. Schemastery coi khoá
  // không `.required()` là optional, nên không khai default ở đây.
  logDir: z.string(),
});

/** Ghi log quyết định; lỗi ghi log không bao giờ được làm hỏng quyết định. */
function makeRecorder(logDir) {
  const logFile = join(logDir, 'decisions.jsonl');
  let ready;
  return (entry) => {
    ready ??= mkdir(logDir, { recursive: true }).catch(() => {});
    ready
      .then(() => appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 }))
      .catch(() => {});
  };
}

const rawCommandOf = (toolName, args) => {
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined;
  const command = args?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const record = makeRecorder(cfg.logDir ?? DEFAULT_LOG_DIR);
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
    notePrompt(messages);
    if (agent) noteSession(agent);
    if (!cfg.enableSpawnHint && !cfg.enableContextTriage) return next();
    if (step !== 1) return next();

    const decision = await next();
    // Chỉ chèn khi step này thật sự vào (không bị chặn) và có message để đọc.
    if (decision?.kind !== 'enter') return decision;
    if (hintedTurns.has(turn)) return decision;
    if (hintedTurns.size > 200) hintedTurns.clear();

    const task = clip(lastSeenPrompt ?? '', 1_500).text;
    if (!task.trim()) return decision;

    /**
     * Ứng viên file chỉ liệt kê khi Lớp 5 bật. Danh sách rỗng vẫn hợp lệ: khi
     * đó request chỉ còn câu `approach`, đúng như hành vi cũ.
     */
    const candidates = cfg.enableContextTriage
      ? await listCandidateFiles(workspaceRootOf(agent, lastSeenSession), cfg.contextCandidateLimit, task)
      : [];

    let verdict;
    try {
      verdict = await jev.evaluate(
        preStepQuestion({
          task,
          candidates,
          includeApproach: cfg.enableSpawnHint,
        }),
        { signal, timeoutOverrideMs: cfg.contextTimeoutMs },
      );
    } catch (error) {
      record({
        type: 'pre_step',
        turn,
        decision: 'fail_open',
        error: error instanceof Error ? error.message : 'unknown',
      });
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

    hintedTurns.add(turn);
    if (!injected.length) {
      record(logged);
      return decision;
    }

    record({ ...logged, decision: 'hinted' });
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
    ctx.on('tools/pre-execute', async (exec, next) => {
      noteSession(exec.agent);
      const command = rawCommandOf(exec.name, exec.arguments);
      if (command === undefined) return next();

      const cwd = exec.agent?.cwd
        ?? exec.agent?.session?.cwd
        ?? process.cwd();
      let verdict;
      try {
        verdict = await jev.evaluate(
          destructiveQuestion({
            toolName: exec.name,
            command,
            cwd,
            declaredWorkdir: exec.arguments?.workdir,
          }),
          { signal: exec.signal, timeoutOverrideMs: cfg.gateTimeoutMs },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        record({ type: 'destructive_gate', tool: exec.name, decision: 'fail_open', error: message });
        return next();
      }

      const p = verdict.answers.destructive?.noul;
      if (typeof p !== 'number') {
        record({ type: 'destructive_gate', tool: exec.name, decision: 'fail_open', error: 'no noul answer' });
        return next();
      }
      if (p < cfg.destructiveThreshold) {
        record({ type: 'destructive_gate', tool: exec.name, decision: 'allow', p });
        return next();
      }

      /**
       * Lệnh đã bị coi là phá dữ liệu. Trước khi chặn, hỏi thêm một câu: user có
       * THẬT SỰ yêu cầu xoá đúng thứ này không?
       *
       * Chỉ chặn khi hội đủ hai điều: phá dữ liệu VÀ không được user yêu cầu.
       * Đây là chỗ sửa đúng phàn nàn "chặn cứng": user bảo xoá thì phải cho xoá.
       *
       * FAIL-CLOSED ở lớp này (ngược lớp 1): hỏi lỗi/timeout → giữ nguyên hành vi
       * cũ là CHẶN. Đây là lớp phòng thủ; lỗi của Jev không được biến thành
       * "cho qua". Tắt bằng `enableAuthorizationOverride: false` cũng quay về
       * hành vi chặn cũ.
       */
      let authorized = false;
      /** '' = chưa hỏi (tắt lớp), 'checked' = đã có phán quyết, 'error' = hỏi lỗi. */
      let authorizationState = cfg.enableAuthorizationOverride ? 'error' : '';
      if (cfg.enableAuthorizationOverride) {
        try {
          const userRequest = await collectUserRequest(exec.agent?.session);
          const verdict2 = await jev.evaluate(
            authorizationQuestion({ userRequest, command, cwd }),
            { signal: exec.signal, timeoutOverrideMs: cfg.authorizationTimeoutMs },
          );
          const choice = verdict2.answers.authorized?.choice;
          if (typeof choice !== 'string') {
            record({ type: 'destructive_gate', tool: exec.name, decision: 'auth_fail_closed', p, error: 'no choice answer' });
          } else if (choice === 'authorized') {
            authorized = true;
            record({
              type: 'destructive_gate',
              tool: exec.name,
              decision: 'allow_authorized',
              p,
              confidence: verdict2.answers.authorized?.confidence,
              command: clip(command, 400).text,
            });
          } else {
            authorizationState = 'checked';
            record({
              type: 'destructive_gate',
              tool: exec.name,
              decision: 'deny',
              p,
              authorization: choice,
              confidence: verdict2.answers.authorized?.confidence,
              command: clip(command, 400).text,
            });
          }
        } catch (error) {
          record({
            type: 'destructive_gate',
            tool: exec.name,
            decision: 'auth_fail_closed',
            p,
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      if (authorized) return next();

      if (!cfg.enableAuthorizationOverride) {
        record({ type: 'destructive_gate', tool: exec.name, decision: 'deny', p, command: clip(command, 400).text });
      }
      const tail = authorizationState === 'checked'
        ? ' and the user\'s own request does not appear to authorize it.'
        : authorizationState === 'error'
          ? ' and the authorization check could not be completed.'
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
      const seen = failuresSeen.get(turn) ?? 0;
      if (seen >= cfg.failureMaxPerTurn) return decision;
      failuresSeen.set(turn, seen + 1);
      if (failuresSeen.size > 200) failuresSeen.clear();

      const errorText = textOf(result.content).trim();
      if (!errorText) return decision;

      let verdict;
      try {
        verdict = await jev.evaluate(
          failureQuestion({
            goal: clip(lastSeenGoal ?? lastSeenPrompt ?? 'Unknown task', 1_000).text,
            toolName: exec.name,
            command: rawCommandOf(exec.name, exec.arguments) ?? JSON.stringify(exec.arguments ?? {}).slice(0, 400),
            errorText: clip(errorText, 1_200).text,
          }),
          { signal: exec.signal, timeoutOverrideMs: cfg.failureTimeoutMs },
        );
      } catch (error) {
        record({
          type: 'failure_recovery',
          turn,
          tool: exec.name,
          decision: 'fail_open',
          error: error instanceof Error ? error.message : 'unknown',
        });
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
        });
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
      });
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

  /* ──────────────────── Lớp 2: kiểm hoàn thành khi sắp dừng ──────────────────── */
  if (cfg.enableCompletionCheck) {
    const checked = new Set();
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      noteSession(agent);
      const key = `${agent?.id ?? 'agent'}:${turn}`;
      if (checked.has(key)) return;
      checked.add(key);
      if (checked.size > 200) checked.clear();

      const goal = agent?.goal?.objective ?? agent?.goalObjective;
      if (typeof goal !== 'string' || !goal.trim()) return;

      const evidence = await collectEvidence(agent?.session);
      let verdict;
      try {
        verdict = await jev.evaluate(
          completionQuestion({
            goal: clip(goal, 1_500).text,
            recentEvidence: evidence.text,
            testSignal: evidence.testSignal,
          }),
          { signal, timeoutOverrideMs: cfg.stopTimeoutMs },
        );
      } catch (error) {
        record({
          type: 'completion_check',
          turn,
          decision: 'fail_open',
          error: error instanceof Error ? error.message : 'unknown',
        });
        return;
      }

      const complete = verdict.answers.complete?.noul;
      const proven = verdict.answers.evidence?.noul;
      const needsExecution = verdict.answers.needs_execution?.noul;
      if (typeof complete !== 'number' || typeof proven !== 'number' || typeof needsExecution !== 'number') {
        record({ type: 'completion_check', turn, decision: 'fail_open', error: 'missing answers' });
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
        });
        return;
      }
      record({ type: 'completion_check', turn, decision: 'continue', complete, proven, needsExecution });
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

  /* ──────────────────── Lớp 3: chọn effort theo bước ──────────────────── */
  /**
   * TÁI DÙNG THEO CONFIDENCE (2026-09-28) — thay cho cơ chế lease cũ.
   *
   * Vấn đề đo được trên 9.263 dòng log thật: Lớp 3 chiếm **65% toàn bộ chi phí
   * Jev** (3.238.650 / 4.958.494 input token, 1.831 lần gọi, 1.768 token/lần).
   *
   * Cơ chế lease cũ (`leaseSteps` do Jev trả) gần như chết: Jev trả `1` ở
   * **1.777/1.830 lần (97%)**, kể cả khi confidence 0.9. Đo `confidence →
   * leaseSteps`: ở mọi mức confidence, lease trung bình 1.00–1.08. Nghĩa là
   * lease=1 là hành vi NHẤT QUÁN của Jev, không phải lỗi — hỏi lại nó cũng
   * không cho lease dài hơn.
   *
   * Nhưng không thể bỏ hẳn việc hỏi lại: trong-turn, effort **đổi ở 70% số
   * turn**, và chỉ 24% số step là điểm đổi (437/1.815). Việc gọi lại là chính
   * đáng — chỉ là không cần gọi ở MỌI step.
   *
   * Cái quyết định được là **confidence của chính Jev**. Đo trên 1.225 cặp step
   * liên tiếp: confidence của step trước tương quan mạnh với việc step sau giữ
   * nguyên effort —
   *
   *   | conf | step sau giữ nguyên |
   *   |------|--------------------|
   *   | 0.1  | 46%                |
   *   | 0.4  | 78%                |
   *   | 0.6  | 88%                |
   *   | 0.7  | 93%                |
   *   | 0.9  | 95%                |
   *
   * Nên: confidence ≥ `effortReuseConfidence` (0.6) → giữ nguyên mức vừa chọn
   * cho step kế, KHÔNG hỏi Jev. Ngưỡng 0.6 bỏ được 32% lần gọi và chỉ đoán sai
   * 8% (bỏ sót TĂNG 4,3% — nhánh tốn kém nhất).
   *
   * Vì sao KHÔNG nâng 1 bậc khi tái dùng để bù rủi ro: đo được nâng 1 bậc làm
   * 95,7% trường hợp **cao hơn mức cần** — đốt reasoning token trên mọi step
   * để phòng 4,3% trường hợp. Đắt hơn nhiều so với tiết kiệm.
   *
   * Vì sao tái dùng bị chặn theo TURN: effort được chọn cho "thế hệ kế tiếp"
   * trong một bối cảnh cụ thể. Sang turn mới, goal và lịch sử tool khác hẳn,
   * nên quyết định cũ không còn là bằng chứng. `reusedTurn` ghi turn đã tái
   * dùng; sang turn khác thì hỏi lại.
   *
   * Vì sao vẫn hỏi lại khi có tool result MỚI: một tool result mới là thông tin
   * mới về việc đang làm, có thể đổi độ khó. Chỉ tái dùng khi KHÔNG có gì mới
   * kể từ lần chấm trước — nếu không, "tái dùng" thành mù với thực tế.
   */
  if (cfg.enableEffortRouting) {
    /** Quyết định gần nhất theo route: effort, confidence, turn, và số tool call lúc chấm. */
    const lastDecision = new Map();

    ctx.on('agent/request', async ({ step, turn, agent }, next) => {
      // Engine fuse `agent` vào MỌI payload agent-scoped (`dsh-agent/lib/index.js:242`),
      // kể cả `agent/request` — note cũ trong ~/.dsh/notes/jev-gate.md ghi ngược lại
      // và đã lỗi thời. Ghi lại session ở đây là bắt buộc: guard "có tool call mới"
      // bên dưới đọc lịch sử tool từ session, nên session cũ sẽ làm guard luôn thấy
      // mảng rỗng và tái dùng cả khi đã có thông tin mới.
      if (agent) noteSession(agent);
      const downstream = await next();
      const route = `${downstream?.provider ?? ''}/${downstream?.model ?? ''}`;
      if (!downstream?.provider || !downstream?.model) return downstream;

      const supported = await supportedEffortsOf(ctx, downstream.provider, downstream.model);
      if (!supported.length) {
        record({ type: 'effort_route', step, decision: 'skip_no_levels', route, diagnostic: lastLookupDiagnostic });
        return downstream;
      }

      const history = await recentToolCalls(lastSeenSession);
      const prev = lastDecision.get(route);

      /**
       * Điều kiện tái dùng. Tất cả phải đúng:
       *   - có quyết định trước, cùng turn
       *   - confidence đủ cao
       *   - KHÔNG có tool call mới kể từ lần chấm trước (không có thông tin mới)
       *   - mức cũ vẫn nằm trong danh sách model nhận (route có thể đã đổi)
       */
      const hasNewToolCall = !prev || history.length !== prev.toolCallCount;
      if (
        prev
        && prev.turn === turn
        && prev.confidence >= cfg.effortReuseConfidence
        && !hasNewToolCall
        && supported.includes(prev.effort)
      ) {
        record({
          type: 'effort_route',
          step,
          turn,
          route,
          decision: 'reuse_high_confidence',
          effort: prev.effort,
          confidence: prev.confidence,
          reusedFor: prev.reuses + 1,
        });
        prev.reuses += 1;
        return { ...downstream, reasoningEffort: prev.effort };
      }

      let verdict;
      try {
        const progress = await collectProgress(lastSeenSession, step);
        verdict = await jev.evaluate(
          effortQuestion({
            // Goal (do user đặt) ưu tiên; nếu chưa có thì dùng prompt thô của turn.
            task: clip(lastSeenGoal ?? lastSeenPrompt ?? 'Unknown task', 1_500).text,
            progress,
            recentToolCalls: history,
            supportedEfforts: supported,
            effortMeaning: EFFORT_MEANING,
          }),
          { timeoutOverrideMs: cfg.effortTimeoutMs },
        );
      } catch (error) {
        record({
          type: 'effort_route',
          step,
          turn,
          route,
          decision: 'fail_open',
          error: error instanceof Error ? error.message : 'unknown',
        });
        return downstream;
      }

      const effort = verdict.answers.effort?.choice;
      const confidence = verdict.answers.effort?.confidence;
      if (typeof effort !== 'string' || !supported.includes(effort) || typeof confidence !== 'number') {
        record({ type: 'effort_route', step, turn, route, decision: 'fail_open', error: 'invalid decision', effort, confidence });
        return downstream;
      }
      lastDecision.set(route, {
        effort,
        confidence,
        turn,
        toolCallCount: history.length,
        reuses: 0,
      });
      record({
        type: 'effort_route',
        step,
        turn,
        route,
        decision: 'applied',
        effort,
        confidence,
        probabilities: verdict.answers.effort?.probabilities,
        reused: false,
      });
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
      if (reviewed.size > 200) reviewed.clear();

      // Chốt 2: chỉ turn chính. `delegationDepth > 0` là subagent.
      const session = agent?.session;
      if (session?.delegationDepth > 0) {
        record({ type: 'quality_review', turn, decision: 'skip_subagent' });
        return;
      }

      const summary = workspaceSummaryOf(ctx, session);
      if (!summary || !summary.files?.length) {
        record({ type: 'quality_review', turn, decision: 'skip_no_changes' });
        return;
      }
      // Chốt 3: diff phải đủ lớn để đáng review.
      const changedLines = (summary.added ?? 0) + (summary.deleted ?? 0);
      if (changedLines < cfg.reviewMinChangedLines) {
        record({
          type: 'quality_review',
          turn,
          decision: 'skip_too_small',
          changedLines,
          threshold: cfg.reviewMinChangedLines,
        });
        return;
      }

      const toolName = `mcp__${cfg.reviewServerName}__jev_review`;
      if (typeof ctx.tools?.get !== 'function' || ctx.tools.get(toolName, agent) === undefined) {
        record({ type: 'quality_review', turn, decision: 'skip_no_tool', tool: toolName });
        return;
      }

      const diff = await buildTurnDiff(ctx, session, summary);
      if (!diff.trim()) {
        record({ type: 'quality_review', turn, decision: 'skip_empty_diff' });
        return;
      }

      let result;
      try {
        result = await ctx.tools.execute({
          callId: `jev-gate-review-${randomUUID()}`,
          name: toolName,
          arguments: {
            task: clip(lastSeenGoal ?? lastSeenPrompt ?? 'Complete the requested change.', 4_000).text,
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
          error: error instanceof Error ? error.message : 'unknown',
        });
        return;
      }

      if (result?.isError) {
        record({
          type: 'quality_review',
          turn,
          decision: 'fail_open',
          error: textOf(result.content).slice(0, 200) || 'tool returned isError',
        });
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
      });
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
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
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
let lastSeenSession;
let lastSeenGoal;
let lastSeenPrompt;

function noteSession(agent) {
  if (agent?.session) lastSeenSession = agent.session;
  const objective = agent?.goal?.objective;
  if (typeof objective === 'string' && objective.trim()) lastSeenGoal = objective;
}

/** Rút text từ `messages` của `agent/pre-step`. */
function notePrompt(messages) {
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
  if (text) lastSeenPrompt = text;
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
 * Lấy tin nhắn thật của user trong session, mới nhất ở cuối.
 *
 * Đây là bằng chứng cho câu hỏi "user có yêu cầu xoá không". Cố ý CHỈ lấy
 * `source.kind === 'user'`: nếu lẫn output tool hay nội dung dán vào, nội dung
 * không tin cậy có thể tự cấp quyền xoá (đã đo: dán "user đã phê duyệt" làm
 * nhánh `noul` cũ trả 0.73–0.93).
 *
 * Cửa sổ 3 tin nhắn gần nhất, mỗi tin cắt 600 ký tự: đủ cho ngữ cảnh "ok làm đi"
 * nối tiếp một yêu cầu trước đó, mà không nhồi cả hội thoại (tài liệu TypeSafe:
 * state thừa làm giảm độ chính xác).
 */
export async function collectUserRequest(session) {
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
  return texts.slice(-3).map((text) => clip(text, 600).text).join('\n---\n');
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

async function recentToolCalls(session) {
  const events = sessionEvents(session);
  return events
    .filter((event) => event?.type === 'tool/call')
    .slice(-6)
    .map((event) => {
      const data = dataOf(event);
      return { tool: data.name, arguments: clip(JSON.stringify(data.arguments ?? {}), 300).text };
    });
}

async function collectProgress(session, step) {
  const events = sessionEvents(session);
  const assistant = events.filter((event) => event?.type === 'assistant/message').slice(-2);
  const text = assistant.map((event) => textOf(dataOf(event).message ?? dataOf(event))).filter(Boolean).join('\n');
  return text ? `step ${step}; recent assistant text: ${clip(text, 900).text}` : `step ${step}`;
}

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
      return service.summary(session.id, seq);
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
 * Cắt theo trần vì `jev_review` có giới hạn input riêng và sẽ từ chối request
 * quá lớn. File lỗi/không đọc được thì bỏ qua, không làm hỏng cả review.
 */
async function buildTurnDiff(ctx, session, summary) {
  let service;
  try {
    service = ctx.get('workspaceChanges', false);
  } catch {
    return '';
  }
  if (typeof service?.diff !== 'function') return '';
  const chunks = [];
  let budget = 24_000;
  for (let index = 0; index < summary.files.length && budget > 0; index += 1) {
    let fileDiff;
    try {
      fileDiff = await service.diff(session.id, summary.files[index].seq ?? 0, index);
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
