<template>
  <el-card shadow="never">
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span><b>任务</b> <HelpTip title="任务页是什么">
            <p>「<b>会话</b>」把平铺的任务还原成「一个人一条对话」，看完整上下文与逐轮执行轨迹。</p>
            <p>「<b>调度流</b>」按时间倒序审计<b>每一次派发</b>，点行看任务全详情（输入 / 组装上下文 / 工具 / 回复）。</p>
            <p>「<b>追溯</b>」按 job_id、request_id、client_id、thread_id 或 principal_id 查单次任务完整生命周期，用于接入排障和审批/送达/工具调用对账。</p>
          </HelpTip></span>
        <el-button :loading="loading || threadsLoading" @click="refresh">刷新</el-button>
      </div>
    </template>

    <el-tabs v-model="activeTab" @tab-change="onTab">
      <!-- ============ 会话视图：把平铺的 job 还原成「一个人一条对话」（收件箱式主从） ============ -->
      <el-tab-pane name="threads">
        <template #label><span><el-icon style="vertical-align:-2px"><ChatLineRound /></el-icon> 会话</span></template>
        <div class="convo">
          <!-- 左：会话列表 -->
          <div class="rail">
            <el-input v-model="threadQ" size="default" placeholder="搜会话：身份 / 接入方 / 内容 / 路由" clearable class="railsearch">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <div v-loading="threadsLoading" class="raillist">
              <el-empty v-if="!threadsLoading && !filteredThreads.length" :image-size="56"
                :description="threadQ ? '没有匹配的会话' : '还没有会话：业务/聊天接入后这里会出现'" />
              <div v-for="t in filteredThreads" :key="t.thread_id" class="threaditem"
                :class="{ active: curThread === t.thread_id }" @click="openThread(t.thread_id)">
                <div class="trow1">
                  <el-tag v-if="partyVisible(t)" size="small" effect="plain" :type="partyType(t)">{{ partyLabel(t) }}</el-tag>
                  <span class="who mono" :title="identityTitle(t)">{{ whoLabel(t) }}</span>
                  <span class="tcount muted">{{ t.message_count }}轮</span>
                </div>
                <div class="tprev muted">{{ t.last_preview || '（无内容）' }}</div>
                <div class="tmeta muted"><span class="mono">{{ t.route_name }}</span> · {{ fmtTime(t.last_active_at, true) }}</div>
              </div>
              <div v-if="threadsMore" class="loadmore"><el-button link :loading="threadsMoreLoading" @click="loadMoreThreads">加载更多会话</el-button></div>
            </div>
          </div>

          <!-- 右：完整对话（聊天记录）+ 逐轮执行轨迹 -->
          <div ref="paneRef" class="pane" v-loading="threadDataLoading">
            <el-empty v-if="!threadData && !threadDataLoading" :image-size="90" description="选择左侧一条会话，查看完整对话与逐轮执行轨迹" />
            <template v-if="threadData">
              <div class="paneHead">
                <div class="ph1">
                  <el-tag v-if="partyVisible(threadData.thread)" size="small" effect="plain" :type="partyType(threadData.thread)">{{ partyLabel(threadData.thread) }}</el-tag>
                  <b class="mono" :title="identityTitle(threadData.thread)">{{ whoLabel(threadData.thread) }}</b>
                  <el-tag size="small" effect="plain" type="info" class="mono">{{ threadData.thread.route_name }}</el-tag>
                  <span class="muted">{{ threadData.thread.message_count }}轮 · 最近 {{ fmtTime(threadData.thread.last_active_at, true) }}</span>
                </div>
                <div class="ph2 muted mono" :title="threadData.thread.scope_key">scope: {{ threadData.thread.scope_key }}</div>
              </div>
              <el-collapse v-if="threadData.thread.summary" class="coll summcoll">
                <el-collapse-item title="记忆层滚动摘要（更早的对话已折叠进这里，装配上下文时注入）">
                  <pre class="block">{{ cap(threadData.thread.summary) }}</pre>
                </el-collapse-item>
              </el-collapse>

              <div class="chat">
                <div v-for="m in threadData.messages" :key="m.id" class="turn" :class="m.direction === 'in' ? 'fromUser' : 'fromHub'">
                  <div class="bubbleWrap">
                    <div class="bMeta muted">{{ m.direction === 'in' ? whoLabel(threadData.thread) : '中枢' }} · {{ fmtTime(m.created_at, true) }}</div>
                    <div class="bubble"><RichText :text="m.content" /></div>
                    <!-- AI 轮次：可折叠的执行轨迹（懒拉该 job 的详情+审计，复用 /runs/:job 接口） -->
                    <div v-if="m.direction === 'out' && m.job_id" class="traceLine">
                      <span class="tracetoggle" @click="toggleTrace(m.job_id)">
                        <svg class="traceCaret" :class="{ open: traces[m.job_id]?.open }" viewBox="0 0 1024 1024" aria-hidden="true">
                          <path d="M0.085333 239.36L512 784.64l511.914667-545.28z" fill="currentColor"></path>
                        </svg>
                        执行轨迹
                        <span v-if="traceBadge(m.job_id)" class="muted">{{ traceBadge(m.job_id) }}</span>
                      </span>
                      <div v-if="traces[m.job_id]?.open" class="tracebox" v-loading="traces[m.job_id]?.loading">
                        <template v-if="traces[m.job_id]?.detail">
                          <div class="tmeta2">
                            <el-tag size="small" :type="statusType(traces[m.job_id].detail.status)" effect="plain">{{ traces[m.job_id].detail.status }}</el-tag>
                            <span v-if="traceModel(m.job_id)" class="mono muted">{{ traceModel(m.job_id) }}</span>
                            <span v-if="traces[m.job_id].detail.usage?.duration_ms" class="muted">{{ (traces[m.job_id].detail.usage.duration_ms / 1000).toFixed(1) }}s</span>
                            <span v-if="traces[m.job_id].detail.usage?.tokens" class="muted">{{ traces[m.job_id].detail.usage.tokens }} tok</span>
                          </div>
                          <div class="muted toolsum">{{ fmtTools(traces[m.job_id].detail?.dispatch?.tools) }}</div>
                          <el-timeline v-if="traces[m.job_id].events?.length" class="tline">
                            <el-timeline-item v-for="(a, i) in traces[m.job_id].events" :key="i" :timestamp="fmtTime(a.ts)" placement="top">
                              <b>{{ traceTitle(a) }}</b>
                              <el-tag size="small" effect="plain" :type="traceStageType(a.stage)" class="traceStage">{{ traceStageLabel(a.stage) }}</el-tag>
                              <el-tag v-if="a.severity && a.severity !== 'info'" size="small" effect="plain" :type="traceSeverityType(a.severity)" class="traceSeverity">{{ a.severity }}</el-tag>
                              <span v-if="traceSummaryText(a)" class="muted auditTag">{{ traceSummaryText(a) }}</span>
                              <template v-if="detailLen(a.detail)">
                                <el-collapse v-if="detailLen(a.detail) > 160" class="auditcoll">
                                  <el-collapse-item :title="shortDetail(a.detail)"><pre class="block">{{ fullDetail(a.detail) }}</pre></el-collapse-item>
                                </el-collapse>
                                <div v-else class="muted detail-json">{{ shortDetail(a.detail) }}</div>
                              </template>
                            </el-timeline-item>
                          </el-timeline>
                          <div v-else class="muted notrace">这一轮没有工具调用（纯生成回复）</div>
                          <el-button plain type="primary" size="small" class="traceDetailBtn" @click="openDetail({ job_id: m.job_id })">查看完整详情</el-button>
                        </template>
                        <div v-else-if="!traces[m.job_id]?.loading" class="muted">该轮详情已不可用（job 可能已清理）</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </el-tab-pane>

      <!-- ============ 调度流：原有平铺列表，按时间审计每一次派发 ============ -->
      <el-tab-pane name="runs">
        <template #label><span><el-icon style="vertical-align:-2px"><List /></el-icon> 调度流</span></template>
        <el-empty v-if="!list.length && !loading" description="还没有任务：业务系统接入后，触发记录会出现在这里" />
        <el-table v-else :data="list" v-loading="loading" @row-click="openDetail" style="cursor: pointer">
          <el-table-column label="时间" width="130">
            <template #default="{ row }"><span class="muted">{{ fmtTime(row.created_at, true) }}</span></template>
          </el-table-column>
          <el-table-column label="调度目标" width="120">
            <template #default="{ row }"><el-tag effect="plain" type="info">{{ row.target }}</el-tag></template>
          </el-table-column>
          <el-table-column label="触发方" min-width="150">
            <template #default="{ row }">
              <span v-if="row.client_app_id" class="mono">{{ row.client_app_id }}</span>
              <template v-else-if="String(row.source || '').startsWith('chat:')">
                <el-tag size="small" effect="plain" type="warning" :title="row.source">{{ String(row.source).slice(5, 17) }}…</el-tag>
                <div class="muted mono">{{ row.visitor_uid || '匿名访客' }}{{ row.thread_id ? ' · ' + row.thread_id : '' }}</div>
              </template>
              <el-tag v-else-if="row.source === 'delivery'" size="small" effect="plain" type="info">送达子任务</el-tag>
              <span v-else class="mono">admin</span>
            </template>
          </el-table-column>
          <el-table-column label="输入" min-width="200">
            <template #default="{ row }">
              <div>{{ row.project || '-' }}</div>
              <div class="muted ellipsis">{{ row.input_preview }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" effect="plain">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="severity" label="级别" width="90" />
          <el-table-column prop="summary" label="结果摘要" min-width="240" show-overflow-tooltip />
        </el-table>
        <div v-if="runsMore" class="loadmore"><el-button :loading="moreLoading" @click="loadMoreRuns">加载更多</el-button></div>
        <div v-else-if="list.length" class="loadmore muted">— 已到底（共 {{ list.length }} 条）—</div>
      </el-tab-pane>

      <!-- ============ 单 Job 追溯：开发者排障入口，job_id → 生命周期全链 ============ -->
      <el-tab-pane name="trace">
        <template #label><span><el-icon style="vertical-align:-2px"><Search /></el-icon> 追溯</span></template>
        <div class="traceLookup">
        <el-input v-model="traceJobInput" size="default" class="mono" clearable placeholder="job_id / request_id / client:crm / thread:123 / principal:u-1" @keyup.enter="lookupJobTrace">
            <template #append><el-button :loading="traceLookupLoading" @click="lookupJobTrace">追溯</el-button></template>
          </el-input>
        </div>
        <el-empty v-if="!traceLookupResult && !traceLookupLoading && !traceLookupMatches.length" description="输入 job_id、request_id 或 client/thread/principal 查询一次任务" />
        <el-table v-if="!traceLookupResult && traceLookupMatches.length" :data="traceLookupMatches" size="small" class="traceMatches" @row-click="openTraceMatch">
          <el-table-column label="时间" width="130"><template #default="{ row }">{{ fmtTime(row.created_at, true) }}</template></el-table-column>
          <el-table-column prop="request_id" label="request_id" min-width="180" show-overflow-tooltip />
          <el-table-column prop="client_app_id" label="接入方" width="120" />
          <el-table-column prop="route_key" label="路由" width="140" show-overflow-tooltip />
          <el-table-column prop="status" label="状态" width="90"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ row.status }}</el-tag></template></el-table-column>
          <el-table-column prop="input_preview" label="输入" min-width="220" show-overflow-tooltip />
        </el-table>
        <div v-if="traceLookupResult" v-loading="traceLookupLoading" class="tracePanel">
          <div class="traceHead">
            <div>
              <b class="mono">{{ traceLookupJob.job_id }}</b>
              <div class="muted mono">request: {{ traceLookupJob.request_id || '—' }}</div>
            </div>
            <div class="traceHeadTags">
              <el-tag :type="statusType(traceLookupJob.status)" effect="plain">{{ traceLookupJob.status }}</el-tag>
              <el-tag effect="plain" type="info">{{ traceLookupJob.target }}</el-tag>
              <el-tag v-if="traceLookupJob.client_app_id" effect="plain" type="success">{{ traceLookupJob.client_app_id }}</el-tag>
              <el-tag v-if="traceLookupSummary.error_count" effect="plain" type="danger">{{ traceLookupSummary.error_count }} 错误</el-tag>
              <el-tag v-if="traceLookupSummary.warning_count" effect="plain" type="warning">{{ traceLookupSummary.warning_count }} 警告</el-tag>
            </div>
          </div>
          <div class="traceStats">
            <div><span class="muted">创建时间</span><b>{{ fmtTime(traceLookupJob.created_at, true) }}</b></div>
            <div><span class="muted">工具调用</span><b>{{ traceLookupSummary.tool_results ?? 0 }}</b></div>
            <div><span class="muted">识图</span><b>{{ traceLookupSummary.perceptions ?? 0 }}</b></div>
            <div><span class="muted">耗时</span><b>{{ traceLookupJob.usage?.duration_ms ? (traceLookupJob.usage.duration_ms / 1000).toFixed(1) + 's' : '—' }}</b></div>
            <div><span class="muted">Tokens</span><b>{{ traceLookupJob.usage?.tokens ?? '—' }}</b></div>
          </div>
          <div class="sec">生命周期时间线 <span class="muted">{{ traceLookupEvents.length }} 步</span></div>
          <el-timeline style="padding-left: 4px">
            <el-timeline-item v-for="(a, i) in traceLookupEvents" :key="i" :timestamp="fmtTime(a.ts)" placement="top">
              <b>{{ traceTitle(a) }}</b>
              <el-tag size="small" effect="plain" :type="traceStageType(a.stage)" class="traceStage">{{ traceStageLabel(a.stage) }}</el-tag>
              <el-tag v-if="a.severity && a.severity !== 'info'" size="small" effect="plain" :type="traceSeverityType(a.severity)" class="traceSeverity">{{ a.severity }}</el-tag>
              <span v-if="traceSummaryText(a)" class="muted auditTag">{{ traceSummaryText(a) }}</span>
              <template v-if="detailLen(a.detail)">
                <el-collapse v-if="detailLen(a.detail) > 160" class="auditcoll">
                  <el-collapse-item :title="shortDetail(a.detail)"><pre class="block">{{ fullDetail(a.detail) }}</pre></el-collapse-item>
                </el-collapse>
                <div v-else class="muted detail-json">{{ shortDetail(a.detail) }}</div>
              </template>
            </el-timeline-item>
          </el-timeline>
          <div class="traceActions">
            <el-button type="primary" plain @click="openTraceLookupDetail">打开完整详情</el-button>
            <el-button plain :disabled="!traceDebugBundle" @click="downloadTraceDebugBundle">下载脱敏排障包</el-button>
            <el-button plain :disabled="!traceDebugBundle" @click="copyTraceDebugBundle">复制脱敏 JSON</el-button>
            <el-button plain :disabled="!traceDebugReport" @click="downloadTraceDebugReport">下载排障报告</el-button>
            <el-button plain :disabled="!traceDebugReport" @click="copyTraceDebugReport">复制报告</el-button>
            <HelpTip title="脱敏排障包">
              <p>排障包只导出 <code>debug_bundle</code>，不是原始 job/trace。</p>
              <p>导出内容已按服务端统一规则遮蔽凭证、令牌、密钥和常见个人信息。</p>
            </HelpTip>
          </div>
          <el-collapse v-if="traceDebugBundle" class="coll debugBundle">
            <el-collapse-item title="排障包摘要">
              <div class="redactionBar">
                <el-tag size="small" effect="plain" :type="traceRedaction.applied ? 'success' : 'warning'">{{ traceRedaction.applied ? '已脱敏' : '未声明脱敏' }}</el-tag>
                <span class="muted">规则：{{ traceRedaction.rules?.join(' / ') || '—' }}</span>
              </div>
              <div v-if="traceDiagnosis.length" class="diagnosisList">
                <div v-for="d in traceDiagnosis" :key="d.code" class="diagnosisItem" :class="d.severity">
                  <el-tag size="small" effect="plain" :type="diagnosisType(d.severity)">{{ diagnosisLabel(d.severity) }}</el-tag>
                  <b>{{ d.title }}</b>
                  <span class="muted">{{ d.detail }}</span>
                  <span v-if="d.next_action" class="muted action">{{ d.next_action }}</span>
                </div>
              </div>
              <div class="debugGrid">
                <div><span class="muted">route</span><b class="mono">{{ traceDebugBundle.identifiers?.route_key || '—' }}</b></div>
                <div><span class="muted">接入方</span><b class="mono">{{ traceDebugBundle.identifiers?.client_app_id || '—' }}</b></div>
                <div><span class="muted">死信</span><b>{{ traceDebugBundle.counts?.delivery_dlq ?? 0 }}</b></div>
                <div><span class="muted">审批</span><b>{{ traceDebugBundle.counts?.approvals ?? 0 }}</b></div>
              </div>
              <pre class="block sm">{{ cap(JSON.stringify(traceDebugBundle, null, 2)) }}</pre>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-drawer v-model="detailOpen" size="min(920px, 92vw)" class="runDetailDrawer" :title="'任务详情 · ' + (detail?.request_id || detail?.job_id || '')">
    <template v-if="detail">
      <div class="detailHero">
        <div class="detailHeroMain">
          <div class="detailTags">
            <el-tag :type="statusType(detail.status)" effect="plain">{{ detail.status }}</el-tag>
            <el-tag effect="plain" type="info">{{ detail.target }}</el-tag>
            <el-tag v-if="detail.client_app_id" effect="plain" type="success">{{ detail.client_app_id }}</el-tag>
            <el-tag v-if="detail.attempts" effect="plain" type="warning">重试 {{ detail.attempts }}</el-tag>
            <el-tag v-if="detailWarningCount" effect="plain" type="warning">{{ detailWarningCount }} 警告</el-tag>
            <el-tag v-if="detailErrorCount" effect="plain" type="danger">{{ detailErrorCount }} 错误</el-tag>
          </div>
          <div class="detailTitle">{{ detail.project || detail.route_name || '单次任务' }}</div>
          <div class="detailIds">
            <span class="mono">job: {{ detail.job_id || '—' }}</span>
            <span class="mono">request: {{ detail.request_id || '—' }}</span>
            <span v-if="detail.thread_id" class="mono">thread: {{ detail.thread_id }}</span>
          </div>
        </div>
        <div class="detailActions">
          <el-button v-if="detail.thread_id" plain size="small" @click="gotoThread(detail.thread_id)">完整会话</el-button>
          <el-popconfirm v-if="canRerun" title="重跑该任务？将复用原始输入与参数重新执行。" width="260" @confirm="rerun">
            <template #reference><el-button type="primary" size="small">重跑</el-button></template>
          </el-popconfirm>
        </div>
      </div>
      <el-alert v-if="detail.error" :title="detail.error" type="error" :closable="false" style="margin-bottom: 12px" />

      <div class="detailStats">
        <div v-for="s in detailStats" :key="s.label">
          <span class="muted">{{ s.label }}</span>
          <b :class="s.strong ? s.strong : ''">{{ s.value }}</b>
        </div>
      </div>

      <div v-if="detailCriticalEvents.length" class="detailProblemList">
        <div v-for="(a, i) in detailCriticalEvents" :key="i" class="detailProblem" :class="a.severity">
          <el-tag size="small" effect="plain" :type="traceSeverityType(a.severity)">{{ a.severity === 'error' ? '错误' : '警告' }}</el-tag>
          <b>{{ traceTitle(a) }}</b>
          <span v-if="traceSummaryText(a)" class="muted">{{ traceSummaryText(a) }}</span>
          <span class="muted mono">{{ fmtTime(a.ts, true) }}</span>
        </div>
      </div>

      <el-collapse v-model="detailPanels" class="detailSections">
        <el-collapse-item name="chain">
          <template #title>
            <div class="detailSectionTitle">
              <b>完整链路</b>
              <span class="muted">{{ detailTraceCount }} 步 · 按入口、上下文、执行、送达归组</span>
            </div>
          </template>
          <div class="chainGroups">
            <div v-for="g in detailTraceGroups" :key="g.key" class="chainGroup">
              <div class="chainGroupHead">
                <div>
                  <b>{{ g.label }}</b>
                  <span class="muted">{{ g.hint }}</span>
                </div>
                <div class="chainGroupTags">
                  <el-tag size="small" effect="plain" :type="detailGroupType(g)">{{ g.events.length }} 步</el-tag>
                  <el-tag v-if="g.errorCount" size="small" effect="plain" type="danger">{{ g.errorCount }} 错误</el-tag>
                  <el-tag v-if="g.warningCount" size="small" effect="plain" type="warning">{{ g.warningCount }} 警告</el-tag>
                </div>
              </div>
              <el-timeline v-if="g.events.length" class="detailTimeline">
                <el-timeline-item v-for="(a, i) in g.events" :key="g.key + i" :timestamp="fmtTime(a.ts)" placement="top">
                  <div class="traceEventHead">
                    <b>{{ traceTitle(a) }}</b>
                    <el-tag size="small" effect="plain" :type="traceStageType(a.stage)" class="traceStage">{{ traceStageLabel(a.stage) }}</el-tag>
                    <el-tag v-if="a.severity && a.severity !== 'info'" size="small" effect="plain" :type="traceSeverityType(a.severity)" class="traceSeverity">{{ a.severity }}</el-tag>
                  </div>
                  <div v-if="traceSummaryText(a)" class="muted traceEventSummary">{{ traceSummaryText(a) }}</div>
                  <template v-if="detailLen(a.detail)">
                    <el-collapse v-if="detailLen(a.detail) > 160" class="auditcoll">
                      <el-collapse-item :title="shortDetail(a.detail)">
                        <pre class="block">{{ fullDetail(a.detail) }}</pre>
                      </el-collapse-item>
                    </el-collapse>
                    <div v-else class="muted detail-json">{{ shortDetail(a.detail) }}</div>
                  </template>
                </el-timeline-item>
              </el-timeline>
              <div v-else class="muted emptyChain">该阶段没有记录</div>
            </div>
          </div>
        </el-collapse-item>

        <el-collapse-item name="context">
          <template #title>
            <div class="detailSectionTitle">
              <b>输入与上下文</b>
              <span class="muted">{{ inputParty.label }}、页面、知识、工具、模型请求</span>
            </div>
          </template>
          <div class="detailSubhead">{{ inputParty.label }} <span class="muted">{{ inputParty.sub }} · 原始触发内容，未装配</span></div>
          <div class="richbox compact"><RichText :text="rawInput" /></div>
          <div v-if="pageCtx" class="pagectx">
            <span class="muted">发起页面：</span>
            <b v-if="pageCtx.page_name">{{ pageCtx.page_name }}</b>
            <span v-if="pageCtx.page_key" class="mono muted">（{{ pageCtx.page_key }}）</span>
            <el-tag size="small" :type="pageCtx.matched ? 'success' : 'info'" effect="plain">{{ pageCtx.matched ? '已匹配登记' : '未匹配·仅路径' }}</el-tag>
            <code class="mono path">{{ pageCtx.url || '—' }}</code>
            <span v-if="pageCtx.title" class="muted">· {{ pageCtx.title }}</span>
          </div>

          <div class="detailContextGrid">
            <div>
              <div class="detailSubhead">知识检索 <span class="muted">{{ kbRefs.length }} 条命中</span></div>
              <div v-if="kbRefs.length" class="kb">
                <div v-for="r in kbRefs" :key="r.seq" class="kbitem">
                  <div><b>[{{ r.seq }}] {{ r.title }}</b> <span class="muted">相关度 {{ Number(r.score || 0).toFixed(3) }}</span></div>
                  <div class="muted snip">{{ r.snippet }}</div>
                </div>
              </div>
              <div v-else class="muted nokb">未注入知识</div>
            </div>
            <div>
              <div class="detailSubhead">工具注入 <span class="muted">本次实际暴露给模型的工具</span></div>
              <div class="muted toolsum">{{ toolsSummary }}</div>
              <div v-if="llmReq" class="toolinject">
                <el-tag size="small" :type="toolModeType" effect="plain">{{ toolModeLabel }}</el-tag>
                <span class="muted" style="margin-left: 6px">{{ toolInjectSummary }}</span>
                <span v-if="llmReq.retrieval_query" class="muted">　· 检索用词「{{ llmReq.retrieval_query }}」</span>
                <div v-if="injectedTools.length" class="injtags">
                  <el-tag v-for="n in injectedTools" :key="n" size="small" effect="plain" class="mono injtag">{{ n }}</el-tag>
                </div>
                <div v-else-if="llmReq.tool_mode === 'progressive'" class="muted" style="margin-top: 4px">首轮只给工具目录，模型经 find_tools 按需取定义</div>
                <div v-else-if="llmReq.tool_mode === 'none'" class="muted" style="margin-top: 4px">本路由未挂工具源，纯对话生成</div>
              </div>
              <div v-else class="muted toolsum">该任务无运行期工具注入记录</div>
            </div>
          </div>

          <el-collapse class="coll">
            <el-collapse-item title="系统提示词">
              <div class="muted sectionHint">{{ llmReq ? '实际发给大脑的完整版，含中枢运行期拼接内容' : '配置原文；该任务无运行期 llm_request 记录' }}</div>
              <pre class="block sm">{{ actualSystemPrompt || '（未配置）' }}</pre>
            </el-collapse-item>
            <el-collapse-item :title="'完整组装 prompt（' + assembledLen + ' 字符）'">
              <pre class="block">{{ cap(detail.input || detail.input_preview || '') }}</pre>
            </el-collapse-item>
          </el-collapse>
        </el-collapse-item>

        <el-collapse-item name="result">
          <template #title>
            <div class="detailSectionTitle">
              <b>AI 回复</b>
              <span class="muted">最终返回给用户或业务侧的内容</span>
            </div>
          </template>
          <div class="richbox"><RichText :text="resultText" /></div>
        </el-collapse-item>

        <el-collapse-item name="raw">
          <template #title>
            <div class="detailSectionTitle">
              <b>原始快照</b>
              <span class="muted">metadata / dispatch，深度排障时使用</span>
            </div>
          </template>
          <div class="detailSubhead">metadata <span class="muted">触发方、聊天层、身份、线程、业务字段</span></div>
          <pre class="block">{{ cap(JSON.stringify(detail.metadata || {}, null, 2)) }}</pre>
          <div class="detailSubhead">dispatch <span class="muted">派发时落定的大脑、工具、送达快照</span></div>
          <pre class="block">{{ cap(JSON.stringify(detail.dispatch || {}, null, 2)) }}</pre>
        </el-collapse-item>
      </el-collapse>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ChatLineRound, List, Search } from '@element-plus/icons-vue';
import { api } from '../request';
import { fmtTime } from '../util';
import { useMe } from '../store';
import RichText from '../components/RichText.vue';
import HelpTip from '../components/HelpTip.vue';

const route = useRoute();

type TraceSeverity = 'info' | 'warning' | 'error';
type TraceStage = 'launch' | 'context' | 'execution' | 'tool' | 'approval' | 'delivery' | 'summary' | 'recovery' | 'channel' | 'config' | 'system' | string;
interface TraceEvent {
  ts: string;
  event: string;
  stage?: TraceStage;
  severity?: TraceSeverity;
  title?: string;
  summary?: string;
  detail?: Record<string, unknown>;
}
interface TracePayload {
  job: any;
  trace: { summary?: any; events: TraceEvent[] };
  lookup?: any;
  debug_bundle?: any;
  debug_report?: string;
}
interface DetailTraceGroup {
  key: string;
  label: string;
  hint: string;
  stages: string[];
  events: TraceEvent[];
  warningCount: number;
  errorCount: number;
}

const s = useMe();
const activeTab = ref<'threads' | 'runs' | 'trace'>('threads');
const list = ref<any[]>([]);
const loading = ref(false);
// 调度流分页：服务端按 offset 取，前端「加载更多」累加。每页 RUNS_PAGE 条；满页即推断还有更多。
const RUNS_PAGE = 50;
const runsMore = ref(false);
const moreLoading = ref(false);
const detailOpen = ref(false);
const detail = ref<any | null>(null);
const traceEvents = ref<TraceEvent[]>([]);
const traceSummary = ref<any | null>(null);
const traceJobInput = ref('');
const traceLookupLoading = ref(false);
const traceLookupResult = ref<TracePayload | null>(null);
const traceLookupMatches = ref<any[]>([]);

// ---- 会话视图状态 ----
const threads = ref<any[]>([]);
const threadsLoading = ref(false);
const threadsLoaded = ref(false);
const THREADS_PAGE = 80;
const threadsMore = ref(false);
const threadsMoreLoading = ref(false);
const threadQ = ref('');
const curThread = ref<number | null>(null);
const threadData = ref<{ thread: any; messages: any[] } | null>(null);
const threadDataLoading = ref(false);
const paneRef = ref<HTMLElement | null>(null);
// 逐轮执行轨迹缓存：job_id → { open, loading, detail, events, summary }（懒拉，展开才请求）
const traces = reactive<Record<string, { open: boolean; loading: boolean; detail: any; events: TraceEvent[]; summary: any | null }>>({});
const traceLookupJob = computed(() => traceLookupResult.value?.job ?? {});
const traceLookupEvents = computed(() => traceLookupResult.value ? normalizeTraceEvents(traceLookupResult.value) : []);
const traceLookupSummary = computed(() => traceLookupResult.value?.trace.summary ?? {});
const traceDebugBundle = computed<any | null>(() => traceLookupResult.value?.debug_bundle ?? null);
const traceDebugReport = computed<string>(() => String(traceLookupResult.value?.debug_report ?? ''));
const traceDiagnosis = computed<any[]>(() => Array.isArray(traceDebugBundle.value?.diagnosis) ? traceDebugBundle.value.diagnosis : []);
const traceRedaction = computed<any>(() => traceDebugBundle.value?.redaction ?? {});
const detailPanels = ref<string[]>(['chain', 'result']);
const DETAIL_TRACE_GROUP_DEFS = [
  { key: 'trigger', label: '入口与触发', hint: '鉴权、建单、渠道、路由配置', stages: ['launch', 'channel', 'config'] },
  { key: 'context', label: '上下文装配', hint: '会话、知识、页面、工具注入、模型请求', stages: ['context'] },
  { key: 'execution', label: '执行与工具', hint: '模型执行、工具调用、审批等待、业务返回', stages: ['execution', 'tool', 'approval'] },
  { key: 'delivery', label: '结果与送达', hint: '回复、摘要、回调、送达、恢复', stages: ['delivery', 'summary', 'recovery', 'system'] },
] as const;
const DETAIL_TRACE_STAGE_TO_GROUP = DETAIL_TRACE_GROUP_DEFS.reduce<Record<string, string>>((acc, g) => {
  for (const stage of g.stages) acc[stage] = g.key;
  return acc;
}, {});

function statusType(st: string): 'success' | 'danger' | 'info' | 'warning' {
  if (st === 'done') return 'success';
  if (st === 'error' || st === 'rejected') return 'danger';
  if (st === 'running' || st === 'dispatched') return 'warning';
  return 'info';
}
// 显示安全上限：审计要全量可追溯，但极端大内容（如几 MB 响应）整段塞进 DOM 会卡；
// 200K 字符够覆盖正常审计内容，超出才尾部标注（真实留存在后端审计，这里只是展示护栏）。
const SAFE_MAX = 200000;
function cap(s: string): string {
  return s.length > SAFE_MAX ? s.slice(0, SAFE_MAX) + `\n…[显示已达上限 ${SAFE_MAX} 字符，完整内容见后端审计 / 重跑导出]` : s;
}
function detailLen(d: unknown): number {
  const t = JSON.stringify(d ?? {});
  return t === '{}' ? 0 : t.length;
}
// 折叠态的预览（一行）：内容多时点箭头看 fullDetail 全量
function shortDetail(d: unknown): string {
  const t = JSON.stringify(d ?? {});
  return t === '{}' ? '' : (t.length > 200 ? t.slice(0, 200) + ' …' : t);
}
// 展开态：全量、易读的 pretty JSON（不截断，仅受 SAFE_MAX 展示护栏）
function fullDetail(d: unknown): string {
  return cap(JSON.stringify(d ?? {}, null, 2));
}
const TOOL_MODE_LABEL: Record<string, string> = { retrieval: '语义检索注入', progressive: '渐进披露（目录+find_tools）', inline: '全量内联', none: '未注入工具' };
function normalizeTraceEvents(t: TracePayload): TraceEvent[] {
  return t.trace.events;
}
function traceTitle(a: TraceEvent): string {
  return a.title || a.event;
}
function traceSummaryText(a: TraceEvent): string {
  return a.summary || '';
}
const STAGE_LABEL: Record<string, string> = {
  launch: '入口',
  context: '上下文',
  execution: '执行',
  tool: '工具',
  approval: '审批',
  delivery: '送达',
  summary: '摘要',
  recovery: '恢复',
  channel: '渠道',
  config: '配置',
  system: '系统',
};
function traceStageLabel(stage?: string): string {
  return STAGE_LABEL[stage || ''] || stage || '系统';
}
function traceStageType(stage?: string): 'success' | 'danger' | 'info' | 'warning' | 'primary' {
  if (stage === 'tool') return 'primary';
  if (stage === 'approval' || stage === 'recovery') return 'warning';
  if (stage === 'delivery' || stage === 'summary') return 'success';
  if (stage === 'context' || stage === 'execution') return 'info';
  return 'info';
}
function traceSeverityType(severity?: string): 'success' | 'danger' | 'info' | 'warning' {
  if (severity === 'error') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'info';
}
function diagnosisType(severity?: string): 'success' | 'danger' | 'info' | 'warning' {
  if (severity === 'error') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'info';
}
function diagnosisLabel(severity?: string): string {
  if (severity === 'error') return '错误';
  if (severity === 'warning') return '提醒';
  return '信息';
}
// 工具摘要：详情抽屉与会话轨迹共用
function fmtTools(t: any): string {
  if (!t || !t.provider) return '未挂工具';
  const allow = Array.isArray(t.allow) ? t.allow.join(' / ') : '';
  return `工具源 ${t.provider}（放行 scope：${allow || '无'}；单任务上限 ${t.max_calls ?? 5}）`;
}
const resultText = computed(() => {
  const r = detail.value?.result ?? {};
  if (typeof r.text === 'string' && r.text) return cap(r.text);
  if (r.report) return cap(JSON.stringify(r.report, null, 2));
  return '（无结果内容）';
});
// ① 原始输入：服务端总账原文优先，回落截断的 preview（非聊天/无总账时）
const rawInput = computed(() => detail.value?.raw_input || detail.value?.input_preview || '（无输入记录）');
// ① 触发方分类：真人(网页聊天 chat:* / 企微 wecom:*) vs 业务系统经 /run 下达(接入方 app_id / admin)。
// 业务下达不是"用户输入"——是事件触发的系统指令，标清楚免得误读成真人在说话。
const inputParty = computed(() => {
  const src = String(detail.value?.source || '');
  if (src.startsWith('chat:')) return { label: '用户输入', sub: '网页聊天访客发来' };
  if (src.startsWith('wecom:')) return { label: '用户输入', sub: '企微用户发来' };
  if (src === 'delivery') return { label: '投递内容', sub: '送达子任务' };
  if (src === 'admin') return { label: '触发方输入', sub: '控制台 / 自测下达' };
  return { label: '触发方输入', sub: `业务系统经 /run 下达·非真人输入${src && src !== 'unknown' ? '（接入方 ' + src + '）' : ''}` };
});
// ② 组装层：系统提示词 / 注入知识 / 工具
const pageCtx = computed<any>(() => detail.value?.metadata?.page_context || null);
// 「中枢实际发给大脑」的运行期记录（llm_request 审计事件）：含完整系统提示词 + 工具暴露决策 + 本轮注入了哪些工具
const llmReq = computed<any>(() => traceEvents.value.find((a) => a.event === 'llm_request')?.detail || null);
// 系统提示词：优先实际发给大脑的完整版（含中枢拼接的工具引导/检索说明/时间锚点）；老任务无 llm_request 时回落配置原文
const actualSystemPrompt = computed(() => String(llmReq.value?.system_prompt ?? detail.value?.dispatch?.target_config?.system_prompt ?? ''));
const injectedTools = computed<string[]>(() => (Array.isArray(llmReq.value?.tools_offered) ? llmReq.value.tools_offered : []));
const toolModeLabel = computed(() => TOOL_MODE_LABEL[llmReq.value?.tool_mode] || '');
const toolModeType = computed<'success' | 'primary' | 'warning' | 'info'>(() => {
  const m = llmReq.value?.tool_mode;
  return m === 'retrieval' ? 'success' : m === 'inline' ? 'primary' : m === 'progressive' ? 'warning' : 'info';
});
const toolInjectSummary = computed(() => {
  const r = llmReq.value; if (!r) return '';
  const total = r.tools_total || 0;
  if (r.tool_mode === 'retrieval') return `按用户问题语义检索后，注入 ${injectedTools.value.length}/${total} 个工具`;
  if (r.tool_mode === 'inline') return `全部 ${total} 个工具直接内联`;
  if (r.tool_mode === 'progressive') return `共 ${total} 个，首轮只给目录，模型经 find_tools 按需取定义`;
  return '本路由未挂工具（纯对话）';
});
const kbRefs = computed<any[]>(() => (Array.isArray(detail.value?.dispatch?.kb_refs) ? detail.value.dispatch.kb_refs : []));
const assembledLen = computed(() => String(detail.value?.input || detail.value?.input_preview || '').length);
const toolsSummary = computed(() => fmtTools(detail.value?.dispatch?.tools));
const canRerun = computed(() =>
  s.can('runs:write') && detail.value && !['queued', 'running', 'dispatched'].includes(detail.value.status));
const detailTraceCount = computed(() => Number(traceSummary.value?.event_count ?? traceEvents.value.length ?? 0));
const detailWarningCount = computed(() => Number(traceSummary.value?.warning_count ?? traceEvents.value.filter((a) => a.severity === 'warning').length));
const detailErrorCount = computed(() => Number(traceSummary.value?.error_count ?? traceEvents.value.filter((a) => a.severity === 'error').length));
const detailToolCount = computed(() => Number(traceSummary.value?.tool_results ?? traceEvents.value.filter((a) => a.stage === 'tool' || a.event === 'tool_result').length));
const detailCriticalEvents = computed(() => traceEvents.value.filter((a) => a.severity === 'error' || a.severity === 'warning').slice(0, 6));
const detailStats = computed(() => {
  const d = detail.value ?? {};
  const warnings = detailWarningCount.value || detailErrorCount.value
    ? `${detailErrorCount.value} 错误 / ${detailWarningCount.value} 警告`
    : '正常';
  return [
    { label: '创建时间', value: d.created_at ? fmtTime(d.created_at, true) : '—' },
    { label: '耗时', value: d.usage?.duration_ms ? (d.usage.duration_ms / 1000).toFixed(1) + 's' : '—' },
    { label: 'Tokens', value: d.usage?.tokens ?? '—' },
    { label: 'Trace', value: detailTraceCount.value ? detailTraceCount.value + ' 步' : '—' },
    { label: '工具调用', value: detailToolCount.value ? detailToolCount.value + ' 次' : '0 次' },
    { label: '风险信号', value: warnings, strong: detailErrorCount.value ? 'dangerText' : detailWarningCount.value ? 'warningText' : '' },
  ];
});
const detailTraceGroups = computed<DetailTraceGroup[]>(() => {
  const groups: DetailTraceGroup[] = DETAIL_TRACE_GROUP_DEFS.map((g) => ({
    ...g,
    stages: [...g.stages],
    events: [],
    warningCount: 0,
    errorCount: 0,
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const other: DetailTraceGroup = {
    key: 'other',
    label: '其他事件',
    hint: '未归类的自定义阶段',
    stages: [],
    events: [],
    warningCount: 0,
    errorCount: 0,
  };
  for (const event of traceEvents.value) {
    const group = byKey.get(DETAIL_TRACE_STAGE_TO_GROUP[event.stage || ''] || '') || other;
    group.events.push(event);
    if (event.severity === 'warning') group.warningCount += 1;
    if (event.severity === 'error') group.errorCount += 1;
  }
  return other.events.length ? groups.concat(other) : groups;
});
function detailGroupType(g: DetailTraceGroup): 'success' | 'danger' | 'info' | 'warning' {
  if (g.errorCount) return 'danger';
  if (g.warningCount) return 'warning';
  if (g.events.length) return 'success';
  return 'info';
}

// ---- 会话标签：把内部的 channel / principal_id / scope_key 翻成人可读的通用主体 ----
// 接入方：业务接入方名 > 网页入口名 > 渠道解析（企微/控制台）
function partyLabel(t: any): string {
  if (t.client_name) return t.client_name;
  if (t.entry_name) return t.entry_name;
  const ch = String(t.channel || '');
  if (ch.startsWith('chat:')) return '网页聊天';
  if (ch.startsWith('wecom:')) return '企微·' + ch.slice(6);
  if (ch === 'admin') return '控制台/自测';
  if (ch === 'hub') return '中枢';
  return ch || '—';
}
function partyVisible(t: any): boolean {
  return partyLabel(t) !== '—';
}
function partyType(t: any): 'success' | 'warning' | 'primary' | 'info' | 'danger' {
  const ch = String(t.channel || '');
  if (t.client_name) return 'success';
  if (ch.startsWith('wecom:')) return 'primary';
  if (ch.startsWith('chat:')) return 'warning';
  return 'info';
}
// 身份：principal_id 是接入方传入的业务主体编码，中枢不推断它的业务含义。
// 例如 uid:t1:u1621 只说明它是一个稳定主体，不等价于中枢能判断出“租户/用户”。
function whoLabel(t: any): string {
  const p = String(t.principal_id || '');
  if (p.startsWith('uid:')) {
    const body = p.slice(4);
    return body ? `身份 ${body}` : '身份';
  }
  if (p.startsWith('visitor:')) return '访客 ' + p.slice(8, 16);
  if (p.startsWith('wxuid:')) return '企微 ' + p.slice(6);
  if (p) return p;
  const sc = String(t.scope_key || '');
  if (sc.startsWith('req:')) return '单次任务 ' + sc.slice(4, 16);
  return sc ? sc.slice(-24) : '匿名';
}
function identityTitle(t: any): string {
  const p = String(t.principal_id || '');
  const sc = String(t.scope_key || '');
  return [p ? `principal_id: ${p}` : '', sc ? `scope_key: ${sc}` : ''].filter(Boolean).join('\n');
}

const filteredThreads = computed(() => {
  const q = threadQ.value.trim().toLowerCase();
  if (!q) return threads.value;
  return threads.value.filter((t) => {
    const hay = [partyLabel(t), whoLabel(t), t.last_preview, t.route_name, t.scope_key].join(' ').toLowerCase();
    return hay.includes(q);
  });
});

// 轨迹徽标（懒拉后才有）：工具次数 / 识图次数 / 耗时
function traceBadge(jobId: string): string {
  const tr = traces[jobId];
  if (!tr || !tr.detail) return '';
  const parts: string[] = [];
  const tools = tr.summary?.tool_results ?? (tr.events || []).filter((a) => a.event === 'tool_result').length;
  if (tools) parts.push(tools + ' 次工具');
  const vc = tr.summary?.perceptions ?? (tr.events || []).filter((a) => a.event === 'perception').length;
  if (vc) parts.push(vc + ' 次识图');
  const warn = tr.summary?.warning_count ?? 0;
  if (warn) parts.push(warn + ' 警告');
  const err = tr.summary?.error_count ?? 0;
  if (err) parts.push(err + ' 错误');
  const dur = tr.detail.usage?.duration_ms;
  if (dur) parts.push((dur / 1000).toFixed(1) + 's');
  return parts.length ? '· ' + parts.join(' · ') : '';
}
function traceModel(jobId: string): string {
  const d = traces[jobId]?.detail;
  return String(d?.dispatch?.target_config?.model || d?.target || '');
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/runs?limit=${RUNS_PAGE}&offset=0`);
    list.value = rows; runsMore.value = rows.length === RUNS_PAGE;
  } finally { loading.value = false; }
}
async function loadMoreRuns(): Promise<void> {
  moreLoading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/runs?limit=${RUNS_PAGE}&offset=${list.value.length}`);
    list.value = list.value.concat(rows); runsMore.value = rows.length === RUNS_PAGE;
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { moreLoading.value = false; }
}
async function loadThreads(): Promise<void> {
  threadsLoading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/threads?limit=${THREADS_PAGE}&offset=0`);
    threads.value = rows; threadsLoaded.value = true; threadsMore.value = rows.length === THREADS_PAGE;
  }
  catch (e) { ElMessage.error((e as Error).message); }
  finally { threadsLoading.value = false; }
}
async function loadMoreThreads(): Promise<void> {
  threadsMoreLoading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/threads?limit=${THREADS_PAGE}&offset=${threads.value.length}`);
    threads.value = threads.value.concat(rows); threadsMore.value = rows.length === THREADS_PAGE;
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { threadsMoreLoading.value = false; }
}
// 聊天场景：进会话直接落在最新消息（最底部），看历史自己向上翻——而不是每次从顶部往下翻
function scrollPaneToBottom(): void {
  const el = paneRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
async function openThread(id: number): Promise<void> {
  curThread.value = id;
  threadData.value = null; threadDataLoading.value = true;
  // 切会话清空轨迹缓存（避免不同会话的 job 串台占内存）
  for (const k of Object.keys(traces)) delete traces[k];
  try { threadData.value = await api('/admin/api/threads/' + id); }
  catch (e) { ElMessage.error((e as Error).message); }
  finally { threadDataLoading.value = false; }
  if (threadData.value) {
    await nextTick();
    scrollPaneToBottom();
    setTimeout(scrollPaneToBottom, 150); // 兜底：图片/异步内容撑高后再贴底
  }
}
async function toggleTrace(jobId: string): Promise<void> {
  const cur = traces[jobId];
  if (cur?.open) { cur.open = false; return; }
  if (cur?.detail) { cur.open = true; return; }
  traces[jobId] = { open: true, loading: true, detail: null, events: [], summary: null };
  try {
    const t = await api<TracePayload>('/admin/api/runs/' + jobId + '/trace');
    traces[jobId] = { open: true, loading: false, detail: t.job, events: normalizeTraceEvents(t), summary: t.trace.summary ?? null };
  } catch (e) {
    traces[jobId] = { open: true, loading: false, detail: null, events: [], summary: null };
    ElMessage.error((e as Error).message);
  }
}
function onTab(name: string): void {
  if (name === 'threads' && !threadsLoaded.value) void loadThreads();
}
function refresh(): void {
  if (activeTab.value === 'threads') { void loadThreads(); if (curThread.value) void openThread(curThread.value); }
  else if (activeTab.value === 'trace') { if (traceJobInput.value.trim()) void lookupJobTrace(); }
  else void load();
}

async function openDetail(row: any): Promise<void> {
  detailOpen.value = true; detail.value = null; traceEvents.value = []; traceSummary.value = null; detailPanels.value = ['chain', 'result'];
  try {
    const t = await api<TracePayload>('/admin/api/runs/' + row.job_id + '/trace');
    detail.value = t.job; traceEvents.value = normalizeTraceEvents(t); traceSummary.value = t.trace.summary ?? null;
  } catch (e) { ElMessage.error((e as Error).message); }
}
async function lookupJobTrace(): Promise<void> {
  const raw = traceJobInput.value.trim();
  if (!raw) { ElMessage.error('请输入要追溯的标识'); return; }
  const q = traceLookupQuery(raw);
  traceLookupLoading.value = true;
  try {
    const got = await api<TracePayload & { matches?: any[]; count?: number }>('/admin/api/runs/trace?' + q);
    if (got.job) {
      traceLookupResult.value = got;
      traceLookupMatches.value = [];
    } else {
      traceLookupResult.value = null;
      traceLookupMatches.value = got.matches ?? [];
      if (!traceLookupMatches.value.length) ElMessage.warning('没有匹配的任务');
    }
  } catch (e) {
    traceLookupResult.value = null;
    traceLookupMatches.value = [];
    ElMessage.error((e as Error).message);
  } finally { traceLookupLoading.value = false; }
}
function traceLookupQuery(raw: string): string {
  const p = new URLSearchParams();
  if (/^[0-9a-f-]{36}$/i.test(raw)) p.set('job_id', raw);
  else if (/^client:/i.test(raw)) p.set('client_id', raw.replace(/^client:/i, '').trim());
  else if (/^thread:/i.test(raw)) p.set('thread_id', raw.replace(/^thread:/i, '').trim());
  else if (/^principal:/i.test(raw)) p.set('principal_id', raw.replace(/^principal:/i, '').trim());
  else p.set('request_id', raw);
  return p.toString();
}
async function openTraceMatch(row: any): Promise<void> {
  traceJobInput.value = row.job_id;
  await lookupJobTrace();
}
function openTraceLookupDetail(): void {
  if (!traceLookupResult.value) return;
  detail.value = traceLookupResult.value.job;
  traceEvents.value = normalizeTraceEvents(traceLookupResult.value);
  traceSummary.value = traceLookupResult.value.trace.summary ?? null;
  detailPanels.value = ['chain', 'result'];
  detailOpen.value = true;
}
function traceDebugJson(): string {
  return JSON.stringify({
    exported_at: new Date().toISOString(),
    export_kind: 'redacted-debug-bundle',
    debug_bundle: traceDebugBundle.value ?? {},
  }, null, 2);
}
function downloadTraceDebugBundle(): void {
  if (!traceDebugBundle.value) return;
  const jobId = String(traceDebugBundle.value.identifiers?.job_id || traceLookupJob.value.job_id || 'trace');
  const blob = new Blob([traceDebugJson()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bailing-redacted-debug-${jobId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function copyTraceDebugBundle(): Promise<void> {
  if (!traceDebugBundle.value) return;
  try {
    await navigator.clipboard.writeText(traceDebugJson());
    ElMessage.success('脱敏排障包 JSON 已复制');
  } catch {
    ElMessage.error('复制失败，请下载脱敏排障包');
  }
}
function downloadTraceDebugReport(): void {
  if (!traceDebugReport.value) return;
  const jobId = String(traceDebugBundle.value?.identifiers?.job_id || traceLookupJob.value.job_id || 'trace');
  const blob = new Blob([traceDebugReport.value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bailing-debug-report-${jobId}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function copyTraceDebugReport(): Promise<void> {
  if (!traceDebugReport.value) return;
  try {
    await navigator.clipboard.writeText(traceDebugReport.value);
    ElMessage.success('排障报告已复制');
  } catch {
    ElMessage.error('复制失败，请下载排障报告');
  }
}
// 从某个 job 跳到它所属的完整会话
function gotoThread(threadId: number): void {
  detailOpen.value = false;
  activeTab.value = 'threads';
  if (!threadsLoaded.value) void loadThreads();
  void openThread(threadId);
}
async function rerun(): Promise<void> {
  try {
    await api('/admin/api/runs/' + detail.value.job_id + '/rerun', { method: 'POST', body: '{}' });
    ElMessage.success('已重新入队');
    await openDetail(detail.value); await load();
  } catch (e) { ElMessage.error((e as Error).message); }
}
async function openJobFromQuery(job: string): Promise<void> {
  if (!job || !/^[0-9a-f-]{36}$/i.test(job)) return;
  activeTab.value = 'trace';
  traceJobInput.value = job;
  await lookupJobTrace();
  openTraceLookupDetail();
}
onMounted(async () => {
  const job = String(route.query['job'] ?? '');       // 深链：审批意图页「看任务」直达详情 → 落调度流 + 开抽屉
  const thr = String(route.query['thread'] ?? '');     // 深链：直达某会话
  if (job) { activeTab.value = 'trace'; traceJobInput.value = job; }
  await load();                                        // 调度流列表（始终拉，刷新/深链都用得上）
  if (activeTab.value === 'threads' && !threadsLoaded.value) await loadThreads(); // 默认进会话视图 → 拉会话列表
  if (thr) void openThread(Number(thr));
  if (job) await openJobFromQuery(job);
});
watch(() => route.query['job'], (v) => {
  void openJobFromQuery(String(v ?? ''));
});
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.dangerText { color: var(--el-color-danger); }
.warningText { color: var(--el-color-warning); }
.loadmore { text-align: center; padding: 12px 0 4px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.meta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pagectx { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; font-size: 13px; }
.pagectx .path { background: var(--el-fill-color-light); border-radius: 0; padding: 1px 6px; word-break: break-all; }
.sec { font-weight: 600; font-size: 13px; margin: 18px 0 8px; padding-left: 8px; border-left: 3px solid var(--el-color-primary-light-3); }
.sec .muted { font-weight: 400; margin-left: 6px; }
.sub { font-size: 12px; color: var(--el-text-color-regular); font-weight: 600; margin: 8px 0 4px; }
.block { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; margin: 0; font: 12px/1.55 var(--bz-mono); white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; }
.block.sm { max-height: 120px; }
.richbox { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; max-height: 480px; overflow: auto; }
.kb { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.kbitem { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 6px 10px; background: var(--el-fill-color-blank); }
.kbitem .snip { font-size: 11px; margin-top: 2px; max-height: 48px; overflow: hidden; }
.nokb { margin-bottom: 8px; }
.toolsum { margin-bottom: 8px; }
.toolinject { background: var(--el-fill-color-light); border-radius: 0; padding: 8px 10px; margin-bottom: 8px; }
.injtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.injtag { max-width: 100%; }
.coll { margin-top: 6px; }
	.detail-json { font-family: var(--bz-mono); font-size: 11px; word-break: break-all; }
	.auditTag { margin-left: 8px; font-family: var(--bz-mono); font-size: 11px; }
	.traceStage { margin-left: 8px; vertical-align: 1px; }
	.traceSeverity { margin-left: 4px; vertical-align: 1px; }
	.auditcoll { margin-top: 2px; border-top: none; }
	.auditcoll :deep(.el-collapse-item__header) { font-family: var(--bz-mono); font-size: 11px; height: auto; line-height: 1.6; padding: 2px 0; border-bottom: none; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; }
	.auditcoll :deep(.el-collapse-item__content) { padding-bottom: 6px; }
	.auditcoll :deep(.el-collapse-item__wrap) { border-bottom: none; }

	:deep(.runDetailDrawer .el-drawer__header) { margin-bottom: 0; padding: 18px 22px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
	:deep(.runDetailDrawer .el-drawer__body) { padding: 16px 22px 24px; }
	.detailHero { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 12px 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 0; background: var(--el-fill-color-light); margin-bottom: 12px; }
	.detailHeroMain { min-width: 0; flex: 1; }
	.detailTags { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
	.detailTitle { font-weight: 700; font-size: 15px; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.detailIds { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 5px; color: var(--el-text-color-secondary); }
	.detailActions { display: flex; align-items: center; gap: 8px; flex: none; }
	.detailActions :deep(.el-button + .el-button) { margin-left: 0; }
	.detailStats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
	.detailStats > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px 10px; background: var(--el-bg-color); min-width: 0; }
	.detailStats span, .detailStats b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.detailStats b { margin-top: 3px; font-size: 13px; }
	.detailProblemList { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
	.detailProblem { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 7px 9px; background: var(--el-fill-color-blank); }
	.detailProblem.error { border-color: var(--el-color-danger-light-7); background: var(--el-color-danger-light-9); }
	.detailProblem.warning { border-color: var(--el-color-warning-light-7); background: var(--el-color-warning-light-9); }
	.detailProblem b { font-size: 13px; }
	.detailSections { border-top: none; }
	.detailSections :deep(.el-collapse-item__header) { min-height: 48px; height: auto; line-height: 1.4; padding: 6px 0; }
	.detailSections :deep(.el-collapse-item__content) { padding-bottom: 14px; }
	.detailSectionTitle { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.detailSectionTitle b { font-size: 14px; }
	.chainGroups { display: flex; flex-direction: column; gap: 10px; }
	.chainGroup { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 10px 12px; background: var(--el-fill-color-blank); }
	.chainGroupHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
	.chainGroupHead b, .chainGroupHead span { display: block; }
	.chainGroupTags { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 5px; flex: none; }
	.chainGroupTags :deep(.el-tag) { display: inline-flex; align-items: center; justify-content: center; height: 24px; line-height: 1; padding: 0 9px; }
	.detailTimeline { padding-left: 4px; margin-top: 4px; }
	.detailTimeline :deep(.el-timeline-item__wrapper) { padding-left: 18px; }
	.traceEventHead { display: flex; align-items: center; flex-wrap: wrap; gap: 0; min-width: 0; }
	.traceEventSummary { margin-top: 2px; font-size: 12px; word-break: break-word; }
	.emptyChain { padding: 6px 0 2px; }
	.detailSubhead { font-size: 12px; color: var(--el-text-color-regular); font-weight: 700; margin: 10px 0 6px; }
	.richbox.compact { max-height: 260px; }
	.detailContextGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 10px; }
	.sectionHint { margin-bottom: 6px; }

	/* ===== 会话视图：收件箱式主从布局 ===== */
.convo { display: flex; gap: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 0; overflow: hidden; height: calc(100vh - 220px); min-height: 460px; }
.rail { width: 320px; flex: none; border-right: 1px solid var(--el-border-color-lighter); display: flex; flex-direction: column; background: var(--el-fill-color-blank); }
.railsearch { padding: 10px; }
.raillist { flex: 1; overflow-y: auto; }
.threaditem { padding: 9px 12px; border-bottom: 1px solid var(--el-border-color-lighter); cursor: pointer; transition: background .12s; }
.threaditem:hover { background: var(--el-fill-color-light); }
.threaditem.active { background: var(--el-color-primary-light-9); box-shadow: inset 3px 0 0 var(--el-color-primary); }
.trow1 { display: flex; align-items: center; gap: 6px; }
.trow1 .who { font-weight: 600; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trow1 .tcount { margin-left: auto; flex: none; }
.tprev { margin: 3px 0 2px; font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tmeta { font-size: 11px; }
.pane { flex: 1; overflow-y: auto; padding: 14px 18px; min-width: 0; }
.paneHead { position: sticky; top: -14px; background: var(--el-bg-color); padding: 4px 0 10px; margin: -4px 0 6px; border-bottom: 1px solid var(--el-border-color-lighter); z-index: 1; }
.ph1 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ph2 { margin-top: 4px; word-break: break-all; }
.summcoll { margin-bottom: 8px; }
.chat { display: flex; flex-direction: column; gap: 14px; padding-top: 6px; }
.turn { display: flex; }
.turn.fromUser { justify-content: flex-end; }
.turn.fromHub { justify-content: flex-start; }
.bubbleWrap { max-width: 80%; min-width: 0; }
.bMeta { font-size: 11px; margin-bottom: 3px; }
.turn.fromUser .bMeta { text-align: right; }
.bubble { border-radius: 0; padding: 8px 12px; word-break: break-word; }
.turn.fromUser .bubble { background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); }
.turn.fromHub .bubble { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
.traceLine { margin-top: 4px; }
.tracetoggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--el-text-color-secondary); cursor: pointer; user-select: none; }
.tracetoggle:hover { color: var(--el-color-primary); }
.traceCaret { width: 10px; height: 10px; color: currentColor; transform: rotate(-90deg); transition: transform .14s ease; flex: none; }
.traceCaret.open { transform: rotate(0deg); }
.tracebox { margin-top: 6px; padding: 10px 12px; border: 1px dashed var(--el-border-color); border-radius: 0; background: var(--el-fill-color-blank); }
.traceDetailBtn { margin-top: 4px; height: 26px; padding: 0 10px; }
.tmeta2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.tline { padding-left: 4px; margin-top: 4px; }
.notrace { font-size: 12px; margin: 4px 0; }
.traceLookup { max-width: 720px; margin-bottom: 14px; }
.traceMatches { margin-bottom: 14px; cursor: pointer; }
.tracePanel { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 14px 16px; background: var(--el-bg-color); }
.traceHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.traceHeadTags { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.traceStats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.traceStats > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 8px 10px; background: var(--el-fill-color-light); }
.traceStats span, .traceStats b { display: block; }
.traceStats b { margin-top: 3px; font-size: 13px; }
.traceActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.traceActions :deep(.el-button + .el-button) { margin-left: 0; }
.debugBundle { margin-top: 10px; }
.redactionBar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.debugGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
.debugGrid > div { border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 7px 9px; background: var(--el-fill-color-light); min-width: 0; }
.debugGrid span, .debugGrid b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.debugGrid b { margin-top: 3px; font-size: 13px; }
.diagnosisList { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.diagnosisItem { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; border: 1px solid var(--el-border-color-lighter); border-radius: 0; padding: 7px 9px; background: var(--el-fill-color-blank); }
.diagnosisItem.error { border-color: var(--el-color-danger-light-7); }
.diagnosisItem.warning { border-color: var(--el-color-warning-light-7); }
.diagnosisItem b { font-size: 13px; }
.diagnosisItem .action { flex-basis: 100%; margin-left: 58px; }

	@media (max-width: 900px) {
	  .detailHero { flex-direction: column; }
	  .detailActions { width: 100%; justify-content: flex-end; }
	  .detailStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	  .detailContextGrid { grid-template-columns: minmax(0, 1fr); }
	  .chainGroupHead { flex-direction: column; }
	  .chainGroupTags { justify-content: flex-start; }
	  .traceHead { flex-direction: column; }
	  .traceStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	  .debugGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	}
	@media (max-width: 560px) {
	  :deep(.runDetailDrawer .el-drawer__body) { padding: 12px 14px 18px; }
	  .detailStats { grid-template-columns: minmax(0, 1fr); }
	  .detailActions { justify-content: flex-start; }
	}
	</style>
