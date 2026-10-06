/**
 * Hợp đồng phủ config (§3, §5 của kế hoạch).
 *
 * Vì sao cần test NÀY chứ không chỉ đọc code: lỗi gốc là `BENCHMARK_CONFIG_KEYS`
 * chỉ có 22/76 khoá runtime, nên hai cấu hình KHÁC NHAU vẫn ra CÙNG
 * `profile_config_hash` và bị ghép cặp như một treatment — một lỗ fail-open im
 * lặng. Một danh sách viết tay sẽ lệch lại mỗi khi runtime thêm khoá mới. Test
 * này biến "quên phân loại khoá mới" thành CI đỏ.
 *
 * Luật: mọi khoá trong `Config.dict` của runtime PHẢI nằm trong
 * `BENCHMARK_CONFIG_KEYS` (ảnh hưởng hành vi ⇒ phải hash) HOẶC trong
 * `BENCHMARK_CONFIG_EXCLUSIONS` (đã khai lý do). Không khoá nào được rơi vào cả
 * hai, và mọi khoá hash/exclude phải là khoá runtime THẬT (không bịa).
 */
import assert from 'node:assert/strict';
import { Config } from '../lib/index.mjs';
import { BENCHMARK_CONFIG_EXCLUSIONS, BENCHMARK_CONFIG_KEYS } from '../tools/trajectory-schema.mjs';

const runtimeKeys = Object.keys(Config.dict).sort();
const hashed = new Set(BENCHMARK_CONFIG_KEYS);
const excluded = new Set(Object.keys(BENCHMARK_CONFIG_EXCLUSIONS));

// 1. Không khoá runtime nào được bỏ sót (đây là bất biến chính).
const unclassified = runtimeKeys.filter((key) => !hashed.has(key) && !excluded.has(key));
assert.deepEqual(unclassified, [],
  `every runtime Config key must be hashed or explicitly excluded; unclassified: ${unclassified.join(', ')}`);

// 2. Không khoá nào vừa hash vừa exclude (mâu thuẫn phân loại).
const both = [...hashed].filter((key) => excluded.has(key));
assert.deepEqual(both, [], `keys cannot be both hashed and excluded: ${both.join(', ')}`);

// 3. Không khoá hash/exclude nào là "ma" (không tồn tại trong runtime).
const runtimeSet = new Set(runtimeKeys);
const ghostHashed = [...hashed].filter((key) => !runtimeSet.has(key));
assert.deepEqual(ghostHashed, [], `hashed keys must exist in runtime Config: ${ghostHashed.join(', ')}`);
const ghostExcluded = [...excluded].filter((key) => !runtimeSet.has(key));
assert.deepEqual(ghostExcluded, [], `excluded keys must exist in runtime Config: ${ghostExcluded.join(', ')}`);

// 4. Mọi exclusion phải kèm LÝ DO (không exclude im lặng).
for (const [key, reason] of Object.entries(BENCHMARK_CONFIG_EXCLUSIONS)) {
  assert.equal(typeof reason, 'string');
  assert(reason.trim().length > 0, `exclusion ${key} must carry a reason`);
}

// 5. Không trùng khoá trong danh sách hash.
assert.equal(new Set(BENCHMARK_CONFIG_KEYS).size, BENCHMARK_CONFIG_KEYS.length,
  'BENCHMARK_CONFIG_KEYS must not contain duplicates');

// 6. Bất biến hành vi: hai config KHÁC nhau ở một khoá hành vi bất kỳ ⇒ hash KHÁC.
//    Đây chính là lỗ fail-open cũ — kiểm bằng hàm hash THẬT, không đọc danh sách.
const { profileConfigHash } = await import('../tools/trajectory-schema.mjs');
const baseConfig = Object.fromEntries(runtimeKeys.map((key) => [key, null]));
// Đặt giá trị "trung tính" khác null để mọi khoá đều có mặt.
for (const key of runtimeKeys) baseConfig[key] = typeof Config.dict[key]?.defaultValue === 'undefined'
  ? null : Config.dict[key].defaultValue;
const baseHash = profileConfigHash(baseConfig);
assert.equal(typeof baseHash, 'string', 'a full config must produce a hash');
for (const key of BENCHMARK_CONFIG_KEYS) {
  const mutated = { ...baseConfig, [key]: Symbol.iterator in Object(baseConfig[key] ?? '')
    ? 'MUTATED' : 12345.678 };
  if (JSON.stringify(mutated[key]) === JSON.stringify(baseConfig[key])) continue;
  assert.notEqual(profileConfigHash(mutated), baseHash,
    `changing behavior key ${key} MUST change the profile config hash`);
}
// 7. Khoá bị loại (logDir) KHÔNG được đổi hash — nó thật sự vô hại với hành vi.
assert.equal(profileConfigHash({ ...baseConfig, logDir: '/tmp/a' }),
  profileConfigHash({ ...baseConfig, logDir: '/tmp/b' }),
  'excluded logDir must not affect the hash');

console.log(`PASS trajectory config coverage (${runtimeKeys.length} runtime keys = `
  + `${BENCHMARK_CONFIG_KEYS.length} hashed + ${excluded.size} excluded)`);
