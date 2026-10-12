/**
 * Sàn tất định cho các lệnh PHÁ HUỶ TOÀN HỆ THỐNG.
 *
 * ## Vì sao cần, khi đã có Jev
 *
 * Gate hiện dựa vào Jev, và Jev **fail-open**: đo trên log thật, 252/6.442 lần
 * (3,9%) gate gọi Jev thất bại (timeout, abort) và lệnh đi thẳng. Với một guard
 * an toàn thì đó là lỗ hổng thiết kế: API lỗi ⇒ `rm -rf /` chạy.
 *
 * Tài liệu `jev-1.13` cũng nói thẳng state gửi vào có thể bị viết để lái câu trả
 * lời, nên lớp phán đoán **không được** là thứ cuối cùng chắn giữa input không
 * tin cậy và hành động không hoàn tác được. Cả `dsh-jev-tools` và
 * `dsh-jev-verify` đều áp dụng nguyên tắc này: **blacklist tất định chạy TRƯỚC,
 * Jev chỉ phán đoán phần còn lại**.
 *
 * ## Phạm vi: chỉ những gì KHÔNG THỂ hoàn tác và KHÔNG THỂ biện minh
 *
 * Danh sách này CỐ Ý hẹp. Nó không chặn `rm -rf /tmp/x` (thư mục tạm — việc
 * hợp lệ) hay `rm -rf node_modules` (dọn dẹp hợp lệ). Nó chỉ chặn những lệnh
 * phá huỷ ở tầng hệ thống, nơi hậu quả không khôi phục được bằng cách thông
 * thường:
 *
 *   - xoá từ gốc filesystem (`rm -rf /`)
 *   - ghi đè thiết bị khối (`dd of=/dev/sda`, `> /dev/nvme0n1`)
 *   - tạo lại filesystem (`mkfs.*`, `wipefs`, `blkdiscard` + thiết bị khối)
 *   - fork bomb
 *   - đổi quyền toàn hệ thống (`chmod -R 777 /`)
 *
 * Đây là sàn an toàn, không phải bộ lọc thông minh. Nó chạy **không cần mạng**,
 * không cần Jev, nên không có đường fail-open.
 *
 * ## Bốn luật phân tích khiến sàn không bắt nhầm (bản này)
 *
 * Bản trước khớp mẫu bằng `[^|;&]*` — lớp này **ăn cả `\n`**, nên một chữ `/`
 * nằm ở DÒNG SAU vẫn bị coi là đích của `rm`. Đo trên log thật: 47/47 dòng
 * `deny_catastrophic` đều là bắt nhầm (0 lệnh thật), trong đó 20/20 dòng
 * `mkfs-or-wipe` chỉ là chuỗi `mkfs` nằm trong heredoc hoặc trong đối số `grep`.
 *
 * Ba luật dưới đây sửa đúng lớp lỗi đó, và mỗi luật có ca test đối chứng:
 *
 *   1. **Neo vị trí lệnh** (`COMMAND_START`): token phá huỷ phải nằm ở chỗ shell
 *      thật sự gọi nó — đầu chuỗi, sau `\n ; & | ( {`, sau một launcher
 *      (`sudo`, `do`, `xargs`, …), hoặc sau `-c "`/`-c '`. Nhờ vậy
 *      `grep -n "mkfs" CHANGELOG.md` hay `ls tests/mkfs-floor.test.mjs` KHÔNG
 *      còn khớp: `mkfs` ở đó bị chặn bởi dấu `"` hoặc `/` phía trước.
 *   2. **Cấm khớp xuyên dòng**: mọi lớp ký tự tự do đổi từ `[^|;&]` thành
 *      `[^|;&\n]`, và mọi khoảng trắng đổi từ `\s` thành `[ \t]`. Đích của
 *      `rm`/`dd` phải nằm CÙNG DÒNG với lệnh.
 *   3. **Bỏ thân heredoc** (`stripHeredocs`): phần giữa `<<'EOF'` và dòng `EOF`
 *      là DỮ LIỆU, không phải lệnh. Script tự-kiểm của repo hay nhúng
 *      `rm -rf /` trong heredoc để làm ca test — nếu không bỏ, chính nó bị chặn.
 *   4. **Trung hoà dấu phân cách trong nháy** (`neutralizeQuotedSeparators`):
 *      `;`/`&`/`|` bên trong một chuỗi nháy là dữ liệu, không phải ranh giới
 *      lệnh. `echo "x; mkfs.ext4 /dev/sda1"` chỉ in một chuỗi — nhưng luật (1)
 *      coi `;` là ranh giới, nên `mkfs` trong đó bị tính là "đang được gọi".
 *      Hàm này thay `; & | \n` trong thân nháy bằng khoảng trắng, TRỪ payload
 *      của `sh -c "…"`/`bash -c "…"`/`eval "…"` — ở đó một shell mới phân tích
 *      chuỗi đó, nên dấu `;` LÀ ranh giới lệnh thật.
 *
 * Kèm theo, `mkfs-or-wipe` nay đòi thêm một **thiết bị khối** cùng dòng
 * (`mkfs.ext4 /dev/sda1`), vì tạo filesystem trên một tệp thường
 * (`mkfs.ext4 image.img`) là việc hợp lệ, không phá gì.
 *
 * ## Giới hạn đã biết (cố ý, không phải sơ suất)
 *
 * Sàn là bộ lọc CÚ PHÁP trên chuỗi lệnh, không phải trình phân tích shell. Nó
 * KHÔNG bắt payload nằm trong dấu nháy của một trình thông dịch lồng
 * (`node -e "...execSync('rm -rf /')"`, `python3 -c "os.system('mkfs…')"`). Đó
 * là chủ ý: nếu quét cả payload trong nháy thì mọi script tự-kiểm của repo (vốn
 * chứa các chuỗi này làm dữ liệu) đều bị chặn — đúng lớp lỗi vừa sửa. Với dạng
 * lồng nhau, lớp phán đoán (Jev) vẫn chạy, và đó là giới hạn được ghi nhận, không
 * phải lỗ hổng bị bỏ quên.
 *
 * ## Ghi đè
 *
 * `enableCatastrophicFloor: false` tắt hẳn. Khi bị chặn, thông báo nói rõ đây là
 * sàn tất định (không phải phán đoán của Jev) để operator biết cách xử lý.
 */

/**
 * Thiết bị khối: ghi vào đây là mất dữ liệu ở tầng phần cứng.
 * Khớp `/dev/sd*`, `/dev/nvme*`, `/dev/vd*`, `/dev/hd*`, `/dev/mmcblk*`,
 * `/dev/disk*`, `/dev/mapper/*`, `/dev/loop*`, `/dev/dm-*`.
 */
const BLOCK_DEVICE = String.raw`\/dev\/(?:sd|nvme|vd|hd|mmcblk|disk|mapper|loop|dm-)[A-Za-z0-9\/_-]*`;

/**
 * Vị trí một lệnh THẬT SỰ được shell gọi.
 *
 * Gồm: đầu chuỗi; sau dấu phân cách `\n ; & | ( {`; sau một launcher chạy lệnh
 * con (`sudo`, `do`, `then`, `else`, `exec`, `nohup`, `time`, `env`, `command`,
 * `xargs`); sau `-c "`/`-c '` của `sh -c`/`bash -c`; và sau `eval "`/`eval '`.
 *
 * Nhờ neo này, một token chỉ được coi là "đang được gọi" khi nó đứng ở đầu một
 * lệnh — không phải khi nó là đối số của `grep`, một mục trong `ls`, hay một
 * chuỗi nằm trong nháy.
 */
const COMMAND_START = String.raw`(?:^|[\n;&|({]|(?:sudo|do|then|else|exec|nohup|time|env|command|xargs)[ \t]+|-c[ \t]+["']|eval[ \t]+["']?)[ \t]*`;

/**
 * Trình thông dịch đọc stdin như CODE, không như dữ liệu.
 *
 * `bash <<'EOF' … EOF` THI HÀNH thân heredoc — nếu bỏ thân đó thì sàn bị lách
 * đúng bằng cú pháp nó vừa học cách bỏ qua. `cat <<'EOF' … EOF` thì chỉ chép
 * thân ra file, nên thân là DỮ LIỆU.
 *
 * Vì vậy chỉ bỏ thân heredoc khi lệnh đứng trước `<<` KHÔNG nằm trong danh sách
 * này. Nhận dạng hơi rộng (bất kỳ từ nào khớp) là cố ý: khớp nhầm chỉ khiến sàn
 * quét thân như code — tức nghiêng về phía fail-closed.
 */
const STDIN_CODE_CONSUMERS = /(?:^|[^\w.-])(?:sh|bash|zsh|dash|ksh|ash|fish|csh|tcsh|python[0-9.]*|perl|ruby|node|php|lua|xargs|ssh|source|eval)(?=$|[^\w.-])/;

/**
 * Bỏ thân heredoc trước khi khớp mẫu.
 *
 * `<<'EOF' … EOF` (và `<<-EOF`, `<<"EOF"`, `<<EOF`) thường là DỮ LIỆU truyền
 * cho lệnh, không phải lệnh. Một script tự-kiểm nhúng `rm -rf /` trong heredoc
 * để làm ca test — nếu không bỏ, chính script đó bị sàn chặn.
 *
 * NGOẠI LỆ: khi lệnh nhận heredoc là một trình thông dịch (`bash <<'EOF'`,
 * `python <<'EOF'`), thân heredoc là CODE sẽ được thi hành, nên KHÔNG bỏ — giữ
 * lại để còn quét. Bỏ nó là tự tay mở một đường lách.
 *
 * Chỉ nhận dạng heredoc (`<<` theo sau là định danh), KHÔNG nhận here-string
 * (`<<<`) hay dịch bit (`echo $((1 << 2))`): ở cả hai, ký tự sau `<<` không phải
 * định danh hợp lệ nên không khớp.
 */
function stripHeredocs(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i += 1;
    // Thu mọi định danh heredoc mở trên dòng này (có thể có nhiều).
    const delims = [];
    const re = /<<(-?)[ \t]*(?:"([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const d = m[2] ?? m[3] ?? m[4];
      if (d) delims.push({ d, stripTabs: m[1] === '-', isCode: STDIN_CODE_CONSUMERS.test(line.slice(0, m.index)) });
    }
    for (const { d, stripTabs, isCode } of delims) {
      // Thân heredoc là CODE sẽ chạy: giữ nguyên để còn khớp mẫu.
      if (isCode) continue;
      // Bỏ các dòng thân cho tới dòng kết thúc bằng đúng định danh.
      while (i < lines.length) {
        const cand = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
        i += 1;
        if (cand.trim() === d) break;
      }
    }
  }
  return out.join('\n');
}

/**
 * Trung hoà dấu phân cách nằm TRONG dấu nháy.
 *
 * Dấu `;`/`&`/`|` bên trong một chuỗi nháy là DỮ LIỆU, không phải ranh giới lệnh:
 * `echo "x; mkfs.ext4 /dev/sda1"` chỉ in một chuỗi, nó không gọi `mkfs`. Nhưng
 * `COMMAND_START` coi `;` là ranh giới, nên nếu không trung hoà, `mkfs` trong
 * chuỗi đó bị tính là "đang được gọi" — đúng một lớp bắt nhầm.
 *
 * NGOẠI LỆ: payload của `sh -c "…"` / `bash -c "…"` (và `eval "…"`) là CODE shell
 * thật, một shell mới sẽ phân tích nó. Ở đó dấu `;` LÀ ranh giới lệnh thật, nên
 * phần thân được giữ nguyên.
 *
 * Chỉ thay `; & |` và `\n` bằng khoảng trắng — KHÔNG thay `(`, `)`, `` ` ``, để
 * `$(…)` và backtick (vốn chạy lệnh thật) vẫn còn khả năng khớp.
 */
function neutralizeQuotedSeparators(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'") { out += ch; i += 1; continue; }
    const before = text.slice(0, i).replace(/[ \t]+$/, '');
    const isCode = /(?:^|[^A-Za-z0-9_-])-c$/.test(before) || /\beval$/.test(before);
    // Tìm dấu nháy đóng cùng loại, tôn trọng `\"` trong nháy kép.
    let j = i + 1;
    let body = '';
    while (j < n) {
      if (ch === '"' && text[j] === '\\') { body += text[j] + (text[j + 1] ?? ''); j += 2; continue; }
      if (text[j] === ch) break;
      body += text[j];
      j += 1;
    }
    const closing = text[j] ?? '';
    out += isCode ? ch + body + closing : ch + body.replace(/[;&|\n]/g, ' ') + closing;
    i = j + 1;
  }
  return out;
}

/**
 * Mẫu lệnh phá huỷ toàn hệ thống. Mỗi mục là một quan hệ nhân quả chắc chắn —
 * không phải "có thể nguy hiểm", mà "nếu chạy thì mất dữ liệu không lấy lại được".
 *
 * Mọi mẫu đều: (a) neo vào `COMMAND_START`, (b) không khớp xuyên `\n`.
 */
const CATASTROPHIC = [
  // Xoá từ gốc filesystem. `rm -rf /` và các biến thể glob/đường dẫn tương đối.
  {
    id: 'rm-root',
    // `rm` với `-r`/`-f`/`-rf`/`--recursive`/`--force` và đích là `/`, `/*`, `~`,
    // `$HOME`, `.` ở gốc — KHÔNG khớp `/tmp/...` hay `./build`. Đích phải cùng
    // dòng với `rm` (`[^|;&\n]`), và `rm` phải ở vị trí lệnh.
    pattern: new RegExp(
      COMMAND_START
      + String.raw`rm\b(?=[^|;&\n]*[ \t]-{1,2}[A-Za-z-]*[rf])[^|;&\n]*[ \t](?:-{1,2}[A-Za-z-]+[ \t]+)*`
      + String.raw`(?:--[ \t]+)?(?:\/|/\\\*|\/\*|\*|~\/?\*?|\$HOME\/?\*?|\.\/\*?)(?=[ \t\n]|$|;|\||&|\)|["'])`,
    ),
  },
  // `mkfs.ext4 /dev/sda1`, `wipefs -a /dev/sdb`, `blkdiscard /dev/nvme0n1`.
  // Đòi thêm thiết bị khối cùng dòng: tạo fs trên tệp thường (`image.img`) không
  // phá gì nên không thuộc sàn.
  {
    id: 'mkfs-or-wipe',
    pattern: new RegExp(
      COMMAND_START
      + String.raw`(?:mkfs(?:\.[a-z0-9]+)?|wipefs|blkdiscard)\b[^|;&\n]*`
      + BLOCK_DEVICE,
      'i',
    ),
  },
  // `dd if=... of=/dev/sda` — ghi đè thiết bị
  {
    id: 'dd-to-device',
    pattern: new RegExp(
      COMMAND_START + String.raw`dd\b[^|;&\n]*\bof[ \t]*=[ \t]*` + BLOCK_DEVICE,
      'i',
    ),
  },
  // `> /dev/sda`, `cat x > /dev/nvme0n1`
  {
    id: 'redirect-to-device',
    pattern: new RegExp(String.raw`>>?[ \t]*` + BLOCK_DEVICE),
  },
  // Fork bomb: `:(){ :|:& };:` và biến thể
  {
    id: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/,
  },
  // `chmod -R 777 /` — mở toàn quyền cả hệ thống
  {
    id: 'chmod-root',
    pattern: new RegExp(
      COMMAND_START
      + String.raw`chmod\b[^|;&\n]*[ \t]-{1,2}[A-Za-z-]*R[^|;&\n]*[ \t](?:\/|~|\$HOME)(?=[ \t\n]|$|;|\||&|\))`,
    ),
  },
  // `mv /* /dev/null`, `mv ~ /dev/null`
  {
    id: 'mv-root-to-null',
    pattern: new RegExp(
      COMMAND_START
      + String.raw`mv\b[^|;&\n]*[ \t](?:\/\*|\/|~|\$HOME)[ \t]+[^|;&\n]*\/dev\/null`,
    ),
  },
];

/**
 * `true` khi lệnh nằm trong sàn tất định.
 *
 * Thuần phân tích cú pháp: không mạng, không Jev, không I/O. Cùng đầu vào luôn
 * cùng đầu ra, nên không có đường fail-open.
 *
 * Trả kèm `id` để log biết mẫu nào khớp.
 */
export function catastrophicMatch(command) {
  if (typeof command !== 'string') return undefined;
  // Ba phép biến đổi chuỗi, theo thứ tự:
  //   1. Nối dòng tiếp (`\` + xuống dòng) TRƯỚC khi trim: `rm -rf \<newline>/` phải
  //      thành `rm -rf /` rồi mới cắt khoảng trắng, nếu trim trước thì dấu `\` ở
  //      cuối chuỗi sẽ phá mẫu.
  //   2. Bỏ thân heredoc — dữ liệu, không phải lệnh.
  //   3. Trung hoà dấu phân cách TRONG nháy — `;` trong `echo "x; mkfs…"` là dữ
  //      liệu, không phải ranh giới lệnh (trừ payload của `sh -c`/`eval`).
  const text = neutralizeQuotedSeparators(
    stripHeredocs(command.replace(/\\\r?\n/g, '')),
  ).trim();
  if (!text) return undefined;
  for (const { id, pattern } of CATASTROPHIC) {
    if (pattern.test(text)) return id;
  }
  return undefined;
}
