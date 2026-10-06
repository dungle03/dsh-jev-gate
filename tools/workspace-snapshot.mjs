/**
 * Snapshot cây workspace thành MỘT hash sha256 tất định.
 *
 * Vì sao cần: `unchanged = !task.writes` chỉ là metadata của task, không phải
 * bằng chứng. Một task read-only khai `writes: false` vẫn có thể bị agent sửa
 * file, và khi đó record trông "sạch" trong khi thực tế đã có side effect. Hash
 * cây thật trước/sau lượt chạy biến metadata thành phép kiểm.
 *
 * Tất định nghĩa là: cùng một cây ⇒ cùng một hash, trên mọi máy, mọi thứ tự
 * duyệt. Đạt được bằng cách sắp xếp đường dẫn tương đối theo thứ tự code-unit
 * (không theo locale) và ghi mỗi entry thành một dòng `path\tkind:payload`.
 *
 * Quy ước:
 *   - đường dẫn tương đối dùng `/` (POSIX) kể cả trên Windows;
 *   - `dir` chỉ ghi tên, KHÔNG ghi mtime/quyền — quyền và thời gian đổi liên
 *     tục mà không phải nội dung, ghi vào sẽ làm hash nhiễu;
 *   - `file` ghi sha256 của nội dung nhị phân;
 *   - `symlink` ghi TARGET (không đi theo link) — target đổi là cây đổi;
 *   - `node_modules` và `.git` bị bỏ qua ở mọi độ sâu;
 *   - entry không đọc được ghi `unreadable:<code>` thay vì ném: một lần snapshot
 *     không được phép làm sập lượt chạy benchmark. Cùng lỗi ở cả hai lần
 *     snapshot ⇒ hash bằng nhau, tức là "không quan sát được thay đổi", chứ
 *     KHÔNG phải "đã xác nhận không đổi".
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Thư mục không bao giờ thuộc về nội dung benchmark. */
const SKIP_NAMES = new Set(['node_modules', '.git']);

const code = (error) => error?.code ?? 'unknown';

/** Mô tả một entry: dòng tất định + có phải thư mục cần duyệt tiếp không. */
function describe(absolute, relative) {
  let stats;
  try { stats = lstatSync(absolute); }
  catch (error) { return { line: `${relative}\tunreadable:${code(error)}`, directory: false }; }
  // lstat nên symlink hỏng vẫn đọc được target — đúng thứ cần bắt.
  if (stats.isSymbolicLink()) {
    try { return { line: `${relative}\tsymlink:${readlinkSync(absolute)}`, directory: false }; }
    catch (error) { return { line: `${relative}\tsymlink:unreadable:${code(error)}`, directory: false }; }
  }
  if (stats.isDirectory()) return { line: `${relative}\tdir`, directory: true };
  if (stats.isFile()) {
    try {
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      return { line: `${relative}\tfile:${digest}`, directory: false };
    } catch (error) { return { line: `${relative}\tfile:unreadable:${code(error)}`, directory: false }; }
  }
  // FIFO/socket/device: không phải file cũng không phải thư mục.
  return { line: `${relative}\tother:${stats.mode.toString(8)}`, directory: false };
}

/**
 * Hash sha256 của cây thư mục `root`.
 *
 * `root` không tồn tại ⇒ hash của cây rỗng-có-lỗi (một dòng `unreadable:ENOENT`),
 * KHÔNG ném. Caller so sánh hai hash nên vẫn phân biệt được "vẫn không tồn tại"
 * với "vừa được tạo".
 */
export function snapshotWorkspace(root) {
  const lines = [];
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    let names;
    try { names = readdirSync(absolute); }
    catch (error) { lines.push(`${relative || '.'}\tunreadable:${code(error)}`); return; }
    for (const name of [...names].sort()) {
      if (SKIP_NAMES.has(name)) continue;
      const child = relative === '' ? name : `${relative}/${name}`;
      const { line, directory } = describe(join(root, child), child);
      lines.push(line);
      if (directory) walk(child);
    }
  };
  walk('');
  lines.sort();
  const digest = createHash('sha256');
  for (const line of lines) digest.update(line).update('\n');
  return digest.digest('hex');
}
