<template>
  <div class="kb-layout">
    <!-- 左：知识库列表 -->
    <div class="kb-list">
      <div class="kb-list-head">
        <span class="muted">知识库</span>
        <el-button v-if="s.can('kb:write')" type="primary" link @click="openCreateKb">+ 建知识库</el-button>
      </div>
      <el-empty v-if="!bases.length" description="还没有知识库" :image-size="60">
        <el-button v-if="s.can('kb:write')" type="primary" @click="openCreateKb">建第一个</el-button>
      </el-empty>
      <div v-for="b in bases" :key="b.kb_id" class="kb-item" :class="{ active: cur?.kb_id === b.kb_id }" @click="selectKb(b)">
        <div class="kb-name">{{ b.name }}</div>
        <div class="kb-meta"><code>{{ b.kb_id }}</code> · {{ b.doc_count }} 文档 / {{ b.chunk_count }} 块</div>
      </div>
    </div>

    <!-- 右：工作台 -->
    <div class="kb-main">
      <el-empty v-if="!cur" description="选择左侧的知识库开始维护" />
      <template v-else>
        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span><b>{{ cur.name }}</b><span class="muted" style="margin-left:10px">{{ cur.credential }} · {{ cur.model }}（{{ cur.dim }}维）</span></span>
              <span>
                <el-button @click="openDocs('knowledge')">开发文档</el-button>
                <el-button v-if="s.can('kb:write')" @click="openSettings">库设置</el-button>
                <el-button v-if="s.can('kb:write')" type="primary" @click="docOpen = true">添加文档</el-button>
                <el-popconfirm v-if="s.can('kb:write')" title="删除整个知识库？全部文档与向量一并删除，不可恢复。" width="260" @confirm="delKb">
                  <template #reference><el-button type="danger" plain>删库</el-button></template>
                </el-popconfirm>
              </span>
            </div>
          </template>

          <el-empty v-if="!docs.length" description="还没有文档">
            <el-button v-if="s.can('kb:write')" type="primary" @click="docOpen = true">添加第一篇</el-button>
          </el-empty>
          <el-table v-else :data="docs">
            <el-table-column label="文档" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="doc-main">
                  <b>{{ row.title }}</b>
                  <span class="muted">#{{ row.doc_id }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="来源" min-width="200">
              <template #default="{ row }">
                <div class="doc-stack">
                  <el-tag size="small" effect="plain" :type="row.source_key ? 'primary' : 'info'">{{ row.source_key ? '接入方 API' : '控制台' }}</el-tag>
                  <el-tooltip v-if="row.source_key" :content="'幂等键 ' + row.source_key" placement="top">
                    <code class="srckey">{{ row.source_key }}</code>
                  </el-tooltip>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="处理状态" min-width="170">
              <template #default="{ row }">
                <div class="doc-stack">
                  <el-tooltip v-if="row.status === 'error'" :content="row.error || '未知错误'">
                    <el-tag :type="docStatusType(row.status)" effect="plain">{{ docStatusLabel(row.status) }}</el-tag>
                  </el-tooltip>
                  <el-tag v-else :type="docStatusType(row.status)" effect="plain">{{ docStatusLabel(row.status) }}</el-tag>
                  <span class="muted">{{ row.chunk_count }} 个切块</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="130">
              <template #default="{ row }"><span class="muted">{{ fmtTime(row.created_at) }}</span></template>
            </el-table-column>
            <el-table-column width="70" align="right">
              <template #default="{ row }">
                <el-popconfirm v-if="s.can('kb:write')" title="删除该文档？其切块与向量一并删除。" width="240" @confirm="delDoc(row.doc_id)">
                  <template #reference><el-button type="danger" link>删</el-button></template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span><b>数据源</b> <HelpTip title="数据源是什么"><p>中枢<b>定时拉业务库</b>，自动同步成文档。</p></HelpTip></span>
              <el-button v-if="s.can('kb:write')" type="primary" plain @click="openDsForm()">+ 添加数据源</el-button>
            </div>
          </template>
          <el-empty v-if="!dsList.length" description="暂无数据源——业务库内容也可由业务系统主动推送（见开发文档）" :image-size="50" />
          <el-table v-else :data="dsList">
            <el-table-column label="数据源" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="doc-main">
                  <b>{{ row.name }}</b>
                  <code>{{ row.db_user }}@{{ row.db_host }}:{{ row.db_port }}/{{ row.db_database }}</code>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="取数映射" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="doc-stack">
                  <span class="muted">键 {{ row.key_field }} · 标题 {{ row.title_field }}</span>
                  <code class="sql-line">{{ row.query_sql }}</code>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="同步状态" min-width="220">
              <template #default="{ row }">
                <div class="doc-stack">
                  <div class="tagline">
                    <el-tooltip v-if="row.last_status === 'error'" :content="row.last_error || '未知错误'">
                      <el-tag :type="dsStatusType(row.last_status)" effect="plain">{{ dsStatusLabel(row.last_status) }}</el-tag>
                    </el-tooltip>
                    <el-tag v-else :type="dsStatusType(row.last_status)" effect="plain">{{ dsStatusLabel(row.last_status) }}</el-tag>
                    <el-tag size="small" effect="plain" type="info">{{ dsScheduleLabel(row.interval_min) }}</el-tag>
                  </div>
                  <span class="muted">{{ row.last_sync_at ? fmtTime(row.last_sync_at) : '尚未同步' }}</span>
                  <span v-if="row.last_stats" class="muted mono">{{ dsStatsLabel(row.last_stats) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="doc_count" label="文档" width="82" />
            <el-table-column width="170" align="right">
              <template #default="{ row }">
                <el-button v-if="s.can('kb:write')" type="primary" link :disabled="row.last_status === 'running'" @click="dsSyncNow(row)">同步</el-button>
                <el-button v-if="s.can('kb:write')" link @click="openDsForm(row)">编辑</el-button>
                <el-popconfirm v-if="s.can('kb:write')" title="删除数据源？它同步进来的文档与向量一并删除。" width="260" @confirm="dsDel(row)">
                  <template #reference><el-button type="danger" link>删</el-button></template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="block">
          <template #header><div class="card-head"><span><b>命中测试</b> <HelpTip title="命中测试是什么"><p>输入一个用户会问的问题，看检索回什么。</p></HelpTip></span></div></template>
          <div class="hit-form">
            <el-input v-model="hitQuery" placeholder="如：如何修改账号权限" clearable @keyup.enter="hitTest" />
            <el-button type="primary" :loading="hitLoading" @click="hitTest">测试</el-button>
          </div>
          <div v-if="hits !== null" class="hits">
            <el-empty v-if="!hits.length" description="没有命中：库是空的，或问题与库内资料无关" :image-size="60" />
            <div v-for="(h, i) in hits" :key="i" class="hit">
              <div class="hit-head">
                <el-progress :percentage="Math.round(h.score * 100)" :stroke-width="6" :show-text="false" class="hit-bar" />
                <span class="hit-score mono">{{ h.score }}</span>
                <span class="muted">{{ h.title }} #{{ h.seq }}</span>
              </div>
              <pre class="hit-content">{{ h.content }}</pre>
            </div>
          </div>
        </el-card>
      </template>
    </div>
  </div>

  <!-- 建知识库（≥4 字段 → 抽屉，DESIGN.md §6） -->
  <el-drawer v-model="createOpen" title="建知识库" size="420px">
    <el-form label-width="100px" label-position="top">
      <el-tabs v-model="kbFormTab" class="console-tabs">
        <el-tab-pane label="基础" name="basic">
      <el-form-item>
        <template #label>知识库 ID <span class="field-required">*</span> <HelpTip title="知识库 ID">
          <p>路由配置和入库 API 使用的稳定标识。建好后不可改；建议小写字母、数字、中划线。</p>
        </HelpTip></template>
        <el-input v-model="createForm.kb_id" placeholder="如 product-docs" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>名称 <span class="field-required">*</span></template>
        <el-input v-model="createForm.name" placeholder="如 产品文档库" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="向量模型" name="embedding">
      <el-form-item>
        <template #label>向量模型凭证 <span class="field-required">*</span> <HelpTip title="向量模型凭证">
          <p>用于把文档切块转换成向量。建库时会锁定模型坐标系，后续换模型需要重建库。</p>
          <p>建库时锁定 embedding 模型与坐标系，后续更换模型需要重建知识库。</p>
        </HelpTip></template>
        <el-select v-model="createForm.credential" filterable allow-create default-first-option placeholder="如 embedding-main" style="width: 100%">
          <el-option v-for="c in credOptions" :key="c" :label="c" :value="c" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>模型 <span class="field-required">*</span></template>
        <el-input v-model="createForm.model" placeholder="默认 text-embedding-v4" />
      </el-form-item>
      <el-form-item>
        <template #label>向量维度 <span class="field-required">*</span> <HelpTip title="向量维度">
          <p>必须与 embedding 模型输出维度一致。维度不一致会导致后续检索不可用。</p>
          <p>常见值：text-embedding-v4 为 1024；OpenAI text-embedding-3-large 为 3072。留 0 时按默认 1024 处理。</p>
        </HelpTip></template>
        <el-input-number v-model="createForm.dim" :min="0" :step="256" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item label="说明（可选）"><el-input v-model="createForm.description" /></el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="createOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createKb">建知识库</el-button>
    </template>
  </el-drawer>

  <!-- 添加文档 -->
  <el-drawer v-model="docOpen" title="添加文档" size="560px">
    <el-form label-position="top">
      <el-form-item label="标题"><el-input v-model="docForm.title" placeholder="如 账号权限说明" /></el-form-item>
      <el-form-item>
        <template #label>内容 <HelpTip title="支持哪些来源">
          <p><b>粘贴文本 / .txt / .md</b>：直接读入，支持 markdown。</p>
          <p><b>.docx（Word）</b>：选择后在浏览器本地转成 markdown 再入库——标题/列表/表格保留；Word 内嵌图片不入库（替换为占位符），需要图片请改用图片链接。</p>
          <p><b>图片</b>：markdown 图片链接（<code>![说明](https://…)</code>）原样保留——检索命中后 AI 可在回答里带出截图，聊天组件会渲染成图。</p>
          <p><b>业务数据库内容</b>（产品文档、操作流程等）不要手工搬：用入库 API 让业务系统自动推送并保持同步，见官网「开发文档」。</p>
        </HelpTip></template>
        <input type="file" accept=".txt,.md,.markdown,.docx" class="file" @change="readFile" />
        <div v-if="converting" class="muted hint">Word 文档转换中…</div>
        <el-input v-model="docForm.content" type="textarea" :rows="14" placeholder="一篇文档一个主题，检索效果最好；支持 markdown" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="docOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="addDoc">添加并向量化</el-button>
    </template>
  </el-drawer>

  <!-- 库设置（名称/说明/可写接入方；kb_id 与模型建库锁定） -->
  <el-drawer v-model="settingsOpen" title="库设置" size="460px">
    <el-form label-position="top">
      <el-form-item label="建库锁定项">
        <div class="muted">kb_id <code>{{ cur?.kb_id }}</code> · {{ cur?.credential }} / {{ cur?.model }}（{{ cur?.dim }}维）<br />embedding 模型决定向量坐标系，换模型需重建库</div>
      </el-form-item>
      <el-form-item label="名称"><el-input v-model="settingsForm.name" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="settingsForm.description" /></el-form-item>
      <el-form-item v-if="s.can('clients:read')">
        <template #label>可写接入方 <HelpTip title="可写接入方是什么">
          <p>允许哪些<b>接入方</b>凭自己的 token 通过入库 API 往本库推送/删除文档——典型用法：业务系统把产品文档、操作流程自动同步进来，保存即更新。</p>
          <p>不勾任何接入方 = 只有控制台能写。推送规范与代码示例见官网「开发文档」。</p>
          <p>此白名单只管<b>写</b>；检索权限跟路由的知识注入走，不受影响。</p>
        </HelpTip></template>
        <el-select v-model="settingsForm.writers" multiple style="width: 100%" placeholder="不选 = 仅控制台可写">
          <el-option v-for="c in clientOptions" :key="c.app_id" :label="`${c.name}（${c.app_id}）`" :value="c.app_id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="settingsOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveSettings">保存</el-button>
    </template>
  </el-drawer>

  <!-- 数据源编辑（连接 + 取数 + 映射；测试预览后再保存） -->
  <el-drawer v-model="dsOpen" :title="dsForm.ds_id ? '编辑数据源' : '添加数据源'" size="620px">
    <el-form label-position="top">
      <el-tabs v-model="dsFormTab" class="console-tabs">
        <el-tab-pane label="连接" name="connection">
      <el-form-item>
        <template #label>名称 <span class="field-required">*</span></template>
        <el-input v-model="dsForm.name" placeholder="如 产品文档表" />
      </el-form-item>
      <el-form-item>
        <template #label>数据库连接 <HelpTip title="连接与安全">
          <p>中枢按「同步间隔」用<b>短连接</b>拉取，用完即断，不常驻。</p>
          <p><b>建议给只读账号</b>：连接器自身有两道闸（仅允许单条 SELECT + 会话级 read only），但最小权限永远是第一道。</p>
          <p>密码入库后不回显；编辑时留空 = 保留原密码。</p>
        </HelpTip></template>
        <div class="ds-conn">
          <el-input v-model="dsForm.db_host" placeholder="主机" style="flex: 3" class="mono" />
          <el-input v-model="dsForm.db_port" placeholder="3306" style="flex: 1" class="mono" />
        </div>
        <div class="ds-conn" style="margin-top: 8px">
          <el-input v-model="dsForm.db_user" placeholder="账号（建议只读）" style="flex: 1" class="mono" />
          <el-input v-model="dsForm.db_password" type="password" :placeholder="dsForm.ds_id ? '留空 = 保留原密码' : '密码'" style="flex: 1" show-password />
          <el-input v-model="dsForm.db_database" placeholder="库名" style="flex: 1" class="mono" />
        </div>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="取数映射" name="mapping">
      <el-form-item>
        <template #label>取数 SQL <HelpTip title="取数 SQL 怎么写">
          <p>单条 <code>SELECT</code>，查出「要进知识库的行」：每行一篇文档。带上幂等键、标题、正文要用到的全部字段。</p>
          <p>例：<code>SELECT id, title, content, updated_at FROM docs_articles WHERE status = 1</code></p>
          <p><b>上限 5000 行</b>：超限报错不静默截断（截断会让部分文档在对账时被误删）。量大就按分类拆成多个数据源。</p>
          <p>写操作被硬性拒绝（仅 SELECT + 会话只读），放心给。</p>
        </HelpTip></template>
        <el-input v-model="dsForm.query_sql" type="textarea" :rows="3" class="mono" placeholder="SELECT id, title, content FROM docs_articles WHERE status = 1" />
      </el-form-item>
      <el-form-item>
        <template #label>字段映射 <HelpTip title="三个映射各管什么">
          <p><b>幂等键字段</b>：哪个字段唯一标识这行（通常主键 id）。同步时文档号 = <code>ds{数据源id}:{该值}</code>——行更新→文档覆盖重嵌，行消失→文档下架。</p>
          <p><b>标题字段</b>：作为文档标题，检索结果里随块展示。</p>
          <p><b>内容模板</b>：<code>${字段名}</code> 占位拼正文（markdown），可混排多个字段与固定文字。<b>内容没变化的行自动跳过重嵌</b>，每小时同步也不烧 embedding 费。</p>
        </HelpTip></template>
        <div class="ds-conn">
          <el-input v-model="dsForm.key_field" placeholder="幂等键字段，如 id" style="flex: 1" class="mono" />
          <el-input v-model="dsForm.title_field" placeholder="标题字段，如 title" style="flex: 1" class="mono" />
        </div>
        <el-input v-model="dsForm.content_template" type="textarea" :rows="4" class="mono" style="margin-top: 8px"
          placeholder="${content}&#10;&#10;（可混排，如：## 适用范围&#10;${scope}）" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="调度" name="schedule">
      <el-form-item>
        <template #label>同步间隔（分钟） <HelpTip title="同步节奏">
          <p>到点自动拉一轮：行级对账（新增/更新/下架）。<b>0 = 仅手动</b>（列表里点「同步」）。</p>
          <p>未变更行被内容指纹短路，不重算向量——间隔可以放心设短；首轮全量会逐篇向量化，篇多时要等几分钟。</p>
        </HelpTip></template>
        <el-input-number v-model="dsForm.interval_min" :min="0" :max="10080" />
      </el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <div v-if="dsPreview" class="ds-preview">
      <div class="muted" style="margin-bottom: 6px">预览（前 3 行渲染效果，确认后再保存）：</div>
      <div v-for="(d, i) in dsPreview" :key="i" class="hit">
        <div class="hit-head"><code class="srckey">{{ d.source_key }}</code><b style="font-size:12px">{{ d.title }}</b></div>
        <pre class="hit-content">{{ d.content }}</pre>
      </div>
      <el-empty v-if="!dsPreview.length" description="SQL 查到 0 行" :image-size="40" />
    </div>
    <template #footer>
      <el-button :loading="dsTesting" @click="dsTest">测试连接并预览</el-button>
      <el-button @click="dsOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="dsSave">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { useMe } from '../store';
import { api } from '../request';
import { openDoc } from '../docs';
import { fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';

interface KbBase { kb_id: string; name: string; credential: string; model: string; dim: number; enabled: boolean; description?: string; writers?: string[]; doc_count: number; chunk_count: number }
interface KbDoc { doc_id: number; source_key?: string; title: string; status: string; error?: string; chunk_count: number; created_at: string }
interface Hit { score: number; content: string; title: string; seq: number }

const s = useMe();
const bases = ref<KbBase[]>([]);
const cur = ref<KbBase | null>(null);
const docs = ref<KbDoc[]>([]);
const credOptions = ref<string[]>([]);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const createOpen = ref(false);
const docOpen = ref(false);
const settingsOpen = ref(false);
function openDocs(page: 'knowledge' | 'api' = 'knowledge'): void {
  const paths: Record<typeof page, string> = {
    knowledge: '/docs/knowledge',
    api: '/docs/api',
  };
  openDoc(paths[page]);
}
const converting = ref(false);
const saving = ref(false);
const kbFormTab = ref<'basic' | 'embedding' | 'publish'>('basic');
const dsFormTab = ref<'connection' | 'mapping' | 'schedule'>('connection');
const settingsForm = reactive({ name: '', description: '', writers: [] as string[] });
const clientOptions = ref<Array<{ app_id: string; name: string }>>([]);

// ---- 数据源连接器 ----
interface KbDs {
  ds_id: number; name: string; db_host: string; db_port: number; db_user: string; db_database: string;
  query_sql: string; key_field: string; title_field: string; content_template: string; interval_min: number; enabled: boolean;
  last_sync_at?: string; last_status?: string; last_error?: string;
  last_stats?: { rows: number; upserted: number; skipped: number; deleted: number; errors: number; ms: number };
  doc_count: number;
}
const dsList = ref<KbDs[]>([]);
const dsOpen = ref(false);
const dsTesting = ref(false);
const dsPreview = ref<Array<{ source_key: string; title: string; content: string }> | null>(null);
const dsForm = reactive({ ds_id: 0, name: '', db_host: '', db_port: '3306', db_user: '', db_password: '', db_database: '',
  query_sql: '', key_field: 'id', title_field: 'title', content_template: '${content}', interval_min: 60 });
let dsPollTimer: ReturnType<typeof setTimeout> | null = null;
const createForm = reactive({ kb_id: '', name: '', credential: '', model: '', dim: 1024, description: '' });
const docForm = reactive({ title: '', content: '' });

const hitQuery = ref('');
const hitLoading = ref(false);
const hits = ref<Hit[] | null>(null);

function docStatusLabel(status: string): string {
  if (status === 'ready') return '就绪';
  if (status === 'embedding') return '向量化中';
  return '失败';
}

function docStatusType(status: string): 'success' | 'info' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'embedding') return 'info';
  return 'danger';
}

function dsStatusLabel(status?: string): string {
  if (status === 'ok') return '正常';
  if (status === 'running') return '同步中';
  if (status === 'error') return '失败';
  return '未同步';
}

function dsStatusType(status?: string): 'success' | 'info' | 'danger' {
  if (status === 'ok') return 'success';
  if (status === 'running') return 'info';
  if (status === 'error') return 'danger';
  return 'info';
}

function dsScheduleLabel(min?: number): string {
  return Number(min || 0) > 0 ? `每 ${min} 分钟` : '仅手动';
}

function dsStatsLabel(stats: KbDs['last_stats']): string {
  if (!stats) return '';
  return `行 ${stats.rows} · 更新 ${stats.upserted} · 跳过 ${stats.skipped} · 下架 ${stats.deleted} · 异常 ${stats.errors}`;
}

function openCreateKb(): void {
  kbFormTab.value = 'basic';
  createOpen.value = true;
}

async function loadBases(keepCur = true): Promise<void> {
  bases.value = await api<KbBase[]>('/admin/api/kb');
  if (keepCur && cur.value) cur.value = bases.value.find((b) => b.kb_id === cur.value!.kb_id) ?? null;
  if (!cur.value && bases.value.length) await selectKb(bases.value[0]!);
}

async function selectKb(b: KbBase): Promise<void> {
  cur.value = b; hits.value = null; hitQuery.value = '';
  await Promise.all([loadDocs(), loadDs()]);
}

async function loadDocs(): Promise<void> {
  if (!cur.value) return;
  docs.value = await api<KbDoc[]>(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/docs`);
  if (pollTimer) clearTimeout(pollTimer);
  // 向量化是后台任务：有进行中的就轮询到就绪
  if (docs.value.some((d) => d.status === 'embedding')) pollTimer = setTimeout(() => void loadDocs(), 2000);
}

async function createKb(): Promise<void> {
  saving.value = true;
  try {
    await api('/admin/api/kb', { method: 'POST', body: JSON.stringify(createForm) });
    ElMessage.success(`知识库 ${createForm.kb_id} 已创建`);
    createOpen.value = false;
    Object.assign(createForm, { kb_id: '', name: '', credential: '', model: '', dim: 1024, description: '' });
    await loadBases(false);
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}

async function delKb(): Promise<void> {
  if (!cur.value) return;
  try {
    await api(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}`, { method: 'DELETE' });
    ElMessage.success('知识库已删除');
    cur.value = null;
    await loadBases(false);
  } catch (e) { ElMessage.error((e as Error).message); }
}

async function readFile(e: Event): Promise<void> {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (!docForm.title) docForm.title = f.name.replace(/\.(txt|md|markdown|docx)$/i, '');
  if (/\.docx$/i.test(f.name)) {
    // Word 在浏览器本地转 markdown（mammoth: docx→HTML，turndown: HTML→markdown），文件不经任何服务器；
    // 两个库按需加载，不进首屏包
    converting.value = true;
    try {
      const [mammothMod, turndownMod] = await Promise.all([import('mammoth'), import('turndown')]);
      const mammoth = (mammothMod as any).default ?? mammothMod;
      const TurndownService = (turndownMod as any).default ?? turndownMod;
      const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
      let md: string = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html);
      // Word 内嵌图片是 base64：不入库（撑爆存储且向量无意义），换占位符提示改用图片链接
      md = md.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, (_m: string, alt: string) => `[图：${alt || '嵌入图片'}（Word 内嵌图片不入库，需要图片请改用图片链接）]`);
      docForm.content = md.trim();
      ElMessage.success('Word 已转为 markdown，请检查后提交');
    } catch (err) { ElMessage.error('Word 解析失败：' + (err as Error).message); }
    finally { converting.value = false; (e.target as HTMLInputElement).value = ''; }
    return;
  }
  const rd = new FileReader();
  rd.onload = () => { docForm.content = String(rd.result ?? ''); };
  rd.readAsText(f);
}

// ---- 库设置（名称/说明/可写接入方）----
function openSettings(): void {
  if (!cur.value) return;
  settingsForm.name = cur.value.name;
  settingsForm.description = cur.value.description ?? '';
  settingsForm.writers = [...(cur.value.writers ?? [])];
  settingsOpen.value = true;
}

async function saveSettings(): Promise<void> {
  if (!cur.value) return;
  saving.value = true;
  try {
    // 同一 upsert 接口：kb_id 已存在时服务端只更新 name/description/writers/enabled（模型坐标系锁定）
    await api('/admin/api/kb', { method: 'POST', body: JSON.stringify({
      kb_id: cur.value.kb_id, name: settingsForm.name, credential: cur.value.credential,
      model: cur.value.model, dim: cur.value.dim, enabled: cur.value.enabled,
      description: settingsForm.description, writers: settingsForm.writers,
    }) });
    ElMessage.success('已保存');
    settingsOpen.value = false;
    await loadBases();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}

async function addDoc(): Promise<void> {
  if (!cur.value) return;
  saving.value = true;
  try {
    await api(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/docs`, { method: 'POST', body: JSON.stringify(docForm) });
    ElMessage.success('文档已提交，向量化进行中');
    docOpen.value = false;
    docForm.title = ''; docForm.content = '';
    await loadDocs();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}

async function delDoc(docId: number): Promise<void> {
  if (!cur.value) return;
  try {
    await api(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/docs/${docId}`, { method: 'DELETE' });
    await loadDocs(); await loadBases();
  } catch (e) { ElMessage.error((e as Error).message); }
}

async function loadDs(): Promise<void> {
  if (!cur.value) return;
  try { dsList.value = await api<KbDs[]>(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/datasources`); } catch { dsList.value = []; }
  if (dsPollTimer) clearTimeout(dsPollTimer);
  // 有同步在跑就轮询到结束，顺带刷新文档列表（同步会增删文档）
  if (dsList.value.some((d) => d.last_status === 'running')) {
    dsPollTimer = setTimeout(() => { void loadDs(); void loadDocs(); void loadBases(); }, 3000);
  }
}

function openDsForm(row?: KbDs): void {
  dsFormTab.value = 'connection';
  dsPreview.value = null;
  if (row) {
    Object.assign(dsForm, { ds_id: row.ds_id, name: row.name, db_host: row.db_host, db_port: String(row.db_port),
      db_user: row.db_user, db_password: '', db_database: row.db_database, query_sql: row.query_sql,
      key_field: row.key_field, title_field: row.title_field, content_template: row.content_template, interval_min: row.interval_min });
  } else {
    Object.assign(dsForm, { ds_id: 0, name: '', db_host: '', db_port: '3306', db_user: '', db_password: '', db_database: '',
      query_sql: '', key_field: 'id', title_field: 'title', content_template: '${content}', interval_min: 60 });
  }
  dsOpen.value = true;
}

function dsBody(): Record<string, unknown> {
  return { ds_id: dsForm.ds_id || undefined, name: dsForm.name, db_host: dsForm.db_host, db_port: Number(dsForm.db_port) || 3306,
    db_user: dsForm.db_user, db_password: dsForm.db_password, db_database: dsForm.db_database, query_sql: dsForm.query_sql,
    key_field: dsForm.key_field, title_field: dsForm.title_field, content_template: dsForm.content_template, interval_min: dsForm.interval_min };
}

async function dsTest(): Promise<void> {
  if (!cur.value) return;
  dsTesting.value = true; dsPreview.value = null;
  try {
    const r = await api<{ preview: Array<{ source_key: string; title: string; content: string }> }>(
      `/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/datasources/test`, { method: 'POST', body: JSON.stringify(dsBody()) });
    dsPreview.value = r.preview;
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { dsTesting.value = false; }
}

async function dsSave(): Promise<void> {
  if (!cur.value) return;
  saving.value = true;
  try {
    await api(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/datasources`, { method: 'POST', body: JSON.stringify(dsBody()) });
    ElMessage.success(dsForm.ds_id ? '已保存' : '数据源已创建，点「同步」拉首轮');
    dsOpen.value = false;
    await loadDs();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}

async function dsSyncNow(row: KbDs): Promise<void> {
  if (!cur.value) return;
  try {
    await api(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/datasources/${row.ds_id}/sync`, { method: 'POST', body: '{}' });
    ElMessage.success('同步已启动，首轮全量会逐篇向量化');
    row.last_status = 'running';
    if (dsPollTimer) clearTimeout(dsPollTimer);
    dsPollTimer = setTimeout(() => { void loadDs(); void loadDocs(); void loadBases(); }, 3000);
  } catch (e) { ElMessage.error((e as Error).message); }
}

async function dsDel(row: KbDs): Promise<void> {
  if (!cur.value) return;
  try {
    const r = await api<{ purged_docs: number }>(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/datasources/${row.ds_id}`, { method: 'DELETE' });
    ElMessage.success(`数据源已删除，清掉 ${r.purged_docs} 篇同步文档`);
    await Promise.all([loadDs(), loadDocs(), loadBases()]);
  } catch (e) { ElMessage.error((e as Error).message); }
}

async function hitTest(): Promise<void> {
  if (!cur.value || !hitQuery.value.trim()) return;
  hitLoading.value = true;
  try {
    const r = await api<{ hits: Hit[] }>(`/admin/api/kb/${encodeURIComponent(cur.value.kb_id)}/hittest`, {
      method: 'POST', body: JSON.stringify({ query: hitQuery.value }),
    });
    hits.value = r.hits;
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { hitLoading.value = false; }
}

onMounted(async () => {
  await loadBases();
  // 凭证下拉仅在有权限时加载；无权限（kb_editor）退化为手填
  if (s.can('credentials:read')) {
    try { credOptions.value = (await api<Array<{ name: string; kind: string }>>('/admin/api/credentials'))
      .filter((c) => c.kind !== 'chat').map((c) => c.name); } catch { /* 可选 */ }
  }
  // 可写接入方下拉（kb_editor 无 clients 权限时隐藏该项，白名单仍可由 admin 维护）
  if (s.can('clients:read')) {
    try { clientOptions.value = await api<Array<{ app_id: string; name: string }>>('/admin/api/clients'); } catch { /* 可选 */ }
  }
});
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer); if (dsPollTimer) clearTimeout(dsPollTimer); });
</script>

<style scoped>
.kb-layout { display: flex; gap: 16px; align-items: flex-start; }
.kb-list { width: 240px; flex: none; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 0; padding: 10px; }
.kb-list-head { display: flex; justify-content: space-between; align-items: center; padding: 2px 8px 8px; }
.kb-item { padding: 8px 10px; border-radius: 0; cursor: pointer; }
.kb-item:hover { background: var(--el-fill-color-light); }
.kb-item.active { background: var(--el-color-primary-light-9); }
.kb-name { font-weight: 600; font-size: 13px; }
.kb-meta { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px; }
.kb-main { flex: 1; min-width: 0; }
.block { margin-bottom: 16px; border-radius: 0; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.hint { margin-top: 4px; line-height: 1.4; }
.file { margin-bottom: 8px; font-size: 12px; display: block; }
.doc-main,
.doc-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  line-height: 1.35;
}
.doc-main b {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-main code,
.sql-line {
  max-width: 100%;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--bz-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tagline { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.hit-form { display: flex; gap: 8px; max-width: 560px; }
.hits { margin-top: 14px; }
.hit { margin-bottom: 14px; }
.hit-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.hit-bar { width: 120px; }
.hit-score { font-weight: 600; }
.hit-content { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin: 0; font: 12px/1.55 inherit; white-space: pre-wrap; }
.ds-conn { display: flex; gap: 8px; width: 100%; }
.ds-preview { margin-top: 4px; }
.srckey { font-family: var(--bz-mono); font-size: 11px; background: var(--el-fill-color-light); padding: 1px 5px; border-radius: 0; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
</style>
