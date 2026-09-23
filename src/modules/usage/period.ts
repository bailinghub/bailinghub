import { UsageError, usageAssert } from "./errors";
export interface PeriodRule {
  unit: "day" | "week" | "month";
  anchor: number;
  timezone: string;
}
type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
function parts(ms: number, zone: string): Parts {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms)))
    if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as Parts;
}
function localEpoch(p: Parts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
function resolveLocal(p: Parts, zone: string): number {
  const nominal = localEpoch(p);
  const offsets = new Set<number>();
  for (const delta of [-36, -24, -12, 0, 12, 24, 36]) {
    const t = nominal + delta * 3600000;
    offsets.add(localEpoch(parts(t, zone)) - t);
  }
  for (let minute = 0; minute <= 180; minute++) {
    const wanted = nominal + minute * 60000;
    const matches = [...offsets]
      .map((o) => wanted - o)
      .filter((t) => localEpoch(parts(t, zone)) === wanted);
    if (matches.length) return Math.min(...matches);
  }
  throw new UsageError(
    "USAGE_UNSUPPORTED_SCHEDULE",
    "Unable to resolve calendar boundary.",
    400,
  );
}
export function periodBounds(
  rule: PeriodRule,
  now: number,
): { start: number; end: number } | null {
  usageAssert(
    Number.isSafeInteger(now) && Number.isSafeInteger(rule.anchor),
    "USAGE_INVALID_INPUT",
    "Invalid schedule timestamp.",
    400,
  );
  if (now < rule.anchor) return null;
  if (rule.unit === "day" || rule.unit === "week") {
    const length = (rule.unit === "day" ? 1 : 7) * 86400000;
    const index = Math.floor((now - rule.anchor) / length);
    return {
      start: rule.anchor + index * length,
      end: rule.anchor + (index + 1) * length,
    };
  }
  usageAssert(
    rule.unit === "month",
    "USAGE_UNSUPPORTED_SCHEDULE",
    "Unsupported period unit.",
    400,
  );
  const a = parts(rule.anchor, rule.timezone),
    n = parts(now, rule.timezone),
    millis = rule.anchor % 1000;
  const boundary = (i: number) => {
    if (i === 0) return rule.anchor;
    const monthIndex = a.year * 12 + a.month - 1 + i,
      year = Math.floor(monthIndex / 12),
      month = (monthIndex % 12) + 1;
    const day = Math.min(
      a.day,
      new Date(Date.UTC(year, month, 0)).getUTCDate(),
    );
    return resolveLocal({ ...a, year, month, day }, rule.timezone) + millis;
  };
  let index = Math.max(0, (n.year - a.year) * 12 + n.month - a.month);
  while (index > 0 && boundary(index) > now) index--;
  while (boundary(index + 1) <= now) index++;
  return { start: boundary(index), end: boundary(index + 1) };
}
