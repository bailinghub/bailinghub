/**
 * 结构化输出提取（仅 structuredOutput=true 的能力档使用）。
 * 中枢不预设任何业务 schema——输出长什么样由该档的系统提示词约定，这里只负责
 * 从模型最终文本中宽容地拎出一个 JSON 对象（裸 JSON / 代码块围栏 / 夹杂文字均可）。
 * 解析不出返回 parseError，调用方落 raw 兜底，绝不丢结果。
 */
export function extractReport(raw: string): { report?: Record<string, unknown>; parseError?: string } {
  const obj = extractJsonObject(raw);
  if (!obj) return { parseError: '未能从模型输出中解析出 JSON 对象' };
  return { report: obj };
}

function extractJsonObject(s: string): Record<string, unknown> | null {
  const text = (s ?? '').trim();
  if (!text) return null;

  const candidates: string[] = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}
