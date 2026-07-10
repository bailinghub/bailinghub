// AI 富内容解析（CONTRACT §2.5 v2.1）：从 markdown 文本解出图片 URL / 音频 URL / 结构化 attachments（image/audio/file）。
// 纯字符串解析、零依赖；引擎(launchJob 抠图 + spawnDelivery 富内容)与聊天路由(reply/入站消息回灌)共用。
// 从一段文本里抽出图片 URL（![](url) markdown）。给多模态送图用——只在用户原始输入上调用，
// 不在装配后的 ctx.input 上调用，否则会把知识库注入的截图也误当成用户发的图。去重保序。
export function extractImageUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[1]!; if (seen.has(url)) continue; seen.add(url); out.push(url);
  }
  return out;
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|webm|flac)(\?[^)]*)?$/i;
const ATTACH_FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|markdown|json|jsonl|xml|html?|log|yaml|yml|zip|rar|7z)(\?[^)]*)?$/i;
// 负向后视只排除图片链接的 `!`，不能消费普通链接前的字符。
// 否则全局正则在相邻链接间会吃掉第二段开头的 `[`，导致附件静默丢失。
const MARKDOWN_LINK_RE = /(?<!\!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

export interface FileRef {
  url: string;
  name?: string;
}

// 从用户原始输入里抽出音频 URL。约定：聊天组件上传录音后写成 [语音：名称](url)，也兼容 audio/voice 标签与常见音频后缀。
export function extractAudioUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const label = (m[1] || '').trim().toLowerCase();
    const url = m[2]!;
    if (seen.has(url)) continue;
    if (/^(语音|音频|录音|audio|voice)\b/.test(label) || AUDIO_EXT.test(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// 从用户原始输入里抽出文件 URL。只识别普通 markdown 链接，图片/音频各走自己的通道。
export function extractFileRefs(text: string): FileRef[] {
  if (!text) return [];
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const label = (m[1] || '').trim();
    const url = m[2]!;
    if (seen.has(url)) continue;
    if (AUDIO_EXT.test(url)) continue;
    if (/^(语音|音频|录音|audio|voice)\b/i.test(label)) continue;
    if (/^(文件|附件|文档|file|document)\b/i.test(label) || ATTACH_FILE_EXT.test(url)) {
      seen.add(url);
      out.push({ url, name: label || url.split('/').pop() || '文件' });
    }
  }
  return out;
}

// 富内容契约（v2.1）：从 AI 的 markdown 回复里解析出结构化 attachments，供第三方按 type 渲染（小程序等无 md 渲染器的端用）。
// text 仍是 markdown 原文（有渲染器的端直接渲）；attachments 是解析镜像。规则与文档见 CONTRACT §2.5。
export function extractAttachments(text: string): Array<Record<string, unknown>> {
  if (!text) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  // 图片：![说明](url)
  for (const m of text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[2]!; if (seen.has(url)) continue; seen.add(url);
    const caption = (m[1] || '').trim();
    out.push(caption ? { type: 'image', url, caption } : { type: 'image', url });
  }
  // 文件/文档：普通链接 [名称](url) 且 url 命中文件后缀（图片链接前缀 ! 已排除）；普通网页链接不当附件，留在 text 内联
  for (const f of extractFileRefs(text)) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    out.push({ type: 'file', url: f.url, name: f.name || f.url.split('/').pop() || '文件' });
  }
  // 音频：普通链接 label 为语音/音频/录音/audio/voice，或 URL 命中常见音频后缀。
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const url = m[2]!; if (seen.has(url)) continue;
    const label = (m[1] || '').trim();
    if (/^(语音|音频|录音|audio|voice)\b/i.test(label) || AUDIO_EXT.test(url)) {
      seen.add(url);
      out.push({ type: 'audio', url, name: label || url.split('/').pop() || '语音' });
    }
  }
  return out;
}
