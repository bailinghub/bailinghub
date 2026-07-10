import { nextTick, watch } from 'vue';
import type { ComponentInternalInstance } from 'vue';
import type { Router } from 'vue-router';

const STORAGE_KEY = 'bailing.console.tableWidths.v1';
const HARD_MIN_WIDTH = 44;

type WidthEntry = {
  width: number;
  percent: number;
  label: string;
  prop: string;
  updated_at: string;
};

type TableEntry = {
  route: string;
  table_index: number;
  table_hint: string;
  table_width: number;
  columns: Record<string, WidthEntry>;
  updated_at: string;
};

type WidthState = {
  version: 1;
  tables: Record<string, TableEntry>;
};

type DefaultWidthEntry = {
  percent: number;
  min?: number;
  max?: number;
};

const DEFAULT_COLUMN_WIDTHS: Record<string, Record<string, DefaultWidthEntry>> = {
  '/routes::table:0': {
    '场景标识': { percent: 11.2, min: 160 },
    name: { percent: 9.8, min: 130 },
    '调度目标': { percent: 10.5, min: 120 },
    '项目': { percent: 6.5, min: 100 },
    '会话连续性': { percent: 6.6, min: 120 },
    '知识/送达': { percent: 34, min: 220 },
    '权限': { percent: 4.8, min: 86 },
    '可执行性': { percent: 4.9, min: 104 },
    '启用': { percent: 4.3, min: 64, max: 110 },
    default: { percent: 7, min: 146, max: 180 },
  },
  '/clients::table:0': {
    AppID: { percent: 8.1, min: 150 },
    name: { percent: 8.1, min: 130 },
    Token: { percent: 8, min: 160 },
    '可调路由': { percent: 19, min: 180 },
    '可推渠道': { percent: 17.4, min: 160 },
    '聊天票据': { percent: 11.1, min: 140 },
    '限速/分': { percent: 5.3, min: 82, max: 128 },
    '预算': { percent: 4.3, min: 76, max: 112 },
    '启用': { percent: 5.5, min: 64, max: 118 },
    '最近调用': { percent: 6.2, min: 124, max: 160 },
    default: { percent: 6.5, min: 146, max: 180 },
  },
  '/chat::table:0': {
    '名称': { percent: 11.4, min: 160 },
    '绑定路由': { percent: 13.4, min: 150 },
    '嵌入站点': { percent: 52, min: 260 },
    '限速': { percent: 4.2, min: 92, max: 128 },
    '启用': { percent: 3.8, min: 64, max: 104 },
    default: { percent: 12.2, min: 240, max: 310 },
  },
  '/channels::table:0': {
    '标识': { percent: 10, min: 140 },
    '类型': { percent: 6.5, min: 92, max: 120 },
    '绑定路由': { percent: 11, min: 150 },
    '回调地址': { percent: 52, min: 320 },
    '启用': { percent: 5, min: 68, max: 104 },
    default: { percent: 12, min: 176, max: 220 },
  },
  '/channels::table:1': {
    '触发事件': { percent: 27, min: 150 },
    '渠道': { percent: 16, min: 140 },
    '收件人': { percent: 34, min: 180 },
    '冷却': { percent: 7, min: 72, max: 100 },
    '启用': { percent: 6, min: 68, max: 104 },
    default: { percent: 10, min: 104, max: 140 },
  },
  '/tools::table:0': {
    '名称': { percent: 11, min: 150 },
    'Base_URL': { percent: 25, min: 260 },
    '接口清单': { percent: 13, min: 166 },
    '授权探针': { percent: 12, min: 146 },
    '签名密钥': { percent: 11, min: 146 },
    '审计': { percent: 6, min: 84, max: 110 },
    '启用': { percent: 5, min: 64, max: 100 },
    default: { percent: 17, min: 280, max: 350 },
  },
  '/targets::table:0': {
    '名称': { percent: 13, min: 160 },
    '类型': { percent: 10, min: 112 },
    '特性': { percent: 16, min: 188 },
    '服务执行器（池）': { percent: 24, min: 190 },
    '超时': { percent: 7, min: 80, max: 110 },
    '启用': { percent: 5, min: 64, max: 100 },
    description: { percent: 17, min: 220 },
    default: { percent: 8, min: 110, max: 150 },
  },
  '/executors::table:0': {
    '标识': { percent: 13, min: 160 },
    '可认领_target': { percent: 26, min: 200 },
    '令牌': { percent: 13, min: 150 },
    '启用': { percent: 5, min: 64, max: 100 },
    '最近接入': { percent: 12, min: 150 },
    description: { percent: 16, min: 140 },
    default: { percent: 15, min: 190, max: 240 },
  },
  '/executors::table:4': {
    '执行器': { percent: 13, min: 160 },
    '状态': { percent: 15, min: 170 },
    '接的_target': { percent: 20, min: 180 },
    '能跑的_profile': { percent: 25, min: 220 },
    '运行时': { percent: 12, min: 150 },
    '标签': { percent: 10, min: 130 },
    default: { percent: 5, min: 70, max: 100 },
  },
  '/runs::table:0': {
    '时间': { percent: 10, min: 120 },
    '调度目标': { percent: 9, min: 110 },
    '触发方': { percent: 18, min: 140 },
    '输入': { percent: 27, min: 170 },
    '状态': { percent: 8, min: 86, max: 120 },
    severity: { percent: 7, min: 70, max: 110 },
    summary: { percent: 21, min: 220 },
  },
  '/audit::table:0': {
    '时间': { percent: 14, min: 150 },
    '操作人': { percent: 14, min: 150 },
    '动作': { percent: 8, min: 90, max: 120 },
    '配置对象': { percent: 64, min: 300 },
  },
};

type TableInstanceLike = ComponentInternalInstance & {
  emit?: (event: string, ...args: unknown[]) => void;
  store?: {
    states?: {
      columns?: { value?: any[] };
    };
    scheduleLayout?: (needUpdateColumns?: boolean, immediate?: boolean) => void;
  };
  state?: {
    doLayout?: () => void;
    debouncedUpdateLayout?: () => void;
  };
  vnode: ComponentInternalInstance['vnode'] & { el?: HTMLElement };
};

const patched = new WeakSet<TableInstanceLike>();
const originalEmit = new WeakMap<TableInstanceLike, TableInstanceLike['emit']>();
const mountedTables = new Set<TableInstanceLike>();
let exportApiInstalled = false;

function emptyState(): WidthState {
  return { version: 1, tables: {} };
}

function readState(): WidthState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as WidthState;
    if (parsed?.version !== 1 || !parsed.tables) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

function writeState(state: WidthState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function routeKey(router: Router): string {
  return router.currentRoute.value.path || '/';
}

function tableEl(instance: TableInstanceLike): HTMLElement | null {
  return instance.vnode.el instanceof HTMLElement ? instance.vnode.el : null;
}

function tableIndex(instance: TableInstanceLike): number {
  const el = tableEl(instance);
  if (!el) return 0;
  const tables = Array.from(document.querySelectorAll<HTMLElement>('.el-table'));
  const index = tables.indexOf(el);
  return index >= 0 ? index : 0;
}

function tableHint(instance: TableInstanceLike): string {
  const el = tableEl(instance);
  const card = el?.closest('.el-card');
  const header = card?.querySelector('.el-card__header')?.textContent?.replace(/\s+/g, ' ').trim();
  return header?.slice(0, 80) || '';
}

function tableKey(instance: TableInstanceLike, router: Router): string {
  return `${routeKey(router)}::table:${tableIndex(instance)}`;
}

function columnsOf(instance: TableInstanceLike): any[] {
  return instance.store?.states?.columns?.value || [];
}

function columnKey(column: any, index: number): string {
  const base = column.columnKey || column.property || column.rawColumnKey || column.label || column.type || `col_${index}`;
  return String(base || `col_${index}`).replace(/\s+/g, '_');
}

function columnWidth(column: any): number {
  const raw = Number(column.realWidth || column.width);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

function setColumnWidth(column: any, width: number): void {
  const nextWidth = Math.max(HARD_MIN_WIDTH, Math.round(width));
  column.width = nextWidth;
  column.realWidth = nextWidth;
}

function numericSize(value: unknown): number {
  if (value == null || value === '') return 0;
  const raw = Number.parseFloat(String(value));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function clamp(value: number, min: number, max?: number): number {
  const upper = max && max > min ? max : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(Math.max(value, min), upper));
}

function defaultWidth(column: any, tableWidth: number, pref: DefaultWidthEntry): number {
  const min = pref.min || numericSize(column.minWidth) || numericSize(column.width) || 64;
  return clamp((tableWidth * pref.percent) / 100, min, pref.max);
}

function savedWidth(saved: WidthEntry, column: any, tableWidth: number, pref?: DefaultWidthEntry): number {
  const percent = Number(saved.percent);
  const raw = Number.isFinite(percent) && percent > 0 ? (tableWidth * percent) / 100 : Number(saved.width);
  const min = pref?.min || numericSize(column.minWidth) || 64;
  return clamp(raw, min, pref?.max);
}

function columnMinWidth(column: any, index: number, defaults?: Record<string, DefaultWidthEntry>): number {
  const key = columnKey(column, index);
  return defaults?.[key]?.min || numericSize(column.minWidth) || 64;
}

function isActionColumn(column: any): boolean {
  const type = String(column.type || '');
  return !column.label && !column.property && !column.columnKey && !column.rawColumnKey && !['expand', 'selection', 'index'].includes(type);
}

function actionColumn(instance: TableInstanceLike): any | null {
  const columns = columnsOf(instance);
  if (columns.length < 2) return null;
  const last = columns[columns.length - 1];
  return last && isActionColumn(last) ? last : null;
}

function markActionColumn(instance: TableInstanceLike): void {
  tableEl(instance)?.classList.toggle('bailing-has-action-column', !!actionColumn(instance));
}

function tableContentWidth(instance: TableInstanceLike): number {
  const el = tableEl(instance);
  const scrollWrap = el?.querySelector<HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap');
  const bodyWrapper = el?.querySelector<HTMLElement>('.el-table__body-wrapper');
  const innerWrapper = el?.querySelector<HTMLElement>('.el-table__inner-wrapper');
  const candidates = [
    scrollWrap,
    bodyWrapper,
    innerWrapper,
    el,
    el?.parentElement,
    el?.closest<HTMLElement>('.el-tab-pane'),
    el?.closest<HTMLElement>('.el-card__body'),
    el?.closest<HTMLElement>('.el-drawer__body'),
  ];
  for (const node of candidates) {
    const rectWidth = Math.round(node?.getBoundingClientRect().width || 0);
    const clientWidth = Math.round(node?.clientWidth || 0);
    const width = Math.min(rectWidth || clientWidth, clientWidth || rectWidth);
    if (width > 16) return Math.max(1, width - 2);
  }
  return 1;
}

function assignedColumnsWidth(columns: any[]): number {
  return columns.reduce((sum, column) => sum + columnWidth(column), 0);
}

function actualScrollOverflow(instance: TableInstanceLike): number {
  const el = tableEl(instance);
  const wrap = el?.querySelector<HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap');
  const body = el?.querySelector<HTMLElement>('.el-table__body-wrapper');
  const node = wrap || body || el;
  const clientWidth = Math.round(node?.clientWidth || 0);
  const scrollWidth = Math.round(node?.scrollWidth || 0);
  return clientWidth > 16 ? Math.max(0, scrollWidth - clientWidth) : 0;
}

function canStretchColumn(column: any, index: number, defaults?: Record<string, DefaultWidthEntry>): boolean {
  if (!column || column.fixed) return false;
  if (['expand', 'selection', 'index'].includes(String(column.type || ''))) return false;
  const key = columnKey(column, index);
  if (defaults?.[key]?.max) return false;
  const label = String(column.label || column.property || '');
  return !['启用', '状态', '审计', '冷却', '预算', '超时', '权限', '动作', '级别'].includes(label);
}

function canForceShrinkColumn(column: any): boolean {
  if (!column || column.fixed) return false;
  return !['expand', 'selection', 'index'].includes(String(column.type || ''));
}

function stretchColumnForSlack(
  instance: TableInstanceLike,
  tableWidth: number,
  defaults?: Record<string, DefaultWidthEntry>,
): boolean {
  const columns = columnsOf(instance);
  const action = actionColumn(instance);
  const slack = tableWidth - assignedColumnsWidth(columns);
  if (slack <= 2) return false;

  const endIndex = action ? columns.indexOf(action) : columns.length;
  const candidates = columns.slice(0, endIndex).filter((column, index) => canStretchColumn(column, index, defaults));
  const target = candidates[candidates.length - 1] || columns[Math.max(0, endIndex - 1)];
  const width = columnWidth(target);
  if (!target || !width) return false;
  setColumnWidth(target, width + slack);
  return true;
}

function shrinkColumnsForOverflow(
  instance: TableInstanceLike,
  tableWidth: number,
  defaults?: Record<string, DefaultWidthEntry>,
): boolean {
  const columns = columnsOf(instance);
  let overflow = assignedColumnsWidth(columns) - tableWidth;
  if (overflow <= 2) return false;
  let changed = false;
  const candidates = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => canStretchColumn(column, index, defaults))
    .reverse();

  for (const { column, index } of candidates) {
    if (overflow <= 2) break;
    const width = columnWidth(column);
    const min = columnMinWidth(column, index, defaults);
    const cut = Math.min(Math.max(0, width - min), overflow);
    if (cut <= 0) continue;
    setColumnWidth(column, width - cut);
    overflow -= cut;
    changed = true;
  }
  if (overflow <= 2) return changed;

  const fallback = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => canForceShrinkColumn(column))
    .reverse();
  for (const { column } of fallback) {
    if (overflow <= 2) break;
    const width = columnWidth(column);
    const cut = Math.min(Math.max(0, width - HARD_MIN_WIDTH), overflow);
    if (cut <= 0) continue;
    setColumnWidth(column, width - cut);
    overflow -= cut;
    changed = true;
  }
  return changed;
}

function normalizeTableWidths(instance: TableInstanceLike, router: Router): boolean {
  const tableWidth = tableContentWidth(instance);
  if (tableWidth <= 16) return false;
  const defaults = DEFAULT_COLUMN_WIDTHS[tableKey(instance, router)];
  let changed = false;
  if (shrinkColumnsForOverflow(instance, tableWidth, defaults)) changed = true;
  if (stretchColumnForSlack(instance, tableWidth, defaults)) changed = true;
  const overflow = actualScrollOverflow(instance);
  if (overflow > 2 && shrinkColumnsForOverflow(instance, Math.max(1, assignedColumnsWidth(columnsOf(instance)) - overflow - 2), defaults)) {
    changed = true;
  }
  return changed;
}

function doLayout(instance: TableInstanceLike): void {
  instance.store?.scheduleLayout?.(false, true);
  instance.state?.doLayout?.();
}

function scheduleColumnsLayout(instance: TableInstanceLike): void {
  instance.store?.scheduleLayout?.(true, true);
  instance.state?.doLayout?.();
}

function pinLastColumnRight(instance: TableInstanceLike): boolean {
  const last = actionColumn(instance);
  if (!last || last.fixed === 'right') return false;
  last.fixed = 'right';
  if (last.rawColumn) last.rawColumn.fixed = 'right';
  return true;
}

function saveTableWidths(instance: TableInstanceLike, router: Router): void {
  const tableWidth = tableContentWidth(instance);
  const columns = columnsOf(instance);
  if (!columns.length || tableWidth <= 16) return;
  const now = new Date().toISOString();
  const state = readState();
  const key = tableKey(instance, router);
  const entry: TableEntry = state.tables[key] || {
    route: routeKey(router),
    table_index: tableIndex(instance),
    table_hint: tableHint(instance),
    table_width: tableWidth,
    columns: {},
    updated_at: now,
  };
  entry.route = routeKey(router);
  entry.table_index = tableIndex(instance);
  entry.table_hint = tableHint(instance);
  entry.table_width = tableWidth;
  entry.updated_at = now;
  entry.columns = {};
  columns.forEach((column, index) => {
    const width = columnWidth(column);
    if (!width) return;
    entry.columns[columnKey(column, index)] = {
      width,
      percent: Number(((width / tableWidth) * 100).toFixed(2)),
      label: String(column.label || ''),
      prop: String(column.property || ''),
      updated_at: now,
    };
  });
  state.tables[key] = entry;
  writeState(state);
}

function applyTablePrefs(instance: TableInstanceLike, router: Router): void {
  if ((instance as any).__bailingUserDragging) return;
  const key = tableKey(instance, router);
  const tableWidth = tableContentWidth(instance);
  if (tableWidth <= 16) return;
  const entry = readState().tables[tableKey(instance, router)];
  const defaults = DEFAULT_COLUMN_WIDTHS[key];
  let widthChanged = false;
  markActionColumn(instance);
  const pinChanged = pinLastColumnRight(instance);
  columnsOf(instance).forEach((column, index) => {
    const key = columnKey(column, index);
    const saved = entry?.columns[key];
    const nextWidth = saved ? savedWidth(saved, column, tableWidth, defaults?.[key]) : (defaults?.[key] ? defaultWidth(column, tableWidth, defaults[key]) : 0);
    if (!nextWidth) return;
    if (column.width === nextWidth && column.realWidth === nextWidth) return;
    setColumnWidth(column, nextWidth);
    widthChanged = true;
  });
  if (normalizeTableWidths(instance, router)) widthChanged = true;
  if (pinChanged) scheduleColumnsLayout(instance);
  else if (widthChanged) doLayout(instance);
}

function installExportApi(): void {
  if (exportApiInstalled || typeof window === 'undefined') return;
  exportApiInstalled = true;
  (window as any).__BailingTableWidths = {
    export: () => readState(),
    copy: async () => {
      const text = JSON.stringify(readState(), null, 2);
      await navigator.clipboard.writeText(text);
      return text;
    },
    download: () => {
      const text = JSON.stringify(readState(), null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `bailing-table-widths-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      return text;
    },
    inspect: () => Array.from(mountedTables).map((instance) => {
      const columns = columnsOf(instance);
      const el = tableEl(instance);
      const scrollWrap = el?.querySelector<HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap');
      const bodyWrapper = el?.querySelector<HTMLElement>('.el-table__body-wrapper');
      return {
        key: tableKey(instance, { currentRoute: { value: { path: location.pathname.replace(/^\/console/, '') || '/' } } } as Router),
        hint: tableHint(instance),
        table_width: tableContentWidth(instance),
        columns_width: assignedColumnsWidth(columns),
        dom_width: {
          root_client: el?.clientWidth || 0,
          root_scroll: el?.scrollWidth || 0,
          body_client: bodyWrapper?.clientWidth || 0,
          body_scroll: bodyWrapper?.scrollWidth || 0,
          wrap_client: scrollWrap?.clientWidth || 0,
          wrap_scroll: scrollWrap?.scrollWidth || 0,
        },
        has_action_column: !!actionColumn(instance),
        action_fixed: actionColumn(instance)?.fixed || '',
        columns: columns.map((column, index) => ({
          key: columnKey(column, index),
          label: String(column.label || ''),
          type: String(column.type || ''),
          width: columnWidth(column),
          fixed: column.fixed || '',
        })),
      };
    }),
    clear: () => window.localStorage.removeItem(STORAGE_KEY),
    storageKey: STORAGE_KEY,
  };
}

export function installTableWidthPersistence(app: any, router: Router): void {
  installExportApi();
  app.mixin({
    mounted() {
      const instance = this.$ as TableInstanceLike;
      if (instance?.type?.name !== 'ElTable' || patched.has(instance)) return;
      patched.add(instance);
      mountedTables.add(instance);
      const emit = instance.emit?.bind(instance);
      originalEmit.set(instance, emit);
      instance.emit = (event: string, ...args: unknown[]) => {
        const result = emit?.(event, ...args);
        if (event === 'header-dragend') {
          (instance as any).__bailingUserDragging = true;
          requestAnimationFrame(() => {
            const pinChanged = pinLastColumnRight(instance);
            const widthChanged = normalizeTableWidths(instance, router);
            if (pinChanged || widthChanged) scheduleColumnsLayout(instance);
            else doLayout(instance);
            saveTableWidths(instance, router);
            (instance as any).__bailingUserDragging = false;
          });
        }
        return result;
      };
      void nextTick(() => applyTablePrefs(instance, router));
      setTimeout(() => applyTablePrefs(instance, router), 120);
      let frame = 0;
      const scheduleApply = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          applyTablePrefs(instance, router);
        });
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleApply);
      const el = tableEl(instance);
      const observed = [
        el,
        el?.parentElement,
        el?.closest<HTMLElement>('.el-tab-pane'),
        el?.closest<HTMLElement>('.el-card__body'),
        el?.closest<HTMLElement>('.el-drawer__body'),
      ].filter((node): node is HTMLElement => !!node);
      observed.forEach((node) => observer?.observe(node));
      window.addEventListener('resize', scheduleApply);
      const stop = watch(
        () => columnsOf(instance).map((column, index) => `${columnKey(column, index)}:${columnWidth(column)}`).join('|'),
        () => void nextTick(() => applyTablePrefs(instance, router)),
        { flush: 'post' },
      );
      (instance as any).__bailingStopTableWidthWatch = stop;
      (instance as any).__bailingStopTableWidthResize = () => {
        if (frame) cancelAnimationFrame(frame);
        observer?.disconnect();
        window.removeEventListener('resize', scheduleApply);
      };
    },
    beforeUnmount() {
      const instance = this.$ as TableInstanceLike;
      if (instance?.type?.name !== 'ElTable') return;
      const emit = originalEmit.get(instance);
      if (emit) instance.emit = emit;
      originalEmit.delete(instance);
      (instance as any).__bailingStopTableWidthWatch?.();
      (instance as any).__bailingStopTableWidthResize?.();
      patched.delete(instance);
      mountedTables.delete(instance);
    },
  });
}
