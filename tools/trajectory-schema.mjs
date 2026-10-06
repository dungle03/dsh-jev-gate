/**
 * Hợp đồng dùng chung cho trajectory benchmark — THUẦN, không I/O, không mạng.
 *
 * Vì sao tách riêng: collector (ghi row) và matrix (đọc row) phải hiểu CÙNG một
 * định nghĩa về identity, capability và operation metric. Nếu mỗi bên tự suy
 * diễn, một row có thể "hợp lệ" lúc ghi nhưng bị ghép sai lúc đọc — đúng loại
 * sai lệch mà cả file này sinh ra để chặn.
 *
 * NĂM nguyên tắc bất di bất dịch:
 *   1. Không đoán từ tên profile. `available` chỉ được suy từ bằng chứng runtime
 *      (decisions.jsonl) hoặc preflight thật; không có bằng chứng ⇒ `null`.
 *   2. `null` KHÁC `0`/`false`. Thiếu số đo là `null`; chỉ `false` khi có bằng
 *      chứng khẳng định vắng mặt.
 *   3. Cấu hình arm khác nhau ⇒ treatment khác nhau. Cùng tên arm nhưng
 *      `profile_config_hash` khác thì KHÔNG được ghép cặp như một treatment.
 *   4. `available` KHÔNG phải `exercised`. Một capability có sẵn (`available`)
 *      không chứng minh nó ĐÃ CHẠY trong trajectory; bằng chứng "đã chạy" phải
 *      theo TỪNG capability (`exercised`), không gộp thành một cờ chung.
 *   5. Bằng chứng không đủ ⇒ `hold`, KHÔNG bao giờ `eligible-for-review`. Nhưng
 *      một môi trường KHÔNG hợp lệ cũng KHÔNG được gọi là `*-regression`: chưa
 *      đo được thì chưa được kết luận là tệ hơn.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';

/** Schema của một row trajectory do collector ghi. */
export const ROW_SCHEMA = 'dsh-jev-gate-trajectory-v2';
/** Schema của báo cáo matrix do trajectory-matrix.mjs trả. */
export const MATRIX_SCHEMA = 'trajectory-matrix-v2';
/** Chỉ những schema này được matrix hiểu; bản cũ bị TỪ CHỐI tường minh. */
export const SUPPORTED_ROW_SCHEMAS = Object.freeze([ROW_SCHEMA]);

/**
 * §28: một dòng JSONL phình to (artifact bị nhúng nguyên file, log dán vào
 * `detail`, hoặc file bị hỏng/ghép) không được parse im lặng như một row bình
 * thường — nó có thể che dữ liệu sai và làm phình bộ nhớ. Row THẬT lớn nhất đo
 * được ~9.6 KB, nên 256 KB là ngưỡng rộng rãi: vượt ngưỡng là bất thường, phải
 * bị TỪ CHỐI tường minh chứ không nuốt vào.
 */
export const MAX_ROW_BYTES = 262144;

export const ARMS = Object.freeze(['vanilla', 'safe', 'balanced', 'experimental']);

/**
 * Các giá trị `split` hợp lệ. Một chuỗi lạ (đánh máy, hoặc tự bịa) phải bị TỪ CHỐI
 * thay vì âm thầm trôi qua: `provenance()` chỉ công nhận `held-out`, nên một giá
 * trị méo mó sẽ khiến bằng chứng hoặc bị loại, hoặc tệ hơn là được coi là hợp lệ.
 */
export const SPLITS = Object.freeze(['train', 'validation', 'held-out', 'outage']);

/** Trục đo. `safety` chỉ bật khi task có ground truth an toàn tường minh. */
export const MEASUREMENT_AXES = Object.freeze(['quality', 'performance', 'safety']);

/** Metric an toàn — chỉ có nghĩa trên task khai `safety: true`. */
export const SAFETY_KEYS = Object.freeze(['false_allow', 'false_deny']);

/** Lớp task mà collector PHẢI hỗ trợ (không thêm layer plugin nào). */
export const TASK_CLASSES = Object.freeze([
  'routine', 'repository-navigation', 'bug-diagnosis',
  'tool-failure-recovery', 'destructive-intent-safety', 'multi-file-coding',
]);

/**
 * Config KHÔNG ảnh hưởng hành vi đo — denylist TỐI THIỂU, phải khai lý do.
 *
 * Đây là danh sách ĐÓNG. Bất kỳ khoá Config runtime nào không nằm trong
 * `BENCHMARK_CONFIG_KEYS` cũng phải nằm trong đây, nếu không test hợp đồng
 * (`tests/trajectory-config-coverage.mjs`) sẽ FAIL — nhờ vậy một khoá hành vi
 * mới thêm vào runtime KHÔNG THỂ lọt khỏi hash một cách âm thầm.
 *
 * Vì sao `logDir`: chỉ là đích ghi log, không đổi quyết định của gate. Không có
 * khoá nào khác đủ vô hại để loại: timeout/ngân sách/ngưỡng/song song/context
 * đều đổi hành vi thật.
 */
export const BENCHMARK_CONFIG_EXCLUSIONS = Object.freeze({
  logDir: 'output path only — does not change gate decisions',
});

/**
 * Toàn bộ khoá config ảnh hưởng hành vi benchmark. Trước đây chỉ 22/76 khoá
 * runtime, nên hai cấu hình KHÁC NHAU (ví dụ khác `jevMaxCallsPerTurn` hay
 * `reviewTimeoutMs`) vẫn ra CÙNG `profile_config_hash` ⇒ bị ghép cặp như một
 * treatment. Nay lấy đủ: mọi khoá runtime trừ denylist tường minh.
 */
export const BENCHMARK_CONFIG_KEYS = Object.freeze([
  'profile',
  'approachConfidenceThreshold', 'approachProbabilityMargin', 'approachTopProbability',
  'completionMaxPerTurn', 'completionThreshold', 'consentTimeoutMs',
  'contextCandidateLimit', 'contextEvidence', 'contextFileThreshold', 'contextMaxFiles',
  'contextTimeoutMs', 'destructiveThreshold',
  'effortAbstain', 'effortDecision', 'effortDefault', 'effortEscalateTestFailures',
  'effortEscalateTo', 'effortEscalateToolErrors', 'effortFallback', 'effortHardThreshold',
  'effortJevChoices', 'effortRoutineThreshold', 'effortTimeoutMs',
  'enableAuthorizationOverride', 'enableCatastrophicFloor', 'enableCompletionCheck',
  'enableContextTriage', 'enableDestructiveConsent', 'enableDestructiveGate',
  'enableEffortRouting', 'enableFailureRecovery', 'enableGateVerdictCache',
  'enableJevgrepEscalation', 'enableQualityReview', 'enableReadOnlyPrefilter', 'enableSpawnHint',
  'evidenceThreshold', 'executionThreshold', 'failureMaxPerTurn', 'failureTimeoutMs',
  'gateFailureMode', 'gateTimeoutMs', 'gateVerdictCacheMargin', 'gateVerdictCacheMax',
  'jevBudgetEnabled', 'jevGrepBackground', 'jevGrepBreakerCooldownMs', 'jevGrepExcerptCap',
  'jevGrepFailureBreaker', 'jevGrepMaxConcurrentGlobal', 'jevGrepMaxConcurrentPerSession',
  'jevGrepMaxPerSession', 'jevGrepMaxPerTurn', 'jevGrepPendingMax', 'jevGrepSearchTaskHeuristic',
  'jevGrepSearchTaskThreshold', 'jevGrepTimeoutMs', 'jevMaxCallsPerSession', 'jevMaxCallsPerTurn',
  'maxDecisionCostPerSession', 'maxDecisionCostPerTurn', 'maxPluginContextTokensPerTurn',
  'reviewContextReserveTokens', 'reviewMaxDiffChars', 'reviewMaxPerSession', 'reviewMaxPerTurn',
  'reviewMinChangedLines', 'reviewMode', 'reviewReportToAgent', 'reviewServerName', 'reviewTimeoutMs',
  'shadowGateThreshold', 'spawnTimeoutMs', 'stopTimeoutMs',
]);

/** Hash sha256 hex của một giá trị bất kỳ (JSON tất định). */
export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

/** JSON tất định (khoá sắp xếp, đệ quy) — bắt buộc để hash ổn định giữa máy. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Trích subset benchmark-relevant; giữ `null` cho khoá vắng để hash tất định. */
export function benchmarkRelevant(config) {
  if (!config || typeof config !== 'object') return null;
  return Object.fromEntries(BENCHMARK_CONFIG_KEYS.map((key) => [key, config[key] ?? null]));
}

/** Hash cấu hình arm. Không có config (vanilla) ⇒ `null`, KHÔNG bịa hash. */
export function profileConfigHash(config) {
  const relevant = benchmarkRelevant(config);
  return relevant === null ? null : createHash('sha256').update(canonicalJson(relevant)).digest('hex');
}

/**
 * Bản ghi config harness dạng canonical — ĐỦ trường để tính lại hash.
 * Ghi cả object này vào row (`benchmark_config`) chứ không chỉ ghi hash suông:
 * một hash không kèm dữ liệu nguồn thì không thể kiểm, chỉ có thể tin.
 */
export function benchmarkConfigFor(fields = {}) {
  return {
    task_id: fields.task_id ?? null, task_class: fields.task_class ?? null,
    task_prompt_hash: fields.task_prompt_hash ?? null, model: fields.model ?? null,
    dsh_version: fields.dsh_version ?? null, plugin_version: fields.plugin_version ?? null,
    evaluator: fields.evaluator ?? null, permission_mode: fields.permission_mode ?? null,
    timeout_ms: fields.timeout_ms ?? null,
  };
}

/** Hash cấu hình harness (dùng chung cho cả 4 arm của một nhóm ghép cặp). */
export function benchmarkConfigHash(fields) {
  return createHash('sha256').update(canonicalJson(benchmarkConfigFor(fields))).digest('hex');
}

/** Kiểm hash cấu hình arm: tính LẠI từ `profile_config`, không tin field khai. */
export function verifyProfileConfigHash(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.arm === 'vanilla') return row.profile_config === null && row.profile_config_hash === null;
  const expected = profileConfigHash(row.profile_config);
  return expected !== null && expected === row.profile_config_hash;
}

/** Kiểm hash cấu hình harness: tính LẠI từ `benchmark_config`, không tin field khai. */
export function verifyBenchmarkConfigHash(row) {
  if (!row || typeof row !== 'object') return false;
  if (!row.benchmark_config || typeof row.benchmark_config !== 'object') return false;
  return benchmarkConfigHash(row.benchmark_config) === row.benchmark_config_hash;
}

/**
 * Bảng capability khai báo. `needs` nói phụ thuộc bên ngoài; `invoked` là bằng
 * chứng "đã thực sự chạy"; `unavailable` là bằng chứng "thiếu hạ tầng".
 * KHÔNG hard-code "experimental luôn cần jg": mọi thứ suy từ config + evidence.
 */
export const CAPABILITY_SPECS = Object.freeze([
  { name: 'jev', configKey: null, needs: 'credentials', record: null },
  { name: 'destructive_gate', configKey: 'enableDestructiveGate', needs: 'jev',
    record: 'destructive_gate', invoked: (d) => d.decision !== 'fail_open' },
  { name: 'completion_check', configKey: 'enableCompletionCheck', needs: 'jev',
    record: 'completion_check', invoked: (d) => d.decision !== 'fail_open' },
  { name: 'effort_routing', configKey: 'enableEffortRouting', needs: 'jev',
    record: 'effort_route', invoked: (d) => d.decision !== 'fail_open' },
  { name: 'effort_abstain', configKey: 'effortAbstain', needs: 'jev',
    record: 'effort_route', invoked: (d) => d.decision === 'jev_abstain' },
  { name: 'failure_recovery', configKey: 'enableFailureRecovery', needs: 'jev',
    record: 'failure_recovery', invoked: (d) => d.decision === 'hinted' },
  { name: 'spawn_hint', configKey: 'enableSpawnHint', needs: 'jev',
    record: 'pre_step', invoked: (d) => d.approach === 'hinted' },
  { name: 'context_triage', configKey: 'enableContextTriage', needs: 'jev',
    record: 'pre_step', invoked: (d) => d.context === 'hinted' },
  // Kênh đồng ý cho hành động phá dữ liệu CHƯA chứng minh được provenance.
  //
  // Vì sao cần một capability riêng: task `destructive-authorized-delete-v1` đo
  // "một lần xoá ĐÃ ĐƯỢC user authorize có bị chặn oan không". Trên đường đó
  // gate phải hỏi user qua thẻ đồng ý (`askDestructiveConsent`) khi provenance
  // không chứng minh được lệnh — mà trong harness headless KHÔNG có người trả
  // lời, nên `askTimed` hết hạn và gate CHẶN (`ASK_TIMED_OUT`). Đó là hành vi
  // fail-closed ĐÚNG, nhưng nó khiến `false_deny=1` phản ánh HẠ TẦNG THIẾU
  // người trả lời, không phải plugin chặn oan.
  //
  // Gộp nhầm hai thứ đó lại chính là lỗi "đo sai" mà kế hoạch yêu cầu sửa:
  // promotion sẽ tuyên bố `safety-regression` cho một arm thực ra chưa hề được
  // đo. Nên tách thành capability riêng, để `capabilityValidity` biến nó thành
  // `hold` (thiếu hạ tầng) thay vì `regression` — đúng luật của kế hoạch.
  //
  // `invoked` = ĐƯỜNG AUTHORIZE đã chạy tới đích: hoặc provenance chứng minh
  // (`allow_authorized`), hoặc user đồng ý thật (`allow_consented`).
  // `confirmed` = bằng chứng DƯƠNG rằng kênh đã phục vụ được yêu cầu — kể cả khi
  // user từ chối thật (`consent: 'refused'`, lý do không phải hết hạn/huỷ). Khi
  // đó kênh CÓ người trả lời, nên không được coi là thiếu hạ tầng.
  // `unavailable` = bằng chứng ÂM: không có kênh hỏi, hoặc hết hạn/huỷ giữa
  // chừng (không ai trả lời) — đúng ca headless.
  { name: 'destructive_consent', configKey: 'enableDestructiveConsent', needs: 'consent_channel',
    record: 'destructive_gate',
    // `invoked` = kênh consent ĐƯỢC DÙNG thật: user bấm đồng ý, hoặc user trả lời
    // từ chối (kênh đã phục vụ một câu hỏi thật). Đường provenance
    // (`allow_authorized`) KHÔNG dùng kênh, nên KHÔNG tính là invoked — nếu tính
    // thì `layer_coverage` báo "kênh đã chạy" cho lần chạy chưa hề mở thẻ.
    invoked: (d) => d.decision === 'allow_consented'
      || (d.decision === 'deny_consent' && d.consent === 'refused'
        && !['ASK_TIMED_OUT', 'ASK_CANCELLED', 'ASK_ABORTED'].includes(d.consent_reason)),
    // `confirmed` = môi trường ĐỦ để đo: uỷ quyền được TÔN TRỌNG (provenance chứng
    // minh) HOẶC kênh consent phục vụ được. Rộng hơn `invoked` vì đường
    // provenance cũng cho một phép đo hợp lệ dù không mở thẻ.
    confirmed: (d) => d.decision === 'allow_consented' || d.decision === 'allow_authorized'
      || (d.decision === 'deny_consent' && d.consent === 'refused'
        && !['ASK_TIMED_OUT', 'ASK_CANCELLED', 'ASK_ABORTED'].includes(d.consent_reason)),
    unavailable: (d) => d.decision === 'deny_consent'
      && (d.consent === 'unavailable'
        || ['ASK_TIMED_OUT', 'ASK_CANCELLED', 'ASK_ABORTED'].includes(d.consent_reason)) },
  { name: 'quality_review', configKey: 'enableQualityReview', needs: 'review_tool',
    record: 'quality_review', invoked: (d) => d.decision === 'reviewed',
    unavailable: (d) => d.decision === 'skip_no_tool' },
  { name: 'jevgrep', configKey: 'enableJevgrepEscalation', needs: 'executable',
    record: 'jevgrep_escalation', invoked: (d) => ['hinted', 'started_background'].includes(d.decision),
    unavailable: (d) => ['skip_unavailable', 'unavailable'].includes(d.decision) },
]);

/** Gộp mọi bản ghi `cost_governor` theo `operation_id` thành metric thật. */
export function aggregateOperations(decisions) {
  const ops = new Map();
  for (const row of decisions) {
    if (!row || row.type !== 'cost_governor' || typeof row.operation_id !== 'string') continue;
    const current = ops.get(row.operation_id) ?? {
      kind: row.invocation_kind ?? null, category: row.category ?? null, reserved_units: 0,
      actual_invocations: 0, completed: false, cancelled: false, failure: null, elapsed_ms: 0,
    };
    if (Number.isFinite(row.reserved_units)) current.reserved_units = Math.max(current.reserved_units, row.reserved_units);
    if (Number.isFinite(row.actual_invocations)) current.actual_invocations = Math.max(current.actual_invocations, row.actual_invocations);
    if (row.completed === true) current.completed = true;
    if (row.cancelled === true) current.cancelled = true;
    if (row.failure !== null && row.failure !== undefined) current.failure = String(row.failure);
    if (Number.isFinite(row.elapsed_ms)) current.elapsed_ms = Math.max(current.elapsed_ms, row.elapsed_ms);
    if (current.kind === null && row.invocation_kind) current.kind = row.invocation_kind;
    if (current.category === null && row.category) current.category = row.category;
    ops.set(row.operation_id, current);
  }
  const list = [...ops.values()];
  const byKind = (kind) => list.filter((op) => op.kind === kind);
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  // Đã đặt chỗ nhưng chưa gọi (cạn ngân sách) KHÁC lỗi vận hành thật.
  const skipped = list.filter((op) => op.actual_invocations === 0 && op.failure !== null);
  const failed = list.filter((op) => op.actual_invocations > 0 && op.failure !== null);
  const group = (rows) => ({
    operations: rows.length,
    successful_operations: rows.filter((op) => op.completed && op.failure === null).length,
    failed_operations: rows.filter((op) => op.actual_invocations > 0 && op.failure !== null).length,
    skipped_operations: rows.filter((op) => op.actual_invocations === 0 && op.failure !== null).length,
    actual_invocations: sum(rows, 'actual_invocations'),
    reserved_units: sum(rows, 'reserved_units'),
    // Tổng thời gian THẬT của nhóm (ms). Khác hẳn số lần gọi: một lần gọi có thể
    // tốn hàng trăm ms. Không có operation nào ⇒ 0, và caller tự quyết định null.
    elapsed_ms: sum(rows, 'elapsed_ms'),
  });
  return {
    operations: list.length,
    reserved_units: sum(list, 'reserved_units'),
    actual_invocations: sum(list, 'actual_invocations'),
    elapsed_ms: sum(list, 'elapsed_ms'),
    failures: failed.length,
    cancellations: list.filter((op) => op.cancelled).length,
    skipped: skipped.length,
    jev: group(byKind('http_request')),
    review: group(byKind('tool_execution')),
    jevgrep: group(byKind('process_spawn')),
  };
}

const matches = (decisions, spec, predicate) => decisions.some((row) => row
  && row.type === spec.record && typeof predicate === 'function' && predicate(row));

/**
 * Suy capability thật của MỘT lần chạy.
 * `configured` từ config đã resolve (boot record); `available`/`invoked` từ
 * bằng chứng. Không bao giờ suy từ tên arm.
 */
export function deriveCapabilities({ arm, config, decisions = [], preflight = {}, operations } = {}) {
  const rows = Array.isArray(decisions) ? decisions : [];
  const observed = rows.some((row) => row?.type === 'boot');
  const ops = operations ?? aggregateOperations(rows);
  const hasConfig = observed && config && typeof config === 'object';
  const jevErrors = rows.filter((row) => row?.type === 'jev_error');
  const keyInvalid = jevErrors.some((row) => typeof row.message === 'string' && /key invalid/i.test(row.message));
  const jevCalled = rows.some((row) => row?.type === 'jev_ok') || ops.jev.successful_operations > 0;
  let jevAvailable;
  if (!hasConfig && arm === 'vanilla') jevAvailable = false;
  else if (keyInvalid) jevAvailable = false;
  else if (preflight.credentials?.typesafe === false && preflight.credentials?.model === false) jevAvailable = false;
  else if (jevCalled) jevAvailable = true;
  // Có config nhưng không có lời gọi nào: chưa chứng minh được ⇒ `null`, không đoán.
  else jevAvailable = null;
  const jevInvoked = rows.some((row) => row?.type === 'jev_ok');

  const capabilities = {};
  for (const spec of CAPABILITY_SPECS) {
    const configured = spec.configKey === null
      ? arm !== 'vanilla' && hasConfig
      : hasConfig && config[spec.configKey] === true;
    if (!configured) { capabilities[spec.name] = { configured: false, available: false, invoked: false }; continue; }
    let available;
    if (spec.needs === 'credentials' || spec.needs === 'jev') available = jevAvailable;
    else if (spec.needs === 'review_tool') {
      available = matches(rows, spec, spec.unavailable) ? false
        : matches(rows, spec, spec.invoked) ? true : (preflight.review_tool ?? null);
    } else if (spec.needs === 'consent_channel') {
      // Không có preflight nào biết được "có người trả lời thẻ hay không" — đó là
      // tính chất của phiên chạy, không của cài đặt. Chỉ bằng chứng mới quyết.
      //
      // THỨ TỰ QUAN TRỌNG: bằng chứng TÍCH CỰC xét TRƯỚC. Một phiên có lần hết hạn
      // rồi lần sau uỷ quyền được TÔN TRỌNG (`allow_authorized`) vẫn là môi trường
      // ĐO ĐƯỢC: nếu xét hết hạn trước, ta sẽ báo `available:false` cho một phép đo
      // hoàn toàn hợp lệ (file bị xoá đúng, `false_deny:0`) và đẩy nhóm thành `hold`
      // oan. `false_deny` mới là chỉ số nói "bị chặn oan"; `available:false` chỉ
      // được khẳng định khi KHÔNG có bằng chứng nào cho thấy kênh từng phục vụ.
      const positive = spec.confirmed ?? spec.invoked;
      available = matches(rows, spec, positive) ? true
        : matches(rows, spec, spec.unavailable) ? false : null;
    } else {
      available = matches(rows, spec, spec.unavailable) ? false
        : matches(rows, spec, spec.invoked) ? true : (preflight.executables?.jg ?? null);
    }
    const invoked = spec.record === null ? jevInvoked : matches(rows, spec, spec.invoked);
    capabilities[spec.name] = { configured: true, available, invoked };
  }
  return capabilities;
}

/**
 * Các chiều định danh MỞ RỘNG được ghép vào khoá cặp cặp (khi có mặt).
 *
 * Vì sao `?? null` thay vì bắt buộc: fixture synthetic không mô phỏng một lần
 * thu thập nào nên được phép bỏ trống; nhưng bằng chứng `real` thì `validateRow`
 * BẮT BUỘC có `plugin_git_commit`/`evaluator_hash`, nên mọi row thật đều mang
 * chúng. Nhờ vậy hai lần chạy CÙNG `plugin_version` nhưng KHÁC git commit (hoặc
 * khác evaluator) không bao giờ bị gộp làm một treatment — mà fixture cũ vẫn
 * chạy được nguyên trạng.
 *
 * `model_endpoint_origin` (§6): hai provider khác nhau có thể trùng tên model;
 * ghi NGUỒN endpoint (không chứa secret) để không ghép cặp hai môi trường khác nhau.
 */
export const EXTRA_IDENTITY_DIMS = Object.freeze([
  'plugin_git_commit', 'evaluator_hash', 'dsh_git_commit', 'model_endpoint_origin',
]);

/** Khoá ghép cặp. Thiếu bất kỳ thành phần LÕI nào ⇒ `null` (row không hợp lệ). */
export function identityOf(row) {
  const required = ['task_id', 'repo_state', 'model', 'dsh_version', 'plugin_version', 'benchmark_config_hash'];
  if (!row || required.some((key) => typeof row[key] !== 'string' || !row[key].trim())) return null;
  if (!(typeof row.seed === 'string' && row.seed.trim()) && !Number.isSafeInteger(row.seed)) return null;
  const core = required.map((key) => row[key]);
  const extra = EXTRA_IDENTITY_DIMS.map((key) => (row[key] === undefined ? null : row[key]));
  return JSON.stringify(core.concat([row.seed], extra));
}

/**
 * Kiểm hình dạng capability manifest. Trả danh sách tên capability hỏng.
 *
 * `configured`/`invoked` phải là boolean; `available` phải là `true`/`false`/`null`;
 * `exercised` (nếu có) phải là boolean hoặc `null`.
 * Một entry méo mó bị TỪ CHỐI tường minh — không âm thầm coi là "không cấu hình",
 * vì như vậy sẽ biến dữ liệu hỏng thành bằng chứng hợp lệ.
 */
export function malformedCapabilities(row) {
  const capabilities = row?.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return [];
  const bad = [];
  for (const spec of CAPABILITY_SPECS) {
    const entry = capabilities[spec.name];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { bad.push(spec.name); continue; }
    if (typeof entry.configured !== 'boolean' || typeof entry.invoked !== 'boolean'
      || !(entry.available === true || entry.available === false || entry.available === null)
      // `exercised` là bằng chứng lớp ĐÃ CHẠY trong trajectory. Ba trạng thái:
      // `true` (đã chạy), `false` (chạy nhưng không tác động), `null` (chưa xác
      // định). Thiếu hẳn khoá cũng chấp nhận (`undefined`) để row cũ vẫn parse
      // được — nhưng khi đó treatment không thể chứng minh exercise.
      || !(entry.exercised === true || entry.exercised === false
        || entry.exercised === null || entry.exercised === undefined)) {
      bad.push(spec.name);
    }
  }
  return bad;
}

/** Kiểm trục đo: phải là object boolean đủ 3 khoá. Trả lý do hoặc `null`. */
function measurementAxisProblem(row) {
  const axes = row?.measurement_axes;
  if (axes === undefined) return 'missing-measurement-axes';
  if (!axes || typeof axes !== 'object' || Array.isArray(axes)) return 'malformed-measurement-axes';
  for (const axis of MEASUREMENT_AXES) {
    if (typeof axes[axis] !== 'boolean') return `malformed-measurement-axes:${axis}`;
  }
  return null;
}

/**
 * Metric số phải hữu hạn và KHÔNG âm. `null`/`undefined` = "chưa đo" (hợp lệ).
 *
 * Vì sao không coerce: `"1"` hay `NaN` từng lọt qua phép so sánh số rồi cho ra
 * kết luận sai (một chuỗi không bao giờ `> base`). Sai kiểu ⇒ TỪ CHỐI row, không
 * đoán ý người ghi.
 */
function metricTypeProblem(row, key) {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `invalid-metric:${key}`;
  return null;
}

/** Bộ đếm phải là số nguyên không âm (không chấp nhận 1.5 hay -1). */
function counterTypeProblem(row, key) {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return `invalid-metric:${key}`;
  return null;
}

/**
 * Metric số mà row PHẢI khai đúng kiểu (nếu có mặt). `tests_total`/`tests_passed`
 * cũng nằm đây để `tests_passed > tests_total` bị bắt.
 */
const NUMERIC_METRIC_KEYS = Object.freeze([
  'walltime_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cost_usd', 'generations',
]);
const COUNTER_METRIC_KEYS = Object.freeze([
  'tests_passed', 'tests_total', 'decision_reserved_units', 'decision_actual_invocations',
  'jev_http_attempts', 'review_tool_invocations', 'jevgrep_process_spawns',
  'decision_operation_failures', 'decision_operation_cancellations',
]);

/** Kiểu invocation hợp lệ của operation telemetry. */
export const INVOCATION_KINDS = Object.freeze(['http_request', 'tool_execution', 'process_spawn']);

/** Các `mode` thu thập hợp lệ. Chuỗi lạ phải bị TỪ CHỐI, không trôi qua. */
export const MODES = Object.freeze(['normal', 'jev-outage']);

/**
 * Kiểm TÍNH NHẤT QUÁN của operation telemetry (§16).
 *
 * `aggregateOperations` gộp nhiều bản ghi cùng `operation_id` (mỗi bản là một
 * snapshot luỹ kế). Gộp bằng `max`/OR rất dễ che một chuỗi SỰ KIỆN BẤT KHẢ: ví dụ
 * một bản ghi vừa `completed:true` vừa `failure:"..."`, hay `actual_invocations`
 * GIẢM giữa hai snapshot (dấu hiệu dữ liệu hỏng/bị trộn). Nếu không bắt, một
 * dataset hỏng vẫn ra metric "sạch".
 *
 * Trả `{ ok, problems }` với mỗi phần tử `{ operation_id, problem }`.
 */
export function validateOperationTelemetry(decisions) {
  const rows = Array.isArray(decisions) ? decisions : [];
  const byId = new Map();
  for (const row of rows) {
    if (!row || row.type !== 'cost_governor' || typeof row.operation_id !== 'string') continue;
    const list = byId.get(row.operation_id) ?? [];
    list.push(row);
    byId.set(row.operation_id, list);
  }
  const problems = [];
  const push = (operation_id, problem) => problems.push({ operation_id, problem });
  for (const [operation_id, list] of byId) {
    let lastActual = 0; let lastReserved = 0; let terminals = 0;
    for (const row of list) {
      if (row.invocation_kind !== undefined && row.invocation_kind !== null
        && !INVOCATION_KINDS.includes(row.invocation_kind)) {
        push(operation_id, `unknown-invocation-kind:${row.invocation_kind}`);
      }
      // Một bản ghi KHÔNG được tự mâu thuẫn: vừa hoàn tất vừa có lỗi, hoặc vừa
      // hoàn tất vừa bị huỷ.
      if (row.completed === true && row.failure !== null && row.failure !== undefined) {
        push(operation_id, 'completed-with-failure');
      }
      if (row.completed === true && row.cancelled === true) push(operation_id, 'completed-and-cancelled');
      if (Number.isFinite(row.actual_invocations)) {
        if (!Number.isSafeInteger(row.actual_invocations) || row.actual_invocations < 0) {
          push(operation_id, 'invalid-actual-invocations');
        } else if (row.actual_invocations < lastActual) push(operation_id, 'actual-invocations-decreased');
        else lastActual = row.actual_invocations;
      }
      if (Number.isFinite(row.reserved_units)) {
        if (row.reserved_units < 0) push(operation_id, 'negative-reserved-units');
        else if (row.reserved_units < lastReserved) push(operation_id, 'reserved-units-decreased');
        else lastReserved = row.reserved_units;
      }
      if (Number.isFinite(row.elapsed_ms) && row.elapsed_ms < 0) push(operation_id, 'negative-elapsed-ms');
      if (row.decision === 'operation_finished') terminals += 1;
    }
    // Nhiều terminal event cho CÙNG operation ⇒ bị ghi lặp (retry/mất đồng bộ).
    if (terminals > 1) push(operation_id, 'duplicate-terminal-event');
    // Đã thực sự gọi mà không có terminal event ⇒ thiếu dấu kết thúc. Operation
    // chỉ ĐẶT CHỖ rồi bị cắt ngân sách (`actual_invocations===0`) được phép thiếu:
    // đó là "không chạy", không phải "chạy dở".
    if (terminals === 0 && lastActual > 0) push(operation_id, 'missing-terminal-event');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Tập hợp TỐI THIỂU cho identity của bằng chứng THẬT (§10, §11): nếu thiếu, một
 * lần chạy không thể tái lập, nên không được coi là bằng chứng promotion.
 */
const REAL_IDENTITY_KEYS = Object.freeze(['plugin_git_commit', 'evaluator_hash']);

/** Kiểm tra một row có đúng schema v2 và đủ trường bắt buộc. */
export function validateRow(row) {
  const reasons = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, reasons: ['not-an-object'] };
  if (row.schema !== ROW_SCHEMA) reasons.push(`unsupported-schema:${row.schema ?? 'missing'}`);
  if (!ARMS.includes(row.arm)) reasons.push('unknown-arm');
  if (identityOf(row) === null) reasons.push('incomplete-pair-identity');
  if (!SPLITS.includes(row.split)) reasons.push(`unknown-split:${row.split ?? 'missing'}`);
  // Bằng chứng `real` PHẢI truy được về một lần thu thập cụ thể. Thiếu `run_id`
  // thì hai lần chạy khác nhau không phân biệt được, nên không có cách nào biết
  // một cặp arm có thật sự đến từ cùng một lần chạy hay không.
  //
  // CHỈ bắt buộc với `source === 'real'`: fixture synthetic không mô phỏng một
  // lần thu thập nào, nên nó được phép bỏ trống hoặc tự đặt `run_id` riêng. Siết
  // cả synthetic sẽ là nới luật sai chỗ — điều cần chặn là dữ liệu THẬT không
  // truy được nguồn.
  if (row.source === 'real' && (typeof row.run_id !== 'string' || !row.run_id.trim())) {
    reasons.push('missing-run-id');
  }
  if (row.arm === 'vanilla') {
    if (row.profile_config !== null) reasons.push('vanilla-must-not-declare-profile-config');
    if (row.profile_config_hash !== null) reasons.push('vanilla-must-not-declare-profile-config-hash');
  } else if (typeof row.profile_config_hash !== 'string' || !row.profile_config_hash.trim()) {
    reasons.push('missing-profile-config-hash');
  }
  // Hash phải TÍNH LẠI được từ dữ liệu nguồn. Chỉ kiểm "có hash" thì một row sửa
  // tay (`profile_config_hash: "fake"`) vẫn lọt.
  if (!verifyProfileConfigHash(row)) reasons.push('profile-config-hash-mismatch');
  if (!verifyBenchmarkConfigHash(row)) reasons.push('benchmark-config-hash-mismatch');
  if (!row.capabilities || typeof row.capabilities !== 'object') reasons.push('missing-capability-manifest');
  else {
    for (const name of malformedCapabilities(row)) reasons.push(`malformed-capability:${name}`);
  }
  if (!row.operations || typeof row.operations !== 'object') reasons.push('missing-operation-metrics');
  const axisProblem = measurementAxisProblem(row);
  if (axisProblem) reasons.push(axisProblem);
  // Metric an toàn chỉ có nghĩa trên task khai trục safety. Một row non-safety
  // khai `false_allow: 0` là dữ liệu TỰ MÂU THUẪN (0 nghĩa là "đã đo và đạt"),
  // và chính nó từng khiến task không liên quan safety bị tính như safety task.
  if (!Array.isArray(row.expected_capabilities_to_exercise)) {
    reasons.push('missing-expected-capabilities');
  }
  const safetyAxis = row.measurement_axes?.safety === true;
  const safetyValues = SAFETY_KEYS.map((key) => row[key]);
  if (!safetyAxis && safetyValues.some((value) => value !== null && value !== undefined)) {
    reasons.push('safety-metric-on-non-safety-task');
  }
  if (safetyAxis && safetyValues.some((value) => value !== null && value !== 0 && value !== 1)) {
    reasons.push('malformed-safety-metric');
  }
  if (row.arm !== 'experimental' && (row.effortAbstain === true || row.layer5 === true)) {
    reasons.push('effortAbstain-and-layer5-are-experimental-only');
  }
  // --- Kiểu dữ liệu nghiêm ngặt (§26): không coerce, không đoán ý. ---
  if (typeof row.success !== 'boolean') reasons.push('invalid-metric:success');
  for (const key of NUMERIC_METRIC_KEYS) {
    const problem = metricTypeProblem(row, key);
    if (problem) reasons.push(problem);
  }
  for (const key of COUNTER_METRIC_KEYS) {
    const problem = counterTypeProblem(row, key);
    if (problem) reasons.push(problem);
  }
  if (Number.isSafeInteger(row.tests_passed) && Number.isSafeInteger(row.tests_total)
    && row.tests_passed > row.tests_total) {
    reasons.push('tests-passed-exceeds-total');
  }
  if (row.mode !== undefined && row.mode !== null && !MODES.includes(row.mode)) {
    reasons.push(`unknown-mode:${row.mode}`);
  }
  // §16: telemetry vận hành KHÔNG nhất quán nghĩa là dataset hỏng. Collector đã
  // ghi `operation_telemetry_problems`; nếu row có vấn đề thì `aggregateOperations`
  // vẫn cho ra metric "sạch" và kết luận dựa trên đó là kết luận trên dữ liệu
  // không đáng tin. Phải từ chối ở đây để analyzer không thể promote row hỏng —
  // trước đây field này chỉ được ghi mà KHÔNG được kiểm (fail-open thật).
  if (Array.isArray(row.operation_telemetry_problems) && row.operation_telemetry_problems.length > 0) {
    reasons.push('operation-telemetry-inconsistent');
  }
  // --- Bằng chứng THẬT phải truy được về một nguồn TÁI LẬP được (§10, §30). ---
  // Thiếu revision chính xác hoặc evaluator hash nghĩa là hai lần chạy cùng
  // `plugin_version` vẫn có thể khác mã nguồn — không được pool làm một treatment.
  if (row.source === 'real') {
    for (const key of REAL_IDENTITY_KEYS) {
      if (typeof row[key] !== 'string' || !row[key].trim()) reasons.push(`missing-${key.replace(/_/g, '-')}`);
    }
    if (row.plugin_dirty_state === true) reasons.push('unreproducible-plugin-state');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Môi trường capability của arm có hợp lệ cho promotion không.
 *
 * `available === false` ⇒ hạ tầng thiếu (không phải regression hiệu năng).
 * `available === null` ⇒ chưa chứng minh được ⇒ không tự đoán là đạt.
 *
 * `expected` (tuỳ chọn) giới hạn phạm vi kiểm: một task không hề cần `jevgrep`
 * thì việc `jevgrep` không đo được KHÔNG làm mất giá trị phép đo của task đó.
 * Khi bỏ trống, mọi capability đã cấu hình đều phải kiểm được (mặc định bảo thủ).
 *
 * `role` quyết định luật `configured`:
 *   - `baseline` (vanilla): arm nền KHÔNG cấu hình plugin capability là ĐÚNG —
 *     entry `configured:false` được bỏ qua, không phải thiếu bằng chứng.
 *   - `treatment`: task KHAI cần capability `x` thì arm treatment PHẢI thật sự
 *     cấu hình `x` (`configured === true`). `configured:false` trên treatment là
 *     bằng chứng MÂU THUẪN với hợp đồng task ⇒ invalid, KHÔNG được coi là "không
 *     áp dụng". Nếu bỏ qua, một treatment chưa hề bật lớp mà task yêu cầu vẫn ra
 *     `valid` và đẩy nhóm lên `eligible-for-review` — đúng lỗ fail-open cần chặn.
 *   - `null`/bỏ trống: giữ luật bảo thủ cũ (chỉ bắt entry THIẾU), để các caller
 *     chẩn đoán không phải khai role.
 *
 * `exercised` (§2): khi treatment khai `expected` capability `x`, `x` phải có
 * bằng chứng ĐÃ CHẠY (`entry.exercised === true`). `available` chỉ nói "có sẵn",
 * KHÔNG nói "đã chạy" — một task recovery có jg sẵn nhưng không bao giờ kích hoạt
 * vẫn `available:true, exercised:false`, và phép đo lớp đó là RỖNG. Trạng thái
 * này là `incomplete` (thiếu bằng chứng), KHÔNG phải `regression`.
 */
export function capabilityValidity(row, expected = null, { role = null } = {}) {
  const capabilities = row?.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    return { valid: false, reasons: ['missing-capability-manifest'], invalid: [], incomplete: [] };
  }
  const scope = Array.isArray(expected) ? new Set(expected) : null;
  const declared = Array.isArray(row?.expected_capabilities_to_exercise)
    ? new Set(row.expected_capabilities_to_exercise) : null;
  const invalid = []; const incomplete = [];
  for (const spec of CAPABILITY_SPECS) {
    // Ngoài phạm vi `expected` ⇒ không kiểm (task không cần lớp này).
    if (scope && !scope.has(spec.name)) continue;
    // Trong phạm vi kiểm (do caller khai) HOẶC do chính row khai cần exercise.
    const wanted = scope ? true : (declared?.has(spec.name) ?? false);
    const entry = capabilities[spec.name];
    // Task KHAI cần exercise lớp này nhưng manifest KHÔNG báo cáo gì về nó ⇒ thiếu
    // bằng chứng, KHÔNG được coi là hợp lệ (fail-closed).
    if (entry === undefined) {
      if (scope || declared?.has(spec.name)) incomplete.push(spec.name);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    // Treatment phải THẬT SỰ bật lớp mà task yêu cầu.
    if (role === 'treatment' && wanted && entry.configured !== true) {
      invalid.push(spec.name);
      continue;
    }
    if (entry.configured !== true) continue;
    if (entry.available === false) invalid.push(spec.name);
    else if (entry.available !== true) incomplete.push(spec.name);
    // `available:true` chưa đủ: treatment phải CHỨNG MINH lớp đã chạy.
    else if (role === 'treatment' && wanted && entry.exercised !== true) incomplete.push(spec.name);
  }
  const reasons = [];
  if (invalid.length) reasons.push('invalid-capability-environment');
  if (incomplete.length) reasons.push('incomplete-capability-evidence');
  return { valid: reasons.length === 0, reasons, invalid, incomplete };
}

/**
 * Các trường metadata PHẢI giống nhau trong một nhóm ghép cặp. `profile` và
 * `profile_config_hash` KHÔNG nằm đây: chúng là định danh treatment của arm.
 *
 * `run_id` CÓ nằm đây nhưng KHÔNG nằm trong `identityOf`/khoá ghép cặp. Đó là
 * điểm mấu chốt: `run_id` là RANH GIỚI của một lần thu thập, không phải phần
 * định danh của cặp. Hai lần chạy CÙNG task/seed (khác `run_id`) vì thế rơi vào
 * CÙNG một group — nhờ vậy `groupConsistency` mới thấy được rằng group đã trộn
 * arm từ hai lần thu thập khác nhau và loại nó (`inconsistent-group-run-id`).
 * Nếu `run_id` vào khoá ghép cặp, hai lần chạy sẽ tách thành hai group riêng và
 * sự trộn lẫn trở nên VÔ HÌNH — đúng lỗi cần chặn.
 *
 * `created_at` CỐ Ý không nằm đây: nó là dấu thời gian của cùng một lần thu thập
 * (mọi row cùng `run_id` chia sẻ nó), và giữ nó ngoài group giúp group không bị
 * loại chỉ vì một row lệch mili-giây.
 */
export const GROUP_COMMON_FIELDS = Object.freeze([
  'source', 'split', 'mode', 'run_id', 'task_class', 'task_prompt_hash', 'permission_mode',
  'dsh_version', 'plugin_version', 'benchmark_config_hash', 'measurement_axes',
  'plugin_git_commit', 'evaluator_hash', 'dsh_git_commit', 'model_endpoint_origin',
  'collector_version', 'cache_mode',
]);

/**
 * Đối chiếu manifest với chính các row đã ghi (§5).
 *
 * Manifest là lời KHAI của collector; row là bằng chứng THẬT. Hai thứ phải khớp
 * trên mọi chiều: `run_id`, `split`, `mode`, `collector_version`, số row mong đợi
 * và số row thực, cùng danh sách task/arm/seed. Trước đây analyzer chỉ đọc
 * `written_rows` rồi tin — nên một manifest bị sửa (đổi `run_id`, thêm arm,
 * giấu seed) vẫn qua được.
 *
 * THUẦN. Trả `{ ok, problems }` — `problems` là mảng chuỗi machine-readable.
 * Không tự sửa dữ liệu: chỉ nói "không tin được".
 */
export function verifyManifestAgainstRows(rows, manifest) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const problems = [];
  if (manifest === null || manifest === undefined) return { ok: false, problems: ['no-run-manifest'] };
  if (typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, problems: ['malformed-run-manifest'] };
  if (manifest.status !== 'complete') problems.push('incomplete-run-manifest');
  if (!Number.isSafeInteger(manifest.written_rows) || !Number.isSafeInteger(manifest.expected_rows)) {
    problems.push('manifest-row-counts-missing');
  } else if (manifest.written_rows !== manifest.expected_rows) {
    problems.push('manifest-wrote-fewer-rows-than-expected');
  }
  // Số row THẬT phải bằng số manifest khai — nếu không, file bị cắt/sửa.
  if (Number.isSafeInteger(manifest.written_rows) && manifest.written_rows !== list.length) {
    problems.push(`manifest-written-rows-mismatch:${manifest.written_rows}!=${list.length}`);
  }
  const real = list.filter((row) => row.source === 'real');
  if (real.length > 0) {
    if (typeof manifest.run_id !== 'string' || !manifest.run_id.trim()) problems.push('manifest-missing-run-id');
    else if (real.some((row) => row.run_id !== manifest.run_id)) problems.push('manifest-run-id-mismatch');
  }
  const distinct = (key) => [...new Set(list.map((row) => canonicalJson(row[key] ?? null)))];
  for (const field of ['split', 'mode', 'collector_version']) {
    if (manifest[field] === undefined) { problems.push(`manifest-${field.replace(/_/g, '-')}-missing`); continue; }
    const values = distinct(field);
    if (values.length > 1) problems.push(`rows-mixed-${field.replace(/_/g, '-')}`);
    else if (values.length === 1 && canonicalJson(manifest[field]) !== values[0]) {
      problems.push(`manifest-${field.replace(/_/g, '-')}-mismatch`);
    }
  }
  // Danh sách task/arm/seed phải khớp CHÍNH XÁC tập hợp trong row. Thiếu khai báo
  // KHÔNG được miễn: manifest chỉ có counts+run_id từng qua được cross-check, nên
  // một manifest bị cắt bỏ `arms`/`tasks`/`seeds` vẫn "verified" (§5/§22/§29).
  const compareSet = (field, rowsOf) => {
    if (!Array.isArray(manifest[field])) {
      problems.push(`manifest-${field}-${manifest[field] === undefined ? 'missing' : 'malformed'}`);
      return null;
    }
    const declared = [...new Set(manifest[field].map((value) => canonicalJson(value)))].sort();
    const actual = [...new Set(rowsOf().map((value) => canonicalJson(value)))].sort();
    if (canonicalJson(declared) !== canonicalJson(actual)) {
      problems.push(`manifest-${field}-mismatch`);
    }
    return manifest[field];
  };
  const arms = compareSet('arms', () => list.map((row) => row.arm));
  const tasks = compareSet('tasks', () => list.map((row) => row.task_id));
  const seeds = compareSet('seeds', () => list.map((row) => row.seed));
  // `expected_rows` phải bằng tích số khai báo arms × tasks × seeds, không chỉ bằng
  // `written_rows` — nếu không, một run khai `arms:[vanilla]` mà ghi 4 arm vẫn qua
  // nếu written_rows khớp số dòng thật (§22).
  if (Number.isSafeInteger(manifest.expected_rows) && arms && tasks && seeds) {
    const computed = arms.length * tasks.length * seeds.length;
    if (manifest.expected_rows !== computed) {
      problems.push(`manifest-expected-rows-mismatch:${manifest.expected_rows}!=${computed}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Kiểm tính nhất quán của MỘT nhóm đủ arm.
 *
 * Trước đây provenance lấy từ row đầu tiên, nên một nhóm trộn `held-out` với
 * `validation` (hoặc `normal` với `jev-outage`) vẫn có thể bị gắn nhãn held-out.
 * Ở đây mọi trường chung phải KHỚP trên tất cả arm; khác nhau ⇒ nhóm bị vô hiệu.
 */
export function groupConsistency(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const problems = [];
  if (list.length === 0) return { consistent: false, reasons: ['empty-group'] };
  for (const field of GROUP_COMMON_FIELDS) {
    const values = new Set(list.map((row) => canonicalJson(row[field] ?? null)));
    if (values.size > 1) problems.push(`inconsistent-group-${field.replace(/_/g, '-')}`);
  }
  return { consistent: problems.length === 0, reasons: problems };
}

/**
 * Metric dùng để phán quyết promotion. `kind` quyết định lý do khi thụt lùi,
 * `axis` quyết định metric đó có hiệu lực trên task nào.
 */
export const PRIMARY_KEYS = Object.freeze([
  'success', 'test_pass_rate', 'walltime_ms', 'cost_usd', 'false_allow', 'false_deny',
]);

/**
 * Bảng direction/kind/axis/required cho từng metric promotion.
 *
 * `axis` quyết định metric chỉ được xét trên task thật sự đo trục đó.
 * `required` quyết định metric THIẾU có chặn promotion không.
 *
 * §7: chi phí phải tách "tiền thật" (`cost_usd`, KHÔNG có nguồn dữ liệu ⇒ optional)
 * khỏi "chi phí nguồn lực đo được" (`resource_invocations` = số lần gọi thật từ
 * operation telemetry ⇒ REQUIRED, vì nó có nguồn thật). Token vào/ra cũng là chi
 * phí nguồn lực nhưng CHỈ bắt buộc khi provider thực sự trả usage — hiện dsh
 * headless không phát `step_end` nên chúng `null`; đánh dấu `required:false` để
 * "chưa đo được" không bị biến thành "không đạt", nhưng cũng không tự thành 0.
 */
export function promotionMetrics() {
  return {
    success: { direction: 'higher-is-better', kind: 'quality', axis: 'quality', required: true },
    test_pass_rate: { direction: 'higher-is-better', kind: 'quality', axis: 'quality', required: true },
    walltime_ms: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: true },
    resource_invocations: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: true },
    cost_usd: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: false },
    input_tokens: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: false },
    output_tokens: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: false },
    reasoning_tokens: { direction: 'lower-is-better', kind: 'performance', axis: 'performance', required: false },
    false_allow: { direction: 'lower-is-better', kind: 'safety', axis: 'safety', required: true },
    false_deny: { direction: 'lower-is-better', kind: 'safety', axis: 'safety', required: true },
  };
}

/** Row có khai trục đo `axis` được bật không. Thiếu metadata ⇒ coi như KHÔNG đo. */
export function measuresAxis(row, axis) {
  return row?.measurement_axes?.[axis] === true;
}

/**
 * Nguồn gốc bản ghi: `held-out-real` | `real` | `synthetic` | `unknown`.
 * Chỉ `held-out-real` mới là bằng chứng promotion; pilot validation chỉ là `real`.
 */
export function provenance(record) {
  if (!record || typeof record !== 'object') return 'unknown';
  const source = typeof record.source === 'string' ? record.source.trim() : '';
  if (!source) return 'unknown';
  if (/synthetic|illustrative|example|fixture|fake|made-?up|dummy|mock|toy|placeholder/i.test(source)) return 'synthetic';
  if (/^real$/i.test(source)) return record.split === 'held-out' ? 'held-out-real' : 'real';
  return 'unknown';
}

/**
 * Tra cứu executable trên PATH — kiểm QUYỀN CHẠY THẬT, không chỉ tồn tại.
 *
 * Bản cũ dùng `existsSync`: một file `jg` tồn tại nhưng thiếu bit +x vẫn báo
 * `available=true`, rồi lần spawn thật fail. Preflight phải dùng cùng semantics
 * với runtime (`access(X_OK)`), nếu không preflight nói dối.
 */
export function executableAvailable(name, env = process.env) {
  const path = env.PATH ?? '';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const check = (candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  };
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      if (check(`${dir}/${name}${suffix}`)) return true;
    }
  }
  return false;
}
