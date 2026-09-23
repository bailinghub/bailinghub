export class UsageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UsageError";
  }
}
export function usageAssert(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new UsageError(code, message, status);
}
