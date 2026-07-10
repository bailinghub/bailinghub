<template>
  <!-- 接入令牌：谁有资格挂执行器（claim/result 专用鉴权）-->
  <el-card shadow="never" class="panel-card">
    <template #header>
      <div class="head">
        <b>执行器接入令牌</b> <HelpTip title="执行器接入令牌是什么">
          <p>外部执行器接入中枢的专用凭证，只能用于 claim/result/heartbeat，不具备后台账号能力。</p>
          <p>令牌按 target 白名单授权，可轮换、可停用、可审计。执行器实例只会认领它被授权的调度目标。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">签发令牌</el-button>
      </div>
    </template>
    <el-table :data="tokens" v-loading="tkLoading">
      <el-table-column label="令牌" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="exec-main">
            <code>{{ row.name }}</code>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="授权范围" min-width="260">
        <template #default="{ row }">
          <div class="tagline">
            <el-tag v-for="t in row.allowed_targets" :key="t" size="small" effect="plain"><code>{{ t }}</code></el-tag>
            <span v-if="!row.allowed_targets?.length" class="muted">未授权任何 target</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="接入状态" min-width="170">
        <template #default="{ row }">
          <div class="exec-stack">
            <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            <span class="muted">{{ lastSeenLabel(row.last_seen_at) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="掩码令牌" width="150">
        <template #default="{ row }"><code class="muted">{{ row.token }}</code></template>
      </el-table-column>
      <el-table-column width="190" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="reveal(row.name)">复制完整令牌</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm :title="`删除令牌 ${row.name}？用它挂着的执行器会立即无法再认领（已在跑的当前任务不受影响）。`" width="280" @confirm="delToken(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
      <template #empty><div class="muted" style="padding: 14px">还没有执行器令牌。点「签发令牌」建一个，把它填进执行器的 <code>--token</code> 即可挂上来。</div></template>
    </el-table>
  </el-card>

  <!-- 调度租约：DB claim/lease 的运行时事实 -->
  <el-card shadow="never" class="panel-card">
    <template #header>
      <div class="head">
        <b>调度租约</b> <HelpTip title="调度租约是什么">
          <p>展示 DB 调度队列里的在途任务、租约剩余时间、按 target 的队列占用，以及同 thread 串行导致的排队。</p>
          <p>这里是只读运行面，用来判断“任务有没有被认领、哪个执行器认领、是否快过期、是否被同会话前序任务阻塞”。</p>
        </HelpTip>
        <el-button style="margin-left: auto" :loading="dispatchLoading" @click="loadDispatch">刷新</el-button>
      </div>
    </template>
    <div v-loading="dispatchLoading">
      <div class="dispatchStats">
        <div><span class="muted">可运行排队</span><b>{{ dispatch?.summary.queued ?? 0 }}</b></div>
        <div><span class="muted">中枢内执行</span><b>{{ dispatch?.summary.running ?? 0 }}</b></div>
        <div><span class="muted">执行器认领</span><b>{{ dispatch?.summary.dispatched ?? 0 }}</b></div>
        <div><span class="muted">延迟队列</span><b>{{ dispatch?.summary.delayed_queued ?? 0 }}</b></div>
        <div><span class="muted">过期租约</span><b :class="{ dangerText: (dispatch?.summary.expired_leases ?? 0) > 0 }">{{ dispatch?.summary.expired_leases ?? 0 }}</b></div>
        <div><span class="muted">thread 阻塞</span><b>{{ dispatch?.summary.blocked_threads ?? 0 }}</b></div>
      </div>
      <div class="dispatchGrid">
        <section>
          <div class="sub">按 target</div>
          <el-table :data="dispatch?.by_target ?? []" size="small" empty-text="暂无在途或排队任务" max-height="220">
            <el-table-column label="target" min-width="150" show-overflow-tooltip><template #default="{ row }"><code>{{ row.target }}</code></template></el-table-column>
            <el-table-column prop="queued" label="等待" width="82" />
            <el-table-column prop="running" label="中枢内" width="88" />
            <el-table-column prop="dispatched" label="执行器" width="96" />
          </el-table>
        </section>
        <section>
          <div class="sub">thread 队头阻塞</div>
          <el-table :data="dispatch?.blocked_threads ?? []" size="small" empty-text="暂无同会话阻塞" max-height="220">
            <el-table-column label="thread" width="90"><template #default="{ row }"><code>{{ row.thread_id }}</code></template></el-table-column>
            <el-table-column prop="queued" label="等待数" width="76" />
            <el-table-column label="最早等待" width="120"><template #default="{ row }">{{ fmtTime(row.oldest_queued_at, true) }}</template></el-table-column>
            <el-table-column label="前序在途" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="muted">{{ row.inflight }}</span>
                <el-button v-if="row.inflight_jobs?.length" link type="primary" size="small" @click.stop="gotoJob(row.inflight_jobs[0])">追溯</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </div>
      <div class="sub">当前租约</div>
      <el-table :data="dispatch?.leases ?? []" size="small" empty-text="暂无在途租约" max-height="260">
        <el-table-column label="任务" min-width="210" show-overflow-tooltip>
          <template #default="{ row }"><code>{{ row.job_id }}</code><div class="muted mono">{{ row.request_id }}</div></template>
        </el-table-column>
        <el-table-column label="运行状态" width="106">
          <template #default="{ row }"><el-tag :type="row.status === 'running' ? 'warning' : 'info'" size="small" effect="plain">{{ leaseStatusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="target" width="130" show-overflow-tooltip><template #default="{ row }"><code>{{ row.target }}</code></template></el-table-column>
        <el-table-column label="owner" width="150" show-overflow-tooltip><template #default="{ row }"><code>{{ row.executor_id || 'inhub' }}</code></template></el-table-column>
        <el-table-column label="thread" width="90"><template #default="{ row }">{{ row.thread_id || '—' }}</template></el-table-column>
        <el-table-column label="租约剩余" width="110">
          <template #default="{ row }"><span :class="{ dangerText: row.lease_ttl_sec < 0, warningText: row.lease_ttl_sec >= 0 && row.lease_ttl_sec < 30 }">{{ ttlLabel(row.lease_ttl_sec) }}</span></template>
        </el-table-column>
        <el-table-column label="认领时间" width="130"><template #default="{ row }">{{ row.claimed_at ? fmtTime(row.claimed_at, true) : '—' }}</template></el-table-column>
        <el-table-column width="76" align="right"><template #default="{ row }"><el-button link type="primary" size="small" @click="gotoJob(row.job_id)">追溯</el-button></template></el-table-column>
      </el-table>
    </div>
  </el-card>

  <!-- 在线执行器：当前连上来的 worker 实例 -->
  <el-card shadow="never" class="panel-card last">
    <template #header>
      <div class="head">
        <b>在线执行器</b> <HelpTip title="在线执行器 / 池模型">
          <p>认领并执行任务的 worker 进程。一个 target 可由多个执行器组成「<b>池</b>」（谁先抢到谁干，等价可互换）。</p>
          <p>模型：<b>路由 → 一个 target（能力 / 队列）→ 服务它的执行器池</b>。执行器声明「我接哪些 target、能跑哪些 profile」，中枢把任务派给在线且有能力的池成员。</p>
          <p>要让不同机器干不同的事 → 用不同 <code>target</code> 或不同 <code>profile</code>，<b>不是</b>堆进同一个 target。</p>
        </HelpTip>
        <el-button style="margin-left: auto" :loading="loading" @click="load">刷新</el-button>
      </div>
    </template>
    <el-table :data="list" v-loading="loading">
      <el-table-column label="执行器" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="exec-main">
            <code>{{ row.executor_id }}</code>
            <span class="muted">{{ row.capabilities?.runtime || '未声明运行时' }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="在线状态" min-width="170">
        <template #default="{ row }">
          <div class="exec-stack">
            <el-tag :type="row.online ? 'success' : 'danger'" effect="plain" size="small">{{ row.online ? '在线' : '离线' }}</el-tag>
            <span class="muted">心跳 {{ fmtTime(row.last_seen_at, true) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="能力范围" min-width="330">
        <template #default="{ row }">
          <div class="exec-stack">
            <div class="tagline">
              <el-tag v-for="t in row.targets" :key="t" size="small" effect="plain"><code>{{ t }}</code></el-tag>
              <span v-if="!row.targets?.length" class="muted">未声明 target</span>
            </div>
            <div class="tagline">
              <template v-if="row.capabilities?.profiles?.length">
                <el-tag v-for="p in row.capabilities.profiles" :key="p" size="small" type="info" effect="plain"><code>{{ p }}</code></el-tag>
              </template>
              <el-tooltip v-else placement="top">
                <template #content>
                  <div style="max-width: 280px; line-height: 1.6">
                    该执行器没声明能跑的 profile。自带大脑的通用执行器通常不分档，这是正常情况。
                  </div>
                </template>
                <span class="muted">不分档</span>
              </el-tooltip>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="标签" min-width="150">
        <template #default="{ row }">
          <div class="tagline"><el-tag v-for="l in row.capabilities?.labels || []" :key="l" size="small" effect="plain">{{ l }}</el-tag></div>
          <span v-if="!row.capabilities?.labels?.length" class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column width="70" align="right">
        <template #default="{ row }">
          <el-popconfirm :title="`注销执行器 ${row.executor_id} 的心跳记录？仅删登记（清退役/测试残留），它下次 claim 会自动重新登记。`" width="280" @confirm="delExec(row.executor_id)">
            <template #reference><el-button link type="danger">注销</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted" style="padding: 16px">还没有执行器在线。先在上方签发一个令牌，再到「触发路由 → 调用代码 → 智能体技能·干活」复制接入指令发给你的智能体。</div>
      </template>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑令牌' : '签发执行器令牌'" size="440px">
    <el-form label-position="top">
      <el-form-item>
        <template #label>{{ tokenFieldTitle('name', '标识') }} <span v-if="tokenFieldRequired('name')" class="field-required">必填</span> <HelpTip :title="tokenFieldTitle('name', '标识')">
          <p>{{ tokenFieldDesc('name') }}</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 worker-dev-token / partner-agent-token" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ tokenFieldTitle('allowed_targets', '可认领目标') }} <span v-if="tokenFieldRequired('allowed_targets')" class="field-required">必填</span> <HelpTip :title="tokenFieldTitle('allowed_targets', '可认领目标')">
          <p>{{ tokenFieldDesc('allowed_targets') }}</p>
        </HelpTip></template>
        <el-select v-model="form.allowed_targets" multiple filterable allow-create style="width: 100%" placeholder="选这个令牌能认领哪些 target">
          <el-option value="*" label="*（全部 executor 目标，生产慎用）" />
          <el-option v-for="t in execTargets" :key="t" :value="t" :label="t" />
        </el-select>
      </el-form-item>
      <el-form-item label="说明（可选）"><el-input v-model="form.description" placeholder="如 开发环境 worker / 合作方执行器" /></el-form-item>
      <el-form-item v-if="editing" label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      <el-form-item v-if="editing"><el-checkbox v-model="form.rotate_token">轮换令牌（旧令牌立即失效，需把新值重新发给执行器）</el-checkbox></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="tokenShow" title="令牌（只显示这一次，请立即复制）" width="520px">
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 10px"
      title="这是完整令牌，关闭后列表只显示掩码。把它填进执行器的 --token。" />
    <div class="codewrap"><pre class="codeblock">{{ newToken }}</pre><el-button size="small" @click="copyText(newToken)">复制</el-button></div>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { copyText, fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

interface ExecutorRow {
  executor_id: string; online: boolean; last_seen_at: string; targets: string[];
  capabilities: { profiles?: string[]; runtime?: string; labels?: string[] } | null;
}
interface DispatchStatus {
  now: string;
  summary: { queued: number; running: number; dispatched: number; delayed_queued: number; expired_leases: number; blocked_threads: number };
  by_target: Array<{ target: string; queued: number; running: number; dispatched: number }>;
  leases: Array<{ job_id: string; request_id: string; status: string; target: string; executor_id?: string; thread_id?: number; claimed_at?: string; lease_until?: string; lease_ttl_sec?: number }>;
  blocked_threads: Array<{ thread_id: number; queued: number; oldest_queued_at: string; inflight: string; inflight_jobs: string[] }>;
}

const router = useRouter();
const tokenSchema = useConfigSchema('executor-token');
const dispatch = ref<DispatchStatus | null>(null);
const dispatchLoading = ref(false);

async function loadDispatch(): Promise<void> {
  dispatchLoading.value = true;
  try { dispatch.value = await api('/admin/api/dispatch-status'); }
  catch (e) { ElMessage.error((e as Error).message); }
  finally { dispatchLoading.value = false; }
}

function ttlLabel(v: number | undefined): string {
  if (v === undefined || v === null) return '—';
  if (v < 0) return `过期 ${Math.abs(v)}s`;
  if (v < 60) return `${v}s`;
  return `${Math.floor(v / 60)}m ${v % 60}s`;
}
function leaseStatusLabel(status: string): string {
  if (status === 'running') return '中枢内执行';
  if (status === 'dispatched') return '执行器认领';
  return status;
}
function lastSeenLabel(v?: string): string {
  return v ? `最近接入 ${fmtTime(v, true)}` : '从未接入';
}
function gotoJob(jobId: string): void {
  void router.push({ path: '/runs', query: { job: jobId } });
}
function tokenFieldTitle(field: string, fallback: string): string {
  return schemaTitle(tokenSchema.schema.value, field, fallback);
}
function tokenFieldDesc(field: string, fallback = ''): string {
  return schemaDescription(tokenSchema.schema.value, field, fallback);
}
function tokenFieldRequired(field: string): boolean {
  return schemaRequired(tokenSchema.required.value, field);
}

// ---- 在线执行器 ----
const list = ref<ExecutorRow[]>([]);
const loading = ref(false);
async function load(): Promise<void> {
  loading.value = true;
  try { list.value = await api('/admin/api/executors'); }
  catch (e) { ElMessage.error((e as Error).message); }
  finally { loading.value = false; }
}
async function delExec(id: string): Promise<void> {
  try { await api('/admin/api/executors/' + encodeURIComponent(id), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}

// ---- 接入令牌 ----
const tokens = ref<any[]>([]);
const tkLoading = ref(false);
const execTargets = ref<string[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ name: '', allowed_targets: [] as string[], description: '', enabled: true, rotate_token: false });
const tokenShow = ref(false);
const newToken = ref('');

async function loadTokens(): Promise<void> {
  tkLoading.value = true;
  try {
    tokens.value = await api('/admin/api/executor-tokens');
    const ts = await api<any[]>('/admin/api/targets').catch(() => []);
    execTargets.value = ts.filter((t) => t.kind === 'executor').map((t) => t.name);
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { tkLoading.value = false; }
}
function openCreate(): void {
  editing.value = false;
  Object.assign(form, { name: '', allowed_targets: [], description: '', enabled: true, rotate_token: false });
  open.value = true;
}
function openEdit(row: any): void {
  editing.value = true;
  Object.assign(form, { name: row.name, allowed_targets: (row.allowed_targets || []).slice(), description: row.description || '', enabled: !!row.enabled, rotate_token: false });
  open.value = true;
}
async function save(): Promise<void> {
  saving.value = true;
  try {
    const r = await api<{ token: string }>('/admin/api/executor-tokens', { method: 'POST', body: JSON.stringify(form) });
    open.value = false;
    if (!editing.value || form.rotate_token) { newToken.value = r.token; tokenShow.value = true; }
    else ElMessage.success('已保存');
    await loadTokens();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function reveal(name: string): Promise<void> {
  try { const r = await api<{ token: string }>('/admin/api/executor-tokens/' + encodeURIComponent(name) + '/token'); await copyText(r.token, '完整令牌已复制'); }
  catch (e) { ElMessage.error((e as Error).message); }
}
async function delToken(name: string): Promise<void> {
  try { await api('/admin/api/executor-tokens/' + encodeURIComponent(name), { method: 'DELETE' }); await loadTokens(); }
  catch (e) { ElMessage.error((e as Error).message); }
}

onMounted(() => { void tokenSchema.load().catch(() => undefined); void load(); void loadTokens(); void loadDispatch(); });
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.dangerText { color: var(--el-color-danger); }
.warningText { color: var(--el-color-warning); }
.panel-card { margin-bottom: 16px; border-radius: 0; }
.panel-card.last { margin-bottom: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.exec-main,
.exec-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.exec-main code {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-family: var(--bz-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tagline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.sub { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
.dispatchStats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.dispatchStats > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px 10px; background: var(--el-fill-color-light); }
.dispatchStats span, .dispatchStats b { display: block; }
.dispatchStats b { margin-top: 3px; font-size: 16px; }
.dispatchGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.note { font-size: 12px; line-height: 1.7; color: var(--el-text-color-regular); }
.codewrap { display: flex; align-items: center; gap: 10px; }
.codeblock { flex: 1; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin: 0; font: 12px/1.5 var(--bz-mono); overflow-x: auto; }
code { font-family: var(--bz-mono); }
@media (max-width: 1000px) {
  .dispatchStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dispatchGrid { grid-template-columns: 1fr; }
}
</style>
