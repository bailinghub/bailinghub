export interface UsagePresentation {
  schema: "bailing.usage-presentation.v1";
  kind: "credits" | "percentage" | "none";
  state:
    | "active"
    | "depleted"
    | "not_started"
    | "expired"
    | "suspended"
    | "unavailable";
  remaining: number | null;
  total: number | null;
  displayValue: string | null;
}

const unavailable = (): UsagePresentation => ({
  schema: "bailing.usage-presentation.v1",
  kind: "none",
  state: "unavailable",
  remaining: null,
  total: null,
  displayValue: null,
});

// A missing or incompatible projection must never fall back to accounting data.
export function readPresentation(
  value: unknown,
  mode?: "credits" | "periodic",
): UsagePresentation {
  if (!value || typeof value !== "object") return unavailable();
  const p = value as UsagePresentation;
  const expected =
    mode === "credits"
      ? "credits"
      : mode === "periodic"
        ? "percentage"
        : "none";
  if (
    p.schema !== "bailing.usage-presentation.v1" ||
    p.kind !== expected ||
    ![
      "active",
      "depleted",
      "not_started",
      "expired",
      "suspended",
      "unavailable",
    ].includes(p.state)
  )
    return unavailable();
  if (p.state !== "active" && p.state !== "depleted") {
    return { ...p, remaining: null, displayValue: null };
  }
  if (
    p.kind === "none" ||
    typeof p.remaining !== "number" ||
    !Number.isFinite(p.remaining) ||
    p.remaining < 0 ||
    typeof p.total !== "number" ||
    !Number.isFinite(p.total) ||
    p.total <= 0 ||
    typeof p.displayValue !== "string" ||
    p.remaining > p.total ||
    (p.kind === "percentage" &&
      (p.total !== 100 ||
        !/^(?:100|[1-9]?\d|<1)$/.test(p.displayValue) ||
        (p.displayValue === "<1" && p.remaining >= 1))) ||
    (p.kind === "credits" &&
      (!/^(?:\d+(?:\.\d{1,2})?|<0\.01)$/.test(p.displayValue) ||
        (p.displayValue === "<0.01" && p.remaining >= 0.01))) ||
    (p.state === "active" &&
      (p.remaining <= 0 || Number(p.displayValue) === 0)) ||
    (p.state === "depleted" && (p.remaining !== 0 || p.displayValue !== "0"))
  )
    return unavailable();
  return p;
}

// Template previews start at a full allowance. This is never used for account balances.
export function previewPresentation(config: {mode:'credits'|'periodic';priceUsd:number;periodAllowanceUsd?:number}): UsagePresentation {
  if (!Number.isFinite(config.priceUsd) || config.priceUsd <= 0) return unavailable();
  if (config.mode === 'periodic' && (typeof config.periodAllowanceUsd !== 'number' || !Number.isFinite(config.periodAllowanceUsd) || config.periodAllowanceUsd <= 0)) return unavailable();
  const amount = config.mode === 'periodic' ? 100 : config.priceUsd * 1000;
  const displayValue = amount < 0.01 ? '<0.01' : String(Math.floor(amount * 100) / 100);
  return {schema:'bailing.usage-presentation.v1',kind:config.mode === 'periodic' ? 'percentage':'credits',state:'active',remaining:amount,total:amount,displayValue};
}

export function presentationAmount(p: UsagePresentation): string {
  if (p.displayValue === null) return "—";
  if (p.displayValue.startsWith("<")) return p.displayValue;
  const [whole, fraction] = p.displayValue.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "")
  );
}
export const presentationUnit = (p: UsagePresentation) =>
  p.kind === "percentage" ? "%" : p.kind === "credits" ? "积分" : "";
export const presentationState = (p: UsagePresentation) =>
  ({
    active: "可用",
    depleted: "额度已用完",
    not_started: "尚未生效",
    expired: "已到期",
    suspended: "已暂停",
    unavailable: "用量暂不可用",
  })[p.state];
