// dsh-lit-library v0.2 — 抽取器
// 契约：SPEC-v0.2.md §5.6（语种）、§5.7（格式与页标）、施工契约-v2.md §6（OCR 钩子）。
//
// 导出面（与 lead 的接口契约一致）：
//   SUPPORTED_EXTS / PAGE_MARKER_RE / isSupportedExt / pageMarker /
//   detectLanguage / countPages / isScannedPages / extractDocument
//
// extractDocument({ absPath, ext, io, ocr, maxPages }) 是主入口；
//   - io：可选的 io 适配器（接口同 .probe/v2/lib/io-node.mjs），不传时退回 node:fs；
//   - ocr：{ command?, args?, timeoutMs?, render? }，command 缺失 = 不可用；
//   - maxPages：页数安全阀（默认 1000）。
// 临时文件只写 os.tmpdir()，finally 清理；不写工作区，也不写真库。
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync } from 'fflate';

export const SUPPORTED_EXTS = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.ppt'];
export const PAGE_MARKER_RE = /^===== \[(p\d+|slide \d+)\] =====$/m;

const MARKER_GLOBAL_RE = /^===== \[(?:p\d+|slide \d+)\] =====$/gm;
const WORD_PAGE_BREAK_RE =
  /<w:br\b[^>]*\bw:type\s*=\s*["']page["'][^>]*\/?>|<w:lastRenderedPageBreak\b[^>]*\/?>/g;
const WORD_TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const PPT_TEXT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const SLIDE_ENTRY_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 解压后单条目上限
const MAX_ZIP_ENTRIES = 2000; // zip 内条目总数上限
const LEGACY_PPT_MESSAGE =
  'lit: 老式 .ppt 需要外部转换命令（LibreOffice），本版本未配置';

const DEFAULT_MAX_PAGES = 1000;
const OCR_DEFAULT_TIMEOUT_MS = 120000;
const OCR_RENDER_DEFAULT_TIMEOUT_MS = 600000;
const OCR_RENDER_DEFAULT_COMMAND = 'pdftoppm';
const OCR_RENDER_DEFAULT_ARGS = ['-r', '200', '-png', '{input}', '{outdir}/{prefix}'];
const OCR_COMMAND_DEFAULT_ARGS = ['{input}', '{output}'];
const OCR_RENDER_PREFIX = 'page';
const OCR_TMP_PREFIX = 'lit-ocr-';
const OCR_NO_COMMAND_REASON = '未配置 OCR（没有 ocr.command）';
const OCR_NOTE_SOURCE = 'OCR 源：摘录前回原件核错字';

function litError(reason) {
  return new Error('lit: ' + reason);
}

function isLitError(error) {
  return error instanceof Error && typeof error.message === 'string' && error.message.startsWith('lit: ');
}

function toExt(ext) {
  if (typeof ext !== 'string') return '';
  const normalized = ext.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('.') ? normalized : '.' + normalized;
}

/** 大小写不敏感；'.PDF'、'pdf' 都算支持。 */
export function isSupportedExt(ext) {
  const normalized = toExt(ext);
  return normalized !== '' && SUPPORTED_EXTS.includes(normalized);
}

/** kind: 'page' → '===== [pN] ====='；'slide' → '===== [slide N] ====='。 */
export function pageMarker(n, kind) {
  return kind === 'slide' ? `===== [slide ${n}] =====` : `===== [p${n}] =====`;
}

/** 数页标（只认独占一行的页标）。 */
export function countPages(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const matches = source.match(MARKER_GLOBAL_RE);
  return matches ? matches.length : 0;
}

/**
 * 扫描件判定：没有任何一页有非空白文字，或全篇非空白字符数 < 20。
 * 抽成独立函数是为了能在没有真实扫描 PDF 时单测。
 */
export function isScannedPages(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  let nonWhitespace = 0;
  let hasAnyText = false;
  for (const page of list) {
    const compact = String(page ?? '').replace(/\s+/g, '');
    if (compact.length > 0) hasAnyText = true;
    nonWhitespace += compact.length;
  }
  return !hasAnyText || nonWhitespace < 20;
}

/**
 * 语种识别：只看正文（去掉页标行）的前 3 页。
 * cjk 占比 > 10% → zh；否则拉丁字母占比 > 30% → en；否则 other。
 */
export function detectLanguage(text) {
  const body = sampleBody(text, 3);
  let total = 0;
  let cjk = 0;
  let latin = 0;
  for (const ch of body) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  if (total === 0) return 'other';
  if (cjk / total > 0.1) return 'zh';
  if (latin / total > 0.3) return 'en';
  return 'other';
}

/** 取前 pageCount 页的正文并去掉页标行。 */
function sampleBody(text, pageCount) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const markerRe = /^===== \[(?:p\d+|slide \d+)\] =====$/gm;
  let seen = 0;
  let end = source.length;
  let match;
  while ((match = markerRe.exec(source)) !== null) {
    if (seen === pageCount) {
      end = match.index;
      break;
    }
    seen += 1;
  }
  return source.slice(0, end).replace(/^===== \[(?:p\d+|slide \d+)\] =====$/gm, '');
}

/** 统一换行，去掉页首多余空行与页尾空白。 */
function cleanPage(content) {
  return String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

/**
 * 组装 txt：每页/每张以页标开头，页与页之间空一行，结尾补一个换行。
 * （与现库 work/外部资料_txt 的格式一致；空页只留页标行。）
 */
function joinPages(contents, kind) {
  if (contents.length === 0) return '';
  const blocks = contents.map((content, index) => {
    const body = cleanPage(content);
    const marker = pageMarker(index + 1, kind);
    return body.length > 0 ? `${marker}\n${body}` : marker;
  });
  return blocks.join('\n\n') + '\n';
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/** zip 安全阀：条目总数或解压后单条目过大 → 'lit: 压缩包异常'。 */
function unzipGuarded(bytes, accept) {
  let entries = 0;
  try {
    return unzipSync(bytes, {
      filter(file) {
        entries += 1;
        if (entries > MAX_ZIP_ENTRIES) throw litError('压缩包异常');
        if (typeof file.originalSize === 'number' && file.originalSize > MAX_ENTRY_BYTES) {
          throw litError('压缩包异常');
        }
        return accept(file.name);
      },
    });
  } catch (error) {
    if (isLitError(error)) throw error;
    throw litError('压缩包异常');
  }
}

/** XML 实体反转义；只做正则替换，不走 XML 解析器（不碰外部实体）。 */
function xmlUnescape(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|apos|#[xX][0-9a-fA-F]+|#\d+);/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      default:
        break;
    }
    const body = entity.slice(1, -1);
    const codePoint =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

function collectText(fragment, regex) {
  let text = '';
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(fragment)) !== null) text += xmlUnescape(match[1]);
  return text;
}

/**
 * docx：按 </w:p> 切段；段内遇到分页符就开新页（分页符之后的文字进下一页）。
 * 整篇无分页符 → 只有 p1（SPEC 已列的已知局限）。
 */
function splitDocxPages(xml) {
  const pages = [''];
  for (const paragraph of String(xml ?? '').split('</w:p>')) {
    let cursor = 0;
    let match;
    WORD_PAGE_BREAK_RE.lastIndex = 0;
    while ((match = WORD_PAGE_BREAK_RE.exec(paragraph)) !== null) {
      pages[pages.length - 1] += collectText(paragraph.slice(cursor, match.index), WORD_TEXT_RE) + '\n';
      pages.push('');
      cursor = match.index + match[0].length;
    }
    pages[pages.length - 1] += collectText(paragraph.slice(cursor), WORD_TEXT_RE) + '\n';
  }
  return pages;
}

/** pptx：每张 slide 按 <a:p> 分段，段内 <a:t> 拼接，段间换行。 */
function extractSlideText(xml) {
  const lines = [];
  for (const paragraph of String(xml ?? '').split('</a:p>')) {
    const runs = [];
    let match;
    PPT_TEXT_RE.lastIndex = 0;
    while ((match = PPT_TEXT_RE.exec(paragraph)) !== null) runs.push(xmlUnescape(match[1]));
    if (runs.length > 0) lines.push(runs.join(''));
  }
  return lines.join('\n');
}

function defaultIo() {
  return {
    async readBytes(absPath) {
      return new Uint8Array(await readFile(absPath));
    },
    async readText(absPath) {
      return await readFile(absPath, 'utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// OCR 钩子（契约 §6）
// ---------------------------------------------------------------------------

function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeMaxPages(maxPages) {
  const number = Number(maxPages);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_MAX_PAGES;
}

function assertPageLimit(pages, maxPages) {
  if (pages > maxPages) throw litError(`页数 ${pages} 超过 maxPages=${maxPages}`);
}

/** 配置里 ocr: { command, args, timeoutMs, render }；command 缺失 = 不可用。 */
function normalizeOcr(ocr) {
  const source = ocr && typeof ocr === 'object' ? ocr : {};
  const command = typeof source.command === 'string' ? source.command.trim() : '';
  if (command === '') return { configured: false };
  const args =
    Array.isArray(source.args) && source.args.length > 0
      ? source.args.map((arg) => String(arg))
      : OCR_COMMAND_DEFAULT_ARGS;
  return {
    configured: true,
    command,
    args,
    timeoutMs: positiveNumber(source.timeoutMs, OCR_DEFAULT_TIMEOUT_MS),
    render: normalizeOcrRender(source.render, source.timeoutMs),
  };
}

function normalizeOcrRender(render, fallbackTimeoutMs) {
  const source = render && typeof render === 'object' ? render : {};
  const command =
    typeof source.command === 'string' && source.command.trim() !== ''
      ? source.command.trim()
      : OCR_RENDER_DEFAULT_COMMAND;
  const args =
    Array.isArray(source.args) && source.args.length > 0
      ? source.args.map((arg) => String(arg))
      : OCR_RENDER_DEFAULT_ARGS;
  return {
    command,
    args,
    timeoutMs: positiveNumber(
      source.timeoutMs,
      positiveNumber(fallbackTimeoutMs, OCR_RENDER_DEFAULT_TIMEOUT_MS),
    ),
  };
}

/** {input} {output} {outdir} {prefix} 四种占位符；不认识的占位符原样保留。 */
function fillPlaceholders(args, values) {
  return args.map((arg) =>
    String(arg).replace(/\{(input|output|outdir|prefix)\}/g, (whole, key) =>
      values[key] === undefined ? whole : values[key],
    ),
  );
}

/**
 * 跑外部命令：stdio 全部 ignore（避免沙箱管道问题），用 Promise 等 close。
 * 启动失败 / 超时 / 非 0 退出码 → 'lit: ' 错误。
 */
function runCommand({ command, args, timeoutMs, what }) {
  const label = what ? `${what}（${command}）` : command;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(litError(`${label} 启动失败：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退出
      }
      reject(litError(`${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(litError(`${label} 启动失败：${error instanceof Error ? error.message : String(error)}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(litError(`${label} 失败（退出码 ${code === null || code === undefined ? signal : code}）`));
    });
  });
}

/** 按文件名里的页码数字排序（page-1.png / page-01.png 都排得对）。 */
function sortPngByPageNumber(names) {
  const keyed = names.map((name) => {
    const matches = String(name).match(/(\d+)(?=\.[^.]+$)/);
    return { name, number: matches ? Number(matches[1]) : null };
  });
  keyed.sort((left, right) => {
    if (left.number !== null && right.number !== null) return left.number - right.number;
    if (left.number !== null) return -1;
    if (right.number !== null) return 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return keyed.map((item) => item.name);
}

/** 栅格化：render 在 workDir 里写出 prefix-*.png；必须恰好 pageCount 张。 */
async function rasterizePdf({ absPath, render, workDir, pageCount }) {
  const prefix = OCR_RENDER_PREFIX;
  const args = fillPlaceholders(render.args, { input: absPath, outdir: workDir, prefix });
  await runCommand({ command: render.command, args, timeoutMs: render.timeoutMs, what: 'PDF 栅格化' });
  const entries = await readdir(workDir);
  const pngs = entries.filter((name) => /\.png$/i.test(name));
  if (pngs.length !== pageCount) {
    throw litError(`PDF 栅格化页数不符：期望 ${pageCount} 张 png，实际 ${pngs.length} 张`);
  }
  return sortPngByPageNumber(pngs).map((name) => join(workDir, name));
}

/** 逐页跑 OCR 命令；{input}=png，{output}=txt，返回每页文本。 */
async function ocrPdfPages({ pngPaths, ocr, workDir }) {
  const contents = [];
  for (let index = 0; index < pngPaths.length; index += 1) {
    const pageNumber = index + 1;
    const outputPath = join(workDir, `ocr-${pageNumber}.txt`);
    const args = fillPlaceholders(ocr.args, { input: pngPaths[index], output: outputPath });
    await runCommand({
      command: ocr.command,
      args,
      timeoutMs: ocr.timeoutMs,
      what: `OCR 第 ${pageNumber} 页`,
    });
    try {
      contents.push(String(await readFile(outputPath, 'utf8')));
    } catch {
      throw litError(`OCR 第 ${pageNumber} 页没有输出文本（${outputPath}）`);
    }
  }
  return contents;
}

/** 扫描件：未配 OCR 返回“待 OCR”结果（不抛错），配了就走 OCR。 */
async function extractScannedPdf({ absPath, pages, ocr }) {
  if (!ocr.configured) {
    return {
      kind: 'pdf',
      pages,
      text: '',
      language: 'other',
      scanned: true,
      notes: ['扫描件：没有文本层，需 OCR', OCR_NO_COMMAND_REASON],
      ocr: { configured: false, used: false, reason: OCR_NO_COMMAND_REASON },
    };
  }
  const workDir = await mkdtemp(join(tmpdir(), OCR_TMP_PREFIX));
  try {
    const pngPaths = await rasterizePdf({ absPath, render: ocr.render, workDir, pageCount: pages });
    const ocrContents = await ocrPdfPages({ pngPaths, ocr, workDir });
    const output = joinPages(ocrContents, 'page');
    return {
      kind: 'pdf',
      pages,
      text: output,
      language: detectLanguage(output),
      scanned: false,
      notes: ['扫描件：没有文本层，已用 OCR 抽取', OCR_NOTE_SOURCE],
      ocr: { configured: true, used: true },
    };
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响抽取结果
    }
  }
}

async function extractPdf(io, absPath, ocr, maxPages) {
  const bytes = await io.readBytes(absPath);
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false });
    const pages =
      Number.isInteger(totalPages) && totalPages > 0
        ? totalPages
        : Array.isArray(text) && text.length > 0
          ? text.length
          : 1;
    assertPageLimit(pages, maxPages);
    const rawPages = Array.isArray(text) ? text : [String(text ?? '')];
    const contents = Array.from({ length: pages }, (_, index) => rawPages[index] ?? '');
    if (isScannedPages(contents)) {
      return await extractScannedPdf({ absPath, pages, ocr });
    }
    const notes = [];
    const emptyPages = contents.filter((page) => String(page ?? '').trim().length === 0).length;
    if (emptyPages > 0) notes.push(`有 ${emptyPages} 页无文本层`);
    const output = joinPages(contents, 'page');
    return {
      kind: 'pdf',
      pages,
      text: output,
      language: detectLanguage(output),
      scanned: false,
      notes,
      ocr: { configured: ocr.configured, used: false },
    };
  } finally {
    if (doc && typeof doc.destroy === 'function') {
      try {
        await doc.destroy();
      } catch {
        // 释放失败不影响抽取结果
      }
    }
  }
}

async function extractDocx(io, absPath, ocr, maxPages) {
  const bytes = await io.readBytes(absPath);
  const files = unzipGuarded(bytes, (name) => name === 'word/document.xml');
  const documentXml = files['word/document.xml'];
  if (!documentXml) throw litError('不是有效的 docx');
  const contents = splitDocxPages(decodeUtf8(documentXml));
  assertPageLimit(contents.length, maxPages);
  const output = joinPages(contents, 'page');
  return {
    kind: 'docx',
    pages: contents.length,
    text: output,
    language: detectLanguage(output),
    scanned: false,
    notes: [],
    ocr: { configured: ocr.configured, used: false },
  };
}

async function extractPptx(io, absPath, ocr, maxPages) {
  const bytes = await io.readBytes(absPath);
  const files = unzipGuarded(bytes, (name) => SLIDE_ENTRY_RE.test(name));
  const slides = Object.keys(files)
    .map((name) => ({ name, number: Number(name.match(SLIDE_ENTRY_RE)[1]) }))
    .sort((a, b) => a.number - b.number);
  const contents = slides.map((slide) => extractSlideText(decodeUtf8(files[slide.name])));
  assertPageLimit(contents.length, maxPages);
  const notes = [];
  if (contents.length === 0) notes.push('pptx 里没有幻灯片');
  // 页标 N 固定为“排序后的位置”（1 起连续），不直接用文件名里的 N。
  const output = joinPages(contents, 'slide');
  return {
    kind: 'pptx',
    pages: contents.length,
    text: output,
    language: detectLanguage(output),
    scanned: false,
    notes,
    ocr: { configured: ocr.configured, used: false },
  };
}

async function extractPlain(io, absPath, kind, ocr) {
  const raw = String(await io.readText(absPath)).replace(/^\uFEFF/, '');
  const output = joinPages([raw], 'page');
  return {
    kind,
    pages: 1,
    text: output,
    language: detectLanguage(output),
    scanned: false,
    notes: [],
    ocr: { configured: ocr.configured, used: false },
  };
}

/**
 * 抽取入口。返回 { kind, pages, text, language, scanned, notes, ocr }。
 * 任何失败都抛 message 以 'lit: ' 开头的 Error。
 * 扫描件未配 OCR 不抛错（text 为空、ocr.reason 说明原因），library 据此写“待 OCR”行。
 */
export async function extractDocument({ absPath, ext, io, ocr, maxPages } = {}) {
  try {
    const normalized = toExt(ext);
    if (!normalized || !SUPPORTED_EXTS.includes(normalized)) {
      throw litError(`不支持的格式：${ext === undefined ? '(空)' : String(ext)}（支持 ${SUPPORTED_EXTS.join(' / ')}）`);
    }
    if (normalized === '.ppt') throw new Error(LEGACY_PPT_MESSAGE);
    if (typeof absPath !== 'string' || absPath.length === 0) throw litError('缺少文件路径');

    const activeIo = io && typeof io.readBytes === 'function' ? io : defaultIo();
    const ocrConfig = normalizeOcr(ocr);
    const pageLimit = normalizeMaxPages(maxPages);
    switch (normalized) {
      case '.pdf':
        return await extractPdf(activeIo, absPath, ocrConfig, pageLimit);
      case '.docx':
        return await extractDocx(activeIo, absPath, ocrConfig, pageLimit);
      case '.pptx':
        return await extractPptx(activeIo, absPath, ocrConfig, pageLimit);
      case '.txt':
        return await extractPlain(activeIo, absPath, 'txt', ocrConfig);
      case '.md':
        return await extractPlain(activeIo, absPath, 'md', ocrConfig);
      default:
        throw litError(`不支持的格式：${ext}`);
    }
  } catch (error) {
    if (isLitError(error)) throw error;
    throw litError(error instanceof Error ? error.message : String(error));
  }
}
