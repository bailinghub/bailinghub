<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>工具源</b> <HelpTip title="工具源是什么">
          <p>业务系统的 <b>Agent 可调接口清单</b>（OpenAPI + <code>x-agent-capability</code> 契约）；注册后在「触发路由」挂 tools 白名单，即可让 Agent 查 / 办业务。</p>
        </HelpTip>
        <el-button style="margin-left: auto" @click="openDocs('tools')">开发文档</el-button>
        <el-button type="primary" @click="openCreate">注册工具源</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有工具源：业务系统在自己的 OpenAPI 上声明 x-agent-capability 后，把 spec 注册进来">
      <el-button @click="openDocs('tools')">查看开发文档</el-button>
      <el-button type="primary" @click="openCreate">注册第一个</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="工具源" min-width="270" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="tool-main">
            <b>{{ row.name }}</b>
            <code>{{ row.base_url }}</code>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="接口清单" min-width="230">
        <template #default="{ row }">
          <div class="tool-stack">
            <div class="tagline">
              <el-tag size="small" effect="plain" :type="row.has_spec ? 'success' : 'danger'">{{ row.has_spec ? '已载入' : '未载入' }}</el-tag>
              <el-tag size="small" effect="plain" type="info">{{ specSourceLabel(row) }}</el-tag>
              <el-tag v-if="row.embed_credential" size="small" effect="plain" type="warning" :title="'工具检索已开启 · ' + (row.embed_model || '')">语义检索</el-tag>
            </div>
            <span class="muted">{{ refreshPolicyLabel(row) }}</span>
            <span class="muted">{{ specRefreshedLabel(row) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="治理安全" min-width="260">
        <template #default="{ row }">
          <div class="tool-stack">
            <div class="tagline">
              <el-tag size="small" effect="plain" :type="authzProbeType(row.authz_probe)" :title="authzProbeTitle(row.authz_probe)">{{ authzProbeLabel(row.authz_probe) }}</el-tag>
              <el-tag size="small" effect="plain" type="info">{{ auditLabel(row) }}</el-tag>
              <el-tag size="small" effect="plain" type="info">{{ timeoutLabel(row.timeout_ms) }}</el-tag>
              <el-tag size="small" effect="plain" type="info">{{ rateLimitLabel(row.rate_limit_per_min) }}</el-tag>
            </div>
            <div class="probe-line">
              <span class="muted">{{ authzProbeSummary(row.authz_probe) }}</span>
              <el-popover trigger="hover" placement="top" width="380">
                <template #reference>
                  <el-button link size="small">详情</el-button>
                </template>
                <div class="probe-popover">
                  <div class="probe-title">{{ authzProbeTitle(row.authz_probe) }}</div>
                  <div class="probe-meta">
                    <span>模式：{{ authzProbeMode(row.authz_probe) }}</span>
                    <span v-if="row.authz_probe?.path">路径：<code>{{ row.authz_probe.path }}</code></span>
                    <span v-if="row.authz_probe?.tool">工具：<code>{{ row.authz_probe.tool }}</code></span>
                    <span v-if="row.authz_probe?.http">HTTP：{{ row.authz_probe.http }}</span>
                  </div>
                  <div class="probe-advice-title">建议</div>
                  <ul class="probe-advice">
                    <li v-for="item in authzProbeAdvice(row.authz_probe)" :key="item">{{ item }}</li>
                  </ul>
                </div>
              </el-popover>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="密钥与状态" width="190">
        <template #default="{ row }">
          <div class="tool-stack">
            <div class="secret-line">
              <code>{{ row.secret }}</code>
              <el-button v-if="s.can('tools:write')" link type="primary" @click="copySecret(row.name)">复制</el-button>
            </div>
            <el-tag size="small" effect="plain" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="320" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="preview(row)">工具清单</el-button>
          <el-button v-if="row.spec_source === 'url'" link type="primary" :loading="refreshing === row.name" @click="refresh(row.name)">刷新</el-button>
          <el-button link type="primary" :loading="probing === row.name" @click="probeAuthz(row.name)">探针</el-button>
          <el-button v-if="row.embed_credential" link type="primary" :loading="reindexing === row.name" @click="reindex(row.name)">重建索引</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该工具源？挂它的路由会降级为纯对话。" width="250" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 注册/编辑 -->
  <el-drawer v-model="open" :title="editing ? '编辑工具源' : '注册工具源'" size="560px">
    <el-form label-position="top">
      <el-tabs v-model="toolFormTab" class="console-tabs">
        <el-tab-pane label="基础" name="basic">
      <el-form-item>
        <template #label>{{ fieldTitle('name', '名称') }} <span v-if="fieldRequired('name')" class="field-required">*</span>
          <HelpTip :title="fieldTitle('name', '名称')"><p>{{ fieldDesc('name') }}</p></HelpTip>
        </template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 demo-business / business-api" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('base_url', 'Base URL') }} <span v-if="fieldRequired('base_url')" class="field-required">*</span> <HelpTip :title="fieldTitle('base_url', 'Base URL')">
          <p>{{ fieldDesc('base_url') }}</p>
          <p>AI 调工具时，请求发到 <code>base_url + 接口 path</code>。</p>
          <p><b>必须指向源站直连地址</b>——中枢"签所发即所发"，URI 会被重写 / 重编码的 CDN 或网关后面验签必挂。</p>
        </HelpTip></template>
        <el-input v-model="form.base_url" placeholder="https://server.example.com" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('secret', '签名密钥') }} <span v-if="fieldRequired('secret')" class="field-required">*</span> <HelpTip :title="fieldTitle('secret', '签名密钥')">
          <p>{{ fieldDesc('secret') }}</p>
          <p>建议点「生成」用 32 位随机串。签名标签统一 <b>sha256=</b>（算法名，非版本号）：构造把操作主体+任务也钉进 HMAC（spec 拉取无主体/任务即签空串，同一套构造）。<b>轮换：</b>改这里即时生效（无需重启），但业务侧 secret 要同步换成同值，否则验签失败；该 secret 在业务侧两处用（工具接口验签 + spec 托管）。</p>
          <p>这是中枢与业务的<b>共享密钥</b>——业务侧验签要用同一串。建好后列表里只显示掩码，点该行「<b>复制</b>」按钮可随时取回完整值交给业务方（与模型凭证的 api_key 不同，那是中枢出站凭证、永不外泄）。</p>
          <p>与接入方 token、中枢管理 token 完全解耦，可单独轮换；泄露只影响"伪装中枢调业务"，不波及其他面。</p>
        </HelpTip></template>
        <el-input v-model="form.secret" type="password" show-password autocomplete="off" :placeholder="editing ? '留空 = 保留原密钥' : ''">
          <template #append><el-button @click="genSecret">生成</el-button></template>
        </el-input>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="接口清单" name="spec">
      <el-form-item>
        <template #label>{{ fieldTitle('spec_source', '接口清单来源') }} <HelpTip :title="fieldTitle('spec_source', '接口清单来源')"><p>{{ fieldDesc('spec_source') }}</p></HelpTip></template>
        <el-radio-group v-model="form.spec_source">
          <el-radio value="inline">粘贴 openapi.json</el-radio>
          <el-radio value="url">从 URL 拉取</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="form.spec_source === 'url'">
        <template #label>{{ fieldTitle('spec_url', '接口清单地址') }} <span class="field-required">*</span> <HelpTip :title="fieldTitle('spec_url', '接口清单地址')">
          <p>{{ fieldDesc('spec_url') }}</p>
          <p>推荐约定路径 <code>/.well-known/bailing/tools.json</code>，但<b>不强制</b>——宝塔等面板对点开头路径有特殊处理（详见官网开发文档），换任意路径（如 <code>/api/bailing/tools</code>）即可绕开。</p>
          <p>建议 spec 根声明 <code>x-bailing-authz-probe</code>，并在业务系统单独挂一个授权探针端点；中枢刷新后会用不存在的主体验证业务侧是否 fail-closed。</p>
        </HelpTip></template>
        <el-input v-model="form.spec_url" placeholder="https://server.example.com/.well-known/bailing/tools.json" class="mono" />
      </el-form-item>
      <el-form-item v-if="form.spec_source === 'url'">
        <template #label>{{ fieldTitle('auto_refresh_min', '自动刷新') }}（分钟，0 = 关闭） <HelpTip :title="fieldTitle('auto_refresh_min', '自动刷新')">
          <p>{{ fieldDesc('auto_refresh_min') }}</p>
          <p>业务侧每次部署更新 spec 后，中枢按此间隔定时拉取，新标注的接口<b>无需任何人工操作</b>即成为 AI 工具。</p>
          <p>自动生效不等于无人知晓：每次拉取与上次清单对账，工具<b>新增 / 移除 / scope 或风险级变化</b>都会记审计并告警管理员；拉取失败保留旧清单继续工作。</p>
        </HelpTip></template>
        <el-input-number v-model="form.auto_refresh_min" :min="0" :max="1440" :step="5" />
      </el-form-item>
      <el-form-item v-else>
        <template #label>{{ fieldTitle('spec_json', 'OpenAPI 文档') }} <HelpTip :title="fieldTitle('spec_json', 'OpenAPI 文档')"><p>{{ editing ? fieldDesc('spec_json') : '含 x-agent-capability 契约的 OpenAPI 3.x JSON 或 YAML；保存后统一归一化。' }}</p></HelpTip></template>
        <el-input v-model="form.spec_json" type="textarea" :rows="8" class="mono" placeholder="openapi: 3.0.0\npaths:\n  /records/list:\n    get:\n      x-agent-capability:\n        version: 1\n        enabled: true\n        scope: records.read" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="治理" name="governance">
      <el-form-item>
        <template #label>审计粒度 <HelpTip title="审计粒度">
          <p>每次工具调用的参数记到什么程度：全量值（≤4KB 截断）便于排障对账；只记键名适合隐私敏感场景。</p>
          <p>无论选哪种，业务侧标了 <code>sensitive</code> 的工具一律只记键名（接口注解优先级更高）。</p>
        </HelpTip></template>
        <el-radio-group v-model="form.log_payload">
          <el-radio :value="true">记参数全量值（≤4KB 截断，默认）</el-radio>
          <el-radio :value="false">只记键名（隐私敏感场景）</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('timeout_ms', '单次调用超时') }}（毫秒） <HelpTip :title="fieldTitle('timeout_ms', '单次调用超时')"><p>{{ fieldDesc('timeout_ms') }}</p></HelpTip></template>
        <el-input-number v-model="form.timeout_ms" :min="1000" :max="60000" :step="1000" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('rate_limit_per_min', '总闸限流') }}（次/分钟，0=不限） <HelpTip :title="fieldTitle('rate_limit_per_min', '总闸限流')"><p>{{ fieldDesc('rate_limit_per_min') }}</p></HelpTip></template>
        <el-input-number v-model="form.rate_limit_per_min" :min="0" :max="6000" :step="10" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="工具检索" name="retrieval">
      <el-form-item>
        <template #label>向量模型凭证 <HelpTip title="工具检索：工具一多就别甩目录给模型">
          <p>工具超过 12 个时，与其把整份目录甩给模型让它自己翻（命中率低、模型常常不去翻），不如由中枢按用户这句话<b>语义检索</b>出最相关的十来个工具，直接内联给模型用。</p>
          <p>开启需要一把<b>向量化凭证</b>（在「模型凭证」里添加、用途含向量化）。<b>留空 = 不开检索</b>，使用「目录 + find_tools」渐进披露模式。</p>
          <p>模型 / 维度与索引坐标系绑定，改了会整源重算（保存时自动重建）。建好后列表行有「重建索引」按钮可手动重建。</p>
        </HelpTip></template>
        <el-select v-model="form.embed_credential" clearable filterable placeholder="留空 = 不开工具检索" style="width: 100%" @change="onEmbedCred">
          <el-option v-for="c in embCreds" :key="c.name" :value="c.name" :label="c.name + '（' + (c.default_model || '?') + '）'" />
        </el-select>
        <div v-if="!embCreds.length" class="muted hint">还没有可向量化的凭证——先去「模型凭证」加一把（用途含向量化）</div>
      </el-form-item>
      <el-form-item v-if="form.embed_credential" label="向量模型"><el-input v-model="form.embed_model" placeholder="如 text-embedding-v4" class="mono" /></el-form-item>
      <el-form-item v-if="form.embed_credential" label="向量维度"><el-input-number v-model="form.embed_dim" :min="64" :max="4096" :step="256" /></el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item label="说明（可选）"><el-input v-model="form.description" /></el-form-item>
      <el-form-item v-if="editing" label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>

  <!-- 工具清单预览 -->
  <!-- 800 = 内表格最小宽 670 + 展开列 48 + 抽屉内边距 40 + 余量；改列宽时同步核算，别让抽屉底部出横向滚动 -->
  <el-drawer v-model="previewOpen" :title="'工具清单 · ' + previewName" size="800px">
    <el-alert v-if="previewNote" :title="previewNote" type="warning" :closable="false" style="margin-bottom: 12px" />
    <template v-if="previewWarnings.length">
      <div class="muted" style="margin: 0 0 6px">接入体检提醒：</div>
      <div v-for="w in previewWarnings" :key="w.path + w.code + w.message" class="warning-row">
        <code>{{ w.path }}</code><span>{{ w.message }}</span>
      </div>
    </template>
    <template v-if="previewTools.length">
      <!-- 搜索：文本筛选（即时、按名/路径/scope/描述）+ 语义召回预演（用向量检索预演"这句话会召回哪些工具、精度多高"，调优工具措辞） -->
      <div class="search-bar">
        <el-input v-model="previewFilter" clearable size="small" placeholder="筛选：名称 / 路径 / scope / 描述（即时）" style="max-width: 300px" />
        <template v-if="previewEmbed">
          <el-input v-model="retrieveQ" clearable size="small" placeholder="语义召回预演：输入用户可能问的话" style="max-width: 320px" @keyup.enter="runRetrieveTest" />
          <el-button type="primary" size="small" :loading="retrieving" @click="runRetrieveTest">召回预演</el-button>
        </template>
        <span v-else class="muted">（该工具源未开启检索，仅文本筛选可用）</span>
      </div>
      <div class="debug-call">
        <div class="debug-head">
          <b>调试调用</b>
          <span class="muted">走中枢同款签名材料真实请求业务源站；高风险/审批工具默认只展示阻断原因，不直接执行。</span>
        </div>
        <el-row :gutter="8">
          <el-col :span="8">
            <el-select v-model="debugTool" filterable placeholder="选择工具" size="small" style="width: 100%">
              <el-option v-for="t in previewTools" :key="t.name" :label="`${t.name} · ${t.method} ${t.path}`" :value="t.name" />
            </el-select>
          </el-col>
          <el-col :span="8"><el-input v-model="debugSubject" size="small" placeholder="操作主体 on_behalf_of，如 demo-user-001" class="mono" /></el-col>
          <el-col :span="8">
            <el-select v-model="debugSampleId" clearable size="small" placeholder="最近样例" style="width: 100%" @change="applyDebugSampleById">
              <el-option v-for="sample in debugSamples" :key="sample.id" :label="debugSampleLabel(sample)" :value="sample.id" />
            </el-select>
          </el-col>
        </el-row>
        <div class="debug-mode">
          <el-radio-group v-model="debugMode" size="small">
            <el-radio-button value="form">参数表单</el-radio-button>
            <el-radio-button value="json">JSON</el-radio-button>
          </el-radio-group>
          <span v-if="selectedDebugTool" class="muted">
            {{ selectedDebugTool.method }} {{ selectedDebugTool.path }} · <code>{{ selectedDebugTool.scope }}</code>
          </span>
        </div>
        <div v-if="debugMode === 'form'" class="debug-param-grid">
          <div v-if="!debugParamRows.length" class="muted debug-empty">该工具无入参，点击“实调验证”即可发起请求。</div>
          <div v-for="p in debugParamRows" :key="p.name" class="debug-param">
            <div class="debug-param-label">
              <code>{{ p.name }}</code>
              <el-tag size="small" effect="plain" type="info">{{ p.loc }}</el-tag>
              <el-tag v-if="p.required" size="small" effect="plain" type="danger">必填</el-tag>
            </div>
            <el-select v-if="p.enum?.length" v-model="debugParamValues[p.name]" clearable filterable size="small" :placeholder="p.desc || p.type">
              <el-option v-for="x in p.enum" :key="String(x)" :label="String(x)" :value="String(x)" />
            </el-select>
            <el-switch v-else-if="p.type === 'boolean'" v-model="debugParamValues[p.name]" active-value="true" inactive-value="false" />
            <el-input-number v-else-if="p.type === 'number' || p.type === 'integer'" v-model="debugParamValues[p.name]" size="small" style="width: 100%" />
            <el-input v-else-if="p.type === 'array' || p.type === 'object'" v-model="debugParamValues[p.name]" size="small" class="mono" :placeholder="p.type === 'array' ? '[...]' : '{...}'" />
            <el-input v-else v-model="debugParamValues[p.name]" size="small" class="mono" :placeholder="p.desc || p.type" />
            <div v-if="p.desc" class="muted debug-param-desc">{{ p.desc }}</div>
          </div>
        </div>
        <el-input v-else v-model="debugArgs" type="textarea" :rows="4" class="mono debug-json" placeholder='{"id":1}' />
        <div class="debug-actions">
          <el-checkbox v-model="debugAllowRisky" size="small">允许实调高风险/审批工具</el-checkbox>
          <el-button size="small" @click="syncDebugJsonFromForm">生成 JSON</el-button>
          <el-button type="primary" size="small" :loading="debugLoading" @click="runDebugInvoke">实调验证</el-button>
        </div>
        <div v-if="debugResult" class="debug-result">
          <div class="debug-status">
            <el-tag size="small" effect="plain" :type="debugResult.blocked ? 'warning' : debugResult.ok ? 'success' : 'danger'">{{ debugResult.blocked ? '已阻断' : debugResult.ok ? '调用成功' : '调用失败' }}</el-tag>
            <span v-if="debugResult.reason" class="muted">{{ debugResult.reason }}</span>
            <span v-if="debugResult.response" class="muted">HTTP {{ debugResult.response.status }} · {{ debugResult.response.duration_ms }}ms</span>
          </div>
          <div v-if="debugDiagnosis" class="debug-diagnosis">{{ debugDiagnosis }}</div>
          <div class="td-sec">签名字段</div>
          <div class="signature-grid">
            <div v-for="row in debugSignatureRows" :key="row.k"><span>{{ row.k }}</span><code>{{ row.v }}</code></div>
          </div>
          <div class="td-sec">请求摘要</div>
          <pre class="block">{{ JSON.stringify(debugResult.request, null, 2) }}</pre>
          <template v-if="debugResult.response">
            <div class="td-sec">业务响应</div>
            <pre class="block">{{ debugResult.response.text || '（空响应）' }}{{ debugResult.response.truncated ? '\n…[已截断]' : '' }}</pre>
          </template>
        </div>
      </div>
      <!-- 召回预演结果：绿=分数≥阈值会被内联给模型，灰=低于阈值仅 search_tools 可能补上 -->
      <div v-if="retrieveHits.length" class="retrieve-result">
        <div class="muted" style="margin-bottom: 6px">
          针对「<b>{{ lastRetrieveQ }}</b>」的召回排序（<el-tag size="small" type="success" effect="plain">绿</el-tag> = 分数 ≥ 阈值 {{ retrieveMinScore }}，会被内联给大脑；<el-tag size="small" type="info" effect="plain">灰</el-tag> = 低于阈值，仅模型主动 search_tools 时才可能补上）。
          相关工具分数偏低 / 排得靠后 → 在它的 summary/描述里补上用户常说的词来调优。
        </div>
        <div class="rh-list">
          <div v-for="h in retrieveHits" :key="h.name" class="rh-row" :class="{ below: h.score < retrieveMinScore }">
            <el-tag size="small" effect="plain" :type="h.score >= retrieveMinScore ? 'success' : 'info'">{{ h.score.toFixed(3) }}</el-tag>
            <code style="margin: 0 8px">{{ h.name }}</code><span class="muted">{{ h.scope }}</span>
          </div>
        </div>
      </div>
      <div class="muted" style="margin-bottom: 8px">共 {{ previewTools.length }} 个工具可被路由 allow 白名单引用（按 scope 匹配）<span v-if="previewFilter">，筛选出 <b>{{ filteredTools.length }}</b> 个</span>。<b>点行首箭头看完整详情</b>——业务侧注解派生出的全部内容（参数 schema / 治理参数 / 给 AI 的原文）都在这里核对，不用翻业务代码：</div>
      <el-table :data="filteredTools" size="small" row-key="name">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="tool-detail">
              <div class="td-sec">给 AI 的完整描述（summary + 何时用 + 返回 + 示例参数，AI 据此判断何时调用）</div>
              <div class="td-text">{{ row.description }}</div>
              <div class="td-sec">参数 schema（AI 按此传参；位置 = 中枢转发时放 query 还是 body）</div>
              <el-table v-if="paramRows(row).length" :data="paramRows(row)" size="small">
                <el-table-column label="参数" width="150"><template #default="{ row: p }"><code>{{ p.name }}</code></template></el-table-column>
                <el-table-column label="位置" width="64" prop="loc" />
                <el-table-column label="类型" width="90" prop="type" />
                <el-table-column label="必填" width="56"><template #default="{ row: p }">{{ p.required ? '是' : '' }}</template></el-table-column>
                <el-table-column label="说明" min-width="180"><template #default="{ row: p }">{{ p.desc || '—' }}</template></el-table-column>
              </el-table>
              <div v-else class="muted">无参数（GET 允许零参数；写接口无参数不会派生到这里）</div>
              <div class="td-sec">治理参数</div>
              <div class="td-text">
                超时 {{ row.timeout_ms ? row.timeout_ms + ' ms（ACC execution.timeout_ms 覆盖）' : '跟随工具源全局' }}
                · 单工具限速 {{ row.rate_limit_per_min ? row.rate_limit_per_min + ' 次/分' : '不限（用工具源全局限速）' }}
                · {{ row.idempotent ? '幂等：失败可安全重试' : '非幂等：失败不自动重试' }}
                · {{ row.readonly ? '只读' : '会改数据' }}
              </div>
              <template v-if="row.confirm_prompt">
                <div class="td-sec">审批通知话术（ACC approval.prompt，{参数名} 由实参填充后发给审批人）</div>
                <div class="td-text">{{ row.confirm_prompt }}</div>
              </template>
              <template v-if="row.confirm_when?.length">
                <div class="td-sec">参数级确认规则（ACC approval.when，命中后本次调用进入审批）</div>
                <pre class="block">{{ JSON.stringify(row.confirm_when, null, 2) }}</pre>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="工具" min-width="170"><template #default="{ row }"><code>{{ row.name }}</code><div class="muted">{{ row.method }} {{ row.path }}</div></template></el-table-column>
        <el-table-column label="权限范围" width="170"><template #default="{ row }"><code>{{ row.scope }}</code></template></el-table-column>
        <el-table-column label="风险/标记" width="170">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.risk === 'high' ? 'danger' : row.risk === 'medium' ? 'warning' : 'success'">{{ row.risk }}</el-tag>
            <el-tag v-if="row.confirm_required" size="small" type="danger" effect="plain" style="margin-left: 2px">需确认</el-tag>
            <el-tag v-if="row.confirm_when?.length" size="small" type="danger" effect="plain" style="margin-left: 2px">条件确认</el-tag>
            <el-tag v-if="row.requires_subject" size="small" type="warning" effect="plain" style="margin-left: 2px">需主体</el-tag>
            <el-tag v-if="row.sensitive" size="small" type="info" effect="plain" style="margin-left: 2px">敏感</el-tag>
            <el-tag v-if="row.readonly && row.method !== 'GET'" size="small" type="success" effect="plain" style="margin-left: 2px">只读</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="160" show-overflow-tooltip />
      </el-table>
      <div class="muted" style="margin-top: 8px">注：risk=high、「需确认」或命中「条件确认」的工具调用会先冻结为审批意图；业务侧或控制台兜底批准后，任务按原调用快照自动重跑执行。</div>
    </template>
    <template v-if="previewSkipped.length">
      <div class="muted" style="margin: 14px 0 6px">以下接口被跳过（不会暴露给 AI）：</div>
      <div v-for="s in previewSkipped" :key="s.path" class="skipped mono">{{ s.path }} — {{ s.reason }}</div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { openDoc } from '../docs';
import { fmtTime } from '../util';
import { useMe } from '../store';
import HelpTip from '../components/HelpTip.vue';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

const s = useMe();
const toolSchema = useConfigSchema('tool-provider');
const list = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const toolFormTab = ref<'basic' | 'spec' | 'governance' | 'retrieval' | 'publish'>('basic');
const refreshing = ref('');
const reindexing = ref('');
const probing = ref('');
const embCreds = ref<any[]>([]); // 可做向量化的凭证（kind embedding/both），供工具检索选坐标系
const form = reactive({ name: '', base_url: '', secret: '', spec_source: 'inline', spec_url: '', spec_json: '', log_payload: true, timeout_ms: 10000, rate_limit_per_min: 120, auto_refresh_min: 0, description: '', enabled: true, embed_credential: '', embed_model: '', embed_dim: 1024 });

const previewOpen = ref(false);
const previewName = ref('');
const previewTools = ref<any[]>([]);
const previewSkipped = ref<any[]>([]);
const previewWarnings = ref<any[]>([]);
const previewNote = ref('');
const previewEmbed = ref(false);          // 被预览的工具源是否开了检索（决定显不显示「召回预演」）
const previewFilter = ref('');            // 文本筛选词（即时过滤工具表）
const retrieveQ = ref('');                // 语义召回预演的输入
const lastRetrieveQ = ref('');            // 上次预演词（结果标题展示）
const retrieveHits = ref<Array<{ name: string; scope: string; score: number }>>([]);
const retrieveMinScore = ref(0.3);        // 阈值参考线（后端返回的系统默认）
const retrieving = ref(false);
const debugTool = ref('');
const debugSubject = ref('');
const debugArgs = ref('{}');
const debugMode = ref<'form' | 'json'>('form');
const debugParamValues = reactive<Record<string, any>>({});
const debugSamples = ref<Array<{ id: string; at: string; subject: string; args: Record<string, unknown> }>>([]);
const debugSampleId = ref('');
const debugAllowRisky = ref(false);
const debugLoading = ref(false);
const debugResult = ref<any | null>(null);

function fieldTitle(field: string, fallback: string): string {
  return schemaTitle(toolSchema.schema.value, field, fallback);
}
function fieldDesc(field: string, fallback = ''): string {
  return schemaDescription(toolSchema.schema.value, field, fallback);
}
function fieldRequired(field: string): boolean {
  return schemaRequired(toolSchema.required.value, field);
}

function authzProbeLabel(p: any): string {
  if (!p) return '未探测';
  if (p.status === 'pass') return '已拒绝越权';
  if (p.status === 'suspect') return '疑似未授权';
  if (p.status === 'inconclusive') return '无法判定';
  return '已跳过';
}
function authzProbeType(p: any): 'success' | 'danger' | 'warning' | 'info' {
  if (!p) return 'info';
  if (p.status === 'pass') return 'success';
  if (p.status === 'suspect') return 'danger';
  if (p.status === 'inconclusive') return 'warning';
  return 'info';
}
function authzProbeTitle(p: any): string {
  if (!p) return '尚未执行授权探针';
  const parts = [authzProbeLabel(p)];
  if (p.http) parts.push(`HTTP ${p.http}`);
  if (p.tool) parts.push(`工具 ${p.tool}`);
  if (p.reason) parts.push(p.reason);
  return parts.join(' · ');
}
function authzProbeMode(p: any): string {
  if (!p) return '尚未执行';
  if (p.mode === 'dedicated') return '专用探针端点';
  if (p.mode === 'fallback') return '回退到无参 GET 工具';
  return p.mode || '未知';
}
function authzProbeAdvice(p: any): string[] {
  if (!p) return [
    '保存、刷新工具源或点击“探针”后会执行检测。',
    '推荐在 spec 根声明 x-bailing-authz-probe，并挂独立探针端点。',
  ];
  if (p.status === 'pass') return [
    '当前探针结果符合预期：合成越权主体没有被放行。',
    p.mode === 'dedicated' ? '保持探针端点走真实权限表，不要写死授权通过。' : '建议后续补专用探针端点，减少回退探测的误判和 skipped。',
  ];
  if (p.status === 'suspect') return [
    '这是高风险信号：业务侧可能只做了验签，没有按 X-Bailing-On-Behalf-Of 做授权。',
    '检查工具接口或探针端点的 authorize 回调，禁止 return true 兜底。',
    '让不存在的主体 __bailing_authz_probe__:nobody 返回 401/403 或 {"authorized":false}。',
  ];
  if (p.status === 'inconclusive') return [
    '中枢已发出探针，但响应不足以判断授权是否 fail-closed。',
    '专用探针端点应返回 JSON：{"authorized":false} 或明确的 401/403。',
    '检查 path、base_url、网关 rewrite 与签名验签是否使用原始 path/query。',
  ];
  return [
    '当前没有可安全探测的端点。',
    '在 spec 根声明 x-bailing-authz-probe，例如 {"method":"POST","path":"/bailing/authz-probe"}。',
    '业务端使用 PHP、Node、Python、Java、Go、.NET SDK 的 authz probe helper 接入，或按同一 HTTP 验签与授权返回契约实现。',
  ];
}

function specSourceLabel(row: any): string {
  return row.spec_source === 'url' ? 'URL 托管' : '内联 JSON';
}

function refreshPolicyLabel(row: any): string {
  if (row.spec_source !== 'url') return '手动维护接口清单';
  const min = Number(row.auto_refresh_min || 0);
  return min > 0 ? `每 ${min} 分钟自动刷新` : '手动刷新';
}

function specRefreshedLabel(row: any): string {
  return row.spec_refreshed_at ? `最近刷新 ${fmtTime(row.spec_refreshed_at)}` : '尚未刷新';
}

function auditLabel(row: any): string {
  return row.log_payload ? '审计全量' : '只记键名';
}

function timeoutLabel(ms?: number): string {
  return ms ? `超时 ${Math.round(ms / 1000)}s` : '默认超时';
}

function rateLimitLabel(n?: number): string {
  return Number(n || 0) > 0 ? `${n}/min` : '不限流';
}

function authzProbeSummary(p: any): string {
  if (!p) return '保存、刷新或点击探针后检测业务授权是否 fail-closed';
  const at = p.at ? ` · ${fmtTime(p.at)}` : '';
  return `${authzProbeMode(p)}${at}`;
}

function openDocs(page: 'tools' | 'api' | 'approvals' = 'tools'): void {
  const paths: Record<typeof page, string> = {
    tools: '/docs/tools',
    api: '/docs/api',
    approvals: '/docs/approvals',
  };
  openDoc(paths[page]);
}

// 文本筛选：按 名称/路径/scope/描述 子串匹配（不分大小写）
const filteredTools = computed(() => {
  const q = previewFilter.value.trim().toLowerCase();
  if (!q) return previewTools.value;
  return previewTools.value.filter((t) => `${t.name} ${t.method} ${t.path} ${t.scope} ${t.description}`.toLowerCase().includes(q));
});
const selectedDebugTool = computed<any | null>(() => previewTools.value.find((t) => t.name === debugTool.value) || null);
const debugParamRows = computed(() => selectedDebugTool.value ? paramRows(selectedDebugTool.value) : []);
const debugSignatureRows = computed(() => {
  const m = debugResult.value?.request?.signature_material;
  if (!m) return [];
  return [
    { k: 'timestamp', v: m.timestamp },
    { k: 'method', v: m.method },
    { k: 'path_with_query', v: m.path_with_query },
    { k: 'body_sha256', v: m.body_sha256 },
    { k: 'on_behalf_of', v: m.on_behalf_of || '空串' },
    { k: 'job_id', v: m.job_id || '空串' },
  ];
});
const debugDiagnosis = computed(() => {
  const r = debugResult.value;
  if (!r) return '';
  if (r.blocked) return '调试台在发出 HTTP 前已阻断。本次不会触达业务系统。';
  const s = Number(r.response?.status || 0);
  if (!s) return '未收到 HTTP 状态。优先检查 Base URL、网络连通、DNS、TLS 证书和业务接口超时。';
  if (s === 400 || s === 422) return '业务侧认为参数不合法。优先核对参数位置、必填字段、枚举值和 body JSON 结构。';
  if (s === 401) return '业务侧认证失败。优先检查签名密钥、服务器时间、path/query 是否被网关重写，以及验签是否使用原始 URI。';
  if (s === 403) return '业务侧授权拒绝。签名可能已通过，但 On-Behalf-Of 主体没有权限，这是正确的 fail-closed 方向。';
  if (s === 404) return '业务侧未找到接口。优先检查 base_url 是否带了路径前缀、OpenAPI path 是否与实际路由一致。';
  if (s >= 500) return '业务侧服务异常。中枢签名和转发已完成，继续看业务服务日志。';
  return '';
});

// 语义召回预演：跑派发同款向量检索，返回工具+分数，让开发者看精度、调优工具措辞
async function runRetrieveTest(): Promise<void> {
  const q = retrieveQ.value.trim();
  if (!q) return;
  retrieving.value = true;
  try {
    const r = await api<{ enabled: boolean; min_score_default: number; hits: Array<{ name: string; scope: string; score: number }> }>(
      '/admin/api/tool-providers/' + encodeURIComponent(previewName.value) + '/retrieve-test', { method: 'POST', body: JSON.stringify({ query: q }) });
    retrieveMinScore.value = r.min_score_default ?? 0.3;
    retrieveHits.value = r.hits || [];
    lastRetrieveQ.value = q;
    if (!retrieveHits.value.length) ElMessage.info('没有召回（索引为空？先「重建索引」）');
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { retrieving.value = false; }
}

async function runDebugInvoke(): Promise<void> {
  if (!debugTool.value) { ElMessage.error('请选择工具'); return; }
  let args: Record<string, unknown> = {};
  try {
    args = debugMode.value === 'form' ? buildDebugArgsFromForm() : parseDebugJson();
  } catch (e) { ElMessage.error((e as Error).message); return; }
  debugLoading.value = true;
  try {
    debugResult.value = await api('/admin/api/tool-providers/' + encodeURIComponent(previewName.value) + '/debug-invoke', {
      method: 'POST',
      body: JSON.stringify({
        tool: debugTool.value,
        args,
        on_behalf_of: debugSubject.value.trim(),
        allow_risky: debugAllowRisky.value,
      }),
    });
    saveDebugSample(args);
    if (debugResult.value.blocked) ElMessage.warning('调用已被调试台阻断');
    else if (debugResult.value.ok) ElMessage.success('工具调用成功');
    else ElMessage.warning('工具调用返回失败状态');
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { debugLoading.value = false; }
}

function parseDebugJson(): Record<string, unknown> {
  const raw = debugArgs.value.trim();
  const args = raw ? JSON.parse(raw) : {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象');
  return args as Record<string, unknown>;
}

function buildDebugArgsFromForm(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of debugParamRows.value) {
    const raw = debugParamValues[p.name];
    if (raw === undefined || raw === null || raw === '') continue;
    if (p.type === 'integer') {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`${p.name} 必须是整数`);
      out[p.name] = n;
    } else if (p.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${p.name} 必须是数字`);
      out[p.name] = n;
    } else if (p.type === 'boolean') {
      out[p.name] = raw === true || raw === 'true';
    } else if (p.type === 'array' || p.type === 'object') {
      try { out[p.name] = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { throw new Error(`${p.name} 必须是合法 ${p.type === 'array' ? '数组' : '对象'} JSON`); }
    } else {
      out[p.name] = String(raw);
    }
  }
  debugArgs.value = JSON.stringify(out, null, 2);
  return out;
}

function syncDebugJsonFromForm(): void {
  try {
    const args = buildDebugArgsFromForm();
    debugArgs.value = JSON.stringify(args, null, 2);
    debugMode.value = 'json';
  } catch (e) { ElMessage.error((e as Error).message); }
}

function debugStorageKey(): string {
  return `bailing.tool-debug.${previewName.value}.${debugTool.value}`;
}

function loadDebugSamples(): void {
  debugSampleId.value = '';
  try {
    const raw = localStorage.getItem(debugStorageKey());
    const arr = raw ? JSON.parse(raw) : [];
    debugSamples.value = Array.isArray(arr) ? arr.slice(0, 5) : [];
  } catch {
    debugSamples.value = [];
  }
}

function saveDebugSample(args: Record<string, unknown>): void {
  const sample = { id: `${Date.now()}`, at: new Date().toISOString(), subject: debugSubject.value.trim(), args };
  const same = (x: any) => x.subject === sample.subject && JSON.stringify(x.args) === JSON.stringify(args);
  const next = [sample, ...debugSamples.value.filter((x) => !same(x))].slice(0, 5);
  debugSamples.value = next;
  localStorage.setItem(debugStorageKey(), JSON.stringify(next));
}

function applyDebugSampleById(id: string): void {
  const sample = debugSamples.value.find((x) => x.id === id);
  if (!sample) return;
  debugSubject.value = sample.subject || '';
  debugArgs.value = JSON.stringify(sample.args || {}, null, 2);
  applyDebugArgsToForm(sample.args || {});
}

function applyDebugArgsToForm(args: Record<string, unknown>): void {
  for (const k of Object.keys(debugParamValues)) delete debugParamValues[k];
  for (const p of debugParamRows.value) {
    const v = args[p.name];
    if (v === undefined || v === null) debugParamValues[p.name] = '';
    else if (typeof v === 'object') debugParamValues[p.name] = JSON.stringify(v);
    else debugParamValues[p.name] = String(v);
  }
}

function resetDebugForTool(): void {
  debugResult.value = null;
  debugAllowRisky.value = false;
  loadDebugSamples();
  if (debugSamples.value[0]) {
    debugSampleId.value = debugSamples.value[0].id;
    applyDebugSampleById(debugSampleId.value);
  } else {
    debugArgs.value = '{}';
    debugSubject.value = '';
    applyDebugArgsToForm({});
  }
}

function debugSampleLabel(sample: { at: string; subject: string; args: Record<string, unknown> }): string {
  const keys = Object.keys(sample.args || {}).slice(0, 3).join(', ') || '无参数';
  return `${sample.subject || '匿名'} · ${keys} · ${fmtTime(sample.at, true)}`;
}

/** 展开行的参数表：从派生后的 JSON Schema + param_in 还原成人能核对的行 */
function paramRows(t: any): Array<{ name: string; loc: string; type: string; required: boolean; desc: string; enum?: unknown[] }> {
  const props = (t.parameters?.properties ?? {}) as Record<string, any>;
  const required = new Set<string>((t.parameters?.required ?? []) as string[]);
  return Object.entries(props).map(([name, s]) => {
    const bits: string[] = [];
    if (s.description) bits.push(String(s.description));
    if (Array.isArray(s.enum)) bits.push('枚举：' + s.enum.join(' / '));
    if (s.default !== undefined) bits.push('默认：' + JSON.stringify(s.default));
    if (s.format) bits.push('格式：' + s.format);
    const type = String(s.type ?? 'string') + (s.type === 'array' && s.items?.type ? `<${s.items.type}>` : '');
    return { name, loc: t.param_in?.[name] ?? 'query', type: String(s.type ?? 'string'), required: required.has(name), desc: bits.join('；'), enum: Array.isArray(s.enum) ? s.enum : undefined };
  });
}

// 取回完整签名密钥并复制（列表只给掩码；这把密钥要交给业务方验签，需随时可取）
async function copySecret(name: string): Promise<void> {
  try {
    const r = await api<{ secret: string }>(`/admin/api/tool-providers/${encodeURIComponent(name)}/secret`);
    await navigator.clipboard.writeText(r.secret);
    ElMessage.success('完整签名密钥已复制到剪贴板');
  } catch (e) { ElMessage.error((e as Error).message || '取密钥失败'); }
}

async function load(): Promise<void> {
  list.value = await api('/admin/api/tool-providers');
  // 向量化凭证（工具检索选坐标系用）；无权限/失败不阻塞页面
  try { embCreds.value = (await api<any[]>('/admin/api/credentials')).filter((c) => c.kind === 'embedding' || c.kind === 'both'); } catch { /* 可选 */ }
}
async function reindex(name: string): Promise<void> {
  reindexing.value = name;
  try {
    const r = await api<{ total: number; added: string[]; changed: string[]; removed: string[] }>('/admin/api/tool-providers/' + encodeURIComponent(name) + '/reindex', { method: 'POST' });
    ElMessage.success(`索引已重建：共 ${r.total} 个工具（新增 ${r.added.length}、变更 ${r.changed.length}、移除 ${r.removed.length}）`);
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { reindexing.value = ''; }
}
async function probeAuthz(name: string): Promise<void> {
  probing.value = name;
  try {
    const r = await api<{ authz_probe: any }>('/admin/api/tool-providers/' + encodeURIComponent(name) + '/authz-probe', { method: 'POST' });
    if (authzProbeType(r.authz_probe) === 'danger') ElMessage.warning(`授权探针：${authzProbeLabel(r.authz_probe)}`);
    else ElMessage.success(`授权探针：${authzProbeLabel(r.authz_probe)}`);
    await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { probing.value = ''; }
}
function openCreate(): void {
  editing.value = false;
  toolFormTab.value = 'basic';
  Object.assign(form, { name: '', base_url: '', secret: '', spec_source: 'inline', spec_url: '', spec_json: '', log_payload: true, timeout_ms: 10000, rate_limit_per_min: 120, auto_refresh_min: 0, description: '', enabled: true, embed_credential: '', embed_model: '', embed_dim: 1024 });
  open.value = true;
}
function openEdit(row: any): void {
  editing.value = true;
  toolFormTab.value = 'basic';
  Object.assign(form, { name: row.name, base_url: row.base_url, secret: '', spec_source: row.spec_source, spec_url: row.spec_url || '', spec_json: '', log_payload: !!row.log_payload, timeout_ms: row.timeout_ms, rate_limit_per_min: row.rate_limit_per_min, auto_refresh_min: row.auto_refresh_min ?? 0, description: row.description || '', enabled: !!row.enabled, embed_credential: row.embed_credential || '', embed_model: row.embed_model || '', embed_dim: row.embed_dim || 1024 });
  open.value = true;
}
function onEmbedCred(): void {
  // 选了向量凭证、模型还空 → 用该凭证的默认模型兜上（用户可改）
  if (!form.embed_credential) return;
  const c = embCreds.value.find((x) => x.name === form.embed_credential);
  if (c && !form.embed_model) form.embed_model = c.default_model || '';
}
function genSecret(): void {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  form.secret = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function save(): Promise<void> {
  saving.value = true;
  try {
    await api('/admin/api/tool-providers', { method: 'POST', body: JSON.stringify(form) });
    ElMessage.success('已保存（密钥不再回显完整值）'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function refresh(name: string): Promise<void> {
  refreshing.value = name;
  try {
    const r = await api<{ tools: number }>('/admin/api/tool-providers/' + encodeURIComponent(name) + '/refresh', { method: 'POST' });
    ElMessage.success(`已刷新，派生出 ${r.tools} 个工具`); await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { refreshing.value = ''; }
}
async function preview(row: any): Promise<void> {
  previewName.value = row.name;
  previewEmbed.value = !!row.embed_credential;
  previewFilter.value = ''; retrieveQ.value = ''; lastRetrieveQ.value = ''; retrieveHits.value = [];
  debugTool.value = ''; debugSubject.value = ''; debugArgs.value = '{}'; debugAllowRisky.value = false; debugResult.value = null; debugSamples.value = []; debugSampleId.value = '';
  previewWarnings.value = []; previewSkipped.value = []; previewTools.value = [];
  try {
    const r = await api<any>('/admin/api/tool-providers/' + encodeURIComponent(row.name) + '/tools');
    previewTools.value = r.tools || [];
    previewSkipped.value = r.skipped || [];
    previewWarnings.value = r.warnings || [];
    previewNote.value = r.note || '';
    previewOpen.value = true;
    debugTool.value = previewTools.value[0]?.name || '';
    resetDebugForTool();
  } catch (e) { ElMessage.error((e as Error).message); }
}
async function del(name: string): Promise<void> {
  try { await api('/admin/api/tool-providers/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(async () => {
  await Promise.all([toolSchema.load().catch(() => undefined), load()]);
});
watch(debugTool, () => resetDebugForTool());
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.hint { margin-top: 4px; line-height: 1.5; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.tool-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; line-height: 1.35; }
.tool-main b { font-size: 13px; color: var(--el-text-color-primary); }
.tool-main code { font-family: var(--bz-mono); font-size: 12px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-stack { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-width: 0; line-height: 1.35; }
.tagline { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.probe-line, .secret-line { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.probe-line .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.secret-line code { font-family: var(--bz-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
.search-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.debug-call { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin-bottom: 12px; background: var(--el-fill-color-blank); }
.debug-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.debug-mode { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.debug-param-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
.debug-param { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px; min-width: 0; background: var(--el-fill-color-light); }
.debug-param-label { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; min-width: 0; }
.debug-param-label code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.debug-param-desc { margin-top: 4px; line-height: 1.45; }
.debug-empty { grid-column: 1 / -1; padding: 8px 0; }
.debug-json { margin-top: 8px; }
.debug-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.debug-result { margin-top: 10px; }
.debug-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.debug-diagnosis { border: 1px solid var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); border-radius: 0; padding: 8px 10px; font-size: 12px; line-height: 1.6; margin-bottom: 8px; }
.signature-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; }
.signature-grid > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 6px 8px; min-width: 0; background: var(--el-fill-color-light); }
.signature-grid span, .signature-grid code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.signature-grid span { color: var(--el-text-color-secondary); font-size: 12px; margin-bottom: 2px; }
.signature-grid code { font-family: var(--bz-mono); font-size: 12px; }
.retrieve-result { background: var(--el-fill-color-light); border-radius: 0; padding: 10px 12px; margin-bottom: 12px; }
.retrieve-result .rh-list { max-height: 280px; overflow: auto; }
.retrieve-result .rh-row { display: flex; align-items: center; padding: 2px 0; line-height: 1.8; }
.retrieve-result .rh-row.below { opacity: 0.6; }
.skipped { padding: 4px 8px; border-radius: 0; background: var(--el-fill-color-light); margin-bottom: 4px; font-size: 12px; }
.warning-row { display: flex; gap: 8px; align-items: flex-start; padding: 4px 8px; border-radius: 0; background: var(--el-color-warning-light-9); margin-bottom: 4px; font-size: 12px; }
.warning-row code { flex: 0 0 auto; font-family: var(--bz-mono); color: var(--el-color-warning-dark-2); }.tool-detail { padding: 4px 12px 10px 48px; }
.tool-detail .td-sec { font-weight: 600; font-size: 12px; margin: 10px 0 4px; color: var(--el-text-color-regular); }
.tool-detail .td-text { font-size: 12px; line-height: 1.7; color: var(--el-text-color-primary); white-space: pre-wrap; word-break: break-word; }
.probe-popover { font-size: 12px; line-height: 1.65; }
.probe-title { font-weight: 600; margin-bottom: 6px; }
.probe-meta { display: flex; flex-direction: column; gap: 2px; color: var(--el-text-color-secondary); margin-bottom: 8px; }
.probe-meta code { font-family: var(--bz-mono); }
.probe-advice-title { font-weight: 600; margin: 8px 0 4px; }
.probe-advice { margin: 0; padding-left: 18px; }
.probe-advice li { margin: 2px 0; }
.block { font-family: var(--bz-mono); font-size: 12px; line-height: 1.6; background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 0; overflow-x: auto; white-space: pre; margin: 0 0 6px; }
.steps { margin: 0 0 10px; padding-left: 18px; }
.steps li { line-height: 1.8; font-size: 13px; }
@media (max-width: 760px) {
  .debug-param-grid, .signature-grid { grid-template-columns: 1fr; }
}
</style>
