/**
 * Hợp đồng OFFLINE cho CATALOG task + BIÊN GIỚI sandbox — chạy hàm THẬT.
 *
 * Vì sao cần file riêng (ngoài `trajectory-tasks.mjs`): file kia kiểm từng
 * evaluator bằng event dựng tay; file này kiểm hai thứ mang tính HỆ THỐNG:
 *
 *   1. §20 — mọi task trong catalog phải qua `assertTaskContract`, và một task
 *      hỏng phải NỔ NGAY lúc nạp, TRƯỚC mọi lời gọi model/Jev (fail-closed rẻ
 *      tiền). Task safety còn phải khai đủ ground truth `false_allow`+`false_deny`.
 *   2. §18/§19 — biên giới sandbox của task destructive: `resolveWithinRoot` phải
 *      chặn `../outside`, path tuyệt đối ngoài root, symlink → ngoài, symlink LỒNG
 *      nhau, kể cả symlink HỎNG. Và fixture destructive chỉ nằm trong temp root
 *      DUY NHẤT, không bao giờ trỏ tới path hệ thống thật.
 *
 * Không mạng, không model, không mock code đang kiểm — chỉ hàm thật + fs thật.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { assertCatalogContract, assertTaskContract, fixtureHash, resolveWithinRoot, TASKS, taskById }
  from '../tools/trajectory-tasks.mjs';
import { CAPABILITY_SPECS, MEASUREMENT_AXES, SAFETY_KEYS, TASK_CLASSES }
  from '../tools/trajectory-schema.mjs';

// Các path TUYỆT ĐỐI không bao giờ được là đích của fixture destructive. Nếu một
// task trỏ tới đây, benchmark có thể xoá file thật của người dùng.
const FORBIDDEN_ROOTS = ['/home', '/etc', '/usr', '/var', '/root', '/bin', '/sbin'];
const CAPABILITY_NAMES = new Set(CAPABILITY_SPECS.map((spec) => spec.name));
const REQUIRED_FIELDS = ['id', 'task_class', 'prompt', 'permission_mode', 'fixture',
  'measurement_axes', 'expected_side_effects', 'expected_capabilities_to_exercise', 'evaluator_version'];

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; };
// Evaluator là `async` ⇒ cần biến thể await được, nếu không lỗi trong promise sẽ
// không bao giờ nổi lên và test "xanh" một cách giả tạo.
const checkAsync = async (label, fn) => { await fn(); checks += 1; };
const isInside = (root, target) => {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(prefix);
};

const sandbox = mkdtempSync(join(tmpdir(), 'jev-task-contract-'));
const outside = mkdtempSync(join(sandbox, 'outside-'));
writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
mkdirSync(join(outside, 'nested'), { recursive: true });
writeFileSync(join(outside, 'nested', 'deep.txt'), 'DEEP\n');

try {
  // ============================================================ §20 hợp đồng
  check('catalog thật (mọi task) phải qua assertTaskContract', () => {
    assert.equal(TASKS.length, 7, 'catalog phải có đúng 7 task');
    for (const task of TASKS) assert.equal(assertTaskContract(task), true, `${task.id}: hợp lệ`);
  });
  check('assertCatalogContract chấp nhận catalog thật', () => {
    assert.equal(assertCatalogContract(TASKS), TASKS, 'trả lại chính mảng để nối tiếp');
  });
  check('mọi task có ĐỦ trường bắt buộc', () => {
    for (const task of TASKS) {
      for (const field of REQUIRED_FIELDS) {
        assert.notEqual(task[field], undefined, `${task.id}: thiếu ${field}`);
      }
      assert(typeof task.id === 'string' && task.id.length > 0, `${task.id}: id non-empty`);
      assert(TASK_CLASSES.includes(task.task_class), `${task.id}: task_class ∈ TASK_CLASSES`);
      assert(typeof task.prompt === 'string' && task.prompt.length > 0, `${task.id}: prompt non-empty`);
      assert(typeof task.permission_mode === 'string' && task.permission_mode.length > 0,
        `${task.id}: permission_mode non-empty`);
      assert(task.fixture && typeof task.fixture === 'object' && !Array.isArray(task.fixture),
        `${task.id}: fixture là object`);
      assert(Array.isArray(task.expected_side_effects), `${task.id}: expected_side_effects array`);
      assert(Number.isInteger(task.evaluator_version), `${task.id}: evaluator_version integer`);
      assert.equal(typeof task.evaluate, 'function', `${task.id}: evaluate function`);
      for (const axis of MEASUREMENT_AXES) {
        assert.equal(typeof task.measurement_axes[axis], 'boolean', `${task.id}: axes.${axis} boolean`);
      }
      for (const name of task.expected_capabilities_to_exercise) {
        assert(CAPABILITY_NAMES.has(name), `${task.id}: capability lạ ${name}`);
      }
    }
  });
  check('id duy nhất trên toàn catalog', () => {
    const ids = TASKS.map((task) => task.id);
    assert.equal(new Set(ids).size, ids.length, 'id phải duy nhất');
  });
  check('fixture hash ổn định giữa hai lần gọi', () => {
    for (const task of TASKS) assert.equal(fixtureHash(task), fixtureHash(task), `${task.id}: hash ổn định`);
  });

  // --- task hỏng phải NỔ (nổ lúc nạp ⇒ chặn trước khi spawn model tốn tiền) ---
  const valid = taskById('routine-copy-v1');
  check('thiếu từng trường bắt buộc ⇒ ném', () => {
    const cases = [
      [{ id: '' }, /id/],
      [{ task_class: 'không-có-lớp-này' }, /task_class/],
      [{ task_class: undefined }, /task_class/],
      [{ prompt: '' }, /prompt/],
      [{ permission_mode: '' }, /permission_mode/],
      [{ fixture: undefined }, /fixture/],
      [{ fixture: [] }, /fixture/],
      [{ measurement_axes: undefined }, /measurement_axes/],
      [{ measurement_axes: { quality: true, performance: true } }, /safety/],
      [{ measurement_axes: { quality: 1, performance: true, safety: false } }, /quality/],
      [{ expected_side_effects: undefined }, /expected_side_effects/],
      [{ expected_capabilities_to_exercise: undefined }, /expected_capabilities_to_exercise/],
      [{ expected_capabilities_to_exercise: ['không_tồn_tại'] }, /capability/],
      [{ evaluator_version: undefined }, /evaluator_version/],
      [{ evaluator_version: 1.5 }, /evaluator_version/],
      [{ evaluator_version: '2' }, /evaluator_version/],
      [{ evaluate: undefined }, /evaluate/],
    ];
    for (const [patch, pattern] of cases) {
      assert.throws(() => assertTaskContract({ ...valid, ...patch }), pattern,
        `phải ném với ${JSON.stringify(Object.keys(patch))}`);
    }
    assert.throws(() => assertTaskContract(null), /object/);
  });
  check('task safety thiếu ground truth an toàn ⇒ ném', () => {
    const safetyTask = TASKS.find((task) => task.measurement_axes.safety === true);
    assert(safetyTask, 'phải có ít nhất một task safety');
    assert.throws(() => assertTaskContract({ ...safetyTask, safety_keys: undefined }), /safety_keys/);
    assert.throws(() => assertTaskContract({ ...safetyTask, safety_keys: ['false_allow'] }), /safety_keys/);
    assert.doesNotThrow(() => assertTaskContract({ ...safetyTask, safety_keys: [...SAFETY_KEYS] }));
  });
  check('id trùng ⇒ assertCatalogContract ném', () => {
    assert.throws(() => assertCatalogContract([valid, { ...valid }]), /duplicate task id/);
    assert.throws(() => assertCatalogContract('nope'), /array/);
  });
  // §4: BẤT KỲ task destructive nào cũng phải BÁO CÁO `destructive_consent` khi kênh
  // THẬT SỰ phục vụ (allow_consented / từ chối thật) — không chỉ task delete. Đây là
  // bằng chứng per-capability do EVALUATOR cung cấp, không suy từ declaration.
  for (const task of TASKS.filter((entry) => entry.task_class === 'destructive-intent-safety')) {
    await checkAsync(`${task.id}: báo destructive_consent khi kênh phục vụ, bỏ khi timeout`, async () => {
      const workspace = mkdtempSync(join(tmpdir(), `jev-${task.id}-consent-`));
      task.setup(workspace);
      const gateRow = (decision, extra = {}) => ([{ type: 'destructive_gate', tool: 'bash', decision, ...extra }]);
      const consented = await task.evaluate({ workspace, events: [], exitCode: 0,
        decisions: gateRow('allow_consented') });
      assert.equal(consented.exercised_capabilities.destructive_gate, true, `${task.id}: gate chạy`);
      assert.equal(consented.exercised_capabilities.destructive_consent, true,
        `${task.id}: kênh consent phục vụ thật ⇒ phải báo cáo`);
      const timedOut = await task.evaluate({ workspace, events: [], exitCode: 0,
        decisions: gateRow('deny_consent', { consent: 'refused', consent_reason: 'ASK_TIMED_OUT' }) });
      assert.equal(timedOut.exercised_capabilities.destructive_consent, undefined,
        `${task.id}: ASK_TIMED_OUT ⇒ bỏ khoá (absence = unknown)`);
      rmSync(workspace, { recursive: true, force: true });
    });
  }
  check('task safety khai đủ safety_keys; task thường không khai', () => {
    const safety = TASKS.filter((task) => task.measurement_axes.safety === true);
    assert.equal(safety.length, 2, 'đúng 2 task safety');
    for (const task of safety) {
      assert.deepEqual([...task.safety_keys].sort(), [...SAFETY_KEYS].sort(), `${task.id}: đủ hai vế`);
    }
    for (const task of TASKS.filter((entry) => entry.measurement_axes.safety === false)) {
      assert.equal(task.safety_keys, undefined, `${task.id}: không khai safety_keys`);
    }
  });

  // ==================================================== §18/§19 biên giới sandbox
  const root = mkdtempSync(join(sandbox, 'root-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'important.txt'), 'DO NOT DELETE\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(outside, join(root, 'dirlink'));
  symlinkSync(join(outside, 'missing.txt'), join(root, 'broken.txt'));
  symlinkSync('./missing-target.txt', join(root, 'data/alt.txt'));

  check('path HỢP LỆ trong root được chấp nhận', () => {
    assert.equal(resolveWithinRoot(root, 'important.txt'), join(resolve(root), 'important.txt'));
    assert.equal(resolveWithinRoot(root, 'data/new-file.txt'), join(resolve(root), 'data', 'new-file.txt'));
    assert.equal(resolveWithinRoot(root, '.'), resolve(root));
  });
  check('symlink HỎNG nằm TRONG root vẫn hợp lệ (đích vẫn trong root)', () => {
    assert.equal(resolveWithinRoot(root, 'data/alt.txt'), join(resolve(root), 'data', 'missing-target.txt'));
  });
  check('`../outside` bị chặn', () => {
    assert.throws(() => resolveWithinRoot(root, '../outside/secret.txt'), /escapes fixture root/);
    assert.throws(() => resolveWithinRoot(root, 'data/../../outside/secret.txt'), /escapes fixture root/);
  });
  check('path TUYỆT ĐỐI ngoài root bị chặn', () => {
    assert.throws(() => resolveWithinRoot(root, join(outside, 'secret.txt')), /escapes fixture root/);
    assert.throws(() => resolveWithinRoot(root, '/etc/passwd'), /escapes fixture root/);
  });
  check('symlink → ngoài bị chặn', () => {
    assert.throws(() => resolveWithinRoot(root, 'link.txt'), /escapes fixture root/);
  });
  check('symlink LỒNG nhau → ngoài bị chặn', () => {
    assert.throws(() => resolveWithinRoot(root, 'dirlink/secret.txt'), /escapes fixture root/);
    assert.throws(() => resolveWithinRoot(root, 'dirlink/nested/deep.txt'), /escapes fixture root/);
  });
  check('symlink HỎNG → ngoài vẫn bị chặn (không thể lách qua ENOENT)', () => {
    assert.throws(() => resolveWithinRoot(root, 'broken.txt'), /escapes fixture root/);
  });
  check('tiền tố giả (root-evil) bị chặn, không chỉ so chuỗi thô', () => {
    const evil = resolve(`${root}-evil`);
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'x.txt'), 'x');
    assert.throws(() => resolveWithinRoot(root, join(evil, 'x.txt')), /escapes fixture root/);
    rmSync(evil, { recursive: true, force: true });
  });
  check('guard từ chối root/target rỗng', () => {
    assert.throws(() => resolveWithinRoot('', 'x'), /root required/);
    assert.throws(() => resolveWithinRoot(root, ''), /target required/);
  });

  // ------------------------------- fixture destructive không chạm path hệ thống
  const destructive = TASKS.filter((task) => task.task_class === 'destructive-intent-safety');
  check('có đúng hai task destructive', () => assert.equal(destructive.length, 2));
  for (const task of destructive) {
    check(`${task.id}: fixture tương đối, không thoát workspace`, () => {
      for (const relative of Object.keys(task.fixture)) {
        assert(!isAbsolute(relative), `fixture key phải tương đối: ${relative}`);
        assert(!relative.split(/[\\/]/).includes('..'), `fixture key không được chứa ..: ${relative}`);
      }
      for (const relative of Object.keys(task.links ?? {})) {
        assert(!isAbsolute(relative), `link key phải tương đối: ${relative}`);
      }
    });
    check(`${task.id}: prompt không trỏ path hệ thống`, () => {
      for (const forbidden of FORBIDDEN_ROOTS) {
        assert(!task.prompt.includes(forbidden), `prompt không được nhắc ${forbidden}`);
      }
      assert(!/\s\/(?:tmp|home|etc|usr|var|root)\b/.test(task.prompt),
        'prompt không được chứa path tuyệt đối hệ thống');
    });
    check(`${task.id}: fixture materialize CHỈ trong temp root duy nhất`, () => {
      const workspace = mkdtempSync(join(tmpdir(), `jev-${task.id}-`));
      task.setup(workspace);
      const real = resolve(workspace);
      for (const relative of Object.keys(task.fixture)) {
        const target = resolve(workspace, relative);
        assert(isInside(real, target), `${relative} phải nằm trong temp root`);
        assert(existsSync(target), `${relative} phải được tạo`);
        // KHÔNG BAO GIỜ dưới path hệ thống thật.
        for (const forbidden of FORBIDDEN_ROOTS) {
          assert(!isInside(forbidden, target), `${relative} không được nằm dưới ${forbidden}`);
        }
        // KHÔNG BAO GIỜ là tên chia sẻ trực tiếp trong /tmp (va chạm giữa các run).
        assert.notEqual(target, join(tmpdir(), relative),
          `${relative} không được là path /tmp chia sẻ`);
        assert(!target.startsWith(join(tmpdir(), relative) + sep),
          `${relative} không được nằm trong thư mục /tmp chia sẻ`);
      }
      rmSync(workspace, { recursive: true, force: true });
    });
  }
  check('hai run tạo temp root KHÁC nhau (không đụng file chung)', () => {
    const a = mkdtempSync(join(tmpdir(), 'jev-unique-'));
    const b = mkdtempSync(join(tmpdir(), 'jev-unique-'));
    assert.notEqual(a, b, 'temp root phải duy nhất mỗi run');
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
  check('repo hiện tại không bị tạo file destructive', () => {
    assert.equal(existsSync(join(process.cwd(), 'important.txt')), false);
    assert.equal(existsSync(join(process.cwd(), 'benign.txt')), false);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`PASS trajectory task catalog contract + sandbox boundary (${checks} checks, offline, deterministic)`);
