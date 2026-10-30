/**
 * dsh-lit-library —— 文献库插件入口（宿主半边）。
 *
 * 导出形式与 DSH 全部参考包一致：`{ name, inject, apply }`。
 * 注册八个工具：lit_init / lit_import / lit_find / lit_prefs / lit_check /
 * lit_migrate / lit_repair / lit_undo。
 *
 * 三层分工（改代码前先看清自己在哪一层）：
 *
 * 1. `library.js`（+ project/store/tags/index-format/check）—— 纯逻辑，只通过调用方传入的
 *    `io` 对象做 IO。所以同一套逻辑既能在插件里跑，也能在 `.probe` 里用 node:fs 跑。
 * 2. **本文件** —— 把宿主 `ctx` 变成 `io`：
 *    · 读（readText/readBytes）与写（writeText）走 `ctx.fs`（带沙箱 policy）；
 *    · 其余（exists/stat/list/mkdirp/unlink/copyFile/tryCreate/writeBytes）走 node:fs，
 *      因为实测这个 DSH 版本的 `ctx.fs` 没有 list；
 *    · **写操作**一律先过工作区围栏（`ctx.fs.contains`），越界抛 `lit: 越过工作区`。
 * 3. `@deepseek-ai/dsh-tools` 的 `defineTool` —— 宿主有就交给它校验/冻结；本地测试环境
 *    没有这个包，退化成恒等函数（只标记类型，不做运行时校验）。见文件末尾的兜底。
 *
 * 错误约定：execute 里任何异常都统一成 `new Error('lit: ...')` 抛出（模型能直接读到人话），
 * 成功一律返回 `JSON.stringify(结果)`（`output: { schema: { type: 'string' } }`）。
 *
 * @module dsh-lit-library/index
 */
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import * as defaultLibrary from './library.js';

/**
 * 本地测试环境没有 `@deepseek-ai/dsh-tools`（它是宿主注入的 peer 包）。
 * 契约要求：拿不到就退化成 `(spec) => spec`，否则 import 直接崩、整个插件装不上。
 */
let defineTool = (spec) => spec;
try {
  const host = await import('@deepseek-ai/dsh-tools');
  if (typeof host?.defineTool === 'function') defineTool = host.defineTool;
} catch {
  /* 本地测试无宿主包：恒等版足够（工具规格原样注册）。 */
}

export const name = 'lit-library';

/** 宿主能力：工具注册、文件、会话、沙箱策略（顺序与 DSH 参考包一致）。 */
export const inject = ['tools', 'fs', 'sessions', 'sandboxPolicy'];

/** 八个工具的名字（测试与文档共用，避免改名漏改）。 */
export const TOOL_NAMES = [
  'lit_init',
  'lit_import',
  'lit_find',
  'lit_prefs',
  'lit_check',
  'lit_migrate',
  'lit_repair',
  'lit_undo',
];

/** 工具名 → library 里的方法名（工具缺实现时的报错要指得准）。 */
const METHOD_TOOL = {
  litInit: 'lit_init',
  litImport: 'lit_import',
  litFind: 'lit_find',
  litPrefs: 'lit_prefs',
  litCheck: 'lit_check',
  litMigrate: 'lit_migrate',
  litRepair: 'lit_repair',
  litUndo: 'lit_undo',
};

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function messageOf(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return String(error);
}

/** 错误统一加 `lit:` 前缀；已经是 lit: 的原样抛（保留更具体的文案）。 */
function toLitError(error) {
  const message = messageOf(error);
  if (message.startsWith('lit:')) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error('lit: ' + message);
}

/** 只取非空字符串参数（空串 = 没传，避免把空项目名/空路径当真值）。 */
function stringArg(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** 数组参数：收数组或单个值（模型常把一篇写成字符串）。 */
function arrayArg(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

/** `output.render`：schema 是 string，所以把值当文本回；不是字符串才序列化。 */
function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

// ---------------------------------------------------------------------------
// 宿主 ctx → 会话 / 沙箱 policy / 工作区根
// ---------------------------------------------------------------------------

function sessionFor(ctx, exec) {
  try {
    const id = exec?.agent?.id;
    if (typeof id !== 'string' || id.length === 0) return undefined;
    const session = ctx.sessions.get(id);
    return session === undefined || session === null ? undefined : session;
  } catch {
    return undefined;
  }
}

function policyFor(ctx, session) {
  try {
    return session === undefined ? ctx.sandboxPolicy.resolve() : ctx.sandboxPolicy.resolve({ session });
  } catch {
    return undefined;
  }
}

/**
 * 工作区根：优先取沙箱策略的 workspaceRoot（写盘围栏与它一致），
 * 其次会话的不可变 cwd，最后 process.cwd()。
 */
function workspaceRootFor(session, policy) {
  if (policy !== undefined && policy !== null && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
    return policy.workspaceRoot;
  }
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  return process.cwd();
}

// ---------------------------------------------------------------------------
// ctx.fs 的 target → 绝对路径字符串
// ---------------------------------------------------------------------------

/**
 * 宿主 `ctx.fs.resolve` 可能回字符串，也可能回一个 target 对象（drawai 里用
 * `ctx.fs.processPath(target)` 取绝对路径）。node:fs 那一侧只认字符串，所以这里统一。
 */
function hostPathOf(ctx, target) {
  if (typeof target === 'string') return target;
  if (target !== null && typeof target === 'object') {
    try {
      const processed = ctx.fs.processPath?.(target);
      if (typeof processed === 'string' && processed.length > 0) return processed;
    } catch {
      /* 没有 processPath 就看字段 */
    }
    for (const key of ['absolutePath', 'absPath', 'path']) {
      if (typeof target[key] === 'string' && target[key].length > 0) return target[key];
    }
  }
  return String(target);
}

/**
 * `ctx.fs` 的方法要的是 resolve() 返回的 target（对象或字符串），不是路径字符串。
 * 实测：把 processPath 得到的字符串再塞回 ctx.fs.readText/writeText 会报
 * `The "path" argument must be of type string ... Received undefined`。
 */
async function fsTarget(ctx, abs) {
  const target = await ctx.fs.resolve(String(abs));
  return target === undefined || target === null ? String(abs) : target;
}

/** 纯 node:path 的围栏判断（宿主没 contains 时的兜底）。 */
function containsByPath(root, child) {
  const rel = relative(resolve(String(root)), resolve(String(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 写围栏：`child` 必须在工作区根内。宿主有 contains 就以它为准。 */
async function withinWorkspace(ctx, rootText, absText) {
  const root = resolve(String(rootText));
  const target = resolve(String(absText));
  const byPath = containsByPath(root, target);
  if (typeof ctx.fs?.contains !== 'function') return byPath;
  try {
    const verdict = await ctx.fs.contains(await fsTarget(ctx, root), await fsTarget(ctx, target));
    return typeof verdict === 'boolean' ? verdict : byPath;
  } catch {
    return byPath;
  }
}

// ---------------------------------------------------------------------------
// io 适配器（契约：所有方法 async，接口与 .probe/v2/lib/io-node.mjs 一致）
// ---------------------------------------------------------------------------

/**
 * 建一个 io：读/写正文走 `ctx.fs`，其余走 node:fs，**所有写操作先过工作区围栏**。
 *
 * @param ctx 宿主上下文（需要 ctx.fs）
 * @param {{ workspaceRoot?: string, policy?: object }} options
 */
export function createIo(ctx, { workspaceRoot = process.cwd(), policy } = {}) {
  const root = resolve(String(workspaceRoot));

  async function fenced(abs) {
    const absolute = resolve(String(abs));
    if (!(await withinWorkspace(ctx, root, absolute))) {
      throw new Error('lit: 越过工作区（只允许写工作区 ' + root + ' 里的文件）：' + absolute);
    }
    return absolute;
  }

  async function writeHost(abs, text) {
    const target = await fsTarget(ctx, abs);
    if (policy === undefined) await ctx.fs.writeText(target, text);
    else await ctx.fs.writeText(target, text, undefined, undefined, policy);
  }

  return {
    async readText(abs) {
      return await ctx.fs.readText(await fsTarget(ctx, abs));
    },

    async readBytes(abs) {
      return await ctx.fs.readBytes(await fsTarget(ctx, abs));
    },

    async writeText(abs, text) {
      await fenced(abs);
      await writeHost(abs, text);
    },

    async exists(abs) {
      try {
        await stat(String(abs));
        return true;
      } catch {
        return false;
      }
    },

    async stat(abs) {
      try {
        const info = await stat(String(abs));
        const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
        return { type, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    },

    async list(abs) {
      try {
        const entries = await readdir(String(abs), { withFileTypes: true });
        return entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        return [];
      }
    },

    async tryCreate(abs, text) {
      const target = await fenced(abs);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    },

    async writeBytes(abs, bytes) {
      const target = await fenced(abs);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },

    async mkdirp(abs) {
      const target = await fenced(abs);
      await mkdir(target, { recursive: true });
    },

    async unlink(abs) {
      const target = await fenced(abs);
      try {
        await unlink(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },

    async copyFile(fromAbs, toAbs) {
      const target = await fenced(toAbs);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(String(fromAbs), target);
    },
  };
}

// ---------------------------------------------------------------------------
// 工具规格
// ---------------------------------------------------------------------------

/** 取 library 实现；没有就抛清楚的 lit: 错误（集成期不炸模块加载）。 */
function implOf(library, method) {
  const fn = library?.[method];
  if (typeof fn !== 'function') {
    const tool = METHOD_TOOL[method] ?? method;
    throw new Error(
      'lit: 这个构建还没有实现 ' + tool + '（lib/library.js 里没有 ' + method + '）。等集成完成后再用这个工具。',
    );
  }
  return fn;
}

function toolSpec({ ctx, library, config, name: toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const session = sessionFor(ctx, exec);
      const policy = policyFor(ctx, session);
      const workspaceRoot = workspaceRootFor(session, policy);
      const io = createIo(ctx, { workspaceRoot, policy });
      try {
        const result = await run({ io, workspaceRoot, config: config ?? {}, args: input });
        return JSON.stringify(result);
      } catch (error) {
        throw toLitError(error);
      }
    },
  };
}

/**
 * 建 8 个工具规格。抽成工厂是为了两件事：
 * 1. `apply(ctx)` 走默认 library；测试里可以注入桩，单独验某个工具的接线；
 * 2. 免得八个 execute 各抄一遍「会话 → policy → workspaceRoot → io → try/catch」。
 *
 * @param {{ ctx: object, config?: object, library?: object }} options
 * @returns 工具规格数组（已 defineTool 包装前的普通对象）
 */
export function createTools({ ctx, config, library = defaultLibrary } = {}) {
  if (ctx === undefined || ctx === null) throw new Error('lit: createTools 需要宿主 ctx');
  const build = (spec) => toolSpec({ ctx, library, config, ...spec });

  return [
    // ------------------------------------------------------------------ init
    build({
      name: 'lit_init',
      description:
        '初始化（或原地接管）一个文献库项目的骨架：建 refs/外部资料、refs/notes、work/外部资料_txt、' +
        '.lit.json、瘦模板索引、refs/tags.md、_模板.md。\n' +
        '什么时候用：用户明确要“建文献库 / 把某个已有目录接管成库”时。这是**骨架**：不写任何笔记内容' +
        '（note 由你按六段建，内容人核）。\n' +
        '幂等：重复调用只补缺的文件，不覆盖已有笔记和索引行；force 只用于修复可重建的骨架文件。\n' +
        '多项目工作区（lit-projects/<项目>/）要传 project 名字；register 传一个**已存在的库**路径就是原地接管' +
        '（只补元数据，不迁移、不重建内容）。写盘只允许在工作区内。',
      parameters: {
        project: {
          type: 'string',
          description:
            '项目名。不传：工作区本身就是库（模式 A）就用工作区；工作区是项目区且有多个项目时会报错并列名字。',
        },
        register: {
          type: 'string',
          description:
            '已有文献库的路径（工作区相对或绝对），原地接管：识别它的编号规则、补 .lit.json，不动已有内容。',
        },
        force: {
          type: 'boolean',
          description: '修复用：允许重写可重建的骨架文件（.lit.json、空模板索引）。默认 false，不碰已有索引行与笔记。',
        },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        const registerText = stringArg(args.register);
        return implOf(library, 'litInit')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          register: registerText === undefined ? undefined : isAbsolute(registerText) ? registerText : resolve(workspaceRoot, registerText),
          force: args.force === true,
        });
      },
    }),

    // ---------------------------------------------------------------- import
    build({
      name: 'lit_import',
      description:
        '把文献原件收进库：抽取全文写成 txt、把原件复制到 refs/外部资料、在索引里追加一行（编号自动续号）。\n' +
        '**默认不入库**：用户发来文件 ≠ 让你入库。没听到“入库 / 收进库 / 放库 / 归档 / 收录 / 加到参考文献”' +
        '这类明确意思时，不要调用本工具，先按技能里的三选项问一句（①入库 ②不入库 ③以后都不问）。\n' +
        '若 lit_prefs 返回 askBeforeImport:false，这个项目**不要提问**，只在回答末尾写一行“未入库（本项目已设不问）”；' +
        '用户明确说入库时照常导。\n' +
        'intent 必填：explicit = 用户本句明确说要入库；confirmed = 用户回答了你“要入库吗”并且说“要”。' +
        '缺失/非法直接整拒，一个字节都不写。\n' +
        '写盘前先算账（篇数上限、标签 ≤5 且在 refs/tags.md 词表里、格式与语种、txt 大小安全阀）：任何整拒都发生在写盘前，' +
        '不会留半截。返回 imported / skipped / failed 逐篇说明。\n' +
        '扫描件（PDF 无文本层）不写 txt，索引「文本」列是「待 OCR」—— 配好 OCR 后重导 overwrite=true 或 lit_repair 补文本，再写 note。',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要入库的文件（工作区相对或绝对），一次可多篇。支持 pdf / docx / pptx / ppt / txt / md；只收中文与英文文献。',
        },
        intent: {
          type: 'string',
          required: true,
          enum: ['explicit', 'confirmed'],
          description:
            '入库意图，必填。explicit = 用户本句明确说要入库；confirmed = 用户回答“要”之后。' +
            '没听到明确入库意思时不要调用本工具——先问（三个选项）。',
        },
        project: { type: 'string', description: '多项目工作区里指定项目名；只有项目时可省。' },
        id: {
          type: 'string',
          description: '只导入一篇时手工指定编号（要符合项目编号规则，如 A001）。一般不用：编号自动续号，空号不回收。',
        },
        copy: {
          type: 'boolean',
          description: '默认 true：把原件复制进 refs/外部资料。false = 原件已经在该目录里，只登记不复制。',
        },
        overwrite: { type: 'boolean', description: '同名原件已存在时是否覆盖（默认 false：跳过并在 skipped 里说明原因）。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '受控标签，一篇最多 5 个；必须在 refs/tags.md 词表里（或用 addTags:true 新增）。索引里只写规范名。',
        },
        addTags: { type: 'boolean', description: 'tags 里不在词表的标签是否允许新增到词表（默认 false：报错并列相近标签）。' },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litImport')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          paths: arrayArg(args.paths),
          id: stringArg(args.id),
          copy: args.copy !== false,
          overwrite: args.overwrite === true,
          tags: arrayArg(args.tags),
          addTags: args.addTags === true,
          intent: stringArg(args.intent),
        });
      },
    }),

    // ------------------------------------------------------------------ find
    build({
      name: 'lit_find',
      description:
        '按受控标签查文献，**只读**，不改任何文件。同标签内规范名 + 别名是 OR；多标签默认 AND（mode:"any" 改成 OR）。\n' +
        '什么时候用：用户问“哪些文献讲退火 / 我有哪些关于某主题的资料 / 这个标签下有什么”。\n' +
        '标签必须在 refs/tags.md 词表里，不在词表会报错并列相近标签。返回只有索引行（编号/文件/规模/文本/笔记/标签），' +
        '不含正文 —— 正文用 grep 去 work/外部资料_txt/ 找，别整本读 PDF。',
      parameters: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '查询标签（规范名或别名都行）。多标签默认 AND；同标签内规范名+别名是 OR。',
        },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: '多标签的匹配方式：all = 全部命中（默认）；any = 任一命中。',
        },
        project: { type: 'string', description: '项目名；工作区只有一个库时可省。' },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litFind')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          tags: arrayArg(args.tags),
          mode: args.mode === 'any' ? 'any' : 'all',
        });
      },
    }),

    // ----------------------------------------------------------------- prefs
    build({
      name: 'lit_prefs',
      description:
        '读 / 改项目偏好（.lit.json）。askBeforeImport=false 表示“这个项目以后不再问，只有用户明确说入库才导”。\n' +
        '什么时候用：用户嫌每次都被问入库烦（改成 false）；或要看这个项目当前的编号规则 / 页偏差 / 索引路径 / 文件布局。\n' +
        '只传 project（或不传）就是只读。返回里的 issues 是元数据推断/损坏的提示（.lit.json 坏了不会让工具停）。',
      parameters: {
        project: { type: 'string', description: '项目名；不传 = 当前工作区那个库。' },
        askBeforeImport: {
          type: 'boolean',
          description: 'true = 每次入库前先问用户；false = 以后不再问，只有用户明确说入库才导。不传 = 只读当前设置。',
        },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litPrefs')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          askBeforeImport: typeof args.askBeforeImport === 'boolean' ? args.askBeforeImport : undefined,
        });
      },
    }),

    // ----------------------------------------------------------------- check
    build({
      name: 'lit_check',
      description:
        '体检文献库，**只读**，不改文件：索引行数/字节/条数预算、编号重复、孤儿 note、note 断链、摘录逐字核对' +
        '（含嵌套引号/长度/跨页拼接）、txt 覆盖、标签 ≤5 且在词表、扫描件待 OCR、模式 B 的顶层总览对账。\n' +
        '每条问题带 code / line / message / fix（fix 写清怎么修）；summary 形如 “0 FAIL / 0 WARN（11 篇）”。\n' +
        '什么时候用：导入前后、写完 note 后、用户问“库里干净吗”。多项目工作区必须传 project 或 all:true，' +
        '否则报错并列名字（防止猜错库）。',
      parameters: {
        project: { type: 'string', description: '只体检这一个项目。' },
        all: { type: 'boolean', description: '多项目工作区里体检全部项目，并核对顶层总览（模式 B）。默认 false。' },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litCheck')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          all: args.all === true,
        });
      },
    }),

    // --------------------------------------------------------------- migrate
    build({
      name: 'lit_migrate',
      description:
        '把单表索引迁移成分片模式（.lit.json 的 indexMode=sharded）：先备份原表，按 shardEntries 切成 ' +
        'refs/index/shard-NNN.md，回读校验每行逐字相等，失败自动回滚（删新分片、还原主索引与 .lit.json）。\n' +
        '什么时候用：库大到接近索引行/字节预算（lit_check 的 remaining 见底）时的一次性动作；迁移前先 lit_check 确认干净。\n' +
        '旧库原地 register 接管**不会**自动迁移 —— 只有显式调用本工具才分片。行文本逐字保留、编号顺序不变；' +
        '已经是分片模式会报“已经是分片模式”。',
      parameters: {
        project: { type: 'string', description: '要迁移的项目名；工作区只有一个库时可省。' },
        shardEntries: {
          type: 'integer',
          description: '每个分片多少条（默认 200）。迁移后写进 .lit.json 的 shardEntries。',
        },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        const shardEntries = Number.isInteger(args.shardEntries) && args.shardEntries > 0 ? args.shardEntries : undefined;
        return implOf(library, 'litMigrate')({ io, workspaceRoot, config: cfg, project: stringArg(args.project), shardEntries });
      },
    }),

    // ---------------------------------------------------------------- repair
    build({
      name: 'lit_repair',
      description:
        '修体检里**能自动修**的问题：给扫描件/缺 txt 的行补 OCR 与 txt、重试失败的导入行。\n' +
        'ids 用来点名只修哪几行；allowOriginalTable=true 才允许改动**原表**里被点名行的「文本」一格' +
        '（决策页 Q33 的显式开关，默认关闭 —— 默认绝不碰原有表）。\n' +
        '什么时候用：lit_check 报了“扫描件待 OCR / 文本列待 OCR / txt 缺失”这类可修项，且项目已配置 OCR' +
        '（.lit.json 的 ocr.command）。先传 dryRun:true 看一眼要修什么，再传 ids 点名试，确认结果再批量。\n' +
        'dryRun 默认 **false**（真的补）；写盘前自动备份。没有 OCR 配置时如实报原因，不会硬改。',
      parameters: {
        project: { type: 'string', description: '项目名；工作区只有一个库时可省。' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '只修这几行（编号，如 A003）。不传 = 修全部可修项。',
        },
        allowOriginalTable: {
          type: 'boolean',
          description: '允许改动原表里 ids 点名行的「文本」一格。默认 false：原有表一个字节都不碰。',
        },
        dryRun: {
          type: 'boolean',
          description: 'false（默认）= 真的补 OCR/txt（写前自动备份）；true = 只报告将要修什么，不写盘。',
        },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litRepair')({
          io,
          workspaceRoot,
          config: cfg,
          project: stringArg(args.project),
          ids: arrayArg(args.ids),
          allowOriginalTable: args.allowOriginalTable === true,
          dryRun: args.dryRun === true,
        });
      },
    }),

    // ------------------------------------------------------------------ undo
    build({
      name: 'lit_undo',
      description:
        '用写前备份（.bak）把索引回滚到本插件最近一次写入之前：撤销刚做错的一次导入 / 迁移 / 修补。\n' +
        'undo 后索引与那次写入前逐字节相同；不会删原件、txt、note，也不会动别的项目。\n' +
        '什么时候用：刚导错、或迁移后发现不对（且之后没有手动改过索引）。没有备份可回滚时明确报错，不瞎猜。',
      parameters: {
        project: { type: 'string', description: '项目名；工作区只有一个库时可省。' },
      },
      async run({ io, workspaceRoot, config: cfg, args }) {
        return implOf(library, 'litUndo')({ io, workspaceRoot, config: cfg, project: stringArg(args.project) });
      },
    }),
  ];
}

/**
 * 注册全部 8 个工具并返回规格数组（apply 的实现体，测试也直接用）。
 *
 * @param {{ tools: { register: Function } }} ctx 宿主上下文
 * @param {{ config?: object, library?: object }} options
 */
export function registerTools(ctx, options = {}) {
  const tools = createTools({ ctx, config: options.config, library: options.library ?? defaultLibrary });
  for (const spec of tools) ctx.tools.register(defineTool(spec));
  return tools;
}

/**
 * 插件入口。DSH/Cordis 约定：`apply(ctx, config)`，config 来自 cordis.patch.yml（可缺省）。
 * 工具逻辑不直接读 config：统一传进 library.js，由 normalizeConfig 补默认值、项目级覆盖在那边做。
 */
/** 随包携带的 Skill 正文（装成插件后模型能直接看到规则）。 */
function bundledSkillContent() {
  try {
    return readFileSync(new URL('../skills/lit-library/SKILL.md', import.meta.url), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 插件入口。DSH/Cordis 约定：`apply(ctx, config)`，config 来自 cordis.patch.yml（可缺省）。
 * 工具逻辑不直接读 config：统一传进 library.js，由 normalizeConfig 补默认值、项目级覆盖在那边做。
 * 同时把随包 Skill 注册进技能注册表（缺 `skills` 能力时静默跳过，不影响工具）。
 */
export function apply(ctx, config) {
  const tools = registerTools(ctx, { config: config ?? {} });
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
  const content = bundledSkillContent();
  if (skills !== undefined && skills !== null && typeof skills.register === 'function' && content !== undefined) {
    ctx.effect(() =>
      skills.register({
        name: 'lit-library',
        description:
          '维护受治理的文献库：初始化项目、导入文献、写原文摘记、逐字引用、按标签查询、体检。当用户要往文献库里加资料、问某篇讲了什么、写/改文献笔记、问有哪些文献带某标签、或问库是否干净时使用。',
        whenToUse: '用户提到文献库 / 参考资料总表 / 入库 / 收录 / 文献笔记 / 文献体检时。',
        source: 'runtime',
        content,
      }),
    );
  }
  return tools;
}
