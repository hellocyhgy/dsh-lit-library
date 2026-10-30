/**
 * 项目解析：把“会话工作区”映射到一个文献库项目根。
 *
 * 两种形态：
 * - 模式 A（主路径）：项目根 = 工作区根，零参数。工作区里有 `.lit.json` 或索引即可。
 * - 模式 B（次要）：工作区 = 项目区，项目在 `<projectsRoot>/<项目名>/`，顶层有 index.md 总览。
 *
 * 解析顺序（写死，见 SPEC §3）：
 * 1. 显式 project（工具参数 > 配置）
 * 2. 工作区本身就是项目 → A
 * 3. 工作区是项目区、里面恰好一个项目 → 那个
 * 4. 工作区是项目区、多个项目 → 报错并列名字
 * 5. 都不是 → 报“这不是文献库”
 *
 * @module dsh-lit-library/project
 */
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { compileIdPattern, inferIdPattern, isIdLike, NEW_ID_PATTERN } from './ids.js';
import { parseIndex } from './index-format.js';

export const SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = {
  projectsRoot: 'lit-projects',
  projectsIndex: '',
  origDir: 'refs/外部资料',
  txtDir: 'work/外部资料_txt',
  notesDir: 'refs/notes',
  indexFile: 'refs/参考资料总表.md',
  shardDir: 'refs/index',
  tagsFile: 'refs/tags.md',
  maxLines: 200,
  maxBytes: 8192,
  maxEntries: 150,
  maxTxtBytes: 1048576,
  maxFileBytes: 52428800,
  maxPages: 1000,
  indexMode: 'single',
  shardEntries: 200,
  ocr: undefined,
};

/** 分片目录（文件名）的固定口径：目录 ≤ 2 KB，每片 ≤ shardEntries 条。 */
export const SHARD_DIR_MAX_BYTES = 2048;
export const SHARD_NAME_RE = /^shard-(\d{3})\.md$/;

export function shardFileName(n) {
  return 'shard-' + String(n).padStart(3, '0') + '.md';
}

/** 补齐默认值（配置只传一部分也能用）。 */
export function normalizeConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

/** 配置里的路径：相对的按项目根解析，绝对的照用。 */
export function resolveAt(root, value) {
  return isAbsolute(String(value)) ? normalize(String(value)) : resolve(root, String(value));
}

/** 一个项目的全部绝对路径。 */
export function projectPaths(root, config) {
  const c = normalizeConfig(config);
  const notesDir = resolveAt(root, c.notesDir);
  return {
    root,
    metaFile: join(root, '.lit.json'),
    indexFile: resolveAt(root, c.indexFile),
    notesDir,
    srcDir: resolveAt(root, c.origDir),
    txtDir: resolveAt(root, c.txtDir),
    tagsFile: resolveAt(root, c.tagsFile),
    shardDir: resolveAt(root, c.shardDir),
    templateFile: join(notesDir, '_模板.md'),
    lockFile: join(root, '.lit.lock'),
  };
}

export function projectNameOf(root) {
  return basename(root);
}

/** 项目区总览路径（模式 B）。 */
export function overviewPathFor(workspaceRoot, config) {
  const c = normalizeConfig(config);
  const projectsRoot = resolveAt(workspaceRoot, c.projectsRoot);
  return { projectsRoot, overviewFile: c.projectsIndex ? resolveAt(workspaceRoot, c.projectsIndex) : join(projectsRoot, 'index.md') };
}

/** 一个目录是不是项目根：有 `.lit.json`，或有索引文件。 */
export async function isProjectRoot({ io, root, config }) {
  const paths = projectPaths(root, config);
  if (await io.exists(join(root, '.lit.json'))) return true;
  return await io.exists(paths.indexFile);
}

/** 列出项目区下的项目候选（只看目录名）。 */
export async function listProjectNames({ io, projectsRoot }) {
  const entries = await io.list(projectsRoot);
  return entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name);
}

/** 校验项目名：不用路径分隔符、不用 Windows 保留名、不以点开头。 */
export function sanitizeProjectName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('lit: 项目名不能为空');
  const value = name.trim();
  if (value.length > 60) throw new Error('lit: 项目名太长（超过 60 字符）');
  if (/[\\/:*?"<>|]/.test(value)) throw new Error('lit: 项目名不能包含路径分隔符、冒号或 Windows 保留字符');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value)) throw new Error('lit: 项目名不能是 Windows 保留名：' + value);
  if (value.startsWith('.')) throw new Error('lit: 项目名不能以点开头');
  return value;
}

async function inferPatternFromIndex(paths, io) {
  let text = '';
  try {
    if (!(await io.exists(paths.indexFile))) return NEW_ID_PATTERN;
    text = await io.readText(paths.indexFile);
  } catch {
    return NEW_ID_PATTERN;
  }
  const ids = parseIndex(text).rows.map((row) => row.id).filter(isIdLike);
  return inferIdPattern(ids);
}

/**
 * 读项目元数据：`.lit.json` 缺失或坏了就从索引推断（不因坏文件而停下）。
 * 旧库只需手放一个 `.lit.json` 就能被识别。
 */
export async function readMeta({ io, root, config }) {
  const paths = projectPaths(root, config);
  const base = { schemaVersion: SCHEMA_VERSION, idPattern: null, askBeforeImport: true, pageOffset: 0, createdAt: null };
  let raw = null;
  try {
    if (await io.exists(paths.metaFile)) raw = await io.readText(paths.metaFile);
  } catch {
    raw = null;
  }
  if (raw === null) {
    return { meta: { ...base, idPattern: await inferPatternFromIndex(paths, io) }, inferred: true, issues: [] };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { meta: { ...base, idPattern: await inferPatternFromIndex(paths, io) }, inferred: true, issues: ['lit: .lit.json 不是合法 JSON，已按索引推断编号规则'] };
  }
  const version = Number(json.schemaVersion ?? SCHEMA_VERSION);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    throw new Error(`lit: .lit.json 的 schemaVersion=${json.schemaVersion} 比本插件支持的 ${SCHEMA_VERSION} 新，请先升级 dsh-lit-library`);
  }
  const meta = {
    ...base,
    ...json,
    schemaVersion: Number.isFinite(version) ? version : SCHEMA_VERSION,
    idPattern: typeof json.idPattern === 'string' && json.idPattern ? json.idPattern : await inferPatternFromIndex(paths, io),
    askBeforeImport: json.askBeforeImport !== false,
    pageOffset: Number(json.pageOffset ?? 0) || 0,
  };
  // 项目级可覆盖的数值键：不合法就丢弃，不能把字符串写进预算。
  for (const key of ['maxBytes', 'maxEntries', 'maxTxtBytes', 'maxFileBytes', 'maxPages', 'shardEntries']) {
    if (json[key] === undefined || json[key] === null) continue;
    const n = Number(json[key]);
    if (Number.isFinite(n) && n > 0) meta[key] = Math.floor(n);
    else delete meta[key];
  }
  meta.indexMode = json.indexMode === 'sharded' || json.indexMode === 'single' ? json.indexMode : undefined;
  if (json.ocr !== undefined && (json.ocr === null || typeof json.ocr !== 'object' || Array.isArray(json.ocr))) delete meta.ocr;
  compileIdPattern(meta.idPattern);
  return { meta, inferred: false, issues: [] };
}

/**
 * 有效配置：项目 `.lit.json` 覆盖全局配置。
 * 分片模式未显式给 maxEntries 时默认 10000（决策页 §12.2：large/万级）；
 * single 模式用 maxEntries=150。
 */
export function effectiveConfig(meta, config) {
  const c = normalizeConfig(config);
  const m = meta ?? {};
  const num = (key) =>
    typeof m[key] === 'number' && Number.isFinite(m[key]) && m[key] > 0 ? Math.floor(m[key]) : undefined;
  const indexMode = m.indexMode === 'sharded' || m.indexMode === 'single' ? m.indexMode : c.indexMode === 'sharded' ? 'sharded' : 'single';
  const shardEntries = num('shardEntries') ?? (Number(c.shardEntries) > 0 ? Math.floor(Number(c.shardEntries)) : 200);
  const maxEntries = num('maxEntries') ?? (indexMode === 'sharded' ? Math.max(Number(c.maxEntries) || 0, 10000) : Number(c.maxEntries) || 150);
  return {
    ...c,
    indexMode,
    shardEntries,
    maxEntries,
    maxBytes: num('maxBytes') ?? c.maxBytes,
    maxTxtBytes: num('maxTxtBytes') ?? c.maxTxtBytes,
    maxFileBytes: num('maxFileBytes') ?? c.maxFileBytes,
    maxPages: num('maxPages') ?? c.maxPages,
    pageOffset: Number.isFinite(Number(m.pageOffset)) ? Number(m.pageOffset) : Number(c.pageOffset ?? 0) || 0,
    ocr: m.ocr ?? c.ocr,
  };
}

/** 写项目元数据（原子写）。 */
export async function writeMeta({ io, root, config, meta }) {
  const paths = projectPaths(root, config);
  const out = { schemaVersion: SCHEMA_VERSION, ...meta };
  await io.writeText(paths.metaFile, JSON.stringify(out, null, 2) + '\n');
}

/**
 * 解析当前项目。
 *
 * @param {{ io: object, workspaceRoot: string, config?: object, project?: string }} options
 * @returns 项目根、名字、模式、元数据、全部路径
 */
export async function resolveProject({ io, workspaceRoot, config, project }) {
  const c = normalizeConfig(config);
  const ws = resolve(String(workspaceRoot));
  const { projectsRoot, overviewFile } = overviewPathFor(ws, c);
  const wsIsProject = await isProjectRoot({ io, root: ws, config: c });
  const fromConfig = typeof c.project === 'string' && c.project.trim() !== '' ? c.project.trim() : undefined;
  const wanted = typeof project === 'string' && project.trim() !== '' ? project.trim() : fromConfig;

  const finalize = async (root, mode) => {
    const info = await readMeta({ io, root, config: c });
    return {
      root,
      name: projectNameOf(root),
      mode,
      projectsRoot,
      overviewFile,
      paths: projectPaths(root, c),
      meta: info.meta,
      inferred: info.inferred,
      issues: info.issues,
      config: c,
    };
  };

  if (wanted !== undefined) {
    if (wsIsProject && projectNameOf(ws) === wanted) return finalize(ws, 'A');
    const underRoot = join(projectsRoot, wanted);
    if (await isProjectRoot({ io, root: underRoot, config: c })) return finalize(underRoot, 'B');
    if (wsIsProject) {
      throw new Error(`lit: 当前工作区是项目「${projectNameOf(ws)}」，不是「${wanted}」。要操作「${wanted}」请在它自己的工作区里打开，或确认它在 ${c.projectsRoot}/ 下。`);
    }
    const names = await listProjectNames({ io, projectsRoot });
    throw new Error(
      'lit: 找不到项目「' + wanted + '」。' + (names.length > 0 ? '可用项目：' + names.join('、') : '当前工作区里还没有项目，先在项目根跑 lit_init。'),
    );
  }

  if (wsIsProject) return finalize(ws, 'A');
  const names = await listProjectNames({ io, projectsRoot });
  if (names.length === 0) {
    throw new Error('lit: 这不是文献库（没找到 .lit.json 或索引文件）。先在当前工作区跑 lit_init。');
  }
  if (names.length === 1) return finalize(join(projectsRoot, names[0]), 'B');
  throw new Error('lit: 当前工作区里有多个项目（' + names.join('、') + '），请显式传 project。');
}

/** 相对路径显示（统一用 /，供总览/结果用）。 */
export function toPosixPath(value) {
  return String(value).split(sep).join('/');
}

/** b 是否在 a 目录内（含相等）。 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
