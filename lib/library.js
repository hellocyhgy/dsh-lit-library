/**
 * 文献库的动作层：初始化 / 导入 / 查标签 / 读改偏好 / 体检 / 迁移 / 补 OCR / 撤销。
 *
 * 这一层不碰 DSH context，也不直接 import node:fs：所有 IO 通过调用方传入的 io 对象，
 * 这样同一套逻辑能在插件里（ctx.fs）和测试里（全 node:fs）跑。
 *
 * 硬规则：
 * - `lit_import` 必须带 intent=explicit|confirmed，否则整拒不写盘（防模型“看到文件就入库”）。
 * - 先算账再写盘：篇数超 maxEntries、索引字节超 maxBytes、标签不在词表、不支持格式 / 非中英文 → 整拒或逐篇拒绝。
 * - 索引只追加不改已有行；编号续号、空号不回收；旧库只写「## 新入库（待整理）」区，原 A–D 表永不碰。
 * - 扫描件无 OCR → 登记挂起（文本列 `待 OCR`），不写 txt；配了 OCR 才解析。
 *
 * @module dsh-lit-library/library
 */
import { basename, extname, join, resolve } from 'node:path';
import { checkOverview, checkProject, limitMessage } from './check.js';
import { extractDocument, isSupportedExt, SUPPORTED_EXTS } from './extract.js';
import {
  appendLegacyRows,
  appendRows,
  indexTemplate,
  isLegacyIndex,
  LEGACY_SECTION_HEADER,
  overviewTemplate,
  parseIndex,
  renderRow,
  splitRow,
} from './index-format.js';
import { isId, isIdLike, nextId } from './ids.js';
import { appendIndexRows, readIndex } from './indexdoc.js';
import { migrateToSharded } from './migrate.js';
import {
  effectiveConfig,
  isInside,
  isProjectRoot,
  listProjectNames,
  normalizeConfig,
  overviewPathFor,
  projectNameOf,
  projectPaths,
  readMeta,
  resolveProject,
  sanitizeProjectName,
  SHARD_DIR_MAX_BYTES,
  toPosixPath,
  writeMeta,
} from './project.js';
import { hashFile, messageOf, readTextOr, todayISO, withLock } from './store.js';
import {
  aliasCollisions,
  canonical,
  expandTag,
  normalizeTagList,
  parseTagsFile,
  renderTagsFile,
  suggestTags,
  tagKey,
} from './tags.js';

export const MAX_TAGS_PER_ENTRY = 5;
const ACCEPTED_INTENTS = new Set(['explicit', 'confirmed']);
const TEXT_CELL_INDEX = 4;

/** 入库意图：缺失或非法直接拒绝，不防用户，防模型“看到文件就入库”。 */
export function assertIntent(intent) {
  if (typeof intent !== 'string' || !ACCEPTED_INTENTS.has(intent.trim())) {
    throw new Error(
      'lit: 缺少合法的入库意图（intent 必须是 explicit 或 confirmed）。默认不入库：用户没明确说要入库时，不要调用 lit_import。',
    );
  }
}

/** 新项目的 note 模板（六段；体检只查摘录与 txt 路径，段落齐不齐靠自觉）。 */
export function noteTemplate(config, { pageOffset = 0, ocr = false } = {}) {
  const c = normalizeConfig(config);
  const lines = [
    '# 模板：改名为 <编号>_<短名>.md',
    '',
    `- 原件：\`${c.origDir}/<文件名>\`（页/张数）`,
    `- 全文：\`${c.txtDir}/<同名>.txt\`（用 \`[pN]\` 定位）`,
    '- 作者 / 出处：',
    '- 性质：（期刊 / 学位论文 / 课堂讲义 / 教材）',
  ];
  if (pageOffset) lines.push(`- 页码：txt 里的 \`[pN]\` 加上 ${pageOffset} = 印刷页（\`paper pN\`）`);
  if (ocr) lines.push('- OCR 源：摘录前回原件核错字，txt 只用来定位');
  lines.push('', '## 内容要点', '', '## 关键参数', '', '## 原文摘录（可抽查）', '', '## 用法提醒', '', '## 注意', '');
  return lines.join('\n');
}

/** 读受控词表；文件不存在 → 空词表。 */
async function readVocab({ io, tagsFile }) {
  const text = await readTextOr(io, tagsFile, '');
  return { vocab: parseTagsFile(text), exists: text.trim().length > 0 || (await io.exists(tagsFile)) };
}

/** 档位名（给 Q34 文案用）。 */
export function tierName(c) {
  if (c.indexMode === 'sharded') return 'large（分片：目录 + 每片若干条）';
  if (Number(c.maxBytes) <= 8192) return 'small（单表，默认 8 KB）';
  if (Number(c.maxBytes) <= 32768) return 'medium（单表，32 KB）';
  return 'large（单表加大）';
}

/** 刷新项目区总览（仅模式 B）。条目数用分片感知的 readIndex 数。 */
async function refreshOverview({ io, projectsRoot, overviewFile, config }) {
  const names = await listProjectNames({ io, projectsRoot });
  const rows = [];
  for (const name of names) {
    const dir = join(projectsRoot, name);
    if (!(await isProjectRoot({ io, root: dir, config }))) continue;
    const info = await readMeta({ io, root: dir, config });
    const c = effectiveConfig(info.meta, config);
    let count = 0;
    try {
      const index = await readIndex({ io, root: dir, config: c, meta: info.meta });
      count = index.rows.length;
    } catch {
      count = 0;
    }
    rows.push({ name, rows: count, updated: todayISO(), path: toPosixPath(join(basename(projectsRoot), name)) });
  }
  await io.writeText(overviewFile, overviewTemplate(rows));
  return { overviewFile, projects: rows };
}

async function refreshOverviewFor({ io, workspaceRoot, config }) {
  const c = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const { projectsRoot, overviewFile } = overviewPathFor(ws, c);
  return await refreshOverview({ io, projectsRoot, overviewFile, config: c });
}

/** 空分片目录模板（indexMode=sharded 的项目刚建时用）。 */
export function shardDirectoryTemplate({ shardEntries = 200 } = {}) {
  return [
    '# 文献总表（分片目录）',
    '',
    '> 本项目是大库分片模式：本页只是目录，不是全量清单。看全量用 lit_find 或打开分片。',
    `> 每会话只读本页；分片按需读。每片上限 ${shardEntries} 条。`,
    '',
    '| 分片 | 条目数 | 编号范围 | 路径 |',
    '|---|---|---|---|',
    '',
  ].join('\n');
}

/**
 * `lit_init`：建目录 + `.lit.json` + 瘦模板索引 + `_模板.md` + `refs/tags.md`（幂等）。
 * 模式 B 同时刷新顶层 `index.md`。`register` 只把 `.lit.json` 写进已存在的库，其它一个字节不改。
 */
export async function litInit({ io, workspaceRoot, config, project, register, force = false, indexMode, maxBytes, maxEntries, shardEntries }) {
  const c = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const { projectsRoot } = overviewPathFor(ws, c);
  const created = [];
  const isRegister = register !== undefined;
  let root;
  let name;
  let mode;
  let existed = false;

  if (isRegister) {
    root = resolve(String(register));
    if (!(await io.exists(root))) throw new Error('lit: register 指向的路径不存在：' + String(register));
    if (!(await isProjectRoot({ io, root, config: c }))) throw new Error('lit: register 指向的不是文献库（找不到索引文件）：' + String(register));
    name = project !== undefined ? sanitizeProjectName(project) : projectNameOf(root);
    mode = root === ws ? 'A' : 'B';
    existed = true;
    const paths = projectPaths(root, c);
    if (!(await io.exists(paths.metaFile))) {
      const info = await readMeta({ io, root, config: c });
      await writeMeta({ io, root, config: c, meta: { idPattern: info.meta.idPattern, createdAt: todayISO(), askBeforeImport: info.meta.askBeforeImport !== false, pageOffset: info.meta.pageOffset ?? 0 } });
      created.push(paths.metaFile);
    }
    return { project: name, root, mode, idPattern: (await readMeta({ io, root, config: c })).meta.idPattern, created, existed, registered: true, note: 'register 只写 .lit.json，原件/索引/notes/txt 不改' };
  }

  const wsIsProject = await isProjectRoot({ io, root: ws, config: c });
  const wanted = project !== undefined ? sanitizeProjectName(project) : undefined;
  if (wanted === undefined) {
    if (wsIsProject) {
      root = ws;
      name = projectNameOf(ws);
      mode = 'A';
      existed = true;
    } else {
      const names = await listProjectNames({ io, projectsRoot });
      if (names.length > 0) {
        throw new Error('lit: 当前工作区里已有项目区（' + names.join('、') + '），请明确传 project 名字，避免猜错。');
      }
      root = ws;
      name = projectNameOf(ws);
      mode = 'A';
    }
  } else if (projectNameOf(ws) === wanted) {
    root = ws;
    name = wanted;
    mode = 'A';
    existed = wsIsProject;
  } else {
    root = join(projectsRoot, wanted);
    name = wanted;
    mode = 'B';
    existed = await isProjectRoot({ io, root, config: c });
  }

  const paths = projectPaths(root, c);
  for (const dir of [paths.srcDir, paths.notesDir, paths.txtDir]) {
    if (!(await io.exists(dir))) {
      await io.mkdirp(dir);
      created.push(dir);
    }
  }
  await ensureMetaFile({ io, root, config: c, force, created, overrides: { indexMode, maxBytes, maxEntries, shardEntries } });
  const info = await readMeta({ io, root, config: c });
  const effective = effectiveConfig(info.meta, c);

  if (!(await io.exists(paths.indexFile))) {
    const text = effective.indexMode === 'sharded' ? shardDirectoryTemplate({ shardEntries: effective.shardEntries }) : indexTemplate();
    await io.writeText(paths.indexFile, text);
    created.push(paths.indexFile);
  } else if (force) {
    const parsed = parseIndex(await io.readText(paths.indexFile));
    if (!parsed.rows.some((row) => isIdLike(row.id))) {
      const text = effective.indexMode === 'sharded' ? shardDirectoryTemplate({ shardEntries: effective.shardEntries }) : indexTemplate();
      await io.writeText(paths.indexFile, text);
      created.push(paths.indexFile);
    }
  }
  if (!(await io.exists(paths.tagsFile))) {
    await io.writeText(paths.tagsFile, renderTagsFile([]));
    created.push(paths.tagsFile);
  }
  if (!(await io.exists(paths.templateFile))) {
    await io.writeText(paths.templateFile, noteTemplate(c, { pageOffset: effective.pageOffset, ocr: Boolean(effective.ocr?.command) }));
    created.push(paths.templateFile);
  }
  if (mode === 'B') await refreshOverviewFor({ io, workspaceRoot: ws, config: c });
  return {
    project: name,
    root,
    mode,
    idPattern: info.meta.idPattern,
    indexMode: effective.indexMode,
    maxBytes: effective.maxBytes,
    maxEntries: effective.maxEntries,
    shardEntries: effective.shardEntries,
    pageOffset: effective.pageOffset,
    created,
    existed,
  };
}

async function ensureMetaFile({ io, root, config, force, created, overrides = {} }) {
  const paths = projectPaths(root, config);
  const exists = await io.exists(paths.metaFile);
  if (exists && !force) return;
  const inferred = await readMeta({ io, root, config });
  const meta = { idPattern: inferred.meta.idPattern, createdAt: inferred.meta.createdAt ?? todayISO(), askBeforeImport: inferred.meta.askBeforeImport !== false, pageOffset: inferred.meta.pageOffset ?? 0 };
  for (const key of ['indexMode', 'maxBytes', 'maxEntries', 'shardEntries']) {
    if (overrides[key] !== undefined) meta[key] = overrides[key];
  }
  await writeMeta({ io, root, config, meta });
  created.push(paths.metaFile);
}

function normalizeInputPath(workspaceRoot, raw) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('lit: paths 里有空路径');
  return resolve(String(workspaceRoot), text);
}

async function statSizeMap(io, dir) {
  const entries = (await io.list(dir)).filter((entry) => entry.type === 'file');
  const map = new Map();
  for (const entry of entries) {
    const info = await io.stat(join(dir, entry.name));
    map.set(entry.name, info?.size);
  }
  return map;
}

function legacySectionLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.findIndex((line) => line.trim() === LEGACY_SECTION_HEADER) + 1;
}

function inOwnScope({ legacy, sectionLine, row }) {
  return !legacy || (sectionLine > 0 && row.line > sectionLine);
}

async function backupFile(io, abs) {
  if (!(await io.exists(abs))) return;
  await io.copyFile(abs, abs + '.bak');
}

function replaceTextCell(line, value) {
  const cells = splitRow(line);
  if (cells.length <= TEXT_CELL_INDEX) return null;
  cells[TEXT_CELL_INDEX] = value;
  return '| ' + cells.join(' | ') + ' |';
}

/** 修改某一行的文本格（只改这一格），写前备份。 */
async function writeTextCell({ io, target, index, row, value }) {
  const abs = index.mode === 'sharded' ? join(target.paths.shardDir, row.shard) : target.paths.indexFile;
  const source = index.mode === 'sharded' ? index.shards.find((shard) => shard.name === row.shard)?.text : index.mainText;
  if (source === undefined) throw new Error('lit: 找不到该行所在文件（' + (row.shard ?? '主索引') + '）');
  const lines = String(source).split(/\r?\n/);
  const newLine = replaceTextCell(lines[row.line - 1], value);
  if (newLine === null) throw new Error('lit: 找不到 ' + row.id + ' 的文本列（表头列数不够）');
  lines[row.line - 1] = newLine;
  await backupFile(io, abs);
  await io.writeText(abs, lines.join('\n'));
  return abs;
}

/**
 * `lit_import`：去重 → 抽文本 → 先算账 → 写 txt / 原件 → 追加索引行 → 标签校验。
 * 任何“整拒”都发生在写盘前。
 */
export async function litImport({
  io,
  workspaceRoot,
  config,
  project,
  paths,
  id,
  copy = true,
  overwrite = false,
  tags,
  addTags = false,
  intent,
  dryRun = false,
}) {
  assertIntent(intent);
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const c = effectiveConfig(target.meta, c0);
  const p = target.paths;

  const tagList = normalizeTagList(tags);
  if (tagList.length > MAX_TAGS_PER_ENTRY) {
    throw new Error(`lit: 一篇最多 ${MAX_TAGS_PER_ENTRY} 个标签，这次给了 ${tagList.length} 个。`);
  }
  const { vocab } = await readVocab({ io, tagsFile: p.tagsFile });
  const collisions = aliasCollisions(vocab);
  if (collisions.length > 0) {
    throw new Error('lit: 标签词表有冲突，先修好再导入：' + collisions.join('；'));
  }
  const unknownTags = [];
  for (const raw of tagList) {
    if (!expandTag(vocab, raw)) unknownTags.push(raw);
  }
  if (unknownTags.length > 0 && !addTags) {
    const hints = unknownTags.map((tag) => `${tag}（相近：${suggestTags(vocab, tag).join('、') || '无'}）`).join('；');
    throw new Error('lit: 标签不在词表里：' + hints + '。确认要新增就传 addTags: true。');
  }

  const index = await readIndex({ io, root: target.root, config: c, meta: target.meta });
  const rows = index.rows;
  const idsSoFar = rows.map((row) => row.id).filter((value) => isId(value, target.meta.idPattern));
  const rowsNow = rows.length;

  const rawPaths = Array.isArray(paths) ? paths : paths === undefined ? [] : [paths];
  if (rawPaths.length === 0) throw new Error('lit: paths 不能为空');
  if (id !== undefined && rawPaths.length > 1) throw new Error('lit: 一次导入多篇时不能指定 id（编号自动续）。');
  if (id !== undefined && !isId(id, target.meta.idPattern)) {
    throw new Error('lit: 指定的 id「' + String(id) + '」不符合本项目编号规则 ' + target.meta.idPattern);
  }
  if (rowsNow + rawPaths.length > c.maxEntries) {
    throw new Error(limitMessage({ mode: c.indexMode, limit: c.maxEntries, current: rowsNow, tier: tierName(c) }));
  }

  const legacy = isLegacyIndex(index.mainText);
  const sectionLine = legacySectionLine(index.mainText);
  const skipped = [];
  const failed = [];
  const planned = [];
  const repairs = [];
  const reservedNames = new Set();
  const originalSizes = await statSizeMap(io, p.srcDir);

  for (const raw of rawPaths) {
    const abs = normalizeInputPath(ws, raw);
    const name = basename(abs);
    const ext = extname(name).toLowerCase();
    if (!isSupportedExt(ext)) {
      throw new Error('lit: 不支持的格式 ' + (ext || '(无后缀)') + '（支持 ' + SUPPORTED_EXTS.join(' ') + '）');
    }
    if (!(await io.exists(abs))) throw new Error('lit: 文件不存在：' + String(raw));
    if (!copy && !isInside(p.srcDir, abs)) {
      throw new Error('lit: copy=false 时原件必须已经在 ' + toPosixPath(p.srcDir) + ' 里：' + name);
    }
    const size = (await io.stat(abs))?.size;
    if (typeof size === 'number' && size > c.maxFileBytes) {
      failed.push({ file: name, error: `文件 ${size} B 超过单文件上限 ${c.maxFileBytes} B，未导入` });
      continue;
    }
    if (reservedNames.has(name)) {
      skipped.push({ file: name, reason: '本次要导入的文件里有重名' });
      continue;
    }
    const existingRow = rows.find((row) => row.file === name);
    if (existingRow !== undefined && !overwrite) {
      skipped.push({ file: name, reason: '同名已入库（要覆盖/补 OCR 传 overwrite: true）' });
      continue;
    }
    if (existingRow === undefined && originalSizes.has(name) && !overwrite) {
      skipped.push({ file: name, reason: '同名原件已存在（要覆盖传 overwrite: true）' });
      continue;
    }
    reservedNames.add(name);

    if (!overwrite && existingRow === undefined && typeof size === 'number' && size <= 5 * 1024 * 1024) {
      const srcHash = await hashFile(io, abs);
      let duplicateOf;
      for (const [otherName, otherSize] of originalSizes) {
        if (otherName === name || otherSize !== size) continue;
        const otherHash = await hashFile(io, join(p.srcDir, otherName));
        if (otherHash !== undefined && otherHash === srcHash) {
          duplicateOf = otherName;
          break;
        }
      }
      if (duplicateOf !== undefined) {
        const dupId = rows.find((row) => row.file === duplicateOf)?.id;
        skipped.push({ file: name, reason: '内容重复，已存在为 ' + (dupId ? dupId + '（' + duplicateOf + '）' : duplicateOf) });
        continue;
      }
    }

    let doc;
    try {
      doc = await extractDocument({ absPath: abs, ext, io, ocr: c.ocr, maxPages: c.maxPages });
    } catch (error) {
      failed.push({ file: name, error: messageOf(error) });
      continue;
    }
    if (doc.language === 'other' && !doc.scanned) {
      failed.push({ file: name, error: '这篇看起来不是中文或英文，本插件目前只支持中文和英文文献。' });
      continue;
    }

    if (existingRow !== undefined && overwrite) {
      // 重导覆盖：只补该行“文本”格 + 写 txt，编号/文件/笔记/标签一字不动。
      if (!inOwnScope({ legacy, sectionLine, row: existingRow })) {
        failed.push({
          file: name,
          error: '该行在旧库的原 A–D 表里，重导不会碰原表。要补这一行请用 lit_repair ids=["' + existingRow.id + '"] allowOriginalTable=true（只改「文本」一格）。',
        });
        continue;
      }
      if (doc.scanned) {
        failed.push({ file: name, error: '这篇是扫描件，OCR 没读出文本（' + (doc.ocr?.reason ?? '未配置 OCR') + '）。配好 OCR 后重试。' });
        continue;
      }
      const txtBytes = Buffer.byteLength(doc.text, 'utf8');
      if (txtBytes > c.maxTxtBytes) {
        failed.push({ file: name, error: `抽取文本 ${txtBytes} 字节，超过安全阀 maxTxtBytes=${c.maxTxtBytes}` });
        continue;
      }
      const stem = basename(name, extname(name));
      repairs.push({ abs, name, entryId: existingRow.id, text: doc.text, txtPath: join(p.txtDir, stem + '.txt'), txtBytes, copy: copy && !isInside(p.srcDir, abs), destAbs: join(p.srcDir, name), language: doc.language, ocrUsed: Boolean(doc.ocr?.used) });
      continue;
    }

    const txtBytes = doc.scanned ? 0 : Buffer.byteLength(doc.text, 'utf8');
    if (!doc.scanned && txtBytes > c.maxTxtBytes) {
      failed.push({ file: name, error: `抽取文本 ${txtBytes} 字节，超过安全阀 maxTxtBytes=${c.maxTxtBytes}` });
      continue;
    }
    const entryId = id !== undefined ? id : nextId(idsSoFar.concat(planned.map((item) => item.entryId)).concat(repairs.map((item) => item.entryId)), target.meta.idPattern);
    const stem = basename(name, extname(name));
    const txtPath = join(p.txtDir, stem + '.txt');
    const slideKind = doc.kind === 'pptx' || doc.kind === 'ppt';
    const scale = slideKind ? `${doc.pages} 张` : `${doc.pages} 页`;
    const pendingOcr = doc.scanned && !doc.ocr?.used;
    const rowText = renderRow({
      id: entryId,
      file: name,
      nature: '—',
      scale,
      text: pendingOcr ? '待 OCR' : '✔',
      note: '—',
      tags: tagList,
    });
    planned.push({
      abs,
      name,
      entryId,
      language: doc.language,
      pages: doc.pages,
      kind: doc.kind,
      scanned: pendingOcr,
      ocrUsed: Boolean(doc.ocr?.used),
      ocrReason: doc.ocr?.reason,
      text: doc.text,
      txtPath,
      txtBytes,
      scale,
      rowText,
      rowBytes: Buffer.byteLength(rowText, 'utf8') + 1,
      destAbs: join(p.srcDir, name),
      copy: copy && !isInside(p.srcDir, abs),
    });
  }

  // 单表：先算字节账（索引主体 + 本次新增行），超限整拒。
  const addedBytes = planned.reduce((sum, item) => sum + item.rowBytes, 0);
  if (c.indexMode === 'single' && planned.length > 0 && index.mainBytes + addedBytes > c.maxBytes) {
    throw new Error(limitMessage({ mode: 'single', limit: c.maxBytes, current: index.mainBytes, addBytes: addedBytes, tier: tierName(c) }));
  }

  const tagSuggestions = tagList.length === 0 ? vocab.slice(0, 3).map((entry) => entry.name) : [];
  const remaining = c.indexMode === 'sharded'
    ? { entries: c.maxEntries - (rowsNow + planned.length) }
    : { bytes: c.maxBytes - (index.mainBytes + addedBytes), entries: c.maxEntries - (rowsNow + planned.length) };

  if (dryRun) {
    return {
      project: target.name,
      projectRoot: target.root,
      mode: c.indexMode,
      dryRun: true,
      wouldAppend: planned.map((plan) => ({ id: plan.entryId, file: plan.name, pages: plan.pages, scale: plan.scale, text: plan.scanned ? '待 OCR' : '✔', txtBytes: plan.txtBytes, rowBytes: plan.rowBytes })),
      wouldRepair: repairs.map((plan) => ({ id: plan.entryId, file: plan.name, text: '✔' })),
      skipped,
      failed,
      remaining,
      tagSuggestions,
      pageOffsetHint: c.pageOffset ? `印刷页 = pN + ${c.pageOffset}` : null,
    };
  }

  const imported = [];
  const updated = [];
  const newTags = [];
  const ocrPending = [];

  if (planned.length > 0 || repairs.length > 0) {
    await withLock(io, p.lockFile, async () => {
      for (const plan of repairs) {
        if (plan.copy) await io.copyFile(plan.abs, plan.destAbs);
        await io.writeText(plan.txtPath, plan.text);
        const fresh = await readIndex({ io, root: target.root, config: c, meta: target.meta });
        const row = fresh.rows.find((item) => item.id === plan.entryId);
        if (row === undefined) throw new Error('lit: 重导时找不到行 ' + plan.entryId);
        await writeTextCell({ io, target, index: fresh, row, value: '✔' });
        updated.push({ id: plan.entryId, file: plan.name, text: '✔', txtPath: toPosixPath(plan.txtPath.slice(target.root.length + 1)), ocrUsed: plan.ocrUsed });
      }
      for (const plan of planned) {
        try {
          if (plan.copy) await io.copyFile(plan.abs, plan.destAbs);
          if (!plan.scanned) await io.writeText(plan.txtPath, plan.text);
          imported.push({
            id: plan.entryId,
            file: plan.name,
            pages: plan.pages,
            kind: plan.kind,
            scale: plan.scale,
            language: plan.language,
            scanned: plan.scanned,
            ocr: plan.ocrUsed,
            text: plan.scanned ? '待 OCR' : 'txt',
            txtPath: plan.scanned ? null : toPosixPath(plan.txtPath.slice(target.root.length + 1)),
            note: plan.scanned ? '扫描件：未配 OCR（' + (plan.ocrReason ?? '未配置') + '），先配好 OCR 再重导 overwrite=true' : plan.ocrUsed ? 'OCR 源：摘录前回原件核错字' : undefined,
          });
          if (plan.scanned) ocrPending.push({ id: plan.entryId, file: plan.name, reason: plan.ocrReason ?? '未配置 OCR' });
        } catch (error) {
          failed.push({ file: plan.name, error: messageOf(error) });
        }
      }
      if (addTags) {
        for (const raw of tagList) if (!expandTag(vocab, raw)) newTags.push(canonical(raw));
        if (newTags.length > 0) {
          await io.writeText(p.tagsFile, renderTagsFile([...vocab, ...newTags.map((name) => ({ name, aliases: [] }))]));
        }
      }
      if (imported.length > 0) {
        const rowsToWrite = imported.map((item) => renderRow({ id: item.id, file: item.file, nature: '—', scale: item.scale, text: item.text === '待 OCR' ? '待 OCR' : '✔', note: '—', tags: tagList }));
        await appendIndexRows({ io, root: target.root, config: c, meta: target.meta, rowTexts: rowsToWrite });
      }
    });
  }

  if (target.mode === 'B') await refreshOverviewFor({ io, workspaceRoot: ws, config: c0 });

  const budgetWarn = c.indexMode === 'single' && remaining.bytes !== undefined && remaining.bytes < c.maxBytes * 0.1
    ? limitMessage({ mode: 'single', limit: c.maxBytes, current: index.mainBytes + addedBytes, tier: tierName(c) })
    : null;

  return {
    project: target.name,
    projectRoot: target.root,
    mode: c.indexMode,
    indexFile: toPosixPath(p.indexFile.slice(target.root.length + 1)),
    pageOffset: c.pageOffset,
    pageOffsetHint: c.pageOffset ? `印刷页 = pN + ${c.pageOffset}` : null,
    imported,
    updated,
    skipped,
    failed,
    tagsAdded: newTags,
    tagSuggestions,
    ocrPending,
    ocrConfigured: Boolean(c.ocr?.command),
    remaining,
    budgetWarn,
  };
}

/** `lit_find`：同标签内 OR（规范名 + 别名），多标签默认 AND。只读。 */
export async function litFind({ io, workspaceRoot, config, project, tags, mode = 'all' }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const c = effectiveConfig(target.meta, c0);
  const matchMode = mode === 'any' ? 'any' : 'all';
  const { vocab } = await readVocab({ io, tagsFile: target.paths.tagsFile });
  const queries = (Array.isArray(tags) ? tags : [tags]).map((value) => String(value ?? '').trim()).filter((value) => value !== '');
  if (queries.length === 0) throw new Error('lit: tags 不能为空');
  const expanded = queries.map((query) => {
    const hit = expandTag(vocab, query);
    if (hit === undefined) {
      const hints = suggestTags(vocab, query).join('、') || '无';
      throw new Error('lit: 标签「' + query + '」不在词表里。相近的现有标签：' + hints);
    }
    return { query, name: hit.name, terms: hit.terms, keys: hit.terms.map(tagKey) };
  });
  const index = await readIndex({ io, root: target.root, config: c, meta: target.meta });
  const hits = [];
  for (const row of index.rows) {
    if (!isId(row.id, target.meta.idPattern)) continue;
    const rowKeys = row.tags.map(tagKey);
    const matched = expanded.map((item) => item.keys.some((key) => rowKeys.includes(key)));
    const ok = matchMode === 'any' ? matched.some(Boolean) : matched.every(Boolean);
    if (ok) {
      hits.push({ id: row.id, file: row.file, scale: row.scale, text: row.text, note: row.note, tags: row.tags, shard: row.shard ?? null });
    }
  }
  return {
    project: target.name,
    mode: c.indexMode,
    matchMode,
    queries: expanded.map((item) => ({ query: item.query, expanded: item.terms })),
    count: hits.length,
    hits,
  };
}

/** `lit_prefs`：读/改项目偏好（askBeforeImport 落盘）。 */
export async function litPrefs({ io, workspaceRoot, config, project, askBeforeImport }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  let meta = target.meta;
  if (askBeforeImport !== undefined) {
    if (typeof askBeforeImport !== 'boolean') throw new Error('lit: askBeforeImport 必须是 true/false');
    meta = { ...meta, askBeforeImport };
    await writeMeta({ io, root: target.root, config: c0, meta });
  }
  const c = effectiveConfig(meta, c0);
  return {
    project: target.name,
    projectRoot: target.root,
    mode: target.mode,
    askBeforeImport: meta.askBeforeImport !== false,
    idPattern: meta.idPattern,
    pageOffset: c.pageOffset,
    schemaVersion: meta.schemaVersion,
    indexMode: c.indexMode,
    shardEntries: c.shardEntries,
    maxBytes: c.maxBytes,
    maxEntries: c.maxEntries,
    maxTxtBytes: c.maxTxtBytes,
    ocrConfigured: Boolean(c.ocr?.command),
    tier: tierName(c),
    indexFile: toPosixPath(target.paths.indexFile.slice(target.root.length + 1)),
    srcDir: toPosixPath(target.paths.srcDir.slice(target.root.length + 1)),
    txtDir: toPosixPath(target.paths.txtDir.slice(target.root.length + 1)),
    notesDir: toPosixPath(target.paths.notesDir.slice(target.root.length + 1)),
    tagsFile: toPosixPath(target.paths.tagsFile.slice(target.root.length + 1)),
    issues: target.issues,
  };
}

/** `lit_check`：体检一个项目，或遍历所有项目 + 总览对账（模式 B）。 */
export async function litCheck({ io, workspaceRoot, config, project, all = false }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const targets = [];
  if (project !== undefined) {
    targets.push(await resolveProject({ io, workspaceRoot: ws, config: c0, project }));
  } else if (await isProjectRoot({ io, root: ws, config: c0 })) {
    targets.push(await resolveProject({ io, workspaceRoot: ws, config: c0 }));
  } else {
    const { projectsRoot } = overviewPathFor(ws, c0);
    const names = await listProjectNames({ io, projectsRoot });
    for (const name of names) {
      const dir = join(projectsRoot, name);
      if (await isProjectRoot({ io, root: dir, config: c0 })) {
        targets.push(await resolveProject({ io, workspaceRoot: ws, config: c0, project: name }));
      }
    }
    if (targets.length === 0) {
      throw new Error('lit: 这不是文献库（没找到 .lit.json 或索引文件）。下一步：在当前工作区跑 lit_init 建库，或用 lit_init register=<旧库根> 接管已有库。');
    }
    if (!all && targets.length > 1) {
      throw new Error('lit: 当前工作区里有多个项目（' + targets.map((t) => t.name).join('、') + '），请显式传 project，或传 all: true。');
    }
  }

  const projects = [];
  for (const target of targets) {
    const c = effectiveConfig(target.meta, c0);
    const result = await checkProject({
      io,
      root: target.root,
      idPattern: target.meta.idPattern,
      paths: target.paths,
      limits: {
        maxLines: c.maxLines,
        maxBytes: c.maxBytes,
        maxEntries: c.maxEntries,
        maxTxtBytes: c.maxTxtBytes,
        pageOffset: c.pageOffset,
        indexMode: c.indexMode,
        shardEntries: c.shardEntries,
      },
    });
    projects.push({ name: target.name, root: target.root, mode: target.mode, idPattern: target.meta.idPattern, ...result });
  }

  let overviewFails = [];
  const isMulti = targets.some((target) => target.mode === 'B');
  if (all && isMulti) {
    const { projectsRoot, overviewFile } = overviewPathFor(ws, c0);
    const summary = projects.map((item) => ({ name: item.name, rows: item.rows }));
    const overview = await checkOverview({ io, projectsRoot, overviewFile, projects: summary });
    overviewFails = overview.overviewFails;
  }
  const total = projects.reduce(
    (acc, item) => ({ fails: acc.fails + item.fails.length, warns: acc.warns + item.warns.length }),
    { fails: 0, warns: 0 },
  );
  total.fails += overviewFails.length;
  return { projects, overviewFails, total };
}

/** `lit_migrate`：single → sharded（逐行保留 + 备份 + 校验 + 失败回滚）。 */
export async function litMigrate({ io, workspaceRoot, config, project, shardEntries }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const c = effectiveConfig(target.meta, c0);
  const result = await migrateToSharded({
    io,
    root: target.root,
    config: c,
    meta: target.meta,
    idPattern: target.meta.idPattern,
    shardEntries: Number(shardEntries) > 0 ? Number(shardEntries) : c.shardEntries,
  });
  if (target.mode === 'B') await refreshOverviewFor({ io, workspaceRoot: ws, config: c0 });
  return {
    ...result,
    project: target.name,
    message: '已切到分片模式：总表变成目录（≤2 KB），每会话只读目录；全量用 lit_find 或打开 refs/index/shard-*.md。原表已备份为 .bak。',
  };
}

/** `lit_repair`：对点名编号重跑 OCR/抽取，只改该行「文本」一格（加 txt）。 */
export async function litRepair({ io, workspaceRoot, config, project, ids, allowOriginalTable = false, dryRun = false }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const c = effectiveConfig(target.meta, c0);
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('lit: lit_repair 需要 ids=["A001", …] 点名要补的编号');
  if (!c.ocr?.command) throw new Error('lit: 没配 OCR（配置或 .lit.json 的 ocr.command 为空）。先把 OCR 装好/配好，再跑 lit_repair。');
  const index = await readIndex({ io, root: target.root, config: c, meta: target.meta });
  const legacy = isLegacyIndex(index.mainText);
  const sectionLine = legacySectionLine(index.mainText);
  const p = target.paths;
  const repaired = [];
  const failed = [];
  for (const entryId of ids) {
    const row = index.rows.find((item) => item.id === entryId);
    if (row === undefined) {
      failed.push({ id: entryId, error: '总表里没有这个编号' });
      continue;
    }
    if (!inOwnScope({ legacy, sectionLine, row }) && !allowOriginalTable) {
      failed.push({ id: entryId, error: '该行在旧库原 A–D 表里，默认不碰；确认只改「文本」一格请传 allowOriginalTable: true' });
      continue;
    }
    const srcAbs = join(p.srcDir, row.file);
    if (!(await io.exists(srcAbs))) {
      failed.push({ id: entryId, error: '原件不在 refs/外部资料/：' + row.file });
      continue;
    }
    let doc;
    try {
      doc = await extractDocument({ absPath: srcAbs, ext: extname(row.file), io, ocr: c.ocr, maxPages: c.maxPages });
    } catch (error) {
      failed.push({ id: entryId, error: messageOf(error) });
      continue;
    }
    if (doc.scanned) {
      failed.push({ id: entryId, error: 'OCR 后仍没有文本层：' + (doc.ocr?.reason ?? '未配置 OCR') });
      continue;
    }
    if (doc.language === 'other') {
      failed.push({ id: entryId, error: 'OCR/抽取结果不是中文或英文，拒写' });
      continue;
    }
    const txtBytes = Buffer.byteLength(doc.text, 'utf8');
    if (txtBytes > c.maxTxtBytes) {
      failed.push({ id: entryId, error: `抽取文本 ${txtBytes} 字节超过 maxTxtBytes=${c.maxTxtBytes}` });
      continue;
    }
    const stem = basename(row.file, extname(row.file));
    const txtPath = join(p.txtDir, stem + '.txt');
    if (dryRun) {
      repaired.push({ id: entryId, dryRun: true, file: row.file, txtBytes, scope: allowOriginalTable && !inOwnScope({ legacy, sectionLine, row }) ? 'original' : 'own' });
      continue;
    }
    await withLock(io, p.lockFile, async () => {
      await io.writeText(txtPath, doc.text);
      const fresh = await readIndex({ io, root: target.root, config: c, meta: target.meta });
      const freshRow = fresh.rows.find((item) => item.id === entryId);
      if (freshRow === undefined) throw new Error('lit: 补写时找不到行 ' + entryId);
      await writeTextCell({ io, target, index: fresh, row: freshRow, value: '✔' });
    });
    repaired.push({ id: entryId, file: row.file, before: row.text, after: '✔', txtPath: toPosixPath(txtPath.slice(target.root.length + 1)), ocrUsed: Boolean(doc.ocr?.used) });
  }
  return {
    project: target.name,
    projectRoot: target.root,
    ids,
    repaired,
    failed,
    allowOriginalTable,
    message: repaired.length > 0 ? '只改了这些行的「文本」一格并写 txt；编号/文件/笔记/标签未动。' : undefined,
  };
}

/** `lit_undo`：用 .bak 回滚最近一次索引写入（主索引 + 分片）。 */
export async function litUndo({ io, workspaceRoot, config, project }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const p = target.paths;
  const targets = [];
  const mainBak = p.indexFile + '.bak';
  if (await io.exists(mainBak)) targets.push({ bak: mainBak, at: p.indexFile });
  for (const entry of (await io.list(p.shardDir)).filter((item) => item.type === 'file' && item.name.endsWith('.bak') && SHARD_NAME_RE.test(item.name.slice(0, -4)))) {
    const original = join(p.shardDir, entry.name.slice(0, -4));
    targets.push({ bak: join(p.shardDir, entry.name), at: original });
  }
  if (targets.length === 0) throw new Error('lit: 没有可回滚的 .bak（最近没有索引写入，或已经撤销过）');
  for (const item of targets) {
    await io.copyFile(item.bak, item.at);
    await io.unlink(item.bak);
  }
  return {
    project: target.name,
    projectRoot: target.root,
    restored: targets.map((item) => toPosixPath(item.at.slice(target.root.length + 1))),
    message: '已把索引（及分片）恢复成最近一次写入前的版本。',
  };
}

/** 供调试/测试：当前索引快照（不写盘）。 */
export async function litSnapshot({ io, workspaceRoot, config, project }) {
  const c0 = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const target = await resolveProject({ io, workspaceRoot: ws, config: c0, project });
  const c = effectiveConfig(target.meta, c0);
  const index = await readIndex({ io, root: target.root, config: c, meta: target.meta });
  return { project: target.name, mode: index.mode, rows: index.rows, mainBytes: index.mainBytes, shards: (index.shards ?? []).map((s) => ({ name: s.name, rows: s.rows.length, bytes: s.bytes })) };
}
