// 时区策略（全框架唯一约定）：
//   · 内部存储与运算一律 UTC——dt()/now() 写 UTC、mysql pool `timezone:'Z'`、DB 列存 UTC 墙钟。这是单一真值。
//   · 只在「展示边界」（喂大脑的上下文 / 给人看的界面）才转成展示时区，并且显式标注时区，绝不把裸 UTC 数字递给读者。
//   · 展示时区是「实例级配置」display_tz（IANA 名，如 Asia/Shanghai / America/New_York），启动时由 server 注入；
//     默认 Asia/Shanghai（面向中国），开源部署方按自身位置改 config.json，调用方零改动。
//   · 用 Intl + IANA 时区做转换——DST 安全（美/欧夏令时一年两跳，固定偏移会错；中国无 DST 两者等价）。
//     这是「一次做对」：既然对外可配任意时区，就不能用「加固定毫秒」那种只对 +8 成立的写法。

let displayTz = 'Asia/Shanghai';
let displayTzLabel = '北京时间';

/** 启动时由 server 注入实例配置（见 config.ts display_tz / display_tz_label）。
 * 给了非法时区名 → 整个调用忽略（保持默认，不让错配的 label 搭上错误偏移误导读者）。 */
export function setDisplayTimezone(tz?: string | null, label?: string | null): void {
  if (tz && !isValidTimeZone(tz)) return;
  if (tz) displayTz = tz;
  displayTzLabel = label && label.trim() ? label.trim() : displayTz; // 没给友好名就用 IANA 名兜底
}

function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return Date.parse(t); // ISO 串（含 'Z'）解析为 UTC 瞬间
}

/** 取某 UTC 瞬间在展示时区的墙钟分量（年月日时分），DST 安全。 */
function partsIn(ms: number): { y: string; mo: string; d: string; h: string; mi: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: displayTz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour'] === '24' ? '00' : p['hour']!, mi: p['minute']! };
}

/** 该瞬间在展示时区相对 UTC 的偏移标签，如 "UTC+8" / "UTC-4"（DST 当下值）/ "UTC+5:30"（半时区）。 */
function offsetTag(ms: number): string {
  const p = partsIn(ms);
  const asUtc = Date.UTC(+p.y, +p.mo - 1, +p.d, +p.h, +p.mi);
  const offMin = Math.round((asUtc - ms) / 60_000);
  const sign = offMin >= 0 ? '+' : '-';
  const hh = Math.floor(Math.abs(offMin) / 60);
  const mm = Math.abs(offMin) % 60;
  return `UTC${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

/** 把一个 UTC 瞬间（ISO 串 / 毫秒 / Date）格式化成展示时区的 "YYYY-MM-DD HH:MM"。
 * 精确到分钟——秒级会让每次请求的 system/上下文都不同，白白击穿上游 prompt cache。脏值兜底原样截断。 */
export function fmtDisplayTime(t: string | number | Date): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return String(t).slice(0, 16).replace('T', ' ');
  const p = partsIn(ms);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`;
}

/** 时区说明，如 "北京时间，UTC+8"——给会话背景块头/锚点标注用，让读者明确时间基准。 */
export function displayTzNote(t?: string | number | Date): string {
  const ms = t === undefined ? Date.now() : toMs(t);
  return `${displayTzLabel}，${offsetTag(Number.isFinite(ms) ? ms : Date.now())}`;
}

/** 带星期与时区标签的完整形式："YYYY-MM-DD HH:MM 星期X（北京时间，UTC+8）"。供「当前时间」锚点用。 */
export function fmtDisplayTimeFull(t: string | number | Date): string {
  const ms = toMs(t);
  const base = Number.isFinite(ms) ? ms : Date.now();
  const week = new Intl.DateTimeFormat('zh-CN', { timeZone: displayTz, weekday: 'long' }).format(new Date(base));
  return `${fmtDisplayTime(base)} ${week}（${displayTzNote(base)}）`;
}
