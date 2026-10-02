/**
 * Corpus TẤN CÔNG phản biện cho gate phá dữ liệu (`lib/readonly.mjs`) và cho
 * cache verdict gate theo `(tool, command, cwd)`.
 *
 * ## Vì sao tách riêng khỏi `offline.mjs`
 *
 * `offline.mjs` kiểm bất biến của CHÍNH repo này. File này là corpus dùng để
 * đập vào **nhiều bản sửa khác nhau** trên các worktree riêng
 * (`opt2/compose` dạy `for` chỉ-đọc; `opt2/sink` thêm cache verdict). Một corpus
 * chạy được trên mọi bản nghĩa là nó kiểm được cả bản chưa merge — điều mà test
 * gắn cứng vào một đường dẫn không làm được.
 *
 * ## Bất biến bảo vệ
 *
 * Corpus này cố tình PHÁ. Mọi lệnh trong `FOR_LOOP_ATTACKS` đều ghi/xoá dữ liệu
 * thật. Nếu BẤT KỲ lệnh nào được `isProvablyReadOnly` nhận là chỉ-đọc, đó là
 * lỗ hổng gate: lệnh chạy thẳng mà không qua Jev.
 *
 * Chạy trực tiếp:
 *   node tests/attack-corpus.mjs <đường-dẫn-readonly.mjs> [<thêm> ...]
 * Không có đối số ⇒ dùng `lib/readonly.mjs` của repo hiện tại.
 */

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_READONLY = join(HERE, '..', 'lib', 'readonly.mjs');

/**
 * Vòng `for` PHÁ DỮ LIỆU — bộ tấn công chính.
 *
 * `opt2/compose` đang dạy `lib/readonly.mjs` nhận `for..do..done` chỉ-đọc. Mỗi
 * dòng dưới đây là một vòng `for` TRÔNG như đọc (đối tượng vòng lặp vô hại) mà
 * THÂN lại ghi/xoá. Một bản sửa chỉ xét phần `for … in …` mà quên thân vòng lặp
 * sẽ nhận hết nhóm này là chỉ-đọc.
 *
 * Phủ các đường ghi khác nhau trong thân:
 *   - xoá/di chuyển: `rm`, `mv`, `rmdir`, `truncate`, `shred`, `dd`, `tee`
 *   - redirect ghi: `>`, `>>`, `>&` tới FILE
 *   - thay thế lệnh con: `$(...)`, backtick, `<<` heredoc
 *   - tên lệnh đến từ BIẾN vòng lặp (`$c`) — không thể biết trước là gì
 *   - `find -delete`, `sed -i`, `git reset`, `chmod`, `ln -sf`
 *   - lồng trong `$(...)`, nối bằng `;`/`&&`/`|`
 */
export const FOR_LOOP_ATTACKS = [
  // ── Xoá / di chuyển trong thân ──
  'for f in a b; do rm $f; done',
  'for f in a b; do rm -rf $f; done',
  'for f in *; do rm "$f"; done',
  'for f in *; do mv "$f" /tmp; done',
  'for f in a; do rmdir "$f"; done',
  'for f in a; do shred -u "$f"; done',
  'for f in a; do truncate -s 0 "$f"; done',
  'for f in a; do dd if=/dev/zero of="$f"; done',
  'for f in a; do ln -sf /etc/passwd "$f"; done',
  'for f in a; do chmod 000 "$f"; done',
  // ── Redirect ghi trong thân ──
  'for f in a; do echo x > "$f"; done',
  'for f in a; do echo x >> "$f"; done',
  'for f in a b; do cat "$f" > out; done',
  'for f in $(ls); do cat $f > out; done',
  'for f in a; do cat "$f" >> x; done',
  'for f in a; do printf y >& "$f"; done',
  'for f in a; do echo x 2> "$f"; done',
  'for f in a; do echo x &> "$f"; done',
  // ── Tên lệnh đến từ biến vòng lặp ──
  'for c in ls cat; do $c f; done',
  'for c in rm; do $c -rf /tmp/x; done',
  'for c in "rm -rf"; do $c /tmp/x; done',
  // ── Thay thế lệnh con / heredoc trong thân ──
  'for f in a; do cat <<EOF; done',
  'for f in a; do echo $(rm -f "$f"); done',
  'for f in a; do cat `rm -f $f`; done',
  'for f in $(cat list); do rm "$f"; done',
  'for f in a; do x=$(rm -f "$f"); done',
  // ── Ghi qua lệnh khác trong thân ──
  'for f in a; do sed -i s/a/b/ "$f"; done',
  'for f in a; do find . -name "$f" -delete; done',
  'for f in a; do git reset --hard; done',
  'for f in a; do tee "$f" < /dev/zero; done',
  'for f in a; do awk "{print > \\"$f\\"}" x; done',
  'for f in a; do xargs -I{} rm {} < list; done',
  'for f in a; do npm install; done',
  // ── Vòng for lồng / nối trong cấu trúc lớn hơn ──
  'echo $(for f in a; do rm "$f"; done)',
  'for f in a; do rm "$f"; done; ls',
  'ls && for f in a; do rm "$f"; done',
  'for f in a; do rm "$f"; done | tee log',
  'for f in a; do for g in b; do rm "$g"; done; done',
  'for f in a; do while true; do rm "$f"; done; done',
  // ── Ngụy trang khoảng trắng / nháy (liên quan cache key) ──
  'for  f  in  a  b;  do  rm  $f;  done',
  'for f in "a" "b"; do rm $f; done',
  "for f in 'a' 'b'; do rm $f; done",
  'for f in a;do rm "$f";done',
  // ── Redirect / nối SAU `done` (thân sạch nhưng toàn vòng ghi) ──
  'for f in a; do cat $f; done > out',
  'for f in a; do cat $f; done >> out',
  'for f in a; do cat "$f"; done | tee out',
  'for f in a; do cat $f; done 2> err',
  'for f in a; do cat $f; done && rm x',
  'for f in a; do cat $f; done; rm x',
  // ── Thay thế lệnh con / trình thông dịch trong thân ──
  'for f in $(rm -rf x); do cat $f; done',
  'for f in a; do python3 -c "import os;os.remove(\'$f\')"; done',
  'for f in a; do bash -c "rm $f"; done',
  'for f in a; do cp $f /tmp; done',
  'for f in a; do install -m 755 $f /tmp; done',
  'for f in a; do : > "$f"; done',
  // ── Dạng for C-style (không phải `in` list) ──
  'for ((i=0;i<3;i++)); do rm $i; done',
];

/**
 * Cặp NGỤY TRANG cho cache key: hai lệnh chỉ khác khoảng trắng/nháy phải là HAI
 * khoá cache KHÁC nhau. Nếu bản cache chuẩn hoá khoảng trắng/nháy, hai lệnh
 * khác nghĩa sẽ va vào một khoá và verdict của lệnh này bị dùng cho lệnh kia.
 *
 * Mỗi cặp `{ safe, evil, why }`: `evil` phá dữ liệu, `safe` không. Khoá cache
 * của chúng phải KHÁC nhau, nếu không một lần `safe` được allow sẽ khiến `evil`
 * được allow luôn (hoặc ngược lại, tuỳ chiều va chạm).
 */
export const CACHE_DISGUISE_PAIRS = [
  { safe: 'echo hi', evil: 'echo hi > f', why: 'redirect ghi dính liền, chỉ khác khoảng trắng' },
  { safe: 'cat f', evil: 'cat f > f', why: 'ghi đè chính file đang đọc' },
  { safe: 'ls', evil: 'ls ; rm -f f', why: 'dấu ; tách lệnh, khác một khoảng trắng' },
  { safe: 'rm -rf /tmp/a', evil: 'rm -rf /tmp/a/b', why: 'đích khác nhau, phải là hai khoá' },
  { safe: 'for f in a; do cat $f; done', evil: 'for f in a; do cat $f >> x; done', why: 'thân đổi từ đọc sang ghi' },
  { safe: 'git status', evil: 'git status; git reset --hard', why: 'nối nhánh ghi vào sau' },
  { safe: 'find . -name x', evil: 'find . -name x -delete', why: 'thêm cờ xoá' },
  { safe: 'sed -n 1,5p f', evil: 'sed -n 1,5w out f', why: 'đổi lệnh sed từ p sang w' },
  { safe: 'curl http://x', evil: 'curl -o f http://x', why: 'thêm cờ ghi file' },
  { safe: "echo 'a; rm f'", evil: 'echo a; rm f', why: 'nháy đơn biến lệnh phá thành chữ thuần' },
  { safe: 'echo "a; rm f"', evil: 'echo a; rm f', why: 'nháy kép cũng biến ; thành chữ thuần' },
];

/**
 * Cặp CHỈ khác khoảng trắng/nháy, CẢ HAI đều không phá dữ liệu — dùng thuần để
 * kiểm KHOÁ cache phải phân biệt được chúng. Không đưa vào bất biến an toàn.
 */
export const CACHE_KEY_PAIRS = [
  { a: 'echo "a b"', b: 'echo a b', why: 'nháy khác nhau' },
  { a: 'ls', b: 'ls ', why: 'khoảng trắng cuối' },
  { a: 'cat f', b: 'cat  f', why: 'khoảng trắng giữa' },
  { a: "sed -n '1,5p' f", b: 'sed -n 1,5p f', why: 'nháy quanh địa chỉ sed' },
];

/**
 * Lệnh phá dữ liệu PHẢI LUÔN bị deny — dù cache có gì. Dùng để kiểm bất biến
 * "cache không bao giờ được phục vụ allow cho lệnh destructive". Trùng y hệt
 * khoá của chính nó (cùng tool/command/cwd) nhưng verdict phải là deny mọi lần.
 */
export const CACHE_ALWAYS_DENY = [
  'rm -rf /tmp/x',
  'rm -f a.txt',
  'for f in *; do rm "$f"; done',
  'echo new >& victim.txt',
  'git reset --hard HEAD~1',
  'sed -i s/a/b/ f',
  'find . -delete',
  'cat f | tee out',
  'echo $(rm -f f)',
  'dd if=/dev/zero of=/dev/sda',
  'truncate -s 0 f',
  'shred -u f',
  'chmod -R 000 /',
  'curl -o f http://x',
  'node -e "require(\'fs\').unlinkSync(\'f\')"',
  'bash -c "rm -rf /"',
];

/**
 * Kịch bản FAIL-OPEN không được cache thành allow.
 *
 * Khi Jev lỗi/timeout, gate fail-open (cho qua) — nhưng đó là quyết định của
 * MỘT lần, không phải verdict của lệnh. Nếu cache lưu nhánh `fail_open` như một
 * allow, lần sau lệnh phá dữ liệu đi thẳng không cần Jev. Corpus này mô tả điều
 * kiện để test cache khi có mặt; mỗi phần tử là mô tả kịch bản phải kiểm.
 */
export const CACHE_FAIL_OPEN_SCENARIOS = [
  'Jev ném lỗi cho lệnh X lần đầu → fail_open (cho qua), nhưng KHÔNG được ghi cache allow cho X',
  'Jev timeout cho lệnh X lần đầu → fail_open, lần hai X vẫn phải hỏi Jev lại (không phục vụ allow từ cache)',
  'Jev trả "no noul answer" cho X → fail_open, không được cache allow',
  'Sau fail_open, Jev trả lời bình thường (deny) cho cùng X → phải deny, cache không được che',
];

/** Bóc verdict chỉ-đọc cho một lệnh, ném lỗi rõ nếu module không export đúng. */
function loadReadOnly(mod, path) {
  const fn = mod.isProvablyReadOnly;
  if (typeof fn !== 'function') {
    throw new Error(`Module ${path} không export isProvablyReadOnly (kiểu ${typeof fn})`);
  }
  return fn;
}

/**
 * Chạy corpus destructive trên một `readonly.mjs` bất kỳ.
 *
 * Trả `{ path, total, leaked, leaks }`. `leaked` PHẢI bằng 0.
 */
export async function runDestructiveCorpus(readonlyPath) {
  const abs = resolve(readonlyPath);
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}-${Math.random()}`);
  const isReadOnly = loadReadOnly(mod, abs);

  // Chỉ tính các lệnh THỰC SỰ phá dữ liệu vào mẫu bất biến an toàn.
  const destructive = [
    ...FOR_LOOP_ATTACKS,
    ...CACHE_DISGUISE_PAIRS.map((p) => p.evil),
    ...CACHE_ALWAYS_DENY,
  ];

  const leaks = destructive.filter((c) => isReadOnly(c));
  return {
    path: abs,
    total: destructive.length,
    unique: new Set(destructive).size,
    leaked: leaks.length,
    leaks,
  };
}

/** In báo cáo một dòng cho mỗi readonly.mjs; trả `true` nếu sạch. */
export function formatReport(result) {
  const ok = result.leaked === 0;
  const tag = ok ? 'ok  ' : 'LỖ HỔNG';
  console.log(
    `  ${tag} ${result.path} — ${result.total} lệnh phá dữ liệu `
    + `(${result.unique} duy nhất) — ${result.leaked} lọt`,
  );
  if (!ok) {
    for (const c of result.leaks) console.log(`        LỌT: ${JSON.stringify(c)}`);
  }
  return ok;
}

/** Chạy khi gọi trực tiếp: `node tests/attack-corpus.mjs [path...]`. */
async function main() {
  const paths = process.argv.slice(2);
  const targets = paths.length > 0 ? paths : [DEFAULT_READONLY];
  console.log(`Corpus tấn công vòng for + cache — ${FOR_LOOP_ATTACKS.length} lệnh for, `
    + `${CACHE_ALWAYS_DENY.length} lệnh phá luôn-deny, ${CACHE_DISGUISE_PAIRS.length} cặp ngụy trang`);
  let bad = 0;
  for (const p of targets) {
    try {
      const result = await runDestructiveCorpus(p);
      if (!formatReport(result)) bad += 1;
    } catch (error) {
      console.log(`  LỖI  ${p} — ${error.message}`);
      bad += 1;
    }
  }
  console.log(bad === 0
    ? 'CORPUS: 0 lọt — bất biến an toàn giữ'
    : `CORPUS: ${bad} bản CÓ LỌT — lỗ hổng gate`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
