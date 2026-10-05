/**
 * §22 — NGÂN SÁCH VĂN BẢN PLUGIN CHÈN VÀO CONTEXT MỖI TURN.
 *
 * Sáu lớp đều chèn text vào context (L4 approach, L5 file, L6 recovery, L8
 * jevgrep, L2 completion, L7 review). Mỗi mảnh 100–300 token; một turn dài cộng
 * dồn thành hàng nghìn token nhiễu. Trần `maxPluginContextTokensPerTurn` (mặc
 * định 500) chặn điều đó.
 *
 * Bất biến:
 *   1. `safety` / `consent` / `real_user` KHÔNG BAO GIỜ bị cắt hay bỏ — cạn ngân
 *      sách không được biến một ràng buộc an toàn thành im lặng.
 *   2. Phần còn lại xếp theo ưu tiên `safety > recovery > completion > evidence >
 *      advisory` và cắt từ dưới lên khi vượt trần.
 *   3. `estimateTokens` ≈ chars/4 (đủ đúng cho tiếng Anh; text tiếng Việt bị ước
 *      LƯỢNG thấp hơn thực tế một chút, chấp nhận được vì trần là để chặn nhiễu).
 *
 * `evidence` là bậc riêng cho GỢI Ý FILE KÈM ĐOẠN TRÍCH (§8 Lớp 5). Nó phải
 * đứng TRÊN `advisory` thường: nếu xếp cùng bậc, gợi ý approach chung (L4, chèn
 * trước) sẽ thắng theo kiểu first-come và đẩy đoạn bằng chứng — thứ đáng giá
 * nhất của Lớp 5 — ra ngoài. Đo thật ở trần mặc định 500: approach 84 token +
 * bằng chứng 171 token = 255 > 250 (nửa trần dành cho advisory) nên bằng chứng
 * bị bỏ. Bậc riêng + dùng trọn trần cho `evidence` sửa đúng lỗi đó.
 *
 * Hàm thuần, không I/O — test được trực tiếp.
 */

/** Ưu tiên giữ lại khi vượt trần (số lớn = giữ trước). */
export const CONTEXT_PRIORITY = Object.freeze({
  safety: 4,
  recovery: 3,
  completion: 2,
  evidence: 1,
  advisory: 0,
});

/** Loại KHÔNG BAO GIỜ bị cắt/bỏ. */
export const CONTEXT_PROTECTED = Object.freeze(new Set(['safety', 'consent', 'real_user']));

/** Ước lượng token của một chuỗi: chars/4, làm tròn lên. */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : '';
  return Math.ceil(value.length / 4);
}

/**
 * §22 "semantic dedup — không bao giờ chèn cùng một gợi ý hai lần".
 *
 * Vân tay chuẩn hoá: gộp mọi khoảng trắng, cắt hai đầu, hạ chữ. Hai chuỗi khác
 * định dạng nhưng cùng nội dung (ví dụ cùng hint phát lại ở step khác) vẫn bị coi
 * là trùng.
 *
 * PHẠM VI: chỉ dedup các hạng DƯỚI `completion` — tức `evidence` và `advisory`.
 * `recovery`/`completion` KHÔNG bị dedup vì chúng có trần riêng theo turn
 * (`failureMaxPerTurn`/`completionMaxPerTurn`) và việc nhắc lại ở một step SAU là
 * chủ ý: agent có thể đã thêm message ở giữa, lời nhắc rơi vào ngữ cảnh khác.
 * Dedup chúng sẽ vô hiệu hoá trần đó. Hạng `CONTEXT_PROTECTED` cũng miễn: một
 * ràng buộc an toàn lặp lại vẫn phải tới agent — thà lặp còn hơn im.
 *
 * @param {{kind?: string, text: string}[]} items
 * @param {Set<string>} seen vân tay đã chèn trong turn (bị sửa tại chỗ)
 * @returns {{fresh: object[], deduped: number}}
 */
export function dedupeInjection(items, seen) {
  const fresh = [];
  let deduped = 0;
  const fingerprints = seen ?? new Set();
  for (const item of items ?? []) {
    const kind = typeof item?.kind === 'string' ? item.kind : 'advisory';
    const rank = CONTEXT_PRIORITY[kind] ?? CONTEXT_PRIORITY.advisory;
    if (CONTEXT_PROTECTED.has(kind) || rank >= CONTEXT_PRIORITY.completion) {
      fresh.push(item);
      continue;
    }
    const print = fingerprintOf(item?.text);
    if (print && fingerprints.has(print)) {
      deduped += 1;
      continue;
    }
    if (print) fingerprints.add(print);
    fresh.push(item);
  }
  return { fresh, deduped };
}

/** Vân tay chuẩn hoá của một hint (gộp khoảng trắng, hạ chữ). */
export function fingerprintOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Cắt `text` xuống còn tối đa `maxTokens` (theo `estimateTokens`) để nhét vừa
 * phần ngân sách còn lại. Cắt ở ranh giới DÒNG khi còn giữ được ≥60% đoạn, nếu
 * không thì cắt thẳng; luôn thêm `…` để người đọc biết là đoạn bị cắt.
 *
 * Trả `''` khi phần còn lại quá nhỏ để còn ý nghĩa (< 24 ký tự) — thà bỏ hẳn
 * còn hơn chèn một mẩu cụt vô nghĩa.
 */
export function truncateToTokens(text, maxTokens) {
  const value = typeof text === 'string' ? text : '';
  const maxChars = Math.floor(Math.max(0, maxTokens) * 4);
  if (value.length <= maxChars) return value;
  if (maxChars < 24) return '';
  const head = value.slice(0, maxChars - 1);
  const cut = head.lastIndexOf('\n');
  const body = cut >= Math.floor(maxChars * 0.6) ? head.slice(0, cut) : head;
  return `${body}…`;
}

/**
 * Chọn mảnh nào được chèn trong `maxTokens`.
 *
 * `reserveTokens` giữ chỗ cho các hạng CAO HƠN `advisory` đến sau trong CÙNG
 * turn. Cần thiết vì các lớp chèn theo thứ tự thời gian (L4/L5 `advisory`/
 * `evidence` ở step 1, rồi L6 `recovery`, L2 `completion`), mà ngân sách là
 * first-come: nếu không giữ chỗ, một gợi ý ở step 1 sẽ ăn hết hạn mức và đẩy gợi
 * ý phục hồi lỗi ra ngoài — đúng ngược thứ tự ưu tiên §22. Vì vậy mọi hạng DƯỚI
 * `completion` (tức `evidence` và `advisory`, đều là mảnh step 1) chỉ được dùng
 * tới `maxTokens - reserveTokens`; `recovery`/`completion`/`safety` dùng trọn
 * `maxTokens`.
 *
 * Mảnh có `truncatable: true` (hiện là gợi ý file kèm bằng chứng của Lớp 5)
 * KHÔNG bị bỏ khi vượt phần còn lại: nó được cắt xuống vừa chỗ và giữ lại, vì
 * một đoạn trích ngắn vẫn là bằng chứng, còn bỏ hẳn thì agent mất luôn manh mối.
 *
 * @param {{kind?: string, text: string, truncatable?: boolean}[]} items
 * @param {number} maxTokens
 * @param {number} [reserveTokens]
 * @returns {{kept: object[], dropped: object[], used: number}}
 *   `kept` giữ NGUYÊN thứ tự đầu vào (thứ tự chèn phải ổn định giữa các lần
 *   chạy); `dropped` gồm `{kind, text, tokens, reason}`.
 */
export function planInjection(items, maxTokens, reserveTokens = 0) {
  const budget = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 0;
  const reserve = Number.isFinite(reserveTokens) ? Math.max(0, reserveTokens) : 0;
  const advisoryBudget = Math.max(0, budget - reserve);
  const entries = (items ?? []).map((item, index) => {
    const kind = typeof item?.kind === 'string' ? item.kind : 'advisory';
    const text = typeof item?.text === 'string' ? item.text : '';
    return {
      index,
      kind,
      text,
      tokens: estimateTokens(text),
      truncatable: item?.truncatable === true,
    };
  });

  const kept = new Set(entries.filter((entry) => CONTEXT_PROTECTED.has(entry.kind)));
  const optional = entries
    .filter((entry) => !CONTEXT_PROTECTED.has(entry.kind))
    .sort((a, b) => (CONTEXT_PRIORITY[b.kind] ?? 0) - (CONTEXT_PRIORITY[a.kind] ?? 0)
      || a.index - b.index);

  let used = [...kept].reduce((sum, entry) => sum + entry.tokens, 0);
  for (const entry of optional) {
    // Hạng thấp hơn `completion` (evidence/advisory) phải chừa `reserve` cho hạng
    // cao hơn đến sau; hạng từ `completion` trở lên dùng trọn trần.
    const limit = (CONTEXT_PRIORITY[entry.kind] ?? 0) >= CONTEXT_PRIORITY.completion
      ? budget
      : advisoryBudget;
    const room = limit - used;
    if (room <= 0) continue;
    if (entry.tokens <= room) {
      kept.add(entry);
      used += entry.tokens;
      continue;
    }
    if (!entry.truncatable) continue;
    const cut = truncateToTokens(entry.text, room);
    if (!cut) continue;
    entry.text = cut;
    entry.tokens = estimateTokens(cut);
    entry.truncated = true;
    kept.add(entry);
    used += entry.tokens;
  }

  return {
    kept: entries.filter((entry) => kept.has(entry)),
    dropped: entries
      .filter((entry) => !kept.has(entry))
      .map((entry) => ({ ...entry, reason: 'over_context_budget' })),
    used,
  };
}
