// Runtime transport budgets; business capability field limits remain independent.
// Count the UTF-8 bytes of JSON.stringify(arguments), including JSON escaping.
export const TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
export const TOOL_INVOCATION_BODY_MAX_BYTES = 2 * 1024 * 1024;

export interface ToolInputLimitDetails {
  origin: 'core';
  dispatch: 'not_dispatched';
  limit_scope: 'arguments' | 'request_body';
  max_bytes: number;
  /** Exact serialized arguments size. Never includes argument contents. */
  actual_bytes?: number;
  /** Bytes read before stopping an oversized stream; the full body can be larger. */
  observed_bytes?: number;
}
