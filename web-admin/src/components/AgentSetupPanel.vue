<template>
  <el-drawer :model-value="modelValue" size="min(1080px, 96vw)" :with-header="false" :before-close="beforeClose" @closed="clear">
    <div class="setup-panel" v-loading="loading">
      <header class="setup-header">
        <div><span class="eyebrow">本地智能体接入</span><h2>{{ client?.name || '配置接入' }}</h2><p>在这里完成授权入口、系统介绍与工具范围配置。</p></div>
        <el-button @click="beforeClose(() => emit('update:modelValue', false))">关闭</el-button>
      </header>
      <el-alert v-if="loadError" type="error" :title="loadError" :closable="false" show-icon />
      <template v-if="client">
        <nav class="setup-steps" aria-label="接入配置步骤">
          <button v-for="(item, index) in steps" :key="item" :class="{ active: step === index }" :disabled="savingClient || savingRoute" @click="step = index"><span>{{ index + 1 }}</span>{{ item }}</button>
        </nav>
        <section v-show="step === 0" class="setup-section">
          <h3>让用户通过业务系统确认身份</h3>
          <p class="description">复用当前接入方。账号、租户和业务权限仍由业务授权页确认。</p>
          <el-alert v-if="!me.can('clients:write')" type="info" :closable="false" title="当前账号可查看授权入口，保存需要接入方管理权限。" />
          <el-form label-position="top" :disabled="savingClient || !me.can('clients:write')">
            <el-form-item label="接入方标识"><el-input :model-value="client.app_id" readonly /></el-form-item>
            <el-form-item label="允许此接入方连接中枢"><el-switch v-model="client.enabled" /><span class="inline-note">停用会影响此接入方的其他入口。</span></el-form-item>
            <el-form-item label="业务授权入口">
              <el-input v-model="client.agent_authorize_url" placeholder="https://business.example.com/agent/authorize" maxlength="2048" />
              <div class="field-note">填写业务系统提供的固定 HTTPS 地址。用户将在该页面登录并确认本次授权。</div>
            </el-form-item>
            <el-form-item label="允许连接的工作空间">
              <el-select v-model="client.allowed_routes" multiple filterable allow-create default-first-option style="width:100%" placeholder="选择已存在的工作空间">
                <el-option v-for="item in workspaces" :key="item.route" :label="`${item.name} · ${item.route}`" :value="item.route" />
                <el-option value="*" label="所有工作空间（包含以后新增的空间）" />
              </el-select>
              <div class="field-note">工作空间对应中枢现有业务路由。这里限定接入范围，不授予业务账号额外权限。</div>
            </el-form-item>
          </el-form>
          <div class="section-footer"><span>{{ clientDirty ? '授权入口有未保存修改' : '授权入口配置已同步' }}</span><el-button type="primary" :loading="savingClient" :disabled="!clientDirty || !me.can('clients:write')" @click="saveClient">保存授权入口</el-button></div>
        </section>

        <template v-if="step === 1 || step === 2">
          <div class="workspace-selector">
            <div><b>配置哪个工作空间</b><p>以下设置保存在原业务路由中，使用同一路由的接入方会共享这些设置。</p></div>
            <el-select :model-value="workspaceKey" :disabled="savingClient || savingRoute" filterable placeholder="选择一个工作空间" @change="selectWorkspace">
              <el-option v-for="item in selectedWorkspaces" :key="item.route" :label="`${item.name} · ${item.route}`" :value="item.route" />
            </el-select>
          </div>
          <el-alert v-if="routeError" type="error" :title="routeError" :closable="false" show-icon />
          <el-empty v-if="!workspaceKey" :description="selectedWorkspaces.length ? '在上方选择要配置的工作空间。' : '还没有可选工作空间，请先在授权入口中关联一个已有空间。'" />
          <div v-loading="routeLoading" v-if="workspaceKey">
            <template v-if="route">
              <el-alert v-if="!route.enabled" title="这个工作空间已停用。完成配置后，还需在业务路由中恢复空间运行。" type="warning" :closable="false" show-icon />
              <section v-show="step === 1" class="setup-section">
                <h3>让智能体先知道这个系统负责什么</h3>
                <p class="description">说明会在首次搜索工具前提供给已选中的授权。它描述系统定位，具体可执行动作仍以授权后的工具查询为准。</p>
                <el-form label-position="top" :disabled="savingRoute || !me.can('routes:write')">
                  <el-form-item label="启用本地智能体"><el-switch v-model="runtime.enabled" /><span class="inline-note">开启本地会话编排；工具调用在下一步单独设置。</span></el-form-item>
                  <el-form-item label="业务系统名称"><el-input v-model="info.name" placeholder="例如：客户服务系统" maxlength="120" show-word-limit /></el-form-item>
                  <el-form-item label="一句话介绍"><el-input v-model="info.summary" placeholder="例如：处理客户咨询、服务工单和售后跟进。" maxlength="400" show-word-limit /></el-form-item>
                  <el-form-item label="典型业务方向"><el-select v-model="info.domains" multiple filterable allow-create default-first-option :multiple-limit="6" style="width:100%" placeholder="输入一个方向后按回车，最多6项"><el-option v-for="item in info.domains" :key="item" :label="item" :value="item" /></el-select></el-form-item>
                  <el-form-item label="系统边界"><el-select v-model="info.boundaries" multiple filterable allow-create default-first-option :multiple-limit="6" style="width:100%" placeholder="例如：财务结算由其他系统负责；最多6项"><el-option v-for="item in info.boundaries" :key="item" :label="item" :value="item" /></el-select></el-form-item>
                </el-form>
                <div class="model-preview"><span>智能体看到的系统定位</span><b>{{ info.name || '系统定位未提供' }}</b><p>{{ info.summary || '尚未配置说明，客户端仍可按原流程查询已授权的业务工具。' }}</p><small>说明仅供目标选择参考 · 工具可能尚未加载 · 不代表已获得写入权限</small></div>
              </section>
              <section v-show="step === 2" class="setup-section">
                <h3>限定智能体可以使用的业务动作</h3>
                <p class="description">工作空间的工具源与范围继续复用原配置。开启后仍会逐次校验业务身份、权限和审批。</p>
                <el-alert v-if="route.permission === 'readonly'" title="这个工作空间的权限档为只读。即使填写写操作清单，也不会开放写入；如需调整，请在业务路由的权限与治理中核对。" type="warning" :closable="false" show-icon />
                <el-form label-position="top" :disabled="savingRoute || !me.can('routes:write')">
                  <el-form-item label="允许本地智能体调用工具"><el-switch v-model="direct.enabled" /></el-form-item>
                  <el-alert v-if="runtime.enabled && !direct.enabled" title="本地会话已启用，但业务工具调用未开启。用户可以完成授权，暂时无法通过此空间发现或操作业务工具。" type="warning" :closable="false" show-icon />
                  <el-divider content-position="left">生成图片上传</el-divider>
                  <el-form-item label="允许上传生成图片"><el-switch v-model="artifacts.enabled" /><div class="field-note">将智能体生成的图片保存到所选媒体存储，返回 URL 供商品等业务使用。上传不等于已修改业务数据。</div></el-form-item>
                  <template v-if="artifacts.enabled">
                    <el-form-item label="保存到哪个媒体存储"><el-select v-model="artifacts.bucket" filterable allow-create placeholder="选择已登记的存储" style="width:100%"><el-option v-for="b in storageOptions" :key="b.name" :value="b.name" :label="`${b.name} · ${b.kind}${b.enabled ? '' : '（已停用）'}`" :disabled="!b.enabled" /></el-select><div class="field-note"><router-link to="/storage">前往媒体存储配置 COS／OSS 或本地存储</router-link>。此处不填写密钥。文件由部署方管理，不随会话结束清理。</div></el-form-item>
                    <el-form-item label="单张图片大小上限（字节）"><el-input-number v-model="artifacts.max_bytes" :min="1" :max="6291456" /><span class="inline-note">默认 6 MiB</span></el-form-item>
                    <el-form-item label="允许的图片类型"><el-select v-model="artifacts.allowed_mimes" multiple><el-option v-for="m in ['image/png','image/jpeg','image/webp']" :key="m" :label="m" :value="m" /></el-select></el-form-item>
                  </template>
                  <el-divider content-position="left">业务工具</el-divider>
                  <div class="source-heading"><b>使用哪些工具源</b><el-button size="small" :disabled="savingRoute || !me.can('routes:write')" @click="addSource">添加工具源</el-button></div>
                  <p v-if="providerError" class="inline-error">{{ providerError }}</p>
                  <el-empty v-if="!sources.length" description="尚未关联工具源。添加已有业务工具源并选择范围。" :image-size="56" />
                  <div class="source-card" v-for="(source, index) in sources" :key="source._key">
                    <div class="source-top"><b>工具源 {{ index + 1 }}</b><el-button link type="danger" :disabled="savingRoute || !me.can('routes:write')" @click="sources.splice(index, 1)">移除</el-button></div>
                    <el-form-item label="已登记的工具源"><el-select v-model="source.config.provider" filterable allow-create style="width:100%" @change="clearCatalog(source)"><el-option v-for="p in providers" :key="p.name" :value="p.name" :label="p.description ? `${p.name} · ${p.description}` : p.name" /></el-select></el-form-item>
                    <el-form-item label="允许的工具范围（scope）"><el-select v-model="source.config.allow" multiple filterable allow-create default-first-option style="width:100%" placeholder="选择范围或输入精确scope"><el-option v-for="scope in sourceScopes(source)" :key="scope" :value="scope" :label="scope" /><el-option value="*" label="全部scope（包含该工具源以后新增的scope）" /></el-select><div class="field-note">只读工具按范围开放；写操作还需要下方的精确清单。</div></el-form-item>
                    <div class="catalog-action"><el-button size="small" :disabled="!source.config.provider" :loading="source._loading" @click="loadCatalog(source)">读取工具目录</el-button><span>{{ source._loaded ? `${source._tools.length} 个已声明工具` : '尚未读取目录，可手工填写已知scope和操作标识' }}</span></div>
                    <p class="inline-error" v-if="source._error">{{ source._error }}</p>
                    <el-table v-if="source._tools.length" :data="source._tools" size="small" max-height="240" style="margin-top:14px">
                      <el-table-column label="业务动作" min-width="200" show-overflow-tooltip><template #default="{ row }"><span>{{ row.description || row.name }}</span><div class="field-note">{{ row.name }}</div></template></el-table-column>
                      <el-table-column label="类型" width="70"><template #default="{ row }">{{ row.readonly ? '查询' : '写入' }}</template></el-table-column>
                      <el-table-column label="当前配置" min-width="150"><template #default="{ row }">{{ toolConfiguration(source, row) }}</template></el-table-column>
                    </el-table>
                  </div>
                  <el-form-item label="允许的写操作" class="write-field"><el-select v-model="direct.write_tools" multiple filterable allow-create default-first-option style="width:100%" placeholder="留空时不开放写操作；只接受精确operationId"><el-option v-for="tool in writeOptions" :key="tool.name" :value="tool.name" :label="`${tool.name} · ${tool.scope}${tool.confirm_required || tool.risk === 'high' ? ' · 原规则需审批' : ''}`" /></el-select><div class="field-note">不能填写 *。选中的操作仍须通过原 scope、主体、风险与审批规则。</div></el-form-item>
                  <el-form-item label="额外要求审批的写操作"><el-select v-model="direct.force_approval_tools" multiple filterable style="width:100%" placeholder="可进一步收紧审批要求"><el-option v-for="name in direct.write_tools" :key="name" :value="name" :label="name" /></el-select><div class="field-note">这里只增加审批要求，不会取消工具本身要求的审批。</div></el-form-item>
                </el-form>
                <el-collapse><el-collapse-item title="高级运行设置" name="advanced"><el-form label-position="top" :disabled="savingRoute || !me.can('routes:write')"><el-form-item label="每轮主动加载的工具上限"><el-input-number v-model="runtime.active_tool_limit" :min="1" :max="12" /></el-form-item><el-form-item label="本地编排补充规则"><el-input v-model="runtime.instructions" type="textarea" :rows="3" maxlength="20000" /><div class="field-note">延续已有运行规则；系统介绍应填写在上一步。</div></el-form-item></el-form></el-collapse-item></el-collapse>
              </section>
              <div class="section-footer"><span>{{ !me.can('routes:write') ? '当前账号没有工作空间修改权限' : routeDirty ? '工作空间有未保存修改' : '工作空间配置已同步' }}</span><el-button type="primary" :loading="savingRoute" :disabled="!routeDirty || !me.can('routes:write')" @click="saveRoute">保存工作空间</el-button></div>
            </template>
          </div>
        </template>

        <section v-show="step === 3" class="setup-section">
          <h3>检查已保存的接入配置</h3><p class="description">连接配置只包含中枢地址、接入方和工作空间。用户登录后，实际可用工具会按原业务授权确定。</p>
          <el-alert v-if="clientDirty || routeDirty" title="还有未保存的修改。下方状态和连接配置仅反映已保存内容。" type="warning" :closable="false" show-icon />
          <div class="check-item"><span>接入方</span><b>{{ persistedClient?.enabled ? '已启用' : '已停用' }}</b></div>
          <div class="check-item"><span>业务授权入口</span><b>{{ persistedClient?.agent_authorize_url ? '已配置' : '尚未配置' }}</b></div>
          <div v-for="item in savedWorkspaces" :key="item.route" class="workspace-result"><div><b>{{ item.name }}</b><code>{{ item.route }}</code></div><p>{{ workspaceStatus(item) }}</p><el-button type="primary" plain size="small" :disabled="!persistedClient?.enabled || !persistedClient?.agent_authorize_url || !item.enabled || !item.runtime_enabled" @click="emit('connect', { app_id: client.app_id, workspace: item.route })">生成连接配置</el-button></div>
          <el-empty v-if="!savedWorkspaces.length" description="尚无可连接的工作空间。请先保存授权入口配置。" :image-size="70" />
          <p class="field-note">系统说明缺失不会阻断已有连接；工具范围与服务可用性将在授权后进一步校验。</p>
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { kernelFetch } from '../runtime-path';
import { useMe } from '../store';

interface Workspace { route: string; name: string; enabled: boolean; runtime_enabled: boolean; direct_enabled: boolean; system_info_configured?: boolean; source_count?: number }
interface ClientSetup { app_id: string; name: string; enabled: boolean; agent_authorize_url: string | null; allowed_routes: string[]; revision: string }
interface Tool { name: string; description?: string; scope: string; readonly: boolean; risk?: string; confirm_required?: boolean }
interface Source { config: { provider: string; allow: string[]; [key: string]: any }; _key: number; _tools: Tool[]; _loaded: boolean; _loading: boolean; _error: string }
const props = defineProps<{ modelValue: boolean; appId: string; workspaces: Workspace[]; initialWorkspace?: string }>();
const me = useMe();
const emit = defineEmits(['update:modelValue', 'saved', 'connect']);
const steps = ['授权入口', '系统说明', '工具与审批', '检查连接'];
const step = ref(0); const loading = ref(false); const loadError = ref('');
const client = ref<ClientSetup | null>(null); const persistedClient = ref<ClientSetup | null>(null);
const clientBaseline = ref(''); const savingClient = ref(false);
const workspaceKey = ref(''); const route = ref<any>(null); const routeBaseline = ref(''); const routeLoading = ref(false); const routeError = ref(''); const savingRoute = ref(false);
const storageOptions = ref<Array<{ name: string; kind: string; enabled: boolean }>>([]);
const artifacts = reactive({ enabled: false, bucket: '', max_bytes: 6291456, allowed_mimes: ['image/png', 'image/jpeg', 'image/webp'] });
const runtime = reactive({ enabled: false, instructions: '', active_tool_limit: 8 });
const info = reactive({ name: '', summary: '', domains: [] as string[], boundaries: [] as string[] });
const direct = reactive({ enabled: false, write_tools: [] as string[], force_approval_tools: [] as string[] });
const sources = ref<Source[]>([]); const providers = ref<Array<{ name: string; description?: string }>>([]); const providerError = ref('');
let requestId = 0; let sourceKey = 0;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clientValue = () => client.value ? { enabled: client.value.enabled, agent_authorize_url: client.value.agent_authorize_url?.trim() || null, allowed_routes: client.value.allowed_routes } : null;
const clientDirty = computed(() => Boolean(client.value) && JSON.stringify(clientValue()) !== clientBaseline.value);
const selectedWorkspaces = computed(() => props.workspaces.filter((w) => client.value?.allowed_routes.includes('*') || client.value?.allowed_routes.includes(w.route)));
const savedWorkspaces = computed(() => props.workspaces.filter((w) => persistedClient.value?.allowed_routes.includes('*') || persistedClient.value?.allowed_routes.includes(w.route)));
const hasInfo = () => Boolean(info.name || info.summary || info.domains.length || info.boundaries.length);
function routeValue(): any {
  const agent = { ...(route.value?.agent_client || {}), ...runtime };
  if (artifacts.enabled || route.value?.agent_client?.artifact_upload) agent.artifact_upload = { ...clone(artifacts), bucket: artifacts.bucket || undefined };
  if (hasInfo()) agent.system_info = clone(info); else delete agent.system_info;
  const d = { ...(route.value?.agent_direct || {}), enabled: direct.enabled };
  delete d.unattended_write_tools;
  if (direct.write_tools.length) d.write_tools = [...direct.write_tools]; else delete d.write_tools;
  if (direct.force_approval_tools.length) d.force_approval_tools = [...direct.force_approval_tools]; else delete d.force_approval_tools;
  return { agent_client: agent, agent_direct: d, tool_sources: sources.value.map((source) => clone(source.config)) };
}
const routeDirty = computed(() => Boolean(route.value) && JSON.stringify(routeValue()) !== routeBaseline.value);
const writeOptions = computed(() => {
  const result = new Map<string, Tool>();
  for (const source of sources.value) for (const tool of source._tools) {
    if (!tool.readonly && (source.config.allow.includes('*') || source.config.allow.includes(tool.scope))) result.set(tool.name, tool);
  }
  return [...result.values()];
});
function workspaceStatus(item: Workspace): string {
  if (!item.enabled) return '工作空间已停用';
  if (!item.runtime_enabled) return '尚未启用本地智能体';
  if (!item.direct_enabled) return '可配置连接；业务工具调用尚未开启';
  if (!item.source_count) return '工具调用已开启；尚未关联工具源';
  return `连接与工具通道已配置${item.system_info_configured ? '' : '；建议补充系统说明'}`;
}
async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await kernelFetch(path, init); const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 409) throw new Error('配置已被其他操作更新。请关闭面板后重新打开，核对最新配置再保存。');
    if (response.status === 403) throw new Error('当前账号没有这部分配置的读取或修改权限，请联系中枢管理员。');
    if (data.error === 'agent_setup_unsupported') throw new Error('当前宿主尚不支持集中保存，请升级配套宿主后再试。');
    throw new Error(data.error || '请求失败，请稍后重试');
  }
  return data;
}
async function open(): Promise<void> {
  clear(); const id = ++requestId; loading.value = true;
  try {
    const value = await api(`/admin/api/clients/${encodeURIComponent(props.appId)}/agent-setup`);
    if (id !== requestId || !props.modelValue) return;
    client.value = clone(value); persistedClient.value = clone(value); clientBaseline.value = JSON.stringify(clientValue());
    const initial = props.initialWorkspace && selectedWorkspaces.value.find((w) => w.route === props.initialWorkspace);
    if (initial) { step.value = 1; await selectWorkspace(initial.route); }
  } catch (e) { if (id === requestId) loadError.value = message(e); }
  finally { if (id === requestId) loading.value = false; }
}
function message(e: unknown): string { return e instanceof Error ? e.message : '操作失败'; }
async function saveClient(): Promise<void> {
  if (!client.value || savingClient.value || savingRoute.value || !me.can('clients:write')) return;
  const id = requestId; const appId = client.value.app_id; const payload = clone({ expected_revision: client.value.revision, ...clientValue() });
  savingClient.value = true;
  try {
    const saved = await api(`/admin/api/clients/${encodeURIComponent(appId)}/agent-setup`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (id !== requestId || client.value?.app_id !== appId || !props.modelValue) return;
    client.value = clone(saved); persistedClient.value = clone(saved); clientBaseline.value = JSON.stringify(clientValue()); emit('saved'); ElMessage.success('授权入口已保存');
  } catch (e) { if (id === requestId) ElMessage.error(message(e)); } finally { if (id === requestId) savingClient.value = false; }
}
async function selectWorkspace(key: string): Promise<void> {
  if (savingClient.value || savingRoute.value) return;
  if (routeDirty.value && !await discard()) return;
  const id = ++requestId; workspaceKey.value = key; route.value = null; routeBaseline.value = ''; routeError.value = ''; routeLoading.value = true;
  try {
    const value = await api(`/admin/api/routes/${encodeURIComponent(key)}/agent-setup`);
    if (id !== requestId || !props.modelValue) return;
    hydrateRoute(value);
    void loadProviders(id);
    if (me.can('storage:read')) void api('/admin/api/storage-buckets').then(values => { if (id === requestId) storageOptions.value = values.map((b: any) => ({ name: b.name, kind: b.kind, enabled: b.enabled })); }).catch(() => {});
  } catch (e) { if (id === requestId) routeError.value = message(e); }
  finally { if (id === requestId) { routeLoading.value = false; loading.value = false; } }
}
function hydrateRoute(value: any): void {
  route.value = value;
  Object.assign(artifacts, { enabled: false, bucket: '', max_bytes: 6291456, allowed_mimes: ['image/png', 'image/jpeg', 'image/webp'] }, clone(value.agent_client?.artifact_upload || {}));
    Object.assign(runtime, { enabled: value.agent_client?.enabled ?? value.agent_direct?.enabled === true, instructions: value.agent_client?.instructions || '', active_tool_limit: value.agent_client?.active_tool_limit || 8 });
    Object.assign(info, clone(value.agent_client?.system_info || { name: '', summary: '', domains: [], boundaries: [] }));
    const d = value.agent_direct || {}; const writes: string[] = d.write_tools || [];
    Object.assign(direct, { enabled: d.enabled === true, write_tools: [...writes], force_approval_tools: [...(d.force_approval_tools || (Array.isArray(d.unattended_write_tools) ? writes.filter((x) => !d.unattended_write_tools.includes(x)) : []))] });
    sources.value = (value.tool_sources || []).map((source: any) => makeSource(source)); routeBaseline.value = JSON.stringify(routeValue());
}
async function loadProviders(id: number): Promise<void> {
  providerError.value = '';
  try { const values = await api('/admin/api/tool-providers'); if (id === requestId) providers.value = values; }
  catch { if (id === requestId) providerError.value = '暂时无法读取工具源目录。现有配置保留，也可以手工填写已登记的工具源标识。'; }
}
function makeSource(raw: any = {}): Source { return { config: { ...clone(raw), provider: raw.provider || '', allow: [...(raw.allow || [])] }, _key: ++sourceKey, _tools: [], _loaded: false, _loading: false, _error: '' }; }
function addSource(): void { sources.value.push(makeSource()); }
function clearCatalog(source: Source): void { source._tools = []; source._loaded = false; source._error = ''; }
function sourceScopes(source: Source): string[] { return [...new Set(source._tools.map((tool) => tool.scope))]; }
function toolConfiguration(source: Source, tool: Tool): string {
  if (!source.config.allow.includes('*') && !source.config.allow.includes(tool.scope)) return '范围未包含';
  if (tool.readonly) return '已纳入查询范围';
  return direct.write_tools.includes(tool.name) ? '已列入写操作清单' : '未开放写入';
}
async function loadCatalog(source: Source): Promise<void> {
  const provider = source.config.provider; const id = requestId; source._loading = true; source._error = '';
  try {
    const value = await api(`/admin/api/tool-providers/${encodeURIComponent(provider)}/tools`);
    if (id !== requestId || source.config.provider !== provider || !sources.value.includes(source)) return;
    source._tools = value.tools || [];
    const skipped = Array.isArray(value.skipped) ? value.skipped.length : Number(value.skipped || 0);
    const notices = [value.note, skipped ? `${skipped} 个声明未通过编译` : '', Array.isArray(value.warnings) && value.warnings.length ? `${value.warnings.length} 项目录提醒` : ''].filter(Boolean);
    source._loaded = !value.note; source._error = notices.join('；');
  } catch (e) { if (id === requestId && source.config.provider === provider) source._error = `${message(e)}；这不代表该工具源没有能力。`; }
  finally { source._loading = false; }
}
async function saveRoute(): Promise<void> {
  if (!route.value || savingClient.value || savingRoute.value || !me.can('routes:write')) return;
  if (hasInfo() && (!info.name.trim() || !info.summary.trim())) { ElMessage.warning('填写系统说明时，系统名称和一句话介绍都需要提供。'); return; }
  if (info.domains.some((x) => !x.trim() || x.length > 120) || info.boundaries.some((x) => !x.trim() || x.length > 160)) { ElMessage.warning('业务方向每项不超过120字，系统边界每项不超过160字。'); return; }
  if ([...direct.write_tools, ...direct.force_approval_tools].some((x) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) || direct.force_approval_tools.some((x) => !direct.write_tools.includes(x))) { ElMessage.warning('写操作需要精确operationId；额外审批只能选择已允许的写操作。'); return; }
  const id = requestId; const key = workspaceKey.value; const payload = clone({ expected_revision: route.value.revision, ...routeValue() });
  savingRoute.value = true;
  try {
    const saved = await api(`/admin/api/routes/${encodeURIComponent(key)}/agent-setup`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (id !== requestId || workspaceKey.value !== key || !props.modelValue) return;
    hydrateRoute(saved); emit('saved'); ElMessage.success('工作空间配置已保存');
  } catch (e) { if (id === requestId) ElMessage.error(message(e)); } finally { if (id === requestId) savingRoute.value = false; }
}
async function discard(): Promise<boolean> { try { await ElMessageBox.confirm('有未保存的修改，离开会放弃这些修改。', '离开配置', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' }); return true; } catch { return false; } }
async function beforeClose(done: () => void): Promise<void> { if (savingClient.value || savingRoute.value) return; if ((clientDirty.value || routeDirty.value) && !await discard()) return; emit('update:modelValue', false); done(); }
function clear(): void { requestId++; savingClient.value = false; savingRoute.value = false; step.value = 0; client.value = null; persistedClient.value = null; route.value = null; workspaceKey.value = ''; sources.value = []; loadError.value = ''; routeError.value = ''; loading.value = false; }
watch(() => [props.modelValue, props.appId], () => { if (props.modelValue && props.appId) void open(); });
</script>

<style scoped>
.setup-panel{max-width:920px;margin:auto;color:var(--el-text-color-primary)}
.setup-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 0 24px}.eyebrow{font-size:12px;color:var(--el-color-primary);font-weight:600}.setup-header h2{font-size:24px;margin:7px 0 9px}.setup-header p,.description{color:var(--el-text-color-secondary);font-size:14px;line-height:1.7;margin:0}
.setup-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:6px;background:var(--el-fill-color-light);border-radius:12px;margin-bottom:24px}.setup-steps button{border:0;background:transparent;text-align:left;padding:12px 10px;color:var(--el-text-color-secondary);cursor:pointer;border-radius:8px;font:inherit;font-size:13px}.setup-steps button span{display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;border-radius:50%;margin-right:7px;background:var(--el-fill-color-darker)}.setup-steps button.active{background:var(--el-bg-color);color:var(--el-color-primary);box-shadow:0 2px 8px #00000008}.setup-steps button.active span{background:var(--el-color-primary-light-9);color:var(--el-color-primary)}
.setup-section{padding:4px 4px 16px}.setup-section h3{font-size:18px;margin:8px 0 9px}.description{margin-bottom:22px}.field-note,.inline-note{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.field-note{margin-top:7px;width:100%}.inline-note{margin-left:12px}.section-footer{display:flex;justify-content:space-between;align-items:center;padding:18px 0;border-top:1px solid var(--el-border-color-lighter);gap:14px}.section-footer span{font-size:12px;color:var(--el-text-color-secondary)}.workspace-selector{padding:18px;background:var(--el-fill-color-light);border-radius:10px;margin-bottom:22px;display:grid;grid-template-columns:1fr 290px;gap:20px;align-items:center}.workspace-selector p{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary);margin:7px 0 0}.model-preview{padding:20px;background:var(--el-color-primary-light-9);border:1px solid var(--el-color-primary-light-7);border-radius:10px}.model-preview span,.model-preview b{display:block}.model-preview span{font-size:12px;color:var(--el-color-primary);margin-bottom:10px}.model-preview p{font-size:14px;line-height:1.7}.model-preview small{font-size:12px;color:var(--el-text-color-secondary)}
.source-heading,.source-top,.catalog-action{display:flex;justify-content:space-between;align-items:center;gap:12px}.source-heading{margin:24px 0 12px}.source-card{border:1px solid var(--el-border-color-light);border-radius:10px;padding:16px;margin-bottom:12px}.source-top{margin-bottom:18px}.catalog-action{justify-content:flex-start}.catalog-action span{font-size:12px;color:var(--el-text-color-secondary)}.write-field{margin-top:24px}.inline-error{color:var(--el-color-danger);font-size:12px;line-height:1.6}.check-item{display:flex;justify-content:space-between;padding:17px 2px;border-bottom:1px solid var(--el-border-color-lighter);font-size:14px}.workspace-result{display:grid;grid-template-columns:1fr auto;gap:12px;padding:20px;border:1px solid var(--el-border-color-light);border-radius:10px;margin:16px 0}.workspace-result code{display:block;color:var(--el-text-color-secondary);font-size:12px;margin-top:6px}.workspace-result p{grid-row:2;grid-column:1/-1;font-size:13px;margin:0;color:var(--el-text-color-secondary)}
@media(max-width:760px){.setup-steps{grid-template-columns:1fr 1fr}.workspace-selector{grid-template-columns:1fr}.setup-header h2{font-size:20px}.catalog-action{align-items:flex-start;flex-direction:column}.inline-note{display:block;margin-left:0}.workspace-result{grid-template-columns:1fr}.workspace-result p{grid-row:auto}}
</style>
