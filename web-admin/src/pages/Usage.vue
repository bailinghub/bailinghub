<template>
  <el-card class="billing-page" shadow="never">
    <template #header>
      <div class="page-heading">
        <div class="page-title">
          <b>用户与用量</b>
          <UsageHelp title="用户与用量说明">
            <p v-if="editing">编辑套餐时，左侧配置模型、倍率与额度，右侧预览用户看到的套餐。返回箭头回到套餐列表，保存后配置才会生效。</p>
            <p>套餐售价与周期额度分别填写：额度包一次获得与售价等额的消费额度；周期套餐每次重置为指定周期额度，不按售价自动平分。实际用量按绑定的 OpenRouter 参考价格计算，再乘套餐统一倍率。支付、开通与汇率由业务侧处理。</p>
            <p>计费模型选填：留空按调用模型标识精确匹配 OpenRouter，填写后优先使用指定标识；不改变模型调用地址或凭证。多个参考端点需明确选择。</p>
            <p>周期套餐按每周期额度估算，额度包按整包额度估算。每个模型均假设独占该额度，已计入统一倍率，不平均分配、不可相加。对话按输入∶输出 3∶1、未命中缓存估算，实际按真实用量结算；图片按报价档位展示。</p>
            <p>参考价格不代表实际供应商账单；模型调用仍使用已配置凭证。每笔请求保存价格与倍率快照，不重算历史费用。参考价格未知时不能按免费处理。</p>
            <p>周期按开通时间起算；未用完不累积，最后不足一个周期仍发放完整周期额度，但到套餐到期即失效。售价不代表供应商成本或保证利润。</p>
            <p>额度包显示积分（1 美元额度 = 1,000 积分）；周期套餐显示本期剩余百分比。Token 保留为原始用量，不用于余额和百分比。未取得可信用量时显示待计量。</p>
            <p>模型工具由客户端注册和编排。图片适配可执行；未适配的视频、语音等仅可保存声明，不会假装可调用。</p>
            <p>移除套餐只检查启用账户当前有效或待生效的开通；已替换、已到期或已停用的关联不阻止删除。删除后保留历史请求与账本，不恢复原套餐。额度耗尽只阻止新请求，已接纳的回复正常完成。</p>
          </UsageHelp>
        </div>
        <div class="actions">
          <router-link to="/usage-access"
            ><el-button>接入设置</el-button></router-link
          ><el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="!loading && !supported"
      title="用量套餐尚未就绪。请检查当前版本与迁移。账户与身份来源可在“接入设置”中管理。"
      type="info"
      :closable="false"
      show-icon
    />
    <div v-if="pending" class="pending panel">
      <b>上一次保存需要核对</b>
      <p>
        已保留原请求。网络恢复后可核对原结果，避免重复开通；核对完成前暂停其他配置变更。
      </p>
      <el-button
        :loading="saving"
        :disabled="pendingNeedsBilling"
        type="primary"
        @click="retryPending"
        >核对 / 重试原请求</el-button
      >
    </div>
    <div class="console-page-tabs">
      <div class="console-page-tabs-actions">
        <template v-if="tab === 'models'">
          <router-link v-if="me.can('credentials:read')" to="/credentials"><el-button>管理模型凭证</el-button></router-link>
          <el-button v-if="canIssuers" :disabled="blocked" type="primary" @click="openService()">添加模型服务</el-button>
        </template>
        <el-button v-else-if="tab === 'plans' && !editing && canWrite" type="primary" :disabled="blocked" @click="openPlan()">新建套餐</el-button>
        <router-link v-else-if="tab === 'accounts'" to="/usage-access?tab=accounts"><el-button>管理账户与成员</el-button></router-link>
      </div>
    <el-tabs v-model="tab" class="section-tabs">
      <el-tab-pane label="模型服务" name="models">
        <div v-if="services.length" class="model-grid">
          <article
            v-for="service in services"
            :key="service.id"
            class="panel model-card"
          >
            <div class="card-top">
              <h3>{{ service.label }}</h3>
              <el-tag
                :type="serviceReady(service) ? 'success' : service.state === 'suspended' ? 'info' : 'warning'"
                effect="plain"
                >{{ serviceReady(service) ? "可选用" : service.state === "suspended" ? "已停用" : "未就绪" }}</el-tag
              >
            </div>
            <el-tag effect="plain">{{ purposeOf(service) === "tool" ? "模型工具" : "对话模型" }}</el-tag>
            <code>{{ service.config.model }}</code>
            <p class="muted">
              凭证：{{ service.config.credential }}<br />模型服务：{{
                service.id
              }}
            </p>
            <p v-if="!serviceReady(service)" class="service-warning">{{ serviceUnavailableReason(service) }}</p>
            <div class="card-bottom">
              <el-button
                v-if="canIssuers"
                link
                type="primary"
                :disabled="blocked"
                @click="openService(service)"
                >{{ serviceConfigurationLabel(service) }}</el-button
              >
              <el-button
                v-if="canIssuers"
                link
                type="danger"
                :disabled="blocked"
                @click="deleteService(service)"
                >删除</el-button
              >
            </div>
          </article>
        </div>
        <el-empty
          v-else
          description="还没有模型服务。先配置模型凭证，再添加供套餐使用的模型。"
        />
      </el-tab-pane>

      <el-tab-pane label="套餐管理" name="plans" :disabled="!supported">
        <template v-if="!editing">
          <el-table :data="plans" row-key="id"
            ><el-table-column label="套餐" min-width="205"
              ><template #default="{ row }"
                ><b>{{ row.label }}</b>
                <div class="muted">
                  {{ row.config.mode === "periodic" ? "周期套餐" : "额度包" }} ·
                  {{ row.state === "active" ? "可开通" : "暂停开通" }}
                </div></template
              ></el-table-column
            >
            <el-table-column label="所见额度" min-width="210">
              <template #default="{ row }">
                <b
                  >{{ row.config.mode === "periodic" ? "剩余 " : ""
                  }}{{ presentationAmount(previewPresentation(row.config)) }}
                  {{ presentationUnit(previewPresentation(row.config)) }}</b
                >
                <div class="muted">
                  {{
                    row.config.mode === "periodic"
                      ? periodText(row.config.periodUnit) + "重置"
                      : "一次发放，用完为止"
                  }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="套餐售价" min-width="170"
              ><template #default="{ row }">{{
                usd(row.config.priceUsd)
              }}<div v-if="row.config.mode === 'periodic'" class="muted">周期额度 {{ row.config.periodAllowanceUsd ? usd(row.config.periodAllowanceUsd) : '待配置' }}</div></template></el-table-column
            ><el-table-column label="统一倍率" width="100"><template #default="{row}">{{ row.config.multiplier }}×</template></el-table-column><el-table-column label="有效期" min-width="140"
              ><template #default="{ row }">{{
                durationText(row.config)
              }}</template></el-table-column
            ><el-table-column label="可用模型" min-width="170"
              ><template #default="{ row }"
                ><div v-for="id in row.config.serviceIds" :key="id">
                  {{ serviceLabel(id) }}
                </div>
                <span v-if="!row.config.serviceIds.length" class="muted"
                  >暂无可用模型或工具</span
                ></template
              ></el-table-column
            ><el-table-column label="操作" width="235" align="right" fixed="right"
              ><template #default="{ row }"
                ><el-button
                  v-if="canWrite"
                  link
                  type="primary"
                  :disabled="blocked"
                  @click="openPlan(row)"
                  >编辑</el-button
                ><el-button
                  v-if="canAdjust"
                  link
                  type="primary"
                  :disabled="blocked || row.state !== 'active'"
                  @click="openGrant(undefined, row.id)"
                  >开通给账户</el-button
                ><el-button v-if="canWrite" link type="danger" :disabled="blocked" @click="deletePlan(row)">删除</el-button></template
              ></el-table-column
            ><template #empty
              >还没有 用量套餐。新建套餐后，再为指定账户开通。</template
            ></el-table
          >
        </template>
        <template v-else>
          <div class="plan-editor-heading">
            <el-button :icon="ArrowLeft" circle aria-label="返回套餐列表" title="返回套餐列表" @click="editing = false" />
            <h2>{{ form.revision ? "编辑套餐" : "新建套餐" }}</h2>
          </div>
          <div v-if="!billingReady" class="billing-notice">
            <el-alert
              :title="billingWarning"
              type="warning"
              :closable="false"
            />
          </div>
          <div class="editor-layout">
            <el-form
              novalidate
              class="plan-form" size="default"
              label-position="top"
              :disabled="blocked || !canWrite"
              @submit.prevent="savePlan"
            >
              <section class="panel form-section plan-settings">
                <div class="form-grid plan-settings-grid">
                  <el-form-item label="套餐名称"><el-input v-model="form.label" maxlength="120" placeholder="例如：标准套餐" /></el-form-item>
                  <el-form-item label="套餐类型"><el-select v-model="form.mode"><el-option value="credits" label="额度包 · 显示积分"/><el-option value="periodic" label="周期套餐 · 显示百分比"/></el-select></el-form-item>
                  <el-form-item label="套餐售价（USD）"><el-input-number v-model="form.priceUsd" :min="0.01" :max="1000000" :precision="2" :controls="false" /></el-form-item>
                  <el-form-item label="统一计费倍率"><el-input-number v-model="form.multiplier" :min="0.000001" :max="1000" :precision="6" :controls="false" /></el-form-item>
                  <el-form-item v-if="form.mode === 'periodic'" label="重置周期"><el-select v-model="form.periodUnit"><el-option label="每天" value="day"/><el-option label="每周" value="week"/><el-option label="每月" value="month"/></el-select></el-form-item>
                  <el-form-item v-if="form.mode === 'periodic'" label="周期额度（USD）"><el-input-number v-model="form.periodAllowanceUsd" :min="0.01" :max="1000000" :precision="2" :controls="false" placeholder="每个周期可用的额度" /></el-form-item>
                  <el-form-item label="有效期"><div class="duration-field"><el-input-number v-if="form.durationUnit !== 'forever'" v-model="form.durationCount" :min="1" :max="1200" :precision="0" :controls="false"/><el-select v-model="form.durationUnit"><el-option label="个月" value="month"/><el-option label="天" value="day"/><el-option v-if="form.mode === 'credits'" label="持续有效" value="forever"/></el-select></div></el-form-item>
                </div>
              </section>
              <section v-for="group in serviceGroups" :key="group.purpose" class="panel form-section">
                <h3>{{ group.label }}<span class="model-estimate-heading">{{ estimateHeading }}</span></h3>
                <el-checkbox-group v-model="form.serviceIds" class="model-choices">
                  <div v-for="service in services.filter(s => purposeOf(s) === group.purpose)" :key="service.id" class="model-choice-row">
                    <el-checkbox :value="service.id" :disabled="!serviceReady(service) && !form.serviceIds.includes(service.id)"><span><b>{{ service.label }}</b><small>{{ service.config.model }}</small><small v-if="!serviceReady(service)" class="service-warning">{{ form.serviceIds.includes(service.id) ? '已选服务暂不可用：' : '' }}{{ serviceUnavailableReason(service) }}</small></span></el-checkbox>
                    <div class="model-estimate">
                      <template v-if="planEstimates(service).length">
                        <div v-for="(estimate,i) in planEstimates(service)" :key="i" class="estimate-scenario"><small>{{ estimate.label }} · {{ estimate.prices }}</small><strong>{{ estimate.estimate }}</strong><small>{{ estimate.assumption }}</small></div>
                        <small class="quote-source">OpenRouter · {{ service.reference_price?.modelId }} · {{ service.reference_price?.endpointId }} · {{ time(service.reference_price?.fetchedAt || 0) }}{{ quoteStale(service) ? ' · 缓存报价，待更新' : '' }}</small>
                      </template>
                      <span v-else class="muted">{{ !estimateBudget ? '请先填写有效额度' : service.config.pricing ? '未取得可用参考价格，暂无法估算' : '尚未配置参考价格，暂无法估算' }}</span>
                    </div>
                    <el-button v-if="!serviceReady(service) && canIssuers" link type="primary" :disabled="blocked" @click="openService(service)">{{ serviceConfigurationLabel(service) }}</el-button>
                  </div>
                </el-checkbox-group>
                <p v-if="!services.some(s => purposeOf(s) === group.purpose)" class="muted">尚未添加{{ group.label }}</p>
              </section>
              <el-alert v-if="form.mode === 'periodic' && !periodAllowanceSupported" title="当前为周期额度预览，配套计费版本启用后可保存。" type="info" :closable="false" />
              <el-alert v-if="!form.serviceIds.length" title="未选择服务时，客户端显示暂无可用模型或工具。" type="info" :closable="false" />
              <section class="panel form-section advanced">
                <details>
                  <summary>
                    更多选项 <span class="muted">开通状态</span>
                  </summary>
                  <div class="advanced-content">
                    <el-form-item label="是否允许新开通"
                      ><el-switch
                        v-model="form.active"
                        active-text="允许开通"
                        inactive-text="暂停开通"
                    /></el-form-item>
                    <p class="muted">
                      暂停开通不影响已有账户。模型列表更新即时生效，额度与有效期配置只用于以后开通。
                    </p>
                  </div>
                </details>
              </section>
              <el-alert
                v-if="formError"
                :title="formError"
                type="error"
                :closable="false"
                show-icon
              />
              <div class="form-footer">
                <span class="muted"
                  >保存模型列表后，已有账户刷新即可看到；新账户仍需开通套餐。</span
                ><el-button
                  type="primary"
                  native-type="submit"
                  :loading="saving"
                  :disabled="!billingReady || (form.mode === 'periodic' && !periodAllowanceSupported)"
                  >保存套餐</el-button
                >
              </div>
            </el-form>
            <aside class="preview panel">
              <div class="preview-eyebrow">用户侧说明预览</div>
              <h3>{{ form.label || "未命名套餐" }}</h3>
              <p class="muted">
                {{ form.mode === "periodic" ? "本期剩余" : "可用积分" }}
              </p>
              <div class="preview-amount">
                {{ presentationAmount(planPresentation)
                }}<small>{{ presentationUnit(planPresentation) }}</small>
              </div>
              <p class="preview-unit">
                {{
                  planPresentation.state === "unavailable"
                    ? "请填写有效额度"
                    : form.mode === "periodic"
                      ? "开通后每期恢复至 100%"
                      : "开通后一次到账"
                }}
              </p>
              <div class="preview-rule">
                <span>有效期</span><b>{{ durationText(previewConfig) }}</b>
              </div>
              <div class="preview-rule">
                <span>额度更新</span
                ><b>{{
                  form.mode === "periodic"
                    ? periodText(form.periodUnit) + "重置"
                    : "一次发放"
                }}</b>
              </div>
              <div class="preview-models">
                <span class="muted">可用模型</span>
                <div class="tags">
                  <el-tag
                    v-for="id in form.serviceIds"
                    :key="id"
                    effect="plain"
                    >{{ serviceLabel(id) }}</el-tag
                  ><span v-if="!form.serviceIds.length" class="muted"
                    >暂无可用模型或工具</span
                  >
                </div>
              </div>
              <ul>
                <li>按参考费用乘套餐统一倍率扣除。</li>
                <li>所有对话模型与工具共用一份额度。</li>
                <li>当前模型回复完成后，额度不足再停止新请求。</li>
              </ul>
              <p class="preview-note">
                用量可能稍晚更新，允许少量超出。{{
                  form.mode === "periodic"
                    ? "本期剩余额度不累积到下一期。"
                    : "未用积分在套餐有效期内可用。"
                }}
              </p>
            </aside>
          </div>
        </template>
      </el-tab-pane>

      <el-tab-pane label="账户用量" name="accounts" :disabled="!supported">
        <el-table :data="accounts" row-key="id"
          ><el-table-column label="账户" min-width="220"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="openAccount(row)">{{
                row.label
              }}</el-button>
              <div class="muted mono">{{ row.id }}</div></template
            ></el-table-column
          ><el-table-column label="类型" width="140"
            ><template #default="{ row }">{{
              row.kind === "organization" ? "组织共享" : "个人"
            }}</template></el-table-column
          ><el-table-column label="状态" width="120"
            ><template #default="{ row }"
              ><el-tag :type="row.state === 'active' ? 'success' : 'info'">{{
                row.state === "active" ? "可用" : "已停用"
              }}</el-tag></template
            ></el-table-column
          ><el-table-column label="操作" width="220" align="right" fixed="right"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="openAccount(row)"
                >查看用量</el-button
              ><el-button
                v-if="canAdjust"
                link
                type="primary"
                :disabled="blocked || row.state !== 'active'"
                @click="openGrant(row)"
                >开通 / 更换套餐</el-button
              ></template
            ></el-table-column
          ><template #empty
            >还没有账户。请先配置身份来源，由业务产品完成一次可信登录。</template
          ></el-table
        >
        <div v-if="accountCursor" class="more">
          <el-button :loading="accountsLoading" @click="loadAccounts(true)"
            >加载更多账户</el-button
          >
        </div>
      </el-tab-pane>
    </el-tabs>
    </div>
  </el-card>

    <UsageDeletionPreview v-model="deletion.open.value" :label="deletion.label.value"
      :report="deletion.report.value" :loading="deletion.loading.value" :busy="blocked"
      :error="deletion.error.value"
      @refresh="deletion.refresh" @delete="confirmDeletePlan" />
    <UsageServiceReferences
      v-model="referencesOpen"
      :label="referenceService?.label || ''"
      :report="serviceReferences"
      :loading="referencesLoading"
      :busy="blocked"
      :error="referencesError"
      :can-edit-plans="canWrite"
      @refresh="loadServiceReferences"
      @delete="confirmDeleteService"
      @plan="openReferencePlan"
    />
    <el-drawer
      v-model="detailOpen"
      :title="selectedAccount?.label || '账户用量'"
      size="min(960px, 96vw)"
      @closed="openDeferredGrant"
      ><div class="account-detail" v-loading="detailLoading">
        <el-alert
          v-if="detailError"
          :title="detailError"
          type="error"
          :closable="false"
        /><template v-if="summary"
          ><div class="section-heading">
            <div>
              <h2>{{ summary.grant?.label || "尚未开通套餐" }}</h2>
              <p>
                {{
                  summary.grant
                    ? grantStatus(summary)
                    : "开通后即可使用套餐内模型。"
                }}
              </p>
            </div>
            <div class="actions">
              <el-button @click="loadDetail">刷新用量</el-button
              ><el-button v-if="canAdjust && summary.grant && !externalGrant"
                :disabled="blocked || !billingReady || !canResetAllowance"
                @click="resetAllowance">重置额度</el-button><el-button
                v-if="canAdjust"
                :disabled="blocked || externalGrant"
                type="primary"
                @click="openGrant(selectedAccount || undefined)"
                >{{ summary.grant ? "更换套餐" : "开通套餐" }}</el-button
              >
            </div>
          </div>
          <el-alert
            v-if="summary.grant"
            :type="accountModelIds.length ? 'info' : 'warning'"
            :closable="false"
            :title="
              accountModelIds.length
                ? '可用模型跟随套餐更新，共享本账户的剩余额度。'
                : '该套餐暂无可用模型或工具；原额度、重置和到期时间保持不变。'
            "
            :description="`所属套餐：${summary.plan?.label || summary.grant.label} · ${summary.grant.planId}。当前模型：${accountModelIds.map(serviceLabel).join('、') || '暂无可用模型或工具'}。`"
          />
          <section class="customer-preview panel" aria-label="账户用户可见预览">
            <div class="preview-eyebrow">用户侧用量预览</div>
            <div class="customer-amount-row">
              <div>
                <p class="muted">
                  {{
                    accountPresentation.kind === "percentage"
                      ? "本期剩余"
                      : accountPresentation.kind === "credits"
                        ? "可用积分"
                        : "当前额度"
                  }}
                </p>
                <div class="preview-amount">
                  {{ presentationAmount(accountPresentation)
                  }}<small>{{ presentationUnit(accountPresentation) }}</small>
                </div>
              </div>
              <el-tag
                :type="
                  accountPresentation.state === 'active' ? 'success' : 'info'
                "
                >{{
                  summary.grant
                    ? accountPresentation.state === "active" &&
                      !accountModelIds.length
                      ? "额度保留"
                      : presentationState(accountPresentation)
                    : "尚未开通"
                }}</el-tag
              >
            </div>
            <el-progress
              v-if="
                accountPresentation.kind === 'percentage' &&
                accountPresentation.remaining !== null
              "
              :percentage="accountPresentation.remaining"
              :show-text="false"
            />
            <p v-if="summary.pendingRequests > 0" class="muted">
              {{ number(summary.pendingRequests) }}
              笔用量待更新，已完成的回复不受影响。
            </p>
            <p v-if="summary.grant" class="muted">
              {{
                summary.resetAt
                  ? "下次重置：" + time(summary.resetAt) + " · "
                  : ""
              }}{{
                summary.expiresAt
                  ? "有效期至：" + time(summary.expiresAt)
                  : "持续有效"
              }}
            </p>
            <p v-else class="muted">开通套餐后即可查看用量。</p>
          </section>
          <section class="operator-accounting">
            <div class="section-heading">
              <div>
                <h3>运营计量</h3>
                <p>美元消耗与供应商原始用量分别记录。</p>
              </div>
            </div>
            <template v-if="summary.grant">
              <div class="metrics">
                <div>
                  <span>剩余额度</span
                  ><strong>{{ number(summary.availableUsd) }}</strong
                  ><small>USD</small>
                </div>
                <div>
                  <span>{{
                    summary.grant.config.mode === "periodic"
                      ? "本期已用"
                      : "已用额度"
                  }}</span
                  ><strong>{{ number(periodConsumed(summary)) }}</strong
                  ><small>USD</small>
                </div>
                <div>
                  <span>待计量请求</span
                  ><strong>{{ number(summary.pendingRequests) }}</strong
                  ><small>用量到账后更新</small>
                </div>
              </div>

              <el-alert
                v-if="summary.overageUsd > 0"
                :title="`当前额度已超出 ${number(summary.overageUsd)} USD。原回复保留，新请求等待下一期额度或新套餐。`"
                type="warning"
                :closable="false"
              />
              <div class="panel grant-details">
                <div>
                  <span>有效期至</span
                  ><b>{{ time(summary.expiresAt, "持续有效") }}</b>
                </div>
                <div>
                  <span>下次重置</span
                  ><b>{{ time(summary.resetAt, "不重置") }}</b>
                </div>
                <div>
                  <span>可用模型</span>
                  <div class="account-models">
                    <div v-for="id in accountModelIds" :key="id">
                      <b>{{ serviceLabel(id) }}</b
                      >
                    </div>
                    <b v-if="!accountModelIds.length">暂无可用模型或工具</b>
                  </div>
                </div>
                <p v-if="externalGrant" class="muted">
                  此套餐由业务后端维护，请在原来源调整；这里保留用量与状态查询。
                </p>
                <p v-if="!billingReady" class="muted">
                  计费内核尚未就绪，暂不可调整套餐。
                </p>
                <el-button
                  v-if="canAdjust && !externalGrant"
                  :disabled="blocked || !billingReady"
                  @click="controlGrant"
                  >{{
                    summary.grant.state === "active" ? "暂停新请求" : "恢复使用"
                  }}</el-button
                >
              </div></template
            >
            <div class="section-heading">
              <div>
                <h3>最近的模型请求</h3>
                <p>只读取用量和原请求状态，不重新执行模型或业务操作。</p>
              </div>
            </div>
            <el-alert v-if="!billingReady" title="原请求计量明细在配套计费内核更新后可查看。当前套餐余额与有效期保持不变。" type="info" :closable="false" />
            <el-table v-else :data="requests" row-key="operation_id"
              ><el-table-column label="原请求" min-width="190"
                ><template #default="{ row }"
                  ><code>{{ row.operation_id }}</code>
                  <div class="muted">
                    {{ serviceLabel(row.service_id) }}
                  </div></template
                ></el-table-column
              ><el-table-column label="结果" min-width="120"
                ><template #default="{ row }"><el-tooltip v-if="row.error" :content="[row.error.message, row.error.http_status ? 'HTTP ' + row.error.http_status : '', row.error.provider_code || '', row.error.provider_request_id ? '请求号：' + row.error.provider_request_id : ''].filter(Boolean).join(' · ')"><span>{{ resultState(row.result_state) }}</span></el-tooltip><span v-else>{{ resultState(row.result_state) }}</span></template></el-table-column
              ><el-table-column label="计量" min-width="130"
                ><template #default="{ row }">{{
                  row.billing_state === "settled" ? "已结算" : "待计量"
                }}</template></el-table-column
              ><el-table-column label="套餐消耗（USD）" min-width="180"
                ><template #default="{ row }"
                  ><b>{{
                    row.billed_usd === null ||
                    row.billed_usd === undefined
                      ? "待计量"
                      : number(row.billed_usd)
                  }}</b>
                  <div v-if="row.usage?.inputTokens != null && row.usage?.outputTokens != null" class="muted">
                    实际 Token：输入 {{ number(row.usage.inputTokens) }} / 输出
                    {{ number(row.usage.outputTokens) }}
                  </div>
                  <div class="muted">参考费用：{{ row.reference_cost_usd == null ? '待计量' : usd(row.reference_cost_usd) }}</div>
                  <div v-if="row.billing_rate" class="muted">统一倍率 × {{ row.billing_rate.multiplier }}</div>
                  <div v-if="row.usage?.inputTokens == null || row.usage?.outputTokens == null" class="muted">Token：未提供</div><div v-if="row.raw_usage?.outputImageCount != null" class="muted">输出图片：{{ row.raw_usage.outputImageCount }} 张</div>
                  </template
                ></el-table-column
              ><template #empty>尚无 模型请求。</template></el-table
            >
            <div v-if="requestCursor" class="more">
              <el-button :loading="requestsLoading" @click="loadRequests(true)"
                >加载更多请求</el-button
              >
            </div>
          </section></template
        >
      </div></el-drawer
    >

    <el-drawer
      v-model="grantOpen"
      title="为账户开通套餐"
      size="min(520px, 100vw)"
      class="usage-config-drawer"
      @closed="returnToAccount"
      :close-on-click-modal="false"
      ><el-alert
        v-if="!billingReady"
        :title="billingWarning"
        type="warning"
        :closable="false"
        class="template-note"
      /><el-form
        size="default"
        novalidate
        label-position="top"
        :disabled="blocked || grantLoading"
        @submit.prevent="grant"
        ><el-form-item label="用量账户"
          ><el-select
            v-model="grantAccountId"
            filterable
            placeholder="选择已有账户"
            @change="loadGrantSummary"
            ><el-option
              v-for="account in accounts"
              :key="account.id"
              :value="account.id"
              :label="account.label"
              :disabled="account.state !== 'active'" /></el-select
          ><el-button
            v-if="accountCursor"
            link
            :loading="accountsLoading"
            @click="loadAccounts(true)"
            >加载更多账户</el-button
          ></el-form-item
        ><el-form-item label="套餐"
          ><el-select v-model="grantPlanId" placeholder="选择套餐"
            ><el-option
              v-for="plan in plans.filter((p) => p.state === 'active')"
              :key="plan.id"
              :value="plan.id"
              :label="plan.label" /></el-select
        ></el-form-item>
        <div v-if="grantPlan" class="grant-preview panel">
          <b>{{ grantPlan.label }}</b>
          <p>
            {{ grantPlan.config.mode === "periodic" ? "剩余 " : ""
            }}{{ presentationAmount(previewPresentation(grantPlan.config)) }}
            {{ presentationUnit(previewPresentation(grantPlan.config)) }} ·
            {{
              grantPlan.config.mode === "periodic"
                ? periodText(grantPlan.config.periodUnit) + "重置"
                : "一次发放"
            }}
            · {{ durationText(grantPlan.config) }}
          </p>
          <p class="muted">
            {{ grantPlan.config.serviceIds.map(serviceLabel).join("、") }}
          </p>
        </div>
        <el-alert
          v-if="grantError"
          :title="grantError"
          type="error"
          :closable="false"
        /><el-alert
          v-else-if="grantSummary?.grant"
          :title="`将替换当前的“${grantSummary.grant.label}”，从现在开始获得一份新额度。原余额不结转；原请求仍归原账。`"
          type="warning"
          :closable="false"
        />
        <p class="muted">
          本次操作从开通时刻发放一份新额度，不收款，也不改变业务授权。
        </p>
      </el-form>
      <template #footer
        ><div class="drawer-actions">
          <el-button @click="grantOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="
              blocked ||
              grantLoading ||
              !canAdjust ||
              !billingReady ||
              !grantSummary ||
              !!grantError ||
              !grantPlan
            "
            @click="grant"
            >确认开通</el-button
          >
        </div></template
      >
    </el-drawer>

    <el-drawer
      v-model="serviceOpen"
      :title="serviceRevision ? '配置模型服务' : '添加模型服务'"
      size="min(540px, 100vw)"
      class="usage-config-drawer"
      :close-on-click-modal="false"
      ><el-form
        size="default"
        novalidate
        label-position="top"
        :disabled="blocked"
        @submit.prevent="saveService"
        ><div class="form-grid">
          <el-form-item label="客户端显示名称"
            ><el-input
              v-model="serviceForm.label"
              placeholder="例如：快速、深度思考" /></el-form-item
          ><el-form-item label="服务标识"
            ><el-input
              v-model="serviceForm.id"
              :disabled="serviceRevision > 0"
              placeholder="例如 general-chat" /></el-form-item
          ><el-form-item
            ><template #label
              >模型凭证</template
            ><el-select
              v-model="serviceForm.credential"
              filterable
              :loading="credentialsLoading"
              :disabled="!me.can('credentials:read') || !!credentialsError"
              placeholder="选择已有模型凭证"
              style="width: 100%"
              @change="onServiceCredentialChange"
            >
              <el-option
                v-for="credential in serviceCredentials"
                :key="credential.name"
                :value="credential.name"
                :label="
                  credential.name +
                  (credential.default_model
                    ? ' · ' + credential.default_model
                    : '')
                "
              />
              <el-option
                v-if="serviceForm.credential && !selectedServiceCredential"
                :value="serviceForm.credential"
                :label="serviceForm.credential + ' · 当前配置，待核对'"
                disabled
              />
              <template #footer>
                <router-link to="/credentials" class="credential-create-link">添加模型凭证</router-link>
              </template>
            </el-select>
            <p v-if="credentialsError" class="muted">
              {{ credentialsError }}
              <el-button link @click="loadServiceCredentials">重试</el-button>
            </p>
            <p v-else-if="!me.can('credentials:read')" class="muted">
              当前账号没有模型凭证查看权限，请联系管理员配置。
            </p>
            <p
              v-else-if="!credentialsLoading && !serviceCredentials.length"
              class="muted"
            >
              尚无可用于对话的模型凭证，请先添加。
            </p>
            </el-form-item
          ><el-form-item
            ><template #label
              >模型标识</template
            ><el-select
              v-model="serviceForm.model"
              filterable
              allow-create
              default-first-option
              :disabled="!serviceForm.credential"
              placeholder="选择模型，或输入自定义模型标识"
              style="width: 100%"
              @change="changeCallingModel"
            >
              <el-option
                v-for="model in serviceModelOptions"
                :key="model.value"
                :value="model.value"
                :label="model.label"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="服务用途"><el-radio-group v-model="serviceForm.purpose" @change="changePurpose"><el-radio-button value="chat">对话模型</el-radio-button><el-radio-button value="tool">模型工具</el-radio-button></el-radio-group></el-form-item>
        <div v-if="serviceForm.purpose === 'chat' || serviceForm.tool.capability === 'image_generation'" class="panel form-section">
          <el-form-item label="计费模型（选填）"><el-select v-model="serviceForm.referenceModel" filterable allow-create clearable default-first-option :loading="pricingLoading" :placeholder="serviceForm.model ? `留空使用 ${serviceForm.model}` : '留空使用调用模型标识'" @change="changeReferenceModel"><el-option v-for="m in priceModels" :key="m.id" :value="m.id" :label="`${m.label} · ${m.id}`"/></el-select></el-form-item>
          <div class="reference-match"><span>价格匹配：{{ effectiveReferenceModel || '请先选择调用模型' }}</span><el-button link type="primary" :loading="endpointsLoading" :disabled="!effectiveReferenceModel" @click="loadPriceEndpoints(true)">同步参考价格</el-button></div>
          <el-alert v-if="pricingError || selectedPriceIssue" :title="pricingError || selectedPriceIssue" type="warning" :closable="false"/>
          <details class="service-advanced" :open="!!effectiveReferenceModel && !serviceForm.referenceEndpoint"><summary>参考端点与价格{{ selectedPriceEndpoint ? ` · ${selectedPriceEndpoint.label}` : '' }}</summary>
            <el-form-item label="参考端点"><el-select v-model="serviceForm.referenceEndpoint" filterable :loading="endpointsLoading" :disabled="!effectiveReferenceModel" placeholder="多个报价时，请选择参考端点"><el-option v-for="e in priceEndpoints" :key="e.id" :value="e.id" :label="e.label + (e.unavailable ? ' · 计量规则暂不支持' : !e.pricing?.lines?.length ? ' · 未取得价格' : '')" :disabled="!!endpointPriceIssue(e)"/><el-option v-if="serviceForm.referenceEndpoint && !priceEndpoints.some(e => e.id === serviceForm.referenceEndpoint)" :value="serviceForm.referenceEndpoint" :label="serviceForm.referenceEndpoint + ' · 原绑定，待核对'" disabled/></el-select></el-form-item>
            <p>OpenRouter 参考价，不代表实际供应商账单。仅一个可用端点时自动选中，多个端点需选择；保存后生效。</p><p>最近同步：{{ priceFetchedAt ? time(priceFetchedAt) : '尚未取得' }}{{ pricingStale ? ' · 缓存报价，后台更新中' : '' }}</p><div v-if="selectedPriceEndpoint?.pricing"><div v-for="(line,i) in selectedPriceEndpoint.pricing.lines" :key="i">{{ line.billable }} · {{ line.variant || line.unit }} · ${{ line.costUsd }} / {{ line.unit }}</div></div>
          </details>
        </div>
        <template v-if="serviceForm.purpose === 'tool'">
          <div class="form-grid"><el-form-item label="工具能力"><el-select v-model="serviceForm.tool.capability" filterable allow-create default-first-option @change="changeToolCapability"><el-option label="图片生成" value="image_generation"/><el-option label="视频生成（仅声明）" value="video_generation"/><el-option label="语音生成（仅声明）" value="speech_generation"/></el-select></el-form-item><el-form-item label="调用名称"><el-input v-model="serviceForm.tool.name" placeholder="例如 generate_image"/></el-form-item></div>
          <el-form-item label="给 AI 的使用说明"><el-input v-model="serviceForm.tool.description" type="textarea" :rows="3" maxlength="1200"/></el-form-item>
          <el-form-item label="接口适配"><el-select v-model="serviceForm.tool.adapter"><el-option label="待适配（仅声明，不执行）" value="pending"/><el-option v-if="serviceForm.tool.capability === 'image_generation'" label="阿里云图片（OpenAI 兼容）" value="aliyun-image"/><el-option v-if="serviceForm.tool.capability === 'image_generation'" label="阿里云图片（DashScope 原生）" value="aliyun-image-native"/><el-option v-if="serviceForm.tool.capability === 'image_generation'" label="OpenRouter 图片生成" value="openrouter-image"/></el-select></el-form-item>
          <details class="service-advanced"><summary>参数与输出声明</summary><div v-for="(param,i) in serviceForm.tool.parameters" :key="i" class="tool-parameter"><el-input v-model="param.name" placeholder="参数名"/><el-select v-model="param.type"><el-option value="string" label="文字"/><el-option value="number" label="数字"/><el-option value="boolean" label="开关"/><el-option value="file" label="附件引用"/></el-select><el-checkbox v-model="param.required">必填</el-checkbox><el-button link type="danger" @click="serviceForm.tool.parameters.splice(i,1)">移除</el-button><el-input v-model="param.description" placeholder="参数说明"/></div><el-button link @click="serviceForm.tool.parameters.push({name:'',type:'string',required:false,description:''})">添加参数</el-button><el-form-item label="输出类型"><el-select v-model="serviceForm.tool.outputs" multiple filterable allow-create default-first-option><el-option label="图片" value="image"/><el-option label="视频" value="video"/><el-option label="音频" value="audio"/><el-option label="文件" value="file"/></el-select></el-form-item></details>
        </template>
        <el-switch
          v-model="serviceForm.active"
          active-text="服务启用"
          inactive-text="停止新请求"
        />
        <details class="service-advanced">
          <summary>模型规格与连接设置</summary>

          <div class="form-grid">
            <el-form-item label="输出 Token 上限"
              ><el-input-number
                v-model="serviceForm.maxOutputTokens"
                :min="1"
                :max="131072" /></el-form-item
            ><el-form-item label="上下文窗口（0 = 未登记）"
              ><el-input-number
                v-model="serviceForm.contextWindowTokens"
                :min="0"
                :max="10000000" /></el-form-item
            ><el-form-item label="模型输入能力"
              ><el-select v-model="serviceForm.modalities"
                ><el-option value="unknown" label="未登记" /><el-option
                  value="text"
                  label="文字" /><el-option
                  value="text_image"
                  label="文字与图片" /></el-select></el-form-item
            ><el-form-item label="请求超时（秒）"
              ><el-input-number
                v-model="serviceForm.timeoutSeconds"
                :min="1"
                :max="600" /></el-form-item
            ><el-form-item label="请求体最大字节数"
              ><el-input-number
                v-model="serviceForm.maxInputBytes"
                :min="1"
                :max="16777216" /></el-form-item
            ><el-form-item label="供应商账户引用"
              ><el-input
                v-model="serviceForm.providerScope"
                placeholder="同一上游账户使用固定引用"
            /></el-form-item>
          </div>
        </details>
        <el-alert
          v-if="serviceError"
          :title="serviceError"
          type="error"
          :closable="false"
        />
      </el-form>
      <template #footer
        ><div class="drawer-actions">
          <el-button @click="serviceOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="blocked || !canIssuers"
            @click="saveService"
            >保存服务</el-button
          >
        </div></template
      >
    </el-drawer>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ArrowLeft } from "@element-plus/icons-vue";
import { ElCheckboxGroup } from "element-plus/es/components/checkbox/index";
import { ElMessage } from "element-plus/es/components/message/index";
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import { api } from "../request";
import { useMe } from "../store";
import { kernelMountPath } from "../runtime-path";
import UsageDeletionPreview from "../components/UsageDeletionPreview.vue";
import { useUsageDeletion } from "../usage-deletion";
import UsageHelp from "../components/UsageHelp.vue";
import UsageServiceReferences from "../components/UsageServiceReferences.vue";
import { effectiveBillingModel, estimateModelAllowance, planEstimateBudget, type ReferenceQuote } from "../usage-price-preview";
import type { ServiceReferenceReport } from "../usage-management";
import {
  readPresentation,
  previewPresentation,
  presentationAmount,
  presentationUnit,
  presentationState,
} from "../usage-presentation";

type Period = "day" | "week" | "month";
interface Config {
  mode: "credits" | "periodic";
  serviceIds: string[];
  priceUsd: number;
  periodAllowanceUsd?: number;
  multiplier: number;
  periodUnit?: Period;
  duration: { unit: "day" | "month" | "forever"; count: number };
}
interface ToolParameter {name: string; type: 'string'|'number'|'boolean'|'file'; required:boolean; description:string}
interface ModelTool {name:string;capability:string;description:string;outputs:string[];parameters:ToolParameter[];adapter:'pending'|'aliyun-image'|'aliyun-image-native'|'openrouter-image'}
type PriceSnapshot = ReferenceQuote;
interface PriceModel {id:string;label:string;kind:'chat'|'image'}
interface PriceEndpoint {id:string;label:string;pricing?:PriceSnapshot;unavailable?:boolean;reason?:string}
interface Plan {
  id: string;
  label: string;
  revision: number;
  state: "active" | "suspended";
  config: Config;
}
interface Account {
  id: string;
  label: string;
  kind: "personal" | "organization";
  state: "active" | "suspended";
}
interface Service {
  id: string;
  label: string;
  revision: number;
  state: "active" | "suspended";
  availability?: {state: 'ready'|'unavailable'; code: string|null; message: string|null};
  reference_price?: ReferenceQuote | null;
  config: {
    credential: string;
    model: string;
    providerScope: string;
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    contextWindowTokens?: number;
    inputModalities?: string[];
    purpose?: "chat"|"tool";
    tool?: ModelTool;
    pricing?: {source:"openrouter";modelId:string;endpointId:string;kind:"chat"|"image"};
  };
}
interface ServiceCredential {
  name: string;
  kind?: string;
  default_model?: string;
}
interface Grant {
  id: string;
  planId: string;
  label: string;
  revision: number;
  state: "active" | "suspended";
  sourceOwner: string;
  startsAt: number;
  expiresAt: number | null;
  config: Omit<Config, "serviceIds">;
}
interface Summary {
  presentation?: unknown;
  accountId: string;
  grant: Grant | null;
  plan: {
    id: string;
    label: string;
    revision: number;
    serviceIds: string[];
    multiplier: number;
  } | null;
  availableUsd: number;
  consumedUsd: number;
  currentPeriodConsumedUsd: number;
  overageUsd: number;
  pendingRequests: number;
  resetAt: number | null;
  expiresAt: number | null;
}
interface RequestView {
  operation_id: string;
  service_id: string;
  result_state: string;
  error?: {message:string;http_status?:number;provider_code?:string;provider_request_id?:string};
  billing_state: string;
  billed_usd: number | null;
  reference_cost_usd: number | null;
  usage?: {inputTokens:number;outputTokens:number} | null;
  raw_usage?: {inputImageCount?:number;outputImageCount?:number} | null;
  billing_rate?: {
    planId: string;
    planRevision: number;
    multiplier: number;
  };
}
interface Attempt {
  path: string;
  body: Record<string, unknown>;
  kind: "plan" | "grant" | "control" | "reset" | "service" | "service_delete" | "plan_delete";
  method?: "POST" | "DELETE";
}
const base = "/admin/api/usage",
  billing = `${base}/billing`,
  me = useMe();
const canWrite = computed(() => me.can("usage:write")),
  canAdjust = computed(() => me.can("usage:write") && me.can("usage:adjust")),
  canIssuers = computed(() => me.can("usage:write") && me.can("usage:issuers"));
const tab = ref("plans"),
  loading = ref(false),
  saving = ref(false),
  supported = ref(false),
  billingReady = ref(false),
  periodAllowanceSupported = ref(false),
  error = ref(""),
  pending = ref<Attempt | null>(null),
  storageFailed = ref(false);
const pendingNeedsBilling = computed(
  () =>
    !!pending.value &&
    ["plan", "grant", "control", "reset"].includes(pending.value.kind) &&
    !billingReady.value,
);
const blocked = computed(
  () =>
    loading.value ||
    saving.value ||
    !supported.value ||
    !!pending.value ||
    storageFailed.value,
);
const plans = ref<Plan[]>([]),
  services = ref<Service[]>([]),
  accounts = ref<Account[]>([]),
  accountCursor = ref<string | null>(null),
  accountsLoading = ref(false);
const billingWarning =
  "美元计费尚未就绪，请核对内核与迁移。";
const editing = ref(false),
  formError = ref("");
const defaults = () => ({
  id: "",
  revision: 0,
  label: "",
  active: true,
  mode: "periodic" as Config["mode"],
  serviceIds: [] as string[],
  priceUsd: 100,
  periodAllowanceUsd: 20 as number | undefined,
  multiplier: 1.5,
  periodUnit: "week" as Period,
  durationUnit: "month" as Config["duration"]["unit"],
  durationCount: 1,

});
const form = reactive(defaults());
const usd = (value: number) => Number.isFinite(value) ? '$' + value.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:6}) : '—';
const serviceGroups = [{purpose:'chat',label:'对话模型'},{purpose:'tool',label:'模型工具'}];
const purposeOf = (service: Service) => service.config.purpose === 'tool' ? 'tool' : 'chat';
const availabilityReasons: Record<string, string> = {
  USAGE_PRICE_NOT_CONFIGURED: '尚未绑定参考价格，请配置参考模型与端点。',
  USAGE_PRICE_UNAVAILABLE: '未取得可用参考价格，请检查绑定并同步价格。',
  USAGE_PRICE_UNSUPPORTED: '参考端点的计量规则暂不支持，请选择其他端点。',
  USAGE_SERVICE_UNAVAILABLE: '服务已停用，请在配置中启用。',
  MODEL_TOOL_ADAPTER_NOT_READY: '工具接口尚未适配，当前仅保存声明。',
};
function serviceAvailability(service: Service) {
  if (service.availability) return service.availability;
  return {state: 'unavailable', code: 'USAGE_SERVICE_UNAVAILABLE', message: '尚未取得配置状态，请刷新后重试。'};
}
const serviceReady = (service: Service) => serviceAvailability(service).state === 'ready';
function serviceUnavailableReason(service: Service) {
  const availability = serviceAvailability(service);
  return availability.message || availabilityReasons[availability.code || ''] || '服务暂不可用，请检查配置。';
}
const serviceConfigurationLabel = (service: Service) => serviceAvailability(service).code?.startsWith('USAGE_PRICE_') ? '配置价格' : '配置';
const previewConfig = computed<Config>(() => ({
  mode: form.mode,
  serviceIds: [...form.serviceIds],
  priceUsd: Number(form.priceUsd),
  multiplier: Number(form.multiplier),
  ...(form.mode === "periodic" ? { periodUnit: form.periodUnit, periodAllowanceUsd: Number(form.periodAllowanceUsd) } : {}),
  duration: {
    unit: form.durationUnit,
    count: form.durationUnit === "forever" ? 1 : Number(form.durationCount),
  },

}));
const planPresentation = computed(() =>
  previewPresentation(previewConfig.value),
);
watch(
  () => form.mode,
  (mode) => {
    if (mode === "periodic" && form.durationUnit === "forever")
      form.durationUnit = "month";
  },
);
const number = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { maximumFractionDigits: 6 })
    : "—";
const time = (n: number | null, empty = "—") =>
  n === null ? empty : new Date(n).toLocaleString("zh-CN", { hour12: false });
const periodText = (p?: string) =>
  ({ day: "每日", week: "每 7 天", month: "每月按开通日期" })[p || ""] ||
  "按周期";
const durationText = (c: Config) =>
  c.duration.unit === "forever"
    ? "持续有效"
    : `开通后 ${c.duration.count} ${c.duration.unit === "month" ? "个月" : "天"}`;
const serviceLabel = (id: string) =>
  services.value.find((s) => s.id === id)?.label || `未找到的模型服务（${id}）`;
const resultState = (state: string) =>
  ({
    complete: "已完成",
    pending: "处理中",
    unknown: "原结果待核对",
    cancelled: "已取消",
    failed: "生成服务已拒绝",
  })[state] || "状态待核对";
function describe(e: unknown) {
  const code = e instanceof Error ? e.message : "请求失败";
  const known: Record<string, string> = {
    USAGE_UNSUPPORTED: "当前实例尚未支持 用量套餐，请核对版本与迁移。",
    USAGE_BILLING_UNSUPPORTED: "用量套餐尚未就绪，请核对迁移。",
    USAGE_RESOURCE_IN_USE: "该记录已有使用关联，请查看删除抽屉中的占用原因。",
    USAGE_RESOURCE_DELETED: "记录已删除，原标识不能重新使用。",
    USAGE_RESOURCE_NOT_FOUND: "记录已不存在，请刷新列表。",
    USAGE_FORBIDDEN: "当前管理员没有此操作权限。",
    USAGE_REVISION_CONFLICT: "记录已被更新，请刷新并核对后重新操作。",
    USAGE_IDEMPOTENCY_CONFLICT: "原请求与当前内容不一致，请核对原记录。",
    USAGE_SOURCE_FORBIDDEN: "此套餐由业务后端维护，请回原来源调整。",
    USAGE_SOURCE_CONFLICT: "此套餐由原来源维护，不能在这里直接替换。",
    USAGE_PRICE_UNSUPPORTED: "参考端点的计量规则暂不支持，请选择其他端点。",
    USAGE_PRICE_UNAVAILABLE: "暂时无法取得参考价格，请稍后重试；已有绑定仍保留。",
    USAGE_PRICING_UNAVAILABLE: "参考价格尚未就绪，请选择有效参考模型和端点。",
    USAGE_TOOL_ADAPTER_UNSUPPORTED: "工具适配尚未支持，请选择已支持的图片适配或保存为仅声明。",
    USAGE_INVALID_INPUT: "部分配置不符合要求，请检查填写内容。",
    USAGE_NOT_FOUND: "记录已不存在，请刷新列表。",
    USAGE_SERVICE_NOT_FOUND: "模型服务已不存在，请刷新列表。",
    USAGE_SERVICE_DELETED: "此服务标识已经删除，请为新模型服务填写新的标识。",
    USAGE_SERVICE_UNAVAILABLE: "选中的模型服务已停用，请刷新并选择可用模型。",
    USAGE_ACCOUNT_SUSPENDED: "该账户已停用，请先恢复账户。",
    SERVICE_NOT_ENTITLED:
      "套餐尚未开通或已经暂停开通，请刷新并选择当前可用套餐。",
  };
  return known[code] || `操作未完成：${code}`;
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  if (!storageFailed.value) error.value = "";
  try {
    const results = await Promise.allSettled([
      api<{ items: Plan[]; billing_ready?: boolean; period_allowance_supported?: boolean }>(`${billing}/plans`)
        .then((r) => {
          plans.value = r.items;
          billingReady.value = r.billing_ready === true;
          periodAllowanceSupported.value = r.period_allowance_supported === true;
          supported.value = true;
        })
        .catch((e) => {
          supported.value = false;
          billingReady.value = false;
          periodAllowanceSupported.value = false;
          tab.value = "models";
          throw e;
        }),
      api<{ items: Service[] }>(`${base}/services`).then(
        (r) => (services.value = r.items),
      ),
      loadAccounts(),
    ]);
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } catch (e) {
    error.value = describe(e);
  } finally {
    loading.value = false;
  }
}
async function loadAccounts(more = false) {
  if (accountsLoading.value) return;
  accountsLoading.value = true;
  try {
    const query = new URLSearchParams({ limit: "30" });
    if (more && accountCursor.value) query.set("cursor", accountCursor.value);
    const r = await api<{ items: Account[]; next_cursor: string | null }>(
      `${base}/accounts?${query}`,
    );
    accounts.value = more ? [...accounts.value, ...r.items] : r.items;
    accountCursor.value = r.next_cursor;
  } catch (e) {
    error.value = describe(e);
    throw e;
  } finally {
    accountsLoading.value = false;
  }
}
const estimateBudget = computed(() => planEstimateBudget(previewConfig.value));
const estimateHeading = computed(() => {
  const cadence = {day:'每天',week:'每周',month:'每月'}[form.periodUnit];
  const basis = form.mode === 'periodic' ? `${cadence}预计可用量 · 周期额度` : '整包预计可用量 · 套餐额度';
  return `${basis} ${estimateBudget.value === null ? '待填写' : usd(estimateBudget.value)} · 已计入 ${form.multiplier || 0}×`;
});
function planEstimates(service: Service) {
  const quote = service.reference_price, binding = service.config.pricing;
  if (!quote || !binding || quote.modelId !== binding.modelId || quote.endpointId !== binding.endpointId) return [];
  return estimateModelAllowance(quote, estimateBudget.value ?? 0, form.multiplier, purposeOf(service) === 'chat' ? 'chat' : 'image');
}
function quoteStale(service: Service) { return !service.reference_price || Date.now() - service.reference_price.fetchedAt > 6 * 60 * 60 * 1000; }
function openPlan(plan?: Plan) {
  Object.assign(
    form,
    defaults(),
    plan
      ? {
          id: plan.id,
          revision: plan.revision,
          label: plan.label,
          active: plan.state === "active",
          mode: plan.config.mode,
          serviceIds: [...plan.config.serviceIds],
          priceUsd: plan.config.priceUsd,
          periodAllowanceUsd: plan.config.periodAllowanceUsd,
          multiplier: plan.config.multiplier,
          periodUnit: plan.config.periodUnit || "week",
          durationUnit: plan.config.duration.unit,
          durationCount: plan.config.duration.count,

        }
      : { id: `billing-plan-${crypto.randomUUID()}` },
  );
  formError.value = "";
  editing.value = true;
  tab.value = "plans";
}
function validateConfig(c: Config) {
  if (!form.label.trim()) throw new Error("请填写套餐名称。");
  if (
    c.serviceIds.some(
      (id) => !services.value.some((s) => s.id === id && (serviceReady(s) || plans.value.find(p => p.id === form.id)?.config.serviceIds.includes(id))),
    )
  )
    throw new Error("新增服务尚未就绪或已不存在，请调整选择或先完成服务配置。");
  if (!Number.isFinite(c.priceUsd) || c.priceUsd < 0.01 || c.priceUsd > 1000000) throw new Error('美元价格须为 0.01 至 1,000,000。');
  if (c.mode === 'periodic' && (typeof c.periodAllowanceUsd !== 'number' || !Number.isFinite(c.periodAllowanceUsd) || c.periodAllowanceUsd < 0.01 || c.periodAllowanceUsd > 1000000)) throw new Error('请填写 0.01 至 1,000,000 的周期额度。');
  if (!Number.isFinite(c.multiplier) || c.multiplier < 0.000001 || c.multiplier > 1000) throw new Error('统一倍率须为 0.000001 至 1000。');
  if (
    !Number.isSafeInteger(c.duration.count) ||
    c.duration.count < 1 ||
    c.duration.count > 1200
  )
    throw new Error("请填写有效的使用期限。");

}
async function savePlan() {
  formError.value = "";
  if (!billingReady.value) {
    formError.value = billingWarning;
    return;
  }
  try {
    if (form.mode === 'periodic' && !periodAllowanceSupported.value) throw new Error('周期额度仅供预览，请先启用配套计费版本。');
    const config = previewConfig.value;
    validateConfig(config);
    await mutate({
      kind: "plan",
      path: `${billing}/plans`,
      body: {
        id: form.id,
        label: form.label.trim(),
        expected_revision: form.revision,
        state: form.active ? "active" : "suspended",
        config,
      },
    });
  } catch (e) {
    formError.value = describe(e);
  }
}
const pendingKey = () =>
  `bailing:billing-config:pending:v1:${kernelMountPath()}:${me.me?.username || ""}`;
async function mutate(attempt: Attempt) {
  if (blocked.value) throw new Error("请先完成上一次操作或等待刷新。");
  try {
    sessionStorage.setItem(pendingKey(), JSON.stringify(attempt));
  } catch {
    storageFailed.value = true;
    throw new Error("无法保存原请求，尚未提交。请恢复浏览器会话存储后刷新。");
  }
  pending.value = attempt;
  await retryPending();
}
const definitive = new Set([
  "USAGE_RESOURCE_IN_USE",
  "USAGE_RESOURCE_DELETED",
  "USAGE_RESOURCE_NOT_FOUND",
  "USAGE_INVALID_INPUT",
  "USAGE_FORBIDDEN",
  "USAGE_REVISION_CONFLICT",
  "USAGE_SOURCE_FORBIDDEN",
  "USAGE_SOURCE_CONFLICT",
  "USAGE_ACCOUNT_NOT_FOUND",
  "USAGE_ACCOUNT_SUSPENDED",
  "SERVICE_NOT_ENTITLED",
  "USAGE_NOT_FOUND",
  "USAGE_SERVICE_NOT_FOUND",
  "USAGE_SERVICE_DELETED",
  "USAGE_SERVICE_UNAVAILABLE",
  "USAGE_PRICE_NOT_CONFIGURED",
  "USAGE_PRICE_UNAVAILABLE",
  "USAGE_PRICE_UNSUPPORTED",
  "MODEL_TOOL_ADAPTER_NOT_READY",
  "USAGE_PLAN_NOT_FOUND",
  "USAGE_IDEMPOTENCY_CONFLICT",
  "USAGE_UNSUPPORTED",
  "USAGE_BILLING_UNSUPPORTED",
  "USAGE_MODEL_NOT_ALLOWED",
  "USAGE_DISABLED",
  "USAGE_PLAN_SUSPENDED",
]);
async function retryPending() {
  if (!pending.value || saving.value) return;
  if (pendingNeedsBilling.value) {
    error.value = billingWarning;
    return;
  }
  const attempt = pending.value;
  saving.value = true;
  error.value = "";
  try {
    await api(attempt.path, {
      method: attempt.method ?? "POST",
      body: JSON.stringify(attempt.body),
    });
    sessionStorage.removeItem(pendingKey());
    pending.value = null;
    if (attempt.kind === "plan") editing.value = false;
    if (attempt.kind === "plan_delete") deletion.open.value = false;
    if (attempt.kind === "grant") grantOpen.value = false;
    if (attempt.kind === "service") serviceOpen.value = false;
    if (attempt.kind === "service_delete") {
      referencesOpen.value = false;
      tab.value = "models";
    }
    ElMessage.success(
      attempt.kind === "grant"
        ? "套餐已开通，新额度从现在开始生效。"
        : attempt.kind === "reset" ? "额度已重置，套餐到期时间不变。"
        : attempt.kind === "service_delete"
          ? "模型服务已删除，历史用量记录已保留。"
          : attempt.kind === "plan_delete" ? "套餐已删除。" : "已保存。",
    );
    await load();
    if (detailOpen.value) await loadDetail();
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    error.value = describe(e);
    formError.value = error.value;
    grantError.value = error.value;
    serviceError.value = error.value;
    if (definitive.has(code)) {
      sessionStorage.removeItem(pendingKey());
      pending.value = null;
      if (code === "USAGE_REVISION_CONFLICT") {
        editing.value = false;
        grantOpen.value = false;
        serviceOpen.value = false;
      }
      await load();
      error.value = describe(e);
      if (detailOpen.value) await loadDetail();
    }
    if (attempt.kind === "plan_delete" && deletion.open.value) {
      await deletion.refresh();
      deletion.error.value = describe(e);
    }
    if (attempt.kind === "service_delete" && referencesOpen.value) {
      await loadServiceReferences();
      referencesError.value = describe(e);
    }
  } finally {
    saving.value = false;
  }
}
const detailOpen = ref(false),
  detailLoading = ref(false),
  detailError = ref(""),
  selectedAccount = ref<Account | null>(null),
  summary = ref<Summary | null>(null),
  requests = ref<RequestView[]>([]),
  requestCursor = ref<string | null>(null),
  requestsLoading = ref(false);
const externalGrant = computed(
  () => !!summary.value?.grant && summary.value.grant.sourceOwner !== "hub",
);
const canResetAllowance = computed(() => {
  const g = summary.value?.grant, now = Date.now();
  return !!g && !!summary.value?.plan && selectedAccount.value?.state === 'active'
    && g.state === 'active' && now >= g.startsAt && (g.expiresAt === null || now < g.expiresAt);
});
const accountModelIds = computed(() =>
  (summary.value?.plan?.serviceIds || []).filter((id) =>
    services.value.some(
      (service) => service.id === id && serviceReady(service),
    ),
  ),
);
const periodConsumed = (s: Summary) =>
  s.grant?.config.mode === "periodic"
    ? s.currentPeriodConsumedUsd
    : s.consumedUsd;
const accountPresentation = computed(() =>
  readPresentation(
    summary.value?.presentation,
    summary.value?.grant?.config.mode,
  ),
);
function grantStatus(s: Summary) {
  const p = readPresentation(s.presentation, s.grant?.config.mode);
  if (p.state === "active") return "多个模型共享同一份额度。";
  if (p.state === "depleted")
    return s.resetAt
      ? "额度已用完，等待下一周期重置。"
      : "额度已用完，可开通新的额度包。";
  return presentationState(p) + "，原记录保留。";
}
async function openAccount(account: Account) {
  selectedAccount.value = account;
  detailOpen.value = true;
  await loadDetail();
}
async function loadDetail() {
  const id = selectedAccount.value?.id;
  if (!id) return;
  detailLoading.value = true;
  detailError.value = "";
  summary.value = null;
  requests.value = [];
  requestCursor.value = null;
  try {
    const value = await api<Summary>(
      `${billing}/accounts/${encodeURIComponent(id)}/summary`,
    );
    if (selectedAccount.value?.id !== id) return;
    summary.value = value;
    await loadRequests();
  } catch (e) {
    detailError.value = describe(e);
  } finally {
    detailLoading.value = false;
  }
}
async function loadRequests(more = false) {
  const id = selectedAccount.value?.id;
  if (!id || requestsLoading.value || !billingReady.value) return;
  requestsLoading.value = true;
  try {
    const query = new URLSearchParams({ limit: "30" });
    if (more && requestCursor.value) query.set("cursor", requestCursor.value);
    const r = await api<{ items: RequestView[]; next_cursor: string | null }>(
      `${billing}/accounts/${encodeURIComponent(id)}/requests?${query}`,
    );
    if (selectedAccount.value?.id !== id) return;
    requests.value = more ? [...requests.value, ...r.items] : r.items;
    requestCursor.value = r.next_cursor;
  } catch (e) {
    detailError.value = describe(e);
  } finally {
    requestsLoading.value = false;
  }
}
const grantOpen = ref(false),
  grantLoading = ref(false),
  grantError = ref(""),
  grantAccountId = ref(""),
  grantPlanId = ref(""),
  grantSummary = ref<Summary | null>(null);
const grantFromAccount = ref(false),
  deferredGrant = ref(false);
function openDeferredGrant() {
  if (deferredGrant.value) {
    deferredGrant.value = false;
    grantOpen.value = true;
  }
}
async function returnToAccount() {
  if (!grantFromAccount.value || !selectedAccount.value) return;
  grantFromAccount.value = false;
  detailOpen.value = true;
  await loadDetail();
}
const grantPlan = computed(() =>
  plans.value.find((p) => p.id === grantPlanId.value),
);
async function openGrant(account?: Account, planId?: string) {
  grantAccountId.value = account?.id || "";
  grantPlanId.value =
    planId || plans.value.find((p) => p.state === "active")?.id || "";
  grantSummary.value = null;
  grantError.value = "";
  grantFromAccount.value = detailOpen.value;
  if (detailOpen.value) {
    deferredGrant.value = true;
    detailOpen.value = false;
  } else grantOpen.value = true;
  if (account) await loadGrantSummary();
}
async function loadGrantSummary() {
  const id = grantAccountId.value;
  grantSummary.value = null;
  grantError.value = "";
  if (!id) return;
  grantLoading.value = true;
  try {
    const r = await api<Summary>(
      `${billing}/accounts/${encodeURIComponent(id)}/summary`,
    );
    if (grantAccountId.value !== id) return;
    grantSummary.value = r;
    if (r.grant && r.grant.sourceOwner !== "hub")
      grantError.value = "此套餐由业务后端维护，请在原来源调整。";
  } catch (e) {
    grantError.value = describe(e);
  } finally {
    grantLoading.value = false;
  }
}
async function grant() {
  if (!billingReady.value) {
    grantError.value = billingWarning;
    return;
  }
  if (!grantSummary.value || !grantPlan.value || grantError.value) return;
  try {
    await mutate({
      kind: "grant",
      path: `${billing}/accounts/${encodeURIComponent(grantAccountId.value)}/grant`,
      body: {
        request_key: crypto.randomUUID(),
        plan_id: grantPlanId.value,
        expected_revision: grantSummary.value.grant?.revision || 0,
      },
    });
  } catch (e) {
    grantError.value = describe(e);
  }
}
async function resetAllowance() {
  const g = summary.value?.grant, account = selectedAccount.value;
  if (!canAdjust.value || !canResetAllowance.value || blocked.value || !billingReady.value || externalGrant.value || !g || !account) return;
  const terms = g.config.mode === 'periodic'
    ? `本期额度将恢复至 100%（${number(g.config.periodAllowanceUsd!)} USD），重置周期从本次确认时重新起算。`
    : `可用积分将恢复至初始额度（${number(g.config.priceUsd * 1000)} 积分）。`;
  try {
    await ElMessageBox.confirm(`${terms}剩余额度不叠加，套餐到期时间不延长。历史用量保留，重置前已发出的请求继续记入原额度。`, '重置此账户额度',
      { confirmButtonText: '确认重置', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false });
  } catch { return; }
  try {
    await mutate({kind: 'reset', path: `${billing}/accounts/${encodeURIComponent(account.id)}/reset`,
      body: {request_key: crypto.randomUUID(), expected_revision: g.revision}});
  } catch (e) { detailError.value = describe(e); }
}
async function controlGrant() {
  if (!billingReady.value) {
    detailError.value = billingWarning;
    return;
  }
  const g = summary.value?.grant;
  if (!g || !selectedAccount.value) return;
  try {
    await ElMessageBox.confirm(
      g.state === "active"
        ? "暂停后不再接纳新请求，已开始的请求仍归原账结算。"
        : "恢复当前套餐，不发放新额度，也不重新执行原请求。",
      "确认套餐状态",
      { confirmButtonText: "确认", cancelButtonText: "返回", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await mutate({
      kind: "control",
      path: `${billing}/accounts/${encodeURIComponent(selectedAccount.value.id)}/control`,
      body: {
        request_key: crypto.randomUUID(),
        expected_revision: g.revision,
        state: g.state === "active" ? "suspended" : "active",
      },
    });
  } catch (e) {
    detailError.value = describe(e);
  }
}
const serviceOpen = ref(false),
  serviceError = ref(""),
  serviceRevision = ref(0);
const serviceDefaults = () => ({
  id: "",
  label: "",
  credential: "",
  model: "",
  purpose: 'chat' as 'chat'|'tool',
  referenceModel: '', referenceEndpoint: '',
  pricingKind: 'chat' as 'chat'|'image',
  tool: {name:'generate_image',capability:'image_generation',description:'根据用户的描述生成图片，返回生成结果；不自动修改业务数据。',outputs:['image'],parameters:[{name:'prompt',type:'string',required:true,description:'要生成的画面内容'}],adapter:'pending'} as ModelTool,
  providerScope: "",
  active: true,
  maxOutputTokens: 8192,
  contextWindowTokens: 0,
  modalities: "unknown",
  timeoutSeconds: 120,
  maxInputBytes: 8388608,
});
const serviceForm = reactive(serviceDefaults());
const priceModels = ref<PriceModel[]>([]), priceEndpoints = ref<PriceEndpoint[]>([]);
const pricingLoading = ref(false), endpointsLoading = ref(false), pricingError = ref(''), priceFetchedAt = ref(0), pricingStale = ref(false);
let modelPriceSequence = 0, endpointPriceSequence = 0;
const effectiveReferenceModel = computed(() => effectiveBillingModel(serviceForm.model, serviceForm.referenceModel));
const selectedPriceEndpoint = computed(() => priceEndpoints.value.find(e => e.id === serviceForm.referenceEndpoint));
function endpointPriceIssue(endpoint?: PriceEndpoint) {
  if (!endpoint) return '尚未取得所选参考端点的真实报价，请同步参考价格或重新选择端点。';
  if (endpoint.unavailable) return '所选端点的计量规则暂不支持，请选择其他端点。';
  const price = endpoint.pricing;
  if (!price?.lines?.length) return '所选参考端点未返回价格，不能保存绑定，请同步价格或选择其他端点。';
  if (price.source !== 'openrouter' || price.currency !== 'USD' || price.modelId !== effectiveReferenceModel.value || price.endpointId !== endpoint.id || price.lines.some(line => !line.costUsd?.trim() || !Number.isFinite(Number(line.costUsd)) || Number(line.costUsd) < 0))
    return '所选参考端点的价格数据无效，请重新同步价格。';
  return '';
}
const selectedPriceIssue = computed(() => !endpointsLoading.value && serviceForm.referenceEndpoint ? endpointPriceIssue(selectedPriceEndpoint.value) : '');
async function loadPriceModels() {
  const sequence = ++modelPriceSequence; pricingLoading.value = true; pricingError.value = ''; priceModels.value = [];
  try {const r = await api<{items:PriceModel[];fetchedAt:number;stale:boolean}>(`${base}/pricing/models?kind=${serviceForm.pricingKind}`); if(sequence !== modelPriceSequence)return; priceModels.value = r.items; pricingStale.value = r.stale;}
  catch(e) {if(sequence === modelPriceSequence) pricingError.value = describe(e);}
  finally {if(sequence === modelPriceSequence) pricingLoading.value = false;}
}
async function loadPriceEndpoints(sync = false) {
  const sequence = ++endpointPriceSequence; priceEndpoints.value = []; priceFetchedAt.value = 0;
  if (!effectiveReferenceModel.value) {endpointsLoading.value = false;return;}
  endpointsLoading.value = true; pricingError.value = '';
  try {const body = {model_id:effectiveReferenceModel.value,kind:serviceForm.pricingKind};
    const r = await api<{items:PriceEndpoint[];fetchedAt:number;stale:boolean}>(sync ? `${base}/pricing/sync` : `${base}/pricing/endpoints?${new URLSearchParams(body)}`, sync ? {method:'POST',body:JSON.stringify(body)} : undefined);
    if(sequence !== endpointPriceSequence)return; priceEndpoints.value = r.items; priceFetchedAt.value = r.fetchedAt; pricingStale.value = r.stale;
    const ready = r.items.filter(e => !endpointPriceIssue(e));
    if (!serviceForm.referenceEndpoint && ready.length === 1) serviceForm.referenceEndpoint = ready[0].id;
    if (!r.items.length) pricingError.value = '未找到参考价格，请填写 OpenRouter 的计费模型标识。';
  } catch(e) {if(sequence === endpointPriceSequence) pricingError.value = describe(e);}
  finally {if(sequence === endpointPriceSequence) endpointsLoading.value = false;}
}
function changeCallingModel() { if (!serviceForm.referenceModel.trim()) changeReferenceModel(); }
function changeReferenceModel() {serviceForm.referenceEndpoint = ''; void loadPriceEndpoints();}
function changePurpose() {serviceForm.pricingKind = serviceForm.purpose === 'chat' ? 'chat':'image'; serviceForm.referenceModel = ''; serviceForm.referenceEndpoint = ''; void loadPriceModels(); void loadPriceEndpoints();}
function changeToolCapability() {const kind = serviceForm.tool.capability; if(kind !== 'image_generation') {serviceForm.tool.adapter = 'pending';serviceForm.referenceModel = '';serviceForm.referenceEndpoint = '';void loadPriceEndpoints();} serviceForm.tool.outputs = [kind === 'video_generation' ? 'video':kind === 'speech_generation'?'audio':'image'];}
const serviceCredentials = ref<ServiceCredential[]>([]),
  credentialsLoading = ref(false),
  credentialsError = ref("");
const selectedServiceCredential = computed(() =>
  serviceCredentials.value.find((c) => c.name === serviceForm.credential),
);
const serviceModelOptions = computed(() => {
  const options = new Map<string, string>();
  const defaultModel = selectedServiceCredential.value?.default_model?.trim();
  if (defaultModel) options.set(defaultModel, `${defaultModel} · 凭证默认`);
  for (const service of services.value) {
    if (
      service.config.credential === serviceForm.credential &&
      !options.has(service.config.model)
    )
      options.set(service.config.model, `${service.config.model} · 已配置`);
  }
  if (serviceForm.model && !options.has(serviceForm.model))
    options.set(serviceForm.model, serviceForm.model);
  return [...options].map(([value, label]) => ({ value, label }));
});
async function loadServiceCredentials() {
  if (!me.can("credentials:read") || credentialsLoading.value) return;
  credentialsLoading.value = true;
  credentialsError.value = "";
  try {
    const items = await api<ServiceCredential[]>("/admin/api/credentials");
    serviceCredentials.value = items.filter((c) => c.kind !== "embedding");
  } catch {
    credentialsError.value = "模型凭证读取失败，请重试。";
  } finally {
    credentialsLoading.value = false;
  }
}
function onServiceCredentialChange() {
  serviceForm.model =
    selectedServiceCredential.value?.default_model?.trim() || "";
  // An empty scope follows the newly selected credential on save.
  serviceForm.providerScope = "";
  changeCallingModel();
}
const referencesOpen = ref(false),
  referencesLoading = ref(false),
  referencesError = ref("");
const referenceService = ref<Service | null>(null),
  serviceReferences = ref<ServiceReferenceReport | null>(null);
let referencesSequence = 0;
async function loadServiceReferences() {
  const service = referenceService.value;
  if (!service) return;
  const sequence = ++referencesSequence;
  referencesLoading.value = true;
  referencesError.value = "";
  serviceReferences.value = null;
  try {
    const report = await api<ServiceReferenceReport>(
      `${base}/services/${encodeURIComponent(service.id)}/references`,
    );
    if (sequence === referencesSequence) serviceReferences.value = report;
  } catch (e) {
    if (sequence === referencesSequence) referencesError.value = describe(e);
  } finally {
    if (sequence === referencesSequence) referencesLoading.value = false;
  }
}
async function deleteService(service: Service) {
  if (blocked.value) return;
  referenceService.value = service;
  referencesOpen.value = true;
  await loadServiceReferences();
}
const deletion = useUsageDeletion(describe);
async function deletePlan(plan: Plan) {
  if (blocked.value || !canWrite.value) return;
  await deletion.show(`${billing}/plans/${encodeURIComponent(plan.id)}`, plan.label);
}
async function confirmDeletePlan() {
  const report = deletion.report.value;
  if (!report?.can_delete || deletion.loading.value || blocked.value || !canWrite.value) return;
  try {
    await mutate({ kind: "plan_delete", method: "DELETE", path: deletion.path.value,
      body: { request_key: crypto.randomUUID(), expected_revision: report.revision } });
  } catch (e) { deletion.error.value = describe(e); }
}
async function confirmDeleteService() {
  const report = serviceReferences.value;
  if (!report?.deletable || referencesLoading.value || blocked.value) return;
  try {
    await mutate({
      kind: "service_delete",
      method: "DELETE",
      path: `${base}/services/${encodeURIComponent(report.service.id)}`,
      body: {
        expected_revision: report.service.revision,
        request_key: crypto.randomUUID(),
      },
    });
  } catch (e) {
    referencesError.value = describe(e);
  }
}
function openReferencePlan(id: string) {
  const plan = plans.value.find((p) => p.id === id);
  if (!plan) {
    referencesError.value = "套餐列表已变化，请关闭抽屉并刷新后再试。";
    return;
  }
  referencesOpen.value = false;
  tab.value = "plans";
  openPlan(plan);
}
function openService(service?: Service) {
  serviceRevision.value = service?.revision || 0;
  Object.assign(
    serviceForm,
    serviceDefaults(),
    service
      ? {
          id: service.id,
          label: service.label,
          credential: service.config.credential,
          model: service.config.model,
          purpose: service.config.purpose || 'chat',
          referenceModel: service.config.pricing?.modelId === service.config.model ? '' : service.config.pricing?.modelId || '',
          referenceEndpoint: service.config.pricing?.endpointId || '',
          pricingKind: service.config.pricing?.kind || (service.config.purpose === 'tool' ? 'image' : 'chat'),
          ...(service.config.tool ? {tool: JSON.parse(JSON.stringify(service.config.tool))} : {}),
          providerScope: service.config.providerScope,
          active: service.state === "active",
          maxOutputTokens: service.config.maxOutputTokens,
          contextWindowTokens: service.config.contextWindowTokens || 0,
          modalities: service.config.inputModalities
            ? service.config.inputModalities.includes("image")
              ? "text_image"
              : "text"
            : "unknown",
          timeoutSeconds: service.config.timeoutMs / 1000,
          maxInputBytes: service.config.maxInputBytes,
        }
      : {},
  );
  serviceError.value = "";
  serviceOpen.value = true;
  void loadServiceCredentials();
  void loadPriceModels();
  void loadPriceEndpoints();
}
async function saveService() {
  serviceError.value = "";
  try {
    if (credentialsLoading.value || credentialsError.value)
      throw new Error("请先完成模型凭证读取。");
    if (me.can("credentials:read") && !selectedServiceCredential.value)
      throw new Error("请选择一个现有的对话模型凭证。");
    if (
      !serviceForm.id.trim() ||
      !serviceForm.label.trim() ||
      !serviceForm.credential.trim() ||
      !serviceForm.model.trim()
    )
      throw new Error("请填写名称、标识、现有凭证与模型。");
    const needsPrice = serviceForm.purpose === 'chat' || serviceForm.tool.adapter !== 'pending';
    if (needsPrice && (!effectiveReferenceModel.value || !serviceForm.referenceEndpoint)) throw new Error('尚未匹配可用参考价格，请检查计费模型并选择参考端点。');
    if (needsPrice || serviceForm.referenceModel || serviceForm.referenceEndpoint) {
      if (endpointsLoading.value) throw new Error('参考价格正在读取，请稍后保存。');
      if (!effectiveReferenceModel.value || !serviceForm.referenceEndpoint) throw new Error('请先匹配参考价格并选择参考端点。');
      const issue = endpointPriceIssue(selectedPriceEndpoint.value);
      if (issue) throw new Error(issue);
    }
    const config: Service["config"] = {
      purpose: serviceForm.purpose,
      ...(effectiveReferenceModel.value && serviceForm.referenceEndpoint ? {pricing: {source:'openrouter' as const,modelId:effectiveReferenceModel.value,endpointId:serviceForm.referenceEndpoint,kind:serviceForm.pricingKind}} : {}),
      ...(serviceForm.purpose === 'tool' ? {tool: JSON.parse(JSON.stringify(serviceForm.tool))} : {}),
      credential: serviceForm.credential.trim(),
      model: serviceForm.model.trim(),
      providerScope:
        serviceForm.providerScope.trim() || serviceForm.credential.trim(),
      maxOutputTokens: serviceForm.maxOutputTokens,
      maxInputBytes: serviceForm.maxInputBytes,
      timeoutMs: serviceForm.timeoutSeconds * 1000,
    };
    if (serviceForm.contextWindowTokens > 0)
      config.contextWindowTokens = serviceForm.contextWindowTokens;
    if (serviceForm.modalities !== "unknown")
      config.inputModalities =
        serviceForm.modalities === "text_image" ? ["text", "image"] : ["text"];
    await mutate({
      kind: "service",
      path: `${base}/services`,
      body: {
        id: serviceForm.id.trim(),
        label: serviceForm.label.trim(),
        expected_revision: serviceRevision.value,
        state: serviceForm.active ? "active" : "suspended",
        config,
      },
    });
  } catch (e) {
    serviceError.value = describe(e);
  }
}
onMounted(() => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(pendingKey()) || "null");
    if (stored) {
      if (
        typeof stored.path === "string" &&
        (stored.kind !== "reset" || ((stored.method === undefined || stored.method === "POST") && /^\/admin\/api\/usage\/billing\/accounts\/[A-Za-z0-9_.:-]+\/reset$/.test(stored.path))) &&
        (stored.kind !== "plan_delete" || (stored.method === "DELETE" && /^\/admin\/api\/usage\/billing\/plans\/(?:[A-Za-z0-9_.:-]|%3[aA])+$/.test(stored.path))) &&
        (stored.path.startsWith(billing + "/") ||
          stored.path === `${base}/services` ||
          (stored.kind === "service_delete" &&
            stored.method === "DELETE" &&
            /^\/admin\/api\/usage\/services\/(?:[A-Za-z0-9_.:-]|%3[aA])+$/.test(
              stored.path,
            ))) &&
        stored.body &&
        ["plan", "grant", "control", "reset", "service", "service_delete", "plan_delete"].includes(
          stored.kind,
        )
      )
        pending.value = stored;
      else {
        storageFailed.value = true;
        error.value = "原保存请求无法识别，请先核对记录。";
      }
    }
  } catch {
    storageFailed.value = true;
    error.value = "无法读取原保存请求，请恢复会话存储后刷新。";
  }
  void load();
});
</script>

<style scoped>
.credential-create-link {
  display: block;
  color: var(--el-color-primary);
  line-height: 32px;
  text-decoration: none;
}
.credential-create-link:hover {
  color: var(--el-color-primary-light-3);
}
.tool-parameter {display:grid;grid-template-columns:1fr 100px 70px 50px;gap:8px;margin:12px 0;}
.tool-parameter > :last-child {grid-column:1 / -1;}
.billing-page {
  min-width: 0;
}
.billing-page :deep(.el-card__body) {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.page-title {
  display: flex;
  align-items: center;
  gap: 5px;
}
.page-heading,
.section-heading,
.actions,
.card-top,
.card-bottom,
.form-footer,
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.preview-eyebrow {
  font-size: 11px;
  letter-spacing: 1.6px;
  color: var(--el-color-primary);
}
h2 {
  font-size: 20px;
  margin: 0 0 7px;
}
h3 {
  font-size: 16px;
  margin: 0 0 8px;
}
.actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.section-heading {
  margin-bottom: 24px;
}
.section-tabs :deep(.el-tabs__item) {
  font-size: 14px;
}
.panel {
  border: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-blank);
}
.muted,
.footnote {
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}
.mono,
code {
  overflow-wrap: anywhere;
}
.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 18px;
}
.model-card {
  padding: 24px;
  min-width: 0;
}
.model-card .card-top {
  margin-bottom: 12px;
  align-items: flex-start;
}
.model-card h3 {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.model-card .card-top :deep(.el-tag) {
  flex-shrink: 0;
}
.card-bottom {
  justify-content: flex-end;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 17px;
  margin-top: 20px;
  gap: 8px;
}
.principle {
  margin-top: 28px;
  padding: 22px 25px;
  border-left: 3px solid var(--el-color-primary);
}
.principle p,
.pending p {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.85;
  margin: 7px 0 0;
}
.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 315px;
  align-items: start;
  gap: 24px;
  max-width: 1440px;
}
.plan-editor-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.plan-editor-heading h2 {
  margin: 0;
  font-size: 18px;
  line-height: 32px;
}
.plan-form {
  display: grid;
  gap: 17px;
  min-width: 0;
}
.form-section {
  padding: 26px;
}




.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
}
.plan-settings-grid {
  gap: 22px 24px;
}
.plan-settings-grid :deep(.el-form-item) {
  margin-bottom: 0;
  min-width: 0;
}
.plan-settings-grid :deep(.el-form-item__content) {
  min-width: 0;
}
.plan-settings-grid :deep(.el-input-number),
.plan-settings-grid :deep(.el-select) {
  width: 100%;
  min-width: 0;
}
.plan-settings-grid :deep(.el-input__inner) {
  text-align: left;
}
.billing-page :deep(.el-select) {
  width: 100%;
}
.billing-page :deep(.el-form-item__label) {
  font-size: 13px;
}





.model-choices {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
  /* CheckboxGroup resets line-height to zero; quote text needs normal flow. */
  font-size: 14px;
  line-height: 1.6;
}
.model-choices :deep(.el-checkbox) {
  height: auto;
  padding: 12px 14px;
  margin-right: 0;
  border: 1px solid var(--el-border-color-lighter);
}
.model-choice-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
}
.model-choice-row :deep(.el-checkbox) {
  flex: 1 1 150px;
  min-width: 0;
  border: 0;
  padding: 0;
}
.model-choice-row > .el-button {
  flex-shrink: 0;
}
.model-estimate {
  flex: 2 1 260px;
  min-width: 0;
  display: grid;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.estimate-scenario { display: grid; gap: 4px; }
.model-estimate strong { color: var(--el-color-primary); font-size: 15px; line-height: 1.5; }
.model-choices .model-estimate small { margin-top: 0; line-height: 1.6; }
.model-estimate-heading { display: block; color: var(--el-text-color-secondary); font-weight: 400; font-size: 12px; margin-top: 5px; }
.model-choices .quote-source { font-size: 10px; }
.reference-match { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--el-text-color-secondary); font-size: 12px; margin-bottom: 12px; overflow-wrap: anywhere; }
.service-warning,
.model-choices small.service-warning {
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  line-height: 1.6;
}
.reference-endpoint-field :deep(.el-form-item__label) {
  width: 100%;
}
.reference-endpoint-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.model-choices :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.5;
}
.model-choices small {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.duration-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px;
  gap: 10px;
  align-items: center;
  width: 100%;
}
.duration-field :deep(.el-input-number) {
  width: 100%;
  min-width: 60px;
}
.duration-field :deep(.el-select) {
  width: 100%;
}
.duration-field > :only-child {
  grid-column: 1 / -1;
}


.advanced summary,
.service-advanced summary {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  cursor: pointer;
  font-size: 13px;
}
.advanced summary::-webkit-details-marker,
.service-advanced summary::-webkit-details-marker {
  display: none;
}
.advanced summary::marker,
.service-advanced summary::marker {
  content: "";
}
.advanced summary::before,
.service-advanced summary::before {
  content: "";
  flex: 0 0 10px;
  width: 10px;
  height: 10px;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Cpath d='M0.085333 239.36L512 784.64l511.914667-545.28z'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Cpath d='M0.085333 239.36L512 784.64l511.914667-545.28z'/%3E%3C/svg%3E") center / contain no-repeat;
  transform: rotate(-90deg);
}
.advanced details[open] > summary::before,
.service-advanced[open] > summary::before {
  transform: rotate(0);
}
.advanced summary .muted {
  margin-left: 0;
}
.advanced-content {
  padding-top: 22px;
}
.preview {
  position: sticky;
  top: 22px;
  padding: 27px 24px;
  border-top: 3px solid var(--el-color-primary);
}
.preview h3 {
  font-size: 19px;
  margin: 25px 0 20px;
}
.preview-amount {
  font-size: 38px;
  line-height: 1.1;
  letter-spacing: -1px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.preview-amount small {
  font-size: 17px;
  font-weight: 500;
  letter-spacing: 0;
  margin-left: 8px;
}
.customer-preview {
  padding: 24px;
  border-top: 3px solid var(--el-color-primary);
}
.customer-amount-row {
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0 22px;
}
.operator-accounting {
  display: grid;
  gap: 20px;
  border-top: 1px solid var(--el-border-color-light);
  padding-top: 24px;
}
.preview-unit {
  color: var(--el-text-color-secondary);
  margin: 10px 0 26px;
}
.preview-rule {
  padding: 13px 0;
  border-top: 1px solid var(--el-border-color-lighter);
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.preview-rule > span {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
.preview-rule b {
  font-weight: 500;
  text-align: right;
}
.preview-models {
  padding-top: 19px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.preview ul {
  list-style: none;
  padding: 18px 0 0;
  margin: 20px 0 0;
  border-top: 1px solid var(--el-border-color-lighter);
}
.preview li {
  position: relative;
  padding: 0 0 12px 18px;
  font-size: 12px;
  line-height: 1.8;
}
.preview li::before {
  content: "✓";
  position: absolute;
  left: 0;
  color: var(--el-color-primary);
}
.preview-note {
  font-size: 11px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
  margin: 6px 0 0;
}
.form-footer {
  padding: 5px 0 12px;
}
.pending {
  padding: 20px;
  border-color: var(--el-color-warning);
}
.pending .el-button {
  margin-top: 14px;
}
.more {
  text-align: center;
  padding: 18px;
}
.account-detail {
  display: grid;
  gap: 20px;
}
.account-detail .section-heading {
  margin: 0;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  border: 1px solid var(--el-border-color-light);
}
.metrics > div {
  padding: 22px;
  display: grid;
  gap: 10px;
}
.metrics span,
.metrics small {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.metrics strong {
  font-size: 27px;
  letter-spacing: -0.6px;
  overflow-wrap: anywhere;
}
.grant-details {
  padding: 22px;
}
.grant-details > div {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
  font-size: 13px;
}
.grant-details span {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
.grant-details b {
  font-weight: 500;
  text-align: right;
  overflow-wrap: anywhere;
}
.grant-preview {
  padding: 18px;
  margin: 20px 0;
}
.grant-preview p {
  font-size: 13px;
  line-height: 1.8;
  margin: 8px 0;
}
.account-models {
  display: grid;
  gap: 6px;
  text-align: right;
}
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.usage-config-drawer :deep(.el-drawer__footer) {
  border-top: 1px solid var(--el-border-color-light);
  padding: 16px 20px;
}
.usage-config-drawer .form-grid {
  grid-template-columns: minmax(0, 1fr);
}
.billing-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}
.billing-notice > .el-alert {
  flex: 1;
}

.service-advanced {
  margin: 24px 0;
}
.service-advanced > .form-grid {
  margin-top: 16px;
}
@media (max-width: 1160px) {
  .editor-layout {
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: 18px;
  }
  .form-section {
    padding: 21px;
  }

}
@media (max-width: 940px) {
  .editor-layout {
    grid-template-columns: 1fr;
  }
  .preview {
    position: static;
  }
  .page-heading,
  .section-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
@media (max-width: 600px) {
  .form-grid,
  .metrics,
  .model-grid {
    grid-template-columns: 1fr;
  }
  .form-section {
    padding: 20px 17px;
  }

  .form-footer {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .preview-amount {
    font-size: 33px;
  }
  .grant-details > div {
    flex-direction: column;
    gap: 5px;
  }
  .account-models {
    text-align: left;
  }
  .grant-details b {
    text-align: left;
  }
  .metrics > div {
    padding: 15px 20px;
  }
  .page-heading .actions {
    gap: 8px;
  }
}
</style>
