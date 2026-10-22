import type { UsageServiceConfig } from './contracts';
import { UsageError, usageAssert } from './errors';
import { integer } from './validation';

export const OUTPUT_TOKEN_PARAMETERS = ['max_tokens', 'max_completion_tokens'] as const;
export const OUTPUT_BUDGET_SCOPES = ['completion_total', 'final_answer'] as const;
export type OutputTokenParameter = typeof OUTPUT_TOKEN_PARAMETERS[number];
export type OutputBudgetScope = typeof OUTPUT_BUDGET_SCOPES[number];

export interface OutputBudgetPolicy {
  defaultTokens: number;
  maxTokens: number;
  parameter: OutputTokenParameter;
  scope: OutputBudgetScope;
  modelMaxTokens?: number;
}

export interface OutputBudgetDescriptor {
  default_output_tokens?: number;
  output_token_parameter?: OutputTokenParameter;
  output_budget_scope?: OutputBudgetScope;
  model_max_output_tokens?: number;
}

/** An operator selects verified provider semantics; model names never imply a policy. */
export function outputBudgetPolicy(config: UsageServiceConfig): OutputBudgetPolicy | null {
  const fields = [config.defaultOutputTokens, config.outputTokenParameter, config.outputBudgetScope];
  const present = fields.filter(value => value !== undefined).length;
  if (present === 0 && config.modelMaxOutputTokens === undefined) return null;
  usageAssert(config.purpose !== 'tool', 'USAGE_INVALID_INPUT', 'Image/model tools do not use a chat output budget.', 400);
  usageAssert(present === fields.length, 'USAGE_INVALID_INPUT', 'Configure the output default, parameter and scope together.', 400);
  const maxTokens = integer(config.maxOutputTokens, 'maxOutputTokens', 1, 131072);
  const defaultTokens = integer(config.defaultOutputTokens, 'defaultOutputTokens', 1, maxTokens);
  usageAssert(OUTPUT_TOKEN_PARAMETERS.includes(config.outputTokenParameter!), 'USAGE_INVALID_INPUT', 'Unsupported output token parameter.', 400);
  usageAssert(OUTPUT_BUDGET_SCOPES.includes(config.outputBudgetScope!), 'USAGE_INVALID_INPUT', 'Unsupported output budget scope.', 400);
  usageAssert(config.outputTokenParameter !== 'max_completion_tokens' || config.outputBudgetScope === 'completion_total',
    'USAGE_INVALID_INPUT', 'max_completion_tokens requires a completion_total budget.', 400);
  let modelMaxTokens: number | undefined;
  if (config.modelMaxOutputTokens !== undefined) {
    modelMaxTokens = integer(config.modelMaxOutputTokens, 'modelMaxOutputTokens', 1, 10000000);
    usageAssert(maxTokens <= modelMaxTokens, 'USAGE_INVALID_INPUT', 'The service output ceiling exceeds the verified model maximum.', 400);
  }
  return { defaultTokens, maxTokens, parameter: config.outputTokenParameter!, scope: config.outputBudgetScope!,
    ...(modelMaxTokens === undefined ? {} : { modelMaxTokens }) };
}

/** Old descriptors omit the new group rather than inventing provider semantics. */
export function outputBudgetDescriptor(config: UsageServiceConfig): OutputBudgetDescriptor {
  const policy = outputBudgetPolicy(config);
  return policy ? {
    default_output_tokens: policy.defaultTokens,
    output_token_parameter: policy.parameter,
    output_budget_scope: policy.scope,
    ...(policy.modelMaxTokens === undefined ? {} : { model_max_output_tokens: policy.modelMaxTokens }),
  } : {};
}

export function resolveOutputBudget(config: UsageServiceConfig, options: Record<string, unknown>): {
  parameter: OutputTokenParameter; tokens: number;
} {
  const policy = outputBudgetPolicy(config);
  const supplied = OUTPUT_TOKEN_PARAMETERS.find(key => options[key] !== undefined);
  if (policy && supplied && supplied !== policy.parameter) throw new UsageError('USAGE_OUTPUT_PARAMETER_MISMATCH',
    `Use ${policy.parameter} for this service's ${policy.scope} output budget. Refresh the model descriptor before preparing a new request.`, 400,
    { output_budget: { expected_parameter: policy.parameter, scope: policy.scope } });
  const parameter = policy?.parameter ?? supplied ?? 'max_tokens';
  const tokens = Number(options[parameter] ?? policy?.defaultTokens ?? config.maxOutputTokens);
  if (tokens > config.maxOutputTokens) throw new UsageError('USAGE_OUTPUT_LIMIT',
    'The requested output limit exceeds the model service limit.', 413,
    { output_limit: { actual: tokens, allowed: config.maxOutputTokens, parameter,
      ...(policy ? { scope: policy.scope } : {}) } });
  return { parameter, tokens };
}
