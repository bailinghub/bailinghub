// LLM 平台预设目录：控制台「模型凭证」按它给"选平台→自动带 base_url + 常用模型下拉"，只手填 Key。
// 原则：能选就不填；聚合平台(模型成百上千/需接入点ID)才退化成手填+少量建议(freeModel)。
// 都是 OpenAI 兼容 /v1 接口（中枢 llm 走 OpenAI 兼容协议）。
// 凭证层只分两条调用通道：生成/理解类（chat/vision/audio/file）与向量化（embedding）。
// 下方细分只是控制台下拉建议，实际模型名仍允许手填。
// 模型名随平台更新，列表是"常用建议"，下拉均 allow-create 可手填新模型。

export interface LlmProvider {
  id: string;
  label: string;
  base_url: string;
  chat?: string[];        // 文本对话 / 推理模型
  vision?: string[];      // 视觉理解 / 图片输入模型
  audio?: string[];       // 语音转写 / 音频理解模型（OpenAI-compatible /audio/transcriptions 或等价能力）
  file?: string[];        // 文件 / 长文档理解建议模型（仍属于生成/理解类）
  embedding?: string[];   // 向量模型（知识库与工具检索用）
  freeModel?: boolean;    // true=模型太多/需接入点ID，建议手填；列表仅作建议
  note?: string;          // 取 Key / 注意事项
  keyUrl?: string;        // 控制台拿 Key 的地址
}

// 自定义占位（base_url/模型全手填，老行为）
export const CUSTOM_PROVIDER = '__custom__';

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'dashscope', label: '阿里云百炼（通义千问 Qwen）',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chat: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
    vision: ['qwen-vl-max', 'qwen-vl-plus', 'qwen-vl-ocr'],
    file: ['qwen-long', 'qwen-max', 'qwen-plus'],
    embedding: ['text-embedding-v4', 'text-embedding-v3'],
    keyUrl: 'bailian.console.aliyun.com', note: '国内网络环境通常较稳定；Qwen2.5-VL 开源模型通常走自托管/聚合平台或专门部署，不作为百炼默认建议',
  },
  {
    id: 'deepseek', label: 'DeepSeek（深度求索）',
    base_url: 'https://api.deepseek.com/v1',
    chat: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'platform.deepseek.com', note: '主要用于文本对话/推理；视觉、语音、向量通常需另配其它平台',
  },
  {
    id: 'zhipu', label: '智谱 GLM（BigModel）',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    chat: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'],
    vision: ['glm-4v-plus', 'glm-4v', 'glm-4v-flash'],
    embedding: ['embedding-3', 'embedding-2'],
    keyUrl: 'bigmodel.cn',
  },
  {
    id: 'moonshot', label: '月之暗面 Kimi（Moonshot）',
    base_url: 'https://api.moonshot.cn/v1',
    chat: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    vision: ['moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview'],
    file: ['moonshot-v1-128k', 'moonshot-v1-32k'],
    keyUrl: 'platform.moonshot.cn', note: '长文本强；无向量模型',
  },
  {
    id: 'hunyuan', label: '腾讯混元（Hunyuan）',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1',
    chat: ['hunyuan-turbo', 'hunyuan-large', 'hunyuan-standard', 'hunyuan-pro'],
    vision: ['hunyuan-vision'],
    embedding: ['hunyuan-embedding'],
    keyUrl: 'console.cloud.tencent.com/hunyuan',
  },
  {
    id: 'qianfan', label: '百度千帆（文心 ERNIE）',
    base_url: 'https://qianfan.baidubce.com/v2',
    chat: ['ernie-4.0-8k', 'ernie-4.0-turbo-8k', 'ernie-3.5-8k', 'ernie-speed-8k'],
    embedding: ['embedding-v1', 'bge-large-zh', 'tao-8k'],
    keyUrl: 'console.bce.baidu.com/qianfan',
  },
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow（聚合）',
    base_url: 'https://api.siliconflow.cn/v1',
    chat: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    vision: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen/Qwen2-VL-72B-Instruct'],
    file: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    embedding: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
    freeModel: true, keyUrl: 'siliconflow.cn', note: '聚合多家模型，模型名带 org/ 前缀，下拉是常用建议、可手填',
  },
  {
    id: 'volcark', label: '火山方舟 豆包（Doubao / Volcengine Ark）',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    chat: ['doubao-1.5-pro-32k', 'doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'],
    vision: ['doubao-1.5-vision-pro-32k', 'doubao-vision-pro-32k'],
    freeModel: true, keyUrl: 'console.volcengine.com/ark', note: '方舟常要用「接入点 ID」(ep-…) 而非模型名，按你开通的接入点手填',
  },
  {
    id: 'openai', label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    chat: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    vision: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    audio: ['whisper-1'],
    file: ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    note: '国内需自备海外节点/代理', keyUrl: 'platform.openai.com',
  },
  {
    id: 'openrouter', label: 'OpenRouter（聚合·海外）',
    base_url: 'https://openrouter.ai/api/v1',
    chat: ['deepseek/deepseek-chat', 'anthropic/claude-3.7-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash-001'],
    vision: ['openai/gpt-4o', 'anthropic/claude-3.7-sonnet', 'google/gemini-2.0-flash-001'],
    file: ['anthropic/claude-3.7-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash-001'],
    freeModel: true, keyUrl: 'openrouter.ai/keys', note: '聚合数百模型(org/model)，国内需代理；下拉是常用建议、可手填',
  },
];

/** 按 base_url 反查平台 id（编辑已有凭证时回选平台）；不匹配返回自定义。 */
export function detectProvider(baseUrl: string): string {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  const hit = LLM_PROVIDERS.find((p) => u === p.base_url.replace(/\/+$/, ''));
  if (hit) return hit.id;
  // 宽松回退：按 host 匹配（base_url 末段被改过仍能认出平台）
  try {
    const host = new URL(u).host;
    const byHost = LLM_PROVIDERS.find((p) => new URL(p.base_url).host === host);
    if (byHost) return byHost.id;
  } catch { /* 非法 url */ }
  return CUSTOM_PROVIDER;
}
