import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function createHostResolver(manifest, workspace = false) {
  const hostManifest = resolve(manifest);
  const released = createRequire(hostManifest);
  let packages;
  if (workspace) {
    let root = dirname(hostManifest);
    while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
      const parent = dirname(root);
      if (parent === root) throw new Error('workspace root with pnpm-workspace.yaml not found');
      root = parent;
    }
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (!Array.isArray(metadata.workspaces)) throw new Error('workspace package.json has no workspaces array');
    packages = new Map();
    const expand = (base, segments) => {
      if (!segments.length) {
        const file = join(base, 'package.json');
        if (!existsSync(file)) return;
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        if (!pkg.name) return;
        if (packages.has(pkg.name) && packages.get(pkg.name) !== file) throw new Error(`duplicate workspace package ${pkg.name}`);
        packages.set(pkg.name, file);
        return;
      }
      const [segment, ...rest] = segments;
      if (!segment.includes('*')) {
        const next = join(base, segment);
        if (existsSync(next) && statSync(next).isDirectory()) expand(next, rest);
        return;
      }
      const pattern = new RegExp(`^${segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && pattern.test(entry.name)) expand(join(base, entry.name), rest);
      }
    };
    for (const pattern of metadata.workspaces) expand(root, pattern.split('/'));
  }
  const entryOf = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    for (const [condition, target] of Object.entries(value)) {
      if (!['node', 'import', 'default'].includes(condition)) continue;
      const selected = entryOf(target);
      if (selected) return selected;
    }
    return undefined;
  };
  return (name) => {
    const fullName = `@deepseek-ai/${name}`;
    if (!workspace) return released.resolve(fullName);
    const file = packages.get(fullName);
    if (!file) throw new Error(`workspace package ${fullName} not found by manifest name`);
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const target = pkg.exports === undefined ? pkg.main : entryOf(pkg.exports?.['.'] ?? pkg.exports);
    if (typeof target !== 'string') throw new Error(`${fullName} has no Node import entry in exports/main`);
    const base = dirname(file);
    const entry = resolve(base, target);
    if (!entry.startsWith(base + sep)) throw new Error(`${fullName} build entry escapes its package`);
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`${fullName} build entry missing: ${entry}`);
    return entry;
  };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'jev-host-resolver-'));
  const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    json(join(root, 'package.json'), { workspaces: ['vendor/*', 'packages/*/*', 'apps/*'] });
    const host = join(root, 'apps/cli/package.json');
    json(host, { name: '@deepseek-ai/dsh', version: 'fixture' });
    const moved = join(root, 'packages/renamed/user-question/package.json');
    json(moved, { name: '@deepseek-ai/dsh-user-questions', exports: { '.': { types: './lib/index.d.ts', import: './lib/esm.js', default: './lib/index.js' } } });
    mkdirSync(join(dirname(moved), 'lib'));
    writeFileSync(join(dirname(moved), 'lib/esm.js'), 'export {};');
    assert.equal(createHostResolver(host, true)('dsh-user-questions'), join(dirname(moved), 'lib/esm.js'));
    assert.throws(() => createHostResolver(host, true)('missing'), /not found by manifest name/);
    json(moved, { name: '@deepseek-ai/dsh-user-questions', main: 'lib/missing.js' });
    assert.throws(() => createHostResolver(host, true)('dsh-user-questions'), /build entry missing/);
    const npmManifest = join(root, 'released/package.json');
    json(npmManifest, { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: 'lib/bin.js' } });
    const installed = join(root, 'released/node_modules/@deepseek-ai/cordis');
    json(join(installed, 'package.json'), { name: '@deepseek-ai/cordis', main: 'index.js' });
    writeFileSync(join(installed, 'index.js'), 'module.exports = {};');
    assert.equal(createHostResolver(npmManifest)('cordis'), join(installed, 'index.js'));
    const brokenHost = join(root, 'isolated');
    mkdirSync(brokenHost);
    writeFileSync(join(brokenHost, 'pnpm-workspace.yaml'), 'packages: []\n');
    json(join(brokenHost, 'package.json'), { name: '@deepseek-ai/dsh', version: 'fixture', bin: { dsh: 'lib/bin.js' } });
    const child = spawnSync(process.execPath, [new URL('./dsh-compat.mjs', import.meta.url).pathname], {
      env: { ...process.env, DSH_HOST_PACKAGE: join(brokenHost, 'package.json'), DSH_COMPAT_MASTER: '1', DSH_COMPAT_STRICT: '0' }, encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /phase=workspace package discovery/);
    assert.doesNotMatch(child.stdout, /SKIP/);
    console.log('PASS host resolver: released tree, moved workspace name, import exports, missing build diagnostics, discovered-host failures never skip');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) selfTest();
