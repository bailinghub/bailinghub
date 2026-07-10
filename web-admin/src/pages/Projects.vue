<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>项目目录</b> <HelpTip title="项目目录是什么">
          <p>项目目录是执行器类目标的工作目录登记。路由选择了“需要项目目录”的 target 后，会从这里选择项目名。</p>
          <p>路径是执行器所在机器上的绝对目录，中枢只保存配置，不直接读取本机文件。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">新建项目</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有项目：需要工作目录的 executor 路由会从这里选择目录">
      <el-button type="primary" @click="openCreate">登记第一个</el-button>
    </el-empty>
    <el-table v-else :data="list">
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
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该项目登记？引用它的路由会派活失败。" width="240" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑项目' : '新建项目'" size="420px">
    <el-form label-position="top">
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
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import HelpTip from '../components/HelpTip.vue';

const list = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ name: '', path: '', description: '', enabled: true });

async function load(): Promise<void> { list.value = await api('/admin/api/projects'); }
function openCreate(): void { editing.value = false; Object.assign(form, { name: '', path: '', description: '', enabled: true }); open.value = true; }
function openEdit(row: any): void { editing.value = true; Object.assign(form, { name: row.name, path: row.path, description: row.description || '', enabled: !!row.enabled }); open.value = true; }
async function save(): Promise<void> {
  saving.value = true;
  try {
    await api('/admin/api/projects', { method: 'POST', body: JSON.stringify(form) });
    ElMessage.success('已保存'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
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
