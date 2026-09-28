/**
 * repair-session-source.mjs — vá record `"source":"jev-gate"` (chuỗi trần) trong
 * log session v4 thành `{"kind":"plugin:jev-gate"}`, để session cũ load lại được.
 *
 * Bối cảnh: dsh-jev-gate < 0.3.1 đặt `source` của message chèn là một **chuỗi**.
 * Session format v4 chỉ nhận `source` là object có `kind` không rỗng và khác
 * `'plugin'` (một plugin khai kind riêng là `plugin:<tên>`). Log ghi ra vẫn
 * append được — validate lúc ghi không kiểm source — nhưng lần đọc lại kế tiếp
 * ném `SessionFormatError: format v4 message requires a producer-owned source
 * kind`, và cả session bị coi là corrupt.
 *
 * Script chỉ đổi đúng trường `source` của record khớp, giữ nguyên ranh giới zstd
 * frame, và từ chối publish nếu bytes mới vẫn fail strict validation.
 *
 * Dùng:
 *   node tools/repair-session-source.mjs              # quét $DSH_HOME/sessions
 *   node tools/repair-session-source.mjs <file...>    # vá file cụ thể
 *   node tools/repair-session-source.mjs --check      # chỉ kiểm, không sửa
 *
 * Bản gốc của mỗi file được giữ cạnh nó với hậu tố .bak-sourcekind-<time>.
 * Nên chạy khi dsh đã tắt: file đang được tiến trình khác mở sẽ bị bỏ qua.
 */

import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/** Resolve the installed DSH packages so the loader validates exactly as DSH does. */
function dshPackages() {
  const roots = [
    process.env.DSH_INSTALL_ROOT,
    '/home/lee/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh',
  ].filter(Boolean);
  for (const root of roots) {
    const base = join(root, 'node_modules', '@deepseek-ai');
    if (existsSync(join(base, 'dsh-session-format-v3-to-v4'))) {
      return { base, root };
    }
  }
  throw new Error('cannot locate @deepseek-ai/dsh packages; set DSH_INSTALL_ROOT');
}

const { base: PKG_BASE } = dshPackages();
const { releasedV4SessionFormatCodec, assertReleasedV4Relationships } =
  await import(join(PKG_BASE, 'dsh-session-format-v3-to-v4', 'lib', 'index.js'));
const { SessionFormatEventCollector } =
  await import(join(PKG_BASE, 'dsh-session-format', 'lib', 'index.js'));
const { KNOWN_SESSION_EVENT_TYPES } =
  await import(join(PKG_BASE, 'dsh-session', 'lib', 'index.js'));

/** Locate complete zstd frames without decompressing them (mirrors DSH's scanner). */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('corrupt Zstandard session log: reserved header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remaining) return { frames, tornStart: start };
    offset += remaining;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('corrupt Zstandard session log: reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Decode one session log exactly as DSH's strict current-generation read does. */
export function loadStrict(file) {
  const bytes = readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log');
  if (tornStart !== undefined) throw new Error('current session generation has a torn physical tail');
  const plains = frames.map((frame) => zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
  const header = plains[0];
  if (header.indexOf(10) !== header.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
  }
  const decoder = releasedV4SessionFormatCodec.createDecoder(
    JSON.parse(header.subarray(0, -1).toString('utf8')),
    'strict',
  );
  const collector = new SessionFormatEventCollector();
  let rows = 0;
  for (const plain of plains.slice(1)) {
    let lineStart = 0;
    for (let nl = plain.indexOf(10); nl !== -1; nl = plain.indexOf(10, lineStart)) {
      decoder.decodeRow(JSON.parse(plain.subarray(lineStart, nl).toString('utf8')), collector);
      rows += 1;
      lineStart = nl + 1;
    }
    if (lineStart < plain.length) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record');
    }
  }
  const inheritedEventCount = decoder.finish(collector);
  assertReleasedV4Relationships(
    { header: decoder.header, inheritedEventCount, events: collector.values },
    KNOWN_SESSION_EVENT_TYPES,
  );
  return { header: decoder.header, events: collector.values, rows, inheritedEventCount };
}

/**
 * Rewrite one legacy row; return null when the line needs no change.
 *
 * Mirrors DSH's own v3→v4 message-source conversion: a bare string source and a
 * `kind: 'plugin'` wrapper both become `plugin:<producer>`. The same-name
 * first-party producers and the retired renames (`compact`, `tools-ptc`,
 * `tools-code-mode`, `dsh-compaction-basic`, `@deepseek-ai/dsh-system-prompt`)
 * are deliberately NOT special-cased here: those never reach this script,
 * because the released migration already handles them and the sessions this
 * repairs were written by third-party plugins using the plain wrapper.
 */
const RETIRED_RENAMES = new Map([
  ['compact', 'compact-checkpoint'],
  ['tools-code-mode', 'ptc-mode'],
  ['tools-ptc', 'ptc-mode'],
  ['dsh-compaction-basic', 'compact-basic'],
]);

function migratedKind(name) {
  return RETIRED_RENAMES.get(name) ?? `plugin:${name}`;
}

function fixSource(source) {
  if (typeof source === 'string' && source.length > 0) return { kind: migratedKind(source) };
  if (source !== null && typeof source === 'object' && source.kind === 'plugin') {
    const name = typeof source.plugin === 'string' ? source.plugin : '';
    if (name.length === 0) return null;
    const { plugin: _drop, ...rest } = source;
    return { ...rest, kind: migratedKind(name) };
  }
  return null;
}

function fixLine(text) {
  const value = JSON.parse(text);
  if (value?.type !== 'user/message') return null;
  const fixed = fixSource(value.data?.source);
  if (fixed === null) return null;
  value.data.source = fixed;
  return JSON.stringify(value);
}

/** Rewrite legacy sources in place across frame boundaries, preserving frame layout. */
function repairFile(file) {
  const bytes = readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log');
  if (tornStart !== undefined) throw new Error('current session generation has a torn physical tail');
  const out = [];
  let changed = 0;
  for (const [index, frame] of frames.entries()) {
    const raw = bytes.subarray(frame.start, frame.end);
    const plain = zlib.zstdDecompressSync(raw);
    if (index === 0) {
      if (plain.indexOf(10) !== plain.length - 1) {
        throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
      }
      out.push(raw);
      continue;
    }
    if (plain.indexOf(10) === -1) throw new Error(`frame ${index} is not newline terminated`);
    const pieces = [];
    let lineStart = 0;
    let touched = false;
    for (let nl = plain.indexOf(10); nl !== -1; nl = plain.indexOf(10, lineStart)) {
      const fixed = fixLine(plain.subarray(lineStart, nl).toString('utf8'));
      if (fixed === null) {
        pieces.push(plain.subarray(lineStart, nl + 1));
      } else {
        pieces.push(Buffer.from(`${fixed}\n`, 'utf8'));
        touched = true;
        changed += 1;
      }
      lineStart = nl + 1;
    }
    if (lineStart < plain.length) {
      throw new Error(`corrupt Zstandard session log: frame ${index} contains a torn JSONL record`);
    }
    out.push(touched ? zlib.zstdCompressSync(Buffer.concat(pieces), CHECKSUM_OPTIONS) : raw);
  }
  return { next: Buffer.concat(out), changed };
}

/** Every session log under $DSH_HOME/sessions. */
function listSessions() {
  const base = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  const found = [];
  for (const project of readdirSync(base)) {
    const dir = join(base, project);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const session of entries) {
      const file = join(dir, session, 'session.v4.jsonl.zstd');
      if (existsSync(file)) found.push(file);
    }
  }
  return found.sort();
}

/** Whether a process currently holds this log open (an in-flight append). */
function isHeld(file) {
  try {
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      const fds = join('/proc', pid, 'fd');
      let links;
      try { links = readdirSync(fds); } catch { continue; }
      for (const fd of links) {
        try {
          if (readlinkSync(join(fds, fd)) === file) return true;
        } catch { /* fd raced away */ }
      }
    }
  } catch { /* /proc unavailable: treat as free */ }
  return false;
}

/** Publish repaired bytes only after re-validating them and confirming no append raced us. */
function publish(file, next, expectedSize) {
  const dir = dirname(file);
  const staging = join(dir, `session.v4.jsonl.zstd.repair-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(staging, next, { mode: 0o600, flag: 'wx' });
  const handle = openSync(staging, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  loadStrict(staging);
  // Refuse to clobber an append that landed while this repair was being built.
  // Losing a frame would desynchronize the live session's sequence numbering.
  if (statSync(file).size !== expectedSize) {
    rmSync(staging, { force: true });
    throw new Error('session log grew during repair (concurrent append); re-run to repair it');
  }
  const backup = `${file}.bak-sourcekind-${Date.now()}`;
  renameSync(file, backup);
  renameSync(staging, file);
  return backup;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const named = args.filter((arg) => !arg.startsWith('--'));
const files = named.length > 0 ? named : listSessions();

let repaired = 0;
let skipped = 0;
let totalChanged = 0;
let pending = 0;
for (const file of files) {
  try {
    loadStrict(file);
    continue;
  } catch (error) {
    if (!/producer-owned source kind/.test(error.message)) {
      console.log(`skip (different failure) ${file} -> ${error.message}`);
      skipped += 1;
      continue;
    }
  }
  if (checkOnly) {
    console.log(`needs repair ${file}`);
    pending += 1;
    continue;
  }
  if (isHeld(file)) {
    console.log(`skip (in use by a running process) ${file}`);
    skipped += 1;
    pending += 1;
    continue;
  }
  const sizeBefore = statSync(file).size;
  const { next, changed } = repairFile(file);
  if (changed === 0) {
    console.log(`skip (nothing to fix) ${file}`);
    skipped += 1;
    continue;
  }
  let backup;
  try {
    backup = publish(file, next, sizeBefore);
  } catch (error) {
    console.log(`skip (${error.message}) ${file}`);
    skipped += 1;
    pending += 1;
    continue;
  }
  repaired += 1;
  totalChanged += changed;
  console.log(`repaired ${file} (${changed} record(s)); backup ${backup}`);
}
console.log(
  `scanned ${files.length}, repaired ${repaired}, skipped ${skipped}, records rewritten ${totalChanged}`
);
if (checkOnly && pending > 0) process.exitCode = 1;
