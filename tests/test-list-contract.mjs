/**
 * §38 — Anti-drift: `package.json` (npm test), `verify.sh` và CI workflow phải
 * chạy CÙNG một tập suite. Trước đây ba danh sách được bảo trì thủ công nên một
 * suite mới thêm vào npm test có thể không bao giờ chạy trong verify.sh/CI (hoặc
 * ngược lại) — nghĩa là "xanh" ở một nơi mà đỏ ở nơi khác.
 *
 * Test này là NGUỒN SỰ THẬT duy nhất: nó đọc cả ba file và báo lệch tường minh.
 * Không mock. Offline.
 *
 * Ngoại lệ được PHÂN LOẠI TƯỜNG MINH (không im lặng bỏ qua): một suite chỉ chạy
 * được khi có host/credential thật thì phải nằm trong `ENVIRONMENT_DEPENDENT`.
 * Thêm suite mới vào verify.sh mà quên npm test ⇒ test này FAIL cho tới khi
 * người phát triển quyết định nó thuộc offline hay môi trường.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** Suite cần host/credential thật, không thể nằm trong `npm test` offline. */
const ENVIRONMENT_DEPENDENT = new Set([
  'tests/dsh-compat.mjs',       // cần DSH host đã cài
  'tests/live-check.mjs',       // cần DSH host + credential
  'tests/consent-integration.mjs', // cần DSH UserQuestionService
  'tests/live-smoke.mjs',       // cần TYPESAFE_API_KEY
]);

/** Trích mọi lời gọi `node <path>` (bỏ `node --check`). */
function suitesFrom(text) {
  const found = new Set();
  const re = /\bnode\s+(?:--check\s+)?(?:--\s+)?([A-Za-z0-9_./-]+\.mjs)/g;
  let match = re.exec(text);
  while (match) { found.add(match[1].replace(/^\.\//, '')); match = re.exec(text); }
  return found;
}

/** Trích danh sách trong `scripts.test` của package.json. */
function npmTestSuites() {
  const pkg = JSON.parse(read('package.json'));
  const found = new Set();
  for (const part of (pkg.scripts?.test ?? '').split('&&')) {
    const match = part.trim().match(/^node\s+([A-Za-z0-9_./-]+\.mjs)/);
    if (match) found.add(match[1].replace(/^\.\//, ''));
  }
  return found;
}

/** `verify.sh` tách hai danh sách: `--check` (syntax) và danh sách CHẠY. */
function verifyScriptSuites() {
  const text = read('verify.sh');
  const run = new Set();
  const syntax = new Set();
  // (a) Vòng `for f in ...; do` — phân loại theo ngữ cảnh sử dụng biến vòng lặp.
  //     Chỉ nhận block thực sự CHẠY hoặc CHECK từng file; block chỉ kiểm tồn tại
  //     (`[ -f "$PLUGIN/$f" ]`) không tính là suite.
  for (const block of text.split(/\n(?=for f in )/)) {
    const listMatch = block.match(/^for f in ([\s\S]*?); do/);
    if (!listMatch) continue;
    const files = listMatch[1].split(/\s+/).filter((entry) => entry.endsWith('.mjs'));
    if (/node\s+--check\s+"\$PLUGIN\/\$f"/.test(block)) {
      for (const file of files) syntax.add(file);
    } else if (/node\s+"\$PLUGIN\/\$f"/.test(block)) {
      for (const file of files) run.add(file);
    }
  }
  // (b) Lời gọi rời rạc, ví dụ `node "$PLUGIN/tools/trajectory-matrix.mjs" --self-test`.
  const standalone = /\bnode\s+"\$PLUGIN\/([A-Za-z0-9_./-]+\.mjs)"/g;
  let match = standalone.exec(text);
  while (match) {
    run.add(match[1]);
    match = standalone.exec(text);
  }
  return { run, syntax };
}

const npm = npmTestSuites();
const verify = verifyScriptSuites();
const ciText = read('.github/workflows/verify.yml');
const ci = suitesFrom(ciText);
// §38: CI có thể gọi MỘT lệnh canonical `npm test` thay vì liệt kê lại từng suite.
// Khi đó tập suite CI chạy chính là tập npm test, không cần lặp lại danh sách —
// đây là dạng mạnh hơn (không thể drift vì chỉ có một nguồn).
const ciRunsCanonicalNpmTest = /(^|\n)\s*run:\s*npm test\s*(\n|$)/.test(ciText);

assert(npm.size >= 30, `npm test phải chạy nhiều suite, chỉ thấy ${npm.size}`);

// 1. Mọi suite trong `npm test` phải được CHẠY trong verify.sh.
assert.deepEqual([...npm].filter((file) => !verify.run.has(file)), [],
  'suite có trong npm test nhưng KHÔNG chạy ở verify.sh');

// 2. Mọi suite trong `npm test` phải được chạy trong CI workflow — hoặc trực tiếp
//    liệt kê, hoặc qua lệnh canonical `npm test`.
assert.deepEqual(ciRunsCanonicalNpmTest ? [] : [...npm].filter((file) => !ci.has(file)), [],
  'suite có trong npm test nhưng KHÔNG chạy ở CI');

// 3. Mọi suite trong `npm test` phải qua `node --check` ở verify.sh.
assert.deepEqual([...npm].filter((file) => !verify.syntax.has(file)), [],
  'suite thiếu trong danh sách syntax-check của verify.sh');

// 4. Chiều ngược lại: mọi suite chạy ở verify.sh/CI mà không có trong npm test
//    phải được PHÂN LOẠI tường minh là phụ thuộc môi trường. Nếu không, một suite
//    mới được thêm rời rạc sẽ không bao giờ chạy trong `npm test` (canonical).
const unclassified = [
  ...[...verify.run].filter((file) => !npm.has(file) && !ENVIRONMENT_DEPENDENT.has(file)),
  ...[...ci].filter((file) => !npm.has(file) && !ENVIRONMENT_DEPENDENT.has(file)),
];
// Khi CI gọi `npm test`, mọi suite nó chạy gián tiếp đều nằm trong `npm` ⇒ không
// có suite nào "ngoài npm test" để phân loại ở nhánh CI.
assert.deepEqual(unclassified, [],
  `suite chạy ngoài npm test nhưng chưa phân loại (thêm vào npm test hoặc ENVIRONMENT_DEPENDENT): ${unclassified.join(', ')}`);

/** Công cụ/helper không phải suite chạy độc lập, đã phân loại tường minh. */
const NON_SUITE_MODULES = new Set([
  'tools/trajectory-fixture.mjs',      // helper test, được import bởi suite
  'tools/repair-session-source.mjs',   // tiện ích bảo trì chạy tay, không phải suite
]);

/** Mọi module được `import ... from '<rel>.mjs'` bởi file khác trong repo. */
function importedModules() {
  const imported = new Set();
  const files = [
    ...readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.mjs')).map((name) => `tests/${name}`),
    ...readdirSync(join(root, 'tools')).filter((name) => name.endsWith('.mjs')).map((name) => `tools/${name}`),
    ...readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`),
  ];
  for (const rel of files) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const re = /from\s+['"](\.[^'"]+\.mjs)['"]/g;
    let match = re.exec(read(rel));
    while (match) {
      const target = join(dir, match[1]);
      imported.add(target.startsWith('./') ? target.slice(2) : target);
      match = re.exec(read(rel));
    }
  }
  return imported;
}

// 5. Không file suite nào "mồ côi": mọi .mjs trong tests/ và tools/ phải được
//    nhắc tới ở ÍT NHẤT một danh sách, hoặc được import bởi file khác, hoặc được
//    phân loại tường minh là không-phải-suite. Nếu không, nó không bao giờ chạy.
const onDisk = [
  ...readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.mjs')).map((name) => `tests/${name}`),
  ...readdirSync(join(root, 'tools')).filter((name) => name.endsWith('.mjs')).map((name) => `tools/${name}`),
];
const imported = importedModules();
const known = new Set([...npm, ...verify.run, ...verify.syntax, ...ci, ...ENVIRONMENT_DEPENDENT, ...NON_SUITE_MODULES, ...imported]);
assert.deepEqual(onDisk.filter((file) => !known.has(file)), [],
  'file .mjs không được chạy/kiểm/import ở đâu');

console.log(`PASS test-list contract (${npm.size} offline suites, `
  + `npm test == verify.sh == CI${ciRunsCanonicalNpmTest ? ' (CI gọi canonical npm test)' : ''}, `
  + `${ENVIRONMENT_DEPENDENT.size} environment-dependent classified)`);
