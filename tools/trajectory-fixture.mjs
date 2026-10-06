/**
 * Fixture dùng CHUNG cho test — KHÔNG phải công cụ production.
 *
 * Vì sao tách riêng: từ v4, một row hợp lệ cần RẤT nhiều trường (hash cấu hình,
 * identity đầy đủ, manifest capability, trục đo...). Nếu mỗi suite tự dựng row
 * bằng tay, chúng sẽ lệch nhau và một fixture sai sẽ khiến test "xanh giả". Mọi
 * suite (self-test, adversarial, mutation, property, promotion) dùng CÙNG builder
 * này, nên một thay đổi hợp đồng chỉ cần sửa một chỗ.
 *
 * Mọi giá trị ở đây là BỊA (synthetic) — không đo gì thật, không gọi mạng. Row
 * `source:'real'` chỉ để kiểm luật parser/promotion, không phải bằng chứng.
 */
import { ARMS, benchmarkConfigFor, benchmarkConfigHash, CAPABILITY_SPECS,
  profileConfigHash, ROW_SCHEMA } from './trajectory-schema.mjs';
import { matrix } from './trajectory-matrix.mjs';

/** Trục đo cho task KHÔNG đo an toàn. */
export const PLAIN_AXES = Object.freeze({ quality: true, performance: true, safety: false });
/** Trục đo cho task CÓ ground truth an toàn. */
export const SAFETY_AXES = Object.freeze({ quality: true, performance: true, safety: true });

export const FIXTURE_RUN_ID = 'fixture-run-1';
export const FIXTURE_COLLECTOR = '2';
export const FIXTURE_PLUGIN_COMMIT = 'a'.repeat(40);
export const FIXTURE_EVALUATOR_HASH = 'b'.repeat(64);

/** Trường harness dùng để tính `benchmark_config`/`benchmark_config_hash`. */
export function benchFields(overrides = {}) {
  return {
    task_id: 'synthetic-task', task_class: 'routine', task_prompt_hash: 'prompt-hash',
    model: 'trajectory-router/synthetic', dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
    evaluator: 'synthetic-task', permission_mode: 'workspace-write', timeout_ms: 60_000,
    ...overrides,
  };
}

/**
 * Manifest capability cho một arm. Mặc định: mọi capability mà arm CẤU HÌNH đều
 * `available:true, invoked:true, exercised:true`. `configured` suy từ config thật
 * của arm (vanilla: chỉ `jev` là "không cấu hình"), KHÔNG suy từ tên arm cho các
 * lớp plugin — ở đây ta khai tường minh để test kiểm đúng luật.
 */
export function capsFor(arm, overrides = {}) {
  const capabilities = {};
  for (const spec of CAPABILITY_SPECS) {
    // vanilla KHÔNG cấu hình lớp plugin nào (đúng dạng row vanilla thật); các arm
    // còn lại cấu hình và chạy được mọi lớp (test kiểm luật, không kiểm plugin).
    const configured = arm !== 'vanilla';
    capabilities[spec.name] = { configured, available: configured, invoked: configured, exercised: configured };
  }
  return { ...capabilities, ...overrides };
}

/**
 * Dựng một row hợp lệ theo v4. Mọi hash được TÍNH LẠI sau khi áp override, nếu
 * không một row "sửa tay" sẽ tự vô hiệu bởi chính phép kiểm hash.
 */
export function makeRow(arm, overrides = {}) {
  if (!ARMS.includes(arm)) throw new Error(`fixture: unknown arm ${arm}`);
  const axes = overrides.measurement_axes ?? PLAIN_AXES;
  const safety = axes.safety === true;
  const profileConfig = overrides.profile_config !== undefined
    ? overrides.profile_config : (arm === 'vanilla' ? null : { profile: arm });
  const merged = { ...overrides };
  delete merged.measurement_axes;
  delete merged.profile_config;
  const row = {
    schema: ROW_SCHEMA,
    task_id: 'synthetic-task', task_class: 'routine', seed: 1,
    repo_state: 'fixturehash', model: 'trajectory-router/synthetic',
    dsh_version: '0.2.0-rc.2', plugin_version: '0.14.0',
    plugin_git_commit: FIXTURE_PLUGIN_COMMIT, evaluator_hash: FIXTURE_EVALUATOR_HASH,
    plugin_dirty_state: false, collector_version: FIXTURE_COLLECTOR, cache_mode: 'cold',
    run_id: FIXTURE_RUN_ID, mode: 'normal',
    arm, source: 'synthetic', split: 'held-out',
    profile: arm === 'vanilla' ? null : arm,
    profile_config: profileConfig,
    measurement_axes: axes,
    expected_capabilities_to_exercise: [],
    capabilities: capsFor(arm),
    operations: { reserved_units: 1, actual_invocations: 1, jev: { actual_invocations: 1 } },
    success: true, tests_passed: 1, tests_total: 1,
    false_allow: safety ? 0 : null, false_deny: safety ? 0 : null,
    walltime_ms: 100, cost_usd: null, effort: 'low',
    decision_reserved_units: 1, decision_actual_invocations: 1,
    jev_http_attempts: arm === 'vanilla' ? 0 : 1,
    review_tool_invocations: 0, jevgrep_process_spawns: 0,
    decision_operation_failures: 0, decision_operation_cancellations: 0,
    ...merged,
  };
  row.benchmark_config = overrides.benchmark_config
    ?? benchmarkConfigFor(benchFields({ task_id: row.task_id, task_class: row.task_class }));
  row.benchmark_config_hash = overrides.benchmark_config_hash
    ?? benchmarkConfigHash(row.benchmark_config);
  // Hash profile PHẢI tính sau cùng, từ chính `profile_config` cuối cùng — TRỪ khi
  // test CỐ Ý tiêm hash sai (tamper). `??` tôn trọng giá trị tường minh, kể cả khi
  // đó là hash bịa, để phép kiểm "hash tính lại ≠ hash khai" có đối tượng để bắt.
  row.profile_config_hash = overrides.profile_config_hash !== undefined
    ? overrides.profile_config_hash
    : (row.profile_config === null ? null : profileConfigHash(row.profile_config));
  return row;
}

/**
 * Manifest khớp với một tập row (để `verifyManifestAgainstRows` chấp nhận).
 * Mặc định đủ tính chất của một lần thu thập hoàn chỉnh.
 */
export function manifestFor(rows, overrides = {}) {
  const list = rows.filter(Boolean);
  return {
    status: 'complete',
    expected_rows: list.length, written_rows: list.length,
    run_id: list[0]?.run_id ?? FIXTURE_RUN_ID,
    split: list[0]?.split ?? 'held-out', mode: list[0]?.mode ?? 'normal',
    collector_version: list[0]?.collector_version ?? FIXTURE_COLLECTOR,
    arms: [...new Set(list.map((row) => row.arm))],
    tasks: [...new Set(list.map((row) => row.task_id))],
    seeds: [...new Set(list.map((row) => row.seed))],
    ...overrides,
  };
}

/**
 * Dataset "khỏe": `pairs` nhóm × 4 arm, held-out real, đủ mọi metric bắt buộc.
 * Dùng làm điểm xuất phát cho test mutation (mọi mutation phải làm mất eligible).
 */
export function healthyHeldOut({ pairs = 10, overrides = {}, taskClass = null } = {}) {
  const rows = [];
  for (let i = 0; i < pairs; i += 1) {
    for (const arm of ARMS) {
      rows.push(makeRow(arm, {
        seed: i,
        source: 'real', split: 'held-out',
        task_class: taskClass ?? (i % 2 ? 'routine' : 'bug-diagnosis'),
        ...overrides,
      }));
    }
  }
  return rows;
}

/** Encode một tập row thành JSONL. */
export function encode(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/**
 * Run-integrity cho FIXTURE. Theo §4, một dataset `source:'real'` không có bằng
 * chứng integrity phải `hold`. Nhưng fixture test KHÔNG phải một lần thu thập
 * thật: tính toàn vẹn của nó được bảo đảm bởi chính builder, nên khai tường minh
 * `source:'synthetic-fixture'` là cách DUY NHẤT để miễn gate mà không giả vờ có
 * manifest thật. Không có nhánh nào khác được miễn — nên không có khe hở.
 */
export const SYNTHETIC_INTEGRITY = Object.freeze({
  verified: true, source: 'synthetic-fixture', problems: [],
});

/** `matrix()` cho fixture: tiêm run-integrity synthetic, tôn trọng option khác. */
export function analyze(text, options = {}) {
  return matrix(text, { runIntegrity: SYNTHETIC_INTEGRITY, ...options });
}
