// 防注入越界：抹掉本系统的栅栏标记，防不可信内容伪造"闭合"标记（如 【/知识参考】、</task>）跳出数据区、把后续文字当指令执行。
// 四个不可信面统一在这里过一遍：知识库命中内容 / 工具返回 / 对话历史（注入时）、以及用户主输入（塞进 <task> 包裹前）。
// 关键时序：launchJob 拼的合法系统块（【知识参考】等）是在「原始用户输入已抹除之后」才前置上去的，故合法栅栏不会被误删。
// 这是减速带不是边界——真正的兜底仍是只读工具白名单 + 业务侧自校参数 + 审批车道（见 docs/TOOLS_DESIGN.md §11）。
export const FENCE_TOKENS = ['【知识参考】', '【/知识参考】', '【会话背景】', '【/会话背景】', '<task>', '</task>'];

export function stripFenceTokens(s: string): string {
  let out = s;
  for (const t of FENCE_TOKENS) out = out.split(t).join('');
  return out;
}
