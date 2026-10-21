<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>媒体存储</b> <HelpTip title="媒体存储是干什么的">
          <p>聊天上传的图片、语音会变成一个<b>永久 URL</b>：① 完整聊天追溯 ② 多模态读图/听音 ③ 业务图片入参直接用。</p>
          <p><b>默认不需要对象存储：</b>未配置时走服务器本地 <code>data/uploads</code>；生产环境可切到业务自己的 COS，得到的 URL 就是业务 CDN 地址。</p>
          <p><b>凭证铁律：</b>业务桶强烈建议给「限定 <code>path_prefix</code> 前缀的子账号 / RAM 策略或 STS 临时凭证」，别把整桶 AK/SK 交出来。落桶对象设为公读（多模态模型与前台都要取）。</p>
        </HelpTip>
        <el-button v-if="canWrite" type="primary" style="margin-left: auto" @click="openCreate">新建存储</el-button></div>
    </template>
    <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><el-button link :disabled="listLoading" @click="load">重新读取</el-button></el-alert>
    <ListLocationBar v-model="listQuery" :count="locatedRows.length" :total="list.length" :focus="listFocus" :return-to="listReturnTo" @clear="clearListLocation" />
    <el-empty v-if="!listLoading && !listError && !list.length" description="未登记外部存储时，聊天入口会默认使用服务器本地存储">
      <el-button v-if="canWrite" type="primary" @click="openCreate">添加外部存储</el-button>
    </el-empty>
    <el-table v-else v-loading="listLoading" :data="locatedRows" :empty-text="listQuery || listFocus ? '没有匹配的对象，请调整或清除筛选' : '暂无数据'">
      <el-table-column label="存储桶" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="bucket-main">
            <b>{{ row.name }}</b>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="存储位置" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="bucket-stack">
            <el-tag effect="plain" type="info">{{ row.kind }}</el-tag>
            <code v-if="row.kind === 'local'">服务器本地 data/uploads</code>
            <code v-else>{{ row.bucket }}<template v-if="row.region"> · {{ row.region }}</template></code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="访问地址" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="bucket-stack">
            <span class="mono muted ellipsis">{{ row.public_base_url || '未配置公开访问域名' }}</span>
            <span class="muted">写入前缀 <code>{{ row.path_prefix || '-' }}</code></span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column width="110" align="right">
        <template #default="{ row }">
          <el-button v-if="canWrite" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm v-if="canWrite" title="删除该存储桶登记？关联它的聊天入口将无法上传图片（已落桶的图不受影响）。" width="280" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑媒体存储' : '新建媒体存储'" size="500px" :before-close="formGuard.beforeClose">
    <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    <el-form name="media-storage-settings" autocomplete="off" label-position="top" :disabled="saving || !canWrite">
      <el-tabs v-model="bucketFormTab" class="console-tabs">
        <el-tab-pane label="基础" name="basic">
      <el-form-item>
        <template #label>登记名 <span class="field-required">必填</span> <HelpTip title="登记名">
          <p>聊天入口按这个名称引用媒体存储。建好后不可改。留空不选时会使用内置本地存储。</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 shared-media / local-media" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>类型 <span class="field-required">必填</span> <HelpTip title="存储类型">
          <p>本地存储写入服务器 <code>data/uploads</code>，并通过 <code>/uploads/*</code> 公开读取，不需要 AccessKey 或 SecretKey。</p>
          <p>生产环境若需要 CDN、生命周期管理或多副本共享，可选择对象存储。</p>
        </HelpTip></template>
        <el-select v-model="form.kind" style="width: 100%">
          <el-option value="local" label="服务器本地（开箱可用）" />
          <el-option value="cos" label="腾讯云 COS" />
          <el-option value="oss" label="阿里云 OSS" />
          <el-option value="s3" label="AWS S3 / 兼容（预留，未实现）" disabled />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.kind !== 'local'">
        <template #label>桶名 <span class="field-required">必填</span></template>
        <el-input v-model="form.bucket" placeholder="COS 带 appid 后缀，如 example-1250000000" class="mono" />
      </el-form-item>
      <el-form-item v-if="form.kind !== 'local'">
        <template #label>地域 <span class="field-required">必填</span></template>
        <el-input v-model="form.region" placeholder="COS：ap-shanghai；OSS：cn-shanghai" class="mono" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="访问凭证" name="secret">
      <template v-if="form.kind !== 'local'">
      <el-form-item>
        <template #label>AccessKeyId <span class="field-required">必填</span> <HelpTip title="AccessKeyId">
          <p>对象存储访问身份。编辑时留空表示保留原值。</p>
        </HelpTip></template>
        <el-input v-model="form.access_key" name="storage-access-key-id" autocomplete="off" class="mono" :placeholder="editing ? '留空 = 保留原值' : ''" />
      </el-form-item>
      <el-form-item>
        <template #label>SecretKey <span class="field-required">必填</span> <HelpTip title="SecretKey">
          <p>对象存储访问密钥。建议使用只允许写入指定前缀的子账号或临时凭证；编辑时留空表示保留原值。</p>
        </HelpTip></template>
        <el-input v-model="form.secret_key" name="storage-secret-key" type="password" show-password autocomplete="new-password" />
      </el-form-item>
      </template>
      <el-form-item>
        <template #label>公开访问域名 <span class="field-required">必填</span> <HelpTip title="公开访问域名">
          <p>上传成功后返回给聊天、视觉模型和业务工具的 URL 前缀。可填 COS 原生域名或业务 CDN 域名，不带尾斜杠。</p>
          <p v-if="form.kind === 'local'">本地存储不需要访问密钥；用于生成图片交付时，请填写指向 <code>/uploads</code> 的公开访问地址。</p>
          <p v-else>例如 <code>https://demo-bucket-1234567890.cos.ap-shanghai.myqcloud.com</code>，或自定义 CDN 域名。</p>
        </HelpTip></template>
        <el-input v-model="form.public_base_url" name="storage-public-base-url" type="url" autocomplete="off" placeholder="https://…" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>写入前缀 <HelpTip title="写入前缀">
          <p>对象写入时统一落在该前缀下，便于权限隔离、生命周期管理和清理。</p>
        </HelpTip></template>
        <el-input v-model="form.path_prefix" placeholder="bailing/chat" class="mono" />
      </el-form-item>
      <el-form-item v-if="form.kind !== 'local'">
        <template #label>自定义 endpoint <HelpTip title="自定义 endpoint">
          <p>一般留空，系统会按存储类型和地域生成地址。</p>
        </HelpTip></template>
        <el-input v-model="form.endpoint" placeholder="可选" class="mono" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item label="说明（可选）"><el-input v-model="form.description" /></el-form-item>
      <el-form-item v-if="editing" label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <span v-if="formGuard.dirty.value" class="muted" style="margin-right:12px">有未保存修改</span>
      <el-button :disabled="saving" @click="closeForm">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canWrite" @click="save">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import ListLocationBar from '../components/ListLocationBar.vue';
import { useListLocation } from '../use-list-location';
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';
import { useUnsavedForm } from '../use-unsaved-form';
import { useMe } from '../store';

const me = useMe();
const canWrite = computed(() => me.can('storage:write'));
const saveError = ref('');
const list = ref<any[]>([]);
const listLoading = ref(false), listError = ref('');
const { keyword: listQuery, focus: listFocus, rows: locatedRows, returnTo: listReturnTo, clear: clearListLocation } = useListLocation(list, { id: r => String(r.name), text: r => `${r.name} ${r.provider || ""} ${r.bucket || ""}` });
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const bucketFormTab = ref<'basic' | 'secret' | 'publish'>('basic');
const blank = { name: '', kind: 'local', region: '', bucket: '', endpoint: '', access_key: '', secret_key: '', public_base_url: '', path_prefix: 'bailing/chat', description: '', enabled: true };
const form = reactive({ ...blank });
const formGuard = useUnsavedForm({ active: () => open.value, saving: () => saving.value, snapshot: () => form, name: '媒体存储配置' });
async function closeForm(): Promise<void> { if (await formGuard.confirmLeave()) open.value = false; }


async function load(): Promise<void> {
  if (listLoading.value) return;
  listLoading.value = true;
  try {
    list.value = await api('/admin/api/storage-buckets');
    listError.value = '';
  } catch { listError.value = list.value.length ? '媒体存储列表刷新失败，当前保留旧快照。' : '媒体存储列表读取失败，请重试。'; }
  finally { listLoading.value = false; }
}

function openCreate(): void { if (!canWrite.value || saving.value || open.value) return; editing.value = false; bucketFormTab.value = 'basic'; Object.assign(form, blank); saveError.value = ''; formGuard.begin(); open.value = true; }
function openEdit(row: any): void { if (!canWrite.value || saving.value || open.value || listError.value) return;
  editing.value = true;
  bucketFormTab.value = 'basic';
  Object.assign(form, {
    name: row.name, kind: row.kind, region: row.region || '', bucket: row.bucket,
    endpoint: row.endpoint || '', access_key: '', secret_key: '',
    public_base_url: row.public_base_url || '', path_prefix: row.path_prefix || 'bailing/chat',
    description: row.description || '', enabled: !!row.enabled,
  });
  saveError.value = ''; formGuard.begin(); open.value = true;
}
async function save(): Promise<void> {
  if (!canWrite.value || saving.value) return;
  saveError.value = '';
  saving.value = true;
  try {
    await api('/admin/api/storage-buckets', { method: 'POST', body: JSON.stringify(form) });
    ElMessage.success('已保存（SecretKey 不再回显完整值）'); formGuard.markSaved(); open.value = false; await load();
  } catch (e) { saveError.value = `未能确认保存成功：${(e as Error).message}。输入已保留，请核对后重试。`; }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
  if (!canWrite.value) return;
  try { await api('/admin/api/storage-buckets/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.bucket-main,
.bucket-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.bucket-main b { max-width: 100%; overflow: hidden; color: var(--el-text-color-primary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.bucket-stack code { max-width: 100%; overflow: hidden; color: var(--el-text-color-secondary); font-family: var(--bz-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
</style>
