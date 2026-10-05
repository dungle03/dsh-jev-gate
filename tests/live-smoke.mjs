import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SMOKE_REQUEST = Object.freeze({
  model: 'jev-latest',
  state: { text: 'The package contains a blue square.' },
  questions: {
    square: { type: 'noul', instructions: 'Does the text explicitly say the package contains a square?' },
    color: { type: 'choice', instructions: 'Which color does the text explicitly name?',
      criteria: { blue: 'Blue', red: 'Red' } },
  },
});
export function validateSmoke(value) {
  const probability = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  assert.equal(typeof value?.model, 'string');
  assert.equal(value.answers?.square?.type, 'noul');
  assert.ok(probability(value.answers.square.noul));
  const color = value.answers?.color;
  assert.equal(color?.type, 'choice');
  assert.ok(['blue', 'red'].includes(color.choice));
  assert.ok(probability(color.confidence));
  assert.deepEqual(Object.keys(color.probabilities).sort(), ['blue', 'red']);
  assert.ok(Object.values(color.probabilities).every(probability));
  assert.ok(Math.abs(color.probabilities.blue + color.probabilities.red - 1) < 0.02);
  for (const key of ['input_tokens', 'output_tokens']) assert.ok(Number.isSafeInteger(value.usage?.[key]) && value.usage[key] >= 0);
  assert.ok(value.answers.square.noul > 0.5);
  assert.equal(color.choice, 'blue');
}
export async function liveSmoke({ key = process.env.TYPESAFE_API_KEY, fetcher = fetch, timeoutMs = 30_000 } = {}) {
  assert.ok(typeof key === 'string' && key.trim(), 'TYPESAFE_API_KEY is required');
  const started = performance.now();
  const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(SMOKE_REQUEST), signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200, `Jev HTTP ${response.status}`);
  const value = await response.json();
  validateSmoke(value);
  return { source: fetcher === fetch ? 'real' : 'synthetic', http_status: response.status, model: value.model,
    latency_ms: Math.round(performance.now() - started), questions: 2, usage: value.usage };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await liveSmoke())); }
  catch (error) { console.error(`Live smoke failed: ${error.message}`); process.exitCode = 1; }
}
