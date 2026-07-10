import type { FileRef } from '../../core/platform/content';
import type { ResolvedCredential } from './perception';

export interface FileConfig {
  /** 文件处理凭证名；留空复用 brain 凭证 */
  credential?: string;
  /** 文件摘要模型；留空用凭证默认模型 */
  model?: string;
  /** extract=中枢抽取文本；summarize=抽取后用模型摘要；inline=仅保留文件链接给具备文件能力的模型/执行器；off=忽略文件 */
  mode?: 'extract' | 'summarize' | 'inline' | 'off';
  /** 单文件最大字节数，默认 FILE_MAX_BYTES_DEFAULT */
  max_bytes?: number;
  /** 注入给大脑的最大字符数，默认 FILE_MAX_CHARS_DEFAULT */
  max_chars?: number;
  /** 派发时由中枢注入的已解析凭证。 */
  _db_credential?: ResolvedCredential;
}

export const FILE_MODE_DEFAULT: 'extract' = 'extract';
export const FILE_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;
export const FILE_MAX_CHARS_DEFAULT = 24000;
export const FILE_TIMEOUT_MS = 60000;

const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|x-ndjson|yaml|x-yaml|javascript|x-javascript)|.+\+(json|xml))($|;)/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|jsonl|log|html?|xml|yaml|yml|ini|conf|sql|tsv)(\?|$)/i;
const PDF_MIME = /^application\/pdf$/i;
const PDF_EXT = /\.pdf(\?|$)/i;
const DOCX_MIME = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i;
const DOCX_EXT = /\.docx(\?|$)/i;
const UNSUPPORTED_STRUCTURED_EXT = /\.(doc|xlsx?|pptx?|zip|rar|7z)(\?|$)/i;

interface FileExtractResult {
  ok: boolean;
  parser: 'text' | 'pdf' | 'docx' | 'unsupported';
  text: string;
  pages?: number;
}

export function resolveFile(
  llmCredentials: Record<string, ResolvedCredential>,
  fcfg: FileConfig | undefined,
  brainCred: ResolvedCredential | undefined,
  brainCredName: string,
): { cred: ResolvedCredential; model: string } | null {
  if (!fcfg) return null;
  const credName = String(fcfg.credential ?? brainCredName ?? '');
  const cred =
    (credName && llmCredentials[credName]) ||
    fcfg._db_credential ||
    (credName && credName === brainCredName ? brainCred : undefined);
  if (!cred) return null;
  const model = String(fcfg.model ?? cred.default_model ?? '');
  if (!model) return null;
  return { cred, model };
}

function fileName(file: FileRef, index: number): string {
  const fromUrl = (() => { try { return decodeURIComponent(new URL(file.url).pathname.split('/').pop() || ''); } catch { return ''; } })();
  return (file.name || fromUrl || `file-${index + 1}`).slice(0, 120);
}

function looksText(url: string, mime: string): boolean {
  return TEXT_MIME.test(mime) || TEXT_EXT.test(url);
}

function looksPdf(url: string, mime: string): boolean {
  return PDF_MIME.test(mime) || PDF_EXT.test(url);
}

function looksDocx(url: string, mime: string): boolean {
  return DOCX_MIME.test(mime) || DOCX_EXT.test(url);
}

function trimChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[已截断：原文 ${text.length} 字符，当前仅注入前 ${maxChars} 字符]`;
}

async function extractPdfText(ab: ArrayBuffer): Promise<FileExtractResult> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(ab),
      disableFontFace: true,
      useWorkerFetch: false,
      standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item: unknown) => {
            const str = (item as { str?: unknown }).str;
            return typeof str === 'string' ? str : '';
          })
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) pages.push(`--- PDF 第 ${i} 页 ---\n${text}`);
      }
      const text = pages.join('\n\n').trim();
      return {
        ok: !!text,
        parser: 'pdf',
        pages: doc.numPages,
        text: text || 'PDF 未抽取到可用文本。它可能是扫描件/图片型 PDF，需要启用 OCR、视觉文档解析模型，或让业务侧提供文本化内容。',
      };
    } finally {
      await doc.destroy();
    }
  } catch (e) {
    return { ok: false, parser: 'pdf', text: `PDF 文本抽取失败：${String(e).slice(0, 300)}` };
  }
}

async function extractDocxText(ab: ArrayBuffer): Promise<FileExtractResult> {
  try {
    const mammothMod = await import('mammoth');
    const mammoth = mammothMod.default ?? mammothMod;
    const got = await mammoth.extractRawText({ buffer: Buffer.from(ab) });
    const text = String(got.value ?? '').replace(/\u0000/g, '').trim();
    return {
      ok: !!text,
      parser: 'docx',
      text: text || 'DOCX 未抽取到可用文本。它可能主要由图片、附件或复杂对象构成，需要 OCR/业务侧解析器处理。',
    };
  } catch (e) {
    return { ok: false, parser: 'docx', text: `DOCX 文本抽取失败：${String(e).slice(0, 300)}` };
  }
}

async function extractFileText(file: FileRef, mime: string, ab: ArrayBuffer): Promise<FileExtractResult> {
  if (looksText(file.url, mime)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(ab).replace(/\u0000/g, '');
    return { ok: true, parser: 'text', text: text.trim() || '（文件为空）' };
  }
  if (looksPdf(file.url, mime)) return extractPdfText(ab);
  if (looksDocx(file.url, mime)) return extractDocxText(ab);
  const family = UNSUPPORTED_STRUCTURED_EXT.test(file.url) ? '结构化/压缩' : '二进制';
  return {
    ok: false,
    parser: 'unsupported',
    text: `该${family}文件暂未在中枢本地抽取文本（${mime || 'unknown'}）。请改用 CSV/TXT/Markdown/DOCX/PDF 文本版，或将文件策略切到「直送大脑」/ 接入专用文件解析模型或业务解析器：${file.url}`,
  };
}

async function fetchFile(file: FileRef, index: number, maxBytes: number): Promise<{ ok: boolean; name: string; mime?: string; bytes?: number; parser?: string; pages?: number; text: string }> {
  const name = fileName(file, index);
  try {
    const resp = await fetch(file.url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!resp.ok) return { ok: false, name, text: `文件下载失败（HTTP ${resp.status}）：${file.url}` };
    const mime = String(resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) return { ok: false, name, mime, bytes: ab.byteLength, text: `文件过大（${ab.byteLength} bytes > ${maxBytes} bytes），未读取内容：${file.url}` };
    const extracted = await extractFileText(file, mime, ab);
    return {
      ok: extracted.ok,
      name,
      mime: mime || 'application/octet-stream',
      bytes: ab.byteLength,
      parser: extracted.parser,
      ...(extracted.pages != null ? { pages: extracted.pages } : {}),
      text: extracted.text,
    };
  } catch (e) {
    const isTimeout = (e as Error)?.name === 'TimeoutError';
    return { ok: false, name, text: isTimeout ? `文件下载超时（${FILE_TIMEOUT_MS}ms）：${file.url}` : `文件读取失败：${String(e).slice(0, 200)}` };
  }
}

async function summarizeFile(opts: {
  cred: ResolvedCredential;
  model: string;
  name: string;
  text: string;
  maxChars: number;
}): Promise<string> {
  const url = opts.cred.base_url.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: opts.model,
    stream: false,
    messages: [
      { role: 'system', content: '你是文件阅读助手。只基于提供的文件文本做摘要，保留关键数字、实体、结论和待办；不要补充文件里没有的信息。' },
      { role: 'user', content: `文件名：${opts.name}\n\n文件文本：\n${trimChars(opts.text, opts.maxChars)}` },
    ],
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.cred.api_key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return `文件摘要失败（HTTP ${resp.status}）：${t.slice(0, 200)}`;
  }
  const data = await resp.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }> };
  return String(data?.choices?.[0]?.message?.content ?? '').trim() || '文件摘要模型返回空内容';
}

export async function buildFileContext(opts: {
  files: FileRef[];
  config: FileConfig | undefined;
  resolved?: { cred: ResolvedCredential; model: string } | null;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}): Promise<string> {
  const cfg = opts.config ?? {};
  const mode = cfg.mode === 'summarize' || cfg.mode === 'inline' || cfg.mode === 'off' || cfg.mode === 'extract'
    ? cfg.mode
    : FILE_MODE_DEFAULT;
  if (!opts.files.length || mode === 'off' || mode === 'inline') return '';

  const maxBytes = Math.max(1024, Math.min(Number(cfg.max_bytes ?? FILE_MAX_BYTES_DEFAULT) || FILE_MAX_BYTES_DEFAULT, 100 * 1024 * 1024));
  const maxChars = Math.max(1000, Math.min(Number(cfg.max_chars ?? FILE_MAX_CHARS_DEFAULT) || FILE_MAX_CHARS_DEFAULT, 200000));
  const lines: string[] = [];
  const perFileChars = Math.max(1000, Math.floor(maxChars / Math.max(1, opts.files.length)));

  for (let i = 0; i < opts.files.length; i++) {
    const file = opts.files[i]!;
    const fetched = await fetchFile(file, i, maxBytes);
    opts.audit?.('file_input', {
      mode,
      index: i,
      ok: fetched.ok,
      name: fileName(file, i),
      mime: fetched.mime,
      bytes: fetched.bytes,
      parser: fetched.parser,
      pages: fetched.pages,
      ...(!fetched.ok ? { error: fetched.text.slice(0, 500) } : {}),
      url: file.url,
    });
    if (!fetched.ok) {
      lines.push(`文件 ${i + 1}（${fetched.name}）：${fetched.text}`);
      continue;
    }
    if (mode === 'summarize' && opts.resolved) {
      const summary = await summarizeFile({ cred: opts.resolved.cred, model: opts.resolved.model, name: fetched.name, text: fetched.text, maxChars: perFileChars });
      lines.push(`文件 ${i + 1}（${fetched.name}）摘要：\n${summary}`);
    } else {
      lines.push(`文件 ${i + 1}（${fetched.name}）文本：\n${trimChars(fetched.text, perFileChars)}`);
    }
  }
  return `[用户附带了 ${opts.files.length} 个文件，中枢处理结果如下]\n${lines.join('\n\n')}`;
}
