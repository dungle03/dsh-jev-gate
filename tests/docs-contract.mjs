import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Config } from '../lib/index.mjs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const languages = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function prose(markdown) {
  let fence;
  return markdown.split('\n').filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length
        && line.trim() === marker) fence = undefined;
      return false;
    }
    if (marker) { fence = marker; return false; }
    return true;
  }).join('\n').replace(/`[^`\n]*`/g, '');
}

function configuration(markdown) {
  const blocks = [...markdown.matchAll(/^```yaml\s*\n([\s\S]*?)^```\s*$/gm)]
    .map((match) => match[1]).filter((block) => /^  name: dsh-jev-gate\s*$/m.test(block) && /^  config:\s*$/m.test(block));
  assert.equal(blocks.length, 1, 'Exactly one complete plugin configuration example is required');
  const entries = [...blocks[0].matchAll(/^    (# )?([A-Za-z][A-Za-z0-9]*):([^\n]*)/gm)]
    .map((match) => [match[2], `${match[1] ? 'optional:' : ''}${match[3].split('#')[0].trim()}`]);
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, 'Configuration keys must not be duplicated');
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}
const configKeys = (markdown) => Object.keys(configuration(markdown)).sort();

const vi = read('README.md');
const en = read('README.en.md');
const changelog = read('CHANGELOG.md');
const manifest = JSON.parse(read('package.json'));
for (const [name, body] of [['README.md', vi], ['README.en.md', en], ['CHANGELOG.md', changelog]]) {
  assert.equal(languages.test(prose(body)), false, `${name}: unexpected Chinese/Japanese/Korean prose`);
}
assert.deepEqual(configuration(vi), configuration(en), 'Both complete examples must expose the same config keys, values and optional state');
assert.deepEqual(configKeys(vi), Object.keys(Config.dict).sort(), 'Examples must cover every runtime Config key, not only new keys');
assert.equal(manifest.version, '0.14.0');
assert.equal(manifest.engines.dsh, '0.2.0-rc.2');
for (const body of [vi, en]) {
  assert.ok(body.includes('`0.14.0`') && body.includes('`0.2.0-rc.2`'), 'Release/support versions must be explicit');
  assert.match(body, /\| DSH master \|/);
  assert.doesNotMatch(body, /(?:warm|cached|cache|ấm)[^\n]{0,80}(?:=\s*3|costs?\s+3|tốn\s+3)/i, 'No unimplemented warm=3 cost claim');
  assert.match(body, /jevGrepMaxConcurrentPerSession: 1/);
  assert.match(body, /jevGrepMaxConcurrentGlobal: 2/);
  assert.match(body, /reviewMode: agent-feedback/);
  assert.match(body, /0.*(?:tắt|disable)/i);
}
assert.match(vi, /DSH master \| Chỉ quan sát/);
assert.match(en, /DSH master \| Observational only/);
assert.match(changelog, /^## \[0\.14\.0\]/m);
assert.match(changelog, /reviewReportToAgent/);
assert.match(changelog, /giữ trước/);

// Mutations prove the checks reject drift without rejecting Vietnamese or code.
assert.equal(languages.test(prose('Tiếng Việt: đường dẫn và cấu hình.\n```js\nconst text = "中文";\n```\n`日本語`')), false);
assert.equal(languages.test(prose('~~~~text\n日本語\n~~~\n한국어\n~~~~')), false);
assert.equal(languages.test(prose('~~~~text\n日本語\n~~~~\n中文')), true);
for (const text of ['中文', '日本語', 'ひらがな', 'カタカナ', '한국어']) assert.equal(languages.test(prose(text)), true);
assert.throws(() => configKeys(vi.replace('    maxDecisionCostPerTurn: 16', '    maxDecisionCostPerTurn: 16\n    maxDecisionCostPerTurn: 16')));
assert.notDeepEqual(configKeys(vi.replace(/^    jevBudgetEnabled:.*\n/m, '')), Object.keys(Config.dict).sort());
assert.notDeepEqual(configuration(vi.replace('    jevMaxCallsPerTurn: 4', '    jevMaxCallsPerTurn: 99')), configuration(en));
assert.notDeepEqual(configuration(vi.replace('    # reviewMode:', '    reviewMode:')), configuration(en));
console.log(`docs contract: complete ${configKeys(vi).length}-key VI/EN examples, language, release and runtime contracts passed`);
