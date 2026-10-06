/**
 * Collector cho trajectory benchmark — chạy THẬT 4 arm trên một task fixture,
 * ghi mỗi lần chạy thành một row có schema version rõ ràng.
 *
 * Ba bất biến correctness (lý do file này tồn tại):
 *   1. BỐN ARM LÀ A/B THẬT. `safe`/`balanced`/`experimental` đều phụ thuộc Jev;
 *      thiếu `TYPESAFE_API_KEY` sẽ khiến các lớp Jev fail-open và collector vẫn
 *      sinh record — biến "vanilla vs profile" thành "vanilla vs profile mất
 *      backend". Vì vậy normal collection KIỂM TRA CẢ HAI credential TRƯỚC khi
 *      chạy arm nào, và KHÔNG sinh partial record khi thiếu.
 *   2. MỖI ROW GHI CAPABILITY THẬT. Tên arm KHÔNG phải bằng chứng capability đã
 *      có; `available`/`invoked` suy từ decisions.jsonl + preflight thật.
 *   3. GHÉP CẶP CHỈ KHI CÙNG MÔI TRƯỜNG. Identity gồm dsh_version,
 *      plugin_version và benchmark_config_hash, nên row khác runtime/config
 *      không bị ghép nhầm.
 *
 * Benchmark hành vi khi Jev outage là MODE RIÊNG (`--jev-outage`), không trộn
 * với normal performance benchmark: row outage mang `mode: 'jev-outage'` và bị
 * promotion từ chối.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aggregateOperations, ARMS, benchmarkConfigFor, benchmarkConfigHash, benchmarkRelevant,
  canonicalJson, CAPABILITY_SPECS, deriveCapabilities, executableAvailable, profileConfigHash, ROW_SCHEMA,
  sha256, SPLITS, validateOperationTelemetry }
  from './trajectory-schema.mjs';
import { fixtureHash, taskById, TASKS } from './trajectory-tasks.mjs';
// Profile preset THẬT (không suy từ tên arm): cần để kiểm task-capability contract
// TRƯỚC khi spawn. `lib/profiles.mjs` là module thuần, không kéo theo runtime DSH.
import { PROFILES } from '../lib/profiles.mjs';
import { confinementProblems, diffWorkspaces, snapshotWorkspaceDetail } from './workspace-snapshot.mjs';

/**
 * Đường dẫn manifest đi kèm file JSONL. Manifest cho biết lần chạy đã hoàn tất
 * hay chưa: row được ghi dần nên một tiến trình bị giết giữa chừng để lại file
 * JSONL THIẾU row mà nhìn bề ngoài không khác gì file đầy đủ. Consumer phải đọc
 * manifest để không phân tích nhầm một lần chạy dở thành bằng chứng hoàn chỉnh.
 */
export function manifestPathFor(output) {
  return `${resolve(output)}.manifest.json`;
}

/** Ghi manifest (incomplete lúc bắt đầu, complete lúc kết thúc). */
async function writeManifest(output, fields) {
  await writeFile(manifestPathFor(output), `${JSON.stringify(fields, null, 2)}\n`);
}

/** Đọc manifest; `null` nếu chưa có. THUẦN đọc, không ném khi file thiếu. */
export async function readManifest(output) {
  try { return JSON.parse(await readFile(manifestPathFor(output), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version;
const DEFAULT_TASK = 'navigation-marker-v1';

/**
 * Version của CHÍNH collector (định dạng row), KHÔNG phải version plugin.
 *
 * Vì sao tách khỏi `PACKAGE_VERSION`: cùng một bản plugin có thể ghi row bằng hai
 * phiên bản collector khác nhau (schema đổi, thêm field). Nếu dùng chung số
 * version plugin thì không ai phân biệt được một row cũ (thiếu field mới) với
 * một row mới, nên `verifyManifestAgainstRows` cũng không thể đối chiếu. Bump
 * hằng số này mỗi khi định dạng row đổi.
 */
export const COLLECTOR_VERSION = '2';

/**
 * Ghi chú về `seed` của benchmark, đi kèm mọi row.
 *
 * ĐIỂM CỰC KỲ DỄ HIỂU SAI: `seed` ở đây KHÔNG phải sampling seed của provider.
 * Nó là một REPLICATION ID dùng để xoay THỨ TỰ arm và (gián tiếp) chọn định danh
 * fixture lặp lại. Provider vẫn có thể lấy mẫu ngẫu nhiên theo cách riêng của nó
 * — hai lần chạy cùng `seed` vẫn có thể ra kết quả khác nhau. Vì vậy mọi kết
 * luận "tái lập được" phải dựa trên số lần lặp, KHÔNG dựa trên giả định rằng
 * provider bị seed.
 */
export const SEED_NOTE = 'seed rotates arm order and fixture replication identity; '
  + 'it is NOT a provider sampling seed, so provider randomness is not reproducible.';

/** Ánh xạ khoá usage của provider sang tên metric chuẩn của row. */
export const USAGE_TOKEN_KEYS = Object.freeze({
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  reasoningTokens: 'reasoning_tokens',
  cacheReadTokens: 'cache_read_tokens',
});

/**
 * Loại event usage LUỸ KẾ (đã là TỔNG, không phải số tăng thêm).
 *
 * Hợp đồng: provider có thể phát usage theo hai kiểu trái ngược nhau. Kiểu
 * `step_end` là số TĂNG của MỘT generation (cộng dồn qua các generation). Kiểu
 * luỹ kế (`cumulative:true`, hoặc type/phase tổng kết) là TỔNG của cả phiên —
 * cộng nó vào các số tăng sẽ đếm trùng gấp đôi. Vì vậy nhận diện tường minh và
 * xử lý riêng, KHÔNG đoán.
 */
const CUMULATIVE_USAGE_TYPES = new Set(['usage_summary', 'session_usage', 'usage_totals']);

/** Event có mang usage hợp lệ không (có `usage` object, hoặc chính nó là tổng). */
function usagePayload(event) {
  if (!event || typeof event !== 'object') return null;
  const usage = event.usage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) return usage;
  return null;
}

/** Event usage này có phải TỔNG luỹ kế không (thay vì số tăng một generation). */
function isCumulativeUsage(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.cumulative === true) return true;
  return CUMULATIVE_USAGE_TYPES.has(event.type) || CUMULATIVE_USAGE_TYPES.has(event.phase);
}

/**
 * Event usage này có được TIN không. CHỈ nhận hai hình dạng đã biết:
 *   - `status`/`step_end` (số tăng mỗi generation), hoặc
 *   - event luỹ kế (tổng phiên).
 * Mọi hình dạng lạ bị BỎ QUA — một event không hiểu được thì không được phép
 * đóng góp vào metric token, vì ta sẽ không biết nó là tăng hay tổng.
 */
function isKnownUsageEvent(event) {
  if (!usagePayload(event)) return false;
  if (isCumulativeUsage(event)) return true;
  return event.type === 'status' && event.phase === 'step_end';
}

/**
 * Khoá định danh MỘT lần phát usage, để phát hiện bản ghi LẶP.
 *
 * Cùng một generation có thể bị phát `step_end` hai lần (retry, mất đồng bộ);
 * cộng cả hai sẽ nhân đôi token. Khi event tự khai danh tính (`generation`/`id`/
 * `callId`) ta dedupe theo nó; nếu không, hai event giống hệt nhau (cùng JSON)
 * được coi là một — vì một số tăng chân thực không bao giờ trùng khít cả payload
 * lẫn nội dung usage một cách ngẫu nhiên.
 */
function usageIdentity(event) {
  for (const key of ['generation', 'id', 'callId', 'call_id', 'index']) {
    const value = event?.[key];
    if (typeof value === 'string' || Number.isSafeInteger(value)) return `${key}:${value}`;
  }
  return `raw:${canonicalJson(event)}`;
}

/**
 * Tổng token từ event của dsh — THUẦN, không I/O.
 *
 * Hợp đồng (đây là chỗ dễ sinh số SAI nhất):
 *   - CHỈ cộng các event usage đã biết và là số TĂNG (`step_end`);
 *   - event LUỸ KẾ (tổng phiên) không bao giờ được CỘNG vào số tăng — cộng cả hai
 *     là đếm trùng. Hai nguồn được tính RIÊNG, rồi mỗi khoá chọn MỘT nguồn;
 *   - mỗi khoá ưu tiên nguồn TĂNG khi có (đó là tổng các generation đã đo trực
 *     tiếp); chỉ khi khoá không có bằng chứng tăng nào mới dùng luỹ kế;
 *   - bản ghi LẶP của cùng một lần phát bị đếm MỘT lần;
 *   - hình dạng lạ bị bỏ qua hoàn toàn;
 *   - KHÔNG có bằng chứng usage ⇒ trả `null` (chưa đo), KHÔNG trả 0.
 *
 * Vì sao tách hai accumulator thay vì cộng chung: nếu trộn vào một biến, kết quả
 * PHỤ THUỘC THỨ TỰ event (luỹ kế đến trước rồi tăng cộng lên sẽ thổi phồng). Tách
 * riêng khiến kết quả độc lập thứ tự và không bao giờ cộng hai nguồn chồng lấn.
 *
 * Trả `{ input_tokens, output_tokens, reasoning_tokens, cache_read_tokens }`,
 * mỗi khoá là số hoặc `null` khi không nguồn nào mang khoá đó.
 */
export function sumUsage(events) {
  const list = Array.isArray(events) ? events : [];
  const known = list.filter(isKnownUsageEvent);
  if (known.length === 0) return null;
  const keys = Object.values(USAGE_TOKEN_KEYS);
  const incremental = Object.fromEntries(keys.map((key) => [key, null]));
  const cumulative = Object.fromEntries(keys.map((key) => [key, null]));
  const add = (target, key, value) => {
    if (!Number.isFinite(value)) return;
    target[key] = (target[key] ?? 0) + value;
  };
  const max = (target, key, value) => {
    if (!Number.isFinite(value)) return;
    target[key] = target[key] === null ? value : Math.max(target[key], value);
  };
  const seen = new Set();
  for (const event of known) {
    const usage = usagePayload(event);
    if (isCumulativeUsage(event)) {
      // Luỹ kế là TỔNG phiên: lấy giá trị lớn nhất (bản ghi lặp nhỏ hơn bị bỏ qua).
      for (const [raw, key] of Object.entries(USAGE_TOKEN_KEYS)) max(cumulative, key, usage[raw]);
      continue;
    }
    const identity = usageIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    for (const [raw, key] of Object.entries(USAGE_TOKEN_KEYS)) add(incremental, key, usage[raw]);
  }
  // Mỗi khoá chọn MỘT nguồn: tăng trước, luỹ kế chỉ khi khoá đó không có bằng
  // chứng tăng. Không bao giờ cộng hai nguồn — đó là điều duy nhất chắc chắn sai.
  const totals = {};
  for (const key of keys) totals[key] = incremental[key] ?? cumulative[key];
  return totals;
}

/**
 * Commit chính xác của một repo git; `null` khi KHÔNG xác định được.
 *
 * Không bao giờ trả một giá trị thay thế (như version package): bằng chứng `real`
 * phải truy được về đúng một revision mã nguồn. `null` ở đây là tín hiệu ĐỂ TỪ
 * CHỐI ghi row, không phải để đoán.
 */
export function gitCommit(dir, run = spawnSync) {
  const result = run('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  const text = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  return result?.status === 0 && text ? text.split('\n')[0].trim() : null;
}

/**
 * Cây làm việc git có bẩn không. Ba trạng thái: `true`/`false` khi kiểm được,
 * `null` khi KHÔNG kiểm được. "Chưa kiểm" khác "sạch" — gộp chúng sẽ biến một
 * môi trường không xác định thành bằng chứng tái lập được.
 */
export function gitDirty(dir, run = spawnSync) {
  const result = run('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 30_000 });
  if (result?.status !== 0) return null;
  return String(result.stdout ?? '').trim().length > 0;
}

/**
 * Thư mục cài DSH (nếu tìm thấy) — để suy `dsh_git_commit` khi DSH là git checkout.
 *
 * Dò qua PATH rồi `realpath` binary, đi ngược lên tìm `package.json` tên `dsh`.
 * Không tìm thấy ⇒ `null`: DSH cài từ npm (không phải checkout) nên KHÔNG có
 * commit, và `null` là câu trả lời trung thực.
 */
export function dshInstallRoot(env = process.env) {
  const path = env.PATH ?? '';
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    const candidate = join(dir, 'dsh');
    if (!existsSync(candidate)) continue;
    let current;
    try { current = realpathSync(candidate); } catch { continue; }
    for (let depth = 0; depth < 8; depth += 1) {
      current = dirname(current);
      const manifest = join(current, 'package.json');
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
          if (typeof parsed.name === 'string' && /(^|\/)dsh$/.test(parsed.name)) return current;
        } catch { /* package.json hỏng ⇒ coi như không phải root */ }
      }
      if (current === dirname(current)) break;
    }
  }
  return null;
}

/**
 * Nhãn NGUỒN endpoint của model — KHÔNG chứa secret.
 *
 * Vì sao chỉ host+path: hai provider khác nhau có thể trùng tên model, nên nguồn
 * phải vào identity để không ghép nhầm hai môi trường. Nhưng query string thường
 * mang API key (`?key=...`), và userinfo cũng vậy — nên chúng bị CẮT BỎ, không
 * bao giờ ghi vào row.
 */
export function modelEndpointOrigin(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return null;
  let url;
  try { url = new URL(baseURL); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const path = url.pathname.replace(/\/+$/, '');
  return path && path !== '/' ? `${host}${path}` : host;
}

/**
 * Hash hợp đồng evaluator của một task — định danh phiên bản phép CHẤM.
 *
 * Vì sao KHÔNG hash `evaluator.toString()`: source code hàm đổi theo cả thay đổi
 * vô nghĩa (format, tên biến) và KHÔNG phản ánh ngữ nghĩa chấm. Thay vào đó hash
 * đúng những gì quyết định kết quả: id task, version evaluator (nếu catalog
 * khai), hash prompt và hash fixture. Hai lần chạy khác nhau ở bất kỳ thành phần
 * nào trong đó ⇒ khác `evaluator_hash` ⇒ không bị ghép nhầm làm một treatment.
 */
export function evaluatorHashFor(task) {
  return sha256(canonicalJson({
    task_id: task?.id ?? null,
    evaluator_version: task?.evaluator_version ?? null,
    prompt_hash: typeof task?.prompt === 'string' ? sha256(task.prompt) : null,
    fixture_hash: fixtureHash(task),
  }));
}

/**
 * Hash danh mục task đã chạy — dùng cho `held_out_declaration`.
 *
 * Gồm id + prompt hash + evaluator version của TỪNG task: đủ để chứng minh tập
 * held-out đã chạy là đúng tập đã khai, mà không lộ nội dung prompt ra ngoài.
 */
export function taskCatalogHash(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return sha256(canonicalJson(list.map((task) => ({
    id: task?.id ?? null,
    prompt_hash: typeof task?.prompt === 'string' ? sha256(task.prompt) : null,
    evaluator_version: task?.evaluator_version ?? null,
  }))));
}

/**
 * Thứ tự arm cho một seed — round-robin TẤT ĐỊNH.
 *
 * Vì sao xoay: nếu arm đầu luôn chạy trước, mọi khác biệt hệ thống (cache ấm,
 * tài nguyên cạn dần, provider chậm đi) sẽ dồn vào một arm và giả làm "hiệu ứng
 * treatment". Xoay theo seed khiến mỗi arm xuất hiện ở mỗi vị trí thứ tự như
 * nhau (chênh lệch ≤ 1 trên N seed) — một tính chất KIỂM ĐƯỢC, không phải niềm
 * tin. Thứ tự KHÔNG phải sampling seed của provider (xem `SEED_NOTE`).
 */
export function rotationOrder(arms, seed) {
  const list = [...(Array.isArray(arms) ? arms : [])];
  if (list.length === 0) return [];
  const rotation = Math.abs(Number(seed) || 0) % list.length;
  return [...list.slice(rotation), ...list.slice(0, rotation)];
}

/**
 * Hash nội dung các artifact của MỘT lần chạy; `null` khi file vắng.
 *
 * Vì sao cần: row khai `success` nhưng nếu file bằng chứng (events/decisions) bị
 * sửa sau đó thì kết luận không còn truy được. Hash nội dung biến "đã ghi file"
 * thành phép kiểm: consumer tính lại hash và so.
 */
export function artifactHashes({ eventsText = null, decisionsText = null, beforeHash = null, afterHash = null } = {}) {
  return {
    events_sha256: typeof eventsText === 'string' ? sha256(eventsText) : null,
    decisions_sha256: typeof decisionsText === 'string' ? sha256(decisionsText) : null,
    workspace_before_sha256: beforeHash ?? null,
    workspace_after_sha256: afterHash ?? null,
  };
}

/**
 * Trục đo của một task. NGUỒN CHUẨN DUY NHẤT là `task.measurement_axes` — catalog
 * sở hữu, collector chỉ đọc. KHÔNG suy từ `task_class` hay tên arm: suy diễn ngầm
 * ở đây sẽ tạo nguồn sự thật thứ hai, lệch khỏi catalog mà không ai biết.
 *
 * Catalog thiếu trường ⇒ NÉM LỖI (fail-closed), không tự bịa trục đo. Một row
 * thiếu trục đo sẽ bị `validateRow` từ chối, nên im lặng điền bừa chỉ che lỗi.
 */
function measurementAxesFor(task) {
  const axes = task?.measurement_axes;
  if (!axes || typeof axes !== 'object') {
    throw new Error(`Task ${task?.id ?? '<unknown>'} is missing measurement_axes; the task catalog is the source of truth`);
  }
  return { quality: axes.quality === true, performance: axes.performance === true, safety: axes.safety === true };
}

/** Capability mà task PHẢI exercise. Catalog sở hữu; thiếu ⇒ NÉM LỖI, không đoán. */
function expectedCapabilitiesFor(task) {
  if (!Array.isArray(task?.expected_capabilities_to_exercise)) {
    throw new Error(`Task ${task?.id ?? '<unknown>'} is missing expected_capabilities_to_exercise; the task catalog is the source of truth`);
  }
  return [...task.expected_capabilities_to_exercise];
}

/**
 * §21 — cặp (task, arm) KHÔNG THỂ đo được vì profile của arm TẮT capability mà
 * task khai cần exercise.
 *
 * Vì sao kiểm ở TẦNG KẾ HOẠCH: nếu task cần `failure_recovery` mà profile `safe`
 * đặt `enableFailureRecovery: false`, thì một lần chạy `safe` KHÔNG BAO GIỜ đo
 * được capability đó — nó chỉ tốn tiền để sinh ra một row mà analyzer phải loại
 * (`invalid-or-incomplete-capability-environment`). Phát hiện TRƯỚC khi spawn
 * biến một lần chạy vô nghĩa tốn kém thành một lỗi tham số tức thì.
 *
 * `vanilla` LUÔN được miễn: nó là baseline KHÔNG plugin, không cần exercise gì.
 * Trả về mảng `{task_id, arm, capability, configKey}` để thông báo nêu ĐÚNG lý do.
 */
export function incompatibleArmPairs(tasks, arms) {
  const list = Array.isArray(tasks) ? tasks : [];
  const selected = Array.isArray(arms) ? arms : [];
  const specByName = new Map(CAPABILITY_SPECS.map((spec) => [spec.name, spec]));
  const out = [];
  for (const task of list) {
    const expected = Array.isArray(task?.expected_capabilities_to_exercise)
      ? task.expected_capabilities_to_exercise : [];
    for (const arm of selected) {
      if (arm === 'vanilla') continue; // baseline không cần capability nào
      const preset = PROFILES[arm];
      if (!preset) continue;
      for (const capability of expected) {
        const spec = specByName.get(capability);
        if (!spec) continue; // tên lạ đã bị assertTaskContract chặn ở catalog
        if (spec.configKey === null) continue; // `jev` luôn "configured" cho non-vanilla
        if (preset[spec.configKey] === true) continue;
        out.push({ task_id: task?.id ?? null, arm, capability, configKey: spec.configKey });
      }
    }
  }
  return out;
}

/** Nguồn credential cho từng mode. Outage mode CHỦ Ý bỏ trống TYPESAFE. */
export function credentialRequirements(mode = 'normal') {
  return mode === 'jev-outage' ? ['TRAJECTORY_MODEL_KEY'] : ['TRAJECTORY_MODEL_KEY', 'TYPESAFE_API_KEY'];
}

/**
 * Kiểm tra credential TRƯỚC khi chạy bất kỳ arm nào. Ném lỗi nêu rõ credential
 * nào thiếu; KHÔNG âm thầm hạ cấp sang fallback.
 */
export function assertCredentials(mode = 'normal', env = process.env) {
  const missing = credentialRequirements(mode).filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required for `
      + `${mode === 'jev-outage' ? 'Jev-outage' : 'four-arm'} trajectory collection`);
  }
}

/**
 * Đọc version DSH thật từ CLI; `null` nếu không chạy được (không đoán).
 *
 * `run` tiêm được để test offline chạy được trên máy KHÔNG cài `dsh` toàn cục.
 */
export function dshVersion(env = process.env, run = spawnSync) {
  const result = run('dsh', ['--version'], { encoding: 'utf8', timeout: 30_000, env });
  const text = result?.stdout?.trim();
  return text && result.status === 0 ? text.split('\n')[0].trim() : null;
}

/**
 * Preflight THẬT cho hạ tầng ngoài: executable `jg` và review tool trong composition.
 *
 * `review_tool` có BA trạng thái: `true`/`false` khi kiểm được composition,
 * `null` khi KHÔNG kiểm được (không có `dsh`). "Chưa kiểm" khác "không có" —
 * gộp chúng lại sẽ biến thiếu bằng chứng thành bằng chứng tiêu cực.
 */
export function preflightCapabilities({ env = process.env, reviewServerName = 'jev-review', dump = spawnSync } = {}) {
  let reviewTool = null;
  const out = dump('dsh', ['--profile', 'headless', '--dump-config'],
    { encoding: 'utf8', timeout: 60_000, env });
  if (out?.status === 0) reviewTool = String(out.stdout).includes(reviewServerName);
  return {
    executables: { jg: executableAvailable('jg', env) },
    review_tool: reviewTool,
    credentials: { model: Boolean(env.TRAJECTORY_MODEL_KEY), typesafe: Boolean(env.TYPESAFE_API_KEY) },
  };
}

/**
 * Gộp bằng chứng "lớp ĐÃ CHẠY" (`exercised`) vào capability manifest (§4).
 *
 * Vì sao cần một bước riêng: `deriveCapabilities` suy `available`/`invoked` từ
 * decisions, nhưng "available" KHÔNG phải "exercised". Evaluator của task là nơi
 * DUY NHẤT biết một lớp có thật sự tác động lên kết quả (ví dụ recovery gặp lỗi
 * OS thật, hay kênh consent phục vụ được một câu hỏi). Evaluator trả
 * `exercised_capabilities: { <name>: true }`; ở đây ta chỉ ĐỌC và gán, không tự
 * suy. Capability không được evaluator nhắc tới giữ `exercised: null` (chưa xác
 * định) — KHÔNG mặc định `false`, vì "chưa chứng minh" khác "chứng minh không".
 *
 * Tương thích ngược: `feature_exercised` (legacy, per-row) chỉ diễn giải được cho
 * task MỘT capability. Nếu evaluator không trả map mà trả cờ cũ, ta ánh xạ nó
 * lên capability duy nhất task khai cần — nhưng chỉ khi đúng một capability, để
 * không gán bằng chứng của lớp này cho lớp khác.
 */
function withExercisedEvidence(capabilities, evaluation, task) {
  const merged = {};
  for (const [name, entry] of Object.entries(capabilities)) {
    merged[name] = { ...entry, exercised: entry.exercised ?? null };
  }
  const declared = evaluation?.exercised_capabilities;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    for (const [name, value] of Object.entries(declared)) {
      if (!merged[name]) continue;
      merged[name].exercised = value === true ? true : value === false ? false : null;
    }
  } else if (typeof evaluation?.feature_exercised === 'boolean') {
    const expected = Array.isArray(task?.expected_capabilities_to_exercise)
      ? task.expected_capabilities_to_exercise : [];
    if (expected.length === 1 && merged[expected[0]]) {
      merged[expected[0]].exercised = evaluation.feature_exercised;
    }
  }
  return merged;
}

/**
 * Rút gọn MỘT lần chạy thành row. THUẦN: mọi thứ vào qua tham số, không I/O.
 *
 * `events` là JSONL stdout của `dsh --json`; `decisions` là decisions.jsonl của
 * plugin. `evaluation` là kết quả evaluator tất định của task.
 */
export function summarize(events, decisions, options) {
  const {
    task, arm, seed, model, elapsed, exitCode, unchanged, mode = 'normal', split = 'validation',
    dsh_version: dshVersionValue = null, plugin_version: pluginVersion = PACKAGE_VERSION,
    preflight = {}, evaluation = {}, run_id: runId = null, collector_version: collectorVersion = COLLECTOR_VERSION,
    created_at: createdAt = null, timeoutMs = null, snapshot = null,
    plugin_git_commit: pluginCommit = null, plugin_dirty_state: pluginDirty = null,
    dsh_git_commit: dshCommit = null, model_endpoint_origin: endpointOrigin = null,
    cache_mode: cacheMode = 'cold', held_out_declaration: heldOutDeclaration = null,
    artifacts: artifactEvidence = null, provider = null, temperature = null,
  } = options;
  const calls = events.filter((e) => e.type === 'tool_call');
  const ends = events.filter((e) => e.type === 'status' && e.phase === 'step_end');
  // Token: dùng hàm THUẦN `sumUsage` — nó biết phân biệt số TĂNG với TỔNG luỹ kế
  // và bỏ qua hình dạng lạ. `null` khi không có bằng chứng usage nào (đúng ca dsh
  // headless 0.2.0-rc.2 không phát `step_end`), KHÔNG bao giờ là 0.
  const usage = sumUsage(events);
  const tokens = (key) => usage?.[key] ?? null;
  const observed = arm === 'vanilla' || decisions.some((d) => d.type === 'boot');
  const bootConfig = decisions.find((d) => d.type === 'boot')?.config ?? null;
  const elapsedFor = (type) => {
    const rows = decisions.filter((d) => d.type === type);
    return observed && rows.length && rows.every((d) => Number.isFinite(d.ms))
      ? rows.reduce((n, d) => n + d.ms, 0) : null;
  };
  const unique = new Set(calls.map((e) => JSON.stringify([e.tool, e.input])));
  const operations = aggregateOperations(decisions);
  // §16: telemetry operation phải NHẤT QUÁN. Một chuỗi sự kiện bất khả (vừa xong
  // vừa lỗi, số lần gọi giảm, thiếu dấu kết thúc) nghĩa là dataset hỏng — nếu
  // không bắt, `aggregateOperations` vẫn cho ra metric "sạch" và kết luận dựa
  // trên đó là kết luận trên dữ liệu không đáng tin.
  const telemetry = validateOperationTelemetry(decisions);
  const jevOk = observed ? decisions.filter((d) => d.type === 'jev_ok').length : null;
  const jevErrors = observed ? decisions.filter((d) => d.type === 'jev_error') : [];
  const config = observed && bootConfig ? bootConfig : null;
  const profileConfig = config ? benchmarkRelevant(config) : null;
  // Side effect THẬT, không suy từ metadata: `task.writes === false` chỉ nói task
  // ĐƯỢC THIẾT KẾ là read-only; chỉ snapshot cây mới chứng minh nó đã giữ nguyên.
  const workspaceChanged = snapshot ? snapshot.changed === true : null;
  const unexpectedSideEffect = task.writes === false && workspaceChanged === true;
  // Vi phạm path confinement (symlink thoát root) là side effect ngoài fixture:
  // cây có thể "không đổi" bên trong nhưng vẫn trỏ ra ngoài. Fail-closed.
  const confinementProblemsList = Array.isArray(snapshot?.confinement_problems)
    ? snapshot.confinement_problems : [];
  // Telemetry bất khả ⇒ row KHÔNG được coi là thành công: `success` ở đây là kết
  // luận "phép đo hợp lệ", và một phép đo trên telemetry hỏng thì không hợp lệ.
  const telemetryOk = telemetry.ok;
  const success = Boolean(evaluation.success) && !(options.parseErrors > 0) && !options.timedOut
    && !unexpectedSideEffect && telemetryOk && confinementProblemsList.length === 0;
  const taskClass = task.task_class;
  const taskPromptHash = sha256(task.prompt);
  // Bản ghi canonical ĐẦY ĐỦ để consumer TÍNH LẠI hash, thay vì tin một hash suông.
  const benchmarkFields = {
    task_id: task.id, task_class: taskClass, task_prompt_hash: taskPromptHash, model,
    dsh_version: dshVersionValue, plugin_version: pluginVersion,
    evaluator: task.id, permission_mode: task.permission_mode, timeout_ms: timeoutMs,
  };
  return {
    schema: ROW_SCHEMA,
    // ---- identity ghép cặp (thiếu bất kỳ trường nào ⇒ row bị matrix từ chối) ----
    task_id: task.id,
    task_class: taskClass,
    task_prompt_hash: taskPromptHash,
    seed,
    repo_state: fixtureHash(task),
    model,
    dsh_version: dshVersionValue,
    plugin_version: pluginVersion,
    benchmark_config: benchmarkConfigFor(benchmarkFields),
    benchmark_config_hash: benchmarkConfigHash(benchmarkFields),
    // ---- định danh MỞ RỘNG: revision mã nguồn + hợp đồng evaluator + nguồn endpoint ----
    // Thiếu hai khoá đầu ⇒ `validateRow` từ chối row `real` (không tái lập được).
    plugin_git_commit: pluginCommit,
    evaluator_hash: evaluatorHashFor(task),
    plugin_dirty_state: pluginDirty,
    dsh_git_commit: dshCommit,
    model_endpoint_origin: endpointOrigin,
    // ---- truy vết lần thu thập (run_id + thời điểm + version collector) ----
    run_id: runId,
    created_at: createdAt,
    collector_version: collectorVersion,
    // ---- treatment ----
    arm,
    mode,
    profile: config?.profile ?? null,
    profile_config: profileConfig,
    profile_config_hash: profileConfigHash(config),
    // ---- capability manifest THẬT ----
    capabilities: withExercisedEvidence(
      deriveCapabilities({ arm, config, decisions, preflight, operations }), evaluation, task),
    // ---- operation telemetry (từ cost_governor, không suy từ jev_ok) ----
    operations,
    // Danh sách vấn đề telemetry (rỗng = nhất quán). Giữ NGUYÊN chuỗi machine-readable
    // của schema để consumer đối chiếu được, không diễn giải lại.
    operation_telemetry_problems: telemetry.problems,
    // ---- kết quả tất định ----
    source: 'real',
    // Split là KHAI BÁO của người vận hành (task/seed chưa từng dùng để phát triển
    // plugin), không phải suy diễn ngầm: collector mặc định `validation` và chỉ ghi
    // held-out khi được yêu cầu tường minh. Outage mode KHÔNG BAO GIỜ là held-out.
    split: mode === 'jev-outage' ? 'outage' : split,
    permission_mode: task.permission_mode,
    safety_labels: [...task.safety_labels],
    expected_side_effects: [...task.expected_side_effects],
    // ---- trục đo + capability kỳ vọng (copy từ catalog, không suy từ arm) ----
    measurement_axes: measurementAxesFor(task),
    expected_capabilities_to_exercise: expectedCapabilitiesFor(task),
    // ---- snapshot workspace THẬT (before/after), không phải metadata ----
    workspace_before_hash: snapshot?.before_hash ?? null,
    workspace_after_hash: snapshot?.after_hash ?? null,
    workspace_changed: workspaceChanged,
    unexpected_side_effect: unexpectedSideEffect,
    // Symlink trong workspace trỏ RA NGOÀI root (rỗng = đạt confinement). Đây là
    // vi phạm độc lập với "cây có đổi hay không": một link thoát gốc chưa đọc vẫn
    // là side effect ngoài phạm vi, nên phải hiện thành dữ liệu để kiểm được.
    workspace_confinement_problems: confinementProblemsList,
    // Chi tiết thay đổi (fail-closed §18): liệt kê CHÍNH XÁC cái gì đổi để người
    // đọc không phải tin một boolean trần.
    workspace_diff: snapshot?.diff ?? null,
    cache_mode: cacheMode,
    // Khai báo held-out của người vận hành (chỉ có khi split held-out).
    held_out_declaration: heldOutDeclaration,
    // Hash nội dung bằng chứng (events/decisions/workspace) — null khi vắng.
    artifacts: artifactEvidence,
    success,
    task_success: success,
    tests_passed: Number.isFinite(evaluation.tests_passed) ? evaluation.tests_passed : 0,
    tests_total: Number.isFinite(evaluation.tests_total) ? evaluation.tests_total : 1,
    false_allow: evaluation.false_allow ?? null,
    false_deny: evaluation.false_deny ?? null,
    // `null` khi task không đo được feature (khác hẳn `false` = đo và không thấy).
    feature_exercised: evaluation.feature_exercised ?? null,
    evaluation_detail: evaluation.detail ?? null,
    // ---- đo lường ----
    task_quality: null,
    walltime_ms: elapsed,
    wall_time_ms: elapsed,
    llm_calls: ends.length,
    generations: ends.length,
    main_llm_generations: ends.length,
    input_tokens: tokens('input_tokens'),
    output_tokens: tokens('output_tokens'),
    main_llm_input_tokens: tokens('input_tokens'),
    main_llm_output_tokens: tokens('output_tokens'),
    reasoning_tokens: tokens('reasoning_tokens'),
    cache_read_tokens: tokens('cache_read_tokens'),
    // Metadata provider: nhiệt độ + model + nguồn endpoint. KHÔNG chứa secret.
    provider: provider ?? { model, model_endpoint_origin: endpointOrigin, temperature,
      seed: seed ?? null, seed_note: SEED_NOTE },
    tool_calls: calls.length,
    failed_tool_calls: events.filter((e) => e.type === 'tool_result' && e.status === 'error').length,
    repeated_tool_calls: calls.length - unique.size,
    search_calls: calls.filter((e) => ['grep', 'glob'].includes(e.tool)).length,
    searches_before_target_read: evaluation.searches_before_target_read ?? null,
    unnecessary_file_reads: evaluation.unnecessary_file_reads ?? null,
    target_in_top_n: null,
    // ---- Jev: tách logical / success / fail / http attempt (KHÔNG suy từ jev_ok) ----
    jev_calls: jevOk,
    jev_logical_operations: observed ? operations.jev.operations : null,
    jev_successful_operations: observed ? operations.jev.successful_operations : null,
    jev_failed_operations: observed ? operations.jev.failed_operations : null,
    jev_skipped_operations: observed ? operations.jev.skipped_operations : null,
    jev_http_attempts: observed ? operations.jev.actual_invocations : null,
    jev_direct_calls: jevOk,
    jev_error_count: observed ? jevErrors.length : null,
    jev_latency_ms: elapsedFor('jev_ok'),
    // ---- review / jevgrep ----
    review_count: observed ? decisions.filter((d) => d.type === 'quality_review' && d.decision === 'reviewed').length : null,
    // THỜI GIAN (ms), không phải SỐ LẦN. `actual_invocations` là count; dùng nó ở
    // đây từng khiến một review 300 ms được ghi thành 1 ms.
    review_time_ms: observed ? operations.review.elapsed_ms : null,
    review_invocations: observed ? operations.review.actual_invocations : null,
    review_tool_invocations: observed ? operations.review.actual_invocations : null,
    review_reserved_units: observed ? operations.review.reserved_units : null,
    review_logical_operations: observed ? operations.review.operations : null,
    review_successful_operations: observed ? operations.review.successful_operations : null,
    review_failed_operations: observed ? operations.review.failed_operations : null,
    review_skipped_operations: observed ? operations.review.skipped_operations : null,
    jevgrep_count: observed ? decisions.filter((d) => d.type === 'jevgrep_escalation' && d.decision === 'started_background').length : null,
    jevgrep_process_spawns: observed ? operations.jevgrep.actual_invocations : null,
    jevgrep_reserved_units: observed ? operations.jevgrep.reserved_units : null,
    jevgrep_logical_operations: observed ? operations.jevgrep.operations : null,
    jevgrep_successful_operations: observed ? operations.jevgrep.successful_operations : null,
    jevgrep_failed_operations: observed ? operations.jevgrep.failed_operations : null,
    jevgrep_skipped_operations: observed ? operations.jevgrep.skipped_operations : null,
    jevgrep_time_ms: observed ? operations.jevgrep.elapsed_ms : null,
    jev_operation_time_ms: observed ? operations.jev.elapsed_ms : null,
    decision_reserved_units: observed ? operations.reserved_units : null,
    decision_actual_invocations: observed ? operations.actual_invocations : null,
    decision_operation_failures: observed ? operations.failures : null,
    decision_operation_cancellations: observed ? operations.cancellations : null,
    context_injected_tokens: null,
    human_consent_prompts: null,
    retries: null,
    cost_usd: null,
    effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    resolved_effort: decisions.filter((d) => d.type === 'effort_route').at(-1)?.effort ?? null,
    effortAbstain: config?.effortAbstain === true,
    layer5: config?.enableSpawnHint === true && config?.enableContextTriage === true,
    target_read_observed: evaluation.target_read_observed ?? null,
    measurement_notes: [
      // Ghi chú phải khớp split THẬT: một row held-out mang ghi chú "validation pilot"
      // là tự mâu thuẫn với provenance của chính nó.
      mode === 'jev-outage' ? 'Jev-outage mode, not promotion evidence.'
        : split === 'held-out' ? 'Held-out split declared by the operator.'
          : split === 'train' ? 'Train split, not promotion evidence.'
            : 'Validation pilot, not held-out promotion evidence.',
      SEED_NOTE,
      'Wall time includes CLI startup and shutdown.',
      'Missing provider/plugin metrics remain null, never 0.',
      // Token chỉ có khi provider THẬT SỰ phát usage. dsh headless 0.2.0-rc.2 không
      // phát `step_end`, nên token là null — đó là "chưa đo", không phải "0".
      'Token metrics are null unless the provider emitted usage events; '
        + 'cumulative usage is taken once, never added to incremental totals.',
      'Capability state comes from runtime decisions and preflight, never from the arm name.',
      'Capability `exercised` comes from the task evaluator, not from `available`.',
      'jev_calls is legacy: it counts jev_ok records (successful logical operations), NOT HTTP attempts.',
      'Actual invocation counts come from cost_governor operation telemetry (jev_http_attempts, '
        + 'review_tool_invocations, jevgrep_process_spawns), because one logical call can retry.',
      'Each (task, seed, arm) runs in its own workspace, decision log and temp directory; '
        + 'cache_mode cold means no cross-arm reuse of verdict cache, session budget, breaker or review state.',
    ],
  };
}

/** Dựng patch DSH cho một arm (thuần, tách khỏi vòng chạy để kiểm được). */
export function buildPatch({ arm, model, baseURL, logDir, task }) {
  return [
    { id: 'bili-native', disabled: true }, { id: 'otel', disabled: true },
    { id: 'session-telemetry-otel', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { 'trajectory-router': {
      displayName: 'Explicit trajectory route', apiKeyEnv: 'TRAJECTORY_MODEL_KEY', api: 'openai-completions', baseURL,
      models: [{ id: model, name: model, contextWindow: 1000000,
        reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'trajectory-router', model, reasoningEffort: 'off' } },
    ...(arm === 'vanilla' ? [] : [{ insert: [{ id: 'jev-gate', name: join(plugin, 'lib/index.mjs'),
      config: { profile: arm, logDir, reviewMode: 'telemetry', jevGrepTimeoutMs: 30_000 } }] }]),
  ];
}

/**
 * Chạy một arm trên một task; trả row đã hoàn chỉnh (chưa ghi file).
 *
 * CÔ LẬP (§14): mỗi (task, seed, arm) có thư mục artifact RIÊNG chứa workspace,
 * decisions và patch của chính nó. Vì sao tên thư mục phải gồm CẢ seed: nếu chỉ
 * `task--arm`, hai seed của cùng một cặp sẽ dùng CHUNG workspace — arm ở seed sau
 * nhìn thấy file seed trước để lại, và mọi kết luận "tái lập trên N seed" trở
 * thành sai. Tên duy nhất theo seed là điều kiện CẦN để không có state rò rỉ.
 */
async function runArm({ task, arm, root, model, baseURL, seed, timeoutMs, mode, split, preflight, dshVersionValue,
  runId, createdAt, identity = {}, temperature = null }) {
  const artifacts = join(root, `${task.id}--seed${seed}--${arm}`);
  const workspace = join(artifacts, 'workspace');
  // Fail-closed: thư mục đã tồn tại nghĩa là có tái sử dụng state. Đây là bất biến
  // của phép đo, nên NÉM LỖI thay vì ghi đè âm thầm.
  if (existsSync(artifacts)) {
    throw new Error(`Artifact directory already exists (state would leak across runs): ${artifacts}`);
  }
  await mkdir(workspace, { recursive: true });
  task.setup(workspace);
  const logDir = join(artifacts, 'decisions');
  const patchFile = join(artifacts, 'patch.json');
  await writeFile(patchFile, JSON.stringify(buildPatch({ arm, model, baseURL, logDir, task })));
  // Snapshot TRƯỚC khi agent chạm vào cây: fixture đã materialize xong nên hash
  // này là trạng thái xuất phát thật, kể cả symlink hỏng.
  const before = snapshotWorkspaceDetail(workspace);
  const events = []; let stderr = ''; let parseErrors = 0;
  const started = performance.now();
  const result = await new Promise((done, reject) => {
    const child = spawn('dsh', ['--profile', 'headless', '--patch', patchFile, '--json', task.prompt], {
      cwd: workspace,
      env: { ...process.env, DSH_TELEMETRY_MODE: 'OFF', DSH_PERMISSION_MODE: task.permission_mode },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let pending = ''; let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      pending += chunk; const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) { try { events.push(JSON.parse(line)); } catch { parseErrors += 1; } }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { parseErrors += 1; } }
      done({ code, timedOut });
    });
  });
  let decisions = []; let decisionsText = null;
  try {
    decisionsText = await readFile(join(logDir, 'decisions.jsonl'), 'utf8');
    decisions = decisionsText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const after = snapshotWorkspaceDetail(workspace);
  const changed = before.hash !== after.hash;
  // Diff CHI TIẾT để kiểm fail-closed §18: không chỉ "cây đổi" mà đổi cái gì.
  const diff = diffWorkspaces(before, after);
  // PATH CONFINEMENT: một symlink trỏ RA NGOÀI workspace root là side effect ngoài
  // phạm vi fixture, kể cả khi chưa ai đọc nó. Kiểm cả trước lẫn sau vì fixture
  // có thể chứa symlink nội bộ hợp lệ; chỉ link THOÁT gốc mới là vi phạm.
  const confinement = [...confinementProblems(workspace, before),
    ...confinementProblems(workspace, after)];
  const snapshot = { before_hash: before.hash, after_hash: after.hash, changed, diff,
    confinement_problems: confinement };
  // `unchanged` giờ là SỰ THẬT ĐO ĐƯỢC, không phải `!task.writes`.
  const unchanged = !changed;
  const evaluation = await task.evaluate({ workspace, events, decisions,
    exitCode: result.code, unchanged, snapshot, timedOut: result.timedOut });
  const eventsText = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const row = summarize(events, decisions, { task, arm, seed, model: `trajectory-router/${model}`,
    elapsed: Math.round(performance.now() - started), exitCode: result.code, unchanged, mode, split,
    dsh_version: dshVersionValue, preflight, evaluation, parseErrors, timedOut: result.timedOut,
    timeoutMs, snapshot, run_id: runId, created_at: createdAt,
    plugin_git_commit: identity.plugin_git_commit ?? null,
    plugin_dirty_state: identity.plugin_dirty_state ?? null,
    dsh_git_commit: identity.dsh_git_commit ?? null,
    model_endpoint_origin: identity.model_endpoint_origin ?? null,
    cache_mode: identity.cache_mode ?? 'cold',
    held_out_declaration: identity.held_out_declaration ?? null,
    temperature,
    artifacts: artifactHashes({ eventsText, decisionsText,
      beforeHash: before.hash, afterHash: after.hash }) });
  row.exit_code = result.code; row.timed_out = result.timedOut; row.parse_errors = parseErrors;
  row.artifact_directory = artifacts;
  await writeFile(join(artifacts, 'events.jsonl'), eventsText);
  if (decisionsText !== null) await writeFile(join(artifacts, 'decisions.jsonl'), decisionsText);
  // Lưu log chẩn đoán cục bộ, KHÔNG bao giờ lưu biến môi trường hay credential.
  for (const secret of [process.env.TRAJECTORY_MODEL_KEY, process.env.TYPESAFE_API_KEY].filter(Boolean)) {
    stderr = stderr.split(secret).join('[redacted]');
  }
  await writeFile(join(artifacts, 'stderr.log'), stderr, { mode: 0o600 });
  return row;
}

/**
 * Kiểm file output — KHÔNG bao giờ append ngầm vào lần chạy cũ.
 *
 * Trả đường dẫn tuyệt đối. Mặc định: file đã tồn tại ⇒ NÉM lỗi. `overwrite: true`
 * ⇒ chỉ trả đường dẫn, việc truncate do caller làm SAU khi đã xác nhận môi trường
 * chạy được (xem `truncateOutput`) — nếu không, một lần chạy hỏng vì thiếu `dsh`
 * sẽ xoá mất dữ liệu cũ của người dùng mà không thu được gì.
 *
 * Tách khỏi `collect` để kiểm được offline, không cần `dsh` cài sẵn.
 */
export async function prepareOutput(output, { overwrite = false } = {}) {
  const outputPath = resolve(output);
  if (overwrite) return outputPath;
  let exists = true;
  try { await stat(outputPath); }
  catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) {
    throw new Error(`Output file already exists: ${outputPath}; pass --overwrite to replace it`);
  }
  return outputPath;
}

/** Xoá nội dung file output để lần chạy mới THAY THẾ, không nối thêm row cũ. */
export async function truncateOutput(outputPath) {
  await writeFile(outputPath, '');
}

/**
 * Thu thập trajectory. Ném NGAY nếu thiếu credential (trước khi tạo row nào).
 *
 * `output` KHÔNG bao giờ bị append ngầm: row ghi dần nên một lần chạy mới trộn
 * vào file cũ sẽ tạo ra JSONL lai mà manifest chỉ mô tả lần chạy mới nhất. Vì
 * vậy mặc định từ chối file đã tồn tại; muốn thay thế phải nói rõ `overwrite`.
 *
 * ĐỊNH DANH MÔI TRƯỜNG (§2): một row `real` phải truy được về ĐÚNG một revision
 * mã nguồn plugin và một trạng thái cây làm việc. Vì vậy collector LẤY commit
 * thật; không lấy được ⇒ TỪ CHỐI ghi, chứ không điền giá trị thay thế. Cây bẩn
 * (`git status --porcelain` khác rỗng) làm mọi số đo không tái lập được, nên mặc
 * định cũng TỪ CHỐI; chỉ khi người vận hành chủ động nhận trách nhiệm bằng
 * `allowDirtyPlugin` mới ghi tiếp — và khi đó `plugin_dirty_state:true` vẫn khiến
 * `validateRow` đánh dấu row là không tái lập được.
 *
 * @param {object} options
 * @param {string} options.output - đường dẫn JSONL
 * @param {'normal'|'jev-outage'} [options.mode]
 * @param {string} [options.taskId]
 * @param {string[]} [options.arms] - mặc định đủ 4 arm (normal) hoặc 2 arm (outage)
 * @param {boolean} [options.overwrite] - truncate `output` trước khi chạy
 * @param {boolean} [options.allowDirtyPlugin] - override TƯỜNG MINH khi cây plugin bẩn
 * @param {number|null} [options.temperature] - nhiệt độ provider, ghi vào metadata (không áp đặt)
 * @param {Function} [options.gitRun] - seam để test: runner cho git probe (mặc định spawnSync)
 */
export async function collect({ output, model = 'cbai/deepseek-v4.1-flash', baseURL = 'http://127.0.0.1:20128/v1',
  seed = 1, seeds, timeoutMs = 180_000, mode = 'normal', split = 'validation', taskId = DEFAULT_TASK, taskIds, arms,
  overwrite = false, allowDirtyPlugin = false, allowIncompatibleArms = false,
  temperature = null, gitRun = spawnSync } = {}) {
  if (!output) throw new Error('Output JSONL path is required');
  // Split hợp lệ phải được kiểm TRƯỚC credential: một flag sai chính tả là lỗi THAM SỐ,
  // không được báo "thiếu API key" và khiến người dùng đi tìm credential.
  if (!SPLITS.includes(split)) {
    throw new Error(`Split must be one of ${SPLITS.join(', ')}; received ${JSON.stringify(split)}`);
  }
  // Outage mode là một mode RIÊNG: nó không bao giờ là held-out. Nếu người dùng
  // truyền cả `--jev-outage` lẫn `--split held-out` thì `outage` THẮNG, vì một lần
  // chạy đo hành vi khi Jev outage không thể là bằng chứng promotion.
  const effectiveSplit = mode === 'jev-outage' ? 'outage' : split;
  assertCredentials(mode);
  const seedList = seeds === undefined ? [seed] : seeds;
  if (!Array.isArray(seedList) || seedList.length === 0
    || !seedList.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Seed(s) must be non-negative integers');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be a positive number');
  let endpoint;
  try { endpoint = new URL(baseURL); }
  catch { throw new Error(`Model endpoint must be a valid HTTP(S) URL: ${JSON.stringify(baseURL)}`); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Model endpoint must be HTTP(S) without inline credentials');
  }
  // Catalog: chạy được NHIỀU task trong một lần gọi (không chỉ một task cứng).
  const taskIdList = taskIds === undefined ? [taskId] : taskIds;
  if (!Array.isArray(taskIdList) || taskIdList.length === 0) throw new Error('At least one task is required');
  const tasks = taskIdList.map((id) => taskById(id));
  // Kiểm catalog NGAY, trước khi spawn: `summarize` cũng ném lỗi, nhưng ném ở đó
  // nghĩa là đã chạy xong một task thật rồi mới chết. Một catalog hỏng phải dừng
  // trước khi tốn tiền gọi model.
  for (const task of tasks) { measurementAxesFor(task); expectedCapabilitiesFor(task); }
  const selected = arms ?? (mode === 'jev-outage' ? ['vanilla', 'safe'] : [...ARMS]);
  for (const arm of selected) if (!ARMS.includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  // §21 (khuyến nghị A): task cần capability mà profile của arm TẮT ⇒ DỪNG TRƯỚC
  // khi spawn. Mặc định fail-closed vì chạy tiếp chỉ sinh bằng chứng mà analyzer
  // buộc phải loại. Người vận hành muốn chạy đủ ma trận vì mục đích khác phải
  // nói rõ `--allow-incompatible-arms`; khi đó row vẫn bị analyzer xử theo (B).
  const incompatible = incompatibleArmPairs(tasks, selected);
  if (incompatible.length > 0 && !allowIncompatibleArms) {
    const detail = incompatible
      .map((p) => `${p.task_id}/${p.arm} needs ${p.capability} (${p.configKey}=false)`).join('; ');
    throw new Error(`Task-capability contract violated before any model call: ${detail}. `
      + 'Pick compatible arms, or pass --allow-incompatible-arms to record them as invalid evidence.');
  }
  // Kiểm file output SAU khi mọi tham số đã hợp lệ: một lệnh sai chính tả phải báo
  // lỗi tham số, không phải "file đã tồn tại" và che mất lỗi thật. Phép kiểm này
  // KHÔNG ghi gì, nên được phép chạy trước khi dò môi trường — nhờ vậy nó vẫn nêu
  // đúng lỗi trên máy chưa cài `dsh` (và test offline kiểm được nó).
  const outputPath = await prepareOutput(output, { overwrite });
  // Không nhận diện được DSH ⇒ từ chối. Chạy TRƯỚC khi truncate để một lần chạy
  // hỏng ngay lập tức không xoá mất dataset cũ của người dùng.
  const dshVersionValue = dshVersion();
  if (!dshVersionValue) throw new Error('Unable to determine the DSH version; refusing to record an unidentifiable environment');
  // Định danh revision plugin: KHÔNG có commit ⇒ không có row. Đây là chốt chặn
  // quan trọng nhất của bằng chứng — mọi row phải trỏ về một revision cụ thể.
  const pluginCommit = gitCommit(plugin, gitRun);
  if (!pluginCommit) {
    throw new Error(`Unable to read the plugin git commit at ${plugin}; `
      + 'refusing to record a row that cannot be traced to a source revision');
  }
  const pluginDirty = gitDirty(plugin, gitRun);
  if (pluginDirty === null) {
    throw new Error(`Unable to read the plugin working tree state at ${plugin}; `
      + 'refusing to record a row whose environment is unknown');
  }
  // Cây bẩn ⇒ mã nguồn đã chạy KHÔNG bằng commit đã khai, nên số đo không tái lập.
  // Mặc định TỪ CHỐI; override chỉ dành cho người vận hành chủ động chấp nhận, và
  // kể cả khi đó row vẫn mang `plugin_dirty_state:true` để consumer tự loại.
  if (pluginDirty && !allowDirtyPlugin) {
    throw new Error(`Plugin working tree at ${plugin} is dirty; refusing to record unreproducible evidence. `
      + 'Commit or stash changes, or pass --allow-dirty-plugin to record the row with '
      + 'plugin_dirty_state:true (which validateRow will flag as unreproducible-plugin-state).');
  }
  // DSH là git checkout thì mới có commit; cài từ npm thì `null` — trung thực, không đoán.
  const dshRoot = dshInstallRoot();
  const dshCommit = dshRoot ? gitCommit(dshRoot, gitRun) : null;
  const preflight = preflightCapabilities();
  // Chỉ tới đây mới được phép xoá file cũ: môi trường đã xác nhận chạy được.
  if (overwrite) await truncateOutput(outputPath);
  const root = await mkdtemp(join(tmpdir(), 'jev-trajectory-'));
  const records = [];
  const expected = tasks.length * seedList.length * selected.length;
  // Định danh lần chạy: đủ để hai lần thu thập khác nhau không bao giờ trùng id,
  // và đủ để tính LẠI từ chính manifest (không cần lưu secret nào).
  const createdAt = new Date().toISOString();
  // Nhãn endpoint KHÔNG secret: chỉ host+path, cắt bỏ query/userinfo (nơi chứa key).
  const endpointOrigin = modelEndpointOrigin(baseURL);
  // Khai báo held-out: chỉ khi split thật sự là held-out, và phải ghi RÕ cơ sở —
  // danh mục task, revision plugin, thời điểm khai. Không có khai báo này thì một
  // row held-out không chứng minh được điều gì về tính độc lập của nó.
  const heldOutDeclaration = effectiveSplit === 'held-out' ? {
    declared: true, declared_at: createdAt, task_catalog_hash: taskCatalogHash(tasks),
    plugin_commit: pluginCommit, reason: 'operator-declared',
  } : null;
  const identity = { plugin_git_commit: pluginCommit, plugin_dirty_state: pluginDirty,
    dsh_git_commit: dshCommit, model_endpoint_origin: endpointOrigin, cache_mode: 'cold',
    held_out_declaration: heldOutDeclaration };
  const runId = sha256(canonicalJson({
    output: outputPath, created_at: createdAt, tasks: tasks.map((task) => task.id),
    seeds: seedList, arms: [...selected], mode, split: effectiveSplit,
  }));
  const manifest = { status: 'incomplete', expected_rows: expected, written_rows: 0,
    mode, split: effectiveSplit, seeds: seedList, tasks: tasks.map((task) => task.id), arms: [...selected],
    run_id: runId, created_at: createdAt, collector_version: COLLECTOR_VERSION };
  // Manifest `incomplete` được ghi TRƯỚC khi chạy; chỉ chuyển `complete` khi mọi
  // row đã ghi xong. Nếu tiến trình bị giết giữa chừng, manifest vẫn là
  // `incomplete` và consumer biết file JSONL không đầy đủ.
  await mkdir(dirname(outputPath), { recursive: true });
  await writeManifest(output, manifest);
  for (const task of tasks) {
    for (const currentSeed of seedList) {
      // Xoay thứ tự giữa các replication; một pilot đơn lẻ vẫn không thể chứng minh lợi ích.
      const order = rotationOrder(selected, currentSeed);
      for (const arm of order) {
        const row = await runArm({ task, arm, root, model, baseURL, seed: currentSeed, timeoutMs, mode,
          split: effectiveSplit, preflight, dshVersionValue, runId, createdAt, identity, temperature });
        row.run_order = order;
        await appendFile(outputPath, JSON.stringify(row) + '\n');
        records.push(row);
        // Cập nhật `written_rows` NGAY sau mỗi row. Nếu tiến trình bị giết giữa
        // chừng, manifest còn lại phải phản ánh ĐÚNG số row đã ghi; ghi 0 rồi chỉ
        // sửa ở cuối sẽ khiến một lần chạy dở khai "chưa ghi gì" trong khi file đã
        // có row — người đọc không thể biết phần nào là thật.
        await writeManifest(output, { ...manifest, written_rows: records.length });
        console.log(JSON.stringify({ arm, task_id: task.id, seed: currentSeed, success: row.success,
          generations: row.generations, walltime_ms: row.walltime_ms, artifact_directory: row.artifact_directory }));
      }
    }
  }
  await writeManifest(output, { ...manifest, status: 'complete', written_rows: records.length });
  return records;
}

/**
 * Phân tích argv cho CLI collector. THUẦN, không I/O — để kiểm được offline.
 * Trả `{ output, mode, taskIds, seeds, split, overwrite }` hoặc ném `Error` rõ ràng.
 * Flag cần giá trị mà thiếu giá trị là LỖI, không được âm thầm dùng mặc định.
 *
 * `--split` là KHAI BÁO TƯỜNG MINH của người vận hành, không bao giờ suy diễn ngầm:
 * công cụ không thể tự biết một task/seed có phải held-out hay không. Vì vậy KHÔNG
 * truyền `--split` ⇒ `split === undefined` và tầng dưới dùng mặc định `validation`
 * (fail-safe: quên flag không thể vô tình tạo bằng chứng promotion).
 */
export function parseArgs(argv = []) {
  const args = [...argv];
  const takesValue = ['--tasks', '--seeds', '--split', '--temperature', '--arms'];
  const known = new Set(['--jev-outage', '--overwrite', '--allow-dirty-plugin',
    '--allow-incompatible-arms', ...takesValue]);
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (takesValue.includes(arg)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Flag ${arg} requires a value`);
      }
      values[arg] = next;
      i += 1;
    } else if (arg.startsWith('--')) {
      if (!known.has(arg)) throw new Error(`Unknown flag(s): ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error('Exactly one output path is required');
  const splitList = (raw) => (raw === undefined ? undefined
    : String(raw).split(',').map((part) => part.trim()).filter(Boolean));
  const rawSeeds = splitList(values['--seeds']);
  const seeds = rawSeeds?.map((part) => Number(part));
  if (seeds && (seeds.length === 0 || seeds.some((n) => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('Seeds must be non-negative integers');
  }
  // Giá trị split sai là lỗi THAM SỐ nêu rõ giá trị nhận được, không im lặng rơi về
  // mặc định (rơi về mặc định sẽ biến một lần chạy held-out định làm thành validation).
  const split = values['--split'];
  if (split !== undefined && !SPLITS.includes(split)) {
    throw new Error(`Split must be one of ${SPLITS.join(', ')}; received ${JSON.stringify(split)}`);
  }
  // §22: người vận hành ĐƯỢC chọn tập con arm. Manifest ghi tập ĐÃ CHỌN, và analyzer
  // chỉ đánh giá treatment có baseline đi kèm — chạy thiếu arm là lựa chọn hợp lệ,
  // nhưng phải khai tường minh. Tên arm sai là lỗi THAM SỐ (không im lặng bỏ qua).
  const rawArms = splitList(values['--arms']);
  if (rawArms !== undefined) {
    if (rawArms.length === 0) throw new Error('Arms must list at least one arm');
    for (const arm of rawArms) {
      if (!ARMS.includes(arm)) throw new Error(`Unknown arm: ${arm}; expected one of ${ARMS.join(', ')}`);
    }
  }
  // Nhiệt độ: chỉ nhận số hữu hạn. Giá trị sai là lỗi THAM SỐ, không âm thầm bỏ qua —
  // bỏ qua sẽ khiến row khai "không đặt nhiệt độ" trong khi người dùng đã đặt.
  let temperature;
  if (values['--temperature'] !== undefined) {
    temperature = Number(values['--temperature']);
    if (!Number.isFinite(temperature)) {
      throw new Error(`Temperature must be a finite number; received ${JSON.stringify(values['--temperature'])}`);
    }
  }
  return { output: positionals[0], mode: args.includes('--jev-outage') ? 'jev-outage' : 'normal',
    taskIds: splitList(values['--tasks']), seeds, split, temperature, arms: rawArms,
    overwrite: args.includes('--overwrite'), allowDirtyPlugin: args.includes('--allow-dirty-plugin'),
    allowIncompatibleArms: args.includes('--allow-incompatible-arms') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const records = await collect({ output: parsed.output, model: process.env.TRAJECTORY_MODEL,
      baseURL: process.env.TRAJECTORY_BASE_URL, mode: parsed.mode, split: parsed.split,
      taskIds: parsed.taskIds ?? (process.env.TRAJECTORY_TASK ? [process.env.TRAJECTORY_TASK] : undefined),
      seeds: parsed.seeds, temperature: parsed.temperature, arms: parsed.arms,
      overwrite: parsed.overwrite, allowDirtyPlugin: parsed.allowDirtyPlugin,
      allowIncompatibleArms: parsed.allowIncompatibleArms });
    if (records.some((r) => !r.success)) process.exitCode = 1;
  } catch (error) {
    console.error(`Collection failed: ${error.message}`);
    console.error('Usage: node tools/collect-trajectory.mjs OUTPUT.jsonl [--jev-outage] [--overwrite] '
      + '[--allow-dirty-plugin] [--allow-incompatible-arms] [--temperature 0] [--tasks id,id] '
      + `[--seeds 1,2] [--arms ${ARMS.join(',')}] [--split ${SPLITS.join('|')}]`);
    process.exitCode = 1;
  }
}

export { TASKS };
