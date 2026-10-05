import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METRICS, metricValue, provenance } from './benchmark-trajectory.mjs';

// Usage: node tools/trajectory-matrix.mjs measured.jsonl | --self-test
// Identity: task_id + seed + repo_state (commit/dirty hash) + model (exact route).
// P2 measurements use snake_case keys below; effort is the actual resolved effort.
// Read measured JSONL only: this command never runs tasks or enables plugin features.
export const ARMS = Object.freeze(['vanilla', 'safe', 'balanced', 'experimental']);
const EXTRA = ['task_quality', 'reasoning_tokens', 'generations', 'repeated_tool_calls',
  'jev_latency_ms', 'review_count', 'review_time_ms', 'jevgrep_count', 'jevgrep_time_ms',
  'context_injected_tokens', 'false_allow', 'false_deny', 'searches_before_target_read',
  'unnecessary_file_reads', 'target_in_top_n'];
const KEYS = [...METRICS.map(({ key }) => key), ...EXTRA];
const valueOf = (row, key) => {
  if (!EXTRA.includes(key)) return metricValue(row, key);
  const value = row[key];
  if (key === 'target_in_top_n' && typeof value === 'boolean') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const keyOf = (row) => JSON.stringify([row.task_id, row.seed, row.repo_state, row.model]);

export function matrix(text) {
  const groups = new Map();
  const rejected = [];
  String(text).split('\n').forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    let row;
    try { row = JSON.parse(line); } catch { rejected.push({ line: index + 1, reason: 'invalid JSON' }); return; }
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !['task_id', 'repo_state', 'model'].every((key) => typeof row[key] === 'string' && row[key].trim())
      || !(typeof row.seed === 'string' && row.seed.trim() || Number.isSafeInteger(row.seed))
      || !ARMS.includes(row.arm)) {
      rejected.push({ line: index + 1, reason: 'required task_id/seed/repo_state/model/four-arm identity missing' });
      return;
    }
    if (row.arm !== 'experimental' && (row.effortAbstain === true || row.layer5 === true)) {
      rejected.push({ line: index + 1, reason: 'effortAbstain and Layer5 are experimental-only' });
      return;
    }
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    // Poison duplicate arm identities rather than arbitrarily selecting a run.
    group.set(row.arm, group.has(row.arm) ? null : row);
  });
  const complete = [];
  const incomplete = [];
  for (const [identity, group] of groups) {
    if (ARMS.every((arm) => group.get(arm))) complete.push(group);
    else incomplete.push({ identity: JSON.parse(identity), missing_or_duplicate: ARMS.filter((arm) => !group.get(arm)) });
  }
  const comparisons = Object.fromEntries(ARMS.slice(1).map((arm) => [arm,
    Object.fromEntries(KEYS.map((key) => {
      const pairs = complete.map((group) => [valueOf(group.get('vanilla'), key), valueOf(group.get(arm), key)])
        .filter(([baseline, treatment]) => baseline !== null && treatment !== null);
      return [key, { pairs: pairs.length, vanilla: mean(pairs.map(([v]) => v)),
        treatment: mean(pairs.map(([, v]) => v)), delta: mean(pairs.map(([a, b]) => b - a)) }];
    }))]));
  const byEffort = Object.create(null);
  for (const group of complete) for (const arm of ARMS) {
    const row = group.get(arm);
    const effort = typeof row.effort === 'string' && row.effort.trim() ? row.effort : 'unknown';
    const bucket = byEffort[arm] ??= Object.create(null);
    (bucket[effort] ??= []).push(row);
  }
  for (const arm of Object.keys(byEffort)) for (const [effort, rows] of Object.entries(byEffort[arm])) {
    byEffort[arm][effort] = Object.fromEntries(['reasoning_tokens', 'walltime_ms', 'success', 'retries', 'generations'].map((key) => {
      const values = rows.map((row) => valueOf(row, key)).filter((value) => value !== null);
      return [key, { samples: values.length, mean: mean(values) }];
    }));
  }
  return { schema: 'trajectory-matrix-v1', arms: ARMS, complete_groups: complete.length,
    held_out_real_groups: complete.filter((group) => ARMS.every((arm) => provenance(group.get(arm)) === 'held-out-real')).length,
    verdict: 'unknown', note: 'Descriptive measurements only; missing metrics stay null. No trajectory benefit inferred.',
    comparisons, by_effort: byEffort, incomplete, rejected };
}

function selfTest() {
  const row = { task_id: 'fixture', seed: 1, repo_state: 'sha:fixture', model: 'fixture/model',
    source: 'synthetic', split: 'held-out', effort: 'low', success: true, walltime_ms: 10 };
  const encode = (rows) => rows.map((value) => JSON.stringify(value)).join('\n');
  const rows = ARMS.map((arm) => ({ ...row, arm }));
  const report = matrix(encode(rows));
  assert.equal(report.complete_groups, 1);
  assert.equal(report.held_out_real_groups, 0);
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.comparisons.safe.reasoning_tokens.delta, null);
  assert.equal(report.comparisons.safe.walltime_ms.delta, 0);
  assert.equal(report.by_effort.safe.low.success.mean, 1);
  assert.equal(matrix(encode([...rows, rows[0]])).complete_groups, 0);
  assert.equal(matrix(encode([...rows.slice(0, 3), { ...rows[3], model: 'other' }])).complete_groups, 0);
  assert.equal(matrix(encode([...rows.slice(0, 3), { ...rows[3], repo_state: 'other' }])).complete_groups, 0);
  assert.equal(matrix(encode(rows.map((r) => r.arm === 'safe' ? { ...r, layer5: true } : r))).rejected.length, 1);
  const prototypeEffort = matrix(encode(rows.map((r) => ({ ...r, effort: '__proto__' }))));
  assert.equal(prototypeEffort.by_effort.safe.__proto__.success.mean, 1);
  assert.equal(matrix(encode([...rows, rows[0], rows[0]])).complete_groups, 0);
  assert.equal(matrix('{bad').rejected.length, 1);
  assert.equal(matrix('').complete_groups, 0);
  console.log('PASS trajectory matrix self-test (synthetic validation only, not A/B evidence)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    const input = process.argv[2];
    if (!input || process.argv.length !== 3) {
      console.error('Usage: node tools/trajectory-matrix.mjs measured.jsonl | --self-test');
      process.exitCode = 1;
    } else {
      const report = matrix(readFileSync(resolve(input), 'utf8'));
      console.log(JSON.stringify(report, null, 2));
      if (report.rejected.length || report.incomplete.length || !report.complete_groups) process.exitCode = 1;
    }
  }
}
