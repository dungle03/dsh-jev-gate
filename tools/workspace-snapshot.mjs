/**
 * Snapshot cây workspace thành MỘT hash sha256 tất định, kèm một DIFF có cấu trúc.
 *
 * Vì sao cần: `unchanged = !task.writes` chỉ là metadata của task, không phải
 * bằng chứng. Một task read-only khai `writes: false` vẫn có thể bị agent sửa
 * file, và khi đó record trông "sạch" trong khi thực tế đã có side effect. Hash
 * cây thật trước/sau lượt chạy biến metadata thành phép kiểm.
 *
 * Tất định nghĩa là: cùng một cây ⇒ cùng một hash, trên mọi máy, mọi thứ tự
 * duyệt. Đạt được bằng cách sắp xếp đường dẫn tương đối theo thứ tự code-unit
 * (không theo locale) và ghi mỗi entry thành một dòng `path\tkind:payload:mode`.
 *
 * Quy ước:
 *   - đường dẫn tương đối dùng `/` (POSIX) kể cả trên Windows;
 *   - `dir`/`file` ghi THÊM mode bit (`stats.mode & 0o7777`) vì §18 yêu cầu bắt
 *     được thay đổi QUYỀN. Trước đây bỏ qua quyền để hash "sạch"; nhưng như vậy
 *     một `chmod` trên task read-only hoàn toàn vô hình — đúng loại side effect
 *     cần chặn. Quyền là một phần của cây, nên phải vào hash;
 *   - `file` ghi sha256 của nội dung NHỊ PHÂN (không giải mã text) — thay đổi
 *     một byte trong file nhị phân cũng phải đổi hash;
 *   - `symlink` ghi TARGET (không đi theo link) — target đổi là cây đổi;
 *   - file ẩn (`.env`, `.gitignore`) là entry bình thường: `readdirSync` đã trả
 *     chúng, KHÔNG được lọc bỏ;
 *   - `node_modules` và `.git` bị bỏ qua ở mọi độ sâu;
 *   - entry không đọc được ghi `unreadable:<code>` thay vì ném: một lần snapshot
 *     không được phép làm sập lượt chạy benchmark. Cùng lỗi ở cả hai lần
 *     snapshot ⇒ hash bằng nhau, tức là "không quan sát được thay đổi", chứ
 *     KHÔNG phải "đã xác nhận không đổi".
 *
 * `diffWorkspaces` là bản so sánh FAIL-CLOSED: nó không chỉ nói "cây đổi" mà
 * còn liệt kê CHÍNH XÁC cái gì đổi (tạo/xoá/đổi tên/đổi nội dung/đổi quyền/đổi
 * kiểu/đổi target symlink). Nhờ vậy caller read-only có thể từ chối thành công
 * khi có bất kỳ thay đổi nào NGOÀI tập mong đợi, thay vì chỉ tin một boolean.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Thư mục không bao giờ thuộc về nội dung benchmark. */
const SKIP_NAMES = new Set(['node_modules', '.git']);

const code = (error) => error?.code ?? 'unknown';

/** Mode bit dạng bát phân (bỏ bit kiểu file) — ổn định giữa các lần chạy. */
const modeOf = (stats) => (stats.mode & 0o7777).toString(8);

/**
 * Mô tả một entry: dòng tất định + entry có cấu trúc + có phải thư mục để duyệt tiếp.
 * `kind` là một trong `dir|file|symlink|other|unreadable`.
 */
function describe(absolute, relative) {
  let stats;
  try { stats = lstatSync(absolute); }
  catch (error) {
    return { line: `${relative}\tunreadable:${code(error)}`,
      entry: { kind: 'unreadable', payload: code(error), mode: null }, directory: false };
  }
  // lstat nên symlink hỏng vẫn đọc được target — đúng thứ cần bắt. KHÔNG đi theo
  // link: đi theo sẽ khiến hash phụ thuộc cây BÊN NGOÀI workspace (path escape).
  if (stats.isSymbolicLink()) {
    try {
      const target = readlinkSync(absolute);
      return { line: `${relative}\tsymlink:${target}`,
        entry: { kind: 'symlink', payload: target, mode: null }, directory: false };
    } catch (error) {
      return { line: `${relative}\tsymlink:unreadable:${code(error)}`,
        entry: { kind: 'symlink', payload: `unreadable:${code(error)}`, mode: null }, directory: false };
    }
  }
  if (stats.isDirectory()) {
    return { line: `${relative}\tdir:${modeOf(stats)}`,
      entry: { kind: 'dir', payload: null, mode: modeOf(stats) }, directory: true };
  }
  if (stats.isFile()) {
    try {
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      return { line: `${relative}\tfile:${digest}:${modeOf(stats)}`,
        entry: { kind: 'file', payload: digest, mode: modeOf(stats) }, directory: false };
    } catch (error) {
      return { line: `${relative}\tfile:unreadable:${code(error)}`,
        entry: { kind: 'file', payload: `unreadable:${code(error)}`, mode: modeOf(stats) }, directory: false };
    }
  }
  // FIFO/socket/device: không phải file cũng không phải thư mục.
  return { line: `${relative}\tother:${modeOf(stats)}`,
    entry: { kind: 'other', payload: null, mode: modeOf(stats) }, directory: false };
}

/**
 * Snapshot CHI TIẾT: hash + map `relative -> {kind, payload, mode}`.
 *
 * `root` không tồn tại ⇒ hash của cây rỗng-có-lỗi (một dòng `unreadable:ENOENT`),
 * KHÔNG ném. Caller so sánh hai hash nên vẫn phân biệt được "vẫn không tồn tại"
 * với "vừa được tạo".
 */
export function snapshotWorkspaceDetail(root) {
  const lines = [];
  const entries = {};
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    let names;
    try { names = readdirSync(absolute); }
    catch (error) {
      const key = relative || '.';
      lines.push(`${key}\tunreadable:${code(error)}`);
      entries[key] = { kind: 'unreadable', payload: code(error), mode: null };
      return;
    }
    for (const name of [...names].sort()) {
      if (SKIP_NAMES.has(name)) continue;
      const child = relative === '' ? name : `${relative}/${name}`;
      const { line, entry, directory } = describe(join(root, child), child);
      lines.push(line);
      entries[child] = entry;
      if (directory) walk(child);
    }
  };
  walk('');
  lines.sort();
  const digest = createHash('sha256');
  for (const line of lines) digest.update(line).update('\n');
  return { hash: digest.digest('hex'), entries };
}

/** Hash sha256 của cây thư mục `root` (giữ API cũ, dùng chung một bộ quy ước). */
export function snapshotWorkspace(root) {
  return snapshotWorkspaceDetail(root).hash;
}

/**
 * So sánh hai snapshot chi tiết; trả về TẤT CẢ các loại thay đổi.
 *
 * `renamed` KHÔNG phải một phép suy đoán nội dung: một đổi tên trên hệ thống file
 * hiện ra đúng như một cặp xoá+ tạo, nên nó nằm trong `deleted`+`created`. Đó là
 * sự thật quan sát được; đoán "cùng nội dung nên là rename" sẽ là suy diễn ngầm.
 */
export function diffWorkspaces(before, after) {
  const beforeEntries = before?.entries ?? {};
  const afterEntries = after?.entries ?? {};
  const created = []; const deleted = []; const modified = [];
  const typeChanged = []; const symlinkChanged = []; const permissionChanged = [];
  for (const path of Object.keys(afterEntries).sort()) {
    if (!(path in beforeEntries)) created.push(path);
  }
  for (const path of Object.keys(beforeEntries).sort()) {
    if (!(path in afterEntries)) { deleted.push(path); continue; }
    const was = beforeEntries[path]; const now = afterEntries[path];
    if (was.kind !== now.kind) { typeChanged.push(path); continue; }
    if (was.kind === 'symlink' && was.payload !== now.payload) { symlinkChanged.push(path); continue; }
    if (was.payload !== now.payload) modified.push(path);
    if (was.mode !== now.mode) permissionChanged.push(path);
  }
  const changedPaths = [...new Set([...created, ...deleted, ...modified, ...typeChanged,
    ...symlinkChanged, ...permissionChanged])].sort();
  return {
    changed: changedPaths.length > 0,
    created, deleted, modified, type_changed: typeChanged,
    symlink_changed: symlinkChanged, permission_changed: permissionChanged,
    paths: changedPaths,
  };
}

/**
 * Kiểm path có THOÁT khỏi workspace root qua một symlink không.
 *
 * KHÔNG đi theo link để đọc (đó là việc của `lstat`); ở đây chỉ GIẢI target ra
 * đường dẫn tuyệt đối rồi hỏi nó có nằm dưới root không. Một symlink trỏ ra
 * `/etc/passwd` là side effect ngoài workspace, kể cả khi chưa ai đọc nó.
 */
export function escapesWorkspaceRoot(root, relative, target) {
  const rootResolved = resolve(root);
  const base = resolve(rootResolved, dirname(relative));
  const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(base, target);
  return resolvedTarget !== rootResolved && !resolvedTarget.startsWith(rootResolved + sep);
}

/** Danh sách symlink trong snapshot trỏ RA NGOÀI root (vi phạm path confinement). */
export function confinementProblems(root, detail) {
  const entries = detail?.entries ?? {};
  const problems = [];
  for (const [relative, entry] of Object.entries(entries)) {
    if (entry?.kind !== 'symlink' || typeof entry.payload !== 'string') continue;
    if (escapesWorkspaceRoot(root, relative, entry.payload)) {
      problems.push({ path: relative, target: entry.payload });
    }
  }
  return problems;
}
