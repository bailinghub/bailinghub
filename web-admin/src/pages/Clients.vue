<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>接入方</b> <HelpTip title="接入方是干什么的">
          <p>业务系统「<b>带 token 主动调中枢 API</b>」的一把可吊销钥匙，管三条主动调用链路：① <code>POST /run</code> 发任务；② <code>GET /jobs/:id</code> 查结果；③ <code>POST /send</code> 经渠道主动推消息给某用户（会作为「回复方」记进该用户在该渠道的会话历史，用户追问时大脑读得到）。控制：能不能调（token）、能调哪些路由（可调路由白名单）、能往哪些渠道推（可推渠道白名单）、调多频（限速）。</p>
          <p><b>聊天入口（网页/小程序组件）不走接入方</b>——那是公开面（Origin 白名单 + 限速），不带 token。接入方在聊天里只有一个间接角色：「票据签发方」，业务后端用它的 token 给登录用户签身份票据（见右侧「聊天入口票据」列）。</p>
          <p><b>开始对接：</b>可直接到「触发路由」页点该路由的「调用代码」按钮，生成可粘贴的 HTTP / Node.js / Python / PHP 高频示例；Java、Go、.NET 与任意语言接入见官网 SDK 文档。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">新建接入方</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有接入方：业务系统接入前先在这里发一把钥匙">
      <el-button type="primary" @click="openCreate">发第一把</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="接入方" min-width="250" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="client-main">
            <b>{{ row.name || row.app_id }}</b>
            <code>{{ row.app_id }}</code>
            <div class="client-token">
              <span class="mono muted">{{ row.token }}</span>
              <el-button v-if="s.can('clients:write')" link type="primary" @click="revealToken(row.app_id)">复制完整</el-button>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="授权边界" min-width="280">
        <template #default="{ row }">
          <div class="client-stack">
            <div class="tagline">
              <span class="muted">可调</span>
              <el-tag v-for="r in previewTags(row.allowed_routes, '全部路由')" :key="r" size="small" effect="plain" type="info">{{ r }}</el-tag>
            </div>
            <div class="tagline">
              <span class="muted">可推</span>
              <template v-if="(row.allowed_channels || []).length">
                <el-tag v-for="c in previewTags(row.allowed_channels, '全部渠道')" :key="c" size="small" effect="plain" type="warning">{{ c }}</el-tag>
              </template>
              <span v-else class="muted">不允许主动推送</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="聊天票据" min-width="190">
        <template #default="{ row }">
          <div class="tagline">
            <template v-if="(ticketOf[row.app_id] || []).length">
              <el-tag v-for="e in previewTags(ticketOf[row.app_id], '全部入口')" :key="e" size="small" effect="plain" type="success">{{ e }}</el-tag>
            </template>
            <span v-else class="muted">未作为票据签发方</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="保护" width="180">
        <template #default="{ row }">
          <div class="protection-stack">
            <div>
              <el-tag size="small" effect="plain" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag>
              <el-tag v-if="hasBudget(row)" size="small" effect="plain" type="danger">预算闸</el-tag>
            </div>
            <span class="muted">限速 {{ row.rate_limit_per_min ? row.rate_limit_per_min + '/分' : '不限' }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="136">
        <template #header>最近调用 <HelpTip title="最近调用怎么算">
          <p>最近一次该接入方<b>凭证被实际使用</b>：① 业务后端带 token 调 <code>/run</code> / <code>/jobs/:id</code>；② 它作为聊天入口票据签发方、有登录访客带票据来验签。</p>
          <p><b>聊天入口的匿名流量不算</b>（公开面、不带 token）——所以小程序匿名聊天再多这里也不动，属正常；接上登录票据后才会显示活跃。</p>
        </HelpTip></template>
        <template #default="{ row }"><span class="muted">{{ fmtTime(row.last_used_at) }}</span></template>
      </el-table-column>
      <el-table-column width="146" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="换钥？旧 token 立即作废，业务侧需同步更新。" width="240" @confirm="rotate(row)">
            <template #reference><el-button link type="warning">换钥</el-button></template>
          </el-popconfirm>
          <el-popconfirm title="删除该接入方？其 token 立即失效。" width="220" @confirm="del(row.app_id)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑接入方' : '新建接入方'" size="440px">
    <el-form label-position="top">
      <el-form-item>
        <template #label>{{ fieldTitle('app_id', 'AppID') }} <span v-if="fieldRequired('app_id')" class="field-required">*</span> <HelpTip :title="fieldTitle('app_id', 'AppID')">
          <p>{{ fieldDesc('app_id', '接入方的稳定标识。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.app_id" :disabled="editing" placeholder="留空自动生成，如 business-api" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('name', '名称') }} <span v-if="fieldRequired('name')" class="field-required">*</span> <HelpTip :title="fieldTitle('name', '名称')">
          <p>{{ fieldDesc('name', '后台展示的人类可读名称。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.name" placeholder="如 业务系统" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('allowed_routes', '可调路由') }} <span v-if="fieldRequired('allowed_routes')" class="field-required">*</span> <HelpTip :title="fieldTitle('allowed_routes', '可调路由')">
          <p>{{ fieldDesc('allowed_routes', '该接入方可触发哪些 route。') }}</p>
          <p><code>*</code> 表示全部路由，适合本地开发或完全受信的内部系统，生产环境慎用。</p>
        </HelpTip></template>
        <el-select v-model="form.allowed_routes" multiple filterable allow-create default-first-option style="width: 100%" placeholder="选择或输入场景标识">
          <el-option value="*" label="*（全部路由）" />
          <el-option v-for="r in routeKeys" :key="r" :value="r" :label="r" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('allowed_channels', '可推渠道白名单') }} <HelpTip :title="fieldTitle('allowed_channels', '可推渠道白名单')">
            <p>{{ fieldDesc('allowed_channels', '该接入方调 POST /send 主动推消息时，只能推这里授权的渠道。') }}</p>
            <p>推送会作为「回复方」消息记进收件人在该渠道的会话历史，所以用户后续在该渠道追问时，大脑接得上上下文。</p>
          </HelpTip></template>
        <el-select v-model="form.allowed_channels" multiple filterable default-first-option style="width: 100%" placeholder="留空=不允许主动推；或选渠道 / *">
          <el-option value="*" label="*（全部渠道）" />
          <el-option v-for="c in channelNames" :key="c" :value="c" :label="c" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('rate_limit_per_min', '限速') }} <HelpTip :title="fieldTitle('rate_limit_per_min', '限速')">
          <p>{{ fieldDesc('rate_limit_per_min', '该接入方每分钟最多调用多少次。0 表示不限。') }}</p>
          <p><code>/run</code> 和 <code>/send</code> 共用同一限速桶。</p>
        </HelpTip></template>
        <el-input-number v-model="form.rate_limit_per_min" :min="0" :max="6000" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('budget', '成本预算闸') }} <HelpTip :title="fieldTitle('budget', '成本预算闸')">
          <p>{{ fieldDesc('budget', '按接入方维度限制模型成本或 token 用量。') }}</p>
          <p>按该接入方在指定窗口内的历史用量做入口硬限。达到成本或 token 上限后，该接入方的新 <code>/run</code> 任务会直接记为 <code>rejected</code>，不会再进入模型、执行器或工具链路。</p>
          <p>这是调用方级预算；触发路由页还可以配置场景级预算。两边任一命中都会拒绝。</p>
        </HelpTip></template>
        <el-switch v-model="budget.enabled" />
      </el-form-item>
      <template v-if="budget.enabled">
        <el-form-item label="预算窗口">
          <el-radio-group v-model="budget.window">
            <el-radio-button value="hour">每小时</el-radio-button>
            <el-radio-button value="day">每天</el-radio-button>
            <el-radio-button value="month">每月</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="硬限">
          <div class="inline-row">
            <span class="muted">成本 USD</span><el-input-number v-model="budget.hard_cost_usd" :min="0" :step="0.1" :precision="4" />
            <span class="muted">Token</span><el-input-number v-model="budget.hard_tokens" :min="0" :step="1000" />
          </div>
          <div class="muted hint">两个都为空等于不设硬限；任一达到上限即拒绝新任务。</div>
        </el-form-item>
      </template>
      <el-form-item>
        <template #label>{{ fieldTitle('description', '说明') }} <HelpTip :title="fieldTitle('description', '说明')">
          <p>{{ fieldDesc('description', '给后台管理员看的补充备注。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.description" />
      </el-form-item>
      <el-form-item v-if="editing">
        <template #label>{{ fieldTitle('enabled', '启用') }} <HelpTip :title="fieldTitle('enabled', '启用')">
          <p>{{ fieldDesc('enabled', '关闭后该接入方 token 不再允许调用。') }}</p>
        </HelpTip></template>
        <el-switch v-model="form.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { api } from '../request';
import { copyText, fmtTime } from '../util';
import { useMe } from '../store';
import HelpTip from '../components/HelpTip.vue';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

const s = useMe();
const clientSchema = useConfigSchema('client');
const list = ref<any[]>([]);
const routeKeys = ref<string[]>([]);
const channelNames = ref<string[]>([]);
// app_id → 它作为「票据签发方」服务的聊天入口列表（让接入方与聊天入口的关联可见）
const ticketOf = ref<Record<string, string[]>>({});
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ app_id: '', name: '', allowed_routes: [] as string[], allowed_channels: [] as string[], rate_limit_per_min: 60, description: '', enabled: true });
const budget = reactive<{ enabled: boolean; window: 'hour' | 'day' | 'month'; hard_cost_usd?: number; hard_tokens?: number }>({ enabled: false, window: 'day', hard_cost_usd: undefined, hard_tokens: undefined });
let budgetRest: Record<string, unknown> = {};

function fieldTitle(field: string, fallback: string): string {
  return schemaTitle(clientSchema.schema.value, field, fallback);
}
function fieldDesc(field: string, fallback = ''): string {
  return schemaDescription(clientSchema.schema.value, field, fallback);
}
function fieldRequired(field: string): boolean {
  return schemaRequired(clientSchema.required.value, field);
}
function hasBudget(row: any): boolean {
  return row.budget?.enabled !== false && (row.budget?.hard_cost_usd || row.budget?.hard_tokens);
}
function previewTags(values: unknown, allLabel: string): string[] {
  const arr = Array.isArray(values) ? values.map((x) => String(x)).filter(Boolean) : [];
  if (!arr.length) return [];
  if (arr.includes('*')) return [allLabel];
  if (arr.length <= 3) return arr;
  return [...arr.slice(0, 3), `+${arr.length - 3}`];
}

async function load(): Promise<void> { list.value = await api('/admin/api/clients'); }
function splitKnown(obj: unknown, keys: string[]): [Record<string, unknown>, Record<string, unknown>] {
  const known: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [known, rest];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(key)) known[key] = value;
    else rest[key] = value;
  }
  return [known, rest];
}
function resetBudget(): void {
  Object.assign(budget, { enabled: false, window: 'day', hard_cost_usd: undefined, hard_tokens: undefined });
  budgetRest = {};
}
function hydrateBudget(raw: unknown): void {
  const [b, rest] = splitKnown(raw, ['enabled', 'window', 'window_hours', 'hard_cost_usd', 'hard_tokens', 'soft_cost_usd', 'soft_tokens']);
  const windowFromHours = Number(b['window_hours']) === 1 ? 'hour' : Number(b['window_hours']) === 720 ? 'month' : 'day';
  const win = ['hour', 'day', 'month'].includes(String(b['window'])) ? String(b['window']) as 'hour' | 'day' | 'month' : windowFromHours;
  Object.assign(budget, {
    enabled: !!raw && b['enabled'] !== false,
    window: win,
    hard_cost_usd: b['hard_cost_usd'] == null ? undefined : Number(b['hard_cost_usd']),
    hard_tokens: b['hard_tokens'] == null ? undefined : Number(b['hard_tokens']),
  });
  budgetRest = rest;
}
function budgetPayload(): Record<string, unknown> | undefined {
  if (!budget.enabled) return undefined;
  const hardCost = Number(budget.hard_cost_usd);
  const hardTokens = Number(budget.hard_tokens);
  if (!(hardCost > 0) && !(hardTokens > 0) && !Object.keys(budgetRest).length) return undefined;
  return {
    enabled: true,
    window: budget.window,
    ...(hardCost > 0 ? { hard_cost_usd: hardCost } : {}),
    ...(hardTokens > 0 ? { hard_tokens: Math.round(hardTokens) } : {}),
    ...budgetRest,
  };
}
function openCreate(): void {
  editing.value = false;
  Object.assign(form, { app_id: '', name: '', allowed_routes: [], allowed_channels: [], rate_limit_per_min: 60, description: '', enabled: true });
  resetBudget();
  open.value = true;
}
function openEdit(row: any): void {
  editing.value = true;
  Object.assign(form, { app_id: row.app_id, name: row.name, allowed_routes: [...(row.allowed_routes || [])], allowed_channels: [...(row.allowed_channels || [])], rate_limit_per_min: row.rate_limit_per_min ?? 60, description: row.description || '', enabled: !!row.enabled });
  hydrateBudget(row.budget);
  open.value = true;
}
async function save(): Promise<void> {
  if (!form.allowed_routes.length) { ElMessage.error('至少选一个路由（或 *）'); return; }
  saving.value = true;
  try {
    const r = await api<{ app_id: string; token: string }>('/admin/api/clients', { method: 'POST', body: JSON.stringify({ ...form, budget: budgetPayload() }) });
    open.value = false; await load();
    if (!editing.value) {
      await ElMessageBox.alert(`接入方 ${r.app_id} 的 token（业务侧 Authorization 用）：\n\n${r.token}`, '接入方已创建', { confirmButtonText: '复制 token' }).catch(() => undefined);
      await copyText(r.token, 'token 已复制');
    } else { ElMessage.success('已保存'); }
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function rotate(row: any): Promise<void> {
  try {
    const r = await api<{ token: string }>('/admin/api/clients', { method: 'POST', body: JSON.stringify({ ...row, rotate_token: true }) });
    await load(); await copyText(r.token, '新 token 已复制，请同步给业务侧');
  } catch (e) { ElMessage.error((e as Error).message); }
}
async function del(appId: string): Promise<void> {
  try { await api('/admin/api/clients/' + encodeURIComponent(appId), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
// 列表只下发掩码 token；要完整值（配业务侧 Authorization）走显式取回，后端 clients:write 鉴权 + 审计留痕
async function revealToken(appId: string): Promise<void> {
  try {
    const r = await api<{ token: string }>('/admin/api/clients/' + encodeURIComponent(appId) + '/token');
    await copyText(r.token, '完整 token 已复制');
  } catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(async () => {
  await Promise.all([clientSchema.load().catch(() => undefined), load()]);
  if (s.can('channels:read')) {
    try { channelNames.value = (await api<any[]>('/admin/api/channels')).map((c) => c.name); } catch { /* 可选 */ }
  }
  if (s.can('routes:read')) {
    try { routeKeys.value = (await api<any[]>('/admin/api/routes')).map((r) => r.route_key); } catch { /* 可选 */ }
    // 聊天入口（与路由同属调度配置权限）：建立 接入方→票据签发的聊天入口 反向映射
    try {
      const map: Record<string, string[]> = {};
      for (const e of await api<any[]>('/admin/api/chat-entries')) {
        if (e.ticket_client) (map[e.ticket_client] ||= []).push(e.entry_key);
      }
      ticketOf.value = map;
    } catch { /* 可选 */ }
  }
});
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.client-main,
.client-stack,
.protection-stack {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.client-main b {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.client-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.client-token,
.tagline,
.protection-stack > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.inline-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hint { margin-top: 4px; width: 100%; }
</style>
