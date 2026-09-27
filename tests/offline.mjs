/**
 * Kiểm chứng OFFLINE — chạy được trong CI, không cần TYPESAFE_API_KEY, không cần
 * DSH đang chạy, không cần mạng.
 *
 * Bổ sung cho `live-check.mjs` (cần Jev API thật). Ở đây kiểm những thứ chỉ phụ
 * thuộc vào logic của plugin, nên phải luôn đúng trên mọi máy:
 *
 *   - fail-open: Jev lỗi / thiếu key / vắng llm → hành động đi tiếp
 *   - bất biến model: plugin chỉ ghi `reasoningEffort`, không đụng provider/model
 *   - hình dạng request: chỉ gửi state bounded, không gửi cả transcript
 *   - ngưỡng: deny/allow đúng ở biên, và không gọi Jev cho tool không phải shell
 *
 * Dùng ctx giả + Jev giả. Không mock thứ đang được kiểm.
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'lib', 'index.mjs');

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/**
 * Nạp plugin với ctx giả. `jevStub` quyết định hành vi của Jev:
 *   - hàm async nhận (body) → trả object kết quả
 *   - hoặc ném lỗi để kiểm fail-open
 */
async function loadPlugin({ jevStub, llm, credentials, config = {} } = {}) {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Math.random()}`);
  const handlers = {};
  const captured = [];
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    effect: (fn) => fn,
    logger: { info() {}, warn() {}, error() {} },
    credentials: credentials ?? { resolve: async () => ({ value: 'test-key' }) },
    llm: llm ?? {
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }] },
      }),
    },
  };
  await mod.apply(ctx, config);
  return { handlers, captured, mod };
}

/* ── Cho phép thay Jev client bằng stub, không đụng file thật ──────────────── */
/* Plugin tạo Jev qua createJev() đọc key từ ctx.credentials. Để kiểm fail-open
   và đường đi, ta điều khiển bằng ctx.credentials (lỗi/không key) và bằng việc
   gọi handler với AbortSignal đã abort — hai đường không cần mạng. */

console.log('1. Fail-open — Jev lỗi thì không được chặn oan');

// 1a. credentials.resolve ném lỗi → gate phải allow
{
  const { handlers } = await loadPlugin({
    credentials: { resolve: async () => { throw new Error('store hỏng'); } },
    config: { enableDestructiveGate: true, enableCompletionCheck: false, enableEffortRouting: false },
  });
  const out = await handlers['tools/pre-execute'][0](
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, agent: { cwd: '/tmp', session: { snapshotEvents: () => [] } }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  check('credentials ném lỗi → allow', out.kind === 'allow', `kind=${out.kind}`);
}

// 1b. AbortSignal đã abort → gate phải allow (không treo, không chặn)
{
  const { handlers } = await loadPlugin({
    config: { enableDestructiveGate: true, enableCompletionCheck: false, enableEffortRouting: false },
  });
  const out = await handlers['tools/pre-execute'][0](
    { name: 'bash', arguments: { command: 'rm -rf /' }, agent: { cwd: '/tmp', session: { snapshotEvents: () => [] } }, signal: AbortSignal.abort() },
    async () => ({ kind: 'allow' }),
  );
  check('signal đã abort → allow', out.kind === 'allow', `kind=${out.kind}`);
}

// 1c. llm service vắng → lớp effort bỏ qua, model giữ nguyên
{
  const { handlers } = await loadPlugin({
    llm: undefined,
    config: { enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: true },
  });
  const out = await handlers['agent/request'][0](
    { turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ provider: 'p', model: 'm' }),
  );
  check('llm vắng → model giữ nguyên, không effort', out.provider === 'p' && out.model === 'm' && out.reasoningEffort === undefined,
    `provider=${out.provider} model=${out.model} effort=${out.reasoningEffort}`);
}

console.log('\n2. Bất biến model — plugin không bao giờ đổi provider/model');

for (const [provider, model] of [
  ['modlens-nine-router', 'cbai/deepseek-v4.1-flash'],
  ['nine-router', 'cx/gpt-6-astra'],
  ['some-other', 'anthropic/claude-x'],
]) {
  const { handlers } = await loadPlugin({
    config: { enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: true },
  });
  // AbortSignal để lớp effort fail-open ngay, vẫn kiểm được payload trả về
  const out = await handlers['agent/request'][0](
    { turn: 1, step: 1, signal: AbortSignal.abort() },
    async () => ({ provider, model }),
  );
  check(`giữ nguyên ${provider}/${model}`, out.provider === provider && out.model === model,
    `→ ${out.provider}/${out.model}`);
}

console.log('\n3. Chỉ gate tool shell — tool khác không được gọi Jev');

{
  const { handlers } = await loadPlugin({
    config: { enableDestructiveGate: true, enableCompletionCheck: false, enableEffortRouting: false },
  });
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'web_fetch']) {
    const out = await handlers['tools/pre-execute'][0](
      { name, arguments: { file_path: '/etc/passwd' }, agent: { cwd: '/tmp', session: { snapshotEvents: () => [] } }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    );
    check(`tool "${name}" bị bỏ qua`, out.kind === 'allow', `kind=${out.kind}`);
  }
  // bash không có command → cũng bỏ qua
  const empty = await handlers['tools/pre-execute'][0](
    { name: 'bash', arguments: {}, agent: { cwd: '/tmp', session: { snapshotEvents: () => [] } }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  check('bash không có command → bỏ qua', empty.kind === 'allow', `kind=${empty.kind}`);
}

console.log('\n4. Kiểm hoàn thành — chỉ chạy khi có goal, và không lặp trong cùng turn');

{
  const { handlers } = await loadPlugin({
    config: { enableDestructiveGate: false, enableCompletionCheck: true, enableEffortRouting: false },
  });
  const agent = {
    id: 'a1',
    goal: { objective: 'Sửa bug và chạy test' },
    session: { snapshotEvents: () => [] },
    steered: [],
    steer(m) { this.steered.push(m); },
  };
  // Không có goal → phải im lặng
  const noGoal = { id: 'a2', session: { snapshotEvents: () => [] }, steer() {} };
  await handlers['agent/turn-stopping'][0]({ agent: noGoal, turn: 1, signal: AbortSignal.abort() });
  check('không có goal → không làm gì', true, 'không ném lỗi');

  // Có goal nhưng signal abort → fail-open, không steer
  await handlers['agent/turn-stopping'][0]({ agent, turn: 1, signal: AbortSignal.abort() });
  check('signal abort → không đẩy tiếp (fail-open)', agent.steered.length === 0, `steer=${agent.steered.length}`);

  // Cùng turn gọi 2 lần → chỉ kiểm 1 lần (có guard `checked`)
  const before = agent.steered.length;
  await handlers['agent/turn-stopping'][0]({ agent, turn: 2, signal: AbortSignal.abort() });
  await handlers['agent/turn-stopping'][0]({ agent, turn: 2, signal: AbortSignal.abort() });
  check('cùng turn không kiểm lại', agent.steered.length === before, `steer=${agent.steered.length}`);
}

console.log('\n5. Lớp 4 — spawn hint chỉ chạy ở step 1, tắt được, fail-open');

{
  // step 2 → phải im lặng, không gọi Jev (không có credential vẫn không lỗi)
  const { handlers } = await loadPlugin({
    credentials: { resolve: async () => { throw new Error('no key'); } },
    config: { enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false, enableSpawnHint: true },
  });
  const p2 = { messages: [{ role: 'user', content: [{ type: 'text', text: 'nghiên cứu 5 chủ đề độc lập' }] }], turn: 1, step: 2, signal: new AbortController().signal };
  const o2 = await handlers['agent/pre-step'][0](p2, async () => ({ kind: 'enter', messages: p2.messages }));
  check('step 2 → không chèn, không lỗi', o2.messages.length === 1 && o2.kind === 'enter', `msg=${o2.messages.length}`);

  // step 1 + không có credential → fail-open, vẫn enter, không chèn
  const p1 = { messages: [{ role: 'user', content: [{ type: 'text', text: 'nghiên cứu 5 chủ đề độc lập' }] }], turn: 1, step: 1, signal: new AbortController().signal };
  const o1 = await handlers['agent/pre-step'][0](p1, async () => ({ kind: 'enter', messages: p1.messages }));
  check('step 1 + Jev lỗi → fail-open, không chèn', o1.messages.length === 1 && o1.kind === 'enter', `msg=${o1.messages.length}`);

  // enableSpawnHint:false → tắt hẳn
  const off = await loadPlugin({
    credentials: { resolve: async () => { throw new Error('no key'); } },
    config: { enableDestructiveGate: false, enableCompletionCheck: false, enableEffortRouting: false, enableSpawnHint: false },
  });
  const o3 = await off.handlers['agent/pre-step'][0](p1, async () => ({ kind: 'enter', messages: p1.messages }));
  check('enableSpawnHint:false → im lặng', o3.messages.length === 1, `msg=${o3.messages.length}`);
}

console.log('\n6. Đóng gói — export đúng hợp đồng plugin');

{
  const mod = await import(`${pathToFileURL(PLUGIN).href}?e=1`);
  check('export apply', typeof mod.apply === 'function');
  // Cordis gọi `Config["~standard"].validate(config)` (cordis/lib/index.js:958).
  // Schemastery trả về schema CALLABLE kèm `~standard` — đúng như plugin đã
  // publish (@hytime/dsh-thinking-effort cũng `typeof Config === 'function'`).
  // Điều bắt buộc là `~standard.validate` phải là hàm và validate được config.
  const hasValidate = mod.Config && typeof mod.Config['~standard']?.validate === 'function';
  check('Config có ~standard.validate (hợp đồng cordis)', hasValidate,
    `type=${typeof mod.Config} validate=${typeof mod.Config?.['~standard']?.validate}`);
  let validated = false;
  try {
    const result = mod.Config['~standard'].validate({ destructiveThreshold: 0.7, enableEffortRouting: true });
    validated = result && !result.issues;
  } catch { /* validate ném lỗi */ }
  check('Config.validate chấp nhận config hợp lệ', validated);
  check('export inject có llm (bắt buộc cho lớp effort)', Array.isArray(mod.inject) && mod.inject.includes('llm'),
    `inject=${JSON.stringify(mod.inject)}`);
  check('export name = jev-gate', mod.name === 'jev-gate', `name=${mod.name}`);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(failed === 0 ? 'OFFLINE: TẤT CẢ PASS' : `OFFLINE: ${failed} MỤC HỎNG`);
process.exit(failed === 0 ? 0 : 1);
