/**
 * Kiểm chứng §8 — LỚP 5 DÙNG BẰNG CHỨNG FILE THẬT, KHÔNG ĐOÁN THEO TÊN.
 *
 * Chạy OFFLINE (không key, không mạng): plugin nạp với `logDir` tạm, Jev thay
 * bằng `fetch` giả trả lời theo id và GHI LẠI `bodies` để soi `state` gửi đi.
 *
 * Bất biến:
 *   1. Khi `enableContextTriage` bật, `state.candidate_evidence` mang đoạn trích
 *      THẬT (imports/exports/dòng khớp task) của từng file ứng viên.
 *   2. Câu hỏi `file_N` trỏ Jev vào đoạn trích đó, không bắt nó đoán theo tên.
 *   3. Gợi ý chèn cho agent chứa cả đường dẫn LẪN bằng chứng.
 *   4. File nhị phân / quá lớn / symlink thoát gốc / đường dẫn `..` bị BỎ QUA —
 *      không đọc, không ném, không rò nội dung ngoài workspace.
 *   5. `enableContextTriage:false` → không đọc file nào (0 I/O bằng chứng).
 *   6. `contextEvidence:false` → quay về hành vi theo tên (A/B).
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'lib', 'index.mjs');
const EVIDENCE_MODULE = join(HERE, '..', 'lib', 'evidence.mjs');

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

/** Ghi một workspace thật với nội dung cho trước (khác `offline.mjs` ở chỗ này). */
const makeWorkspace = (files) => {
  const root = tmpDir('jev-gate-evidence-');
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

/** `fetch` giả: trả lời theo id, ghi lại `bodies` để soi state. */
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
      const probabilities = spec.probabilities
        ?? Object.fromEntries(keys.map((key) => [key, key === choice ? 0.8 : 0.2 / Math.max(1, keys.length - 1)]));
      return [id, { type: 'choice', choice, confidence: spec.confidence ?? 0.9, probabilities }];
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

const runPreStep = (handlers, agent, task, turn = 1) => {
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] }];
  return handlers['agent/pre-step'][0](
    { messages, turn, step: 1, signal: new AbortController().signal, agent },
    // `next()` phải trả lại `messages` đã vào, đúng như DSH thật: plugin chèn
    // thêm vào CUỐI, nên mảnh chèn nằm ở `slice(1)`.
    async () => ({ kind: 'enter', messages }),
  );
};

const injectedText = (result) => (result.messages ?? []).slice(1)
  .map((m) => m.content?.[0]?.text ?? '').join('\n');

const BASE_CONFIG = {
  enableDestructiveGate: false,
  enableCompletionCheck: false,
  enableEffortRouting: false,
  enableSpawnHint: false,
  enableContextTriage: true,
};

console.log('1. §8 Stage 2 — trích bằng chứng THẬT từ file (imports/exports/dòng khớp task)');

{
  const root = makeWorkspace({
    'src/session.ts': [
      "import { sign } from './jwt';",
      "import { redis } from '../infra/redis';",
      'export function createSession(user) { return sign(user); }',
      'export function validateToken(token) {',
      '  // refresh token expired → must reissue',
      '  return redis.get(token);',
      '}',
      '',
    ].join('\n'),
    'src/unrelated.ts': 'export const nothing = 1;\n',
  });

  const { readFileEvidence, formatEvidence } = await import(`${pathToFileURL(EVIDENCE_MODULE).href}?t=${Math.random()}`);

  const entry = await readFileEvidence(root, 'src/session.ts', ['token', 'session', 'expired']);
  check('1a trích được entry cho file thật', !!entry, `entry=${entry ? 'ok' : 'null'}`);
  check('1b ghi lại kích thước file', entry?.bytes > 0, `bytes=${entry?.bytes}`);
  check('1c có dòng import thật', (entry?.imports ?? []).some((l) => l.includes("from './jwt'")),
    `imports=${JSON.stringify(entry?.imports)}`);
  check('1d có dòng export thật', (entry?.exports ?? []).some((l) => l.includes('createSession')),
    `exports=${JSON.stringify(entry?.exports)}`);
  check('1e có dòng khớp token của task', (entry?.matches ?? []).some((m) => /expired/.test(m.text)),
    `matches=${JSON.stringify(entry?.matches)}`);
  check('1f match mang số dòng', Number.isSafeInteger(entry?.matches?.[0]?.line),
    `line=${entry?.matches?.[0]?.line}`);

  const block = formatEvidence(entry);
  check('1g formatEvidence in ra imports/exports/matching line',
    /imports:/.test(block) && /exports:/.test(block) && /matching line/.test(block),
    block.split('\n')[0]);
}

console.log('\n2. §8 Stage 3 — state gửi Jev mang candidate_evidence, câu hỏi trỏ vào đoạn trích');

{
  const root = makeWorkspace({
    'src/auth.ts': "import { db } from './db';\nexport function login(u) { return db.find(u); }\n",
    'README.md': '# docs\nnothing to do with code\n',
  });

  const bodies = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async (seen) => {
      const { handlers } = await loadPlugin({
        logDir: tmpDir('jev-gate-evidence-'),
        config: { ...BASE_CONFIG, enableSpawnHint: true },
      });
      await runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa bug login trong auth');
      return seen;
    },
  );

  const state = bodies[0]?.state ?? {};
  check('2a state có khoá candidate_evidence', !!state.candidate_evidence,
    `keys=${Object.keys(state).join(',')}`);
  const authEvidence = state.candidate_evidence?.['src/auth.ts'];
  check('2b bằng chứng của src/auth.ts là chuỗi nhiều dòng', typeof authEvidence === 'string' && authEvidence.includes('\n'),
    JSON.stringify(authEvidence)?.slice(0, 60));
  check('2c bằng chứng chứa import thật', /import/.test(authEvidence ?? ''), authEvidence?.split('\n')[0]);
  check('2d note nói rõ đoạn trích là một phần, không phải toàn bộ file',
    /partial view/.test(state.note ?? ''), state.note);
  const authQuestion = bodies[0]?.questions?.file_0?.instructions ?? '';
  const fileIds = Object.keys(bodies[0]?.questions ?? {}).filter((id) => id.startsWith('file_'));
  const withPointer = fileIds.filter((id) => /candidate_evidence/.test(bodies[0].questions[id].instructions));
  check('2e câu hỏi file_N trỏ vào candidate_evidence (không đoán theo tên)', withPointer.length > 0,
    `pointers=${withPointer.length}/${fileIds.length}`);
  check('2f câu hỏi file_N vẫn là noul', bodies[0]?.questions?.file_0?.type === 'noul',
    `type=${bodies[0]?.questions?.file_0?.type}`);
  void authQuestion;
}

console.log('\n3. §8 Stage 4 — chèn ĐƯỜNG DẪN + BẰNG CHỨNG cho agent, không chỉ tên');

{
  const root = makeWorkspace({
    'src/auth.ts': "import { db } from './db';\nexport function login(u) { return db.find(u); }\n",
    'src/other.ts': 'export const x = 1;\n',
  });

  const result = await withRawJev(
    (id) => (id === 'file_0' ? { noul: 0.9 } : { noul: 0.1 }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: tmpDir('jev-gate-evidence-'),
        config: BASE_CONFIG,
      });
      return runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa hàm login trong auth');
    },
  );

  const text = injectedText(result);
  check('3a nêu tên file được chọn', /src\/auth\.ts/.test(text), text.slice(0, 60));
  check('3b KÈM đoạn bằng chứng (import thật), không chỉ tên', /imports:/.test(text) && /\.\/db/.test(text),
    text.split('\n').slice(0, 4).join(' / '));
  check('3c còn giữ escape clause "hint, not a restriction"', /hint, not a restriction/.test(text), '');
  check('3d message mang source plugin:jev-gate',
    result.messages.slice(1).every((m) => m.source?.kind === 'plugin:jev-gate'), '');
  check('3e file dưới ngưỡng không bị nêu', !/src\/other\.ts/.test(text), '');
}

console.log('\n4. §8 an toàn — nhị phân / quá lớn / symlink thoát gốc / `..` đều bị BỎ QUA');

{
  const root = makeWorkspace({
    'src/ok.ts': 'export const ok = 1;\n',
    'src/big.ts': 'x'.repeat(300_000),
    'src/secret-outside.txt': 'not read\n',
  });
  writeFileSync(join(root, 'src/binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  const outside = tmpDir('jev-gate-outside-');
  writeFileSync(join(outside, 'target.ts'), 'export const leaked = 1;\n');
  try { symlinkSync(join(outside, 'target.ts'), join(root, 'src/link.ts')); } catch { /* fs có thể chặn */ }

  const { readFileEvidence } = await import(`${pathToFileURL(EVIDENCE_MODULE).href}?t=${Math.random()}`);

  check('4a file thường đọc được', !!(await readFileEvidence(root, 'src/ok.ts', [])), '');
  check('4a1 file nhỏ vẫn đọc đúng khi trần 24 bytes',
    (await readFileEvidence(root, 'src/ok.ts', [], { maxBytes: 24 }))?.path === 'src/ok.ts', '');
  check('4b file nhị phân (có NUL) bị bỏ qua', (await readFileEvidence(root, 'src/binary.bin', [])) === null, '');
  check('4c file quá lớn (>256KiB) bị bỏ qua', (await readFileEvidence(root, 'src/big.ts', [])) === null, '');
  check('4d symlink thoát gốc bị bỏ qua', (await readFileEvidence(root, 'src/link.ts', [])) === null, '');
  check('4e đường dẫn `..` bị bỏ qua', (await readFileEvidence(root, '../outside/target.ts', [])) === null, '');
  check('4f đường dẫn tuyệt đối bị bỏ qua', (await readFileEvidence(root, '/etc/passwd', [])) === null, '');
  check('4g file không tồn tại → null (không ném)', (await readFileEvidence(root, 'src/nope.ts', [])) === null, '');
}

console.log('\n5. §8 tương thích — tắt/bật cờ điều khiển đúng đường');

{
  const root = makeWorkspace({ 'src/auth.ts': "import { db } from './db';\nexport const login = db;\n" });

  // 5a. enableContextTriage:false → không có candidate_evidence nào được gửi.
  const offBodies = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async (seen) => {
      const { handlers } = await loadPlugin({
        logDir: tmpDir('jev-gate-evidence-'),
        config: { ...BASE_CONFIG, enableContextTriage: false, enableSpawnHint: true },
      });
      await runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa bug login');
      return seen;
    },
  );
  check('5a enableContextTriage:false → KHÔNG gửi candidate_evidence',
    !offBodies[0]?.state?.candidate_evidence, `keys=${Object.keys(offBodies[0]?.state ?? {}).join(',')}`);

  // 5b. contextEvidence:false → ứng viên vẫn được hỏi, nhưng KHÔNG kèm đoạn trích.
  const noEvBodies = await withRawJev(
    (id) => (id === 'approach' ? { choice: 'scripted-analysis' } : { noul: 0.9 }),
    async (seen) => {
      const { handlers } = await loadPlugin({
        logDir: tmpDir('jev-gate-evidence-'),
        config: { ...BASE_CONFIG, contextEvidence: false, enableSpawnHint: true },
      });
      await runPreStep(handlers, { session: { header: { cwd: root } } }, 'sửa bug login');
      return seen;
    },
  );
  const state = noEvBodies[0]?.state ?? {};
  check('5b contextEvidence:false → vẫn hỏi file nhưng không kèm đoạn trích',
    (state.candidate_files ?? []).length > 0 && !state.candidate_evidence,
    `files=${(state.candidate_files ?? []).length} evidence=${state.candidate_evidence ? 'yes' : 'no'}`);

  // 5c. Không có file trích được → gợi ý ghi rõ là "name-only hint".
  const onlyBinary = makeWorkspace({ 'src/blob.bin': 'x' });
  writeFileSync(join(onlyBinary, 'src/blob.bin'), Buffer.from([0, 1, 2, 0]));
  const nameOnly = await withRawJev(
    (id) => (id.startsWith('file_') ? { noul: 0.9 } : { choice: 'scripted-analysis' }),
    async () => {
      const { handlers } = await loadPlugin({
        logDir: tmpDir('jev-gate-evidence-'),
        config: BASE_CONFIG,
      });
      return runPreStep(handlers, { session: { header: { cwd: onlyBinary } } }, 'xem blob');
    },
  );
  const text = injectedText(nameOnly);
  check('5c không trích được file → nói rõ là name-only hint',
    !/blob\.bin/.test(text) || /name-only/.test(text), text.slice(0, 80));
}

console.log('\n────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log('EVIDENCE: TẤT CẢ PASS');
} else {
  console.log(`EVIDENCE: ${failed} MỤC HỎNG`);
}
process.exit(failed === 0 ? 0 : 1);
