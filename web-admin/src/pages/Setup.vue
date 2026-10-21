<template>
  <div class="setup">
    <el-card shadow="never">
      <template #header>
        <div class="head">
          <span><b>接入向导</b> <HelpTip title="接入向导是什么">
            <p>先选择要完成的任务，再按配置之间的依赖逐步接入。</p>
            <p>「已配置」只说明已保存相应配置；模型、业务鉴权、工具及真实执行结果需要单独验证。读取失败和无权查看不会被当成没有配置。</p>
            <p>内置演示只验证演示链路，不代表你的业务系统已经接通；不会自动发起任务。</p>
          </HelpTip></span>
          <div class="headActions"><el-button size="small" @click="openDocs">开发文档</el-button><el-button size="small" :loading="loading" @click="load">刷新</el-button></div>
        </div>
      </template>

      <div class="flowChoices" role="group" aria-label="选择接入任务">
        <button type="button" :class="{ selected: flow === 'business' }" :aria-pressed="flow === 'business'" @click="selectFlow('business')">
          <b>让业务系统调用 AI</b><span>业务后端发起任务，由中枢调度模型或执行器，再查看结果。</span>
        </button>
        <button type="button" :class="{ selected: flow === 'agent' }" :aria-pressed="flow === 'agent'" @click="selectFlow('agent')">
          <b>让本地智能体操作业务系统</b><span>客户端运行模型，通过业务登录授权连接中枢工具；先准备可复用的业务路由。</span>
        </button>
      </div>

      <div class="nextPanel">
        <div class="nextMain"><span class="muted">{{ showDemoJourney ? '先体验内置演示（可选）' : '下一步' }}</span><b>{{ nextTitle }}</b><p>{{ nextDetail }}</p></div>
        <div class="nextActions">
          <template v-if="showDemoJourney">
            <el-button v-if="smoke?.run?.job_id && canViewRuns" type="primary" @click="viewSmokeTask">查看演示任务</el-button>
            <el-button v-else-if="!demoStatus?.imported && demoCanManage" type="primary" :loading="demoLoading" :disabled="busy" @click="importDemo">导入演示数据</el-button>
            <el-button v-else-if="demoStatus?.imported && me.can('audit:read')" type="primary" :loading="smokeLoading" :disabled="busy" @click="runSmoke">{{ verifiedDemo ? '重新运行演示验证' : '运行演示验证' }}</el-button>
            <el-button :type="verifiedDemo && !canViewRuns ? 'primary' : 'default'" @click="startBusiness">{{ verifiedDemo ? '接入真实业务' : '直接配置业务' }}</el-button>
          </template>
          <template v-else-if="nextStep">
            <el-button v-if="nextStep.status === 'error'" type="primary" :loading="loading" @click="load">重新读取配置</el-button>
            <el-button v-else-if="canOpen(nextStep) && nextStep.status !== 'loading'" type="primary" @click="openStep(nextStep)">{{ stepAction(nextStep) }}</el-button>
            <el-button v-else @click="openDocs">查看接入文档</el-button>
          </template>
        </div>
      </div>
      <el-alert v-if="demoActionError" :title="demoActionError" type="error" :closable="false" show-icon class="notice" />
      <el-alert v-if="smokeError" title="演示验证结果获取失败" :description="smokeError" type="error" :closable="false" show-icon class="notice" />

      <div class="progressLine"><b>业务配置准备 {{ configurationProgress }}</b><span>已配置不等于已验证；最后一步请发起真实调用。</span></div>
      <p v-if="demoStatus?.imported" class="field-hint">下方只统计真实业务配置，内置演示资源单独展示。</p>
      <div class="steps">
        <section v-for="(item, index) in steps" :key="item.key" class="step" :class="item.status">
          <div class="stepTop"><span class="num">{{ index + 1 }}</span><b>{{ item.title }}</b><el-tag size="small" effect="plain" :type="tagType(item.status)">{{ statusLabel(item.status) }}</el-tag></div>
          <p>{{ item.detail }}</p>
          <div v-if="flow === 'agent' && item.key === 'routes' && item.status === 'missing'" class="actions">
            <el-button v-if="me.can('targets:read') && me.hasModule('targets')" size="small" @click="router.push('/targets')">查看调度目标</el-button>
            <el-button v-if="me.can('credentials:read') && me.hasModule('credentials')" size="small" @click="router.push('/credentials')">查看模型凭证</el-button>
          </div>
          <span v-if="item.write && canOpen(item) && !me.can(item.write)" class="field-hint">当前账号可查看，修改需要管理员授予配置权限。</span>
          <div class="actions"><el-button v-if="canOpen(item)" size="small" :disabled="item.status === 'loading'" @click="openStep(item)">{{ stepAction(item) }}</el-button><span v-else class="field-hint">{{ item.status === 'unavailable' ? '当前实例未开放此功能' : '请联系有相应权限的管理员' }}</span></div>
        </section>
      </div>

      <div v-if="flow === 'business'" class="modelNote">
        <div><b>模型凭证（按执行方式配置）</b><p>{{ credentialDetail }}</p></div>
        <el-button v-if="me.can('credentials:read') && me.hasModule('credentials')" size="small" @click="router.push('/credentials')">查看模型凭证</el-button>
      </div>
      <div class="verificationNote"><b>验证后到哪里查看？</b><span>{{ flow === 'business' ? '业务调用返回任务编号（job_id）后，到「任务」核对执行结果与执行记录（trace）。演示成功不能代替这一步。' : '在「本地智能体」查看设备授权和运行记录，核对刚才的只读动作；连接配置生成成功不代表业务授权已完成。' }}</span><el-button v-if="flow === 'business' && canViewRuns" link type="primary" @click="router.push('/runs')">查看任务</el-button></div>
    </el-card>

    <el-card v-if="smoke" shadow="never" class="smokePanel">
      <template #header><div class="head"><b>本次演示验证结果</b><el-tag effect="plain" :type="verifiedDemo ? 'success' : 'warning'">{{ verifiedDemo ? '演示调用已完成' : '尚未完成演示验证' }}</el-tag><el-button size="small" :loading="smokeLoading" :disabled="busy || !demoStatus?.imported" @click="runSmoke">重新运行</el-button></div></template>
      <p class="field-hint">{{ verifiedDemo ? '本次只验证内置演示路由。请继续核对任务中的实际输出，再按上方路径接入业务。' : '检查无失败项也不一定代表调用成功：还需演示任务状态为 done，并取得可追溯记录。请查看下方明细。' }}</p>
      <div class="smokeMeta"><span>通过 {{ smoke.pass }} / 跳过 {{ smoke.skip }} / 失败 {{ smoke.fail }}</span><span v-if="smoke.run?.status">任务状态：{{ smoke.run.status }}</span><el-button v-if="smoke.run?.job_id && canViewRuns" link type="primary" @click="viewSmokeTask">查看任务</el-button></div>
      <el-table :data="smoke.checks" size="small" max-height="300"><el-table-column label="状态" width="80"><template #default="{ row }"><el-tag size="small" effect="plain" :type="row.status === 'pass' ? 'success' : row.status === 'fail' ? 'danger' : 'info'">{{ row.status === 'pass' ? '通过' : row.status === 'fail' ? '失败' : '跳过' }}</el-tag></template></el-table-column><el-table-column prop="name" label="检查项" min-width="190" /><el-table-column prop="detail" label="说明" min-width="240" show-overflow-tooltip /></el-table>
    </el-card>

    <el-collapse class="demoOptions">
      <el-collapse-item title="内置演示（可选）" name="demo">
        <p>使用确定性演示目标，无需购买模型算力。导入只写配置；运行演示验证 才会发起真实演示任务。它不验证本地智能体登录，也不替代真实业务验收。</p>
        <el-alert v-if="resources.demo.status !== 'ready'" :type="resources.demo.status === 'error' ? 'error' : 'info'" :title="resources.demo.error || '正在读取演示配置…'" :closable="false" />
        <p v-else-if="!demoStatus?.available">此实例未开放演示数据导入，可直接按上方路径配置业务。</p>
        <div class="actions">
          <el-button v-if="demoAvailable && demoCanManage" :loading="demoLoading" :disabled="busy" @click="importDemo">{{ demoStatus?.imported ? '刷新演示数据' : '导入演示数据' }}</el-button>
          <el-button v-if="demoStatus?.imported && me.can('audit:read')" :loading="smokeLoading" :disabled="busy" @click="runSmoke">运行演示验证</el-button>
          <el-button v-if="demoStatus?.imported && demoCanManage" :loading="demoCleanupLoading" :disabled="busy" @click="clearDemo">清理演示数据</el-button>
          <span v-if="demoAvailable && !demoCanManage" class="field-hint">导入或清理需要目标、工具源、路由和接入方的管理权限。</span>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { api } from '../request';
import { kernelFetch } from '../runtime-path';
import { openDoc } from '../docs';
import { useMe } from '../store';
import { demoVerified, onboardingSteps, pendingResource, resourceFromResponse, type OnboardingFlow, type OnboardingResources, type SetupResource, type SetupStep, type SetupStepStatus, type SetupSmoke, type SetupDemo, type SetupAgentOverview, type SetupCredential, type SetupTarget, type SetupProvider, type SetupRoute, type SetupClient } from '../onboarding-state';
import HelpTip from '../components/HelpTip.vue';

const router = useRouter();
const pageRoute = useRoute();
const me = useMe();
const flow = computed<OnboardingFlow>(() => pageRoute.query.flow === 'agent' ? 'agent' : 'business');
const resources = ref<OnboardingResources>({ credentials: pendingResource(), targets: pendingResource(), providers: pendingResource(), clients: pendingResource(), routes: pendingResource(), demo: pendingResource(), agent: pendingResource() });
const loading = ref(false);
const smokeLoading = ref(false);
const demoLoading = ref(false);
const demoCleanupLoading = ref(false);
const smoke = ref<SetupSmoke | null>(null);
const smokeError = ref('');
const demoActionError = ref('');
const demoFocus = ref(true);
const busy = computed(() => loading.value || smokeLoading.value || demoLoading.value || demoCleanupLoading.value);
const demoStatus = computed(() => resources.value.demo.status === 'ready' ? resources.value.demo.data : null);
const demoAvailable = computed(() => demoStatus.value?.available === true);
const demoCanManage = computed(() => ['targets:write', 'tools:write', 'routes:write', 'clients:write'].every((permission) => me.can(permission)));
const canViewRuns = computed(() => me.can('runs:read') && me.hasModule('runs'));
const verifiedDemo = computed(() => demoVerified(smoke.value));
const hasBusinessConfiguration = computed(() => (resources.value.routes.data ?? []).some((route) => route.route_key !== 'demo_support')
  || (resources.value.clients.data ?? []).some((client) => client.app_id !== 'demo-app'));
const showDemoJourney = computed(() => flow.value === 'business' && demoFocus.value && !hasBusinessConfiguration.value
  && demoAvailable.value && (demoStatus.value?.imported || demoStatus.value?.empty));
const steps = computed(() => onboardingSteps(flow.value, resources.value));
const requiredSteps = computed(() => steps.value.filter((step) => !step.optional && step.key !== 'verify'));
const configuredCount = computed(() => requiredSteps.value.filter((step) => step.status === 'configured').length);
const configurationProgress = computed(() => requiredSteps.value.some((step) => ['loading', 'error', 'forbidden', 'unavailable'].includes(step.status)) ? '待确认' : `${configuredCount.value}/${requiredSteps.value.length}`);
const nextStep = computed(() => requiredSteps.value.find((step) => step.status !== 'configured') ?? steps.value.find((step) => step.key === 'verify'));
const nextTitle = computed(() => showDemoJourney.value
  ? verifiedDemo.value ? '演示调用已完成，查看任务后接入真实业务' : demoStatus.value?.imported ? '演示数据已导入，运行演示验证' : '先导入演示配置，再手动运行验证'
  : nextStep.value?.title || '按所选路径验证真实调用');
const nextDetail = computed(() => {
  if (!showDemoJourney.value) return nextStep.value?.detail || '';
  if (smokeLoading.value) return '正在运行本次演示验证，请等待任务与检查结果。';
  if (verifiedDemo.value) return '已生成真实演示任务与可追溯记录。这只证明本次演示调用完成；你的业务模型、工具和授权需要另行验证。';
  if (smoke.value) return '本次演示尚未满足成功条件。请先查看任务状态与下方检查明细，再决定是否重试。';
  return demoStatus.value?.imported ? '使用内置演示主体发起真实调用并生成任务与执行记录（trace）。导入不等于验证通过；运行由你手动发起。' : '先用不依赖外部模型的演示链路认识任务与执行记录（trace）。也可以直接开始业务配置。';
});
const credentialDetail = computed(() => {
  const item = resources.value.credentials;
  if (item.status !== 'ready') return item.error || '正在读取模型凭证…';
  const count = item.data?.filter((credential) => credential.enabled).length ?? 0;
  return count ? `已保存 ${count} 个已启用凭证，尚不能据此确认模型可用。请在实际路由调用中验证。` : '尚无已启用的模型凭证。使用中枢模型时再添加；外部执行器使用自身环境，不必为完成向导添加无关凭证。';
});

function selectFlow(value: OnboardingFlow): void { void router.replace({ query: { ...pageRoute.query, flow: value } }); }
function startBusiness(): void { demoFocus.value = false; selectFlow('business'); }
function openDocs(): void { openDoc('/docs'); }
function canOpen(step: SetupStep): boolean { return step.status !== 'forbidden' && step.status !== 'unavailable' && me.can(step.read) && me.hasModule(step.path.slice(1)); }
function stepAction(step: SetupStep): string {
  if (step.key === 'verify') return flow.value === 'business' ? '获取调用代码' : '打开本地智能体';
  if (step.status === 'missing' && step.create && step.write && me.can(step.write)) return '开始配置';
  return step.write && !me.can(step.write) ? '查看配置' : '打开配置';
}
function openStep(step: SetupStep): void {
  if (!canOpen(step)) return;
  const query: Record<string, string> = {};
  if (step.status === 'missing' && step.create && step.write && me.can(step.write)) query.create = '1';
  void router.push({ path: step.path, query });
}
function viewSmokeTask(): void { if (canViewRuns.value && smoke.value?.run?.job_id) void router.push({ path: '/runs', query: { job: smoke.value.run.job_id } }); }
function tagType(status: SetupStepStatus): 'success' | 'warning' | 'danger' | 'info' {
  return status === 'configured' ? 'info' : status === 'error' ? 'danger' : status === 'verify' || status === 'missing' ? 'warning' : 'info';
}
function statusLabel(status: SetupStepStatus): string {
  return ({ configured: '已配置', missing: '待配置', verify: '待验证', optional: '按需配置', loading: '读取中', error: '读取失败', forbidden: '无权查看', unavailable: '未开放' })[status];
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function enabledName(value: unknown): value is SetupCredential & SetupTarget & SetupProvider { return object(value) && typeof value.name === 'string' && typeof value.enabled === 'boolean'; }
function isNamedList(value: unknown): value is Array<SetupCredential & SetupTarget & SetupProvider> { return Array.isArray(value) && value.every(enabledName); }
function isRoutes(value: unknown): value is SetupRoute[] { return Array.isArray(value) && value.every((row) => object(row) && typeof row.route_key === 'string' && typeof row.enabled === 'boolean'); }
function isClient(value: unknown): value is SetupClient { return object(value) && typeof value.app_id === 'string' && typeof value.enabled === 'boolean' && Array.isArray(value.allowed_routes) && value.allowed_routes.every((route) => typeof route === 'string'); }
function isClients(value: unknown): value is SetupClient[] { return Array.isArray(value) && value.every(isClient); }
function isDemo(value: unknown): value is SetupDemo { return object(value) && typeof value.available === 'boolean' && typeof value.imported === 'boolean' && typeof value.empty === 'boolean'; }
function isAgent(value: unknown): value is SetupAgentOverview {
  return object(value) && Array.isArray(value.applications) && value.applications.every((app) => isClient(app) && object(app) && typeof app.agent_auth_enabled === 'boolean')
    && Array.isArray(value.setup_workspaces) && value.setup_workspaces.every((workspace) => object(workspace) && typeof workspace.route === 'string'
      && ['enabled', 'runtime_enabled', 'direct_enabled'].every((key) => typeof workspace[key] === 'boolean') && typeof workspace.source_count === 'number');
}
let loginRedirect: Promise<void> | null = null;
async function expireSession(): Promise<void> {
  if (!loginRedirect) loginRedirect = me.logout().then(async () => { await router.replace('/login'); });
  await loginRedirect;
}
async function readResource<T>(path: string, permission: string, module: string | null, valid: (value: unknown) => value is T): Promise<SetupResource<T>> {
  if (!me.can(permission)) return { status: 'forbidden', data: null, error: '当前账号无权读取，请联系管理员' };
  if (module && !me.hasModule(module)) return { status: 'unavailable', data: null, error: '当前实例未开放此功能' };
  try {
    const response = await kernelFetch(path);
    if (response.status === 401) { await expireSession(); return { status: 'error', data: null, error: '登录已失效，请重新登录' }; }
    return resourceFromResponse(response.status, await response.json().catch(() => null), valid);
  } catch (error) { return { status: 'error', data: null, error: error instanceof Error ? error.message : '请求失败，请刷新重试' }; }
}
async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  resources.value = { credentials: pendingResource(), targets: pendingResource(), providers: pendingResource(), clients: pendingResource(), routes: pendingResource(), demo: pendingResource(), agent: pendingResource() };
  try {
    await Promise.all([
      readResource('/admin/api/credentials', 'credentials:read', 'credentials', isNamedList).then((value) => { resources.value.credentials = value; }),
      readResource('/admin/api/targets', 'targets:read', 'targets', isNamedList).then((value) => { resources.value.targets = value; }),
      readResource('/admin/api/tool-providers', 'tools:read', 'tools', isNamedList).then((value) => { resources.value.providers = value; }),
      readResource('/admin/api/routes', 'routes:read', 'routes', isRoutes).then((value) => { resources.value.routes = value; }),
      readResource('/admin/api/clients', 'clients:read', 'clients', isClients).then((value) => { resources.value.clients = value; }),
      readResource('/admin/api/demo-dataset/status', 'audit:read', null, isDemo).then((value) => { resources.value.demo = value; }),
      readResource('/admin/api/agent-clients/overview', 'clients:read', 'agent-clients', isAgent).then((value) => { resources.value.agent = value; }),
    ]);
  } finally { loading.value = false; }
}
async function importDemo(): Promise<void> {
  if (busy.value || !demoAvailable.value || !demoCanManage.value) return;
  demoLoading.value = true; demoActionError.value = ''; smoke.value = null; smokeError.value = '';
  try {
    await api('/admin/api/demo-dataset/import', { method: 'POST', body: '{}' });
    demoFocus.value = true;
    ElMessage.success('演示数据已导入，请手动运行验证');
    await load();
  } catch (error) { demoActionError.value = error instanceof Error ? error.message : '演示数据导入失败'; }
  finally { demoLoading.value = false; }
}
async function clearDemo(): Promise<void> {
  if (busy.value || !demoCanManage.value) return;
  try {
    await ElMessageBox.confirm('只会清理可证明属于 Core、且未被修改或其他配置引用的演示配置。任务、消息、执行记录（trace）、审计账本和用户配置都会保留。', '清理演示数据', { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' });
  } catch { return; }
  if (busy.value) return;
  demoCleanupLoading.value = true; demoActionError.value = ''; smoke.value = null; smokeError.value = '';
  try {
    await api('/admin/api/demo-dataset', { method: 'DELETE' });
    ElMessage.success('演示数据已清理');
    window.dispatchEvent(new CustomEvent('bailing-demo-dataset-cleared'));
    await load();
  } catch (error) { demoActionError.value = error instanceof Error ? error.message : '演示数据清理失败'; }
  finally { demoCleanupLoading.value = false; }
}
async function runSmoke(): Promise<void> {
  if (busy.value || !demoStatus.value?.imported || !me.can('audit:read')) return;
  smokeLoading.value = true; smoke.value = null; smokeError.value = '';
  try {
    smoke.value = await api<SetupSmoke>('/admin/api/smoke', { method: 'POST', body: '{}' });
  } catch (error) { smokeError.value = error instanceof Error ? error.message : '请求失败，请重试'; }
  finally { smokeLoading.value = false; }
}
function onDemoImported(): void { smoke.value = null; smokeError.value = ''; void load(); }
onMounted(() => { void load(); window.addEventListener('bailing-demo-dataset-imported', onDemoImported); });
onUnmounted(() => window.removeEventListener('bailing-demo-dataset-imported', onDemoImported));
</script>

<style scoped>
.setup{display:flex;flex-direction:column;gap:16px}.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.headActions{margin-left:auto;display:flex;align-items:center;gap:8px}.flowChoices{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}.flowChoices button{padding:16px;text-align:left;font:inherit;color:var(--el-text-color-primary);background:var(--el-bg-color);border:1px solid var(--el-border-color);cursor:pointer}.flowChoices button.selected{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.flowChoices button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.flowChoices b,.flowChoices span{display:block}.flowChoices b{font-size:16px;margin-bottom:8px}.flowChoices span{font-size:13px;line-height:1.6;color:var(--el-text-color-secondary)}.nextPanel{display:flex;align-items:center;gap:20px;padding:18px;margin-bottom:18px;border:1px solid var(--el-border-color-lighter);background:var(--el-fill-color-light)}.nextMain{flex:1;min-width:0}.nextMain b{display:block;font-size:18px;margin:7px 0}.nextMain p{margin:0;line-height:1.7;color:var(--el-text-color-regular)}.nextActions,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.nextActions{justify-content:flex-end;max-width:360px}.notice{margin-bottom:14px}.progressLine{display:flex;align-items:baseline;gap:14px;margin-bottom:14px;flex-wrap:wrap}.progressLine span,.field-hint{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.step{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--el-border-color-lighter)}.step.error{border-color:var(--el-color-danger-light-5)}.stepTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.stepTop b{flex:1;font-size:14px}.num{color:var(--el-text-color-secondary);font-size:12px}.step p{margin:0;line-height:1.7;color:var(--el-text-color-regular);font-size:13px;flex:1}.modelNote{display:flex;align-items:center;gap:16px;margin-top:18px;padding:14px;border:1px solid var(--el-border-color-lighter)}.modelNote div{flex:1}.modelNote p{margin:6px 0 0;font-size:13px;line-height:1.7;color:var(--el-text-color-secondary)}.verificationNote{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:16px;font-size:13px;line-height:1.7}.verificationNote span{color:var(--el-text-color-secondary);flex:1;min-width:220px}.smokeMeta{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:12px;font-size:13px}.demoOptions p{font-size:13px;line-height:1.7;color:var(--el-text-color-secondary)}.muted{color:var(--el-text-color-secondary);font-size:12px}
@media(max-width:1100px){.steps{grid-template-columns:repeat(2,minmax(0,1fr))}.nextPanel{align-items:flex-start;flex-direction:column}.nextActions{max-width:none;justify-content:flex-start}}
@media(max-width:760px){.steps,.flowChoices{grid-template-columns:1fr}.modelNote{align-items:flex-start;flex-direction:column}.headActions{margin-left:0}}
</style>
