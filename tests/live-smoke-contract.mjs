import assert from 'node:assert/strict';
import { liveSmoke, validateSmoke } from './live-smoke.mjs';
const result = { model: 'fixture', answers: { square: { type: 'noul', noul: 0.99 },
  color: { type: 'choice', choice: 'blue', confidence: 0.9, probabilities: { blue: 0.99, red: 0.01 } } },
  usage: { input_tokens: 1, output_tokens: 1 } };
validateSmoke(result);
for (const mutate of [
  (v) => { v.answers.square.noul = NaN; },
  (v) => { v.answers.color.probabilities.blue = 4; },
  (v) => { delete v.usage; },
]) { const value = structuredClone(result); mutate(value); assert.throws(() => validateSmoke(value)); }
let calls = 0;
const smoke = await liveSmoke({ key: 'fixture', fetcher: async (_url, request) => {
  calls += 1; assert.equal(Object.keys(JSON.parse(request.body).questions).length, 2);
  return new Response(JSON.stringify(result), { status: 200 });
} });
assert.equal(calls, 1);
assert.equal(smoke.http_status, 200);
assert.equal(smoke.source, 'synthetic');
await assert.rejects(liveSmoke({ key: 'fixture', fetcher: async () => new Response('', { status: 401 }) }), /HTTP 401/);
console.log('PASS live smoke contract (fixtures only, not live API evidence)');
