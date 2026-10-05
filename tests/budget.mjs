/**
 * Kiểm chứng §16 — NGÂN SÁCH JEV DÙNG CHUNG THEO TURN/SESSION.
 *
 * Chạy OFFLINE (không cần TYPESAFE_API_KEY, không cần mạng): Jev được thay bằng
 * một `fetch` giả ĐẾM số request, và plugin được nạp với `logDir` trỏ vào thư
 * mục tạm nên không làm bẩn log thật.
 *
 * Bất biến phải giữ, đúng đặc tả:
 *   1. Mặc định `jevMaxCallsPerTurn: 4`, `jevMaxCallsPerSession: 100`.
 *   2. SAFETY (Lớp 1 destructive gate) KHÔNG BAO GIỜ bị ngân sách chặn — cạn
 *      ngân sách không được biến thành "cho lệnh nguy hiểm chạy".
 *   3. Lớp TẤT ĐỊNH = 0 call Jev (không đụng ngân sách).
 *   4. Lớp KHÔNG-safety khi cạn ngân sách: KHÔNG gọi model, và ghi log
 *      `jev_budget` kèm `layer` + `decision`.
 *   5. Thứ tự cắt: advisory trước, rồi effort, rồi recovery; completion được
 *      chừa chỗ (ưu tiên cao hơn).
 *   6. `jevBudgetEnabled: false` gỡ hẳn cơ chế (hành vi cũ).
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'lib', 'index.mjs');

const TEMP_DIRS = [];
const tmpDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Nạp plugin với ctx giả, giống `tests/offline.mjs` nhưng gọn cho mục đích ở đây. */
async function loadPlugin({ logDir, config = {}, services, credentials } = {}) {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Math.random()}`);
  const handlers = {};
  const effects = [];
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    effect: (fn) => { effects.push(fn); return fn; },
    logger: { info() {}, warn() {}, error() {} },
    credentials: credentials ?? { resolve: async () => ({ value: 'test-key' }) },
    llm: {
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }] },
      }),
    },
    get: (name, strict = true) => {
      const found = services?.[name];
      if (found === undefined && strict) throw new Error(`service "${name}" is not available`);
      return found;
    },
  };
  await mod.apply(ctx, { logDir, ...config });
  return { handlers, effects, mod };
}

/**
 * `fetch` giả đếm request. Trả lời MỌI câu hỏi bằng `answers` (theo id), mặc
 * định `'*'`. Ghi lại `bodies` để kiểm state nếu cần.
 *
 * `calls()` là số request Jev THẬT SỰ được gửi (sau khi qua cổng ngân sách).
 */
async function withCountingJev(answers, run) {
  const realFetch = globalThis.fetch;
  let count = 0;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    count += 1;
    const body = JSON.parse(init.body);
    bodies.push(body);
    const ids = Object.keys(body.questions);
    const payload = {
      model: 'jev-stub',
      answers: Object.fromEntries(ids.map((id) => {
        const question = body.questions[id];
        const spec = answers[id] ?? answers['*'];
        const value = typeof spec === 'function' ? spec(id, question, count) : spec;
        if (question.type === 'noul') return [id, { type: 'noul', noul: value }];
        const keys = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === value ? 1 : 0]));
        return [id, { type: 'choice', choice: value, confidence: answers.__confidence ?? 0.9, probabilities }];
      })),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await run(() => count, bodies);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Đọc các dòng log `decisions.jsonl` theo `type`.
 *
 * Log ghi BẤT ĐỒNG BỘ (append qua promise), nên phải `await sleepMs` trước khi
 * đọc — và file có thể CHƯA TỒN TẠI nếu chưa có dòng nào được ghi.
 */
const rowsOf = (logDir, type) => {
  let raw;
  try { raw = readFileSync(join(logDir, 'decisions.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === type);
};

/** Ghi task của user vào state để Lớp 3/2/6 có gì mà đọc. */
const seedTask = async (handlers, agent, text) => {
  await handlers['agent/pre-step'][0](
    {
      turn: 1, step: 1, signal: new AbortController().signal, agent,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    },
    async () => ({ kind: 'enter' }),
  );
};

console.log('1. §16 — MẶC ĐỊNH: jevMaxCallsPerTurn=4, jevMaxCallsPerSession=100');

{
  const { mod } = await loadPlugin({ logDir: tmpDir('jev-gate-budget-') });
  const { Config } = mod;
  const parsed = Config['~standard'].validate({}).value;
  check('1a mặc định jevMaxCallsPerTurn = 4', parsed.jevMaxCallsPerTurn === 4, `=${parsed.jevMaxCallsPerTurn}`);
  check('1b mặc định jevMaxCallsPerSession = 100', parsed.jevMaxCallsPerSession === 100, `=${parsed.jevMaxCallsPerSession}`);
  check('1c mặc định jevBudgetEnabled = true', parsed.jevBudgetEnabled === true, `=${parsed.jevBudgetEnabled}`);
}

console.log('\n2. SAFETY ưu tiên tuyệt đối — cạn ngân sách KHÔNG mở cửa cho lệnh nguy hiểm');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * `jevMaxCallsPerTurn: 0` là trường hợp xấu nhất: ngân sách không-safety bằng
   * 0. Lớp 1 (safety) vẫn PHẢI gọi Jev — nếu không, hết tiền lại thành allow.
   * Stub trả destructive p=1 → deny.
   */
  await withCountingJev({ destructive: 1 }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevMaxCallsPerTurn: 0,
        jevMaxCallsPerSession: 0,
        enableDestructiveGate: true,
        enableCompletionCheck: false,
        enableEffortRouting: false,
      },
    });
    const agent = { cwd: '/tmp', session: { id: 'sess-safety', snapshotEvents: () => [] } };
    const out = await handlers['tools/pre-execute'][0](
      { name: 'bash', arguments: { command: 'rm -rf /tmp/customer-data' }, agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    );
    check('2a ngân sách 0 nhưng Lớp 1 VẪN gọi Jev (không bị chặn)', calls() === 1, `calls=${calls()}`);
    check('2b lệnh nguy hiểm vẫn bị DENY (không bị mở vì hết ngân sách)',
      out.kind === 'deny', `kind=${out.kind}`);
    const budgetRows = rowsOf(logDir, 'jev_budget').filter((row) => row.layer === 'destructive_gate');
    check('2c safety KHÔNG ghi jev_budget skip (không bị coi là vượt ngân sách)',
      budgetRows.length === 0, `n=${budgetRows.length}`);
  });
}

console.log('\n3. Lớp TẤT ĐỊNH = 0 call Jev (không đụng ngân sách)');

{
  const logDir = tmpDir('jev-gate-budget-');
  await withCountingJev({ '*': 'retry' }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        enableDestructiveGate: false,
        enableCompletionCheck: false,
        enableEffortRouting: true,
        effortDecision: 'deterministic',
        enableFailureRecovery: true,
      },
    });
    const agent = { id: 'det-a', cwd: '/tmp', session: { id: 'sess-det', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 1 } }] } };
    await seedTask(handlers, agent, 'đổi tên một biến trong config');
    await handlers['agent/request'][0](
      { turn: 1, step: 1, signal: new AbortController().signal, agent },
      async () => ({ provider: 'p', model: 'm' }),
    );
    // Lỗi ĐÃ BIẾT → Lớp 6 tất định, không hỏi Jev.
    await handlers['tools/post-execute'][0](
      { name: 'bash', arguments: { command: 'curl https://x' }, agent, signal: new AbortController().signal },
      { isError: true, content: [{ type: 'text', text: 'Error: connect ETIMEDOUT' }] },
      async () => ({ kind: 'accept' }),
    );
    check('3a effort tất định + lỗi đã biết → 0 call Jev', calls() === 0, `calls=${calls()}`);
  });
}

console.log('\n4. Lớp KHÔNG-safety cạn ngân sách → KHÔNG gọi model + log layer/decision');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * Chỉ bật Lớp 6 (recovery) với trần turn = 1. Hai lỗi NHẬP NHẰNG khác chữ ký
   * trong cùng một turn: lần đầu gọi Jev (đầy ngân sách), lần hai bị cắt.
   */
  await withCountingJev({ recovery: 'diagnose' }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevMaxCallsPerTurn: 1,
        enableDestructiveGate: false,
        enableCompletionCheck: false,
        enableEffortRouting: false,
        enableFailureRecovery: true,
        failureMaxPerTurn: 5,
      },
    });
    const agent = { cwd: '/tmp', session: { id: 'sess-cut', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 7 } }] } };
    const handler = handlers['tools/post-execute'][0];
    const call = (command, text) => handler(
      { name: 'bash', arguments: { command }, agent, signal: new AbortController().signal },
      { isError: true, content: [{ type: 'text', text }] },
      async () => ({ kind: 'accept' }),
    );
    const first = await call('./build', 'Error: build step 3 failed with exit code 2');
    const second = await call('./deploy', 'Error: deploy pipeline aborted unexpectedly');
    check('4a lần đầu (còn ngân sách) → gọi Jev', calls() === 1, `calls=${calls()}`);
    check('4b lần hai (cạn ngân sách) → KHÔNG gọi model', calls() === 1, `calls=${calls()}`);
    check('4c lần hai không chèn gợi ý nào (im lặng, không đoán bừa)',
      (second.additionalContexts ?? []).length === 0,
      `n=${(second.additionalContexts ?? []).length}`);
    check('4d lần đầu vẫn chèn gợi ý bình thường',
      (first.additionalContexts ?? []).length === 1,
      `n=${(first.additionalContexts ?? []).length}`);

    await sleepMs(200);
    const budgetRows = rowsOf(logDir, 'jev_budget');
    const row = budgetRows.at(-1);
    check('4e log có jev_budget với decision=skip_budget', row?.decision === 'skip_budget', JSON.stringify(row ?? {}));
    check('4f log ghi đúng layer bị cắt', row?.layer === 'failure_recovery', `layer=${row?.layer}`);
    check('4g log ghi reason + priority + số đã dùng',
      row?.reason === 'turn_budget' && row?.priority === 'recovery' && row?.turnUsed === 1,
      JSON.stringify({ reason: row?.reason, priority: row?.priority, turnUsed: row?.turnUsed }));
  });
}

console.log('\n5. Thứ tự cắt: advisory nhường trước; completion được chừa chỗ');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * Bật completion + recovery + advisory (pre-step), trần turn = 4.
   *
   * Phần CHỪA đúng theo §16:
   *   • completion (hạng 3, cao nhất): reserve 0 → trần 4.
   *   • recovery   (hạng 2): reserve 1 (chừa completion) → trần 3.
   *   • advisory   (hạng 0): reserve 2 (chừa completion + recovery) → trần 2.
   *
   * Kịch bản: 3 lỗi nhập nhằng khác chữ ký ở turn 3 → recovery tiêu 3 call (đúng
   * trần 3 của nó). Rồi:
   *   • pre-step advisory ở turn 3 → CÒN 1 slot trống nhưng reserve 2 > phần còn
   *     lại, nên BỊ CẮT — advisory nhường đúng lúc.
   *   • completion ở turn 3 → vẫn chạy (reserve 0), KHÔNG bị advisory/recovery ăn
   *     mất chỗ. Đây là bất biến "không hy sinh lớp ưu tiên cao để giữ gợi ý".
   *
   * Đặt `agent.goal.objective` để `taskOf` có mục tiêu mà không phải đi qua
   * pre-step (pre-step chính là lớp advisory đang bị kiểm) — nhờ vậy số call
   * đếm được là TẤT ĐỊNH, không phụ thuộc thứ tự nạp task.
   */
  await withCountingJev({ '*': 'diagnose', approach: 'one-command-scan', complete: 1, evidence: 1, needs_execution: 0 }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevMaxCallsPerTurn: 4,
        enableDestructiveGate: false,
        enableCompletionCheck: true,
        enableEffortRouting: false,
        enableFailureRecovery: true,
        enableSpawnHint: true,
        enableContextTriage: false,
        failureMaxPerTurn: 5,
      },
    });
    const agent = {
      id: 'prio-a',
      cwd: '/tmp',
      goal: { objective: 'phân tích vài phương án rồi chọn một' },
      session: { id: 'sess-prio', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 3 } }] },
    };

    // 3 lỗi nhập nhằng khác chữ ký → tiêu 3 call recovery (đúng trần 3 của nó).
    const post = handlers['tools/post-execute'][0];
    for (const [cmd, text] of [
      ['./a', 'Error: alpha failed unexpectedly'],
      ['./b', 'Error: bravo failed unexpectedly'],
      ['./c', 'Error: charlie failed unexpectedly'],
    ]) {
      await post(
        { name: 'bash', arguments: { command: cmd }, agent, signal: new AbortController().signal },
        { isError: true, content: [{ type: 'text', text }] },
        async () => ({ kind: 'accept' }),
      );
    }
    const afterRecovery = calls();
    check('5a ba lỗi nhập nhằng → tiêu 3 call recovery (đúng trần chừa cho completion)',
      afterRecovery === 3, `calls=${afterRecovery}`);

    // Advisory (ưu tiên thấp nhất) → nhường: dù còn 1 slot, reserve 2 vẫn cắt nó.
    await handlers['agent/pre-step'][0](
      { turn: 3, step: 1, signal: new AbortController().signal, agent, messages: [] },
      async () => ({ kind: 'enter' }),
    );
    check('5b advisory bị cắt để nhường lớp ưu tiên cao hơn', calls() === 3, `calls=${calls()}`);
    await sleepMs(200);
    const advRow = rowsOf(logDir, 'jev_budget').filter((r) => r.layer === 'approach_context').at(-1);
    check('5c log ghi advisory bị cắt (approach_context, skip_budget, reserve=2)',
      advRow?.decision === 'skip_budget' && advRow?.priority === 'advisory' && advRow?.reserve === 2,
      JSON.stringify(advRow ?? {}));

    // Completion (ưu tiên cao nhất, reserve 0) → vẫn còn chỗ → chạy.
    await handlers['agent/turn-stopping'][0](
      { agent, turn: 3, signal: new AbortController().signal },
    );
    check('5d completion vẫn được chạy dù advisory đã bị cắt', calls() === 4, `calls=${calls()}`);
    await sleepMs(200);
    const compRow = rowsOf(logDir, 'completion_check').at(-1);
    check('5e completion thực sự chạy (không bị cắt, không fail_open)',
      compRow !== undefined && compRow.decision !== 'fail_open',
      JSON.stringify(compRow ?? {}));
  });
}

console.log('\n6. Ngân sách SESSION chặn xuyên turn');

{
  const logDir = tmpDir('jev-gate-budget-');
  await withCountingJev({ recovery: 'diagnose' }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevMaxCallsPerTurn: 4,
        jevMaxCallsPerSession: 2,
        enableDestructiveGate: false,
        enableCompletionCheck: false,
        enableEffortRouting: false,
        enableFailureRecovery: true,
        failureMaxPerTurn: 5,
      },
    });
    const post = handlers['tools/post-execute'][0];
    let turn = 10;
    const call = async (cmd, text) => {
      turn += 1;
      const agent = { cwd: '/tmp', session: { id: 'sess-cap', snapshotEvents: () => [{ type: 'tool/result', data: { turn } }] } };
      return post(
        { name: 'bash', arguments: { command: cmd }, agent, signal: new AbortController().signal },
        { isError: true, content: [{ type: 'text', text }] },
        async () => ({ kind: 'accept' }),
      );
    };
    // Mỗi turn một lỗi khác chữ ký → mỗi turn tiêu 1 call, nhưng session chỉ cho 2.
    await call('./a', 'Error: alpha failed unexpectedly');
    await call('./b', 'Error: bravo failed unexpectedly');
    await call('./c', 'Error: charlie failed unexpectedly');
    check('6a session cap=2 → chỉ 2 call dù mỗi turn còn ngân sách', calls() === 2, `calls=${calls()}`);
    await sleepMs(200);
    const sessionRow = rowsOf(logDir, 'jev_budget').filter((r) => r.reason === 'session_budget').at(-1);
    check('6b log ghi reason=session_budget',
      sessionRow?.reason === 'session_budget' && sessionRow?.layer === 'failure_recovery',
      JSON.stringify(sessionRow ?? {}));
  });
}

console.log('\n7. jevBudgetEnabled:false → gỡ hẳn cơ chế (hành vi cũ)');

{
  const logDir = tmpDir('jev-gate-budget-');
  await withCountingJev({ recovery: 'diagnose' }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevBudgetEnabled: false,
        jevMaxCallsPerTurn: 0,
        jevMaxCallsPerSession: 0,
        enableDestructiveGate: false,
        enableCompletionCheck: false,
        enableEffortRouting: false,
        enableFailureRecovery: true,
        failureMaxPerTurn: 5,
      },
    });
    const agent = { cwd: '/tmp', session: { id: 'sess-off', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 1 } }] } };
    await handlers['tools/post-execute'][0](
      { name: 'bash', arguments: { command: './build' }, agent, signal: new AbortController().signal },
      { isError: true, content: [{ type: 'text', text: 'Error: build failed unexpectedly' }] },
      async () => ({ kind: 'accept' }),
    );
    check('7a tắt ngân sách → trần 0 KHÔNG cắt call nào', calls() === 1, `calls=${calls()}`);
    check('7b không ghi dòng jev_budget nào', rowsOf(logDir, 'jev_budget').length === 0,
      `n=${rowsOf(logDir, 'jev_budget').length}`);
  });
}

console.log('\n8. BẤT BIẾN TỔNG (end-to-end): mọi lớp cùng bật, trần turn KHÔNG BAO GIỜ bị vượt');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * Đây là phép thử MẠNH NHẤT: bật TẤT CẢ các lớp gọi Jev CÙNG LÚC và dội vào
   * đúng MỘT turn, rồi khẳng định bất biến trung tâm của §16:
   *
   *   (a) tổng số call Jev của turn KHÔNG BAO GIỜ vượt `jevMaxCallsPerTurn`;
   *   (b) lớp completion (ưu tiên cao nhất) VẪN chạy dù advisory/recovery đã
   *       tranh hết slot — "không hy sinh lớp ưu tiên cao để giữ gợi ý";
   *   (c) mọi lần bị cắt đều để lại dấu vết `jev_budget` có `layer` + `reason`.
   *
   * Thứ tự dội là TẤT ĐỊNH nên phép đếm không phụ thuộc thời điểm:
   *   • 3 lỗi recovery  → tiêu 3 (trần recovery = 4 − 1(chừa completion) = 3)
   *   • pre-step advisory → BỊ CẮT (đã dùng 3, còn chừa 2 cho completion+effort)
   *   • turn-stopping completion → CHẠY (reserve 0) → tiêu 4
   *   • agent/request effort → BỊ CẮT (đã chạm trần 4)
   * Tổng đúng 4 = trần, và completion nằm TRONG 4 call đó.
   */
  await withCountingJev(
    { '*': 'diagnose', approach: 'one-command-scan', effort: 'high', complete: 1, evidence: 1, needs_execution: 0 },
    async (calls) => {
      const { handlers } = await loadPlugin({
        logDir,
        config: {
          // Mặc định §16: 4/turn, 100/session — không ghi đè trần để kiểm ĐÚNG
          // con số mặc định trên đường tổng hợp.
          enableDestructiveGate: false,
          enableCompletionCheck: true,
          enableEffortRouting: true,
          enableFailureRecovery: true,
          enableSpawnHint: true,
          enableContextTriage: false,
          failureMaxPerTurn: 5,
        },
      });
      const agent = {
        id: 'all-a',
        cwd: '/tmp',
        goal: { objective: 'phân tích vài phương án rồi chọn một' },
        session: { id: 'sess-all', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 9 } }] },
      };

      const post = handlers['tools/post-execute'][0];
      const fail = (cmd, text) => post(
        { name: 'bash', arguments: { command: cmd }, agent, signal: new AbortController().signal },
        { isError: true, content: [{ type: 'text', text }] },
        async () => ({ kind: 'accept' }),
      );

      await fail('./a', 'Error: alpha failed unexpectedly');
      await fail('./b', 'Error: bravo failed unexpectedly');
      await fail('./c', 'Error: charlie failed unexpectedly');
      check('8a 3 lỗi recovery tiêu đúng 3 call (trần chừa completion)', calls() === 3, `calls=${calls()}`);

      await handlers['agent/pre-step'][0](
        { turn: 9, step: 1, signal: new AbortController().signal, agent, messages: [] },
        async () => ({ kind: 'enter' }),
      );
      check('8b advisory bị cắt (không vượt trần)', calls() === 3, `calls=${calls()}`);

      await handlers['agent/turn-stopping'][0]({ agent, turn: 9, signal: new AbortController().signal });
      check('8c completion CHẠY (ưu tiên cao nhất vẫn có chỗ)', calls() === 4, `calls=${calls()}`);

      await handlers['agent/request'][0](
        { turn: 9, step: 1, signal: new AbortController().signal, agent },
        async () => ({ provider: 'p', model: 'm' }),
      );
      check('8d effort bị cắt ở slot cuối — TỔNG KHÔNG VƯỢT TRẦN', calls() === 4, `calls=${calls()}`);
      check('8e bất biến trung tâm: tổng call của turn ≤ 4', calls() <= 4, `calls=${calls()}`);

      await sleepMs(250);
      const rows = rowsOf(logDir, 'jev_budget');
      const layersCut = new Set(rows.map((r) => r.layer));
      check('8f mọi lần cắt đều có dấu vết jev_budget (layer + reason)',
        rows.length >= 2 && rows.every((r) => r.layer && r.reason && r.decision === 'skip_budget'),
        JSON.stringify(rows.map((r) => `${r.layer}:${r.reason}`)));
      check('8g advisory bị cắt trước (approach_context)', layersCut.has('approach_context'),
        [...layersCut].join(','));
      check('8h effort bị cắt sau cùng (effort_route)', layersCut.has('effort_route'),
        [...layersCut].join(','));
      check('8i KHÔNG có dòng cắt nào cho completion_check (không bị hy sinh)',
        !layersCut.has('completion_check'), [...layersCut].join(','));
      const compRow = rowsOf(logDir, 'completion_check').at(-1);
      check('8j completion thực sự CHẠY và chấp nhận (không fail_open)',
        compRow !== undefined && compRow.decision === 'accept', JSON.stringify(compRow ?? {}));
    },
  );
}

console.log('\n9. Lớp TẤT ĐỊNH không chiếm slot chừa (effortDecision: deterministic)');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * Lớp 3 ở chế độ `deterministic` KHÔNG gọi Jev, nên nó không được chiếm một
   * slot chừa của lớp advisory — nếu không, advisory bị cắt sớm một cách vô cớ
   * vì một lớp chẳng bao giờ tiêu slot đó.
   *
   * Đối chứng chính xác: trần 4, bật completion + recovery + advisory, effort
   * TẤT ĐỊNH.
   *   • reserve của advisory = 1 (completion) + 1 (recovery) = 2 (KHÔNG tính
   *     effort). Sau 1 lỗi recovery: 1 + 1 + 2 = 4 ≤ 4 → advisory CHẠY.
   *   • Nếu tính oan effort (reserve 3): 1 + 1 + 3 = 5 > 4 → advisory bị cắt.
   * Vậy chỉ cần advisory chạy được ở đây là đủ chứng minh.
   */
  await withCountingJev(
    { '*': 'diagnose', approach: 'one-command-scan', complete: 1, evidence: 1, needs_execution: 0 },
    async (calls) => {
      const { handlers } = await loadPlugin({
        logDir,
        config: {
          enableDestructiveGate: false,
          enableCompletionCheck: true,
          enableEffortRouting: true,
          effortDecision: 'deterministic',
          enableFailureRecovery: true,
          enableSpawnHint: true,
          failureMaxPerTurn: 5,
        },
      });
      const agent = {
        id: 'detres-a',
        cwd: '/tmp',
        goal: { objective: 'phân tích vài phương án rồi chọn một' },
        session: { id: 'sess-detres', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 5 } }] },
      };

      await handlers['tools/post-execute'][0](
        { name: 'bash', arguments: { command: './a' }, agent, signal: new AbortController().signal },
        { isError: true, content: [{ type: 'text', text: 'Error: alpha failed unexpectedly' }] },
        async () => ({ kind: 'accept' }),
      );
      check('9a 1 lỗi recovery → tiêu 1 call', calls() === 1, `calls=${calls()}`);

      await handlers['agent/pre-step'][0](
        { turn: 5, step: 1, signal: new AbortController().signal, agent, messages: [] },
        async () => ({ kind: 'enter' }),
      );
      check('9b advisory VẪN chạy (effort tất định không chiếm slot chừa)', calls() === 2, `calls=${calls()}`);
      await sleepMs(200);
      const cut = rowsOf(logDir, 'jev_budget').filter((r) => r.layer === 'approach_context');
      check('9c không có dòng cắt nào cho advisory', cut.length === 0, `n=${cut.length}`);
    },
  );
}

console.log('\n10. ĐỒNG THỜI: nhiều call song song KHÔNG vượt trần (kiểm→tiêu là nguyên tử)');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * DSH có thể chạy nhiều tool call SONG SONG trong một turn, nên nhiều
   * `post-execute` có thể cùng lúc tiến tới cổng ngân sách. Nếu phép
   * "kiểm rồi tiêu" bị ngắt quãng bởi một `await`, hai lời gọi cùng đọc
   * `turnUsed=3` rồi cùng tiêu → vượt trần.
   *
   * Trong JS đơn luồng điều này chỉ xảy ra nếu có `await` xen giữa
   * `budgetAllows` và `budgetSpend`. Bản thân hai hàm là ĐỒNG BỘ liền nhau nên
   * an toàn — phép thử này khoá lại bất biến đó: dội 8 lỗi nhập nhằng (khác
   * chữ ký) bằng `Promise.all` với trần 4, và khẳng định tổng call vẫn ≤ 4.
   */
  await withCountingJev({ '*': 'diagnose' }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        enableDestructiveGate: false,
        enableCompletionCheck: false,
        enableEffortRouting: false,
        enableFailureRecovery: true,
        failureMaxPerTurn: 50,
      },
    });
    const agent = { id: 'par-a', cwd: '/tmp', session: { id: 'sess-par', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 1 } }] } };
    const post = handlers['tools/post-execute'][0];
    const fail = (i) => post(
      { name: 'bash', arguments: { command: `./x${i}` }, agent, signal: new AbortController().signal },
      { isError: true, content: [{ type: 'text', text: `Error: worker${i} failed unexpectedly` }] },
      async () => ({ kind: 'accept' }),
    );
    // 8 lời gọi khởi động cùng lúc, mỗi cái một chữ ký lỗi khác nhau.
    await Promise.all(Array.from({ length: 8 }, (_, i) => fail(i)));
    check('10a 8 call song song → KHÔNG vượt trần 4', calls() <= 4, `calls=${calls()}`);
    await sleepMs(250);
    const cut = rowsOf(logDir, 'jev_budget').filter((r) => r.layer === 'failure_recovery');
    check('10b phần bị cắt vì đồng thời đều được ghi log', cut.length >= 4, `n=${cut.length}`);
  });
}

console.log('\n11. SAFETY không tiêu ngân sách không-safety (nhiều lệnh shell ≠ cạn ngân sách)');

{
  const logDir = tmpDir('jev-gate-budget-');
  /**
   * Đây là lỗi thật đo được trên log vận hành: gate (safety) gọi Jev cho MỌI
   * lệnh shell, nên một turn nhiều lệnh cộng dồn vào cùng bộ đếm lượt và đốt hết
   * trần 4 — completion/effort bị cắt âm thầm (từng thấy `turnUsed=29` với trần
   * 4, và một phiên 197 lần gate chỉ còn 1 completion_check).
   *
   * Bất biến cần khoá: dội N lệnh qua gate KHÔNG được làm cạn phần ngân sách mà
   * completion cần. Trần turn = 2 (nhỏ để kịch bản rõ), completion phải VẪN chạy
   * sau khi gate đã chạy 6 lần.
   */
  await withCountingJev({ destructive: 0, complete: 1, evidence: 1, needs_execution: 0 }, async (calls) => {
    const { handlers } = await loadPlugin({
      logDir,
      config: {
        jevMaxCallsPerTurn: 2,
        jevMaxCallsPerSession: 100,
        enableDestructiveGate: true,
        enableCompletionCheck: true,
        enableEffortRouting: false,
        enableContextTriage: false,
        enableReadOnlyPrefilter: false,
      },
    });
    const agent = {
      id: 'safety-budget-a',
      cwd: '/tmp',
      goal: { objective: 'chạy vài lệnh rồi xác nhận hoàn thành' },
      session: { id: 'sess-safety-budget', snapshotEvents: () => [{ type: 'tool/result', data: { turn: 1 } }] },
    };
    const pre = handlers['tools/pre-execute'][0];
    const turn = 1;
    // 6 lệnh KHÔNG provably-readonly để buộc gate thật sự hỏi Jev mỗi lần.
    for (let i = 0; i < 6; i += 1) {
      await pre(
        { name: 'bash', arguments: { command: `./step-${i} --run` }, agent, signal: new AbortController().signal, turn },
        async () => ({ kind: 'allow' }),
      );
    }
    check('11a gate chạy Jev cho cả 6 lệnh (safety không bị chặn)',
      calls() === 6, `calls=${calls()}`);
    await sleepMs(200);
    const safetyCuts = rowsOf(logDir, 'jev_budget').filter((r) => r.layer === 'destructive_gate');
    check('11b KHÔNG có dòng cắt nào cho safety dù đã vượt trần turn=2',
      safetyCuts.length === 0, `n=${safetyCuts.length}`);

    // Completion (không-safety) sau đó → phải vẫn còn nguyên ngân sách để chạy.
    await handlers['agent/turn-stopping'][0](
      { agent, turn, signal: new AbortController().signal },
    );
    check('11c completion VẪN chạy sau 6 lệnh gate (safety không ăn ngân sách)',
      calls() === 7, `calls=${calls()}`);
    await sleepMs(200);
    const compCut = rowsOf(logDir, 'jev_budget').filter((r) => r.layer === 'completion_check');
    check('11d completion KHÔNG bị ghi skip_budget',
      compCut.length === 0, `n=${compCut.length}`);
    const compRow = rowsOf(logDir, 'completion_check').at(-1);
    check('11e completion thực sự chạy (không fail_open)',
      compRow !== undefined && compRow.decision !== 'fail_open',
      JSON.stringify(compRow ?? {}));
  });
}

console.log(`\n${'─'.repeat(56)}`);
console.log(failed === 0 ? 'BUDGET: TẤT CẢ PASS' : `BUDGET: ${failed} MỤC HỎNG`);
process.exit(failed === 0 ? 0 : 1);
