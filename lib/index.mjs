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

const LOG_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'dsh-jev-gate');
const LOG_FILE = join(LOG_DIR, 'decisions.jsonl');
const LEASES = [1, 2, 5, 10];

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
  gateTimeoutMs: 2_000,
  authorizationTimeoutMs: 4_000,
  stopTimeoutMs: 6_000,
  effortTimeoutMs: 8_000,
  spawnTimeoutMs: 6_000,
  contextTimeoutMs: 6_000,
  failureTimeoutMs: 4_000,
  maxLeaseSteps: 10,
  enableDestructiveGate: true,
  enableAuthorizationOverride: true,
  enableCompletionCheck: true,
  enableEffortRouting: true,
  enableSpawnHint: true,
  enableContextTriage: true,
  enableFailureRecovery: true,
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
  gateTimeoutMs: z.number().default(DEFAULTS.gateTimeoutMs),
  authorizationTimeoutMs: z.number().default(DEFAULTS.authorizationTimeoutMs),
  stopTimeoutMs: z.number().default(DEFAULTS.stopTimeoutMs),
  effortTimeoutMs: z.number().default(DEFAULTS.effortTimeoutMs),
  spawnTimeoutMs: z.number().default(DEFAULTS.spawnTimeoutMs),
  contextTimeoutMs: z.number().default(DEFAULTS.contextTimeoutMs),
  failureTimeoutMs: z.number().default(DEFAULTS.failureTimeoutMs),
  maxLeaseSteps: z.number().default(DEFAULTS.maxLeaseSteps),
  enableDestructiveGate: z.boolean().default(DEFAULTS.enableDestructiveGate),
  enableAuthorizationOverride: z.boolean().default(DEFAULTS.enableAuthorizationOverride),
  enableCompletionCheck: z.boolean().default(DEFAULTS.enableCompletionCheck),
  enableEffortRouting: z.boolean().default(DEFAULTS.enableEffortRouting),
  enableSpawnHint: z.boolean().default(DEFAULTS.enableSpawnHint),
  enableContextTriage: z.boolean().default(DEFAULTS.enableContextTriage),
  enableFailureRecovery: z.boolean().default(DEFAULTS.enableFailureRecovery),
});

/** Ghi log quyết định; lỗi ghi log không bao giờ được làm hỏng quyết định. */
function makeRecorder() {
  let ready;
  return (entry) => {
    ready ??= mkdir(LOG_DIR, { recursive: true }).catch(() => {});
    ready
      .then(() => appendFile(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 }))
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
  const record = makeRecorder();
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
  if (cfg.enableEffortRouting) {
    /** lease đang giữ, khoá theo `provider/model` (agent/request không nhận agent). */
    const leases = new Map();

    ctx.on('agent/request', async ({ step }, next) => {
      const downstream = await next();
      const route = `${downstream?.provider ?? ''}/${downstream?.model ?? ''}`;
      if (!downstream?.provider || !downstream?.model) return downstream;

      const supported = await supportedEffortsOf(ctx, downstream.provider, downstream.model);
      if (!supported.length) {
        record({ type: 'effort_route', step, decision: 'skip_no_levels', route, diagnostic: lastLookupDiagnostic });
        return downstream;
      }

      const lease = leases.get(route);
      if (lease && lease.remaining > 0) {
        lease.remaining -= 1;
        record({ type: 'effort_route', step, route, decision: 'lease_reuse', effort: lease.effort, remaining: lease.remaining });
        return { ...downstream, reasoningEffort: lease.effort };
      }

      let verdict;
      try {
        const progress = await collectProgress(lastSeenSession, step);
        const history = await recentToolCalls(lastSeenSession);
        verdict = await jev.evaluate(
          effortQuestion({
            // Goal (do user đặt) ưu tiên; nếu chưa có thì dùng prompt thô của turn.
            task: clip(lastSeenGoal ?? lastSeenPrompt ?? 'Unknown task', 1_500).text,
            progress,
            recentToolCalls: history,
            supportedEfforts: supported,
            effortMeaning: EFFORT_MEANING,
            leaseOptions: LEASES.filter((n) => n <= cfg.maxLeaseSteps),
          }),
          { timeoutOverrideMs: cfg.effortTimeoutMs },
        );
      } catch (error) {
        record({
          type: 'effort_route',
          step,
          route,
          decision: 'fail_open',
          error: error instanceof Error ? error.message : 'unknown',
        });
        return downstream;
      }

      const effort = verdict.answers.effort?.choice;
      const leaseSteps = Number(verdict.answers.lease?.choice);
      if (typeof effort !== 'string' || !supported.includes(effort) || !LEASES.includes(leaseSteps)) {
        record({ type: 'effort_route', step, route, decision: 'fail_open', error: 'invalid decision', effort, leaseSteps });
        return downstream;
      }
      leases.set(route, { effort, remaining: Math.max(leaseSteps - 1, 0) });
      record({
        type: 'effort_route',
        step,
        route,
        decision: 'applied',
        effort,
        leaseSteps,
        confidence: verdict.answers.effort?.confidence,
        probabilities: verdict.answers.effort?.probabilities,
      });
      return { ...downstream, reasoningEffort: effort };
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
