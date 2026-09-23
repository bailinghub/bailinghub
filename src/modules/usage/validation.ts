import { usageAssert } from "./errors";
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  usageAssert(
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max,
    "USAGE_INVALID_INPUT",
    `${name} is outside the supported integer range.`,
    400,
  );
  return Number(value);
}
export function assertKnownFields(
  value: unknown,
  allowed: readonly string[],
  name: string,
): void {
  usageAssert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "USAGE_INVALID_INPUT",
    `${name} must be an object.`,
    400,
  );
  usageAssert(
    Object.keys(value).every((k) => allowed.includes(k)),
    "USAGE_INVALID_INPUT",
    `${name} contains unsupported fields.`,
    400,
  );
}
