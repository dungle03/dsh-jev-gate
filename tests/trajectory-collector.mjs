import assert from 'node:assert/strict';
import { summarize } from '../tools/collect-trajectory.mjs';
const options = { arm: 'vanilla', seed: 1, model: 'fixture', elapsed: 1, exitCode: 0, unchanged: true };
const events = [
  { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 1 } },
  { type: 'tool_call', callId: 'read-marker', tool: 'read', input: { file_path: 'marker.txt' } },
  { type: 'tool_result', callId: 'read-marker', status: 'completed', result: 'TRAJECTORY_OK_731' },
  { type: 'final', text: 'TRAJECTORY_OK_731' },
];
const row = summarize(events, [], options);
assert.equal(row.success, true);
assert.equal(row.reasoning_tokens, null);
assert.equal(row.input_tokens, 10);
assert.equal(row.false_allow, null);
assert.equal(row.jev_calls, 0);
assert.equal(row.searches_before_target_read, 0);
assert.equal(row.unnecessary_file_reads, 0);
assert.equal(summarize(events.filter((e) => e.type !== 'tool_call'), [], options).success, false);
assert.equal(summarize(events.filter((e) => e.type !== 'tool_result'), [], options).success, false);
const replaceRead = (patch) => events.map((e) => e.type === 'tool_call' ? { ...e, ...patch } : e);
assert.equal(summarize(replaceRead({ input: { file_path: 'not-marker.txt' } }), [], options).success, false);
assert.equal(summarize(replaceRead({ callId: undefined }), [], options).success, false);
assert.equal(summarize(events.map((e) => ({ ...e, callId: undefined })), [], options).success, false);
assert.equal(summarize(events.map((e) => e.type === 'tool_result' ? { ...e, result: {} } : e), [], options).success, false);
assert.equal(summarize(replaceRead({ input: { file_path: '/workspace/marker.txt' } }), [], options).success, true);
const searched = summarize([{ type: 'tool_call', tool: 'glob', input: {} },
  { type: 'tool_call', tool: 'read', input: { file_path: 'other.txt' } }, ...events], [], options);
assert.equal(searched.searches_before_target_read, 1);
assert.equal(searched.unnecessary_file_reads, 1);
assert.equal(summarize(events, [], { ...options, unchanged: false }).success, false);
assert.equal(summarize([...events, { type: 'status', phase: 'step_end' }], [], options).input_tokens, null);
assert.equal(summarize(events, [], { ...options, arm: 'safe' }).jev_calls, null);
console.log('PASS trajectory collector contract (synthetic parser checks only)');
