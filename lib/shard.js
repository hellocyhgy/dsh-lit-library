/**
 * 分片索引：大库把总表拆成 `refs/index/shard-NNN.md`，主索引文件退化成目录。
 *
 * 为什么分片：单表超过 maxLines / maxBytes 后，每次会话读全表太贵；
 * 分片后每会话只读目录（≤ 2 KB），要全量时用 `lit_find` 或按需打开某一片。
 *
 * 约定（施工契约 §5.2）：
 * - 分片文件 = 7 列表头 + 分隔行 + 行；一个分片一个文件，`parseIndex` 能直接解析。
 * - 目录 = `# 文献总表（分片目录）` + 两行说明 + 4 列表格（分片 / 条目数 / 编号范围 / 路径）。
 * - 目录里的路径统一用 `/`，相对项目根。
 *
 * 本模块只通过调用方传入的 `io` 做 IO，不直接 import node:fs。
 *
 * @module dsh-lit-library/shard
 */
import { dirname, join, relative, sep } from 'node:path';
import { COLUMNS, parseIndex } from './index-format.js';

export const DEFAULT_SHARD_ENTRIES = 200;
export const SHARD_FILE_RE = /^shard-(\d+)\.md$/;
export const SHARD_HEADER_LINE = `| ${COLUMNS.join(' | ')} |`;
export const SHARD_SEP_LINE = `|${COLUMNS.map(() => '---').join('|')}|`;
export const CATALOG_TITLE = '# 文献总表（分片目录）';

/** UTF-8 字节数（索引预算按字节算，不按字符）。 */
export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/** 分片条数上限：`.lit.json` 的 shardEntries > 全局配置 > 默认 200。 */
export function shardEntriesOf(meta, config) {
  for (const value of [meta?.shardEntries, config?.shardEntries]) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_SHARD_ENTRIES;
}

/** 分片文件名：1 → `shard-001.md`。编号只增不回收。 */
export function shardFileName(number) {
  const n = Number.isInteger(Number(number)) && Number(number) > 0 ? Number(number) : 1;
  return `shard-${String(n).padStart(3, '0')}.md`;
}

/** 目录里显示的分片名：`shard-001.md` → `shard-001`。 */
export function shardDisplayName(fileName) {
  return String(fileName ?? '').replace(/\.md$/i, '');
}

/** 从文件名读分片号（不是分片文件名返回 NaN）。 */
export function shardNumber(fileName) {
  const match = SHARD_FILE_RE.exec(String(fileName ?? ''));
  return match ? Number(match[1]) : Number.NaN;
}

/** 分片目录：与主索引同级的 `index/`（主索引 `refs/参考资料总表.md` → `refs/index/`）。 */
export function shardDirOf(paths) {
  return join(dirname(paths.indexFile), 'index');
}

/** 相对项目根的 posix 路径（目录里显示用）。 */
export function posixRelative(root, abs) {
  return relative(root, abs).split(sep).join('/');
}

/** 列出分片文件，按分片号升序；目录不存在 → []。 */
export async function listShards(io, shardDir) {
  const entries = await io.list(shardDir);
  return entries
    .filter((entry) => entry.type === 'file' && SHARD_FILE_RE.test(entry.name))
    .map((entry) => ({ name: entry.name, number: shardNumber(entry.name), abs: join(shardDir, entry.name) }))
    .sort((a, b) => (a.number === b.number ? (a.name < b.name ? -1 : 1) : a.number - b.number));
}

/** 读全部分片：`[{ name, abs, text, parsed, bytes, lines }]`，按分片号升序。 */
export async function readShards({ io, shardDir }) {
  const files = await listShards(io, shardDir);
  const shards = [];
  for (const file of files) {
    const text = await io.readText(file.abs);
    const parsed = parseIndex(text);
    shards.push({
      name: file.name,
      abs: file.abs,
      text,
      parsed,
      bytes: byteLength(text),
      lines: parsed.lineCount,
    });
  }
  return shards;
}

/** 渲染一个分片文件：表头 + 分隔行 + 行。 */
export function renderShard(rowTexts) {
  const rows = (rowTexts ?? []).map((row) => String(row).replace(/\r$/, ''));
  return [SHARD_HEADER_LINE, SHARD_SEP_LINE, ...rows].join('\n') + '\n';
}

/**
 * 在 markdown 文件的最后一张表末尾插入行。
 *
 * 与 `index-format.js` 的 `appendRows` 口径一致，但额外处理“空表”：
 * 表里只有表头 + 分隔行时，行必须插在分隔行之后，否则表结构会坏。
 * （index-format.js 归 lead 维护，这里不越界改它。）
 */
export function appendTableRows(text, rowTexts) {
  const raw = typeof text === 'string' ? text : '';
  const rows = (rowTexts ?? []).map((row) => String(row).replace(/\r$/, ''));
  if (rows.length === 0) return raw;
  const lines = raw.split(/\r?\n/);
  let lastTableLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (String(lines[i]).trim().startsWith('|')) lastTableLine = i;
  }
  if (lastTableLine < 0) {
    const base = raw.length > 0 && !raw.endsWith('\n') ? raw + '\n' : raw;
    return base + rows.join('\n') + '\n';
  }
  lines.splice(lastTableLine + 1, 0, ...rows);
  return lines.join('\n');
}

/** 在分片文件的表末尾追加行；空文件按新分片渲染。 */
export function appendShardRows(text, rowTexts) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '' || !/^\|/m.test(raw)) return renderShard(rowTexts);
  const out = appendTableRows(raw, rowTexts);
  return out.endsWith('\n') ? out : out + '\n';
}

/** 编号范围：`A001–A200`；没有行写 `—`。 */
export function rangeOfIds(ids) {
  const list = (ids ?? []).map((id) => String(id ?? '')).filter((id) => id !== '');
  if (list.length === 0) return '—';
  return list.length === 1 ? list[0] : `${list[0]}–${list[list.length - 1]}`;
}

/** 分片 → 目录一行。`name` 传文件名或显示名都行。 */
export function catalogEntryOf({ name, text, root, shardDir }) {
  const parsed = parseIndex(text);
  const fileName = SHARD_FILE_RE.test(String(name)) ? String(name) : shardFileName(shardNumber(name));
  return {
    name: shardDisplayName(fileName),
    rows: parsed.rows.length,
    range: rangeOfIds(parsed.rows.map((row) => row.id)),
    path: posixRelative(root, join(shardDir, fileName)),
  };
}

/** 渲染分片目录（主索引文件在 sharded 模式下就是这份内容）。 */
export function renderCatalog(entries, shardEntries = DEFAULT_SHARD_ENTRIES) {
  const limit = Number.isInteger(Number(shardEntries)) && Number(shardEntries) > 0 ? Number(shardEntries) : DEFAULT_SHARD_ENTRIES;
  return [
    CATALOG_TITLE,
    '',
    '> 本项目是大库分片模式：本页只是目录，不是全量清单。看全量用 lit_find 或打开分片。',
    `> 每会话只读本页；分片按需读。每片上限 ${limit} 条。`,
    '',
    '| 分片 | 条目数 | 编号范围 | 路径 |',
    '|---|---|---|---|',
    ...(entries ?? []).map((entry) => `| ${entry.name} | ${entry.rows} | ${entry.range} | ${entry.path} |`),
    '',
  ].join('\n');
}

/** 把非 `lit:` 异常统一包成 `new Error('lit: ...')`（契约：异常一律 lit: 开头）。 */
export function asLitError(error, label = '') {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  if (message.startsWith('lit: ')) return error instanceof Error ? error : new Error(message);
  return new Error('lit: ' + (label ? label + '：' : '') + message);
}
