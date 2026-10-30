/**
 * 单表 → 分片模式迁移（`lit_migrate`）。
 *
 * 铁律：行的原始文本逐字保留、顺序不变；任一步失败必须回到迁移前。
 *
 * 步骤（施工契约 §5.3）：
 *   备份原表 → 写全部分片 → 用 readIndex 回读校验（行数 + 每行 id/文件/原始行逐字相同）
 *   → 写分片目录 → 改 `.lit.json`（indexMode='sharded'，shardEntries）。
 *
 * 回滚：删已建分片 / 恢复被覆盖的分片 → 用 `.bak` 覆盖回主索引 → 恢复 `.lit.json` 原文。
 *
 * @module dsh-lit-library/migrate
 */
import { join } from 'node:path';
import { compileIdPattern } from './ids.js';
import { parseIndex } from './index-format.js';
import { readIndex } from './indexdoc.js';
import { normalizeConfig, projectPaths } from './project.js';
import {
  DEFAULT_SHARD_ENTRIES,
  asLitError,
  listShards,
  posixRelative,
  rangeOfIds,
  renderCatalog,
  renderShard,
  shardDirOf,
  shardDisplayName,
  shardEntriesOf,
  shardFileName,
} from './shard.js';

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

function normalizeShardEntries(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SHARD_ENTRIES;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('lit: shardEntries 必须是正整数（默认 ' + DEFAULT_SHARD_ENTRIES + '）');
  }
  return n;
}

/** 行原始文本：`parseIndex().lines` 是 1-based 行号；去掉尾部 \r，其余一个字节不改。 */
function rawLine(parsed, row) {
  return String(parsed.lines[row.line - 1] ?? '').replace(/\r$/, '');
}

async function rollback({ io, indexFile, backup, written, metaFile, metaTextBefore }) {
  const issues = [];
  for (const item of [...written].reverse()) {
    try {
      if (item.created) await io.unlink(item.abs);
      else await io.copyFile(item.bak, item.abs);
    } catch (error) {
      issues.push(messageOf(error));
    }
  }
  try {
    await io.copyFile(backup, indexFile);
  } catch (error) {
    issues.push(messageOf(error));
  }
  try {
    if (metaTextBefore === null) await io.unlink(metaFile);
    else await io.writeText(metaFile, metaTextBefore);
  } catch (error) {
    issues.push(messageOf(error));
  }
  return issues;
}

export async function migrateToSharded(options) {
  try {
    return await migrateInner(options);
  } catch (error) {
    throw asLitError(error);
  }
}

async function migrateInner({ io, root, config, meta = {}, idPattern, shardEntries }) {
  const c = normalizeConfig(config);
  const paths = projectPaths(root, c);
  if (meta && meta.indexMode === 'sharded') throw new Error('lit: 已经是分片模式');
  const limit = normalizeShardEntries(shardEntries ?? meta?.shardEntries ?? shardEntriesOf(meta, c));

  if (!(await io.exists(paths.indexFile))) {
    throw new Error('lit: 找不到索引文件：' + paths.indexFile);
  }
  const beforeText = await io.readText(paths.indexFile);
  const parsed = parseIndex(beforeText);
  const matcher = idPattern ? compileIdPattern(idPattern) : null;
  const selected = matcher ? parsed.rows.filter((row) => matcher.test(row.id)) : parsed.rows.slice();
  if (selected.length === 0) throw new Error('lit: 索引里没有可迁移的条目');
  const rowTexts = selected.map((row) => rawLine(parsed, row));

  // `.lit.json` 先预检（坏 JSON 必须在任何写盘前就报错）。
  const metaExists = await io.exists(paths.metaFile);
  const metaTextBefore = metaExists ? await io.readText(paths.metaFile) : null;
  let metaJson = null;
  if (metaTextBefore !== null) {
    try {
      metaJson = JSON.parse(metaTextBefore);
    } catch {
      throw new Error('lit: .lit.json 不是合法 JSON，先修好再迁移');
    }
    if (metaJson === null || typeof metaJson !== 'object' || Array.isArray(metaJson)) {
      throw new Error('lit: .lit.json 内容不是对象，先修好再迁移');
    }
  }

  // 1) 备份原表（保留最近 1 份）。
  const backup = paths.indexFile + '.bak';
  await io.copyFile(paths.indexFile, backup);

  const shardDir = shardDirOf(paths);
  const chunks = [];
  for (let i = 0; i < rowTexts.length; i += limit) chunks.push(rowTexts.slice(i, i + limit));
  const planned = chunks.map((rows, index) => ({
    name: shardFileName(index + 1),
    abs: join(shardDir, shardFileName(index + 1)),
    text: renderShard(rows),
  }));
  const written = [];

  try {
    // 2) 写全部分片。
    for (const shard of planned) {
      const existed = await io.exists(shard.abs);
      if (existed) await io.copyFile(shard.abs, shard.abs + '.bak');
      written.push({ abs: shard.abs, created: !existed, bak: shard.abs + '.bak' });
      await io.writeText(shard.abs, shard.text);
    }

    // 3) 回读校验：行数相同 + 每行 id/文件/原始行逐字相同。
    const after = await readIndex({ io, root, config: c, meta: { ...meta, indexMode: 'sharded', shardEntries: limit } });
    const afterRows = [];
    for (const shard of after.shards) {
      const parsedShard = parseIndex(shard.text);
      for (const row of parsedShard.rows) {
        afterRows.push({ id: row.id, file: row.file, text: rawLine(parsedShard, row) });
      }
    }
    let equal = afterRows.length === rowTexts.length;
    if (equal) {
      for (let i = 0; i < rowTexts.length; i += 1) {
        if (
          afterRows[i].id !== selected[i].id ||
          afterRows[i].file !== selected[i].file ||
          afterRows[i].text !== rowTexts[i]
        ) {
          equal = false;
          break;
        }
      }
    }
    if (!equal) throw new Error('lit: 迁移校验失败：分片回读的行与原文不一致');

    // 4) 写分片目录（主索引文件退化为目录，≤ 2048 B）。
    const entries = after.shards.map((shard) => {
      const parsedShard = parseIndex(shard.text);
      return {
        name: shardDisplayName(shard.name),
        rows: parsedShard.rows.length,
        range: rangeOfIds(parsedShard.rows.map((row) => row.id)),
        path: posixRelative(root, join(shardDir, shard.name)),
      };
    });
    await io.writeText(paths.indexFile, renderCatalog(entries, limit));

    // 5) 改 `.lit.json`（其余键原样保留）。
    const nextMeta = metaJson === null
      ? {
          schemaVersion: 1,
          createdAt: meta?.createdAt ?? null,
          idPattern: idPattern ?? meta?.idPattern ?? null,
          askBeforeImport: meta?.askBeforeImport !== false,
          pageOffset: Number(meta?.pageOffset ?? 0) || 0,
          indexMode: 'sharded',
          shardEntries: limit,
        }
      : { ...metaJson, indexMode: 'sharded', shardEntries: limit };
    await io.writeText(paths.metaFile, JSON.stringify(nextMeta, null, 2) + '\n');

    return {
      ok: true,
      backup,
      shards: after.shards.map((shard) => ({ name: shardDisplayName(shard.name), rows: shard.rows.length })),
      rows: rowTexts.length,
      verify: { before: selected.length, after: afterRows.length, equal: true },
    };
  } catch (error) {
    const issues = await rollback({ io, indexFile: paths.indexFile, backup, written, metaFile: paths.metaFile, metaTextBefore });
    const reason = asLitError(error).message.replace(/^lit: /, '');
    throw new Error(
      'lit: 迁移失败，已回滚：' + reason + (issues.length > 0 ? '（回滚告警：' + issues.join('；') + '）' : ''),
    );
  }
}
