import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, apply } from '../lib/index.mjs';
import { resolveProfile } from '../lib/profiles.mjs';

/**
 * `apply` ghi `boot`/`unknown_config` vào `logDir`; thiếu `logDir` thì nó rơi
 * về nhật ký THẬT của plugin. Bài test này cố tình truyền khoá sai để kiểm
 * cảnh báo, nên phải trỏ vào thư mục tạm — nếu không, mỗi lần chạy kiểm thử lại
 * đẩy một `boot` giả (kèm khoá sai chính tả) vào nhật ký vận hành, làm nhiễu mọi
 * phép đo sau này.
 */
const logDir = mkdtempSync(join(tmpdir(), 'jev-gate-profiles-'));
process.on('exit', () => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const parse = (value) => {
  const result = Config['~standard'].validate(value);
  assert.equal(result.issues, undefined, JSON.stringify(result.issues));
  return result.value;
};
const defaults = parse({});
assert.equal(resolveProfile({}, defaults).enableSpawnHint, false);
assert.equal(defaults.shadowGateThreshold, undefined);
assert.equal(parse({ shadowGateThreshold: 0.6 }).shadowGateThreshold, 0.6);
assert.equal(resolveProfile({ profile: 'custom', enableSpawnHint: true }, defaults).enableSpawnHint, true);
for (const profile of ['safe', 'balanced', 'experimental']) {
  const resolved = resolveProfile(parse({ profile, gateFailureMode: 'auto_allow', enableCatastrophicFloor: false, destructiveThreshold: 1 }), defaults);
  assert.equal(resolved.gateFailureMode, 'ask');
  assert.equal(resolved.destructiveThreshold, 0.7);
  assert.equal(resolved.enableCatastrophicFloor, true);
  assert.equal(resolved.enableDestructiveGate, true);
  assert.equal(resolved.enableDestructiveConsent, true);
  assert.equal(resolved.enableAuthorizationOverride, true);
  assert.equal(resolved.enableReadOnlyPrefilter, true);
  assert.equal(resolved.enableSpawnHint, profile === 'experimental');
  assert.equal(resolved.enableContextTriage, profile === 'experimental');
  assert.equal(resolved.enableJevgrepEscalation, profile === 'experimental');
  assert.equal(resolved.enableEffortRouting, profile !== 'safe');
  assert.equal(resolved.enableFailureRecovery, profile !== 'safe');
  assert.equal(resolved.enableQualityReview, profile !== 'safe');
  const strict = resolveProfile(parse({ profile, gateFailureMode: 'block',
    enableAuthorizationOverride: false, enableDestructiveConsent: false,
    destructiveThreshold: 0.3 }), defaults);
  assert.equal(strict.gateFailureMode, 'block');
  assert.equal(strict.enableAuthorizationOverride, false);
  assert.equal(strict.enableDestructiveConsent, false);
  assert.equal(strict.destructiveThreshold, 0.3);
}
assert.ok(Config['~standard'].validate({ destructiveThreshold: 2 }).issues?.length);
assert.ok(Config['~standard'].validate({ shadowGateThreshold: -0.1 }).issues?.length);
assert.ok(Config['~standard'].validate({ shadowGateThreshold: 1.1 }).issues?.length);
assert.ok(Config['~standard'].validate({ contextFileThreshold: 2 }).issues?.length);
assert.throws(() => resolveProfile({ profile: 'missing' }, defaults), /Unknown jev-gate profile/);
const warnings = [];
apply({
  on() {}, effect() {}, logger: { warn: (message) => warnings.push(message) },
  credentials: { resolve: async () => ({ value: 'test-key' }) },
}, parse({ logDir, destructiveThreshhold: 0.1, enableDestructiveGatee: false }));
assert.ok(warnings.some((message) => message.includes('destructiveThreshhold')
  && message.includes('enableDestructiveGatee')));
console.log('profiles: PASS');
