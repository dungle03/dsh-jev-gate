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
  }),
});

export function resolveProfile(config, defaults) {
  const profile = config.profile ?? 'custom';
  if (profile === 'custom') return { ...defaults, ...config };
  if (!Object.hasOwn(PROFILES, profile)) throw new TypeError(`Unknown jev-gate profile: ${profile}`);
  const resolved = { ...defaults, ...config, ...PROFILES[profile] };
  // A preset must not relax an explicitly stricter destructive-gate setting.
  if (config.gateFailureMode === 'block') resolved.gateFailureMode = 'block';
  if (config.enableAuthorizationOverride === false) resolved.enableAuthorizationOverride = false;
  if (config.enableDestructiveConsent === false) resolved.enableDestructiveConsent = false;
  if (Number.isFinite(config.destructiveThreshold)) {
    resolved.destructiveThreshold = Math.min(config.destructiveThreshold, resolved.destructiveThreshold);
  }
  return resolved;
}
