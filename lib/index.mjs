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

import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createJev } from './jev-client.mjs';
import {
  clip,
  completionQuestion,
  destructiveQuestion,
  effortQuestion,
  EFFORT_MEANING,
} from './policy.mjs';

export const name = 'jev-gate';
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
const DEFAULTS = {
  destructiveThreshold: 0.7,
  completionThreshold: 0.5,
  evidenceThreshold: 0.5,
  executionThreshold: 0.5,
  gateTimeoutMs: 2_000,
  stopTimeoutMs: 6_000,
  effortTimeoutMs: 8_000,
  maxLeaseSteps: 10,
  enableDestructiveGate: true,
  enableCompletionCheck: true,
  enableEffortRouting: true,
};

export const Config = z.object({
  destructiveThreshold: z.number().default(DEFAULTS.destructiveThreshold),
  completionThreshold: z.number().default(DEFAULTS.completionThreshold),
  evidenceThreshold: z.number().default(DEFAULTS.evidenceThreshold),
  executionThreshold: z.number().default(DEFAULTS.executionThreshold),
  gateTimeoutMs: z.number().default(DEFAULTS.gateTimeoutMs),
  stopTimeoutMs: z.number().default(DEFAULTS.stopTimeoutMs),
  effortTimeoutMs: z.number().default(DEFAULTS.effortTimeoutMs),
  maxLeaseSteps: z.number().default(DEFAULTS.maxLeaseSteps),
  enableDestructiveGate: z.boolean().default(DEFAULTS.enableDestructiveGate),
  enableCompletionCheck: z.boolean().default(DEFAULTS.enableCompletionCheck),
  enableEffortRouting: z.boolean().default(DEFAULTS.enableEffortRouting),
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

  /* ───────── Bắt task text sớm: chạy TRƯỚC agent/request mỗi step ───────── */
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    notePrompt(messages);
    return next();
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
      record({ type: 'destructive_gate', tool: exec.name, decision: 'deny', p, command: clip(command, 400).text });
      return {
        kind: 'deny',
        reason:
          `Jev flagged this ${exec.name} call as destructive (p=${p.toFixed(2)}, `
          + `threshold ${cfg.destructiveThreshold}). The body was not executed. `
          + 'If the action is genuinely intended, reissue it with an explicit justification '
          + 'or narrow it to a path created in this session.',
        info: { name: 'JevDestructiveGate', code: 'JEV_DESTRUCTIVE', probability: p },
      };
    }, { prepend: true });
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
        source: 'jev-gate',
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
