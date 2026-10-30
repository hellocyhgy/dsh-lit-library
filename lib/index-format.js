/**
 * 索引（文献总表）的读写格式：一张表、一篇一行、带「笔记」与「标签」列。
 *
 * 设计约束（实测教训）：
 * 1. 旧库的索引里不止一张表，不能把每行首格都当编号 —— 先验 `^[A-Za-z]+\d+$`。
 * 2. 新库模板必须瘦（≤ 1 KB），否则 8 KB 预算装不下 ~66 条。
 * 3. 追加行永远插在最后一张表的最后一行之后，不改动已有分区。
 *
 * @module dsh-lit-library/index-format
 */

export const COLUMNS = ['编号', '文件', '性质', '规模', '文本', '笔记', '标签'];

const DEFAULT_MAP = { id: 0, file: 1, nature: 2, scale: 3, text: 4, note: 5, tags: 6 };
const COLUMN_KEYS = { 编号: 'id', 文件: 'file', 性质: 'nature', 规模: 'scale', 文本: 'text', 笔记: 'note', 标签: 'tags' };
const ID_LIKE = /^[A-Za-z]+\d+$/;

/** 拆一行 markdown 表格：返回 trim 过的 cells；非表格行返回 []。 */
export function splitRow(line) {
  const raw = (line ?? '').trim();
  if (!raw.startsWith('|')) return [];
  const body = raw.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

/** 去反引号与两边空白（文件/笔记列常包在反引号里）。 */
export function stripTicks(cell) {
  return String(cell ?? '').replace(/^`+|`+$/g, '').trim();
}

/** 标签列 → 数组（中英文逗号都认）。 */
export function splitTags(cell) {
  return String(cell ?? '')
    .split(/[,，]/)
    .map((tag) => tag.trim())
    // `—` 是“没有标签”的占位符（renderRow 写出来的），不是标签
    .filter((tag) => tag.length > 0 && tag !== '—' && tag !== '-');
}

function columnMap(headerCells) {
  const map = { ...DEFAULT_MAP };
  let seen = 0;
  for (let i = 0; i < headerCells.length; i++) {
    const key = COLUMN_KEYS[headerCells[i]];
    if (key !== undefined) {
      map[key] = i;
      seen += 1;
    }
  }
  // 只有表头认得出「编号」才信这份映射，否则回落旧库口径。
  return seen >= 3 ? map : { ...DEFAULT_MAP };
}

/**
 * 解析索引。`rows` 里的每一行都是“首格像编号”的行（不保证符合 idPattern，
 * 校验交给调用方，因为要看项目配置）。
 */
export function parseIndex(text) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);
  const lineCount = raw.endsWith('\n') ? Math.max(lines.length - 1, 0) : lines.length;
  let header = null;
  let headerLine = -1;
  let map = { ...DEFAULT_MAP };
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length < 3) continue;
    if (cells.some((cell) => cell === '编号') && cells.includes('文件')) {
      header = cells;
      headerLine = i;
      map = columnMap(cells);
      break;
    }
  }
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length === 0) continue;
    const id = cells[map.id] ?? '';
    if (!ID_LIKE.test(id)) continue;
    rows.push({
      line: i + 1,
      cells,
      id,
      file: stripTicks(cells[map.file]),
      nature: cells[map.nature] ?? '',
      scale: cells[map.scale] ?? '',
      text: (cells[map.text] ?? '').trim(),
      note: stripTicks(cells[map.note]),
      tags: splitTags(cells[map.tags]),
    });
  }
  return { raw, lines, lineCount, bytes: byteLength(raw), header, headerLine, map, rows };
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** 渲染一行索引。文件用反引号包住，笔记没有就写 `—`。 */
export function renderRow({ id, file, nature = '—', scale = '—', text = '✔', note = '—', tags = [] }) {
  const tagCell = Array.isArray(tags) && tags.length > 0 ? tags.join(', ') : '—';
  return `| ${id} | \`${file}\` | ${nature || '—'} | ${scale || '—'} | ${text || '✔'} | ${note || '—'} | ${tagCell} |`;
}

/**
 * 追加行：插到最后一张表的最后一行之后（表格里没有行就追加到文件末尾）。
 * 不改动任何已有行、不重排分区。
 */
export function appendRows(text, rows) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);
  let lastTableLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    // 跳过 `|---|---|` 这类分隔行
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    lastTableLine = i;
    break;
  }
  if (lastTableLine >= 0) lines.splice(lastTableLine + 1, 0, ...rows);
  else lines.push(...rows);
  const joined = lines.join('\n');
  return raw.endsWith('\n') && !joined.endsWith('\n') ? joined + '\n' : joined;
}

/** 旧库追加区的固定标题（A–D 原表永不碰，新行只进这里）。 */
export const LEGACY_SECTION_HEADER = '## 新入库（待整理）';

const TABLE_HEADER = '| 编号 | 文件 | 性质 | 规模 | 文本 | 笔记 | 标签 |';
const TABLE_SEP = '|---|---|---|---|---|---|---|';

/**
 * 旧库判定：多分区标题、非模板表头、或有多张表 → 旧库。
 * 新库 = lit_init 生成的单表（最多带上追加区后仍是同一张表）。
 */
export function isLegacyIndex(text) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return false;
  const lines = raw.split(/\r?\n/);
  let tableHeaders = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^##\s/.test(t) && t !== LEGACY_SECTION_HEADER) return true;
    if (t === TABLE_HEADER) tableHeaders += 1;
  }
  if (tableHeaders > 1) return true;
  if (tableHeaders === 1 && !raw.includes('# 文献总表')) return true;
  const parsed = parseIndex(raw);
  // 表头认不出「文件」列（旧库有 5 列/6 列的表）也算旧库
  if (parsed.header !== null && !parsed.header.includes('文件')) return true;
  return false;
}

/**
 * 旧库追加：写进文件末尾的「## 新入库（待整理）」区；没有就建（标题 + 表头 + 分隔行）。
 * 原表一个字节不动。
 */
export function appendLegacyRows(text, rows) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === LEGACY_SECTION_HEADER);
  const rowList = Array.isArray(rows) ? rows : [rows];

  if (sectionIndex < 0) {
    const body = raw.length === 0 ? '' : raw.endsWith('\n') ? raw : raw + '\n';
    const gap = body.length === 0 || body.endsWith('\n\n') ? '' : '\n';
    return body + gap + LEGACY_SECTION_HEADER + '\n\n' + TABLE_HEADER + '\n' + TABLE_SEP + '\n' + rowList.join('\n') + '\n';
  }

  // 追加区已存在：插到该区最后一行表格之后（没有表格就先补表头）。
  let lastTableLine = -1;
  let hasHeader = false;
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^##\s/.test(t)) break;
    if (t === TABLE_HEADER) hasHeader = true;
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    lastTableLine = i;
  }
  if (!hasHeader) {
    lines.splice(sectionIndex + 1, 0, '', TABLE_HEADER, TABLE_SEP);
    lastTableLine = Math.max(lastTableLine + 3, sectionIndex + 3);
  }
  if (lastTableLine >= 0) lines.splice(lastTableLine + 1, 0, ...rowList);
  else lines.push(...rowList);
  const joined = lines.join('\n');
  return raw.endsWith('\n') && !joined.endsWith('\n') ? joined + '\n' : joined;
}

/** 新库索引模板：单表 + 一行说明，目标 ≤ 1 KB。 */
export function indexTemplate() {
  return [
    '# 文献总表',
    '',
    '> 新文献用 `lit_import` 收录；全文在 `work/外部资料_txt/`，检索优先 grep。',
    '',
    '| 编号 | 文件 | 性质 | 规模 | 文本 | 笔记 | 标签 |',
    '|---|---|---|---|---|---|---|',
    '',
  ].join('\n');
}

/** 项目区总览模板（仅模式 B）。 */
export function overviewTemplate(rows) {
  const body = rows.map((r) => `| ${r.name} | ${r.rows} | ${r.updated} | ${r.path} |`);
  return ['# 项目区总览', '', '| 项目 | 条目数 | 最近更新 | 路径 |', '|---|---|---|---|', ...body, ''].join('\n');
}
