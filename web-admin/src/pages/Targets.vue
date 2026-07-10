<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>调度目标</b> <HelpTip title="调度目标是什么">
          <p>调度目标是路由派发任务的运行边界：<code>llm</code> 由中枢进程内适配器执行，executor 目标由外部执行器池认领。</p>
          <p>新增一种执行能力时，先注册目标，再让执行器令牌和执行器实例声明可认领该目标，路由即可选择它。</p>
          <p>内置渠道送达走「渠道直推」；只有自定义送达才需要注册 <code>*-notify</code> 这类 executor 目标。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">注册目标</el-button></div>
    </template>
    <el-table :data="list">
      <el-table-column label="目标" min-width="230" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="target-main">
            <code>{{ row.name }}</code>
            <b>{{ row.description || kindLabel(row.kind) }}</b>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="运行方式" min-width="250">
        <template #default="{ row }">
          <div class="target-stack">
            <div class="tagline">
              <el-tag :type="row.kind === 'inhub' ? 'warning' : 'info'" size="small" effect="plain">{{ kindLabel(row.kind) }}</el-tag>
              <el-tag v-if="row.stateless" size="small" effect="plain">无状态</el-tag>
              <el-tag v-if="row.needs_project" size="small" effect="plain" type="warning">需项目目录</el-tag>
            </div>
            <span class="muted">{{ row.kind === 'inhub' ? '中枢进程内执行，无需执行器认领。' : '任务进入 DB 队列，由外部执行器长轮询认领。' }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="执行器池" min-width="260">
        <template #default="{ row }">
          <div class="target-stack">
            <template v-if="row.kind === 'inhub'">
              <span class="muted">中枢内置适配器</span>
              <span class="muted">不依赖执行器在线状态</span>
            </template>
            <template v-else>
              <div class="tagline">
                <el-tag size="small" effect="plain" :type="pool(row.name).online ? 'success' : 'danger'">{{ pool(row.name).online }}/{{ pool(row.name).total }} 在线</el-tag>
                <span v-if="!pool(row.name).total" class="muted">无执行器认领</span>
              </div>
              <span v-if="pool(row.name).total" class="muted ellipsis">{{ pool(row.name).ids.join('、') }}</span>
            </template>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <div class="target-stack">
            <el-tag size="small" effect="plain" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag>
            <span class="muted">超时 {{ timeoutLabel(row.timeout_ms) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="110" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该目标注册？引用它的路由会派活失败（内置目标 llm 删后仍有代码兜底）。" width="270" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑目标' : '注册目标'" size="440px">
    <el-form label-position="top">
      <el-form-item>
        <template #label>名称 <span class="field-required">必填</span> <HelpTip title="目标名称">
          <p>路由里选择的 <code>target</code> 值。executor 类型目标需要外部执行器声明同名 target 才能认领任务。</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 report-agent / sms-notify" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>类型 <span class="field-required">必填</span> <HelpTip title="目标类型">
          <p><b>executor</b>：任务进入队列，由外部执行器长轮询认领。</p>
          <p><b>inhub</b>：中枢进程内已有同名适配器，适合 llm 这类内置能力。</p>
        </HelpTip></template>
        <el-select v-model="form.kind" style="width: 100%">
          <el-option value="executor" label="executor（外部执行器认领）" />
          <el-option value="inhub" label="inhub（中枢内置适配器）" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>无状态 <HelpTip title="无状态目标">
          <p>开启后，派发时必须由中枢从对话总账装配历史上下文。大多数 OpenAI 兼容模型目标和一次性命令执行器都应保持开启。</p>
        </HelpTip></template>
        <el-switch v-model="form.stateless" />
      </el-form-item>
      <el-form-item>
        <template #label>需要项目目录 <HelpTip title="项目目录">
          <p>开启后，选择该目标的路由需要绑定「项目目录」，执行器会收到对应工作目录上下文。</p>
        </HelpTip></template>
        <el-switch v-model="form.needs_project" />
      </el-form-item>
      <el-form-item label="执行超时">
        <el-input-number v-model="form.timeout_ms" :min="0" :max="600000" :step="10000" />
        <span class="muted" style="margin-left: 8px">ms，0 = 默认 120000</span>
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
const execs = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ name: '', kind: 'executor', stateless: false, needs_project: false, timeout_ms: 0, description: '', enabled: true });

/** 服务某 target 的执行器池：声明了该 target 的执行器 + 其中在线数。target 是 route↔执行器的解耦缝。 */
function pool(targetName: string): { online: number; total: number; ids: string[] } {
  const serving = execs.value.filter((e) => Array.isArray(e.targets) && e.targets.includes(targetName));
  return { online: serving.filter((e) => e.online).length, total: serving.length, ids: serving.map((e) => e.executor_id) };
}
function kindLabel(kind: string): string {
  return kind === 'inhub' ? '中枢内执行' : '执行器认领';
}
function timeoutLabel(ms?: number): string {
  return ms ? `${ms / 1000}s` : '默认 120s';
}

async function load(): Promise<void> {
  list.value = await api('/admin/api/targets');
  execs.value = await api('/admin/api/executors').catch(() => []);
}
function openCreate(): void { editing.value = false; Object.assign(form, { name: '', kind: 'executor', stateless: false, needs_project: false, timeout_ms: 0, description: '', enabled: true }); open.value = true; }
function openEdit(row: any): void { editing.value = true; Object.assign(form, { ...row, description: row.description || '' }); open.value = true; }
async function save(): Promise<void> {
  saving.value = true;
  try {
    await api('/admin/api/targets', { method: 'POST', body: JSON.stringify(form) });
    ElMessage.success('已保存并即时生效'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
  try { await api('/admin/api/targets/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.bad { color: var(--el-color-danger); font-weight: 600; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target-main,
.target-stack {
  display: grid;
  align-items: start;
  gap: 4px;
  min-width: 0;
}
.target-main b {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tagline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
</style>
