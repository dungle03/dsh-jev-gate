/**
 * Jev client tối giản cho gate.
 *
 * Tái dùng đúng hợp đồng đã chạy thật trong dsh-jev-decision-model:
 * endpoint /v1/systemone, 3 loại câu hỏi (choice/score/noul), giới hạn 256 KiB.
 *
 * Khác biệt có chủ đích: model được PIN vào jev-1.13.0 thay vì alias
 * `jev-latest`, vì docs TypeSafe cảnh báo alias dịch chuyển khi có bản mới và
 * "the answers behind it can change without a change on your side".
 */

export const MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_BYTES = 256 * 1024;
const RESPONSE_BYTES = 1024 * 1024;

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const content = (value) =>
  typeof value === 'string' ? value.trim().length > 0 : record(value) || Array.isArray(value);
const probability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * Chờ `ms`, nhưng thoát NGAY khi `signal` abort — không giữ turn sống thêm.
 *
 * Backoff giữa các lần thử phải tôn trọng deadline chung: nếu ngân sách gate chỉ
 * còn 30ms mà ta ngủ 150ms thì đã vượt trần độ trễ. `signal` ở đây chính là
 * `combined` (deadline + lifetime + hook), nên hết ngân sách là ngủ dừng và
 * `throwIfAborted` ngay sau đó ném ra — trần độ trễ không đổi.
 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Mô tả một giá trị bị NÉM RA thành chuỗi đọc được — kể cả khi nó không phải
 * `Error`.
 *
 * ## Vì sao cần (bug thật, đo trên log)
 *
 * Bản cũ ghi `error instanceof Error ? error.message : 'unknown'`. Đo trên
 * `decisions.jsonl`: **10 bản ghi `jev_error` có `message: 'unknown'` và
 * `ms: 0`** — không chẩn đoán được gì.
 *
 * Nguyên nhân gốc: `AbortSignal.throwIfAborted()` ném ra CHÍNH giá trị `reason`
 * truyền cho `abort(reason)`. Khi reason KHÔNG phải `Error` (DSH abort với một
 * chuỗi hoặc object), giá trị ném ra cũng không phải `Error`:
 *
 *   const c = new AbortController();
 *   c.abort('some string reason');
 *   c.signal.throwIfAborted();   // ném ra chuỗi, KHÔNG phải Error
 *
 * Nên phải xử lý mọi kiểu: `Error`, `DOMException`, chuỗi, object, và cả
 * `undefined`/`null`. Thà log một chuỗi thô còn hơn log `'unknown'`.
 */
/**
 * Rút mã lỗi THẬT từ một `Error` — kể cả khi nó nằm trong `cause` lồng nhau.
 *
 * ## Vì sao cần (bug thật, đo trên log 02/10)
 *
 * `fetch` của Node/undici bọc MỌI lỗi mạng trong một `TypeError('fetch failed')`
 * rồi giấu nguyên nhân thật ở `error.cause`:
 *
 *   TypeError: fetch failed
 *     └─ cause: Error { code: 'ENETUNREACH' }   ← đây mới là thứ chẩn đoán được
 *
 * Bản `describeError` cũ chỉ đọc `error.message`, nên **381 lỗi hôm 02/10 đều
 * ghi giống hệt nhau: `"TypeError: fetch failed"`** — không phân biệt được
 * IPv6 không có route (`ENETUNREACH`), DNS hỏng (`ENOTFOUND`), TLS lỗi, hay
 * connection reset. Sự cố thật (máy có AAAA nhưng route IPv6 chết) trở nên vô
 * hình trong log, đúng loại khoảng trống quan sát mà plugin này sinh ra để bịt.
 *
 * Đi theo chuỗi `cause` (có trần độ sâu, chống vòng lặp `cause` tự trỏ) và gom
 * `code` + `errno` + `syscall`, dedup lại. `AggregateError` (undici dùng khi
 * mọi họ địa chỉ đều hỏng) có `errors` — đi vào từng phần tử.
 */
function errorCauseChain(error) {
  const parts = [];
  const seen = new Set();
  const visit = (node, depth) => {
    // Mọi truy cập đều có thể NÉM: `cause` là getter độc hại, `code` là object có
    // `toString` ném, hoặc cả node là `Proxy` trap ném. Hàm chẩn đoán KHÔNG được
    // phép ném — nó chạy trong catch block, ném ở đây là thay lỗi gốc bằng lỗi
    // của chính bộ ghi log và phá fail-open. Bọc từng bước, bỏ qua phần hỏng.
    try {
      if (node === null || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
      seen.add(node);
      // `code`/`errno`/`syscall` là các trường hệ thống thật sự phân biệt được lỗi.
      // Bỏ `code` SỐ của DOMException: đó là mã legacy (AbortError = 20) không
      // thêm thông tin, chỉ làm nhiễu chuỗi `AbortError: aborted [20]`.
      const isDomException = typeof DOMException === 'function' && node instanceof DOMException;
      const code = node.code ?? node.errno;
      if (typeof code === 'string' || (typeof code === 'number' && !isDomException)) parts.push(String(code));
      if (typeof node.syscall === 'string') parts.push(node.syscall);
      if (Array.isArray(node.errors)) for (const child of node.errors) visit(child, depth + 1);
      if (node.cause !== undefined) visit(node.cause, depth + 1);
    } catch { /* node hỏng — bỏ qua, không để nó phá cả chuỗi chẩn đoán */ }
  };
  try { visit(error, 0); } catch { /* phòng tuyến cuối */ }
  return [...new Set(parts)];
}

export function describeError(error) {
  if (error instanceof Error) {
    // Đọc `name`/`message` cũng có thể ném (Proxy trap). Không để nó phá bộ ghi log.
    let name = '';
    let message = '';
    try { name = error.name; } catch { /* bỏ */ }
    try { message = error.message; } catch { /* bỏ */ }
    // `name` quan trọng: AbortError vs TimeoutError khác hẳn nhau khi chẩn đoán.
    const prefix = name && name !== 'Error' ? `${name}: ` : '';
    const base = `${prefix}${message || '(no message)'}`;
    // `cause` chứa mã lỗi thật của fetch; không có nó thì mọi lỗi mạng giống nhau.
    const chain = errorCauseChain(error);
    return chain.length ? `${base} [${chain.join(', ')}]` : base;
  }
  if (typeof error === 'string') return `thrown string: ${error}`;
  if (error === undefined) return 'thrown undefined';
  if (error === null) return 'thrown null';
  try {
    const json = JSON.stringify(error);
    return `thrown ${typeof error}: ${json === undefined ? String(error) : json}`.slice(0, 200);
  } catch {
    return `thrown ${typeof error} (không serialize được)`;
  }
}

/**
 * Mã lỗi mạng TẠM THỜI — thử lại một lần là hợp lý, thường đã khác kết quả.
 *
 * Danh sách CỐ Ý hẹp: chỉ những mã mà bản chất là "lần này không được, lần sau
 * có thể được". Không gồm lỗi cấu hình (chứng chỉ, sai host) — retry vô ích.
 *
 * `ENETUNREACH`/`EHOSTUNREACH`: máy có bản ghi AAAA nhưng KHÔNG có route IPv6
 * (đúng máy này: `disable_ipv6=0` nhưng `ip -6 addr` rỗng). Đây là nguyên nhân
 * thật của 381 lỗi `fetch failed` ngày 02/10 — đo được ms:2–7, tức hỏng ngay ở
 * tầng connect chứ không phải timeout.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EPROTO', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Lỗi này có phải sự cố mạng tạm thời, đáng thử lại không?
 *
 * KHÔNG tính abort/timeout do chính ta đặt (deadline, hook abort, dispose) —
 * đó là quyết định CÓ CHỦ Ý, thử lại là sai. Chỉ tính lỗi tầng kết nối.
 *
 * `fetch` bọc mọi lỗi mạng trong `TypeError('fetch failed')` và giấu mã thật ở
 * `cause`, nên phải soi chuỗi `cause` (xem `errorCauseChain`).
 */
export function isTransientNetworkError(error) {
  // Toàn bộ thân hàm bọc trong try: nó chạy TRONG catch block của `evaluate`, nên
  // một cú ném ở đây sẽ thay lỗi gốc bằng lỗi của bộ phân loại và phá fail-open.
  // `instanceof`/đọc `name`/`message` đều có thể ném với `Proxy` trap độc hại.
  try {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
    const codes = errorCauseChain(error);
    if (codes.some((code) => TRANSIENT_NETWORK_CODES.has(code))) return true;
    // undici bọc lỗi connect thành đúng chuỗi này khi không lộ `code` ra ngoài.
    return error.message === 'fetch failed';
  } catch {
    // Không phân loại được → coi như KHÔNG transient (không retry). An toàn hơn:
    // retry trên lỗi không rõ bản chất có thể lặp vô ích hoặc che lỗi thật.
    return false;
  }
}

/** Validate tại biên chung; không adapter nào được nới hợp đồng. */
export function requestBody(input) {
  requireValue(
    record(input) && Object.keys(input).every((key) => ['state', 'questions'].includes(key)),
    'only state and questions are accepted',
  );
  requireValue(content(input.state), 'state must be non-empty text, object, or array');
  requireValue(record(input.questions), 'questions must map ids to question objects');
  const questions = Object.entries(input.questions);
  requireValue(questions.length >= 1 && questions.length <= 64, 'each evaluation needs 1-64 questions');
  for (const [id, question] of questions) {
    requireValue(id.trim().length > 0 && id.length <= 160, 'question id must be 1-160 chars');
    requireValue(
      record(question) && Object.keys(question).every((key) => ['type', 'instructions', 'criteria'].includes(key)),
      'a question accepts only type, instructions, and criteria',
    );
    requireValue(content(question.instructions), 'every question needs complete instructions');
    const criteria = question.criteria;
    if (question.type === 'choice') {
      requireValue(record(criteria), 'choice.criteria must be a candidate map');
      const options = Object.entries(criteria);
      requireValue(options.length >= 2 && options.length <= 255, 'choice needs 2-255 candidates');
      requireValue(
        options.every(([key, value]) => key.trim() && (value === null || content(value))),
        'choice candidates need a valid id and description',
      );
    } else if (question.type === 'score') {
      requireValue(
        Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10 && criteria.every(content),
        'score.criteria needs 2-10 ordered level descriptions',
      );
    } else if (question.type === 'noul') {
      requireValue(
        criteria === undefined
        || (record(criteria) && Object.entries(criteria).every(([key, value]) => ['true', 'false'].includes(key) && content(value))),
        'noul.criteria may only describe true and false',
      );
    } else {
      throw new Error('question type must be choice, score, or noul');
    }
  }
  let body;
  try {
    body = JSON.stringify({ state: input.state, questions: input.questions, model: MODEL }, (_key, value) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error();
      return value;
    });
  } catch {
    throw new Error('evaluation content must be serializable JSON');
  }
  requireValue(Buffer.byteLength(body) <= REQUEST_BYTES, 'evaluation request exceeds 256 KiB; keep only decision-relevant context');
  return body;
}

function responseValue(value, questions) {
  const invalid = 'Jev returned an incomplete or invalid structured result';
  requireValue(record(value) && typeof value.model === 'string' && record(value.answers), invalid);
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = Object.hasOwn(value.answers, id) ? value.answers[id] : null;
    requireValue(record(answer) && answer.type === question.type, invalid);
    if (answer.type === 'noul') {
      requireValue(probability(answer.noul), invalid);
      return [id, { type: 'noul', noul: answer.noul }];
    }
    const levels = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_item, index) => String(index));
    requireValue(probability(answer.confidence) && record(answer.probabilities), invalid);
    requireValue(
      Object.keys(answer.probabilities).length === levels.length
      && levels.every((key) => Object.hasOwn(answer.probabilities, key) && probability(answer.probabilities[key])),
      invalid,
    );
    requireValue(Math.abs(Object.values(answer.probabilities).reduce((sum, item) => sum + item, 0) - 1) < 0.02, invalid);
    const shared = { type: answer.type, confidence: answer.confidence, probabilities: answer.probabilities };
    if (answer.type === 'choice') {
      requireValue(typeof answer.choice === 'string' && levels.includes(answer.choice), invalid);
      return [id, { ...shared, choice: answer.choice }];
    }
    requireValue(
      Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= levels.length - 1,
      invalid,
    );
    return [id, { ...shared, score: answer.score }];
  }));
  requireValue(
    record(value.usage)
    && ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0),
    invalid,
  );
  return {
    provider: 'TypeSafe AI',
    model: value.model,
    answers,
    usage: { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens },
  };
}

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Jev returned an empty response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValue(size <= RESPONSE_BYTES, 'Jev response too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Jev returned an unparseable response');
  }
}

/**
 * Tạo client Jev.
 *
 * `timeoutMs` mặc định ngắn (2s) vì gate chạy trong đường tới hạn của mọi tool
 * call: một gate chậm làm cả turn chậm. Caller nào chịu được lâu hơn thì truyền
 * timeout riêng.
 */
export function createJev({ getApiKey, timeoutMs = 2_000, fetchImpl = globalThis.fetch, record = () => {} } = {}) {
  requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0, 'timeoutMs must be > 0');
  const lifetime = new AbortController();

  const apiKey = async () => {
    const value = await getApiKey();
    requireValue(
      typeof value === 'string' && value.trim() && !/[\r\n]/.test(value),
      'TYPESAFE_API_KEY is not configured',
    );
    return value.trim();
  };

  /**
   * `agent` là TUỲ CHỌN: khi có, `jev_ok`/`jev_error` kèm `session` để đo được
   * per-agent. Không truyền thì bản ghi vẫn hợp lệ, chỉ thiếu danh tính.
   */
  const evaluate = async (input, { signal, timeoutOverrideMs, agent, layer, onInvocation } = {}) => {
    const body = requestBody(input);
    const key = await apiKey();
    const budget = timeoutOverrideMs ?? timeoutMs;
    const deadline = AbortSignal.timeout(budget);
    const combined = AbortSignal.any([
      lifetime.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    const started = Date.now();
    /**
     * Số lần thử: 1 lần gốc + 2 lần lại. Trước đây chỉ retry 429/529, nên MỌI
     * lỗi mạng transient đều thành `fail_open` ngay lần đầu — đo trên log
     * 02/10: 381/381 lỗi `fetch failed` đều bỏ qua chỉ sau một lần thử.
     *
     * Mọi lần thử vẫn nằm dưới `combined` (deadline + lifetime + hook signal),
     * nên trần độ trễ KHÔNG đổi: hết ngân sách là `throwIfAborted` cắt ngay,
     * không có đường vượt `timeoutOverrideMs`.
     */
    const MAX_ATTEMPTS = 3;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        combined.throwIfAborted();
        let response;
        try {
          onInvocation?.();
          response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            redirect: 'error',
            signal: combined,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body,
          });
        } catch (error) {
          // Lỗi mạng tầng connect (DNS, route, reset): thử lại có ích.
          // Abort/timeout do chính ta đặt thì KHÔNG — đó là quyết định có chủ ý.
          const transient = isTransientNetworkError(error);
          if (transient && attempt < MAX_ATTEMPTS - 1) {
            // Backoff ngắn, có trần, và không vượt ngân sách còn lại của deadline.
            await sleep(Math.min(50 * (attempt + 1), 150), combined);
            continue;
          }
          throw error;
        }
        if (response.ok) {
          const parsed = responseValue(await readResponse(response), JSON.parse(body).questions);
          record({
            type: 'jev_ok', ms: Date.now() - started, usage: parsed.usage, model: parsed.model,
            ...(layer ? { layer } : {}),
          }, agent);
          return parsed;
        }
        await response.body?.cancel().catch(() => {});
        // 429/529 = quá tải tạm thời; 5xx khác cũng đáng thử lại một lần.
        if ([429, 529].includes(response.status) && attempt < MAX_ATTEMPTS - 1) {
          await sleep(Math.min(50 * (attempt + 1), 150), combined);
          continue;
        }
        if (response.status === 401) throw new Error('Jev API key invalid');
        if (response.status === 422) throw new Error('Jev rejected the evaluation request');
        throw new Error(`Jev request failed (HTTP ${response.status})`);
      }
      throw new Error('Jev request failed after retry');
    } catch (error) {
      record({
        type: 'jev_error',
        ms: Date.now() - started,
        message: describeError(error).slice(0, 160),
        ...(layer ? { layer } : {}),
      }, agent);
      throw error;
    }
  };

  return {
    evaluate,
    dispose: () => lifetime.abort(new Error('jev gate disposed')),
    model: MODEL,
  };
}
