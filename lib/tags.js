/**
 * 标签与受控词表（`refs/tags.md`）。
 *
 * 词表一行一条：`- 退火工艺 | 退火, annealing`。
 * 左边是规范名（写进索引行的就是它）；右边是别名，**只在查询时展开**。
 * 别名不建层级；同一别名出现在两个条目下 = 词表冲突（lit_check 报 FAIL）。
 *
 * @module dsh-lit-library/tags
 */

/** 规范化：去两头空白，内部连续空白压成一个。 */
export function canonical(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/** 匹配用的 key（拉丁字母不区分大小写）。 */
export function tagKey(value) {
  return canonical(value).toLowerCase();
}

/** 解析词表文本 → [{ name, aliases }]。注释行、标题、引用块都跳过。 */
export function parseTagsFile(text) {
  const vocab = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*]\s*/, '').trim();
    if (!t || t.startsWith('#') || t.startsWith('>')) continue;
    const parts = t.split('|');
    const name = canonical(parts[0]);
    if (!name) continue;
    const aliases = (parts[1] ?? '').split(/[,，]/).map(canonical).filter((alias) => alias.length > 0);
    vocab.push({ name, aliases });
  }
  return vocab;
}

/** 渲染词表文本（新库初始为空词表，lit_init 会写这个骨架）。 */
export function renderTagsFile(vocab) {
  const head = ['# 标签词表', '', '> 一行一条：`- 规范名 | 别名, 别名`。索引里只写规范名；别名只在查询时展开。', ''];
  const body = (vocab ?? []).map((entry) => (entry.aliases.length > 0 ? `- ${entry.name} | ${entry.aliases.join(', ')}` : `- ${entry.name}`));
  return [...head, ...body, ''].join('\n');
}

/** 用词表展开一个查询标签：命中规范名或别名都返回整组（规范名 + 别名）。 */
export function expandTag(vocab, query) {
  const key = tagKey(query);
  if (!key) return undefined;
  for (const entry of vocab ?? []) {
    if (tagKey(entry.name) === key) return { name: entry.name, terms: [entry.name, ...entry.aliases] };
    for (const alias of entry.aliases) {
      if (tagKey(alias) === key) return { name: entry.name, terms: [entry.name, ...entry.aliases] };
    }
  }
  return undefined;
}

/** 别名/规范名跨条目重复 → 返回冲突描述（每条一句）。 */
export function aliasCollisions(vocab) {
  const seen = new Map();
  const collisions = [];
  for (const entry of vocab ?? []) {
    for (const term of [entry.name, ...entry.aliases]) {
      const key = tagKey(term);
      if (!key) continue;
      const owner = seen.get(key);
      if (owner === undefined) seen.set(key, entry.name);
      else if (owner !== entry.name) collisions.push(`词表冲突：「${term}」同时属于「${owner}」和「${entry.name}」`);
    }
  }
  return collisions;
}

/** 词表里未被任何索引行用到的标签（提醒清理，不阻塞）。 */
export function unusedTags(vocab, usedCounts) {
  const unused = [];
  for (const entry of vocab ?? []) {
    const used = usedCounts?.[entry.name] ?? 0;
    if (!used) unused.push(entry.name);
  }
  return unused;
}

/** 近似标签建议：编辑距离小或互为子串。 */
export function suggestTags(vocab, query, limit = 5) {
  const q = tagKey(query);
  if (!q) return [];
  const scored = [];
  for (const entry of vocab ?? []) {
    let best = Infinity;
    for (const term of [entry.name, ...entry.aliases]) {
      const key = tagKey(term);
      let dist = levenshtein(q, key);
      if (key.includes(q) || q.includes(key)) dist = Math.min(dist, 1);
      best = Math.min(best, dist);
    }
    scored.push({ name: entry.name, dist: best });
  }
  scored.sort((a, b) => a.dist - b.dist);
  const out = [];
  for (const item of scored) {
    if (out.includes(item.name)) continue;
    out.push(item.name);
    if (out.length >= limit) break;
  }
  return out;
}

/** 标签数组去空、去重、保序。 */
export function normalizeTagList(tags) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : tags === undefined ? [] : [tags]) {
    const value = canonical(raw);
    if (!value) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}
