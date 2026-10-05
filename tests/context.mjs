/**
 * Kiểm chứng §22 — NGÂN SÁCH VĂN BẢN PLUGIN CHÈN VÀO CONTEXT MỖI TURN.
 *
 * Sáu lớp chèn text vào context: L4 approach, L5 file, L6 recovery, L8 jevgrep,
 * L2 completion, L7 review. Không có trần thì một turn dài cộng dồn hàng nghìn
 * token nhiễu. Trần `maxPluginContextTokensPerTurn` (mặc định 500, ước lượng
 * chars/4) chặn điều đó.
 *
 * Bất biến được kiểm ở đây:
 *   1. Mặc định = 500 token, và schema phơi đúng khoá đó.
 *   2. Ước lượng token = chars/4 làm tròn lên.
 *   3. `planInjection` thuần: giữ theo ưu tiên safety > recovery > completion >
 *      advisory; mảnh bị bỏ ghi rõ `reason`.
 *   4. `safety`/`consent`/`real_user` KHÔNG BAO GIỜ bị bỏ, kể cả trần = 0.
 *   5. Chèn THẬT qua plugin bị cắt khi vượt trần, và có log `context_budget`.
 *   6. Hạng thấp (advisory ở step 1) KHÔNG ăn hết hạn mức của hạng cao đến sau
 *      trong cùng turn (reserve).
 *   7. Trần = 0 → không mảnh advisory nào được chèn.
 *   8. Trần lớn → mọi mảnh advisory được chèn, không log `context_budget`.
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'lib', 'index.mjs');
const INJECTION_MODULE = join(HERE, '..', 'lib', 'injection.mjs');

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

const makeWorkspace = (files) => {
  const root = tmpDir('jev-gate-context-');
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
};

async function loadPlugin({ logDir, config = {} } = {}) {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Math.random()}`);
  const handlers = {};
  const effects = [];
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    effect: (fn) => { effects.push(fn); return fn; },
    logger: { info() {}, warn() {}, error() {} },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    llm: {
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }] },
      }),
    },
    get: (name, strict = true) => {
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };
  await mod.apply(ctx, { logDir, ...config });
  return { handlers, effects, mod };
}

async function withRawJev(answerFor, run) {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const ids = Object.keys(body.questions);
    const answers = Object.fromEntries(ids.map((id) => {
      const question = body.questions[id];
      const spec = answerFor(id, question, bodies.length) ?? {};
      if (question.type === 'noul') return [id, { type: 'noul', noul: spec.noul ?? 0 }];
      const keys = Object.keys(question.criteria);
      const choice = spec.choice ?? keys[0];
      return [id, {
        type: 'choice',
        choice,
        confidence: spec.confidence ?? 0.9,
        probabilities: spec.probabilities
          ?? Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])),
      }];
    }));
    return new Response(JSON.stringify({
      model: 'jev-stub', answers, usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await run(bodies);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * `record` ghi log bằng `appendFile` (BẤT ĐỒNG BỘ, không await) — đọc ngay sau
 * khi handler trả về sẽ thấy file còn thiếu. Chờ tới khi thấy đủ số dòng cần,
 * hoặc hết hạn thì trả về những gì đang có.
 */
const rowsOf = async (logDir, type, minRows = 1) => {
  const read = () => {
    try {
      return readFileSync(join(logDir, 'decisions.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((row) => row.type === type);
    } catch { return []; }
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = read();
    if (rows.length >= minRows) return rows;
    await sleepMs(25);
  }
  return read();
};

const runPreStep = (handlers, agent, task, turn = 1) => {
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] }];
  return handlers['agent/pre-step'][0](
    { messages, turn, step: 1, signal: new AbortController().signal, agent },
    async () => ({ kind: 'enter', messages }),
  );
};

const injectedText = (result) => (result.messages ?? []).slice(1)
  .map((m) => m.content?.[0]?.text ?? '').join('\n');

console.log('1. §22 mặc định + schema');

{
  const { mod } = await loadPlugin({ logDir: tmpDir('jev-gate-context-') });
  const resolved = mod.Config['~standard'].validate({}).value;
  check('1a mặc định maxPluginContextTokensPerTurn = 500',
    resolved.maxPluginContextTokensPerTurn === 500, `v=${resolved.maxPluginContextTokensPerTurn}`);
  check('1b schema phơi khoá maxPluginContextTokensPerTurn',
    'maxPluginContextTokensPerTurn' in resolved, Object.keys(resolved).length + ' keys');
  check('1c trần là số nguyên không âm', Number.isFinite(resolved.maxPluginContextTokensPerTurn)
    && resolved.maxPluginContextTokensPerTurn >= 0, `v=${resolved.maxPluginContextTokensPerTurn}`);
}

console.log('\n2. §22 ước lượng token = chars/4 làm tròn lên');

{
  const { estimateTokens, CONTEXT_PRIORITY, CONTEXT_PROTECTED } = await import(
    `${pathToFileURL(INJECTION_MODULE).href}?t=${Math.random()}`
  );
  check('2a chuỗi rỗng → 0', estimateTokens('') === 0, '');
  check('2b 4 ký tự → 1', estimateTokens('abcd') === 1, '');
  check('2c 5 ký tự → 2 (làm tròn lên)', estimateTokens('abcde') === 2, '');
  check('2d 400 ký tự → 100', estimateTokens('x'.repeat(400)) === 100, '');
  check('2e không phải chuỗi → 0 (không ném)', estimateTokens(null) === 0 && estimateTokens(undefined) === 0, '');
  check('2f ưu tiên safety > recovery > completion > advisory',
    CONTEXT_PRIORITY.safety > CONTEXT_PRIORITY.recovery
    && CONTEXT_PRIORITY.recovery > CONTEXT_PRIORITY.completion
    && CONTEXT_PRIORITY.completion > CONTEXT_PRIORITY.advisory, JSON.stringify(CONTEXT_PRIORITY));
  check('2g protected gồm safety/consent/real_user',
    CONTEXT_PROTECTED.has('safety') && CONTEXT_PROTECTED.has('consent') && CONTEXT_PROTECTED.has('real_user'),
    [...CONTEXT_PROTECTED].join(','));
}

console.log('\n3. §22 planInjection — cắt theo ưu tiên, mảnh bỏ ghi lý do');

{
  const { planInjection } = await import(`${pathToFileURL(INJECTION_MODULE).href}?t=${Math.random()}`);
  const text = (n) => 'x'.repeat(n * 4); // đúng n token

  // 3a. Vừa trần → giữ hết.
  const fits = planInjection([
    { kind: 'advisory', text: text(50) },
    { kind: 'recovery', text: text(50) },
  ], 100);
  check('3a vừa trần → giữ cả hai', fits.kept.length === 2 && fits.dropped.length === 0,
    `kept=${fits.kept.length} dropped=${fits.dropped.length} used=${fits.used}`);

  // 3b. Vượt trần → bỏ mảnh hạng THẤP trước, giữ hạng cao.
  const overflow = planInjection([
    { kind: 'advisory', text: text(80) },
    { kind: 'recovery', text: text(80) },
  ], 100);
  check('3b vượt trần → giữ recovery, bỏ advisory',
    overflow.kept.length === 1 && overflow.kept[0].kind === 'recovery'
    && overflow.dropped.length === 1 && overflow.dropped[0].kind === 'advisory',
    `kept=${overflow.kept.map((e) => e.kind)} dropped=${overflow.dropped.map((e) => e.kind)}`);

  // 3c. Thứ tự chèn giữ NGUYÊN thứ tự đầu vào (không sắp lại theo ưu tiên).
  const order = planInjection([
    { kind: 'advisory', text: text(10) },
    { kind: 'recovery', text: text(10) },
    { kind: 'completion', text: text(10) },
  ], 500);
  check('3c kept giữ nguyên thứ tự đầu vào',
    order.kept.map((e) => e.kind).join(',') === 'advisory,recovery,completion',
    order.kept.map((e) => e.kind).join(','));

  // 3d. Mảnh bị bỏ mang `reason`.
  check('3d mảnh bị bỏ có reason=over_context_budget',
    overflow.dropped.every((e) => e.reason === 'over_context_budget'),
    JSON.stringify(overflow.dropped.map((e) => e.reason)));

  // 3e. `used` chỉ tính mảnh được giữ.
  check('3e used = tổng token mảnh giữ', overflow.used === 80, `used=${overflow.used}`);

  // 3f. Trần 0 → bỏ hết advisory.
  const zero = planInjection([{ kind: 'advisory', text: text(10) }], 0);
  check('3f trần 0 → advisory bị bỏ', zero.kept.length === 0 && zero.dropped.length === 1, '');

  // 3g. Trần âm/NaN → coi như 0, không ném.
  check('3g trần âm/NaN → coi như 0',
    planInjection([{ kind: 'advisory', text: text(10) }], -5).kept.length === 0
    && planInjection([{ kind: 'advisory', text: text(10) }], Number.NaN).kept.length === 0, '');

  // 3h. Danh sách rỗng → rỗng.
  check('3h danh sách rỗng → rỗng', planInjection([], 100).kept.length === 0, '');

  // 3i. kind thiếu → mặc định advisory.
  const noKind = planInjection([{ text: text(10) }], 100);
  check('3i thiếu kind → mặc định advisory', noKind.kept[0]?.kind === 'advisory', noKind.kept[0]?.kind);
}

console.log('\n4. §22 safety/consent/real_user KHÔNG BAO GIỜ bị bỏ');

{
  const { planInjection } = await import(`${pathToFileURL(INJECTION_MODULE).href}?t=${Math.random()}`);
  const text = (n) => 'x'.repeat(n * 4);

  for (const kind of ['safety', 'consent', 'real_user']) {
    const out = planInjection([
      { kind, text: text(100) },
      { kind: 'advisory', text: text(100) },
    ], 0);
    check(`4 ${kind} giữ được kể cả trần 0`,
      out.kept.some((e) => e.kind === kind) && !out.kept.some((e) => e.kind === 'advisory'),
      `kept=${out.kept.map((e) => e.kind)}`);
  }

  // Mảnh bảo vệ VƯỢT trần vẫn được giữ (an toàn thắng hạn mức), và `used` phản ánh.
  const over = planInjection([{ kind: 'safety', text: text(900) }], 100);
  check('4d safety vượt trần vẫn giữ (không cắt ràng buộc an toàn)',
    over.kept.length === 1 && over.used === 900, `used=${over.used}`);
}

console.log('\n5. §22 chèn THẬT qua plugin bị cắt theo trần, có log context_budget');

{
  const root = makeWorkspace({
    'src/auth.ts': "import { db } from './db';\nexport function login(u) { return db.find(u); }\n",
    'src/other.ts': 'export const x = 1;\n',
  });

  // 5a. Trần lớn → cả approach lẫn file được chèn, KHÔNG log context_budget.
  const bigLog = tmpDir('jev-gate-context-');
  const big = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: bigLog,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true, maxPluginContextTokensPerTurn: 5_000,
        },
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa hàm login trong auth');
    },
  );
  const bigText = injectedText(big);
  check('5a trần lớn → chèn cả approach lẫn bằng chứng file',
    /scripted-analysis/.test(bigText) && /src\/auth\.ts/.test(bigText), `${bigText.length} chars`);
  const bigBudget = await rowsOf(bigLog, 'context_budget', 1);
  check('5b trần lớn → KHÔNG có log context_budget',
    bigBudget.length === 0, `n=${bigBudget.length}`);

  // 5c. Trần 0 → advisory bị bỏ hết, có log context_budget, không chèn message.
  const zeroLog = tmpDir('jev-gate-context-');
  const zero = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: zeroLog,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true, maxPluginContextTokensPerTurn: 0,
        },
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa hàm login trong auth');
    },
  );
  check('5c trần 0 → không chèn message nào', injectedText(zero) === '',
    JSON.stringify(injectedText(zero)).slice(0, 40));
  const budgetRows = await rowsOf(zeroLog, 'context_budget', 1);
  check('5d trần 0 → có log context_budget với cap=0',
    budgetRows.length >= 1 && budgetRows.some((r) => r.cap === 0),
    JSON.stringify(budgetRows.map((r) => ({ cap: r.cap, dropped: r.dropped }))));
  check('5e log context_budget ghi rõ mảnh bị bỏ',
    budgetRows.some((r) => Array.isArray(r.dropped) && r.dropped.length > 0),
    JSON.stringify(budgetRows[0]?.dropped));

  // 5f. Trần trung bình: chỉ một phần được chèn, phần bị bỏ có log.
  const midLog = tmpDir('jev-gate-context-');
  await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: midLog,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true, maxPluginContextTokensPerTurn: 60,
        },
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa hàm login trong auth');
    },
  );
  const midBudget = await rowsOf(midLog, 'context_budget', 1);
  check('5f trần 60 → ít nhất một mảnh bị bỏ, có log',
    midBudget.length >= 1, JSON.stringify(midBudget.map((r) => r.dropped)));
}

console.log('\n6. §22 reserve — advisory ở step 1 không ăn hết hạn mức của recovery');

{
  const { planInjection } = await import(`${pathToFileURL(INJECTION_MODULE).href}?t=${Math.random()}`);
  const text = (n) => 'x'.repeat(n * 4);

  // Mô phỏng đúng trình tự thật: advisory ở step 1 giữ chỗ, rồi recovery ở
  // post-execute phải còn chỗ. Với trần 500, advisory chỉ được dùng ≤ 250.
  const advisory = planInjection([{ kind: 'advisory', text: text(400) }], 500, 250);
  check('6a advisory 400 token bị chặn ở mức reserve 250 → bị bỏ',
    advisory.kept.length === 0, `kept=${advisory.kept.length} used=${advisory.used}`);
  const advisorySmall = planInjection([{ kind: 'advisory', text: text(200) }], 500, 250);
  check('6b advisory 200 token ≤ reserve → được giữ',
    advisorySmall.kept.length === 1 && advisorySmall.used === 200, `used=${advisorySmall.used}`);
  const recovery = planInjection([{ kind: 'recovery', text: text(400) }], 500, 250);
  check('6c recovery KHÔNG bị reserve chặn (dùng trọn trần)',
    recovery.kept.length === 1 && recovery.used === 400, `used=${recovery.used}`);

  // 6d. Trình tự thật qua plugin: turn có advisory ở step 1 rồi tool lỗi.
  //     Với trần đủ chật, advisory phải nhường chỗ để recovery vẫn được chèn.
  const root = makeWorkspace({ 'src/auth.ts': "import { db } from './db';\nexport const login = db;\n" });
  const logDir = tmpDir('jev-gate-context-');
  const agent = {
    id: 'ctx-agent',
    session: { id: 'ctx-sess', header: { cwd: root }, snapshotEvents: () => [] },
  };
  const out = await withRawJev(
    (id) => {
      if (id === 'approach') return { choice: 'scripted-analysis' };
      if (id === 'recovery') return { choice: 'alternate' };
      return { noul: 0.9 };
    },
    async () => {
      const { handlers } = await loadPlugin({
        logDir,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true, enableFailureRecovery: true,
          maxPluginContextTokensPerTurn: 300,
        },
      });
      const pre = await runPreStep(handlers, agent, 'sửa hàm login trong auth', 4);
      const post = await handlers['tools/post-execute'][0](
        { name: 'bash', arguments: { command: 'npm run deploy' }, agent, signal: new AbortController().signal },
        { isError: true, content: [{ type: 'text', text: 'Error: ECONNREFUSED' }] },
        async () => ({ kind: 'accept' }),
      );
      return { pre, post };
    },
  );
  const postText = (out.post.additionalContexts ?? []).map((c) => c.content?.[0]?.text ?? '').join('\n');
  check('6d advisory step 1 không chặn recovery ở post-execute (cùng turn)',
    /alternate|change approach|The approach itself looks wrong/i.test(postText),
    postText.slice(0, 90));
}

console.log('\n7. §22 văn bản AN TOÀN đi đường riêng, không bị trần chạm tới');

{
  // Lớp 1 trả `{kind:'deny', reason}` — DSH hiển thị nguyên văn, KHÔNG qua
  // `admitContext`. Đây là dạng mạnh nhất của "không bao giờ bị cắt": trần chỉ
  // áp cho text CHÈN thêm, không áp cho lý do chặn.
  const { handlers } = await loadPlugin({
    logDir: tmpDir('jev-gate-context-'),
    config: {
      enableDestructiveGate: true, enableCompletionCheck: false, enableEffortRouting: false,
      maxPluginContextTokensPerTurn: 0,
    },
  });
  const out = await withRawJev(
    (id) => (id === 'destructive' ? { noul: 0.95 } : { noul: 0.5 }),
    async () => handlers['tools/pre-execute'][0](
      { name: 'bash', arguments: { command: 'rm -rf /tmp/customer-data' }, agent: { session: { snapshotEvents: () => [] } }, signal: new AbortController().signal },
      async () => ({ kind: 'accept' }),
    ),
  );
  check('7a trần 0 KHÔNG làm rơi lý do chặn của Lớp 1',
    out.kind === 'deny' && typeof out.reason === 'string' && out.reason.length > 40,
    `kind=${out.kind} len=${out.reason?.length}`);
  check('7b lý do chặn vẫn nói rõ vì sao (không rỗng/cụt)',
    /destructive|not run|did not run|hold|consent/i.test(out.reason ?? ''), out.reason?.slice(0, 80));
}

console.log('\n8. §22/§8 hồi quy — ở TRẦN MẶC ĐỊNH, bằng chứng file VẪN được chèn');

{
  /**
   * Lỗi thật đã bắt được (không test nào phủ): L4 approach và L5 file từng cùng
   * hạng `advisory`, nên ở trần mặc định 500 (nửa trần = 250 cho advisory) gợi ý
   * approach chèn trước thắng first-come, còn khối bằng chứng file (~171 token
   * cho MỘT file) bị đẩy ra ngoài. Đo thật: approach 84 + bằng chứng 171 = 255 >
   * 250. Kết quả: thứ đáng giá nhất của Lớp 5 biến mất đúng ở cấu hình mặc định.
   *
   * Bản sửa: khối bằng chứng mang hạng riêng `evidence` (> `advisory`) và
   * `truncatable`, nên nó được giữ (cắt ngắn nếu chật) thay vì bị bỏ.
   */
  const root = makeWorkspace({
    'src/auth/session.ts': [
      "import { verifyToken } from './token';",
      "import { db } from '../db';",
      'export async function refreshSession(token: string) {',
      '  // refresh token expired -> force re-login',
      "  if (isExpired(token)) throw new Error('refresh token expired');",
      '  return db.sessions.rotate(token);',
      '}',
      'export const SESSION_TTL = 3600;',
      '',
    ].join('\n'),
    'src/billing/invoice.ts': 'export const invoice = 1;\n',
    'README.md': '# docs\n',
  });

  const logDir = tmpDir('jev-gate-context-');
  const result = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: id === 'file_0' ? 0.93 : 0.05 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true,
          // KHÔNG đặt maxPluginContextTokensPerTurn → dùng đúng mặc định 500.
        },
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa bug refresh token expired trong src/auth/session.ts');
    },
  );

  const text = injectedText(result);
  check('8a trần MẶC ĐỊNH 500 → khối bằng chứng file VẪN được chèn',
    /src\/auth\/session\.ts/.test(text) && /imports:/.test(text),
    `${text.length} chars, có imports=${/imports:/.test(text)}`);
  check('8b bằng chứng thật (import ./token) có mặt, không chỉ tên file',
    /\.\/token/.test(text), text.split('\n').find((l) => /imports:/.test(l))?.slice(0, 90));
  check('8c câu miễn trừ §23 vẫn còn (đặt ở ĐẦU khối để không bị cắt mất)',
    /hint, not a restriction/i.test(text), '');

  /**
   * 8d. Ở trần mặc định, nửa trần dành cho hạng step-1 chỉ là 250 token, mà
   * bằng chứng MỘT file đã ~171 + approach ~84 = 255. Không thể vừa cả hai, và
   * thứ tự đúng là: BẰNG CHỨNG thắng, gợi ý approach chung nhường. Đây chính là
   * điều bản sửa muốn: trước kia first-come khiến approach thắng và bằng chứng
   * biến mất — đúng ngược. Nên khẳng định: có bằng chứng, và nếu approach bị bỏ
   * thì phải có log nói rõ.
   */
  const budgetRows = await rowsOf(logDir, 'context_budget', 1);
  const approachDropped = budgetRows.some((r) => (r.dropped ?? []).includes('advisory'));
  check('8d bằng chứng THẮNG gợi ý approach khi cả hai không vừa trần mặc định',
    /imports:/.test(text) && (!/scripted-analysis/.test(text) ? approachDropped : true),
    approachDropped ? 'approach bị bỏ (đúng ưu tiên evidence > advisory)' : 'cả hai vừa trần');

  // 8e. Mọi lần vượt trần đều phải để lại dấu vết: bỏ mảnh HOẶC cắt ngắn mảnh.
  check('8e mọi lần vượt trần đều có log (dropped hoặc truncated)',
    budgetRows.every((r) => (r.dropped ?? []).length > 0 || (r.truncated ?? []).length > 0),
    JSON.stringify(budgetRows.map((r) => ({ dropped: r.dropped, truncated: r.truncated }))));

  // 8f. Trần chật: bằng chứng bị CẮT NGẮN chứ KHÔNG bị bỏ hẳn.
  const tightLog = tmpDir('jev-gate-context-');
  const tight = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: id === 'file_0' ? 0.93 : 0.05 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: tightLog,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true,
          maxPluginContextTokensPerTurn: 180,
        },
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa bug refresh token expired trong src/auth/session.ts');
    },
  );
  const tightText = injectedText(tight);
  const tightRows = await rowsOf(tightLog, 'context_budget', 1);
  check('8f trần chật 180 → bằng chứng bị cắt ngắn nhưng KHÔNG bỏ hẳn',
    /src\/auth\/session\.ts/.test(tightText)
    && tightRows.some((r) => Array.isArray(r.truncated) && r.truncated.includes('evidence')),
    `${tightText.length} chars, rows=${JSON.stringify(tightRows.map((r) => ({ dropped: r.dropped, truncated: r.truncated })))}`);
  check('8g đoạn bị cắt vẫn mang dấu … để biết là đoạn cụt',
    tightText.includes('…') || tightText.length < text.length, `${tightText.length} vs ${text.length}`);
}

console.log('\n9. §22 semantic dedup — không chèn cùng một gợi ý hai lần trong một turn');

{
  const { dedupeInjection, fingerprintOf } = await import(`${pathToFileURL(INJECTION_MODULE).href}?t=${Math.random()}`);

  // 9a. Cùng nội dung, khác định dạng (khoảng trắng/hoa-thường) → coi là trùng.
  const seen = new Set();
  const first = dedupeInjection([{ kind: 'advisory', text: 'Read  src/auth.ts   first' }], seen);
  const second = dedupeInjection([{ kind: 'advisory', text: 'read src/auth.ts first' }], seen);
  check('9a advisory lặp lại (khác định dạng) bị dedup',
    first.deduped === 0 && second.deduped === 1 && second.fresh.length === 0,
    `first=${first.deduped} second=${second.deduped}`);

  // 9b. Nội dung KHÁC nhau thì cả hai đi qua.
  const seen2 = new Set();
  dedupeInjection([{ kind: 'advisory', text: 'hint A' }], seen2);
  const other = dedupeInjection([{ kind: 'advisory', text: 'hint B' }], seen2);
  check('9b advisory khác nội dung KHÔNG bị dedup',
    other.deduped === 0 && other.fresh.length === 1, `deduped=${other.deduped}`);

  // 9c. `recovery`/`completion` MIỄN dedup: chúng có trần riêng theo turn và
  //     việc nhắc lại ở step SAU là chủ ý (agent đã thêm message ở giữa).
  const seen3 = new Set();
  dedupeInjection([{ kind: 'recovery', text: 'same recovery text' }], seen3);
  const recoveryAgain = dedupeInjection([{ kind: 'recovery', text: 'same recovery text' }], seen3);
  const completionTwice = dedupeInjection([
    { kind: 'completion', text: 'same completion text' },
    { kind: 'completion', text: 'same completion text' },
  ], new Set());
  check('9c recovery KHÔNG bị dedup (có trần riêng failureMaxPerTurn)',
    recoveryAgain.deduped === 0 && recoveryAgain.fresh.length === 1, `deduped=${recoveryAgain.deduped}`);
  check('9d completion KHÔNG bị dedup (có trần riêng completionMaxPerTurn)',
    completionTwice.deduped === 0 && completionTwice.fresh.length === 2, `deduped=${completionTwice.deduped}`);

  // 9e. Hạng bảo vệ miễn dedup — thà lặp ràng buộc an toàn còn hơn im.
  const protectedTwice = dedupeInjection([
    { kind: 'safety', text: 'never run rm -rf /' },
    { kind: 'safety', text: 'never run rm -rf /' },
  ], new Set());
  check('9e safety KHÔNG bị dedup dù trùng hoàn toàn',
    protectedTwice.deduped === 0 && protectedTwice.fresh.length === 2, `deduped=${protectedTwice.deduped}`);

  // 9f. Vân tay rỗng (text rỗng) không bị coi là trùng nhau.
  const emptyTwice = dedupeInjection([
    { kind: 'advisory', text: '' }, { kind: 'advisory', text: '' },
  ], new Set());
  check('9f text rỗng không bị dedup oan',
    emptyTwice.deduped === 0 && emptyTwice.fresh.length === 2, `deduped=${emptyTwice.deduped}`);

  // 9g. `admitContext` (trong index.mjs) gọi đúng helper này và ghi log `deduped`
  //     khi mọi mảnh đều là trùng. Chứng minh đường dây bằng log thật: L4/L5 chèn
  //     một lần ở step 1, rồi gọi lại CÙNG turn — lần hai không chèn thêm gì.
  const root = makeWorkspace({ 'src/auth.ts': "import { db } from './db';\nexport const login = db;\n" });
  const logDir = tmpDir('jev-gate-context-');
  const agent = { id: 'dedup-agent', session: { id: 'dedup-sess', header: { cwd: root }, snapshotEvents: () => [] } };
  const twice = await withRawJev(
    () => ({ noul: 0.9, choice: 'scripted-analysis' }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir,
        config: {
          enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false,
          enableSpawnHint: true, enableContextTriage: true,
        },
      });
      const one = await runPreStep(handlers, agent, 'sửa hàm login trong auth', 7);
      const two = await runPreStep(handlers, agent, 'sửa hàm login trong auth', 7);
      return { one, two };
    },
  );
  const oneText = injectedText(twice.one);
  const twoText = injectedText(twice.two);
  check('9g gọi lại cùng turn → KHÔNG chèn thêm (khoá hintedTurns + dedup)',
    oneText.length > 0 && twoText.length === 0, `lần1=${oneText.length} lần2=${twoText.length}`);
}

console.log('\n────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log('CONTEXT: TẤT CẢ PASS');
} else {
  console.log(`CONTEXT: ${failed} MỤC HỎNG`);
}
process.exit(failed === 0 ? 0 : 1);
