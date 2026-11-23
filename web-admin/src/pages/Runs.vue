<template>
  <el-card shadow="never">
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span><b>任务</b> <HelpTip title="任务页是什么">
            <p>「<b>会话</b>」按最近活动汇总客户端、网页助手和其他渠道已记录的对话。可从消息查看执行轨迹，也可单独查原授权记录。</p>
            <p>「<b>调度流</b>」按时间倒序审计<b>每一次派发</b>，点行看任务全详情（输入 / 组装上下文 / 工具 / 回复）。</p>
            <p>「<b>追溯</b>」按 job_id、request_id、client_id、thread_id 或 principal_id 查单次任务完整生命周期，用于接入排障和审批/送达/工具调用对账。</p>
          </HelpTip></span>
        <div><el-button v-if="returnPath" @click="router.push(returnPath)">返回来源页面</el-button><el-button :loading="loading || threadsLoading" @click="refresh">刷新</el-button></div>
      </div>
    </template>

    <el-tabs v-model="activeTab" @tab-change="onTab">
      <!-- ============ 会话视图：把平铺的 job 还原成「一个人一条对话」（收件箱式主从） ============ -->
      <el-tab-pane name="threads">
        <template #label><span><el-icon style="vertical-align:-2px"><ChatLineRound /></el-icon> 会话</span></template>
        <ClientConversations ref="clientConversations" :selected-id="auditConversationId" :focus-turn="auditTurnId" :channel-thread="channelThreadId" :source="conversationSource"
          @select-channel="selectChannelThread" @change-source="changeConversationSource" @open-audit="gotoAuditConversation"
          @select="selectAuditConversation" @back-list="backToConversationList" @open-directory="openRecordDirectory" @open-thread="gotoThread" @open-job="openDetail({ job_id: $event })" />
      </el-tab-pane>
      <!-- ============ 调度流：原有平铺列表，按时间审计每一次派发 ============ -->
      <el-tab-pane name="runs">
        <template #label><span><el-icon style="vertical-align:-2px"><List /></el-icon> 调度流</span></template>
        <div class="run-filters">
          <el-select v-model="runFilters.status" aria-label="任务状态筛选" placeholder="全部状态" style="width:170px" @change="persistRunFilters"><el-option value="" label="全部状态" /><el-option v-for="status in RUN_FILTER_STATUSES" :key="status" :value="status" :label="`${runStatusLabels[status]} · ${status}`" /></el-select>
          <el-select v-model="runFilters.route" aria-label="任务路由筛选" style="width:240px" filterable allow-create clearable placeholder="全部路由（输入精确标识）" @change="persistRunFilters"><el-option v-for="key in runRouteOptions" :key="key" :value="key" :label="key" /></el-select>
          <el-select v-model="runFilters.period" aria-label="任务时间筛选" style="width:150px" @change="persistRunFilters"><el-option value="all" label="全部时间" /><el-option value="24h" label="最近 24 小时" /><el-option value="7d" label="最近 7 天" /></el-select>
          <el-button v-if="hasRunFilters" @click="clearRunFilters">清除筛选</el-button>
        </div>
        <el-alert v-if="runsError" :title="runsError" :description="list.length ? `保留上次读取的记录（${fmtTime(runsLoadedAt, true)}）。` : '请重试读取当前条件下的任务。'" type="error" :closable="false" show-icon />
        <div v-if="!loading && !runsError && list.length" class="runCount muted">{{ runsMore ? '已显示 ' + list.length + ' 条，可继续加载' : '共 ' + list.length + ' 条任务' }}</div>
        <el-empty v-if="!list.length && !loading && !runsError" :description="hasRunFilters ? '没有符合当前条件的任务' : '尚无任务记录'"><el-button v-if="hasRunFilters" @click="clearRunFilters">清除筛选</el-button></el-empty>
        <el-table v-else :data="list" v-loading="loading" @row-click="openDetail" row-key="job_id" class="runsTable">
          <el-table-column label="时间" width="125"><template #default="{ row }"><time>{{ fmtTime(row.created_at, true) }}</time></template></el-table-column>
          <el-table-column label="任务" min-width="215"><template #default="{ row }">
            <button type="button" class="runSubject" :title="row.input_preview || row.project || row.request_id || row.job_id" @click.stop="openDetail(row)">{{ row.input_preview || row.project || row.request_id || row.job_id }}</button>
            <div v-if="row.project && row.input_preview" class="muted runCellLine">{{ row.project }}</div>
          </template></el-table-column>
          <el-table-column label="来源" min-width="110"><template #default="{ row }">
            <span class="runCellLine" :title="row.source || row.client_app_id">{{ runSourceLabel(row) }}</span>
            <span v-if="row.visitor_uid || row.thread_id" class="muted runCellLine">{{ [row.visitor_uid, row.thread_id].filter(Boolean).join(' · ') }}</span>
          </template></el-table-column>
          <el-table-column label="路由 / 调度目标" min-width="135"><template #default="{ row }">
            <span class="runCellLine" :title="runRouteKey(row)">{{ runRouteKey(row) || '未记录' }}</span>
            <span v-if="row.target" class="muted runCellLine">{{ row.target }}</span>
          </template></el-table-column>
          <el-table-column label="状态" width="95"><template #default="{ row }">
            <el-tag :type="statusType(row.status)" effect="plain" :title="row.status">{{ runStatusLabels[row.status] || row.status || '未记录' }}</el-tag>
          </template></el-table-column>
          <el-table-column label="结果 / 异常摘要" min-width="180"><template #default="{ row }">
            <div class="runCellLine" :class="{ errorText: row.error_preview }" :title="row.error_preview || row.summary">{{ row.error_preview || row.summary || '—' }}</div>
            <span v-if="row.severity" class="muted runCellLine">级别 · {{ row.severity }}</span>
          </template></el-table-column>
        </el-table>
        <div v-if="runsMore" class="loadmore"><el-button :loading="moreLoading" :disabled="loading" @click="loadMoreRuns">加载更多</el-button></div>
      </el-tab-pane>

      <!-- ============ 单 Job 追溯：开发者排障入口，job_id → 生命周期全链 ============ -->
      <el-tab-pane name="trace">
        <template #label><span><el-icon style="vertical-align:-2px"><Search /></el-icon> 追溯</span></template>
        <div class="traceLookup">
          <el-input v-model="traceJobInput" size="default" class="mono" clearable aria-label="追溯标识" placeholder="任务、请求或关联对象标识" @keyup.enter="lookupJobTrace" @clear="clearTraceLookup">
            <template #append><el-button :loading="traceLookupLoading" @click="lookupJobTrace">追溯</el-button></template>
          </el-input>
          <HelpTip title="追溯标识"><p>直接输入 job_id 或 request_id。按关联对象查询时，在标识前添加前缀，例如 <code>client:crm</code>、<code>thread:123</code> 或 <code>principal:u-1</code>。</p></HelpTip>
        </div>
        <el-button v-if="traceFrom" class="traceReturn" plain size="small" @click="returnToTraceMatches">返回匹配任务</el-button>
        <el-alert v-if="traceLookupError" :title="traceLookupError" :description="traceLookupResult || traceLookupMatches.length ? `正在展示旧快照，上次成功读取：${fmtTime(traceLoadedAt, true)}。` : '此次未取得追溯结果，请刷新重试。'" type="error" :closable="false" show-icon />
        <el-empty v-if="!traceLookupResult && !traceLookupLoading && !traceLookupMatches.length && !traceLookupError" :description="traceEmptyFor ? `没有与「${traceEmptyFor}」匹配的任务` : '输入标识后查看匹配任务'" />
        <el-table v-if="!traceLookupResult && traceLookupMatches.length" :data="traceLookupMatches" size="small" class="traceMatches" @row-click="openTraceMatch">
          <el-table-column label="时间" width="130"><template #default="{ row }">{{ fmtTime(row.created_at, true) }}</template></el-table-column>
          <el-table-column label="请求编号" min-width="180" show-overflow-tooltip><template #default="{ row }"><el-button link type="primary" @click.stop="openTraceMatch(row)">{{ row.request_id || row.job_id }}</el-button></template></el-table-column>
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
      <el-tab-pane label="通知送达" name="notifications">
        <NotificationOutboxPanel v-if="activeTab === 'notifications'" ref="notificationPanel" @open-job="openDetail({ job_id: $event })" />
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-drawer :model-value="recordDrawerOpen" :title="curThread ? '原授权记录' : '授权与接入记录'"
    size="min(660px, 100vw)" class="rawRecordDrawer" append-to-body :before-close="closeRecordDrawer">
    <div ref="recordContents" class="recordContents">
      <div class="recordTools">
        <el-button v-if="curThread" size="small" data-record-list @click="backToRecordDirectory">返回记录列表</el-button>
        <HelpTip v-else title="筛选授权与接入记录">记录按最近活动排序，搜索范围为当前已加载的记录。</HelpTip>
        <el-button size="small" :loading="curThread ? rawTranscript?.loading : threadsLoading" @click="refreshRecords">刷新记录</el-button>
      </div>
      <div v-show="!curThread" class="rail" aria-label="原记录列表">
        <el-alert v-if="threadsError" :title="threadsError" type="error" :closable="false" show-icon />
        <el-input v-model="threadQ" size="default" aria-label="筛选已加载的授权与接入记录" placeholder="筛选身份、接入方、内容或路由" clearable class="railsearch" @input="persistThreadSearch">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <div v-loading="threadsLoading" class="raillist">
          <el-empty v-if="!threadsLoading && !threadsError && !filteredThreads.length" :image-size="56"
            :description="threadQ ? '已加载记录中没有匹配项' : '暂无授权或业务接入记录'" />
          <button v-for="t in filteredThreads" :key="t.thread_id" type="button" class="threaditem"
            :class="{ active: lastOpenedThread === t.thread_id }" :aria-current="lastOpenedThread === t.thread_id ? 'true' : undefined" :data-thread-id="t.thread_id" @click="gotoThread(t.thread_id)">
            <div class="trow1">
              <el-tag v-if="partyVisible(t)" size="small" effect="plain" :type="partyType(t)">{{ partyLabel(t) }}</el-tag>
              <span class="who mono" :title="identityTitle(t)">{{ whoLabel(t) }}</span>
              <span class="tcount muted">{{ t.message_count }} 条消息</span>
            </div>
            <div class="tprev muted">{{ t.last_preview || '（无内容）' }}</div>
            <div class="tmeta muted"><span class="mono">{{ t.route_name }}</span> · {{ fmtTime(t.last_active_at, true) }}</div>
          </button>
          <div v-if="threadsMore" class="loadmore"><el-button link :loading="threadsMoreLoading" @click="loadMoreThreads">加载更多记录</el-button></div>
        </div>
      </div>

      <ChannelThread v-if="curThread" ref="rawTranscript" :thread-id="curThread" @open-job="openDetail({ job_id: $event })" @open-audit="gotoAuditConversation" />
    </div>
  </el-drawer>

  <el-drawer :model-value="detailOpen" size="min(920px, 92vw)" class="runDetailDrawer" append-to-body :title="'任务详情 · ' + (detail?.request_id || detail?.job_id || '')" :before-close="closeJobDetail">
    <el-alert v-if="detailError" :title="detailError" :description="detail ? `当前保留旧快照（${fmtTime(detailLoadedAt, true)}），刷新成功前不能重新执行。` : '未取得任务详情，请重试。'" type="error" :closable="false" show-icon />
    <div v-if="detailLoading" class="muted">正在读取任务详情…</div>
    <el-button v-if="!detail && detailJobId && !detailLoading" @click="openDetail({ job_id: detailJobId })">重试读取任务</el-button>
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
          <el-button plain size="small" :loading="detailLoading" @click="openDetail(detail)">刷新快照</el-button>
          <el-button plain size="small" @click="copyJobId(detail.job_id)">复制原 Job ID</el-button>
          <el-button v-if="detail.conversation_audit_id" plain size="small" type="primary" @click="gotoAuditConversation(detail.conversation_audit_id, detail.client_turn_id)">客户端完整对话</el-button>
          <el-button v-if="detail.thread_id" plain size="small" @click="gotoThread(detail.thread_id)">原会话记录</el-button>
          <el-popconfirm v-if="canRerun" title="重新执行会复用原始输入和参数，可能再次调用模型、产生费用或业务写入；不会撤销上次结果。请先核对原任务确需重新执行。" width="350" @confirm="rerun">
            <template #reference><el-button type="primary" size="small" :disabled="detailLoading || Boolean(detailError)" :loading="rerunning">重新执行任务</el-button></template>
          </el-popconfirm>
        </div>
      </div>
      <el-alert v-if="detailRerunHint" :title="detailRerunHint" :type="detail.console_execution?.rerun?.reason === 'outcome_unknown' ? 'warning' : 'info'" :closable="false" show-icon />
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
              <span class="muted">{{ detailTraceCount }} 步</span>
            </div>
          </template>
          <div class="chainGroups">
            <div v-for="g in detailTraceGroups" :key="g.key" class="chainGroup">
              <div class="chainGroupHead">
                <div>
                  <b>{{ g.label }}</b>
                  <HelpTip :title="g.label">{{ g.hint }}</HelpTip>
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
            </div>
          </template>
          <div class="detailSubhead">{{ inputParty.label }} <span class="muted">{{ inputParty.sub }}</span></div>
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
              <div class="detailSubhead">工具注入 <HelpTip title="工具注入">本次任务实际提供给模型的工具。渐进模式下，首轮提供目录，模型按需读取工具定义。</HelpTip></div>
              <div class="muted toolsum">{{ toolsSummary }}</div>
              <div v-if="llmReq" class="toolinject">
                <el-tag size="small" :type="toolModeType" effect="plain">{{ toolModeLabel }}</el-tag>
                <span class="muted" style="margin-left: 6px">{{ toolInjectSummary }}</span>
                <span v-if="llmReq.retrieval_query" class="muted">　· 检索用词「{{ llmReq.retrieval_query }}」</span>
                <div v-if="injectedTools.length" class="injtags">
                  <el-tag v-for="n in injectedTools" :key="n" size="small" effect="plain" class="mono injtag">{{ n }}</el-tag>
                </div>
                <div v-else-if="llmReq.tool_mode === 'none'" class="muted" style="margin-top: 4px">本路由未挂工具源，纯对话生成</div>
              </div>
              <div v-else class="muted toolsum">该任务无运行期工具注入记录</div>
            </div>
          </div>

          <el-collapse class="coll">
            <el-collapse-item title="系统提示词">
              <div class="muted sectionHint">{{ llmReq ? '运行时实际提示词' : '配置原文（缺少运行时记录）' }}</div>
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
            </div>
          </template>
          <div class="richbox"><RichText :text="resultText" /></div>
        </el-collapse-item>

        <el-collapse-item name="raw">
          <template #title>
            <div class="detailSectionTitle">
              <b>原始快照</b>
            </div>
          </template>
          <div class="detailSubhead">metadata <HelpTip title="任务元数据">记录触发方、会话身份、线程和业务字段。</HelpTip></div>
          <pre class="block">{{ cap(JSON.stringify(detail.metadata || {}, null, 2)) }}</pre>
          <div class="detailSubhead">dispatch <HelpTip title="派发快照">记录任务派发时使用的模型、工具和送达配置。</HelpTip></div>
          <pre class="block">{{ cap(JSON.stringify(detail.dispatch || {}, null, 2)) }}</pre>
        </el-collapse-item>
      </el-collapse>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ChatLineRound, List, Search } from '@element-plus/icons-vue';
import { api, ApiError } from '../request';
import { fmtTime } from '../util';
import { useMe } from '../store';
import RichText from '../components/RichText.vue';
import HelpTip from '../components/HelpTip.vue';
import ClientConversations from '../components/ClientConversations.vue';
import ChannelThread from '../components/ChannelThread.vue';
import { cap, detailLen, shortDetail, fullDetail, fmtTools, statusType, traceTitle, traceSummaryText, traceStageLabel, traceStageType, traceSeverityType,
  partyLabel, partyVisible, partyType, whoLabel, identityTitle, type TraceEvent, type TracePayload } from '../task-trace-presentation';
import NotificationOutboxPanel from '../components/NotificationOutboxPanel.vue';
import { canOfferRerun, rerunHint } from '../runtime-feedback';
import { queryText, runFilterParams, patchTaskQuery, readRunFilters, readRunsLocation, RUN_FILTER_STATUSES, runRouteKey, runsTabQuery, safeTaskReturnPath, type RunsTab } from '../task-page-location';

const route = useRoute();
const router = useRouter();
const returnPath = computed(() => safeTaskReturnPath(route.query.return_to));
const initialLocation = readRunsLocation(route.query);

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
const activeTab = ref<RunsTab>(initialLocation.tab);
const notificationPanel = ref<InstanceType<typeof NotificationOutboxPanel> | null>(null);
const recordDrawerOpen = computed(() => {
  const location = readRunsLocation(route.query);
  return location.tab === 'threads' && location.view === 'legacy';
});
const auditConversationId = ref(initialLocation.conversation), auditTurnId = ref(initialLocation.turn);
const rawTranscript = ref<InstanceType<typeof ChannelThread> | null>(null);
const channelThreadId = computed(() => {
  const value = route.query.channel_thread;
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
});
const conversationSource = computed(() => typeof route.query.conversation_source === 'string' ? route.query.conversation_source : 'all');
const clientConversations = ref<InstanceType<typeof ClientConversations> | null>(null);
const list = ref<any[]>([]);
const runFilters = reactive(readRunFilters(route.query));
const runStatusLabels: Record<string, string> = { queued: '等待执行', running: '执行中', dispatched: '已派发', done: '已完成', error: '执行错误', rejected: '已拒绝' };
const hasRunFilters = computed(() => Boolean(runFilters.status || runFilters.route || runFilters.period !== 'all'));
const knownRunRoutes = ref<string[]>([]);
const runRouteOptions = computed(() => [...new Set([...knownRunRoutes.value, ...(runFilters.route ? [runFilters.route] : [])])].sort());
let requestedRunsKey: string | undefined;
function runSourceLabel(row: { source?: string; client_app_id?: string }): string {
  const src = row.source || '';
  if (src.startsWith('chat:')) return '网页助手 · ' + src.slice(5);
  if (src.startsWith('wecom:')) return '企微 · ' + src.slice(6);
  if (src.startsWith('agent:') || src.startsWith('agent-tool:')) return '客户端 · ' + (row.client_app_id || src.slice(src.indexOf(':') + 1));
  if (src === 'delivery') return '结果送达';
  if (src === 'admin') return '控制台';
  return row.client_app_id || src || '未记录';
}
const loading = ref(false);
const runsError = ref(''), runsLoadedAt = ref('');
let runsGeneration = 0;
// 多取一条判断是否还有下一页，同秒的记录以 Job ID 排序。
const RUNS_PAGE = 50;
const runsMore = ref(false);
const moreLoading = ref(false);
const detailOpen = ref(false);
const detail = ref<any | null>(null);
const detailLoading = ref(false), detailError = ref(''), detailLoadedAt = ref(''), detailJobId = ref(''), rerunning = ref(false);
let detailGeneration = 0;
const traceEvents = ref<TraceEvent[]>([]);
const traceSummary = ref<any | null>(null);
const traceJobInput = ref(initialLocation.traceQ);
const traceLookupLoading = ref(false);
const traceLookupResult = ref<TracePayload | null>(null);
const traceLookupMatches = ref<any[]>([]);
const traceLookupError = ref(''), traceLoadedAt = ref(''), traceEmptyFor = ref('');
const traceFrom = computed(() => queryText(route.query.trace_from));
let traceGeneration = 0, traceLoadedQuery = '', traceRequestedRaw = '';

// ---- 会话视图状态 ----
const threads = ref<any[]>([]);
const threadsLoading = ref(false);
const threadsError = ref('');
let threadsGeneration = 0;
const threadsLoaded = ref(false);
const THREADS_PAGE = 80;
const threadsMore = ref(false);
const threadsMoreLoading = ref(false);
const threadQ = ref(initialLocation.threadQ);
const curThread = ref<number | null>(null);
const lastOpenedThread = ref<number | null>(null);
const recordContents = ref<HTMLElement | null>(null);
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

const TOOL_MODE_LABEL: Record<string, string> = { retrieval: '语义检索注入', progressive: '渐进披露（目录+find_tools）', inline: '全量内联', none: '未注入工具' };
function normalizeTraceEvents(t: TracePayload): TraceEvent[] {
  return t.trace.events;
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
const canRerun = computed(() => s.can('runs:write') && canOfferRerun(detail.value?.console_execution));
const detailRerunHint = computed(() => detail.value ? rerunHint(detail.value.console_execution) : '');
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

const filteredThreads = computed(() => {
  const q = threadQ.value.trim().toLowerCase();
  if (!q) return threads.value;
  return threads.value.filter((t) => {
    const hay = [partyLabel(t), whoLabel(t), t.last_preview, t.route_name, t.scope_key].join(' ').toLowerCase();
    return hay.includes(q);
  });
});

function applyRunPage(rows: any[], append: boolean): void {
  const page = rows.slice(0, RUNS_PAGE);
  list.value = append ? [...list.value, ...page] : page;
  runsMore.value = rows.length > RUNS_PAGE;
  knownRunRoutes.value = [...new Set([...knownRunRoutes.value, ...page.map(runRouteKey).filter(Boolean)])];
}

async function load(): Promise<void> {
  const generation = ++runsGeneration;
  const query = runFilterParams(runFilters);
  const key = query.toString();
  if (key !== requestedRunsKey) { list.value = []; runsMore.value = false; runsLoadedAt.value = ''; }
  requestedRunsKey = key;
  loading.value = true; moreLoading.value = false; runsError.value = '';
  query.set('limit', String(RUNS_PAGE + 1)); query.set('offset', '0');
  try {
    const rows = await api<any[]>('/admin/api/runs?' + query);
    if (generation !== runsGeneration) return;
    applyRunPage(rows, false); runsLoadedAt.value = new Date().toISOString();
  } catch (error) {
    if (generation === runsGeneration) runsError.value = (error as Error).message || '暂时无法读取任务列表，请刷新重试。';
  }
  finally { if (generation === runsGeneration) loading.value = false; }
}
async function loadMoreRuns(): Promise<void> {
  if (loading.value || moreLoading.value || !runsMore.value) return;
  const generation = runsGeneration;
  const query = runFilterParams(runFilters);
  if (query.toString() !== requestedRunsKey) return;
  query.set('limit', String(RUNS_PAGE + 1)); query.set('offset', String(list.value.length));
  const last = list.value.at(-1);
  if (last?.created_at && last.job_id) {
    query.set('before_created_at', last.created_at);
    query.set('before_job_id', last.job_id);
  }
  moreLoading.value = true;
  try {
    const rows = await api<any[]>('/admin/api/runs?' + query);
    if (generation === runsGeneration) applyRunPage(rows, true);
  } catch (e) { if (generation === runsGeneration) ElMessage.error((e as Error).message); }
  finally { if (generation === runsGeneration) moreLoading.value = false; }
}
async function loadThreads(): Promise<void> {
  const generation = ++threadsGeneration;
  threadsLoading.value = true; threadsError.value = '';
  try {
    const rows = await api<any[]>(`/admin/api/threads?limit=${THREADS_PAGE}&offset=0`);
    if (generation !== threadsGeneration) return;
    threads.value = rows; threadsLoaded.value = true; threadsMore.value = rows.length === THREADS_PAGE;
  }
  catch { if (generation === threadsGeneration) threadsError.value = threads.value.length ? '会话列表刷新失败，当前保留旧快照。' : '暂时无法读取会话列表，请刷新重试。'; }
  finally { if (generation === threadsGeneration) threadsLoading.value = false; }
}
async function loadMoreThreads(): Promise<void> {
  if (threadsLoading.value || threadsMoreLoading.value) return;
  const generation = threadsGeneration;
  threadsMoreLoading.value = true;
  try {
    const rows = await api<any[]>(`/admin/api/threads?limit=${THREADS_PAGE}&offset=${threads.value.length}`);
    if (generation === threadsGeneration) { threads.value = threads.value.concat(rows); threadsMore.value = rows.length === THREADS_PAGE; }
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { threadsMoreLoading.value = false; }
}
function onTab(name: string): void {
  if (name === readRunsLocation(route.query).tab) return;
  void router.push({ query: patchTaskQuery(route.query, { tab: runsTabQuery(name as RunsTab) }) });
}
function openRecordDirectory(): void { gotoThread(); }
function closeRecordDrawer(): void {
  const { position, rawRecordsOrigin } = router.options.history.state;
  if (typeof position === 'number' && typeof rawRecordsOrigin === 'number' && rawRecordsOrigin < position) {
    router.go(rawRecordsOrigin - position);
    return;
  }
  // A bookmark has no in-app opener; keep its optional conversation, turn and return destination.
  void router.replace({ query: patchTaskQuery(route.query, { tab: 'conversations', view: 'audit', thread: undefined }) });
}
function backToRecordDirectory(): void {
  const query = patchTaskQuery(route.query, { tab: 'conversations', view: 'legacy', thread: undefined });
  if (router.options.history.state.back === router.resolve({ query }).fullPath) router.back();
  else void router.replace({ query });
}
function refreshRecords(): void {
  if (curThread.value) void rawTranscript.value?.refresh(); else void loadThreads();
}
function persistThreadSearch(): void { void router.replace({ query: patchTaskQuery(route.query, { thread_q: threadQ.value || undefined }) }); }
function persistRunFilters(): void {
  void router.replace({ query: patchTaskQuery(route.query, { tab: 'jobs', run_status: runFilters.status || undefined,
    run_route: runFilters.route.trim() || undefined, run_period: runFilters.period === 'all' ? undefined : runFilters.period }) });
}
function clearRunFilters(): void { Object.assign(runFilters, { status: '', route: '', period: 'all' }); persistRunFilters(); }
function refresh(): void {
  if (activeTab.value === 'notifications') void notificationPanel.value?.refresh();
  else if (activeTab.value === 'threads') void clientConversations.value?.refresh();
  else if (activeTab.value === 'trace') { if (traceJobInput.value.trim()) void lookupJobTrace(); }
  else void load();
}

async function openDetail(row: any): Promise<void> {
  if (detailOpen.value && detailJobId.value === row.job_id) { await loadDetail(row.job_id); return; }
  await router.push({ query: patchTaskQuery(route.query, { tab: runsTabQuery(activeTab.value), detail: row.job_id }) });
}
async function loadDetail(jobId: string): Promise<void> {
  const generation = ++detailGeneration;
  if (detail.value?.job_id !== jobId) { detail.value = null; traceEvents.value = []; traceSummary.value = null; detailLoadedAt.value = ''; }
  detailJobId.value = jobId; detailOpen.value = true; detailLoading.value = true; detailError.value = '';
  detailPanels.value = ['chain', 'result'];
  try {
    const t = await api<TracePayload>('/admin/api/runs/' + encodeURIComponent(jobId) + '/trace');
    if (generation !== detailGeneration) return;
    detail.value = t.job; traceEvents.value = normalizeTraceEvents(t); traceSummary.value = t.trace.summary ?? null;
    detailLoadedAt.value = new Date().toISOString();
  } catch { if (generation === detailGeneration) detailError.value = '暂时无法读取任务详情，请刷新重试。'; }
  finally { if (generation === detailGeneration) detailLoading.value = false; }
}
async function lookupJobTrace(persist = true): Promise<void> {
  const raw = traceJobInput.value.trim();
  if (!raw) { ElMessage.error('请输入要追溯的标识'); return; }
  traceRequestedRaw = raw;
  if (persist) void router.replace({ query: patchTaskQuery(route.query, { tab: 'trace', trace_q: raw, job: undefined,
    trace_from: raw === queryText(route.query.trace_q) ? traceFrom.value : undefined }) });
  const q = traceLookupQuery(raw);
  const generation = ++traceGeneration;
  if (q !== traceLoadedQuery) { traceLookupResult.value = null; traceLookupMatches.value = []; }
  traceLookupLoading.value = true; traceLookupError.value = ''; traceEmptyFor.value = '';
  try {
    const got = await api<TracePayload & { matches?: any[]; count?: number }>('/admin/api/runs/trace?' + q);
    if (generation !== traceGeneration) return;
    traceLoadedQuery = q; traceLoadedAt.value = new Date().toISOString();
    if (got.job) {
      traceLookupResult.value = got;
      traceLookupMatches.value = [];
    } else {
      traceLookupResult.value = null;
      traceLookupMatches.value = got.matches ?? [];
      if (!traceLookupMatches.value.length) traceEmptyFor.value = raw;
    }
  } catch (error) {
    if (generation !== traceGeneration) return;
    if (error instanceof ApiError && error.status === 404 && error.message === 'job 不存在') {
      traceLookupResult.value = null; traceLookupMatches.value = []; traceEmptyFor.value = raw;
    } else traceLookupError.value = '暂时无法读取追溯结果，请刷新重试。';
  }
  finally { if (generation === traceGeneration) traceLookupLoading.value = false; }
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
function openTraceMatch(row: { job_id: string }): void {
  void router.push({ query: patchTaskQuery(route.query, { tab: 'trace', job: undefined, trace_q: row.job_id, trace_from: traceRequestedRaw }) });
}
function returnToTraceMatches(): void {
  const query = patchTaskQuery(route.query, { trace_q: traceFrom.value, trace_from: undefined });
  if (router.options.history.state.back === router.resolve({ query }).fullPath) router.back();
  else void router.replace({ query });
}
function clearTraceLookup(): void {
  void router.replace({ query: patchTaskQuery(route.query, { trace_q: undefined, trace_from: undefined, job: undefined }) });
}
function openTraceLookupDetail(): void {
  if (!traceLookupResult.value) return;
  detailGeneration++; detailLoading.value = false;
  detail.value = traceLookupResult.value.job;
  detailJobId.value = detail.value.job_id; detailLoadedAt.value = traceLoadedAt.value;
  detailError.value = traceLookupError.value ? '追溯刷新失败，当前详情来自旧快照，请刷新核对。' : '';
  traceEvents.value = normalizeTraceEvents(traceLookupResult.value);
  traceSummary.value = traceLookupResult.value.trace.summary ?? null;
  detailPanels.value = ['chain', 'result'];
  detailOpen.value = true;
  void router.push({ query: patchTaskQuery(route.query, { tab: 'trace', detail: detailJobId.value }) });
}
function closeJobDetail(): void {
  const query = patchTaskQuery(route.query, { tab: runsTabQuery(activeTab.value), detail: undefined });
  if (router.options.history.state.back === router.resolve({ query }).fullPath) router.back();
  else void router.replace({ query });
}
async function copyJobId(jobId: string): Promise<void> {
  try { await navigator.clipboard.writeText(jobId); ElMessage.success('已复制原 Job ID，可用于核对原调用结果'); }
  catch { ElMessage.warning('复制失败，请选中上方 Job ID 手工复制。'); }
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
function gotoThread(threadId?: number): void {
  const { position, rawRecordsOrigin } = router.options.history.state;
  const origin = recordDrawerOpen.value ? rawRecordsOrigin : position;
  void router.push({
    query: patchTaskQuery(route.query, { tab: 'conversations', view: 'legacy', detail: undefined, job: undefined, thread: threadId ? String(threadId) : undefined }),
    state: { rawRecordsOrigin: typeof origin === 'number' ? origin : null },
  });
}
function selectAuditConversation(id: string): void { gotoAuditConversation(id); }
function selectChannelThread(id: number): void {
  void router.push({ query: patchTaskQuery(route.query, { tab: 'conversations', view: 'audit', channel_thread: String(id), conversation: undefined, turn: undefined, thread: undefined, detail: undefined, job: undefined }) });
}
function changeConversationSource(source: string): void {
  void router.push({ query: patchTaskQuery(route.query, { tab: 'conversations', view: 'audit', conversation_source: source === 'all' ? undefined : source, channel_thread: undefined, conversation: undefined, turn: undefined, thread: undefined, detail: undefined, job: undefined }) });
}
function backToConversationList(): void {
  void router.push({ query: patchTaskQuery(route.query, { tab: 'conversations', view: 'audit', thread: undefined, channel_thread: undefined, conversation: undefined, turn: undefined }) });
}
function gotoAuditConversation(id: string, turnId?: string): void {
  void router.push({ query: patchTaskQuery(route.query, { tab: 'conversations', view: 'audit', detail: undefined, job: undefined, thread: undefined, channel_thread: undefined, conversation: id, turn: turnId || undefined }) });
}
async function rerun(): Promise<void> {
  if (!canRerun.value || detailLoading.value || detailError.value || rerunning.value) return;
  const jobId = detail.value.job_id;
  rerunning.value = true;
  try {
    await api('/admin/api/runs/' + jobId + '/rerun', { method: 'POST', body: '{}' });
    ElMessage.success('原任务已重新入队，尚未确认执行结果');
    if (detailOpen.value && detailJobId.value === jobId) await openDetail({ job_id: jobId });
    await load();
  } catch (e) {
    if (detailJobId.value === jobId) detailError.value = `重新执行请求未得到完整确认：${(e as Error).message}。请先刷新核对原任务状态，不要重复提交。`;
  } finally { rerunning.value = false; }
}
function applyLocation(): void {
  if (route.path !== '/runs') return;
  const location = readRunsLocation(route.query);
  Object.assign(runFilters, readRunFilters(route.query));
  if (location.tab === 'runs' && runFilterParams(runFilters).toString() !== requestedRunsKey) void load();
  activeTab.value = location.tab;
  auditConversationId.value = location.conversation; auditTurnId.value = location.turn;
  threadQ.value = location.threadQ; traceJobInput.value = location.traceQ;
  if (location.tab === 'threads' && location.view === 'legacy') {
    if (!location.thread && !threadsLoaded.value && !threadsLoading.value) void loadThreads();
    curThread.value = location.thread;
    if (location.thread) lastOpenedThread.value = location.thread;
  }
  if (location.tab === 'trace' && location.traceQ && location.traceQ !== traceRequestedRaw) void lookupJobTrace(false);
  else if (!location.traceQ) { traceGeneration++; traceRequestedRaw = ''; traceLoadedQuery = ''; traceEmptyFor.value = ''; traceLookupResult.value = null; traceLookupMatches.value = []; traceLookupError.value = ''; traceLookupLoading.value = false; }
  if (location.detail && (!detailOpen.value || detailJobId.value !== location.detail)) void loadDetail(location.detail);
  else if (!location.detail && detailOpen.value) { detailGeneration++; detailOpen.value = false; detailLoading.value = false; detailJobId.value = ''; }
}
watch(curThread, async (id, previous) => {
  if (!recordDrawerOpen.value || !recordContents.value) return;
  await nextTick();
  const selector = id ? '[data-record-list]' : `[data-thread-id="${previous}"]`;
  const target = recordContents.value?.querySelector<HTMLElement>(selector) || recordContents.value?.querySelector('input');
  target?.focus({ preventScroll: true });
});
onMounted(applyLocation);
watch(() => route.query, applyLocation);
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.runCount { margin: 6px 0; }
.runsTable { cursor: pointer; }
.runCellLine { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runSubject { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-width: 100%; overflow: hidden; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; padding: 0; border: 0; background: transparent; cursor: pointer; font-family: inherit; font-size: inherit; font-weight: 600; text-align: left; color: var(--el-text-color-primary); }
.runSubject:hover, .runSubject:focus-visible { color: var(--el-color-primary); text-decoration: underline; }
.errorText { color: var(--el-color-danger); }
.run-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 4px 0 14px; }
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

	:global(.runDetailDrawer .el-drawer__header) { margin-bottom: 0; padding: 18px 22px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
	:global(.runDetailDrawer .el-drawer__body) { padding: 16px 22px 24px; }
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

/* 授权与业务接入记录侧栏 */
:global(.rawRecordDrawer .el-drawer__header) { margin-bottom: 0; padding: 16px 20px; border-bottom: 1px solid var(--el-border-color-lighter); }
:global(.rawRecordDrawer .el-drawer__body) { padding: 0; min-height: 0; }
.recordContents { display: flex; flex-direction: column; height: 100%; }
.recordTools { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.rail { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--el-bg-color); }
.railsearch { padding: 10px 16px; }
.raillist { flex: 1; overflow-y: auto; }
.threaditem { display: block; width: 100%; text-align: left; padding: 12px 16px; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.threaditem:hover { background: var(--el-fill-color-light); }
.threaditem.active { background: var(--el-color-primary-light-9); }
.threaditem.active .who { color: var(--el-color-primary); }
.threaditem:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.trow1 { display: flex; align-items: center; gap: 6px; }
.trow1 .who { font-weight: 600; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trow1 .tcount { margin-left: auto; flex: none; }
.tprev { margin: 3px 0 2px; font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tmeta { font-size: 11px; }
.traceLookup { display: flex; align-items: center; gap: 6px; max-width: 720px; margin-bottom: 14px; }
.traceReturn { margin-bottom: 12px; }
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
	  :global(.runDetailDrawer .el-drawer__body) { padding: 12px 14px 18px; }
	  .detailStats { grid-template-columns: minmax(0, 1fr); }
	  .detailActions { justify-content: flex-start; }
	}
	</style>
