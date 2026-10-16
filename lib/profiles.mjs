// Named profiles select layer groups while preserving stricter gate settings.
export const PROFILES = Object.freeze({
  safe: Object.freeze({
    enableDestructiveGate: true,
    enableReadOnlyPrefilter: true,
    enableCatastrophicFloor: true,
    enableAuthorizationOverride: true,
    enableDestructiveConsent: true,
    gateFailureMode: 'ask',
    destructiveThreshold: 0.7,
    enableCompletionCheck: true,
    enableEffortRouting: false,
    enableFailureRecovery: false,
    enableQualityReview: false,
    enableSpawnHint: false,
    enableContextTriage: false,
    enableJevgrepEscalation: false,
    effortAbstain: false,
  }),
  balanced: Object.freeze({
    enableDestructiveGate: true,
    enableReadOnlyPrefilter: true,
    enableCatastrophicFloor: true,
    enableAuthorizationOverride: true,
    enableDestructiveConsent: true,
    gateFailureMode: 'ask',
    destructiveThreshold: 0.7,
    enableCompletionCheck: true,
    enableEffortRouting: true,
    enableFailureRecovery: true,
    enableQualityReview: true,
    enableSpawnHint: false,
    enableContextTriage: false,
    enableJevgrepEscalation: false,
    effortAbstain: false,
  }),
  experimental: Object.freeze({
    enableDestructiveGate: true,
    enableReadOnlyPrefilter: true,
    enableCatastrophicFloor: true,
    enableAuthorizationOverride: true,
    enableDestructiveConsent: true,
    gateFailureMode: 'ask',
    destructiveThreshold: 0.7,
    enableCompletionCheck: true,
    enableEffortRouting: true,
    enableFailureRecovery: true,
    enableQualityReview: true,
    enableSpawnHint: true,
    enableContextTriage: true,
    enableJevgrepEscalation: true,
    effortAbstain: true,
  }),
});

export function resolveProfile(config, defaults) {
  const profile = config.profile ?? 'custom';
  if (profile === 'custom') return { ...defaults, ...config };
  if (!Object.hasOwn(PROFILES, profile)) throw new TypeError(`Unknown jev-gate profile: ${profile}`);
  const resolved = { ...defaults, ...config, ...PROFILES[profile] };
  // A preset must not relax an explicitly stricter destructive-gate setting.
  //
  // `enableReadOnlyPrefilter: false` là một trong số đó: prefilter là ĐƯỜNG VÒNG
  // của gate (lệnh chứng minh chỉ-đọc thì bỏ qua Jev). Tắt nó = MỌI lệnh bash đều
  // qua Jev = chặt hơn. Thiếu dòng dưới đây, preset âm thầm bật lại đường vòng,
  // tức người dùng yêu cầu chặt nhất lại nhận cấu hình lỏng hơn yêu cầu — đúng
  // loại lỗi mà khối này tồn tại để chặn. Phát hiện khi rà soát 16/10 bằng cách
  // gọi thẳng `resolveProfile` với từng cờ "chặt hơn" (các cờ còn lại đã được
  // chặn; chỉ cờ này lọt).
  if (config.gateFailureMode === 'block') resolved.gateFailureMode = 'block';
  if (config.enableAuthorizationOverride === false) resolved.enableAuthorizationOverride = false;
  if (config.enableDestructiveConsent === false) resolved.enableDestructiveConsent = false;
  if (config.enableReadOnlyPrefilter === false) resolved.enableReadOnlyPrefilter = false;
  if (Number.isFinite(config.destructiveThreshold)) {
    resolved.destructiveThreshold = Math.min(config.destructiveThreshold, resolved.destructiveThreshold);
  }
  return resolved;
}
