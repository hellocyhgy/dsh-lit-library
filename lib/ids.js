/**
 * 编号规则：项目内独立、空号不回收。
 *
 * 新项目用 A001（3 位数字），旧库继续 A1/C2（`idPattern` 配置成 `^[A-D]\\d+$`）；
 * 两边互不干扰 —— 编号只是一个被索引和 note 文件名共同引用的字符串。
 *
 * @module dsh-lit-library/ids
 */

export const NEW_ID_PATTERN = '^[A-Z]\\d{3}$';
export const LEGACY_ID_PATTERN = '^[A-D]\\d+$';

/** 编译 idPattern；坏正则在初始化时就报，别等到写盘。 */
export function compileIdPattern(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error('lit: idPattern 不是合法正则：' + String(pattern));
  }
}

/** 首格“长得像编号”（字母 + 数字）；索引里不止一张表，先用它过滤表格正文。 */
export function isIdLike(value) {
  return typeof value === 'string' && /^[A-Za-z]+\d+$/.test(value);
}

/** 是否是本项目合法编号（先像编号，再过 idPattern）。 */
export function isId(value, pattern) {
  return isIdLike(value) && compileIdPattern(pattern).test(value);
}

/** 从 idPattern 里读数字位数（`\\d{3}` → 3），读不到按 1 位。 */
function widthOf(pattern) {
  const m = /\\d\{(\d+)\}/.exec(String(pattern));
  return m ? Number(m[1]) : 1;
}

/** 空项目的第一个编号：A001（或旧库的 A1）。 */
export function firstIdFor(pattern) {
  const width = Math.max(widthOf(pattern), 1);
  return 'A' + '1'.padStart(width, '0');
}

/** 编号推断：先试新库口径，再试旧库口径，都不行就按新库默认。 */
export function inferIdPattern(ids) {
  const valid = (ids ?? []).filter(isIdLike);
  if (valid.length === 0) return NEW_ID_PATTERN;
  for (const candidate of [NEW_ID_PATTERN, LEGACY_ID_PATTERN]) {
    const re = compileIdPattern(candidate);
    if (valid.every((id) => re.test(id))) return candidate;
  }
  return NEW_ID_PATTERN;
}

/**
 * 续号：先取字母段最大的，同字母再取数字最大的，+1。空号不回收。
 * 例：A1,B1..D2 → D3；A001,A003 → A004；A999 → A1000。
 */
export function nextId(ids, pattern) {
  const re = compileIdPattern(pattern);
  let best = null;
  for (const id of ids ?? []) {
    if (!re.test(id)) continue;
    const m = /^([A-Za-z]+)(\d+)$/.exec(id);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    const n = Number(m[2]);
    if (best === null || letter > best.letter || (letter === best.letter && n > best.n)) {
      best = { letter, n, width: m[2].length };
    }
  }
  if (best === null) return firstIdFor(pattern);
  return best.letter + String(best.n + 1).padStart(best.width, '0');
}
