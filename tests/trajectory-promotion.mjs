import assert from 'node:assert/strict';
import { ARMS, matrix } from '../tools/trajectory-matrix.mjs';
const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const rows = Array.from({ length: 10 }, (_, seed) => ARMS.map((arm) => ({
  task_id: `fixture-${seed}`, seed, repo_state: 'fixture', model: 'fixture', arm,
  source: 'real', split: 'held-out', task_class: seed < 5 ? 'routine' : 'navigation',
  success: true, tests_passed: 1, tests_total: 1, walltime_ms: 1, cost_usd: 1,
  false_allow: 0, false_deny: 0,
}))).flat();
// Declared source tags validate the gate, not the authenticity of these fixtures.
const report = matrix(encode(rows));
assert.equal(report.promotion.experimental.status, 'eligible-for-review');
assert.equal(report.promotion.experimental.automatic_promotion, false);
assert.equal(matrix(encode(rows.map((r) => ({ ...r, source: 'synthetic' })))).promotion.experimental.status, 'hold');
assert.equal(matrix(encode(rows.filter((r) => r.seed < 2))).promotion.experimental.status, 'hold');
assert.equal(matrix(encode(rows.map((r) => r.arm === 'experimental' ? { ...r, false_allow: 1 } : r))).promotion.experimental.status, 'regression');
assert.equal(matrix(encode(rows.map((r) => r.arm === 'experimental' ? { ...r, cost_usd: null } : r))).promotion.experimental.status, 'hold');
assert.equal(matrix(encode(rows.map((r) => r.arm === 'experimental' ? { ...r, walltime_ms: 2 } : r))).promotion.experimental.status, 'hold');
console.log('PASS trajectory promotion contract (synthetic gate validation only)');
