// 感知层（多模态解耦）—— 设计与边界见 docs/TOOLS_DESIGN.md「感知层」。
//
// 为什么解耦：中枢的「大脑」（brain，target_config.model）是编排者，最重要的能力是**可靠地调用工具**；
// 而「看图」是另一种能力。把两者绑在同一个模型上很脆——很多最强的工具模型不识图（如纯文本的
// qwen-plus / deepseek），很多识图模型又不会调工具（实测 qwen-vl-max 在工具调用上 0 命中）。
// 本模块把「看图」拆成一个独立可配的**视觉模型**，通过两条路接入，让 brain 用纯文本工具模型也能间接看图：
//   - tool 模式：给 brain 一个内置工具 see_image，它按需对「图 + 问题」做一次视觉子调用，结果回流；
//   - prepass 模式：派发前先把图识别成文字，前置注入，brain 纯文本+工具正常跑。
// 这样开发者（含海外）可以任意搭配「最强工具模型 + 任意视觉模型」，不被「又能看图又能调工具的独角兽模型」绑架。

/** 解析后的模型凭证（base_url + key，可选默认模型）。与 config.ts 的 LlmCredential、bz_credentials 行兼容。 */
export interface ResolvedCredential {
  base_url: string;
  api_key: string;
  default_model?: string;
}

/** 路由 target_config.input.image：图片输入策略（全可选）。 */
export interface VisionConfig {
  /** 视觉模型凭证名（「模型凭证」注册表）；留空复用 brain 凭证（同一把 key 调不同模型） */
  credential?: string;
  /** 视觉模型；留空用凭证默认模型 */
  model?: string;
  /** 图片接入方式：tool=见图工具（推荐，最解耦）/ prepass=前置识图 / inline=直送 brain（brain 须多模态）/ off=忽略图片 */
  mode?: 'tool' | 'prepass' | 'inline' | 'off';
  /** 单次任务的视觉调用次数上限（tool 模式防刷；不占业务工具的 max_calls）。默认 VISION_MAX_CALLS_DEFAULT */
  max_calls?: number;
  /** 派发时由中枢注入的已解析凭证（key 只进本次调用内存，不落 job 快照/日志）。 */
  _db_credential?: ResolvedCredential;
}

/** 无显式 mode 且视觉模型可用时的默认接入方式：见图工具（最解耦、最 agentic）。 */
export const VISION_MODE_DEFAULT: 'tool' = 'tool';
/** tool 模式单任务视觉调用次数上限缺省值。 */
export const VISION_MAX_CALLS_DEFAULT = 6;
/** 视觉子调用超时（ms）。识图通常比纯文本慢，给足。 */
export const VISION_TIMEOUT_MS = 60000;

/** see_image 内置工具定义（OpenAI function-calling 形态）。imageCount 写进描述，让 brain 知道有几张可看。 */
export function seeImageTool(imageCount: number): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  const range = imageCount > 1 ? `序号 0..${imageCount - 1}` : '序号 0';
  return {
    type: 'function',
    function: {
      name: 'see_image',
      description:
        `查看用户本次附带的图片并回答关于图片的问题（用户共附带 ${imageCount} 张，${range}）。` +
        '需要图片里的信息时调用本工具：question 精确描述你要看什么' +
        '（如"图中员工的工号是多少""识别这张小票的金额与商品""图里的二维码内容"）；' +
        'indexes 可选，只看指定序号的图，默认看全部。返回文字描述，你可据此继续调用业务工具或作答。' +
        '不要凭空臆测图片内容——要图片信息就调用本工具拿真实识别结果。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要从图片中获取的具体信息或问题' },
          indexes: { type: 'array', items: { type: 'integer' }, description: '只看这些序号的图（从 0 开始）；省略=看全部' },
        },
        required: ['question'],
      },
    },
  };
}

/** 按 indexes 过滤图片 URL（越界/非法忽略）；indexes 为空或缺省返回全部。 */
export function selectImages(all: string[], indexes?: unknown): string[] {
  if (!Array.isArray(indexes) || !indexes.length) return all;
  const picked: string[] = [];
  for (const i of indexes) {
    const n = Number(i);
    if (Number.isInteger(n) && n >= 0 && n < all.length && !picked.includes(all[n]!)) picked.push(all[n]!);
  }
  return picked.length ? picked : all;
}

export interface VisionResult {
  ok: boolean;
  text: string;
}

/**
 * 用视觉模型对「图片 + 问题」做一次 OpenAI 兼容多模态子调用（无工具、非流式），返回文字。
 * 失败（HTTP 错误/超时/空响应）以 ok=false + 文本回传，由调用方决定如何回流——绝不抛错炸断整条任务。
 */
export async function runVision(opts: {
  cred: ResolvedCredential;
  model: string;
  images: string[];
  question: string;
  timeoutMs?: number;
}): Promise<VisionResult> {
  const { cred, model, images, question } = opts;
  if (!images.length) return { ok: false, text: '（没有可查看的图片）' };
  const url = cred.base_url.replace(/\/+$/, '') + '/chat/completions';
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: question || '请客观、详细地描述这些图片中的全部可见内容与文字。' },
    ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
  ];
  const body = {
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          '你是图像识别助手。只如实描述图片中**可见**的内容与文字（含 OCR），不要臆测看不到的信息；' +
          '信息不足以回答时明确说明"图中看不到"。回答简洁、准确、面向下游助手使用。',
      },
      { role: 'user', content },
    ],
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.api_key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? VISION_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { ok: false, text: `视觉模型调用失败（HTTP ${resp.status}）：${t.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    return { ok: !!text, text: text || '（视觉模型返回空内容）' };
  } catch (e) {
    const isTimeout = (e as Error)?.name === 'TimeoutError';
    return {
      ok: false,
      text: isTimeout
        ? `视觉模型调用超时（${opts.timeoutMs ?? VISION_TIMEOUT_MS}ms）`
        : `视觉模型调用失败：${String(e).slice(0, 200)}`,
    };
  }
}

/**
 * 解析视觉模型的「凭证 + 模型」。返回 null = 无法识图（调用方应退回 inline：把图直送 brain）。
 * 凭证优先级：config.json 凭证 > 派发注入的 _db_credential > （凭证名与 brain 相同则）复用 brain 凭证。
 */
export function resolveVision(
  llmCredentials: Record<string, ResolvedCredential>,
  vcfg: VisionConfig | undefined,
  brainCred: ResolvedCredential | undefined,
  brainCredName: string,
): { cred: ResolvedCredential; model: string } | null {
  if (!vcfg) return null;
  const credName = String(vcfg.credential ?? brainCredName ?? '');
  const cred =
    (credName && llmCredentials[credName]) ||
    vcfg._db_credential ||
    (credName && credName === brainCredName ? brainCred : undefined);
  if (!cred) return null;
  const model = String(vcfg.model ?? cred.default_model ?? '');
  if (!model) return null;
  return { cred, model };
}
