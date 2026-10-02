/**
 * Nhận diện lệnh CHẮC CHẮN chỉ-đọc (provably read-only).
 *
 * ## Vì sao có file này
 *
 * Lớp 1 (gate phá dữ liệu) gọi Jev cho **mọi** lệnh `bash`. Đo trên log thật
 * `~/.local/share/dsh-jev-gate/decisions.jsonl` (2026-09-27 → 09-30):
 *
 *   - 5.675 call `destructive_gate`, 100% là tool `bash`
 *   - **80,7%** call có `p ≤ 0.02` — Jev trả "chắc chắn không phá gì"
 *   - p50 282ms/call, ~1.100 input token/call
 *
 * Nghĩa là ~4.500 round-trip API chỉ để nghe lại điều suy ra được bằng một phép
 * phân tích cú pháp cục bộ rẻ hơn hàng nghìn lần.
 *
 * ## Nguyên tắc: KHÔNG đoán
 *
 * Trả `true` chỉ khi **chứng minh được** lệnh không thể ghi. Mọi trường hợp
 * không chắc — heredoc, backtick, redirect ghi, pipe vào chương trình lạ,
 * `find -delete`, `sed -i`, trình thông dịch, lệnh lạ — đều trả `false`, và lệnh
 * đó vẫn đi qua Jev như cũ.
 *
 * An toàn một chiều: bỏ sót (trả `false` khi lệnh vô hại) chỉ tốn một call Jev;
 * đoán bừa (trả `true` khi lệnh phá dữ liệu) là lỗ hổng gate. Nên mọi nhánh
 * nghi ngờ đều nghiêng về `false`.
 *
 * ## Vì sao phải tokenize chứ không quét regex
 *
 * Ba lần đo liên tiếp cho thấy quét chuỗi thô sai theo cả hai hướng:
 *
 *   - `\bdsh\b` để chặn lệnh `dsh` khớp luôn đường dẫn `~/.dsh/...` → giết oan
 *     2.100/3.197 lệnh hợp lệ (coverage tụt còn 2,3%).
 *   - `>` trong nháy (`sed 's/x/=<set>/'`) bị tính là redirect ghi.
 *   - `;` trong nháy (`echo "a; b"`) bị tính là dấu tách lệnh.
 *
 * Tokenizer dưới đây tách từ **có ghi nhớ nháy**, nên `>`/`;`/`|` bên trong
 * nháy là nội dung chứ không phải toán tử, còn tên lệnh được xét theo **vị trí**
 * thay vì khớp chuỗi. Đây là điểm khác biệt cốt lõi so với bản regex.
 *
 * ## Trần phủ sót (đo trên 3.197 lệnh bash thật của chính máy này)
 *
 * 24,1% khớp. Con số thấp hơn trực giác vì phần lớn lệnh của agent chứa heredoc
 * `<<'EOF'`, redirect `>`, `$(...)` hoặc trình thông dịch — tất cả đều bị loại
 * có chủ ý. Đây là số đo thật, không phải ước lượng.
 *
 * ## Bất biến được kiểm bằng corpus
 *
 * `tests/offline.mjs` chạy hai bộ: 221 lệnh phá dữ liệu (**0 được phép lọt**) và
 * 137 lệnh chỉ-đọc (**phải nhận ra**). Bất biến thứ nhất là điều kiện an toàn;
 * bất biến thứ hai chỉ là chất lượng phủ.
 */

/** Token: `word` (có nhớ nháy) hoặc `op` (toán tử shell không nháy). */
const REDIRECT_OPS = new Set(['>', '>>', '>&', '&>', '<', '<<', '<&']);
const SEPARATOR_OPS = new Set(['&&', '||', ';', '|', '\n', '&']);

/**
 * Tập lệnh được coi là chỉ-đọc khi đứng ở **đầu một đoạn lệnh**.
 *
 * Mỗi lệnh ở đây phải thoả: **mọi** cách gọi đều không ghi vào đối tượng đã tồn
 * tại. Đây là tiêu chí hẹp, và nó đã loại nhiều lệnh trông có vẻ chỉ-đọc:
 *
 *   - `xxd`/`uniq`/`sort`/`shuf`: nhận **đối số vị trí là file GHI**
 *     (`xxd in out`, `uniq in out`). `sort`/`shuf` đã xử lý riêng; `xxd`/`uniq`
 *     bị loại hẳn vì không có cách phân biệt chắc chắn.
 *   - `trap`: chạy lệnh tuỳ ý khi có signal (`trap 'rm -f v' EXIT`). Nguy hiểm
 *     nhất trong nhóm này, đã kiểm bằng shell thật.
 *   - `history`: `-w`/`-a` ghi file history.
 *   - `less`/`more`: `-o`/`--log-file` ghi file, và `less` còn chạy được `!cmd`.
 *   - `hostname`: đối số vị trí **đặt** tên máy (`hostname NEW`).
 *   - `file`: `-C`/`--compile` ghi file magic (`magic.mgc`).
 *   - `rg`/`fd`: `--pre`/`-x` chạy chương trình tuỳ ý.
 *   - `set`/`export`/`read`/`alias`/`trap`… builtin: đổi trạng thái shell, và
 *     `set -- $(...)`/`eval` có thể chạy lệnh.
 *
 * Đo trên 3.197 lệnh thật: các lệnh bị loại vì lý do trên xuất hiện **0–2 lần**
 * mỗi cái, nên chi phí phủ sót gần như bằng không.
 */
const READ_ONLY_COMMANDS = new Set([
  // Liệt kê / đọc nội dung
  'ls', 'dir', 'vdir', 'cat', 'head', 'tail', 'nl', 'tree',
  'stat', 'readlink', 'realpath', 'basename', 'dirname', 'wc',
  // Tìm kiếm (KHÔNG `rg`/`fd`: `--pre`/`-x` chạy chương trình)
  'grep', 'egrep', 'fgrep', 'which', 'type', 'whereis',
  // Biến đổi thuần luồng (stdin → stdout). KHÔNG `uniq` (nhận file GHI ở vị trí 2).
  'cut', 'tr', 'column', 'fold', 'expand', 'unexpand', 'comm',
  'join', 'paste', 'cmp', 'diff', 'rev', 'tac',
  // Hiển thị / định dạng. KHÔNG `xxd` (nhận file GHI ở đối số thứ hai).
  // `od`/`strings`/`hexdump` đã kiểm bằng shell thật: mọi cách gọi đều chỉ ghi
  // stdout, không có đường ghi file (`-o` của `strings` là alias của `--radix`).
  'echo', 'printf', 'seq', 'yes', 'expr', 'jq', 'base64', 'od', 'strings', 'hexdump',
  // Thông tin hệ thống (chỉ đọc). KHÔNG `hostname` (đặt được tên máy).
  'pwd', 'id', 'whoami', 'groups', 'tty', 'cal', 'uname', 'uptime',
  'du', 'df', 'free', 'nproc', 'getconf', 'locale', 'ps', 'pgrep', 'ss',
  'netstat', 'lsof', 'vmstat', 'iostat', 'lsblk', 'lsusb', 'lscpu', 'lspci',
  // Hash (đọc file, ghi stdout)
  'sha256sum', 'sha1sum', 'sha512sum', 'md5sum', 'md5', 'shasum', 'cksum',
  'b2sum',
  // Chỉ điều hướng/trạng thái shell, không đụng dữ liệu trên đĩa.
  //
  // KHÔNG có `trap`: nó **chạy lệnh tuỳ ý** khi có signal, và payload nằm trong
  // nháy nên phép kiểm `$(...)` không bắt được — đã kiểm bằng shell thật
  // (`trap 'rm -f victim' EXIT` xoá file). KHÔNG có `history`: `-w`/`-a` ghi file.
  //
  // `set`/`export`/`read`/`alias` AN TOÀN vì mọi đường chạy lệnh của chúng đều
  // đi qua `$(...)`/backtick — đã bị chặn ở tầng tokenize. Đo trên 3.197 lệnh
  // thật: `export` 68 lần, `read` 36 lần, nên loại chúng là mất mát thật.
  'cd', 'true', 'false', 'test', 'set', 'unset', 'export', 'exit', 'shift',
  'return', 'ulimit', 'umask', 'read', 'wait', 'sleep', 'alias', 'unalias',
  'hash', 'times', 'dirs', 'pushd', 'popd',
]);

/**
 * Lệnh chỉ-đọc *có điều kiện*: an toàn trừ khi khớp một cờ trong `rejectFlags`.
 *
 * Cờ phải gắn với TỪNG lệnh, không kiểm chung toàn câu: `-o` ghi file với
 * `sort`/`less` nhưng chỉ là "chỉ in phần khớp" với `grep -o`; `-x` chạy lệnh
 * với `fd` nhưng là "file thực thi được" với `test -x`. Kiểm chung sẽ loại oan
 * những lệnh rất phổ biến.
 *
 * Mỗi mục dưới đây là một lỗi thật đã kiểm bằng shell/`--help` trên máy này.
 */
const CONDITIONAL_COMMANDS = {
  // `sort -o f` ghi đè f; `--compress-program` chạy chương trình tuỳ ý.
  sort: { rejectFlags: [/^-o/, /^--output/, /^--compress-program/] },
  // `shuf -o f` ghi đè f.
  shuf: { rejectFlags: [/^-o/, /^--output/] },
  // `date -s STR` và `date MMDDhhmm` (đối số vị trí) đặt lại đồng hồ hệ thống.
  date: { rejectFlags: [/^-s$/, /^--set/, /^[0-9]{8,12}(\.[0-9]+)?$/] },
  // `less -o f` ghi file; `less` còn chạy được `!cmd` khi tương tác.
  less: { rejectFlags: [/^-o/, /^-O/, /^--log-file/, /^--LOG-FILE/, /^-k/, /^!/] },
  // `more -o` / `--log-file` ghi file.
  more: { rejectFlags: [/^-o/, /^--log-file/] },
  // `rg --pre CMD` chạy CMD trên mỗi file; `--hostname-bin` chạy binary ngoài.
  rg: { rejectFlags: [/^--pre/, /^--pre-glob/, /^--hostname-bin/] },
  // `fd -x CMD` / `--exec-batch CMD` chạy chương trình tuỳ ý.
  fd: { rejectFlags: [/^-x$/, /^-X$/, /^--exec/, /^--batch-size/] },
  // `file -C`/`--compile` ghi file magic (`magic.mgc`) vào thư mục hiện tại.
  file: { rejectFlags: [/^-C$/, /^--compile/] },
  // `history -w/-a/-r/-n` ghi hoặc nạp file history; `-c` xoá, `-d` xoá mục,
  // `-p`/`-s` thêm mục. Chỉ dạng trần và `history N` là chỉ-đọc.
  history: { rejectFlags: [/^-/, /^--/] },
};

/**
 * Lệnh mà một ĐỐI SỐ VỊ TRÍ là file ghi: an toàn chỉ khi có ít hơn N đối số
 * không phải cờ.
 *
 * `uniq [INPUT [OUTPUT]]` và `xxd [infile [outfile]]` — đối số thứ hai ghi đè
 * file, và cả hai dạng đều hợp lệ nên không thể phân biệt bằng tên cờ. Phải đếm
 * đối số vị trí. Đây là lỗi thật: `xxd in out` từng được coi là chỉ-đọc.
 */
const POSITIONAL_OUTPUT_COMMANDS = new Map([
  ['uniq', 2],     // `uniq in` đọc, `uniq in out` ghi
  ['xxd', 2],      // `xxd in` đọc, `xxd in out` ghi
  // `hostname` trần in tên máy; có đối số vị trí thì ĐẶT tên máy
  // (`hostname NEW`). Cờ như `-f`/`-I` vẫn chỉ đọc nên đếm vị trí là đủ.
  ['hostname', 1],
]);

/**
 * Lệnh luôn ghi ở mọi cách gọi ⇒ không bao giờ chỉ-đọc.
 *
 * `split`/`csplit` sinh file mảnh; `tee` ghi ra file theo thiết kế.
 */
const ALWAYS_WRITE_COMMANDS = new Set(['split', 'csplit', 'tee']);

/**
 * Đếm đối số vị trí (không phải cờ) trong mảng từ, sau khi bỏ tên lệnh.
 *
 * `--` kết thúc danh sách cờ; mọi thứ sau đó đều là vị trí.
 */
function positionalCount(words) {
  let count = 0;
  let flagsEnded = false;
  for (const word of words) {
    if (flagsEnded) { count += 1; continue; }
    if (word === '--') { flagsEnded = true; continue; }
    if (word.startsWith('-') && word.length > 1) continue; // cờ
    count += 1;
  }
  return count;
}

/**
 * Cờ của `find` gây ghi hoặc thực thi.
 *
 * `-ls` không nằm đây: nó chỉ in thông tin (đã từng bị bản regex loại oan).
 */
const FIND_WRITE_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir',
  '-fprint', '-fprint0', '-fprintf', '-fls',
]);

/** Subcommand `git` chỉ-đọc, không nhánh ghi nào. */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'blame',
  'describe', 'shortlog', 'ls-files', 'ls-tree', 'cat-file', 'grep',
  'count-objects', 'name-rev', 'merge-base', 'verify-commit', 'verify-tag',
  'whatchanged', 'cherry', 'version', 'check-ignore', 'check-attr',
  'for-each-ref', 'annotate', 'diff-tree', 'diff-index', 'diff-files',
]);

/**
 * Cờ toàn cục của `git` tiêu thụ một giá trị đứng sau.
 * `git -C dir status` — thiếu bước này thì subcommand bị đọc nhầm là `dir`.
 */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
]);

/**
 * Wrapper được bóc ra rồi xét lệnh bên trong.
 *
 * `sudo`/`doas`/`command` KHÔNG nằm đây: chúng chạy lệnh bằng quyền khác hoặc
 * che mất tên lệnh thật.
 */
const WRAPPERS = new Set(['rtk', 'time', 'stdbuf', 'nice', 'ionice', 'timeout']);

/** Wrapper tiêu thụ thêm một token số trước lệnh thật (`timeout 5s CMD`). */
const WRAPPER_NUMERIC_ARG = new Set(['timeout', 'nice', 'ionice']);

/**
 * Token giữa wrapper và lệnh thật (`rtk proxy grep …`).
 *
 * Không bóc thì mất 263/3.197 lệnh — đo được, không phải phỏng đoán.
 */
const SUBCOMMAND_SKIP = new Set(['proxy']);

/** Chuỗi đánh dấu một `$(...)` đã được tách ra để xét riêng. */
const SUBST_MARK = '\u0000SUBST\u0000';

/**
 * Tách câu lệnh thành token, **ghi nhớ nháy**.
 *
 * Trả `{ tokens, subs }`, hoặc `null` khi gặp cấu trúc không phân tích nổi:
 * nháy không đóng, ngoặc `$(` lệch, hoặc backtick.
 *
 * `subs` là danh sách lệnh con trong `$(...)`; chúng phải được xét đệ quy vì
 * `echo $(rm -rf /tmp/x)` có vẻ là `echo` nhưng thực chất chạy `rm`.
 */
function tokenize(text) {
  const tokens = [];
  const subs = [];
  let i = 0;

  const pushOp = (value, len) => {
    tokens.push({ kind: 'op', value });
    i += len;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '\n' || ch === ';') { pushOp(ch === '\n' ? '\n' : ';', 1); continue; }

    if (ch === '&') {
      if (text[i + 1] === '&') pushOp('&&', 2);
      else if (text[i + 1] === '>') pushOp('&>', 2);
      else pushOp('&', 1);
      continue;
    }
    if (ch === '|') { pushOp(text[i + 1] === '|' ? '||' : '|', text[i + 1] === '|' ? 2 : 1); continue; }
    if (ch === '>') {
      if (text[i + 1] === '>') pushOp('>>', 2);
      else if (text[i + 1] === '&') pushOp('>&', 2);
      else pushOp('>', 1);
      continue;
    }
    if (ch === '<') {
      if (text[i + 1] === '<') pushOp('<<', 2);
      else if (text[i + 1] === '&') pushOp('<&', 2);
      else pushOp('<', 1);
      continue;
    }

    // Một từ: gom cho tới khi gặp khoảng trắng hoặc toán tử KHÔNG nháy.
    let value = '';
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r') break;
      if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '<' || c === '>') break;
      if (c === '`') return null; // backtick: thực thi tuỳ ý, không phân tích
      if (c === '\\') {
        if (text[i + 1] === undefined) { value += '\\'; i += 1; } else { value += text[i + 1]; i += 2; }
        continue;
      }
      if (c === "'") {
        // Nháy đơn: nội dung là ký tự thuần, KHÔNG có phép thay thế nào.
        const end = text.indexOf("'", i + 1);
        if (end < 0) return null;
        value += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        // Nháy kép: nội dung là ký tự thuần NHƯNG `$(...)` và backtick VẪN được
        // shell thực thi. Bỏ qua điều này từng là lỗ hổng thật:
        // `echo "$(sed -i s/a/b/ f)"` bị coi là chỉ-đọc.
        i += 1;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') { value += text[i + 1] ?? '\\'; i += 2; continue; }
          if (text[i] === '`') return null;
          if (text[i] === '$' && text[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            while (j < text.length && depth > 0) {
              if (text[j] === '(') depth += 1;
              else if (text[j] === ')') depth -= 1;
              j += 1;
            }
            if (depth !== 0) return null;
            subs.push(text.slice(i + 2, j - 1));
            value += SUBST_MARK;
            i = j;
            continue;
          }
          value += text[i];
          i += 1;
        }
        if (i >= text.length) return null;
        i += 1; // bỏ nháy kép đóng
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === '(') depth += 1;
          else if (text[j] === ')') depth -= 1;
          j += 1;
        }
        if (depth !== 0) return null;
        subs.push(text.slice(i + 2, j - 1));
        value += SUBST_MARK;
        i = j;
        continue;
      }
      value += c;
      i += 1;
    }
    tokens.push({ kind: 'word', value });
  }
  return { tokens, subs };
}

/**
 * Chia token thành các đoạn lệnh, đồng thời loại redirect.
 *
 * Trả mảng các đoạn (mỗi đoạn là mảng chuỗi từ), hoặc `null` nếu có redirect
 * ghi / heredoc / toán tử lạ — mọi trường hợp đó đều phải đi qua Jev.
 *
 * Redirect vô hại được phép: chuyển fd (`2>&1`) và nuốt vào `/dev/null`.
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.kind === 'word') {
      // Số đứng ngay trước redirect là fd, không phải tên lệnh (`2>/dev/null`).
      const next = tokens[i + 1];
      if (/^\d+$/.test(token.value) && next?.kind === 'op' && REDIRECT_OPS.has(next.value)) {
        i += 1;
        continue;
      }
      current.push(token.value);
      i += 1;
      continue;
    }

    if (SEPARATOR_OPS.has(token.value)) {
      segments.push(current);
      current = [];
      i += 1;
      continue;
    }

    /**
     * Redirect: chỉ cho qua những dạng CHỨNG MINH được là không ghi file.
     *
     * `>&`/`<&` KHÔNG mặc nhiên vô hại. Bash có hai nghĩa cho `>&`:
     *
     *   `cmd >&2`      — nhân bản fd 2 (an toàn, chỉ chuyển luồng)
     *   `cmd >& file`  — chuyển stdout+stderr tới FILE, GHI ĐÈ file đó
     *
     * Nên phải kiểm token theo sau là **số** (fd) mới an toàn. Bản trước cho
     * `>&` qua vô điều kiện, nên `echo new >& victim.txt` được coi là chỉ-đọc và
     * bỏ qua Jev hoàn toàn — một lỗ hổng an toàn thật, đã tái hiện bằng shell
     * (file bị xoá nội dung).
     *
     * `2>&1` không đi qua đây: tokenizer gộp nó thành `>&` với target là `1`,
     * tức một con số, nên vẫn qua đúng.
     */
    const target = tokens[i + 1]?.kind === 'word' ? tokens[i + 1].value : undefined;
    const isFdNumber = target !== undefined && /^\d+$/.test(target);
    const isDevNull = target === '/dev/null';
    const dupToFd = (token.value === '>&' || token.value === '<&') && isFdNumber;
    const toDevNull = isDevNull && ['>', '>>', '&>', '<'].includes(token.value);
    if (dupToFd || toDevNull) { i += 2; continue; }
    return null; // ghi thật, heredoc, hoặc toán tử không nhận dạng
  }

  segments.push(current);
  return segments;
}

/**
 * Từ khoá mở một cấu trúc điều khiển. Gặp chúng trong thân vòng `for` ⇒ không
 * chứng minh được (lồng `for`/`while`/`if` có thể ẩn lệnh ghi).
 */
const COMPOUND_KEYWORDS = new Set([
  'for', 'while', 'until', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function', 'coproc',
]);

/**
 * Token thay cho một vòng `for` đã chứng minh chỉ-đọc.
 *
 * `true` là lệnh chỉ-đọc luôn-an-toàn trong `READ_ONLY_COMMANDS`, nên phần còn
 * lại của câu (trước/sau vòng lặp) vẫn được xét như thường. Thay bằng MỘT từ
 * giữ nguyên các toán tử kề nó (`|`, `&&`, `>`, `2>&1`…) để `splitSegments`
 * phán đúng ngữ cảnh.
 */
const FOR_LOOP_PLACEHOLDER = 'true';

/**
 * Từ thay cho `$VAR`/`${VAR}` trong thân vòng lặp.
 *
 * Phải là một từ **không phải lệnh chỉ-đọc** để `$f arg` (VAR ở vị trí lệnh)
 * trở thành `__LOOPVAR__ arg` ⇒ tên lệnh lạ ⇒ loại. Nếu dùng `true` thì
 * `$f arg` sẽ thành `true arg` và bị nhận nhầm là chỉ-đọc.
 */
const LOOP_VAR_PLACEHOLDER = '__LOOPVAR__';

/** Một từ trong danh sách `in` phải là chữ thuần: không `$`, không `$(...)`. */
function isLiteralListWord(value) {
  return !value.includes('$') && !value.includes(SUBST_MARK);
}

/** Regex khớp chính xác `$VAR` hoặc `${VAR}` (không khớp `$VARX`, `$VAR_`). */
function loopVarPattern(loopVar) {
  const esc = loopVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\$\\{${esc}\\}|\\$${esc}(?![A-Za-z0-9_])`, 'g');
}

/**
 * `tokens[i]` có thể mở một LỆNH không? (đầu chuỗi, sau dấu tách, hoặc sau
 * `do`/`then`/`else`).
 *
 * Chỉ khi đúng vị trí này `for` mới là từ khoá vòng lặp. Nhờ vậy `cat for f`
 * (trong đó `for` chỉ là đối số) không bị đọc nhầm — và `cat` vẫn được xét bình
 * thường.
 */
function atCommandStart(tokens, i) {
  if (i === 0) return true;
  const prev = tokens[i - 1];
  if (prev.kind === 'op') return SEPARATOR_OPS.has(prev.value);
  return prev.value === 'do' || prev.value === 'then' || prev.value === 'else';
}

/**
 * Phân tích một vòng `for VAR in LIST; do BODY; done` bắt đầu ở `tokens[start]`.
 *
 * Trả `{ next }` khi **chứng minh được** vòng lặp chỉ-đọc, `null` cho mọi
 * trường hợp khác (cấu trúc không nhận ra, hoặc không chứng minh được an toàn).
 *
 * ## Vì sao an toàn
 *
 * Thân vòng lặp được kiểm bằng chính `tokensAreReadOnly` — cùng phép kiểm đang
 * dùng cho cả câu — sau khi thay `$VAR`/`${VAR}` bằng một từ placeholder. Nên:
 *
 *   - `cat "$f"` → `cat __LOOPVAR__` → chỉ-đọc ✓
 *   - `$f arg` (VAR ở VỊ TRÍ LỆNH) → `__LOOPVAR__ arg` → tên lệnh lạ → loại ✓
 *   - `rm $f` → `rm __LOOPVAR__` → `rm` không chỉ-đọc → loại ✓
 *   - `cat $f > out` → redirect ghi → `splitSegments` trả `null` → loại ✓
 *
 * Danh sách `in` chỉ nhận **từ literal** (glob là tên file, cho qua). Mọi `$`,
 * `$(...)`, redirect, heredoc, hay lồng cấu trúc điều khiển đều bị loại.
 *
 * Nghi ngờ một chiều: bất kỳ điều kiện nào không thoả ⇒ `null` ⇒ rơi xuống Jev.
 */
function parseForLoop(tokens, start) {
  let j = start + 1;

  const varTok = tokens[j];
  if (varTok === undefined || varTok.kind !== 'word') return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varTok.value)) return null;
  const loopVar = varTok.value;
  j += 1;

  const inTok = tokens[j];
  if (inTok === undefined || inTok.kind !== 'word' || inTok.value !== 'in') return null;
  j += 1;

  // Danh sách sau `in`: chỉ từ literal, dừng ở `do` hoặc dấu tách.
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.kind === 'word' && t.value === 'do') break;
    if (t.kind !== 'word') break;
    if (!isLiteralListWord(t.value)) return null;
    j += 1;
  }

  if (tokens[j]?.kind === 'op' && SEPARATOR_OPS.has(tokens[j].value)) j += 1;
  const doTok = tokens[j];
  if (doTok === undefined || doTok.kind !== 'word' || doTok.value !== 'do') return null;
  j += 1;

  // Thân: tới `done` đầu tiên Ở VỊ TRÍ MỞ LỆNH (không cho lồng cấu trúc).
  // `done` là đối số (`echo "done"`) không kết thúc vòng lặp.
  const bodyStart = j;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.kind === 'word' && t.value === 'done' && atCommandStart(tokens, j)) break;
    j += 1;
  }
  if (j >= tokens.length) return null; // thiếu `done`
  const body = tokens.slice(bodyStart, j);
  if (body.length === 0) return null; // thân rỗng: cấu trúc không hợp lệ
  j += 1;

  // Sau `done` phải là dấu tách, hết câu, hoặc tiền tố fd của redirect (`2>&1`).
  const after = tokens[j];
  const afterIsFdPrefix = after?.kind === 'word' && /^\d+$/.test(after.value)
    && tokens[j + 1]?.kind === 'op' && REDIRECT_OPS.has(tokens[j + 1].value);
  if (after !== undefined && !afterIsFdPrefix
      && !(after.kind === 'op' && SEPARATOR_OPS.has(after.value))) return null;

  const pattern = loopVarPattern(loopVar);
  const substituted = [];
  for (let k = 0; k < body.length; k += 1) {
    const t = body[k];
    if (t.kind === 'op') {
      if (t.value === '<<') return null; // heredoc: nội dung tuỳ ý
      substituted.push(t);
      continue;
    }
    if (t.value.includes(SUBST_MARK)) return null;       // `$(...)` trong thân
    // Từ khoá điều khiển ở VỊ TRÍ MỞ LỆNH ⇒ lồng cấu trúc ⇒ không chứng minh
    // được. Ở vị trí đối số (`cat for`) thì vô hại, cho qua.
    if (COMPOUND_KEYWORDS.has(t.value) && atCommandStart(body, k)) return null;
    let value = t.value;
    if (value.includes('$')) {
      value = value.replace(pattern, LOOP_VAR_PLACEHOLDER);
      // Còn `$` ⇒ biến KHÁC loop var, `${VAR:-x}`, `$1`… ⇒ không chứng minh được.
      if (value.includes('$')) return null;
    }
    substituted.push({ kind: 'word', value });
  }

  if (!tokensAreReadOnly(substituted)) return null;
  return { next: j };
}

/**
 * Thay mọi vòng `for` đã chứng minh chỉ-đọc bằng một token placeholder.
 *
 * Vòng `for` ở vị trí mở lệnh nhưng KHÔNG chứng minh được sẽ bị để nguyên: khi
 * đó `for` rơi vào `wordsAreReadOnly` như một lệnh lạ ⇒ cả câu trả `false`, đúng
 * như mong muốn.
 */
function rewriteForLoops(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'word' && t.value === 'for' && atCommandStart(tokens, i)) {
      const res = parseForLoop(tokens, i);
      if (res !== null) {
        out.push({ kind: 'word', value: FOR_LOOP_PLACEHOLDER });
        i = res.next;
        continue;
      }
    }
    out.push(t);
    i += 1;
  }
  return out;
}

/**
 * Xét một DÃY TOKEN đã tách xem có chỉ-đọc không (không tokenize lại).
 *
 * Dùng chung cho cả câu và cho thân vòng `for` (đã thay placeholder).
 */
function tokensAreReadOnly(tokens) {
  const segments = splitSegments(tokens);
  if (segments === null) return false;
  for (const segment of segments) {
    if (!wordsAreReadOnly(segment)) return false;
  }
  return true;
}

/** `sed` chỉ-đọc? Ghi chỉ qua `-i` và lệnh `w`/`W`/`e` trong script. */
function sedIsReadOnly(words) {
  const scripts = [];
  let i = 1; // bỏ qua chính `sed`
  while (i < words.length) {
    const token = words[i];
    if (token === '-e' || token === '--expression') {
      if (words[i + 1] === undefined) return false;
      scripts.push(words[i + 1]);
      i += 2;
      continue;
    }
    if (token.startsWith('-e') && token.length > 2) { scripts.push(token.slice(2)); i += 1; continue; }
    if (token === '-f' || token === '--file' || (token.startsWith('-f') && token.length > 2)) {
      return false; // script nằm trong file: không đọc được nội dung
    }
    if (token === '--in-place') return false;
    if (token.startsWith('--')) { i += 1; continue; }
    if (token.startsWith('-')) {
      if (token.slice(1).includes('i')) return false; // `-i`, `-i.bak`, `-ni`…
      i += 1;
      continue;
    }
    if (scripts.length === 0) { scripts.push(token); i += 1; continue; }
    break; // phần còn lại là file đầu vào
  }
  if (scripts.length === 0) return false;
  for (const script of scripts) {
    if (!sedScriptIsReadOnly(script)) return false;
  }
  return true;
}

/**
 * Soi một script `sed` xem có lệnh ghi không.
 *
 * Đây là parser thật, không phải quét ký tự. Quét ký tự từng sai theo cả hai
 * hướng và cả hai đều là lỗi thật:
 *
 *   - **Bỏ lọt**: `sed 's/a/b/w out'` và `sed 's/a/b/e'` — chữ `w`/`e` là *cờ*
 *     của lệnh `s`, không phải ký tự trong pattern.
 *   - **Loại oan**: `sed -n '/rawCommandOf/,/^}/p'` — địa chỉ regex chứa chữ
 *     `w` (trong `rawCommandOf`) và `}`; quét thô tưởng đó là lệnh ghi.
 *
 * Parser đi đúng thứ tự cú pháp sed: địa chỉ (`/re/`, `\#re#`, `$`, số) →
 * phủ định `!` → ký tự lệnh → tham số của lệnh đó. Chỉ ba đường mới ghi được:
 * lệnh `w`/`W` (ghi file), `e` (chạy shell), và cờ `w`/`e` của lệnh `s`.
 *
 * Lệnh không nhận ra ⇒ `false` (đi qua Jev), không đoán.
 */
function sedScriptIsReadOnly(script) {
  const n = script.length;
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === ';';

  /** Bỏ một regex phân cách bằng `delim` (đã ở ngay sau delimiter mở). */
  const skipRegex = (delim) => {
    i += 1; // bỏ delimiter mở
    while (i < n) {
      if (script[i] === '\\') { i += 2; continue; }
      if (script[i] === delim) { i += 1; return true; }
      i += 1;
    }
    return false;
  };

  const skipAddress = () => {
    while (i < n && (script[i] === ' ' || script[i] === '\t')) i += 1;
    if (i >= n) return false;
    const c = script[i];
    if (c === '/') return skipRegex('/');
    if (c === '\\') {
      const delim = script[i + 1];
      if (delim === undefined) return false;
      i += 1;
      return skipRegex(delim);
    }
    if (c === '$') { i += 1; return true; }
    if (isDigit(c)) { while (i < n && isDigit(script[i])) i += 1; return true; }
    return false;
  };

  while (i < n) {
    while (i < n && isSpace(script[i])) i += 1;
    if (i >= n) break;

    // Địa chỉ: 0–2, phân cách bằng `,`
    const first = script[i];
    if (first === '/' || first === '$' || isDigit(first) || first === '\\') {
      if (!skipAddress()) return false;
      while (i < n && (script[i] === ' ' || script[i] === '\t')) i += 1;
      if (script[i] === ',') {
        i += 1;
        if (!skipAddress()) return false;
      }
      while (i < n && (script[i] === ' ' || script[i] === '\t')) i += 1;
    }
    if (script[i] === '!') { i += 1; while (i < n && (script[i] === ' ' || script[i] === '\t')) i += 1; }
    if (i >= n) break;

    const cmd = script[i];
    i += 1;

    // Chú thích: tới hết dòng.
    if (cmd === '#') { while (i < n && script[i] !== '\n') i += 1; continue; }

    // Lệnh `s` và `y` có tham số phân cách bằng delimiter.
    if (cmd === 's' || cmd === 'y') {
      const delim = script[i];
      if (delim === undefined || /[A-Za-z0-9\\\s]/.test(delim)) return false;
      i += 1; // tiêu thụ delimiter MỞ (ngay sau `s`/`y`)
      // Còn đúng HAI delimiter đóng: kết thúc PATTERN và kết thúc REPLACEMENT.
      let seen = 0;
      while (i < n && seen < 2) {
        if (script[i] === '\\') { i += 2; continue; }
        if (script[i] === delim) { seen += 1; i += 1; continue; }
        i += 1;
      }
      if (seen < 2) return false;
      if (cmd === 'y') continue;
      // Cờ của `s` chạy tới khoảng trắng/dấu `;`. `w` ghi file, `e` chạy shell.
      const start = i;
      while (i < n && !isSpace(script[i])) i += 1;
      if (/[eEwW]/.test(script.slice(start, i))) return false;
      continue;
    }

    // Ba đường ghi duy nhất còn lại.
    if (cmd === 'w' || cmd === 'W') return false; // ghi file
    if (cmd === 'e') return false;                // chạy shell

    // Lệnh có tham số chạy tới hết dòng. `a`/`i`/`c` lấy văn bản tuỳ ý (có thể
    // chứa `w`), `r`/`R`/`b`/`t`/`T`/`:` lấy tên file hoặc nhãn.
    if ('aicrRbtTqQ='.includes(cmd)) {
      while (i < n && script[i] !== '\n') i += 1;
      continue;
    }

    // Lệnh không tham số đã biết.
    if ('pPdDnNhHgGxzF'.includes(cmd) || cmd === '{' || cmd === '}') continue;

    return false; // lệnh lạ ⇒ không kết luận
  }
  return true;
}

/** `git` chỉ-đọc? Chỉ nhận subcommand trong danh sách trắng. */
function gitIsReadOnly(words) {
  // Cờ chạy chương trình ngoài hoặc ghi file ⇒ loại ngay, dù subcommand đọc được.
  // `git --ext-diff`/`--textconv` gọi diff ngoài; `--output` ghi ra file.
  if (words.some((w) => /^--ext-diff|^--textconv|^--output|^--pager/.test(w))) return false;

  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    i += GIT_GLOBAL_FLAGS_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  if (sub === undefined) return false;
  return GIT_READ_ONLY.has(sub);
}

/** `find` chỉ-đọc? `-ls` chỉ in; `-delete`/`-exec`/`-fprint*` thì không. */
function findIsReadOnly(words) {
  return !words.some((w) => FIND_WRITE_FLAGS.has(w));
}

/**
 * `awk` chỉ-đọc?
 *
 * `awk` ghi qua `print > file`, chạy shell qua `system()`/`|`, và đọc script từ
 * file qua `-f`. Bất kỳ dấu hiệu nào trong số đó đều đẩy sang Jev.
 */
function awkIsReadOnly(words) {
  const joined = words.join(' ');
  if (/-f\b|--file\b/.test(joined)) return false; // script trong file: không đọc được
  if (/system\s*\(/.test(joined)) return false;
  if (/close\s*\(/.test(joined)) return false;
  if (/>/.test(joined)) return false; // print > file
  if (/\|/.test(joined)) return false; // print | "cmd"
  return true;
}

/**
 * `env` hai mặt: `env CMD` và `env -i CMD` chạy CMD, còn `env` trần chỉ in biến.
 */
function envIsReadOnly(words) {
  let k = 1;
  while (k < words.length && words[k].startsWith('-')) k += 1;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k += 1;
  if (k >= words.length) return true; // `env` trần
  return wordsAreReadOnly(words.slice(k));
}

/**
 * `command` hai mặt: `command -v CMD` chỉ tra cứu, còn `command CMD` CHẠY CMD.
 *
 * `command -v rm` không chạy gì; `command rm -rf /` xoá thật. Chỉ nhận dạng
 * tra cứu (`-v`/`-V`).
 */
function commandIsReadOnly(words) {
  const flags = words.slice(1).filter((w) => w.startsWith('-'));
  if (flags.length === 0) return false; // `command CMD` chạy CMD
  return flags.every((f) => f === '-v' || f === '-V' || f === '-p' || f === '--');
}

/**
 * `curl` chỉ-đọc?
 *
 * ## ALLOWLIST, không phải denylist — và đây là lần sửa thứ ba
 *
 * Hai bản trước liệt kê cờ NGUY HIỂM. Cả hai đều lọt, mỗi lần phải thử thật mới thấy:
 *
 *   - bản 1: so `^--flag$` nên không khớp `--flag=value` → lọt 7 dạng
 *   - bản 2: thêm khớp tiền tố, vẫn lọt `-D` (ghi header ra file),
 *     `-c`/`--cookie-jar` (ghi cookie jar), `--libcurl` (ghi C source),
 *     `-w '%output{file}'` (ghi file), `--stderr file`
 *
 * `curl` có **hơn 200 cờ** và mỗi phiên bản lại thêm. Liệt kê cờ nguy hiểm là
 * danh sách KHÔNG BAO GIỜ đầy. Nên đảo chiều: chỉ cho qua khi CHỨNG MINH được
 * là an toàn.
 *
 * ## Quy tắc
 *
 * Chỉ-đọc khi MỌI token là:
 *   1. URL (`scheme://…`), hoặc
 *   2. cờ nằm trong allowlist dưới đây, hoặc
 *   3. giá trị của một cờ allowlist CÓ giá trị.
 *
 * Cờ LẠ → `false` → đi qua Jev. Thà tốn một call còn hơn lọt một lệnh ghi.
 *
 * ## Vì sao `-w` bị loại nhưng `-H` được
 *
 * `-w '%{json}'` in ra stdout (an toàn), nhưng `-w '%output{file}x'` GHI FILE.
 * Phân biệt hai dạng này đòi phân tích nội dung chuỗi — đúng kiểu phân tích dễ
 * sai. Loại `-w` luôn: mất ít, và `-w` hiếm trong 11.349 lệnh thật.
 *
 * `-o /dev/null` cũng bị loại theo nguyên tắc "cờ lạ thì loại" — đơn giản và an
 * toàn hơn là đặc cách cho `/dev/null`.
 */
function curlIsReadOnly(words) {
  const rest = words.slice(1);
  /** Cờ ngắn chỉ-đọc KHÔNG giá trị; gộp được trong cụm (`-sSL`). */
  const SAFE_FLAG_ONLY = new Set(['s', 'S', 'i', 'I', 'L', 'k', 'v', 'g', 'f', 'n', 'N', 'q', 'R', 'B', 'j', '4', '6', 'G', 'a', 'p', 'C', 'M']);
  /**
   * Cờ ngắn chỉ-đọc CÓ giá trị (`-m 5`, `-H 'X: y'`, `-u user:pass`).
   *
   * KHÔNG có `b`/`c`/`e`: `-b`/`--cookie` nạp cookie từ file (đọc, nhưng kèm
   * `--cookie-jar` thành ghi), `-c`/`--cookie-jar` GHI file cookie, `-e` chỉ đặt
   * Referer nhưng nằm cùng nhóm dễ nhầm. Loại cả ba cho nhất quán — mất rất ít,
   * đo trên 11.349 lệnh thật thì không lệnh nào dùng chúng.
   */
  const SAFE_VALUE_SHORT = new Set(['m', 'H', 'u', 'A', 'x', 'y', 'Y', 't', 'E', 'Q']);
  /** Cờ dài chỉ-đọc KHÔNG giá trị. */
  const SAFE_LONG_FLAG = new Set([
    'silent', 'show-error', 'include', 'head', 'location', 'location-trusted',
    'insecure', 'verbose', 'globoff', 'fail', 'fail-with-body', 'netrc',
    'netrc-optional', 'no-buffer', 'compressed', 'compressed-ssh', 'ipv4',
    'ipv6', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'get',
    'raw', 'no-progress-meter', 'progress-bar', 'tcp-nodelay', 'anyauth',
    'basic', 'digest', 'negotiate', 'ntlm', 'cert-status', 'path-as-is',
    'remote-time', 'no-keepalive', 'keepalive', 'ssl', 'ssl-reqd', 'tlsv1.2',
    'tlsv1.3', 'version', 'help', 'manual',
  ]);
  /** Cờ dài chỉ-đọc CÓ giá trị (`--max-time 5`, `--max-time=5`). */
  const SAFE_LONG_VALUE = new Set([
    'user-agent', 'max-time', 'connect-timeout', 'retry', 'retry-delay',
    'retry-max-time', 'range', 'limit-rate', 'proxy', 'noproxy', 'resolve',
    'cacert', 'capath', 'cert', 'key', 'ciphers', 'tls-max', 'interface',
    'local-port', 'max-filesize', 'header', 'url', 'request-target',
    'happy-eyeballs-timeout-ms', 'aws-sigv4', 'cert-type', 'key-type',
    'crlfile', 'pinnedpubkey', 'tls13-ciphers', 'proxy-user', 'proxy-header',
    'connect-to', 'dns-servers', 'random-file',
  ]);
  const isUrl = (token) => /^[a-z][a-z0-9+.-]*:\/\//i.test(token);

  for (let k = 0; k < rest.length; k += 1) {
    const w = rest[k];
    if (w === '--') continue;
    if (isUrl(w)) continue;
    // Token trần không phải URL: cờ trước đã tiêu thụ giá trị của nó rồi, nên
    // tới đây mà còn thì là đối số lạ → loại.
    if (!w.startsWith('-')) return false;

    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (SAFE_LONG_FLAG.has(name)) {
        if (eq >= 0) return false; // cờ không-giá-trị mà có `=`: hình dạng lạ
        continue;
      }
      if (SAFE_LONG_VALUE.has(name)) {
        if (eq < 0) k += 1;        // tiêu thụ token kế làm giá trị
        continue;
      }
      return false;                // cờ dài lạ → loại
    }

    // Cụm cờ ngắn: `-sSL`, `-m5`, `-Hfoo`.
    const body = w.slice(1);
    for (let j = 0; j < body.length; j += 1) {
      const c = body[j];
      if (SAFE_FLAG_ONLY.has(c)) continue;
      if (SAFE_VALUE_SHORT.has(c)) {
        if (j === body.length - 1) k += 1; // giá trị là token kế
        break;                              // hết cụm: phần sau là giá trị
      }
      return false;                // cờ ngắn lạ → loại
    }
  }
  return true;
}

/**
 * `node --check` chỉ-đọc?
 *
 * `--check` chỉ PHÂN TÍCH CÚ PHÁP rồi thoát, không chạy script. An toàn tuyệt
 * đối — nhưng chỉ khi không kèm cờ chạy code (`-e`, `-p`, `-r`), vì thứ tự cờ
 * có thể làm node chạy thật.
 */
function nodeIsReadOnly(words) {
  const rest = words.slice(1);
  if (!rest.includes('--check')) return false;
  return !rest.some((w) => /^(-e|--eval|-p|--print|-r|--require|--import)$/.test(w) || /^-e./.test(w));
}

/**
 * `dsh` chỉ-đọc?
 *
 * `dsh plugin list`, `dsh --version`, `dsh --help`, `dsh plugin --help` chỉ đọc
 * và in. Mọi subcommand khác (`dsh plugin add`, `dsh web`, …) có thể ghi state
 * nên đi qua Jev.
 *
 * Lưu ý: phải xét TÊN LỆNH đã tách khỏi đường dẫn — `\bdsh\b` quét chuỗi thô
 * từng khớp cả `~/.dsh/...` và giết oan 2.100 lệnh (xem đầu file).
 */
function dshIsReadOnly(words) {
  const rest = words.slice(1);
  if (rest.some((w) => w === '--version' || w === '-v' || w === '--help' || w === '-h')) return true;
  // Bỏ qua cờ toàn cục tiêu thụ một giá trị (`--profile web`) ở bất kỳ đâu trước
  // hoặc sau subcommand — DSH nhận cả `dsh --profile web plugin list` và
  // `dsh plugin list --profile web`.
  const cleaned = [];
  for (let k = 0; k < rest.length; k += 1) {
    if (rest[k] === '--profile' || rest[k] === '-p') { k += 1; continue; }
    cleaned.push(rest[k]);
  }
  if (cleaned[0] !== 'plugin') return false;
  return cleaned.slice(1).every((w) => w === 'list' || w === '--help' || w === '-h');
}

/**
 * Xét một đoạn lệnh (mảng từ) xem có chỉ-đọc không.
 */
function wordsAreReadOnly(words) {
  if (words.length === 0) return true;

  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  if (i >= words.length) return true; // thuần gán biến

  let guard = 0;
  while (i < words.length && WRAPPERS.has(words[i]) && guard < 8) {
    const wrapper = words[i];
    i += 1;
    guard += 1;
    while (i < words.length && words[i].startsWith('-')) i += 1;
    if (WRAPPER_NUMERIC_ARG.has(wrapper)) {
      while (i < words.length && /^[\d.]+[smhd]?$/.test(words[i])) i += 1;
    }
    while (i < words.length && SUBCOMMAND_SKIP.has(words[i])) i += 1;
    if (i >= words.length) return false;
  }

  const command = words[i];
  if (command === undefined) return false;
  const base = command.split('/').pop(); // `/usr/bin/ls` → `ls`
  const rest = words.slice(i + 1);

  // Lệnh luôn ghi, bất kể cờ.
  if (ALWAYS_WRITE_COMMANDS.has(base)) return false;

  // Lệnh mà đối số vị trí thứ N là file ghi.
  const maxPositional = POSITIONAL_OUTPUT_COMMANDS.get(base);
  if (maxPositional !== undefined) return positionalCount(rest) < maxPositional;

  // Lệnh có logic riêng phải xử lý TRƯỚC bảng cờ, nếu không bảng cờ sẽ bỏ qua
  // subcommand: `git reset --hard` từng lọt vì `git` khớp bảng cờ rồi trả về
  // "không có cờ ghi" mà không hề xét `reset` là nhánh ghi.
  if (base === 'git') return gitIsReadOnly(words.slice(i));
  if (base === 'sed') return sedIsReadOnly(words.slice(i));
  if (base === 'find') return findIsReadOnly(words.slice(i));
  if (base === 'awk') return awkIsReadOnly(words.slice(i));
  if (base === 'env') return envIsReadOnly(words.slice(i));
  if (base === 'command') return commandIsReadOnly(words.slice(i));
  if (base === 'curl') return curlIsReadOnly(words.slice(i));
  if (base === 'node') return nodeIsReadOnly(words.slice(i));
  if (base === 'dsh') return dshIsReadOnly(words.slice(i));

  // Lệnh chỉ-đọc *có điều kiện*: cờ ghi phải được kiểm riêng cho từng lệnh,
  // không kiểm chung toàn câu (`-o` khác nghĩa ở `grep` và `sort`).
  const conditional = CONDITIONAL_COMMANDS[base];
  if (conditional !== undefined) {
    return !rest.some((w) => conditional.rejectFlags.some((re) => re.test(w)));
  }

  return READ_ONLY_COMMANDS.has(base);
}

/**
 * `true` chỉ khi chứng minh được lệnh không thể ghi/đổi dữ liệu đã tồn tại.
 *
 * Fail-safe một chiều: mọi nghi ngờ ⇒ `false` ⇒ lệnh vẫn đi qua Jev.
 */
export function isProvablyReadOnly(command, depth = 0) {
  if (typeof command !== 'string') return false;
  const raw = command.trim();
  if (!raw) return false;
  if (depth > 4) return false;

  const parsed = tokenize(raw);
  if (parsed === null) return false;

  // Lệnh con trong `$(...)` cũng phải chỉ-đọc, nếu không thì cả câu không an toàn.
  for (const inner of parsed.subs) {
    if (!isProvablyReadOnly(inner, depth + 1)) return false;
  }

  // Vòng `for` chỉ-đọc được chứng minh riêng rồi thu về một token `true`, nên
  // phần còn lại của câu vẫn được xét với đúng ngữ cảnh toán tử của nó.
  return tokensAreReadOnly(rewriteForLoops(parsed.tokens));
}
