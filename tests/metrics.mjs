import assert from 'node:assert/strict';
import { summarize } from '../lib/metrics.mjs';

const stats = summarize([
  { type: 'destructive_gate', decision: 'deny_outage', fixture: true },
  { type: 'destructive_gate', decision: 'allow', label: false },
  { type: 'destructive_gate', decision: 'deny_consent' },
]);
assert.equal(stats.total, 3);
assert.equal(stats.deny, 2);
assert.equal(stats.allow, 1);
assert.equal(stats.unlabeled, 2);
assert.equal(stats.canary, 1);
assert.equal(stats.useful_ratio, 0.6667);
console.log('metrics: PASS');
