<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>后台账号</b> <HelpTip title="后台账号 / 角色">
          <p>后台账号只用于维护中枢控制台，不等同于业务系统用户，也不参与聊天/工具调用的业务身份。</p>
          <p>角色决定可见板块与管理权限：<code>admin</code> 管全局配置，<code>kb_editor</code> 维护知识库，<code>viewer</code> 查看运行记录；<code>usage_operator</code> 管理AI额度，<code>usage_auditor</code> 只读消费明细。</p>
        </HelpTip>
        <el-button :loading="loading" style="margin-left: auto" @click="load">刷新</el-button><el-button type="primary" :disabled="loading || !!loadError" @click="openCreate">新建账号</el-button></div>
    </template>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon><template #default>{{ loaded ? '以下为上次读取的旧快照，请刷新后再编辑。' : '账号读取失败，请重试。' }}</template></el-alert>
    <el-table v-loading="loading" :data="list" :empty-text="loadError ? '账号读取失败' : loading ? '正在读取账号' : '暂无账号'">
      <el-table-column label="账号" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="account-main">
            <b>{{ row.display_name || row.username }}</b>
            <code>{{ row.username }}</code>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="角色权限" min-width="220">
        <template #default="{ row }">
          <div class="account-stack">
            <el-tag :type="row.role === 'admin' ? 'warning' : 'info'" effect="plain">{{ roleLabel(row.role) }}</el-tag>
            <span class="muted">{{ ROLE_DESC[row.role] || '自定义角色' }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="登录状态" min-width="190">
        <template #default="{ row }">
          <div class="account-stack">
            <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            <span class="muted">{{ lastLoginLabel(row.last_login_at) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column min-width="80" align="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="loading || !!loadError" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm v-if="row.username !== s.me?.username" title="删除该账号？其登录会话立即失效。" width="240" @confirm="del(row.username)">
            <template #reference><el-button link type="danger" :disabled="loading || !!loadError">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑账号' : '新建账号'" size="420px" :before-close="unsaved.beforeClose">
    <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon style="margin-bottom: 12px" />
    <el-form label-position="top" :disabled="saving" @submit.prevent>
      <el-form-item>
        <template #label>用户名 <span class="field-required">必填</span></template>
        <el-input v-model="form.username" :disabled="editing" placeholder="如 ops-admin" class="mono" />
      </el-form-item>
      <el-form-item label="显示名（可选）"><el-input v-model="form.display_name" /></el-form-item>
      <el-form-item>
        <template #label>角色 <span class="field-required">必填</span> <HelpTip title="角色">
          <p><b>admin</b>：管理全局配置与账号；<b>kb_editor</b>：维护知识库；<b>viewer</b>：只读查看运行记录；<b>usage_operator</b>：管理AI额度；<b>usage_auditor</b>：只读消费明细。用量角色不会获得业务会话正文权限。</p>
        </HelpTip></template>
        <el-select v-model="form.role" style="width: 100%">
          <el-option v-for="r in roles" :key="r" :value="r" :label="r + (ROLE_DESC[r] ? '（' + ROLE_DESC[r] + '）' : '')" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>密码 <HelpTip title="密码">
          <p>新建时留空会自动生成，并只显示一次。编辑时留空表示不修改；填写后该账号其他登录会话会立即下线。</p>
        </HelpTip></template>
        <el-input v-model="form.password" type="password" show-password autocomplete="new-password" placeholder="至少 8 位" />
      </el-form-item>
      <el-form-item v-if="editing">
        <template #label>启用 <HelpTip title="启用状态">
          <p>停用账号会立即使其登录会话失效。</p>
        </HelpTip></template>
        <el-switch v-model="form.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="closeEditor">取消</el-button>
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
import { useUnsavedForm } from '../use-unsaved-form';

const ROLE_DESC: Record<string, string> = { admin: '全能', kb_editor: '知识库维护', viewer: '只读任务', usage_operator: '用量管理', usage_auditor: '用量只读' };
const s = useMe();
const list = ref<any[]>([]);
const roles = ref<string[]>(['admin', 'kb_editor', 'viewer']);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const loading = ref(false), loaded = ref(false), loadError = ref(''), saveError = ref('');
const form = reactive({ username: '', display_name: '', role: 'kb_editor', password: '', enabled: true });

const unsaved = useUnsavedForm({ active: () => open.value, saving: () => saving.value, snapshot: () => form, name: '后台账号' });
async function closeEditor(): Promise<void> { if (await unsaved.confirmLeave()) open.value = false; }
async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true; loadError.value = '';
  try {
    const r = await api<{ list: any[]; roles: string[] }>('/admin/api/admins');
    list.value = r.list; if (r.roles?.length) roles.value = r.roles; loaded.value = true;
  } catch (e) { loadError.value = (e as Error).message; }
  finally { loading.value = false; }
}
function roleLabel(role: string): string {
  if (role === 'admin') return 'admin';
  if (role === 'kb_editor') return 'kb_editor';
  if (role === 'viewer') return 'viewer';
  return role;
}
function lastLoginLabel(v?: string): string {
  return v ? `最近登录 ${fmtTime(v)}` : '从未登录';
}
function openCreate(): void { if (loading.value || loadError.value || open.value || saving.value) return; editing.value = false; Object.assign(form, { username: '', display_name: '', role: 'kb_editor', password: '', enabled: true }); saveError.value = ''; open.value = true; unsaved.begin(); }
function openEdit(row: any): void {
  if (loading.value || loadError.value || open.value || saving.value) return;
  editing.value = true;
  Object.assign(form, { username: row.username, display_name: row.display_name || '', role: row.role, password: '', enabled: !!row.enabled });
  saveError.value = ''; open.value = true; unsaved.begin();
}
async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true; saveError.value = '';
  let result: { username: string; generated_password?: string };
  try {
    result = await api('/admin/api/admins', { method: 'POST', body: JSON.stringify(form) });
  } catch (e) {
    saveError.value = (e as Error).message;
    saving.value = false; return;
  }
  unsaved.markSaved(); open.value = false; saving.value = false; form.password = '';
  // A failed list refresh must never hide a password that is returned only once.
  void load();
  if (result.generated_password) {
    try {
      await ElMessageBox.alert(
        `账号 ${result.username} 的初始密码（只显示这一次，请立即保存）：\n\n${result.generated_password}`,
        '账号已创建', { confirmButtonText: '复制密码', distinguishCancelAndClose: true },
      );
      await copyText(result.generated_password, '密码已复制');
    } catch { /* Closing the receipt does not copy its secret to the clipboard. */ }
  } else { ElMessage.success('已保存'); }
}
async function del(username: string): Promise<void> {
  try { await api('/admin/api/admins/' + encodeURIComponent(username), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.account-main,
.account-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.account-main b,
.account-main code {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-main b { color: var(--el-text-color-primary); font-size: 13px; }
.account-main code { color: var(--el-text-color-secondary); font-family: var(--bz-mono); font-size: 12px; }
</style>
