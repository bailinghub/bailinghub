/** Console estimates only. Never use these numbers to admit or settle a request. */
export interface PriceLine { billable: string; unit: string; costUsd: string; variant?: string }
export interface ReferenceQuote {
  source: 'openrouter'; modelId: string; endpointId: string; currency: 'USD'; fetchedAt: number;
  lines: PriceLine[]; tiers?: Array<{ minPromptTokens: number; lines: PriceLine[] }>;
}
export interface PriceEstimate { label: string; prices: string; estimate: string; assumption: string }
export const effectiveBillingModel = (model: string, override: string) => override.trim() || model.trim();
const money = (value: number) => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value);
const quantity = (value: number) => value >= 10000
  ? `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Math.floor(value / 100) / 100)} 万`
  : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.floor(value));
const price = (line: PriceLine) => Number(line.costUsd);
const valid = (lines: PriceLine[]) => lines.length > 0 && lines.every(l => l.costUsd.trim() !== '' && Number.isFinite(price(l)) && price(l) >= 0);

export function estimateModelAllowance(quote: ReferenceQuote | null | undefined, budget: number, multiplier: number, kind: 'chat' | 'image'): PriceEstimate[] {
  if (!quote || quote.source !== 'openrouter' || quote.currency !== 'USD' || !valid(quote.lines)) return [];
  const usable = Number.isFinite(budget) && budget > 0 && Number.isFinite(multiplier) && multiplier > 0;
  const units = (cost: number, unit: string, floor = false) => !usable ? '请填写有效价格和倍率'
    : cost === 0 ? '参考单价为 0，暂不估算可用量'
    : `约 ${floor ? Math.floor(budget / multiplier / cost).toLocaleString('zh-CN') : quantity(budget / multiplier / cost)} ${unit}`;
  if (kind === 'chat') {
    const tiers = quote.tiers ?? [];
    const scenarios = [{ minPromptTokens: 0, lines: quote.lines }, ...tiers].sort((a, b) => a.minPromptTokens - b.minPromptTokens);
    return scenarios.map((scenario, index) => {
      const { lines } = scenario;
      const inputs = lines.filter(l => l.billable === 'prompt' && l.unit === 'token');
      const outputs = lines.filter(l => l.billable === 'completion' && l.unit === 'token');
      const label = scenarios.length === 1 ? '对话' : `单次输入 ${scenario.minPromptTokens.toLocaleString('zh-CN')}${scenarios[index + 1] ? `–${(scenarios[index + 1].minPromptTokens - 1).toLocaleString('zh-CN')}` : '+'} Token`;
      if (!valid(lines) || inputs.length !== 1 || outputs.length !== 1) return { label, prices: '报价不完整', estimate: '暂无法估算', assumption: '' };
      const prices = `输入 $${money(price(inputs[0]) * 1e6)} / 百万 Token · 输出 $${money(price(outputs[0]) * 1e6)} / 百万 Token`;
      const extra = lines.some(l => !['prompt', 'completion', 'input_cache_read', 'input_cache_write'].includes(l.billable) && price(l) > 0);
      return { label, prices,
        estimate: extra ? '含额外按次费用，暂不换算 Token' : units(price(inputs[0]) * .75 + price(outputs[0]) * .25, 'Token'),
        assumption: '输入∶输出 = 3∶1，未命中缓存；全部额度仅用于此模型' };
    });
  }
  const outputs = quote.lines.filter(l => l.billable === 'output_image');
  return outputs.map(line => {
    const sameVariant = outputs.filter(l => l.variant === line.variant);
    const unit = line.unit === 'image' ? '张' : line.unit === 'megapixel' ? '百万像素' : line.unit === 'token' ? '图像 Token' : '';
    const extra = quote.lines.some(l => !['output_image', 'input_image', 'input_reference'].includes(l.billable) && price(l) > 0);
    return { label: line.variant ? line.variant.toUpperCase() : '图片',
      prices: unit ? `$${money(price(line))} / ${unit} · 倍率后 $${money(price(line) * multiplier)} / ${unit}` : '计量单位尚不支持',
      estimate: !unit || extra || sameVariant.length !== 1 ? '暂无法估算' : units(price(line), unit, line.unit === 'image'),
      assumption: `纯文生图，不含参考图；全部额度仅用于此模型${line.unit !== 'image' ? '，张数取决于每张实际用量' : ''}` };
  });
}

// Sale price is not a periodic allowance; missing period configuration stays unknown.
export function planEstimateBudget(config: {mode: 'credits'|'periodic';priceUsd:number;periodAllowanceUsd?:number}): number | null {
  const budget = config.mode === 'periodic' ? config.periodAllowanceUsd : config.priceUsd;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : null;
}
