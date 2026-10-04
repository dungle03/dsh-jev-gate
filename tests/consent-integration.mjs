/**
 * Kiểm chứng THẺ ĐỒNG Ý của Lớp 1b chạy qua `UserQuestionService` THẬT.
 *
 * Vì sao có file riêng (không nhét vào `offline.mjs`):
 *   `offline.mjs` phải chạy được trên CI Node 20/22 KHÔNG có DSH cài sẵn — nó
 *   dùng ctx giả và không import gói `@deepseek-ai/*` nào. File này import
 *   thẳng `dsh-user-questions` + `cordis` từ cài đặt DSH cục bộ, nên chỉ chạy
 *   trên máy có DSH. Thiếu DSH → bỏ qua (exit 0), không làm đỏ CI.
 *
 * Vì sao cần: stub trong `offline.mjs` KHÔNG chạy validation thật của service
 * (`BAD_INTENT` khi `intent.approve` không khớp option nào, hoặc khi thiếu
 * `detail`) và không đi qua đường hết hạn `askTimed` thật. Đây là chỗ chứng
 * minh câu hỏi của plugin THỰC SỰ hợp lệ với service, và `{pending:true}` thật
 * được parse thành CHẶN.
 *
 * Chạy: `node tests/consent-integration.mjs`
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_ROOT = join(
  process.env.DSH_ENGINE_ROOT
    ?? join(homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  'node_modules', '@deepseek-ai',
);
const CORDIS = join(DSH_ROOT, 'cordis', 'lib', 'index.js');
const USER_QUESTIONS = join(DSH_ROOT, 'dsh-user-questions', 'lib', 'index.js');

if (!existsSync(CORDIS) || !existsSync(USER_QUESTIONS)) {
  console.log(`CONSENT INTEGRATION: bỏ qua — không tìm thấy DSH tại ${DSH_ROOT}`);
  console.log('(đặt DSH_ENGINE_ROOT để trỏ tới node_modules/@deepseek-ai/dsh)');
  process.exit(0);
}

const { Context } = await import(CORDIS);
const { UserQuestionService, UserQuestionError } = await import(USER_QUESTIONS);

/* ── Trích NGUYÊN VĂN logic parse của `askDestructiveConsent` (lib/index.mjs).
 *    Nếu bạn sửa parse ở đó, sửa cả đây — đây là bản sao có chủ đích để test
 *    độc lập với plugin. ── */
const CONSENT_ID = 'jev-destructive-consent';
const CONSENT_APPROVE = 'Run it';
const CONSENT_REFUSE = 'Do not run it';
function parseAnswer(answer) {
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

/** Câu hỏi y hệt thẻ plugin dựng (xem `askDestructiveConsent`). */
function question(extra = {}) {
  return {
    id: CONSENT_ID,
    header: 'Destructive action',
    question: 'Allow this bash command to run?',
    detail: 'rm -rf /tmp/consent-target',
    options: [
      { label: CONSENT_APPROVE, description: 'Run the command exactly as shown.' },
      { label: CONSENT_REFUSE, description: 'Block it. The command will not run.' },
    ],
    intent: { kind: 'jev-destructive-consent', approve: CONSENT_APPROVE, callId: 'call-1' },
    ...extra,
  };
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/** Context cordis thật + service thật + một agent root thật. */
function build(replyFn) {
  const ctx = new Context();
  const agent = { id: 'agent-1', session: { id: 's1' }, inbox: { nextTurn: [], nextStep: [] } };
  ctx.provide('agents', {
    get: (id) => (id === 'agent-1' ? agent : undefined),
    roots: () => [agent],
  });
  ctx.on('user-questions/request', async () => replyFn());
  return { svc: new UserQuestionService(ctx), agent };
}

console.log('CONSENT INTEGRATION — câu hỏi đồng ý qua UserQuestionService THẬT');

// (1) Câu hỏi hợp lệ phải QUA được validation thật (không BAD_INTENT) và parse đúng.
{
  const { svc, agent } = build(() => ({ answers: [{ id: CONSENT_ID, selected: [CONSENT_APPROVE] }] }));
  let answer; let err;
  try { answer = await svc.ask({ questions: [question()], agent }); } catch (e) { err = e; }
  check('câu hỏi hợp lệ qua service thật (không BAD_INTENT)', err === undefined, err ? String(err.message) : '');
  check('parse(answer thật) = approved', parseAnswer(answer).decision === 'approved', JSON.stringify(answer));
}

// (2) `intent.approve` không khớp option nào → service ném BAD_INTENT (chứng minh
//     service thật SỰ kiểm, nên test (1) không phải pass rỗng).
{
  const { svc, agent } = build(() => ({ answers: [] }));
  let err;
  try { await svc.ask({ questions: [question({ intent: { kind: 'x', approve: 'Nope', callId: 'call-1' } })], agent }); }
  catch (e) { err = e; }
  check('approve label sai → BAD_INTENT', err instanceof UserQuestionError && err.code === 'BAD_INTENT', err ? err.code : 'no throw');
}

// (3) Thiếu `detail` → BAD_INTENT (intent bắt buộc có detail).
{
  const { svc, agent } = build(() => ({ answers: [] }));
  const q = question();
  delete q.detail;
  let err;
  try { await svc.ask({ questions: [q], agent }); } catch (e) { err = e; }
  check('thiếu detail → BAD_INTENT', err instanceof UserQuestionError && err.code === 'BAD_INTENT', err ? err.code : 'no throw');
}

// (4) Đồng ý kèm văn bản tự gõ → KHÔNG tính là đồng ý (đồng ý phải rõ ràng).
{
  const { svc, agent } = build(() => ({ answers: [{ id: CONSENT_ID, selected: [CONSENT_APPROVE], custom: 'đừng xoá' }] }));
  const answer = await svc.ask({ questions: [question()], agent });
  check('đồng ý + custom → refused', parseAnswer(answer).decision === 'refused', JSON.stringify(answer));
}

// (5) Chọn nhãn từ chối → refused.
{
  const { svc, agent } = build(() => ({ answers: [{ id: CONSENT_ID, selected: [CONSENT_REFUSE] }] }));
  const answer = await svc.ask({ questions: [question()], agent });
  check('chọn "Do not run it" → refused', parseAnswer(answer).decision === 'refused');
}

// (6) Đường HẾT HẠN thật: answerer mô phỏng client (chờ signal abort → ném
//     ASK_TIMED_OUT). `askTimed` phải trả `{pending:true}` và parse thành CHẶN.
{
  const ctx = new Context();
  const agent = { id: 'agent-1', session: { id: 's1' }, inbox: { nextTurn: [], nextStep: [] } };
  ctx.provide('agents', { get: (id) => (id === 'agent-1' ? agent : undefined), roots: () => [agent] });
  let sawWait = false;
  ctx.on('user-questions/request', (request) => new Promise((_resolve, reject) => {
    sawWait = request?.wait?.timed === true && request?.wait?.callId === 'call-1';
    request.signal.addEventListener('abort', () => {
      reject(new UserQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT'));
    }, { once: true });
  }));
  const svc = new UserQuestionService(ctx);
  const started = Date.now();
  const answer = await svc.askTimed({ questions: [question()], agent }, 'call-1', 300);
  const elapsed = Date.now() - started;
  check('answerer nhận wait.timed + callId đúng', sawWait);
  check('askTimed hết hạn → {pending:true, callId}', answer?.pending === true && answer?.callId === 'call-1', JSON.stringify(answer));
  check('parse(pending) → refused ASK_TIMED_OUT (CHẶN)', parseAnswer(answer).decision === 'refused' && parseAnswer(answer).reason === 'ASK_TIMED_OUT');
  // Ý định là "KHÔNG treo vô hạn", không phải đo chính xác đồng hồ: dưới tải CPU
  // nặng bộ đếm 300ms có thể trễ. Cận dưới giữ nguyên, cận trên nới rộng để máy
  // chậm không tạo FAIL giả (đã quan sát 1 lần flake khi chạy song song).
  check('kết thúc sau ~300ms (không treo vô hạn)', elapsed >= 250 && elapsed < 10000, `elapsed=${elapsed}ms`);
}

console.log('─'.repeat(56));
console.log(fail === 0 ? `CONSENT INTEGRATION: TẤT CẢ PASS (${pass} check)` : `CONSENT INTEGRATION: ${fail} MỤC HỎNG`);
process.exit(fail ? 1 : 0);
