/**
 * 索引文档的读与追加：两种模式一套返回结构。
 *
 * - `single`：主索引文件就是全量清单。新库（`indexTemplate()` 单表）追加到最后一表末行；
 *   旧库（多张表 / 不是新库模板）只往文件末尾的 `## 新入库（待整理）` 区写，原表一个字节不动。
 * - `sharded`：主索引文件退化为目录，行在 `refs/index/shard-NNN.md` 里；追加时先填满
 *   最后一个分片，再按 `shardEntries`（默认 200）开新分片，最后重写目录。
 *
 * 所有写盘前先备份：主索引 `<indexFile>.bak`；要改写的分片 `<shard>.bak`（保留最近 1 份）。
 * 行的原始文本（`parseIndex().lines[row.line-1]`）永远逐字保留；本模块只做追加，不改已有行。
 *
 * @module dsh-lit-library/indexdoc
 */
import { join } from 'node:path';
import * as indexFormat from './index-format.js';
import { normalizeConfig, projectPaths } from './project.js';
import {
  appendShardRows,
  appendTableRows,
  asLitError,
  byteLength,
  catalogEntryOf,
  listShards,
  readShards,
  renderCatalog,
  renderShard,
  shardDirOf,
  shardEntriesOf,
  shardFileName,
  shardNumber,
} from './shard.js';

const { COLUMNS, indexTemplate, parseIndex, splitRow } = indexFormat;

const LEGACY_SECTION_TITLE = '## 新入库（待整理）';
const LEGACY_SECTION_RE = /^##\s*新入库/;
const HEADER_LINE = `| ${COLUMNS.join(' | ')} |`;
const SEPARATOR_LINE = `|${COLUMNS.map(() => '---').join('|')}|`;

async function readTextOr(io, abs, fallback) {
  return (await io.exists(abs)) ? await io.readText(abs) : fallback;
}

function tableHeaderLine(line) {
  const cells = splitRow(line);
  return cells.length >= 3 && cells.includes('编号') && cells.includes('文件');
}

function countTableHeaders(text) {
  let count = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (tableHeaderLine(line)) count += 1;
  }
  return count;
}

/** 本地版旧库判定（契约 §2）：只有“新库模板单表”才算新库。 */
function localIsLegacyIndex(text) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === indexTemplate().trim()) return false;
  const parsed = parseIndex(raw);
  if (!parsed.header) return true;
  if (parsed.header.join('|') !== COLUMNS.join('|')) return true;
  if (countTableHeaders(raw) > 1) return true;
  if (/^##\s/m.test(raw)) return true;
  return false;
}

/** 优先用 lead 维护的 `index-format.isLegacyIndex`；还没合入时用本地版。 */
function isLegacyIndex(text) {
  return typeof indexFormat.isLegacyIndex === 'function'
    ? Boolean(indexFormat.isLegacyIndex(text))
    : localIsLegacyIndex(text);
}

/** 优先用 lead 维护的 `index-format.appendLegacyRows`；还没合入时用本地版。 */
function appendLegacy(text, rowTexts) {
  return typeof indexFormat.appendLegacyRows === 'function'
    ? indexFormat.appendLegacyRows(text, rowTexts)
    : appendLegacySection(text, rowTexts);
}

function ensureTrailingNewline(text) {
  const raw = typeof text === 'string' ? text : '';
  return raw.length > 0 && !raw.endsWith('\n') ? raw + '\n' : raw;
}

/**
 * 旧库追加：用文件末尾的 `## 新入库（待整理）` 区（没有就创建）。
 * 只追加/插入行，不重写任何已有表。
 */
function appendLegacySection(text, rowTexts) {
  const raw = typeof text === 'string' ? text : '';
  const rows = (rowTexts ?? []).map((row) => String(row).replace(/\r$/, ''));
  const lines = raw.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => LEGACY_SECTION_RE.test(String(line).trim()));

  if (sectionIndex < 0) {
    let base = raw;
    if (base.length > 0 && !base.endsWith('\n')) base += '\n';
    if (base.length > 0 && !base.endsWith('\n\n')) base += '\n';
    return ensureTrailingNewline(
      base + [LEGACY_SECTION_TITLE, '', HEADER_LINE, SEPARATOR_LINE, ...rows, ''].join('\n'),
    );
  }

  // 已有新区：找到区内表格，插在最后一行之后。
  let headerIndex = -1;
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    if (tableHeaderLine(lines[i])) {
      headerIndex = i;
      break;
    }
    if (/^##\s/.test(String(lines[i]).trim())) break;
  }
  if (headerIndex < 0) {
    let base = raw;
    if (base.length > 0 && !base.endsWith('\n')) base += '\n';
    return ensureTrailingNewline(base + ['', HEADER_LINE, SEPARATOR_LINE, ...rows, ''].join('\n'));
  }
  let lastTableLine = headerIndex;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const value = String(lines[i]).trim();
    if (value.startsWith('|')) {
      lastTableLine = i;
      continue;
    }
    if (value === '') continue;
    break;
  }
  lines.splice(lastTableLine + 1, 0, ...rows);
  return lines.join('\n');
}

/** single 模式：写前备份，新库追加到表尾，旧库写新区。 */
async function appendSingle({ io, paths, rowTexts }) {
  const exists = await io.exists(paths.indexFile);
  const text = exists ? await io.readText(paths.indexFile) : indexTemplate();
  const legacy = exists ? isLegacyIndex(text) : false;
  const nextText = legacy
    ? appendLegacy(text, rowTexts)
    : ensureTrailingNewline(appendTableRows(text, rowTexts));
  const backup = [];
  if (exists) {
    await io.copyFile(paths.indexFile, paths.indexFile + '.bak');
    backup.push(paths.indexFile + '.bak');
  }
  await io.writeText(paths.indexFile, nextText);
  return { mode: 'single', files: [paths.indexFile], backup, target: legacy ? 'legacy-section' : 'table' };
}

/** sharded 模式：填满最后一片 → 按上限开新片 → 重写目录。 */
async function appendSharded({ io, root, paths, meta, config, rowTexts }) {
  const limit = shardEntriesOf(meta, config);
  const shardDir = shardDirOf(paths);
  const existing = await listShards(io, shardDir);
  const rows = (rowTexts ?? []).map((row) => String(row).replace(/\r$/, ''));
  const writes = [];
  let cursor = 0;
  let nextNumber = existing.length > 0 ? existing[existing.length - 1].number + 1 : 1;

  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    const lastText = await io.readText(last.abs);
    const used = parseIndex(lastText).rows.length;
    const capacity = Math.max(limit - used, 0);
    if (capacity > 0) {
      const take = rows.slice(cursor, cursor + capacity);
      if (take.length > 0) {
        cursor += take.length;
        writes.push({ name: last.name, abs: last.abs, text: appendShardRows(lastText, take) });
      }
    }
  }

  while (cursor < rows.length) {
    const name = shardFileName(nextNumber);
    nextNumber += 1;
    const take = rows.slice(cursor, cursor + limit);
    cursor += take.length;
    writes.push({ name, abs: join(shardDir, name), text: renderShard(take) });
  }

  const backup = [];
  if (await io.exists(paths.indexFile)) {
    await io.copyFile(paths.indexFile, paths.indexFile + '.bak');
    backup.push(paths.indexFile + '.bak');
  }
  for (const write of writes) {
    if (await io.exists(write.abs)) {
      await io.copyFile(write.abs, write.abs + '.bak');
      backup.push(write.abs + '.bak');
    }
  }

  const texts = new Map(writes.map((write) => [write.name, write.text]));
  const names = new Map();
  for (const shard of existing) names.set(shard.name, shard.number);
  for (const write of writes) names.set(write.name, shardNumber(write.name));
  const ordered = [...names.entries()].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1]));
  const entries = [];
  for (const [name] of ordered) {
    const text = texts.has(name) ? texts.get(name) : await io.readText(join(shardDir, name));
    entries.push(catalogEntryOf({ name, text, root, shardDir }));
  }

  for (const write of writes) await io.writeText(write.abs, write.text);
  await io.writeText(paths.indexFile, renderCatalog(entries, limit));

  return {
    mode: 'sharded',
    files: [...writes.map((write) => write.abs), paths.indexFile],
    backup,
    target: 'shard',
  };
}

/**
 * 读索引（single + sharded 统一结构）。
 *
 * rows 保留 `parseIndex().rows` 的全部字段（含 1-based `line`：单表=主索引行号，分片=该分片内行号），
 * 另外每行加 `shard`：单表为 null，分片为分片文件名（如 `shard-001.md`）。
 */
export async function readIndex({ io, root, config, meta = {} }) {
  try {
    const c = normalizeConfig(config);
    const paths = projectPaths(root, c);
    const mode = meta && meta.indexMode === 'sharded' ? 'sharded' : 'single';
    const mainText = await readTextOr(io, paths.indexFile, '');
    const parsed = parseIndex(mainText);
    const result = {
      mode,
      rows: [],
      mainText,
      mainBytes: byteLength(mainText),
      mainLines: parsed.lineCount,
      shards: [],
    };

    if (mode === 'single') {
      result.rows = parsed.rows.map((row) => ({ ...row, shard: null }));
      return result;
    }

    const shardDir = shardDirOf(paths);
    const shards = await readShards({ io, shardDir });
    for (const shard of shards) {
      const rows = shard.parsed.rows.map((row) => ({ ...row, shard: shard.name }));
      result.rows.push(...rows);
      result.shards.push({
        name: shard.name,
        text: shard.text,
        rows,
        bytes: shard.bytes,
        lines: shard.lines,
      });
    }
    return result;
  } catch (error) {
    throw asLitError(error, '读索引失败');
  }
}

/**
 * 追加索引行（先备份再写）。
 *
 * @returns {{ mode:'single'|'sharded', files:string[], backup:string[], target:'table'|'legacy-section'|'shard' }}
 */
export async function appendIndexRows({ io, root, config, meta = {}, rowTexts }) {
  try {
    if (!Array.isArray(rowTexts)) throw new Error('lit: rowTexts 必须是字符串数组');
    const c = normalizeConfig(config);
    const paths = projectPaths(root, c);
    const mode = meta && meta.indexMode === 'sharded' ? 'sharded' : 'single';
    const rows = rowTexts.map((row) => String(row).replace(/\r$/, ''));
    if (rows.length === 0) {
      return { mode, files: [], backup: [], target: mode === 'sharded' ? 'shard' : 'table' };
    }
    if (mode === 'sharded') {
      return await appendSharded({ io, root, paths, meta, config: c, rowTexts: rows });
    }
    return await appendSingle({ io, paths, rowTexts: rows });
  } catch (error) {
    throw asLitError(error, '写索引失败');
  }
}
