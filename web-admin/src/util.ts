import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';

export async function copyText(t: string, tip = '已复制到剪贴板'): Promise<void> {
  try { await navigator.clipboard.writeText(t); ElMessage.success(tip); }
  catch { await ElMessageBox.alert(t, '手动复制', { confirmButtonText: '关闭' }).catch(() => undefined); }
}

/** 后端统一存/出 UTC（ISO 带 Z），时区转换归显示层——按浏览器本地时区渲染（上海用户即北京时间）。 */
export function fmtTime(t?: string, withSec = false): string {
  if (!t) return '-';
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t); // 解析不了的原样显示，别吞
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${withSec ? ':' + p(d.getSeconds()) : ''}`;
}
