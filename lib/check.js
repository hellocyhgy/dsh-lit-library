/**
 * `lit_check` 的实现：把“索引层 / 笔记层 / 原件↔全文 / 标签 / 总览”一次查完。
 *
 * 口径（与旧 `work\kb_check.py` 对齐，否则真库会从 0/0 变红）：
 * - 索引行数 ≤ maxLines、字节 ≤ maxBytes（项目级可覆盖）；一篇编号在总表里宽容 2 行。
 * - 孤儿 note（总表没引用）FAIL；编号不在总表 FAIL；总表引用了不存在的 note FAIL。
 * - 摘录：逐字回查 txt（白空格归一），“没写到”只 WARN；中文 12–60 字，英文 8–40 词。
 * - 扫描件 `待 OCR` 行跳过 txt 检查，末尾汇总一条 WARN。
 * - 标签：≤5 个、都在词表里（含别名），词表冲突 FAIL。
 * - 分片模式：目录 ≤ 2 KB，每片 ≤ shardEntries 条，分片与目录互相对账。
 *
 * 每条 FAIL/WARN 都带 `fix`（怎么修），见决策页 Q20。
 *
 * @module dsh-lit-library/check
 */
import { extname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { parseIndex, splitRow, stripTicks } from './index-format.js';
import { readTextOr } from './store.js';
import { aliasCollisions, expandTag, parseTagsFile, suggestTags, tagKey } from './tags.js';
import { SHARD_DIR_MAX_BYTES, SHARD_NAME_RE } from './project.js';

const MARKER_RE = /^===== \[(?:p\d+|slide \d+)\] =====$/gm;
const NOTE_REF_RE = /refs\/notes\/([^`\s)]+\.md)/g;
const QUOTE_RE = /[「“]([^」”]{12,})[」”]/g;
const NUM_RE = /μV\/℃|sccm|×1[0-9０-９]|10-\d|℃|μm|%，/;
const MAX_TAGS = 5;
const BINARY_SRC_EXTS = new Set(['.pdf', '.docx', '.pptx', '.ppt']);

const DEFAULTS = {
  maxLines: 200,
  maxBytes: 8192,
  maxEntries: 150,
  maxTxtBytes: 1048576,
  pageOffset: 0,
  indexMode: 'single',
  shardEntries: 200,
};

function limitOf(limits, key) {
  const value = limits?.[key];
  return value === undefined || value === null ? DEFAULTS[key] : value;
}

function issue(code, message, fix, line) {
  const item = { code, message, fix };
  if (line !== undefined) item.line = line;
  return item;
}

function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

function charLength(text) {
  return [...String(text ?? '')].length;
}

function squash(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** Q34 上限文案：两条路 + 各自优缺点（single / sharded 两套）。 */
export function limitMessage({ mode, limit, current, addBytes, tier }) {
  if (mode === 'sharded') {
    const lines = [
      `lit: 这个项目的分片条目数到上限了（上限 maxEntries=${limit}，当前 ${current} 条${addBytes ? `，本篇约 ${addBytes} B` : ''}）。`,
      '两条路，各有代价：',
      '① 扩大预算：在 `.lit.json` 里把 `maxEntries` 调大（万级仍用分片，每会话只读目录，成本不随总量涨）。',
      '  优点：不拆库、编号连续、引用不用带项目名；缺点：分片文件变多，check 遍历更慢，单次全量检索耗时增加。',
      '② 拆分项目：按话题/年份另建项目区，各自保持轻。',
      '  优点：每个索引都轻，检索、交接都便宜；缺点：要多建项目区，跨项目引用得写「项目/编号」，已有行需要手工迁移（归位工具二期）。',
    ];
    if (tier) lines.push(`当前档位：${tier}。`);
    return lines.join('\n');
  }
  const lines = [
    `lit: 这个项目的索引到上限了（上限 ${limit} B，当前 ${current} B${addBytes ? `，本篇约 ${addBytes} B` : ''}）。`,
    '两条路，各有代价：',
    '① 扩大预算：把本项目上限调大——在 `.lit.json` 里改 `maxBytes`，按需选阶梯：32 KB≈200 篇、64 KB≈400 篇、128 KB≈860 篇（公式：篇数 ≈ (maxBytes − 350) ÷ 150）。',
    '  优点：不拆库、编号连续、引用不用带项目名；',
    '  缺点：索引每次被读/检索的成本线性上涨（8 KB≈2.7k token，32 KB≈11k，64 KB≈22k，128 KB≈44k）；且与其它项目/旧库的 8 KB 口径不统一。',
    '② 拆分项目（拆成两个项目）：本库保留一部分，新话题/新年份另建项目区。',
    '  优点：每个索引保持轻，检索、交接都便宜；',
    '  缺点：要多建一个项目区，跨项目引用得写「项目/编号」，已有行需要手工迁移（归位工具二期）。',
    '建议：剩余只差几篇且内容同题 → 选 ①；内容本就能分开、或预计长期增长 → 选 ②。',
  ];
  return lines.join('\n');
}

/** 全局通用检查（single 与 sharded 共用）。 */
async function checkEntries({ io, root, paths, idPattern, limits, rows, referenceText, fails, warns }) {
  const idSet = new Set();
  const perId = new Map();
  const pending = new Set();
  let pendingOcr = 0;

  for (const row of rows) {
    idSet.add(row.id);
    perId.set(row.id, (perId.get(row.id) ?? 0) + 1);
    if (/^[A-Za-z]+\d+$/.test(row.id) && idPattern) {
      let ok = true;
      try {
        ok = new RegExp(idPattern).test(row.id);
      } catch {
        ok = true;
      }
      if (!ok) {
        fails.push(
          issue(
            'id-pattern',
            `编号 ${row.id} 不符合本项目编号规则 ${idPattern}`,
            '改成本项目允许的编号（旧库可用 A1 形式；新库用 A001），或调 `.lit.json` 的 idPattern',
            row.line,
          ),
        );
      }
    }
    if (String(row.text ?? '').includes('待 OCR')) {
      pendingOcr += 1;
      if (row.file) pending.add(row.file);
    }
  }

  // 一篇最多 2 行（Q9-B 宽容；旧库允许一篇占两行）
  for (const [id, count] of perId) {
    if (count > 2) {
      fails.push(
        issue('id-overflow', `${id} 在总表里占了 ${count} 行（阈值 2 行）`, '把内容拆到 refs/notes/ 的 note，总表只留一行', undefined),
      );
    }
  }

  // ---- notes ----
  const noteFiles = (await io.list(paths.notesDir))
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  for (const name of noteFiles) {
    if (!referenceText.includes(name)) {
      fails.push(issue('orphan-note', `孤儿 note（总表没引用）: ${name}`, '在总表补一行引用它，或删掉这个文件', undefined));
    }
    const match = /^([A-Za-z]+\d+)_/.exec(name);
    if (!match) {
      warns.push(issue('bad-note-name', `note 文件名不遵守 编号_短名.md 约定: ${name}`, '改名成 <编号>_<短名>.md', undefined));
    } else if (!idSet.has(match[1])) {
      fails.push(issue('note-id-missing', `note 的编号 ${match[1]} 不在总表清单里: ${name}`, '补总表行，或删掉这个 note', undefined));
    }
    await checkNote({ io, root, paths, name, fails, warns });
  }

  // ---- 总表 → notes 断链 ----
  NOTE_REF_RE.lastIndex = 0;
  let link;
  const seenLinks = new Set();
  while ((link = NOTE_REF_RE.exec(referenceText)) !== null) {
    const name = link[1];
    if (seenLinks.has(name)) continue;
    seenLinks.add(name);
    if (name.includes('<') || name.includes('*')) continue;
    const abs = resolvePath(paths.notesDir, name);
    if (!(await io.exists(abs))) {
      fails.push(issue('note-link-missing', `总表引用了不存在的 note: ${name}`, '补上 refs/notes/ 下的文件，或改正总表路径', undefined));
    }
  }

  // ---- 原件 ↔ txt ----
  for (const entry of (await io.list(paths.srcDir)).filter((item) => item.type === 'file')) {
    const ext = extname(entry.name).toLowerCase();
    if (!BINARY_SRC_EXTS.has(ext)) continue;
    if (pending.has(entry.name)) continue; // 待 OCR 行不强求 txt
    const stem = basename(entry.name, extname(entry.name));
    const txtPath = resolvePath(paths.txtDir, stem + '.txt');
    if (!(await io.exists(txtPath))) {
      warns.push(issue('txt-missing', `原件没有对应 txt: ${entry.name}`, '重新导入（lit_import overwrite=true）或手工抽文本到 work/外部资料_txt/', undefined));
      continue;
    }
    const content = await io.readText(txtPath);
    MARKER_RE.lastIndex = 0;
    const markers = (content.match(MARKER_RE) ?? []).length;
    if (markers === 0) {
      warns.push(issue('txt-no-marker', `txt 缺少页标: ${stem}.txt`, '用 ===== [pN] ===== / ===== [slide N] ===== 按页重建 txt', undefined));
    }
    if (charLength(content) < 200) {
      warns.push(issue('txt-tiny', `txt 内容过少（${charLength(content)} 字符）: ${stem}.txt`, '重新抽取/OCR；空文本不应入库', undefined));
    }
  }

  // ---- 标签 ----
  const tagsText = await readTextOr(io, paths.tagsFile, '');
  const vocab = parseTagsFile(tagsText);
  if (vocab.length > 0) {
    for (const collision of aliasCollisions(vocab)) {
      fails.push(issue('tag-collision', collision, '同一别名只保留在一个规范名下', undefined));
    }
    const used = new Map();
    for (const row of rows) {
      if (row.tags.length > MAX_TAGS) {
        fails.push(issue('tag-too-many', `${row.id} 有 ${row.tags.length} 个标签（上限 ${MAX_TAGS}）`, '删到 5 个以内', row.line));
      }
      for (const raw of row.tags) {
        const hit = expandTag(vocab, raw);
        if (!hit) {
          const hints = suggestTags(vocab, raw).join('、') || '无';
          fails.push(issue('tag-unknown', `${row.id} 的标签「${raw}」不在词表里（相近：${hints}）`, '改用词表里的规范名，或把它加进 refs/tags.md', row.line));
        } else {
          used.set(tagKey(hit.name), (used.get(tagKey(hit.name)) ?? 0) + 1);
        }
      }
    }
    for (const entry of vocab) {
      if (!used.has(tagKey(entry.name))) {
        warns.push(issue('tag-unused', `词表里的标签「${entry.name}」还没被任何文献用到`, '先留着，或从 refs/tags.md 删掉', undefined));
      }
    }
  }

  return pendingOcr;
}

/** 单篇 note 的摘录检查（R1/R2/R3 + 长度 + 逐字回查）。 */
async function checkNote({ io, root, paths, name, fails, warns }) {
  const abs = resolvePath(paths.notesDir, name);
  let content = '';
  try {
    content = await io.readText(abs);
  } catch {
    fails.push(issue('note-unreadable', `note 读不了: ${name}`, '检查编码（UTF-8）或权限', undefined));
    return;
  }
  const sectionMatch = /## 原文摘录[\s\S]*?(?=\n## |$)/.exec(content);
  const section = sectionMatch ? sectionMatch[0] : '';
  const quotes = [];
  const englishQuotes = [];

  if (section) {
    for (const match of section.matchAll(QUOTE_RE)) quotes.push(match[1]);
    for (const line of section.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const nestedDouble = /“([^”]*)”/.exec(text);
      if (nestedDouble && /[「」]/.test(nestedDouble[1])) {
        warns.push(issue('nested-quote', `摘录内嵌引号: ${name} :: ${nestedDouble[1].slice(0, 18)}`, '拆成两条单页短摘录，别在引号里再套引号', undefined));
      }
      if (text.includes('「')) {
        const inner = /「([^」]*)」/.exec(text);
        if (inner && /[“”]/.test(inner[1])) {
          warns.push(issue('nested-quote', `摘录内嵌引号: ${name} :: ${inner[1].slice(0, 18)}`, '拆成两条单页短摘录，别在引号里再套引号', undefined));
        } else if (!inner) {
          warns.push(issue('unclosed-quote', `引号未闭合: ${name} :: ${text.slice(0, 18)}`, '补齐「」或删掉半边引号', undefined));
        }
      }
      const open1 = (text.match(/「/g) ?? []).length;
      const close1 = (text.match(/」/g) ?? []).length;
      if (open1 !== close1) {
        warns.push(issue('unbalanced-quote', `「」不配对: ${name} :: ${text.slice(0, 18)}`, '一行里开合数量要相等', undefined));
      }
      const open2 = (text.match(/“/g) ?? []).length;
      const close2 = (text.match(/”/g) ?? []).length;
      if (open2 !== close2) {
        warns.push(issue('unbalanced-quote', `“”不配对: ${name} :: ${text.slice(0, 18)}`, '一行里开合数量要相等', undefined));
      }
      // 英文直引号：只认引用行（行首 >），词数 8–40
      if (text.startsWith('>')) {
        const emb = /"([^"]{8,})"/.exec(text);
        if (emb) {
          englishQuotes.push(emb[1]);
          const words = emb[1].trim().split(/\s+/).filter(Boolean).length;
          if (words > 40) warns.push(issue('quote-long', `英文摘录 ${words} 词（上限 40 词）: ${name}`, '拆成两段更短的摘录', undefined));
          else if (words < 8) warns.push(issue('quote-short', `英文摘录只有 ${words} 词（下限 8 词）: ${name}`, '补足到 8–40 词，或改成中文摘录', undefined));
        }
      }
    }
  }

  if (NUM_RE.test(content) && quotes.length === 0 && englishQuotes.length === 0) {
    warns.push(issue('numbers-no-quote', `note 有数值但没有原文摘录: ${name}`, '补一条带页码的「」/“”摘录', undefined));
  }

  const pathMatch = /全文：`([^`]+)`/.exec(content);
  if (!pathMatch) {
    warns.push(issue('no-txt-path', `note 里没写全文 txt 路径: ${name}`, '在 note 头部补 — 全文：`work/外部资料_txt/….txt`', undefined));
    return;
  }
  const rawPath = pathMatch[1];
  const txtAbs = isAbsolute(rawPath) ? rawPath : resolvePath(root, rawPath);
  if (!(await io.exists(txtAbs))) {
    warns.push(issue('note-txt-missing', `note 写的 txt 不存在: ${name} -> ${rawPath}`, '改正 note 里的路径，或重新抽取 txt', undefined));
    return;
  }
  const body = squash(await io.readText(txtAbs));
  for (const quote of quotes) {
    if (charLength(quote) > 60) {
      warns.push(issue('quote-long', `摘录过长（${charLength(quote)} 字，建议 ≤60 字）: ${name} :: ${quote.slice(0, 20)}…`, '拆成 ≤60 字的单页片段', undefined));
    }
    if (!body.includes(squash(quote))) {
      warns.push(issue('quote-miss', `摘录未能逐字核对（跨页/OCR 碎片或抄错）: ${name} :: ${quote.slice(0, 22)}…`, '改成单页原文片段（≤60 字），或回原件核错字', undefined));
    }
  }
  for (const quote of englishQuotes) {
    if (!body.includes(squash(quote))) {
      warns.push(issue('quote-miss', `英文摘录未能逐字核对: ${name} :: ${quote.slice(0, 30)}…`, '对照 txt 改正拼写/连字符', undefined));
    }
  }
}

/** 目录里的分片列可能写 `shard-001`（不带 .md）或全名，统一成文件名。 */
function normalizeShardName(cell) {
  const value = String(cell ?? '').trim();
  if (SHARD_NAME_RE.test(value)) return value;
  if (/^shard-\d{3}$/.test(value)) return value + '.md';
  return null;
}

/** 解析分片目录里的表：| 分片 | 条目数 | 编号范围 | 路径 | */
function parseDirectory(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]);
    if (cells.length >= 2 && cells[0] === '分片') {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]);
    if (cells.length === 0) continue;
    if (cells[0].startsWith('---')) continue;
    const name = normalizeShardName(cells[0]);
    if (name === null) continue;
    entries.push({
      name,
      count: Number(cells[1]),
      range: cells[2] ?? '',
      path: stripTicks(cells[3] ?? ''),
      line: i + 1,
    });
  }
  return entries;
}

function summarize(mode, entries, shards, fails, warns, pendingOcr) {
  const head = mode === 'sharded' ? `分片 ${shards} 片，共 ${entries} 篇` : `单表 ${entries} 篇`;
  const tail = `${fails.length} FAIL / ${warns.length} WARN`;
  const ocr = pendingOcr > 0 ? `；${pendingOcr} 篇待 OCR` : '';
  return `${head}；${tail}${ocr}`;
}

/** 体检一个项目。 */
export async function checkProject({ io, root, idPattern, paths, limits }) {
  const lim = {
    maxLines: limitOf(limits, 'maxLines'),
    maxBytes: limitOf(limits, 'maxBytes'),
    maxEntries: limitOf(limits, 'maxEntries'),
    maxTxtBytes: limitOf(limits, 'maxTxtBytes'),
    pageOffset: limitOf(limits, 'pageOffset'),
    indexMode: limitOf(limits, 'indexMode'),
    shardEntries: limitOf(limits, 'shardEntries'),
  };
  const fails = [];
  const warns = [];
  const shardEntriesLimit = Number(lim.shardEntries) > 0 ? Number(lim.shardEntries) : 200;

  if (lim.indexMode === 'sharded') {
    const dirText = await readTextOr(io, paths.indexFile, undefined);
    if (dirText === undefined) {
      return {
        mode: 'sharded',
        rows: 0,
        lines: 0,
        bytes: 0,
        remaining: { lines: lim.maxLines, bytes: SHARD_DIR_MAX_BYTES, entries: lim.maxEntries },
        pendingOcr: 0,
        fails: [issue('index-missing', '分片目录文件不存在：' + paths.indexFile, '先跑 lit_init 或 lit_migrate 生成目录/分片', undefined)],
        warns,
        summary: '分片 0 片，共 0 篇；1 FAIL / 0 WARN',
      };
    }
    const dirLines = String(dirText).endsWith('\n')
      ? String(dirText).split(/\r?\n/).length - 1
      : String(dirText).split(/\r?\n/).length;
    const dirBytes = byteLength(dirText);
    if (dirBytes > SHARD_DIR_MAX_BYTES) {
      fails.push(issue('dir-too-big', `分片目录 ${dirBytes} B，超过 ${SHARD_DIR_MAX_BYTES} B`, '目录只放分片清单，别把文献行写进目录', undefined));
    }
    if (dirLines > lim.maxLines) {
      fails.push(issue('dir-too-many-lines', `分片目录 ${dirLines} 行，超过 maxLines=${lim.maxLines}`, '目录只放分片清单', undefined));
    }

    const shardFiles = (await io.list(paths.shardDir))
      .filter((entry) => entry.type === 'file' && SHARD_NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const listed = parseDirectory(dirText);
    const rows = [];
    const shardTexts = [];
    const shardBounds = new Map();
    let maxNumber = 0;

    for (const name of shardFiles) {
      const text = await io.readText(resolvePath(paths.shardDir, name));
      const parsed = parseIndex(text);
      shardTexts.push(text);
      const number = Number(SHARD_NAME_RE.exec(name)[1]);
      maxNumber = Math.max(maxNumber, number);
      if (parsed.rows.length === 0) {
        warns.push(issue('shard-empty', `分片没有编号行: ${name}`, '删掉空分片，或把行补进去', undefined));
      }
      if (parsed.rows.length > shardEntriesLimit) {
        fails.push(issue('shard-overflow', `${name} 有 ${parsed.rows.length} 行，超过每片 ${shardEntriesLimit} 条`, '调大 shardEntries，或拆成更多分片', undefined));
      }
      shardBounds.set(name, { count: parsed.rows.length, first: parsed.rows[0]?.id, last: parsed.rows[parsed.rows.length - 1]?.id });
      for (const row of parsed.rows) rows.push({ ...row, shard: name });
    }

    const expected = new Set(shardFiles);
    if (listed === null) {
      fails.push(issue('dir-malformed', '分片目录里找不到「| 分片 | 条目数 | 编号范围 | 路径 |」表', '按 lit_migrate 生成的目录格式重建目录', undefined));
    } else {
      for (const entry of listed) {
        if (!expected.has(entry.name)) {
          fails.push(issue('shard-missing', `目录登记了不存在的分片: ${entry.name}`, '恢复分片文件，或从目录删掉这一行', entry.line));
          continue;
        }
        const bound = shardBounds.get(entry.name);
        if (Number.isFinite(entry.count) && entry.count !== bound.count) {
          fails.push(issue('shard-count', `${entry.name} 目录写 ${entry.count} 条，实际 ${bound.count} 条（条目数不对账）`, '重写目录计数（跑 lit_migrate 或修复目录）', entry.line));
        }
        const actualRange = bound.first && bound.last ? `${bound.first}–${bound.last}` : '';
        if (entry.range && actualRange) {
          // 范围写法宽容：`A003` / `A003–A003` / `A001-A002` 都算对，只验首末编号。
          const parts = entry.range
            .split(/[–—~-]/)
            .map((part) => part.trim())
            .filter((part) => part !== '');
          const rangeOk = parts.length > 0 && parts[0] === bound.first && parts[parts.length - 1] === bound.last;
          if (!rangeOk) {
            fails.push(issue('shard-range', `${entry.name} 目录写范围 ${entry.range}，实际 ${actualRange}`, '重写目录的编号范围', entry.line));
          }
        }
      }
      for (const name of shardFiles) {
        if (!listed.some((entry) => entry.name === name)) {
          fails.push(issue('shard-unlisted', `分片未登记进目录: ${name}`, '把这一片补进目录（条目数 + 编号范围）', undefined));
        }
      }
    }
    for (let n = 1; n <= maxNumber; n += 1) {
      const name = 'shard-' + String(n).padStart(3, '0') + '.md';
      if (!expected.has(name)) {
        fails.push(issue('shard-gap', `分片编号不连续，缺 ${name}`, '补回缺失分片，或从 001 起重排（先备份）', undefined));
      }
    }

    const totalEntries = rows.length;
    if (totalEntries > lim.maxEntries) {
      fails.push(issue('entries-over', `共 ${totalEntries} 篇，超过 maxEntries=${lim.maxEntries}`, limitMessage({ mode: 'sharded', limit: lim.maxEntries, current: totalEntries }), undefined));
    }

    const referenceText = [dirText, ...shardTexts].join('\n');
    const pendingOcr = await checkEntries({ io, root, paths, idPattern, limits: lim, rows, referenceText, fails, warns });
    if (pendingOcr > 0) {
      warns.push(issue('pending-ocr', `${pendingOcr} 篇待 OCR（装好 OCR 后重导 overwrite=true 补文本）`, '配好 ocr.command 后 lit_repair 或重新导入', undefined));
    }
    const entries = totalEntries;
    const remaining = {
      lines: lim.maxLines - dirLines,
      bytes: SHARD_DIR_MAX_BYTES - dirBytes,
      entries: lim.maxEntries - entries,
    };
    if (remaining.bytes < SHARD_DIR_MAX_BYTES * 0.1) {
      warns.push(issue('budget-low', '分片目录剩余空间不足 10%', limitMessage({ mode: 'sharded', limit: SHARD_DIR_MAX_BYTES, current: dirBytes }), undefined));
    }
    if (remaining.entries < lim.maxEntries * 0.1) {
      warns.push(issue('budget-low', `条目额度剩余不足 10%（${remaining.entries} / ${lim.maxEntries}）`, limitMessage({ mode: 'sharded', limit: lim.maxEntries, current: entries }), undefined));
    }
    return {
      mode: 'sharded',
      rows: entries,
      lines: dirLines,
      bytes: dirBytes,
      remaining,
      pendingOcr,
      fails,
      warns,
      summary: summarize('sharded', entries, shardFiles.length, fails, warns, pendingOcr),
    };
  }

  // ---- single ----
  const text = await readTextOr(io, paths.indexFile, undefined);
  if (text === undefined) {
    return {
      mode: 'single',
      rows: 0,
      lines: 0,
      bytes: 0,
      remaining: { lines: lim.maxLines, bytes: lim.maxBytes, entries: lim.maxEntries },
      pendingOcr: 0,
      fails: [issue('index-missing', '索引文件不存在：' + paths.indexFile, '先跑 lit_init，或用 register 接管已有库', undefined)],
      warns,
      summary: '单表 0 篇；1 FAIL / 0 WARN',
    };
  }
  const parsed = parseIndex(text);
  const lines = parsed.lineCount;
  const bytes = parsed.bytes;
  const rows = parsed.rows;
  if (lines > lim.maxLines) {
    fails.push(issue('index-too-many-lines', `总表 ${lines} 行，超过 maxLines=${lim.maxLines}`, '把细节拆到 refs/notes/，总表只留索引行', undefined));
  }
  if (bytes > lim.maxBytes) {
    fails.push(issue('index-too-big', `总表 ${bytes} B，超过 maxBytes=${lim.maxBytes}`, limitMessage({ mode: 'single', limit: lim.maxBytes, current: bytes }), undefined));
  }
  const pendingOcr = await checkEntries({ io, root, paths, idPattern, limits: lim, rows, referenceText: text, fails, warns });
  if (pendingOcr > 0) {
    warns.push(issue('pending-ocr', `${pendingOcr} 篇待 OCR（装好 OCR 后重导 overwrite=true 补文本）`, '配好 ocr.command 后 lit_repair 或重新导入', undefined));
  }
  const entries = rows.length;
  const remaining = {
    lines: lim.maxLines - lines,
    bytes: lim.maxBytes - bytes,
    entries: lim.maxEntries - entries,
  };
  if (bytes <= lim.maxBytes && remaining.bytes < lim.maxBytes * 0.1) {
    warns.push(issue('budget-low', `索引剩余额度不足 10%（${remaining.bytes} / ${lim.maxBytes} B）`, limitMessage({ mode: 'single', limit: lim.maxBytes, current: bytes }), undefined));
  }
  return {
    mode: 'single',
    rows: entries,
    lines,
    bytes,
    remaining,
    pendingOcr,
    fails,
    warns,
    summary: summarize('single', entries, 0, fails, warns, pendingOcr),
  };
}

/** 总览与目录/条目数对账（仅模式 B）。 */
export async function checkOverview({ io, projectsRoot, overviewFile, projects }) {
  const overviewFails = [];
  const exists = await io.exists(overviewFile);
  if (!exists) {
    return {
      overviewFails: [issue('overview-missing', '项目区总览不存在：' + overviewFile, '跑一次 lit_init 或 lit_check all 重建总览', undefined)],
      overviewText: null,
    };
  }
  const text = await io.readText(overviewFile);
  const lines = String(text).split(/\r?\n/);
  const listed = new Map();
  let header = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]);
    if (cells.length >= 2 && cells[0] === '项目') {
      header = i;
      break;
    }
  }
  if (header >= 0) {
    for (let i = header + 1; i < lines.length; i += 1) {
      const cells = splitRow(lines[i]);
      if (cells.length < 2) continue;
      if (cells[0].startsWith('---')) continue;
      listed.set(cells[0], { count: Number(cells[1]), line: i + 1 });
    }
  }
  for (const project of projects ?? []) {
    const hit = listed.get(project.name);
    if (!hit) {
      overviewFails.push(issue('overview-missing-project', `目录存在但总览未登记: ${project.name}`, '把项目补进总览（重跑 lit_init all）', undefined));
      continue;
    }
    if (Number.isFinite(hit.count) && hit.count !== project.rows) {
      overviewFails.push(
        issue('overview-count', `总览条目数与实际不对账：${project.name} 总览 ${hit.count} / 实际 ${project.rows}`, '刷新总览里的条目数', hit.line),
      );
    }
  }
  const names = new Set((projects ?? []).map((project) => project.name));
  for (const name of listed.keys()) {
    if (!names.has(name)) {
      overviewFails.push(issue('overview-orphan', `总览登记但目录不存在: ${name}`, '恢复项目目录，或从总览删掉这一行', listed.get(name).line));
    }
  }
  return { overviewFails, overviewText: text };
}
