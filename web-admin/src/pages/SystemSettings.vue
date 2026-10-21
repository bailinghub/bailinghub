<template>
  <div class="settings-page">
    <el-alert
      v-if="management.source === 'platform'"
      type="info"
      :closable="false"
      show-icon
      title="实例外观由上级平台统一管理"
    >
      <template #default>
        <span>当前控制台继续读取同一套品牌契约，但本地实例不再拥有写权限，避免平台与实例双写。</span>
        <el-button v-if="management.management_url" link type="primary" @click="openManagement">前往平台管理</el-button>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="head">
          <div>
            <b>实例外观</b> <HelpTip title="实例外观"><p>设置自托管控制台的名称、搜索摘要和登录页文案。配置保存在数据库中，升级代码不会覆盖。</p></HelpTip>
          </div>
          <el-button :loading="loading" :disabled="saving || imageReading" @click="load">刷新</el-button>
        </div>
      </template>

      <el-alert v-if="loadError" type="error" title="实例外观读取失败" :description="loadError + (loaded ? '；当前保留上次读取的内容和未保存修改' : '；请点击刷新重试')" :closable="false" show-icon style="margin-bottom: 14px" />
      <el-alert v-if="saveError" type="error" title="实例外观保存未完成" :description="saveError" :closable="false" show-icon style="margin-bottom: 14px" />
      <el-form label-position="top" :disabled="editLocked" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="网站名称">
            <el-input v-model="form.site_name" maxlength="64" show-word-limit placeholder="如：企业智能运营中枢" />
          </el-form-item>
          <el-form-item label="浏览器标题">
            <el-input v-model="form.browser_title" maxlength="120" show-word-limit placeholder="显示在浏览器标签页" />
          </el-form-item>
        </div>
        <el-form-item label="网站描述">
          <el-input v-model="form.site_description" type="textarea" :rows="2" maxlength="255" show-word-limit />
        </el-form-item>
        <el-form-item label="网站关键词">
          <el-select
            v-model="form.site_keywords"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="12"
            placeholder="输入关键词后按回车，最多 12 个"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="登录页主标题">
          <el-input v-model="form.login_heading" maxlength="160" show-word-limit />
        </el-form-item>
        <el-form-item label="登录页副标题">
          <el-input v-model="form.login_subheading" type="textarea" :rows="3" maxlength="512" show-word-limit />
        </el-form-item>
      </el-form>
    </el-card>

    <div class="asset-grid">
      <el-card shadow="never">
        <template #header><b>品牌 Logo</b> <HelpTip title="品牌 Logo"><p>支持 PNG、JPEG、WebP，最大 512 KiB。建议上传横向完整标识。</p></HelpTip></template>
        <div class="asset-body">
          <div class="logo-preview">
            <img v-if="logoPreview" :src="logoPreview" alt="Logo 预览" />
            <span v-else>使用内置百灵中枢标识</span>
          </div>
          <p v-if="logoReading">正在读取图片…</p>
          <el-alert v-if="logoError" type="error" :title="logoError" :closable="false" />
          <div class="asset-actions">
            <el-button :disabled="editLocked" @click="logoInput?.click()">选择图片</el-button>
            <el-button v-if="logoPreview || logoReading" :disabled="editLocked" type="danger" plain @click="removeLogo">移除</el-button>
          </div>
          <input ref="logoInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="selectLogo" />
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header><b>浏览器图标</b> <HelpTip title="浏览器图标"><p>支持 PNG 或 ICO，最大 128 KiB。建议使用正方形图标。</p></HelpTip></template>
        <div class="asset-body">
          <div class="favicon-preview">
            <img v-if="faviconPreview" :src="faviconPreview" alt="Favicon 预览" />
            <span v-else>无自定义图标</span>
          </div>
          <p v-if="faviconReading">正在读取图标…</p>
          <el-alert v-if="faviconError" type="error" :title="faviconError" :closable="false" />
          <div class="asset-actions">
            <el-button :disabled="editLocked" @click="faviconInput?.click()">选择图标</el-button>
            <el-button v-if="faviconPreview || faviconReading" :disabled="editLocked" type="danger" plain @click="removeFavicon">移除</el-button>
          </div>
          <input ref="faviconInput" class="file-input" type="file" accept="image/png,image/x-icon,.ico" @change="selectFavicon" />
        </div>
      </el-card>
    </div>

    <div class="save-bar">
      <span v-if="!loaded">{{ loading ? '正在读取实例外观…' : '尚未取得实例外观' }}</span>
      <span v-else>当前来源：{{ management.source === 'platform' ? '上级平台' : '本地实例' }}</span>
      <span v-if="formGuard.dirty.value" style="margin-left: 14px">有未保存修改</span>
      <el-button v-if="management.writable" type="primary" :disabled="loading || imageReading || !loaded" :loading="saving" @click="save">保存设置</el-button>
      <el-button v-else-if="management.management_url" type="primary" @click="openManagement">前往平台管理</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';
import { useUnsavedForm } from '../use-unsaved-form';
import { setInstanceBranding, type InstanceBranding } from '../branding';
import { kernelPath } from '../runtime-path';

interface BrandingManagement {
  source: 'local' | 'platform';
  writable: boolean;
  management_url?: string;
}

interface BrandingResponse {
  branding: InstanceBranding;
  management: BrandingManagement;
}

const loading = ref(false);
const saving = ref(false), loaded = ref(false), loadError = ref(''), saveError = ref('');
const logoReading = ref(false), faviconReading = ref(false), logoError = ref(''), faviconError = ref('');
const imageReading = computed(() => logoReading.value || faviconReading.value);
const editLocked = computed(() => !loaded.value || !management.writable || loading.value || saving.value);
let requestEpoch = 0, logoEpoch = 0, faviconEpoch = 0;
const management = reactive<BrandingManagement>({ source: 'local', writable: false });
const form = reactive({
  site_name: '',
  browser_title: '',
  site_description: '',
  site_keywords: [] as string[],
  login_heading: '',
  login_subheading: '',
});
const logoInput = ref<HTMLInputElement>();
const faviconInput = ref<HTMLInputElement>();
const logoPreview = ref('');
const faviconPreview = ref('');
const logoDataUrl = ref<string | null>(), faviconDataUrl = ref<string | null>();
const formGuard = useUnsavedForm({ active: () => loaded.value && management.writable, saving: () => saving.value,
  snapshot: () => ({ form, logo: logoDataUrl.value, favicon: faviconDataUrl.value, logoReading: logoReading.value, faviconReading: faviconReading.value }), name: '实例外观' });

function applyResponse(response: BrandingResponse): void {
  Object.assign(form, {
    site_name: response.branding.site_name,
    browser_title: response.branding.browser_title,
    site_description: response.branding.site_description,
    site_keywords: [...response.branding.site_keywords],
    login_heading: response.branding.login_heading,
    login_subheading: response.branding.login_subheading,
  });
  Object.assign(management, response.management, { management_url: response.management.management_url });
  logoPreview.value = response.branding.logo_url ? kernelPath(response.branding.logo_url) : '';
  faviconPreview.value = response.branding.favicon_url ? kernelPath(response.branding.favicon_url) : '';
  logoDataUrl.value = undefined;
  faviconDataUrl.value = undefined;
  loaded.value = true;
  formGuard.markSaved();
  setInstanceBranding(response.branding);
}

async function load(): Promise<void> {
  if (loading.value || saving.value || imageReading.value) return;
  if (loaded.value && !await formGuard.confirmLeave()) return;
  if (loading.value || saving.value || imageReading.value) return;
  const epoch = ++requestEpoch;
  loading.value = true; loadError.value = ''; saveError.value = '';
  try {
    const response = await api<BrandingResponse>('/admin/api/instance-branding');
    if (epoch === requestEpoch) applyResponse(response);
  } catch (error) {
    if (epoch === requestEpoch) loadError.value = (error as Error).message || '请稍后重试';
  } finally {
    if (epoch === requestEpoch) loading.value = false;
  }
}

function readFile(file: File, maxBytes: number, label: string): Promise<string> {
  if (file.size > maxBytes) return Promise.reject(new Error(`${label}文件过大`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`${label}读取失败`));
    reader.readAsDataURL(file);
  });
}

async function selectLogo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file || editLocked.value) return;
  const epoch = ++logoEpoch;
  logoReading.value = true; logoError.value = '';
  try {
    const data = await readFile(file, 512 * 1024, 'Logo');
    if (epoch === logoEpoch) { logoDataUrl.value = data; logoPreview.value = data; }
  } catch (error) { if (epoch === logoEpoch) logoError.value = (error as Error).message; }
  finally { if (epoch === logoEpoch) logoReading.value = false; }
}

async function selectFavicon(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file || editLocked.value) return;
  const epoch = ++faviconEpoch;
  faviconReading.value = true; faviconError.value = '';
  try {
    const data = await readFile(file, 128 * 1024, '浏览器图标');
    if (epoch === faviconEpoch) { faviconDataUrl.value = data; faviconPreview.value = data; }
  } catch (error) { if (epoch === faviconEpoch) faviconError.value = (error as Error).message; }
  finally { if (epoch === faviconEpoch) faviconReading.value = false; }
}

function removeLogo(): void {
  if (editLocked.value) return;
  ++logoEpoch; logoReading.value = false; logoError.value = '';
  logoDataUrl.value = null; logoPreview.value = '';
}

function removeFavicon(): void {
  if (editLocked.value) return;
  ++faviconEpoch; faviconReading.value = false; faviconError.value = '';
  faviconDataUrl.value = null; faviconPreview.value = '';
}

async function save(): Promise<void> {
  if (editLocked.value || imageReading.value) return;
  const epoch = ++requestEpoch;
  saving.value = true; saveError.value = '';
  try {
    const payload: Record<string, unknown> = {
      ...form,
      site_keywords: form.site_keywords.map((item) => item.trim()).filter(Boolean),
    };
    if (logoDataUrl.value !== undefined) payload.logo_data_url = logoDataUrl.value;
    if (faviconDataUrl.value !== undefined) payload.favicon_data_url = faviconDataUrl.value;
    const response = await api<BrandingResponse>('/admin/api/instance-branding', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (epoch !== requestEpoch) return;
    applyResponse(response); loadError.value = '';
    ElMessage.success('实例外观已保存');
  } catch (error) {
    if (epoch === requestEpoch) saveError.value = (error as Error).message || '请保留当前修改并重试';
  } finally {
    if (epoch === requestEpoch) saving.value = false;
  }
}

function openManagement(): void {
  if (management.management_url) window.open(management.management_url, '_blank', 'noopener,noreferrer');
}

onMounted(load);
onUnmounted(() => { ++requestEpoch; ++logoEpoch; ++faviconEpoch; });
</script>

<style scoped>
.settings-page { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; align-items: center; gap: 16px; }
.head > div { min-width: 0; }
.head p { margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.head .el-button { margin-left: auto; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.asset-body { display: flex; flex-direction: column; gap: 12px; }
.asset-body p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.logo-preview,
.favicon-preview {
  height: 96px;
  border: 1px dashed var(--el-border-color);
  background: var(--el-fill-color-light);
  display: grid;
  place-items: center;
  color: var(--el-text-color-secondary);
}
.logo-preview img { max-width: calc(100% - 32px); max-height: 68px; object-fit: contain; }
.favicon-preview img { width: 48px; height: 48px; object-fit: contain; }
.asset-actions { display: flex; gap: 8px; }
.file-input { display: none; }
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color);
  background: color-mix(in srgb, var(--el-bg-color) 94%, transparent);
  backdrop-filter: blur(12px);
}
.save-bar span { color: var(--el-text-color-secondary); font-size: 12px; }
.save-bar .el-button { margin-left: auto; }
@media (max-width: 760px) {
  .form-grid,
  .asset-grid { grid-template-columns: 1fr; }
}
</style>
