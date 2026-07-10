<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>模型凭证</b> <HelpTip title="模型凭证是什么">
          <p>中枢调用外部模型服务的出站凭证。路由大脑、图片理解、语音转写、文件理解、知识库向量化都只按凭证名引用，API Key 不进入业务配置。</p>
          <p>一条凭证只定义一个主用途：生成/理解，或向量化。若同一个平台 Key 同时用于两类场景，建议建两条凭证，分别设置默认模型。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">新建凭证</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有凭证：llm 路由与知识库都需要先配一把">
      <el-button type="primary" @click="openCreate">添加第一把</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="凭证" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="cred-main">
            <b>{{ row.name }}</b>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="能力与模型" min-width="230">
        <template #default="{ row }">
          <div class="cred-stack">
            <el-tag effect="plain" type="info">{{ KIND[row.kind] || row.kind }}</el-tag>
            <code>{{ row.default_model || '未设置默认模型' }}</code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="连接" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="cred-stack">
            <span class="mono muted ellipsis">{{ row.base_url }}</span>
            <code>{{ row.api_key }}</code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="最近使用" width="140"><template #default="{ row }"><span class="muted">{{ lastUsedLabel(row.last_used_at) }}</span></template></el-table-column>
      <el-table-column width="160" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openVerify(row)">验证</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该凭证？引用它的路由/知识库会立即失效。" width="250" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑凭证' : '新建凭证'" size="480px">
    <el-form label-position="top">
      <el-tabs v-model="credFormTab" class="console-tabs">
        <el-tab-pane label="基础" name="basic">
      <el-form-item>
        <template #label>{{ fieldTitle('name', '名称') }} <span v-if="fieldRequired('name')" class="field-required">*</span> <HelpTip :title="fieldTitle('name', '名称')">
          <p>{{ fieldDesc('name', '凭证稳定标识，路由和知识库按该名称引用。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 dashscope-main / openrouter-prod" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>平台 <span class="field-required">*</span></template>
        <el-select v-model="form.platform" filterable style="width: 100%" placeholder="选平台自动带出 Base URL 与常用模型" @change="onPlatform">
          <el-option v-for="p in providers" :key="p.id" :value="p.id" :label="p.label" />
          <el-option :value="CUSTOM" label="自定义（手填 Base URL 与模型）" />
        </el-select>
        <div v-if="curProvider && (curProvider.note || curProvider.keyUrl)" class="muted hint">
          <span v-if="curProvider.note">{{ curProvider.note }}</span><span v-if="curProvider.keyUrl">　取 Key：{{ curProvider.keyUrl }}</span>
        </div>
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('kind', '用途') }} <HelpTip title="用途怎么选">
          <p>{{ fieldDesc('kind', '这把密钥主要用于生成/理解类模型，或向量化模型。') }}</p>
          <p>这里选的是这条<b>凭证记录的主用途</b>，不是平台 API Key 的全部能力。一个平台 Key 可能同时能调对话和向量模型，但一条凭证只能有一个默认模型，因此不建议混在一条里。</p>
          <p>• <b>生成/理解类</b>：文本对话、图片理解、语音转写/音频理解、文件/长文档理解，属于让模型“理解输入并生成结果”的通道；</p>
          <p>• <b>向量化</b>：知识库与工具语义检索使用的 embedding，走 <code>/embeddings</code>，是另一条通道。</p>
          <p>如果同一个 API Key 两边都要用，建两条凭证即可，例如 <code>dashscope-main</code> 和 <code>dashscope-embedding</code>，Base URL 与 API Key 可以相同，但默认模型和引用位置分开。</p>
        </HelpTip></template>
        <el-radio-group v-model="credKind" class="kind-radios">
          <el-radio value="chat">生成/理解类 <span class="muted">文本 / 图片 / 语音 / 文件</span></el-radio>
          <el-radio value="embedding">向量化 <span class="muted">知识库 / 工具检索</span></el-radio>
        </el-radio-group>
        <div v-if="capHint" class="muted hint">{{ capHint }}</div>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="连接与模型" name="connection">
      <el-form-item>
        <template #label>{{ fieldTitle('base_url', 'Base URL') }} <span v-if="fieldRequired('base_url')" class="field-required">*</span> <HelpTip :title="fieldTitle('base_url', 'Base URL')">
          <p>{{ fieldDesc('base_url', '模型服务的 OpenAI 兼容接口前缀。') }}</p>
          <p>选平台会自动填入默认值；多地域或代理网关可按需修改。</p>
        </HelpTip></template>
        <el-input v-model="form.base_url" placeholder="https://…/v1" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('api_key', 'API Key') }} <span v-if="fieldRequired('api_key')" class="field-required">*</span> <HelpTip :title="fieldTitle('api_key', 'API Key')">
          <p>{{ fieldDesc('api_key', '中枢出站调用模型服务时使用的密钥。') }}</p>
          <p>编辑时留空表示保留原值；保存后列表只显示掩码。</p>
        </HelpTip></template>
        <el-input v-model="form.api_key" type="password" show-password autocomplete="off" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('default_model', '默认模型') }} <HelpTip :title="fieldTitle('default_model', '默认模型')">
          <p>{{ fieldDesc('default_model', '路由或知识库未显式指定模型时使用的默认模型。') }}</p>
          <p>生成/理解凭证建议填一个常用文本模型，向量化凭证必须填 embedding 模型。</p>
          <p>视觉、语音、文件等专项模型可在「触发路由」里按场景单独覆盖；这里的默认模型只是兜底。</p>
        </HelpTip></template>
        <el-select v-model="form.default_model" filterable allow-create default-first-option clearable style="width: 100%"
          :placeholder="modelGroups.length ? '选一个，或手填模型名' : '手填模型名'">
          <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
            <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
          </el-option-group>
        </el-select>
        <div v-if="curProvider?.freeModel" class="muted hint">该平台模型很多/可能需接入点 ID，列表只是常用建议，可直接手填</div>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item>
        <template #label>{{ fieldTitle('description', '说明') }} <HelpTip :title="fieldTitle('description', '说明')">
          <p>{{ fieldDesc('description', '给后台管理员看的补充备注。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.description" />
      </el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="verifyOpen" title="验证模型凭证" width="560px">
    <el-form label-position="top">
      <el-form-item label="凭证">
        <div class="test-credential">
          <b>{{ verifyForm.name }}</b>
          <span class="mono muted ellipsis">{{ verifyForm.base_url }}</span>
        </div>
      </el-form-item>
      <el-form-item label="验证类型">
        <el-radio-group v-model="verifyForm.capability" @change="onVerifyCapabilityChange">
          <el-radio value="chat">文本对话</el-radio>
          <el-radio value="vision">图片理解</el-radio>
          <el-radio value="embedding">向量化</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="验证模型">
        <el-select v-model="verifyForm.model" filterable allow-create default-first-option clearable style="width: 100%"
          :placeholder="verifyModelGroups.length ? '选择或手填模型名' : '手填模型名'">
          <el-option-group v-for="g in verifyModelGroups" :key="g.label" :label="g.label">
            <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
          </el-option-group>
        </el-select>
      </el-form-item>
      <el-alert v-if="verifyResult" :type="verifyResult.ok ? 'success' : 'error'" :closable="false" show-icon>
        <template #title>{{ verifyResult.ok ? '验证通过' : '验证失败' }}</template>
        <div class="verify-result">
          <div>{{ verifyResult.message }}</div>
          <div class="muted mono">
            {{ verifyResult.endpoint }} · {{ verifyResult.status ? 'HTTP ' + verifyResult.status + ' · ' : '' }}{{ verifyResult.duration_ms }}ms
          </div>
        </div>
      </el-alert>
    </el-form>
    <template #footer>
      <el-button @click="verifyOpen = false">关闭</el-button>
      <el-button type="primary" :loading="verifying" @click="runVerify">开始验证</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { fmtTime } from '../util';
import { LLM_PROVIDERS, CUSTOM_PROVIDER, detectProvider } from '../llm-catalog';
import HelpTip from '../components/HelpTip.vue';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

const KIND: Record<string, string> = { both: '复合凭证', chat: '生成/理解', embedding: '向量化' };
const CUSTOM = CUSTOM_PROVIDER;
const providers = LLM_PROVIDERS;
const credentialSchema = useConfigSchema('credential');
const list = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const verifyOpen = ref(false);
const verifying = ref(false);
const verifyResult = ref<any | null>(null);
const credFormTab = ref<'basic' | 'connection' | 'publish'>('basic');
const blank = { name: '', platform: 'dashscope', base_url: '', api_key: '', default_model: '', description: '' };
const form = reactive({ ...blank });
const verifyForm = reactive({
  name: '',
  base_url: '',
  kind: 'chat',
  platform: 'dashscope',
  capability: 'chat' as 'chat' | 'vision' | 'embedding',
  model: '',
  default_model: '',
});
// 一条凭证记录只服务一个主通道；同一平台 Key 可建两条凭证分别用于生成/理解与向量化。
const credKind = ref<'chat' | 'embedding'>('chat');

function fieldTitle(field: string, fallback: string): string {
  return schemaTitle(credentialSchema.schema.value, field, fallback);
}
function fieldDesc(field: string, fallback = ''): string {
  return schemaDescription(credentialSchema.schema.value, field, fallback);
}
function fieldRequired(field: string): boolean {
  return schemaRequired(credentialSchema.required.value, field);
}
function lastUsedLabel(v?: string): string {
  return v ? fmtTime(v) : '尚未使用';
}

const curProvider = computed(() => providers.find((p) => p.id === form.platform));
// 按平台 + 主用途过滤出可选模型建议；自定义或无预设则空（仍可手填）
const modelGroups = computed(() => {
  const p = curProvider.value;
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (credKind.value === 'chat') {
    if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
    if (p.vision?.length) g.push({ label: '视觉理解 / 图片输入', tag: '图片', models: p.vision });
    if (p.audio?.length) g.push({ label: '语音转写 / 音频理解', tag: '语音', models: p.audio });
    if (p.file?.length) g.push({ label: '文件 / 长文档理解', tag: '文件', models: p.file });
  } else if (p.embedding?.length) {
    g.push({ label: '向量化', models: p.embedding });
  }
  return g;
});
const verifyModelGroups = computed(() => {
  const p = providers.find((x) => x.id === verifyForm.platform);
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (verifyForm.capability === 'embedding') {
    if (p.embedding?.length) g.push({ label: '向量化', models: p.embedding });
  } else if (verifyForm.capability === 'vision') {
    if (p.vision?.length) g.push({ label: '视觉理解 / 图片输入', tag: '图片', models: p.vision });
    if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
  } else {
    if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
    if (p.vision?.length) g.push({ label: '视觉理解 / 图片输入', tag: '图片', models: p.vision });
    if (p.file?.length) g.push({ label: '文件 / 长文档理解', tag: '文件', models: p.file });
  }
  return g;
});
// 当前主用途在平台预设里没有对应模型 → 温和提示（不禁用，目录可能不全/可手填）
const capHint = computed(() => {
  const p = curProvider.value;
  if (!p || form.platform === CUSTOM) return '';
  const msgs: string[] = [];
  if (credKind.value === 'chat' && !(p.chat?.length || p.vision?.length || p.audio?.length || p.file?.length)) msgs.push('该平台预设无生成/理解类模型');
  if (credKind.value === 'embedding' && !(p.embedding?.length)) msgs.push('该平台预设无向量模型（如确有可手填模型名）');
  return msgs.join('；');
});
function hasChatModels(p: (typeof providers)[number]): boolean {
  return !!(p.chat?.length || p.vision?.length || p.audio?.length || p.file?.length);
}
function looksEmbeddingModel(model: string): boolean {
  const v = model.toLowerCase();
  return v.includes('embedding') || v.includes('embed') || v.includes('bge');
}
// 选平台：带出 base_url + 按平台能力给一个合理默认用途。若两类都支持，默认生成/理解；向量化可另建凭证。
function applyPlatformCaps(): void {
  const p = curProvider.value;
  if (!p) { credKind.value = 'chat'; return; }
  credKind.value = hasChatModels(p) ? 'chat' : 'embedding';
}
function onPlatform(): void {
  const p = curProvider.value;
  if (p) form.base_url = p.base_url; // 选平台自动带 base_url（自定义不动）
  form.default_model = '';            // 平台变了模型清空，避免串台
  applyPlatformCaps();
}
watch(credKind, () => { form.default_model = ''; });

async function load(): Promise<void> { list.value = await api('/admin/api/credentials'); }
function openCreate(): void { editing.value = false; credFormTab.value = 'basic'; Object.assign(form, { ...blank }); onPlatform(); open.value = true; }
function openEdit(row: any): void {
  editing.value = true;
  credFormTab.value = 'basic';
  Object.assign(form, {
    name: row.name, platform: detectProvider(row.base_url || ''),
    base_url: row.base_url, api_key: '', default_model: row.default_model || '', description: row.description || '',
  });
  credKind.value = row.kind === 'embedding' || (row.kind === 'both' && looksEmbeddingModel(row.default_model || '')) ? 'embedding' : 'chat';
  open.value = true;
}
function defaultVerifyModel(): string {
  const firstGroup = verifyModelGroups.value[0];
  return verifyForm.default_model || firstGroup?.models?.[0] || '';
}
function openVerify(row: any): void {
  Object.assign(verifyForm, {
    name: row.name,
    base_url: row.base_url || '',
    kind: row.kind || 'chat',
    platform: detectProvider(row.base_url || ''),
    capability: row.kind === 'embedding' ? 'embedding' : 'chat',
    model: row.default_model || '',
    default_model: row.default_model || '',
  });
  if (!verifyForm.model) verifyForm.model = defaultVerifyModel();
  verifyResult.value = null;
  verifyOpen.value = true;
}
function onVerifyCapabilityChange(): void {
  verifyResult.value = null;
  verifyForm.model = defaultVerifyModel();
}
async function runVerify(): Promise<void> {
  if (!verifyForm.model.trim()) { ElMessage.error('请先填写要验证的模型名'); return; }
  verifying.value = true;
  verifyResult.value = null;
  try {
    verifyResult.value = await api('/admin/api/credentials/' + encodeURIComponent(verifyForm.name) + '/verify', {
      method: 'POST',
      body: JSON.stringify({ capability: verifyForm.capability, model: verifyForm.model.trim() }),
    });
    if (verifyResult.value?.ok) ElMessage.success('模型凭证验证通过');
    else ElMessage.error(verifyResult.value?.message || '模型凭证验证失败');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    verifying.value = false;
  }
}
async function save(): Promise<void> {
  const kind = credKind.value;
  saving.value = true;
  try {
    // platform 仅 UI 辅助，不入库；存的还是 name/kind/base_url/api_key/default_model/description
    const body = { name: form.name, kind, base_url: form.base_url, api_key: form.api_key, default_model: form.default_model, description: form.description };
    await api('/admin/api/credentials', { method: 'POST', body: JSON.stringify(body) });
    ElMessage.success('已保存（key 不再回显完整值）'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
  try { await api('/admin/api/credentials/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(async () => {
  await Promise.all([credentialSchema.load().catch(() => undefined), load()]);
});
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.kind-radios {
  display: grid;
  gap: 10px;
}
.kind-radios .muted { margin-left: 4px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.hint { margin-top: 4px; line-height: 1.5; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cred-main,
.cred-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.cred-main b {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cred-stack code {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--bz-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-credential,
.test-result {
  display: grid;
  gap: 4px;
  min-width: 0;
}
</style>
