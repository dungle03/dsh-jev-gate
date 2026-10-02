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
 *   - tạo lại filesystem (`mkfs.*`, `wipefs`, `blkdiscard`)
 *   - fork bomb
 *   - đổi quyền toàn hệ thống (`chmod -R 777 /`)
 *
 * Đây là sàn an toàn, không phải bộ lọc thông minh. Nó chạy **không cần mạng**,
 * không cần Jev, nên không có đường fail-open.
 *
 * ## Ghi đè
 *
 * `enableCatastrophicFloor: false` tắt hẳn. Khi bị chặn, thông báo nói rõ đây là
 * sàn tất định (không phải phán đoán của Jev) để operator biết cách xử lý.
 */

/**
 * Thiết bị khối: ghi vào đây là mất dữ liệu ở tầng phần cứng.
 * Khớp `/dev/sd*`, `/dev/nvme*`, `/dev/vd*`, `/dev/hd*`, `/dev/mmcblk*`,
 * `/dev/disk*`, và `/dev/mapper/*`.
 */
const BLOCK_DEVICE = String.raw`\/dev\/(?:sd|nvme|vd|hd|mmcblk|disk|mapper|loop|dm-)[A-Za-z0-9\/_-]*`;

/**
 * Mẫu lệnh phá huỷ toàn hệ thống. Mỗi mục là một quan hệ nhân quả chắc chắn —
 * không phải "có thể nguy hiểm", mà "nếu chạy thì mất dữ liệu không lấy lại được".
 */
const CATASTROPHIC = [
  // Xoá từ gốc filesystem. `rm -rf /` và các biến thể glob/đường dẫn tương đối.
  {
    id: 'rm-root',
    // `rm` với `-r`/`-f`/`-rf`/`--recursive`/`--force` và đích là `/`, `/*`, `~`, `$HOME`, `.`
    // ở gốc — KHÔNG khớp `/tmp/...` hay `./build`.
    pattern: new RegExp(
      String.raw`\brm\b(?=[^|;&]*\s-{1,2}[A-Za-z-]*[rf])[^|;&]*\s(?:-{1,2}[A-Za-z-]+\s+)*`
      + String.raw`(?:--\s+)?(?:\/|/\\\*|\/\*|\*|~\/?\*?|\$HOME\/?\*?|\.\/\*?)(?:\s|$|;|\||&)`,
    ),
  },
  // `mkfs.ext4 /dev/sda1`, `wipefs -a /dev/sdb`, `blkdiscard /dev/nvme0n1`
  {
    id: 'mkfs-or-wipe',
    pattern: new RegExp(String.raw`\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|blkdiscard)\b[^|;&]*`, 'i'),
  },
  // `dd if=... of=/dev/sda` — ghi đè thiết bị
  {
    id: 'dd-to-device',
    pattern: new RegExp(String.raw`\bdd\b[^|;&]*\bof\s*=\s*${BLOCK_DEVICE}`, 'i'),
  },
  // `> /dev/sda`, `cat x > /dev/nvme0n1`
  {
    id: 'redirect-to-device',
    pattern: new RegExp(String.raw`>>?\s*${BLOCK_DEVICE}`),
  },
  // Fork bomb: `:(){ :|:& };:` và biến thể
  {
    id: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/,
  },
  // `chmod -R 777 /` — mở toàn quyền cả hệ thống
  {
    id: 'chmod-root',
    pattern: /\bchmod\b[^|;&]*\s-{1,2}[A-Za-z-]*R[^|;&]*\s(?:\/|~|\$HOME)\s*(?:$|;|\||&)/,
  },
  // `mv /* /dev/null`, `mv ~ /dev/null`
  {
    id: 'mv-root-to-null',
    pattern: /\bmv\b[^|;&]*\s(?:\/\*|\/|~|\$HOME)\s+[^|;&]*\/dev\/null/,
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
  const raw = command.trim();
  if (!raw) return undefined;
  for (const { id, pattern } of CATASTROPHIC) {
    if (pattern.test(raw)) return id;
  }
  return undefined;
}
