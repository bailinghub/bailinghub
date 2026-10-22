/** Discovery descriptions stay short; authored usage guidance is read explicitly by name. */
export const TOOL_DESCRIPTION_MAX_CHARS = 500;
export const TOOL_USAGE_GUIDANCE_MAX_CHARS = 32 * 1024;
export const TOOL_USAGE_GUIDANCE_MAX_BYTES = 64 * 1024;

export interface ToolUsageGuidance {
  text: string;
  truncated: boolean;
  sourceChars: number;
  sourceBytes: number;
}

/** Remove control characters without losing paragraphs or cutting a UTF-8 character. */
export function boundedToolText(value: string, maxChars: number, maxBytes = Number.POSITIVE_INFINITY): ToolUsageGuidance {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  let sourceChars = 0;
  let usedBytes = 0;
  let text = '';
  let stopped = false;
  for (const char of clean) {
    sourceChars++;
    const bytes = Buffer.byteLength(char, 'utf8');
    if (!stopped && sourceChars <= maxChars && usedBytes + bytes <= maxBytes) {
      text += char;
      usedBytes += bytes;
    } else {
      stopped = true;
    }
  }
  return { text, truncated: stopped, sourceChars, sourceBytes: Buffer.byteLength(clean, 'utf8') };
}
