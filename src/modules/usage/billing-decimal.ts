import { UsageError, usageAssert } from './errors';

export const USD_SCALE = 1_000_000_000_000n;
const MAX_DECIMAL = 10n ** 30n - 1n;
/** Parse decimal/scientific notation without multiplying a binary floating point value. */
export function usdMicros(value: string | number, name = 'amount'): bigint {
  usageAssert((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string',
    'USAGE_INVALID_INPUT', `${name} must be a finite decimal.`, 400);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  usageAssert(match, 'USAGE_INVALID_INPUT', `${name} must be a nonnegative decimal.`, 400);
  const exponent = Number(match[3] ?? 0), fraction = match[2] ?? '';
  usageAssert(Number.isInteger(exponent) && Math.abs(exponent) <= 30, 'USAGE_INVALID_INPUT', `${name} is outside the decimal range.`, 400);
  const coefficient = BigInt(match[1]! + fraction), shift = 12 + exponent - fraction.length;
  let micros: bigint;
  if (shift >= 0) micros = coefficient * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    usageAssert(coefficient % divisor === 0n, 'USAGE_INVALID_INPUT', `${name} allows at most twelve decimal places.`, 400);
    micros = coefficient / divisor;
  }
  usageAssert(micros <= MAX_DECIMAL, 'USAGE_INVALID_INPUT', `${name} is outside the decimal range.`, 400);
  return micros;
}
export function usdDecimal(micros: bigint): string {
  usageAssert(micros >= 0n && micros <= MAX_DECIMAL, 'METERING_UNAVAILABLE', 'The recorded amount exceeds the accounting range.', 503);
  const fractional = String(micros % USD_SCALE).padStart(12, '0').replace(/0+$/, '');
  return `${micros / USD_SCALE}${fractional ? `.${fractional}` : ''}`;
}
/** Never silently round persisted decimal evidence when serializing the numeric API. */
export function usdAmount(micros: bigint): number {
  const value = Number(usdDecimal(micros));
  if (value > Number.MAX_SAFE_INTEGER || usdMicros(value) !== micros)
    throw new UsageError('METERING_UNAVAILABLE', 'The amount cannot be represented exactly by the numeric usage interface.', 503, { reason: 'decimal_precision' });
  return value;
}
export function positivePart(micros: bigint): bigint { return micros > 0n ? micros : 0n; }
