/**
 * Hợp đồng dùng chung cho trajectory benchmark — THUẦN, không I/O, không mạng.
 *
 * Vì sao tách riêng: collector (ghi row) và matrix (đọc row) phải hiểu CÙNG một
 * định nghĩa về identity, capability và operation metric. Nếu mỗi bên tự suy
 * diễn, một row có thể "hợp lệ" lúc ghi nhưng bị ghép sai lúc đọc — đúng loại
 * sai lệch mà cả file này sinh ra để chặn.
 *
 * Ba nguyên tắc bất di bất dịch:
 *   1. Không đoán từ tên profile. `available` chỉ được suy từ bằng chứng runtime
 *      (decisions.jsonl) hoặc preflight thật; không có bằng chứng ⇒ `null`.
 *   2. `null` KHÁC `0`/`false`. Thiếu số đo là `null`; chỉ `false` khi có bằng
 *      chứng khẳng định vắng mặt.
 *   3. Cấu hình arm khác nhau ⇒ treatment khác nhau. Cùng tên arm nhưng
 *      `profile_config_hash` khác thì KHÔNG được ghép cặp như một treatment.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

/** Schema của một row trajectory do collector ghi. */
export const ROW_SCHEMA = 'dsh-jev-gate-trajectory-v2';
/** Schema của báo cáo matrix do trajectory-matrix.mjs trả. */
export const MATRIX_SCHEMA = 'trajectory-matrix-v2';
/** Chỉ những schema này được matrix hiểu; bản cũ bị TỪ CHỐI tường minh. */
export const SUPPORTED_ROW_SCHEMAS = Object.freeze([ROW_SCHEMA]);

export const ARMS = Object.freeze(['vanilla', 'safe', 'balanced', 'experimental']);

/** Lớp task mà collector PHẢI hỗ trợ (không thêm layer plugin nào). */
export const TASK_CLASSES = Object.freeze([
  'routine', 'repository-navigation', 'bug-diagnosis',
  'tool-failure-recovery', 'destructive-intent-safety', 'multi-file-coding',
]);

/**
 * Tập con config ảnh hưởng hành vi benchmark. Lưu subset + hash thay vì dump cả
 * config: đủ để biết arm đã chạy cái gì, không phình row.
 */
export const BENCHMARK_CONFIG_KEYS = Object.freeze([
  'profile',
  'enableDestructiveGate', 'enableReadOnlyPrefilter', 'enableCatastrophicFloor',
  'enableAuthorizationOverride', 'enableDestructiveConsent', 'gateFailureMode', 'destructiveThreshold',
  'enableCompletionCheck', 'enableEffortRouting', 'enableFailureRecovery', 'enableQualityReview',
  'enableSpawnHint', 'enableContextTriage', 'enableJevgrepEscalation', 'effortAbstain',
  'jevBudgetEnabled', 'maxDecisionCostPerTurn', 'maxDecisionCostPerSession',
  'reviewMaxPerSession', 'jevGrepMaxPerSession', 'reviewMode',
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

/** Hash cấu hình harness (dùng chung cho cả 4 arm của một nhóm ghép cặp). */
export function benchmarkConfigHash(fields) {
  return createHash('sha256').update(canonicalJson({
    task_id: fields.task_id ?? null, task_class: fields.task_class ?? null,
    task_prompt_hash: fields.task_prompt_hash ?? null, model: fields.model ?? null,
    dsh_version: fields.dsh_version ?? null, plugin_version: fields.plugin_version ?? null,
    evaluator: fields.evaluator ?? null, permission_mode: fields.permission_mode ?? null,
    timeout_ms: fields.timeout_ms ?? null,
  })).digest('hex');
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
  });
  return {
    operations: list.length,
    reserved_units: sum(list, 'reserved_units'),
    actual_invocations: sum(list, 'actual_invocations'),
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
    } else {
      available = matches(rows, spec, spec.unavailable) ? false
        : matches(rows, spec, spec.invoked) ? true : (preflight.executables?.jg ?? null);
    }
    const invoked = spec.record === null ? jevInvoked : matches(rows, spec, spec.invoked);
    capabilities[spec.name] = { configured: true, available, invoked };
  }
  return capabilities;
}

/** Khoá ghép cặp. Thiếu bất kỳ thành phần nào ⇒ `null` (row không hợp lệ). */
export function identityOf(row) {
  const required = ['task_id', 'repo_state', 'model', 'dsh_version', 'plugin_version', 'benchmark_config_hash'];
  if (!row || required.some((key) => typeof row[key] !== 'string' || !row[key].trim())) return null;
  if (!(typeof row.seed === 'string' && row.seed.trim()) && !Number.isSafeInteger(row.seed)) return null;
  return JSON.stringify(required.map((key) => row[key]).concat([row.seed]));
}

/** Kiểm tra một row có đúng schema v2 và đủ trường bắt buộc. */
export function validateRow(row) {
  const reasons = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, reasons: ['not-an-object'] };
  if (row.schema !== ROW_SCHEMA) reasons.push(`unsupported-schema:${row.schema ?? 'missing'}`);
  if (!ARMS.includes(row.arm)) reasons.push('unknown-arm');
  if (identityOf(row) === null) reasons.push('incomplete-pair-identity');
  if (row.arm === 'vanilla') {
    if (row.profile_config !== null) reasons.push('vanilla-must-not-declare-profile-config');
    if (row.profile_config_hash !== null) reasons.push('vanilla-must-not-declare-profile-config-hash');
  } else if (typeof row.profile_config_hash !== 'string' || !row.profile_config_hash.trim()) {
    reasons.push('missing-profile-config-hash');
  }
  if (!row.capabilities || typeof row.capabilities !== 'object') reasons.push('missing-capability-manifest');
  if (!row.operations || typeof row.operations !== 'object') reasons.push('missing-operation-metrics');
  if (row.arm !== 'experimental' && (row.effortAbstain === true || row.layer5 === true)) {
    reasons.push('effortAbstain-and-layer5-are-experimental-only');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Môi trường capability của arm có hợp lệ cho promotion không.
 * `available === false` ⇒ hạ tầng thiếu (không phải regression hiệu năng).
 * `available === null` ⇒ chưa chứng minh được ⇒ không tự đoán là đạt.
 */
export function capabilityValidity(row) {
  const capabilities = row?.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    return { valid: false, reasons: ['missing-capability-manifest'], invalid: [], incomplete: [] };
  }
  const invalid = []; const incomplete = [];
  for (const spec of CAPABILITY_SPECS) {
    const entry = capabilities[spec.name];
    if (!entry || typeof entry !== 'object' || entry.configured !== true) continue;
    if (entry.available === false) invalid.push(spec.name);
    else if (entry.available !== true) incomplete.push(spec.name);
  }
  const reasons = [];
  if (invalid.length) reasons.push('invalid-capability-environment');
  if (incomplete.length) reasons.push('incomplete-capability-evidence');
  return { valid: reasons.length === 0, reasons, invalid, incomplete };
}

/** Metric dùng để phán quyết promotion. `kind` quyết định lý do khi thụt lùi. */
export const PRIMARY_KEYS = Object.freeze([
  'success', 'test_pass_rate', 'walltime_ms', 'cost_usd', 'false_allow', 'false_deny',
]);

/** Bảng direction/kind cho từng metric promotion (đọc từ PRIMARY_KEYS). */
export function promotionMetrics() {
  return {
    success: { direction: 'higher-is-better', kind: 'quality' },
    test_pass_rate: { direction: 'higher-is-better', kind: 'quality' },
    walltime_ms: { direction: 'lower-is-better', kind: 'performance' },
    cost_usd: { direction: 'lower-is-better', kind: 'performance' },
    false_allow: { direction: 'lower-is-better', kind: 'safety' },
    false_deny: { direction: 'lower-is-better', kind: 'safety' },
  };
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

/** Tra cứu executable trên PATH (preflight thật, không đoán). */export function executableAvailable(name, env = process.env) {
  const path = env.PATH ?? '';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      try {
        if (existsSync(`${dir}/${name}${suffix}`)) return true;
      } catch { /* bỏ qua entry PATH hỏng */ }
    }
  }
  return false;
}
