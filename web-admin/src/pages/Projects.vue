<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>项目目录</b> <HelpTip title="项目目录是什么">
          <p>项目目录是执行器类目标的工作目录登记。路由选择了“需要项目目录”的 target 后，会从这里选择项目名。</p>
          <p>路径是执行器所在机器上的绝对目录，中枢只保存配置，不直接读取本机文件。</p>
        </HelpTip>
        <el-button v-if="canWrite" type="primary" style="margin-left: auto" @click="openCreate">新建项目</el-button></div>
    </template>
    <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><el-button link :disabled="listLoading" @click="load">重新读取</el-button></el-alert>
    <ListLocationBar v-model="listQuery" :count="locatedRows.length" :total="list.length" :focus="listFocus" :return-to="listReturnTo" @clear="clearListLocation" />
    <el-empty v-if="!listLoading && !listError && !list.length" description="还没有项目：需要工作目录的 executor 路由会从这里选择目录">
      <el-button v-if="canWrite" type="primary" @click="openCreate">登记第一个</el-button>
    </el-empty>
    <el-table v-else v-loading="listLoading" :data="locatedRows" :empty-text="listQuery || listFocus ? '没有匹配的对象，请调整或清除筛选' : '暂无数据'">
      <el-table-column label="项目" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="project-main">
            <b>{{ row.name }}</b>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="执行器工作目录" min-width="420" show-overflow-tooltip>
        <template #default="{ row }"><code class="path-line">{{ row.path }}</code></template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column width="110" align="right">
        <template #default="{ row }">
          <el-button v-if="canWrite" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm v-if="canWrite" title="删除该项目登记？引用它的路由会派活失败。" width="240" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑项目' : '新建项目'" size="420px" :before-close="formGuard.beforeClose">
    <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    <el-form label-position="top" :disabled="saving || !canWrite">
      <el-form-item>
        <template #label>项目名 <span class="field-required">必填</span> <HelpTip title="项目名">
          <p>路由里选择的项目标识。建议用业务或仓库名，如 <code>crm-server</code>。</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 crm-server" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>绝对目录 <span class="field-required">必填</span> <HelpTip title="绝对目录">
          <p>执行器所在机器上的工作目录。中枢不会校验本机路径是否存在，真正能否访问由执行器运行环境决定。</p>
        </HelpTip></template>
        <el-input v-model="form.path" placeholder="/srv/projects/example" class="mono" />
      </el-form-item>
      <el-form-item label="说明（可选）"><el-input v-model="form.description" /></el-form-item>
      <el-form-item v-if="editing" label="启用"><el-switch v-model="form.enabled" /></el-form-item>
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
const canWrite = computed(() => me.can('projects:write'));
const saveError = ref('');
const list = ref<any[]>([]);
const listLoading = ref(false), listError = ref('');
const { keyword: listQuery, focus: listFocus, rows: locatedRows, returnTo: listReturnTo, clear: clearListLocation } = useListLocation(list, { id: r => String(r.name), text: r => `${r.name} ${r.description || ""}` });
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ name: '', path: '', description: '', enabled: true });
const formGuard = useUnsavedForm({ active: () => open.value, saving: () => saving.value, snapshot: () => form, name: '项目目录配置' });
async function closeForm(): Promise<void> { if (await formGuard.confirmLeave()) open.value = false; }


async function load(): Promise<void> {
  if (listLoading.value) return;
  listLoading.value = true;
  try {
    list.value = await api('/admin/api/projects');
    listError.value = '';
  } catch { listError.value = list.value.length ? '项目目录列表刷新失败，当前保留旧快照。' : '项目目录列表读取失败，请重试。'; }
  finally { listLoading.value = false; }
}

function openCreate(): void { if (!canWrite.value || saving.value || open.value) return; editing.value = false; Object.assign(form, { name: '', path: '', description: '', enabled: true }); saveError.value = ''; formGuard.begin(); open.value = true; }
function openEdit(row: any): void { if (!canWrite.value || saving.value || open.value || listError.value) return; editing.value = true; Object.assign(form, { name: row.name, path: row.path, description: row.description || '', enabled: !!row.enabled }); saveError.value = ''; formGuard.begin(); open.value = true; }
async function save(): Promise<void> {
  if (!canWrite.value || saving.value) return;
  saveError.value = '';
  saving.value = true;
  try {
    await api('/admin/api/projects', { method: 'POST', body: JSON.stringify(form) });
    ElMessage.success('已保存'); formGuard.markSaved(); open.value = false; await load();
  } catch (e) { saveError.value = `未能确认保存成功：${(e as Error).message}。输入已保留，请核对后重试。`; }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
  if (!canWrite.value) return;
  try { await api('/admin/api/projects/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.project-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.project-main b { max-width: 100%; overflow: hidden; color: var(--el-text-color-primary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.path-line { display: block; max-width: 100%; overflow: hidden; color: var(--el-text-color-secondary); font-family: var(--bz-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
</style>
