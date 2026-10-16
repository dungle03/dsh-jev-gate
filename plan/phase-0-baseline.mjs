import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const input = resolve(process.argv[2] ?? `${process.env.HOME}/.local/share/dsh-jev-gate/decisions.jsonl`);
const output = resolve(process.argv[3] ?? `${root}/phase-0-v1.jsonl`);
const source = readFileSync(input, 'utf8');
const rows = [];
const malformed = [];
for (const [index, raw] of source.split(/\r?\n/).entries()) {
  if (!raw.trim()) continue;
  try {
    const row = JSON.parse(raw);
    const session = typeof row.session === 'string' ? createHash('sha256').update(row.session).digest('hex').slice(0, 16) : null;
    rows.push({
      dataset_version: 'phase0-v1', source_line: index + 1,
      at: typeof row.at === 'string' ? row.at : null,
      type: typeof row.type === 'string' ? row.type : 'unknown', session_hash: session,
      turn: Number.isInteger(row.turn) ? row.turn : null,
      step: Number.isInteger(row.step) ? row.step : null,
      layer: typeof row.layer === 'string' ? row.layer : null,
      decision: typeof row.decision === 'string' ? row.decision : null,
      action: typeof row.action === 'string' ? row.action : null,
      elapsed_ms: Number.isFinite(row.elapsed_ms) ? row.elapsed_ms : Number.isFinite(row.ms) ? row.ms : null,
      label: 'unknown', label_source: null, split: 'development',
    });
  } catch { malformed.push(index + 1); }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
const types = Object.fromEntries([...new Set(rows.map((row) => row.type))].sort().map((type) => [type, rows.filter((row) => row.type === type).length]));
const byType = Object.fromEntries(Object.keys(types).map((type) => [type, {
  count: types[type],
  decisions: Object.fromEntries([...new Set(rows.filter((r) => r.type === type).map((r) => r.decision).filter(Boolean))].sort().map((v) => [v, rows.filter((r) => r.type === type && r.decision === v).length])),
  session_turn_keys: rows.filter((r) => r.type === type && r.session_hash && r.turn !== null).length,
  steps: new Set(rows.filter((r) => r.type === type && r.step !== null).map((r) => r.step)).size,
  elapsed_samples: rows.filter((r) => r.type === type && r.elapsed_ms !== null).length,
}]));
const snapshot = {
  dataset_version: 'phase0-v1', source_path: input,
  source_sha256: createHash('sha256').update(source).digest('hex'),
  records: rows.length, malformed_lines: malformed,
  timestamp_min: rows.map((r) => r.at).filter(Boolean).sort()[0] ?? null,
  timestamp_max: rows.map((r) => r.at).filter(Boolean).sort().at(-1) ?? null,
  distinct_sessions: new Set(rows.map((r) => r.session_hash).filter(Boolean)).size,
  records_with_session_turn: rows.filter((r) => r.session_hash && r.turn !== null).length,
  records_unmatched_session_turn: rows.filter((r) => !r.session_hash || r.turn === null).length,
  by_type: byType,
  excluded_fields: ['command', 'error', 'message', 'files', 'config', 'model', 'signals', 'scores', 'usage', 'consent'],
  labels: { independent_human: 0, unknown: rows.length },
};
writeFileSync(`${output}.summary.json`, JSON.stringify(snapshot, null, 2) + '\n');
console.log(JSON.stringify({ output, summary: `${output}.summary.json`, ...snapshot }, null, 2));
if (process.argv.includes('--self-test')) {
  if (rows.some((r) => 'command' in r || 'error' in r || 'message' in r)) throw new Error('sensitive field leaked');
  if (rows.some((r) => r.label !== 'unknown' || r.label_source !== null)) throw new Error('labels must remain unknown');
  console.log('self-test passed');
}
// Event logs lack task intent and outcomes, so retain unknown labels instead of inferring them from gate decisions.
