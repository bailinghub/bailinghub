/** Operator-entered policy for the selected provider route, never inferred from a model name. */
export interface BudgetConfig {
  maxOutputTokens: number;
  defaultOutputTokens?: number;
  outputTokenParameter?: 'max_tokens'|'max_completion_tokens';
  outputBudgetScope?: 'completion_total'|'final_answer';
  modelMaxOutputTokens?: number;
}
export interface BudgetForm {
  budgetMode: 'legacy'|'explicit';
  maxOutputTokens: number|undefined;
  defaultOutputTokens: number|undefined;
  outputTokenParameter: ''|'max_tokens'|'max_completion_tokens';
  outputBudgetScope: ''|'completion_total'|'final_answer';
  modelMaxOutputTokens: number|undefined;
}
export const newBudgetForm = (): BudgetForm => ({budgetMode:'explicit',maxOutputTokens:undefined,
  defaultOutputTokens:undefined,outputTokenParameter:'',outputBudgetScope:'',modelMaxOutputTokens:undefined});
export function readBudgetForm(config: BudgetConfig): BudgetForm {
  const explicit = ['defaultOutputTokens','outputTokenParameter','outputBudgetScope','modelMaxOutputTokens']
    .some(key => config[key as keyof BudgetConfig] !== undefined);
  return {...newBudgetForm(),budgetMode:explicit?'explicit':'legacy',maxOutputTokens:config.maxOutputTokens,
    defaultOutputTokens:config.defaultOutputTokens,outputTokenParameter:config.outputTokenParameter ?? '',
    outputBudgetScope:config.outputBudgetScope ?? '',modelMaxOutputTokens:config.modelMaxOutputTokens};
}
export function clearVerifiedBudgetRoute(form: BudgetForm) {
  form.outputTokenParameter='';form.outputBudgetScope='';form.modelMaxOutputTokens=undefined;
}
export function writeBudgetConfig(form: BudgetForm, purpose: 'chat'|'tool'): BudgetConfig {
  // Existing tool schemas require this inert compatibility field. It is not an image-token budget.
  if (purpose === 'tool') return {maxOutputTokens:form.maxOutputTokens ?? 8192};
  const integer = (value: number|undefined, label: string, max: number) => {
    if (!Number.isInteger(value) || value! < 1 || value! > max) throw new Error(`${label}须为 1–${max.toLocaleString('en-US')} 的整数。`);
    return value!;
  };
  const maxOutputTokens=integer(form.maxOutputTokens,'服务输出上限',131072);
  if(form.budgetMode==='legacy') return {maxOutputTokens};
  const defaultOutputTokens=integer(form.defaultOutputTokens,'默认输出预算',maxOutputTokens);
  if (!['max_tokens','max_completion_tokens'].includes(form.outputTokenParameter)) throw new Error('请核对供应商路由并选择输出参数。');
  if (!['completion_total','final_answer'].includes(form.outputBudgetScope)) throw new Error('请选择输出预算是否包含思考。');
  if(form.outputTokenParameter==='max_completion_tokens' && form.outputBudgetScope!=='completion_total') throw new Error('max_completion_tokens 须使用含思考的总输出预算。');
  const modelMaxOutputTokens=form.modelMaxOutputTokens===undefined?undefined:integer(form.modelMaxOutputTokens,'已核供应商上限',10000000);
  if(modelMaxOutputTokens!==undefined && maxOutputTokens>modelMaxOutputTokens) throw new Error('服务输出上限不能超过已核供应商上限。');
  return {maxOutputTokens,defaultOutputTokens,outputTokenParameter:form.outputTokenParameter as BudgetConfig['outputTokenParameter'],
    outputBudgetScope:form.outputBudgetScope as BudgetConfig['outputBudgetScope'],...(modelMaxOutputTokens===undefined?{}:{modelMaxOutputTokens})};
}
