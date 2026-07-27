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
            <b>实例外观</b>
            <p>设置自托管控制台的名称、搜索摘要和登录页文案。配置保存在数据库中，升级代码不会覆盖。</p>
          </div>
          <el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </template>

      <el-form label-position="top" :disabled="!management.writable" @submit.prevent>
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
        <template #header><b>品牌 Logo</b></template>
        <div class="asset-body">
          <div class="logo-preview">
            <img v-if="logoPreview" :src="logoPreview" alt="Logo 预览" />
            <span v-else>使用内置百灵中枢标识</span>
          </div>
          <p>支持 PNG、JPEG、WebP，最大 512 KiB。建议上传横向完整标识。</p>
          <div class="asset-actions">
            <el-button :disabled="!management.writable" @click="logoInput?.click()">选择图片</el-button>
            <el-button v-if="logoPreview" :disabled="!management.writable" type="danger" plain @click="removeLogo">移除</el-button>
          </div>
          <input ref="logoInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="selectLogo" />
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header><b>浏览器图标</b></template>
        <div class="asset-body">
          <div class="favicon-preview">
            <img v-if="faviconPreview" :src="faviconPreview" alt="Favicon 预览" />
            <span v-else>无自定义图标</span>
          </div>
          <p>支持 PNG 或 ICO，最大 128 KiB。建议使用正方形图标。</p>
          <div class="asset-actions">
            <el-button :disabled="!management.writable" @click="faviconInput?.click()">选择图标</el-button>
            <el-button v-if="faviconPreview" :disabled="!management.writable" type="danger" plain @click="removeFavicon">移除</el-button>
          </div>
          <input ref="faviconInput" class="file-input" type="file" accept="image/png,image/x-icon,.ico" @change="selectFavicon" />
        </div>
      </el-card>
    </div>

    <div class="save-bar">
      <span>当前来源：{{ management.source === 'platform' ? '上级平台' : '本地实例' }}</span>
      <el-button v-if="management.writable" type="primary" :loading="saving" @click="save">保存设置</el-button>
      <el-button v-else-if="management.management_url" type="primary" @click="openManagement">前往平台管理</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { setInstanceBranding, type InstanceBranding } from '../branding';

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
const saving = ref(false);
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
let logoDataUrl: string | null | undefined;
let faviconDataUrl: string | null | undefined;

function applyResponse(response: BrandingResponse): void {
  Object.assign(form, {
    site_name: response.branding.site_name,
    browser_title: response.branding.browser_title,
    site_description: response.branding.site_description,
    site_keywords: [...response.branding.site_keywords],
    login_heading: response.branding.login_heading,
    login_subheading: response.branding.login_subheading,
  });
  Object.assign(management, response.management);
  logoPreview.value = response.branding.logo_url ?? '';
  faviconPreview.value = response.branding.favicon_url ?? '';
  logoDataUrl = undefined;
  faviconDataUrl = undefined;
  setInstanceBranding(response.branding);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    applyResponse(await api<BrandingResponse>('/admin/api/instance-branding'));
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
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
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    logoDataUrl = await readFile(file, 512 * 1024, 'Logo');
    logoPreview.value = logoDataUrl;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function selectFavicon(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    faviconDataUrl = await readFile(file, 128 * 1024, '浏览器图标');
    faviconPreview.value = faviconDataUrl;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

function removeLogo(): void {
  logoDataUrl = null;
  logoPreview.value = '';
}

function removeFavicon(): void {
  faviconDataUrl = null;
  faviconPreview.value = '';
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      ...form,
      site_keywords: form.site_keywords.map((item) => item.trim()).filter(Boolean),
    };
    if (logoDataUrl !== undefined) payload.logo_data_url = logoDataUrl;
    if (faviconDataUrl !== undefined) payload.favicon_data_url = faviconDataUrl;
    const response = await api<BrandingResponse>('/admin/api/instance-branding', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    applyResponse(response);
    ElMessage.success('实例外观已保存');
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    saving.value = false;
  }
}

function openManagement(): void {
  if (management.management_url) window.open(management.management_url, '_blank', 'noopener,noreferrer');
}

onMounted(load);
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
