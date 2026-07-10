<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>入站渠道</b> <HelpTip title="入站渠道是什么 / 怎么接 / 业务如何经它推消息">
          <p><b>入站渠道 = 外部平台消息进中枢的前门</b>（企业微信，未来飞书等）。「消息进来」与「谁来处理」解耦——绑哪条路由就交给哪个大脑，换大脑只改路由。</p>
          <p><b>接入（以企微为例）：</b>企业微信后台把「接收消息」回调地址填成本页表格里那条<b>回调地址</b>，Token / EncodingAESKey 两边一致即可。密钥入库只显掩码、编辑留空即保留。</p>
          <p><b>慢回答主动推</b>（回答超出被动回复窗口）：需填 AgentId + Secret，并把中枢出口 IP 加进该应用「企业可信 IP」。</p>
          <p><b>业务主动经渠道推消息（<code>POST /send</code>）：</b>业务后端带接入方 token 调 <code>/send</code> 把一条消息推给该渠道的某用户——会作为「回复方」记进该用户在此渠道的<b>会话历史</b>，用户追问时大脑接得上。接入方须先在「接入方」里把本渠道加进它的<b>可推渠道白名单</b>；正文原样投递、不改写。</p>
          <p>具体怎么调：点本页每行右侧的「<b>调用代码</b>」，直接复制 HTTP / Node.js / Python / PHP 高频示例；Java、Go、.NET 与任意语言按同一 HTTP 契约接入，见官网 SDK 文档。</p>
          <p><b>另一种用法 · 让任务结果自动经本渠道推（<code>delivery.type=channel</code>）：</b>到「路由」给某条路由的<b>送达</b>选「渠道直推」并绑定本渠道——业务 <code>/run</code> 触发一次，执行器/大脑跑完中枢就<b>自动</b>把结果推给指定用户（收件人由触发 metadata 带），<b>无需业务再调 /send</b>。适合"业务下发任务 → 跑完通知某人"。配法与示例在「路由」页该路由的「调用代码」里。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">新建渠道</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有渠道：把外部消息平台接进来从这里开始">
      <el-button type="primary" @click="openCreate">添加第一个</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="渠道" min-width="230" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="channel-main">
            <b>{{ row.name }}</b>
            <div class="tagline">
              <el-tag size="small" effect="plain" type="info">{{ KIND[row.kind] || row.kind }}</el-tag>
              <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="绑定与回调" min-width="420">
        <template #default="{ row }">
          <div class="channel-stack">
            <div class="tagline">
              <span class="muted">路由</span>
              <el-tag size="small" effect="plain" type="info">{{ row.route_key }}</el-tag>
              <span class="muted">{{ routeName(row.route_key) }}</span>
            </div>
            <div class="callback-line">
              <span class="mono muted">{{ callbackUrl(row) }}</span>
              <el-button link type="primary" size="small" @click="copyText(callbackUrl(row))">复制</el-button>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="能力状态" width="190">
        <template #default="{ row }">
          <div class="channel-stack">
            <div class="tagline">
              <el-tag size="small" :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '已启用' : '已停用' }}</el-tag>
              <el-tag size="small" :type="canPush(row) ? 'success' : 'warning'" effect="plain">{{ canPush(row) ? '可主动推' : '仅入站' }}</el-tag>
            </div>
            <span v-if="row.config?.bucket" class="muted">图片桶 {{ row.config.bucket }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="176" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openCode(row)">调用代码</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该渠道？该平台应用的消息将无法再进中枢。" width="260" @confirm="del(row.name)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card shadow="never" style="margin-top: 14px">
    <template #header>
      <div class="head"><b>告警通知</b> <HelpTip title="告警通知是什么">
          <p>中枢<b>自身的运行告警</b>（执行器离线 / 任务失败 / 积压 / 工具源变更等）经上面的渠道推给收件人。</p>
          <p>可按<b>事件类型分流</b>——不同的事通知不同的人 / 渠道。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" :disabled="!list.length" @click="openRuleCreate">新建规则</el-button></div>
    </template>
    <el-alert v-if="!list.length" type="warning" :closable="false" show-icon
      title="先在上方建一个可主动推的渠道（企业微信需填 AgentId + Secret，并把中枢出口 IP 加进该应用「企业可信 IP」），告警才有处可发。" />
    <el-empty v-else-if="!rules.length" description="还没有告警规则：建一条把运行告警推给自己">
      <el-button type="primary" @click="openRuleCreate">添加第一条</el-button>
    </el-empty>
    <el-table v-else :data="rules">
      <el-table-column label="规则" min-width="220">
        <template #default="{ row }">
          <div class="channel-main">
            <b>{{ row.event_prefix ? (EVENT_LABEL[row.event_prefix] || row.event_prefix) : '全部事件' }}</b>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="送达" min-width="320">
        <template #default="{ row }">
          <div class="channel-stack">
            <div class="tagline">
              <span class="muted">渠道</span>
              <el-tag size="small" effect="plain" type="info">{{ row.channel }}</el-tag>
            </div>
            <span class="mono muted">{{ recipientsText(row.recipients) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="保护" width="160">
        <template #default="{ row }">
          <div class="channel-stack">
            <el-tag size="small" :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '已启用' : '已停用' }}</el-tag>
            <span class="muted">冷却 {{ row.cooldown_min }} 分</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="104" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openRuleEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该告警规则？" width="200" @confirm="delRule(row.id)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="open" :title="editing ? '编辑渠道' : '新建渠道'" size="500px">
    <el-form label-position="top">
      <el-tabs v-model="channelFormTab" class="console-tabs">
        <el-tab-pane label="基础" name="basic">
      <el-form-item>
        <template #label>{{ fieldTitle('name', '渠道标识') }} <span v-if="fieldRequired('name')" class="field-required">*</span> <HelpTip :title="fieldTitle('name', '渠道标识')">
          <p>{{ fieldDesc('name', '渠道的唯一标识，也是回调 URL 的路径段。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.name" :disabled="editing" placeholder="如 ops-wecom / support-channel" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('kind', '类型') }} <span v-if="fieldRequired('kind')" class="field-required">*</span> <HelpTip :title="fieldTitle('kind', '类型')">
          <p>{{ fieldDesc('kind', '外部平台类型。当前生产可用类型为企业微信。') }}</p>
        </HelpTip></template>
        <el-select v-model="form.kind" style="width: 100%">
          <el-option value="wecom" label="企业微信（自建应用接收消息）" />
          <el-option value="feishu" label="飞书（预留，未实现）" disabled />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>{{ fieldTitle('route_key', '绑定路由') }} <span v-if="fieldRequired('route_key')" class="field-required">*</span> <HelpTip :title="fieldTitle('route_key', '绑定路由')">
          <p>{{ fieldDesc('route_key', '该渠道收到的用户消息会交给这条路由处理。') }}</p>
          <p>路由决定大脑、工具、知识和送达策略。</p>
        </HelpTip></template>
        <el-select v-model="form.route_key" filterable allow-create style="width: 100%" placeholder="选一条路由">
          <el-option v-for="r in routes" :key="r.route_key" :value="r.route_key"
            :label="r.route_key + (r.name ? '（' + r.name + '）' : '')" :disabled="r.enabled === false" />
        </el-select>
      </el-form-item>
        </el-tab-pane>

      <template v-if="form.kind === 'wecom'">
        <el-tab-pane label="平台参数" name="platform">
        <el-alert type="success" :closable="false" style="margin-bottom: 10px"
          :title="'回调地址：' + (form.name ? callbackUrlFor(form.name) : '（先填渠道标识）')" />
        <el-form-item>
          <template #label>{{ fieldTitle('config.token', 'Token') }} <span class="field-required">*</span> <HelpTip :title="fieldTitle('config.token', 'Token')">
            <p>{{ fieldDesc('config.token', '企业微信接收消息配置中的 Token；编辑时留空表示保留原值。') }}</p>
          </HelpTip></template>
          <el-input v-model="form.token" :type="editing ? 'password' : 'text'" show-password autocomplete="off" class="mono" placeholder="企微「接收消息」里的 Token" />
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.aes_key', 'EncodingAESKey') }} <span class="field-required">*</span> <HelpTip :title="fieldTitle('config.aes_key', 'EncodingAESKey')">
            <p>{{ fieldDesc('config.aes_key', '企业微信接收消息配置中的 EncodingAESKey；编辑时留空表示保留原值。') }}</p>
          </HelpTip></template>
          <el-input v-model="form.aes_key" type="password" show-password autocomplete="off" class="mono" />
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.corpid', '企业 ID') }} <HelpTip :title="fieldTitle('config.corpid', '企业 ID')">
            <p>{{ fieldDesc('config.corpid', '企业微信企业 ID；主动推、告警通知和慢回答推送需要填写。') }}</p>
            <p>被动回复能从消息里识别 corpid；主动推、告警通知和慢回答推送场景必须填写。</p>
          </HelpTip></template>
          <el-input v-model="form.corpid" placeholder="ww… / wx…（要主动推或当告警渠道则必填）" class="mono" />
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.agentid', 'AgentId') }} <HelpTip :title="fieldTitle('config.agentid', 'AgentId')">
            <p>{{ fieldDesc('config.agentid', '平台应用 ID。需要慢回答主动推、告警通知或业务主动推送时填写。') }}</p>
          </HelpTip></template>
          <el-input v-model="form.agentid" placeholder="如 1000013" class="mono" />
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.secret', 'Secret') }} <HelpTip :title="fieldTitle('config.secret', 'Secret')">
            <p>{{ fieldDesc('config.secret', '平台应用 Secret。需要主动推送时填写；编辑时留空表示保留原值。') }}</p>
          </HelpTip></template>
          <el-input v-model="form.secret" type="password" show-password autocomplete="off" class="mono" />
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.reply_wait_ms', '被动回复等待窗口') }} <HelpTip :title="fieldTitle('config.reply_wait_ms', '被动回复等待窗口')">
            <p>{{ fieldDesc('config.reply_wait_ms', '平台被动回复窗口内等待大脑回答的最长时间。') }}</p>
            <p>该值必须小于平台被动回复窗口；超出窗口的回答需要走主动推送。</p>
          </HelpTip></template>
          <el-input-number v-model="form.reply_wait_ms" :min="500" :max="4500" :step="500" />
          <span class="muted" style="margin-left: 8px">ms</span>
        </el-form-item>
        <el-form-item>
          <template #label>{{ fieldTitle('config.bucket', '图片存储桶') }} <HelpTip :title="fieldTitle('config.bucket', '图片存储桶')">
            <p>{{ fieldDesc('config.bucket', '用户发图时用于保存媒体文件；留空使用本地存储。') }}</p>
            <p>保存后的图片可用于视觉模型识别和会话回看；未选择外部存储时，中枢会使用服务器本地存储。</p>
          </HelpTip></template>
          <el-select v-model="form.bucket" filterable allow-create clearable style="width: 100%"
            placeholder="选一个媒体存储（与「媒体存储」里登记的一致），留空 = 本地存储">
            <el-option v-for="b in buckets" :key="b.name" :value="b.name" :label="b.name + (b.enabled === false ? '（已停用）' : '')" />
          </el-select>
        </el-form-item>
        </el-tab-pane>
      </template>

        <el-tab-pane label="发布" name="publish">
      <el-form-item>
        <template #label>{{ fieldTitle('description', '说明') }} <HelpTip :title="fieldTitle('description', '说明')">
          <p>{{ fieldDesc('description', '给后台管理员看的补充备注。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.description" />
      </el-form-item>
      <el-form-item v-if="editing">
        <template #label>{{ fieldTitle('enabled', '启用') }} <HelpTip :title="fieldTitle('enabled', '启用')">
          <p>{{ fieldDesc('enabled', '关闭后该渠道不再接收入站消息，也不再用于主动推送。') }}</p>
        </HelpTip></template>
        <el-switch v-model="form.enabled" />
      </el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="ruleOpen" :title="ruleEditing ? '编辑告警规则' : '新建告警规则'" size="460px">
    <el-form label-position="top">
      <el-form-item>
        <template #label>触发事件 <HelpTip title="触发事件">
          <p>按告警标识前缀匹配。留空表示订阅所有事件。</p>
          <p>选择「执行器离线」时，任一执行器离线都会通知；也可以只订阅你关心的事件。</p>
        </HelpTip></template>
        <el-select v-model="ruleForm.event_prefix" filterable allow-create default-first-option clearable style="width: 100%" placeholder="全部事件（留空）">
          <el-option value="" label="全部事件" />
          <el-option v-for="(lab, k) in EVENT_LABEL" :key="k" :value="k" :label="lab + '（' + k + '）'" />
        </el-select>
      </el-form-item>
      <el-form-item label="走哪个渠道">
        <el-select v-model="ruleForm.channel" filterable style="width: 100%" placeholder="选一个能主动推的渠道">
          <el-option v-for="c in list" :key="c.name" :value="c.name" :label="c.name + '（' + (KIND[c.kind] || c.kind) + '）'" :disabled="c.enabled === false" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>通知对象 <HelpTip title="通知对象">
          <p>填写渠道原生收件人 ID，例如企业微信 userid。</p>
          <p>支持多个收件人，输入后回车即可继续添加。</p>
        </HelpTip></template>
        <el-select v-model="ruleForm.recipients" multiple filterable allow-create default-first-option style="width: 100%" placeholder="如 user001" />
      </el-form-item>
      <el-form-item>
        <template #label>冷却时间 <HelpTip title="冷却时间">
          <p>同一事件在冷却时间内只通知一次，用于避免异常刷屏。</p>
        </HelpTip></template>
        <el-input-number v-model="ruleForm.cooldown_min" :min="1" :max="1440" :step="5" />
        <span class="muted" style="margin-left: 8px">分钟</span>
      </el-form-item>
      <el-form-item label="说明（可选）"><el-input v-model="ruleForm.description" /></el-form-item>
      <el-form-item v-if="ruleEditing" label="启用"><el-switch v-model="ruleForm.enabled" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="ruleOpen = false">取消</el-button>
      <el-button type="primary" :loading="ruleSaving" @click="saveRule">保存</el-button>
    </template>
  </el-drawer>

  <!-- 调用代码：业务后端主动经本渠道给某用户推消息（POST /send），复制即用 -->
  <el-dialog v-model="codeOpen" :title="'调用代码 · 经「' + (codeChannel?.name || '') + '」渠道主动推消息'" width="820px" class="code-dialog">
    <div class="code-context">
      <div class="code-context-main">
        <span class="code-context-label">接入方</span>
        <el-select v-if="eligibleClients.length" v-model="codeClientId" class="code-context-select" @change="fetchCodeToken">
        <el-option v-for="c in eligibleClients" :key="c.app_id" :value="c.app_id" :label="c.name + '（' + c.app_id + '）'" />
      </el-select>
        <span v-else class="muted">—</span>
      </div>
      <div class="code-context-note">下方示例使用所选接入方 token 调 <code>POST /send</code>；消息会作为「回复方」写入该用户在本渠道的会话历史。</div>
    </div>

    <div v-if="codeChannel" class="channel-code-summary">
      <div>
        <span>渠道</span>
        <b class="mono">{{ codeChannel.name }}</b>
        <em>{{ KIND[codeChannel.kind] || codeChannel.kind }}</em>
      </div>
      <div>
        <span>绑定路由</span>
        <b class="mono">{{ codeChannel.route_key }}</b>
        <em>{{ routeName(codeChannel.route_key) }}</em>
      </div>
      <div>
        <span>主动推送</span>
        <b>{{ canPush(codeChannel) ? '可用' : '未完整配置' }}</b>
        <em>{{ canPush(codeChannel) ? 'AgentId / Secret 已配置' : '需补 AgentId / Secret' }}</em>
      </div>
      <div>
        <span>接入授权</span>
        <b>{{ eligibleClients.length ? eligibleClients.length + ' 个接入方' : '无' }}</b>
        <em>{{ codeClientId || '请先授权可推渠道' }}</em>
      </div>
    </div>

    <el-alert v-if="!eligibleClients.length" type="warning" :closable="false" show-icon style="margin-bottom: 10px"
      :title="`还没有接入方被授权推送「${codeChannel?.name}」`"
      description="先到「接入方」页编辑一个接入方，把本渠道加入它的「可推渠道白名单」，回来这里就能拿到可直接运行的代码。下面示例先用占位 token。" />
    <el-tabs v-model="codeTab" class="code-tabs">
      <el-tab-pane label="HTTP / cURL" name="curl">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>HTTP 联调示例</b>
              <p>任意语言照此请求即可；收件人使用渠道原生 id。</p>
            </div>
            <el-button type="primary" @click="copyText(curlCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ curlCode }}</pre>
          <div class="snippet-notes">
            <span>把 <code>&lt;收件人id&gt;</code> 换成该渠道的用户原生 id，企业微信即成员 UserID。成功返回 <code>{"ok":true,"job_id":...}</code>。</span>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane label="Node.js" name="node">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>Node.js 推送示例</b>
              <p>适合业务后端主动通知用户；图片、附件、卡片字段按需加入 payload。</p>
            </div>
            <el-button type="primary" @click="copyText(nodeCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ nodeCode }}</pre>
        </section>
      </el-tab-pane>
      <el-tab-pane label="Python" name="python">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>Python 推送示例</b>
              <p>适合 Python 后端、脚本任务或数据处理服务主动通知用户。</p>
            </div>
            <el-button type="primary" @click="copyText(pythonCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ pythonCode }}</pre>
        </section>
      </el-tab-pane>
      <el-tab-pane label="PHP" name="php">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>PHP 推送示例</b>
              <p>适合 ThinkPHP、Laravel 或存量 PHP 系统；带附件时要给足超时。</p>
            </div>
            <el-button type="primary" @click="copyText(phpCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ phpCode }}</pre>
        </section>
      </el-tab-pane>
    </el-tabs>
    <div class="code-notices compact" style="margin-top: 12px">
      <div class="code-notice info">
        <b>富内容</b>
        <span><code>images</code> 是图片 URL 数组，<code>files</code> 是 <code>[{url,name}]</code>；中枢拉取后上传到渠道。任一拉取或上传失败，整条 502，不会半发。</span>
      </div>
      <div class="code-notice info">
        <b>多收件人</b>
        <span><code>to</code> 可传数组或 <code>A|B|C</code>，渠道原生合并，一次调用只占一次限速。</span>
      </div>
      <div class="code-notice info">
        <b>完整 SDK</b>
        <span>Java、Go、.NET 的 <code>HubClient</code> 同样支持 <code>/send</code>；当前弹窗只放高频示例，避免代码面板过重。</span>
        <el-button link type="primary" @click="openDoc('/docs/sdk')">打开 SDK 文档</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { openDoc } from '../docs';
import { copyText } from '../util';
import { useMe } from '../store';
import HelpTip from '../components/HelpTip.vue';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

const KIND: Record<string, string> = { wecom: '企业微信', feishu: '飞书' };
const s = useMe();
const channelSchema = useConfigSchema('channel');
const list = ref<any[]>([]);
// 调用代码弹窗（业务后端经本渠道主动推消息 /send）
const clients = ref<any[]>([]);
const codeOpen = ref(false);
const codeChannel = ref<any | null>(null);
const codeClientId = ref('');
const codeToken = ref('<接入方token>');
const codeTab = ref('curl');
const routes = ref<Array<{ route_key: string; name?: string; enabled?: boolean }>>([]);
const buckets = ref<Array<{ name: string; enabled?: boolean }>>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const channelFormTab = ref<'basic' | 'platform' | 'publish'>('basic');
const blank = { name: '', kind: 'wecom', route_key: '', corpid: '', token: '', aes_key: '', agentid: '', secret: '', reply_wait_ms: 4000, bucket: '', description: '', enabled: true };
const form = reactive({ ...blank });

function fieldTitle(field: string, fallback: string): string {
  return schemaTitle(channelSchema.schema.value, field, fallback);
}
function fieldDesc(field: string, fallback = ''): string {
  return schemaDescription(channelSchema.schema.value, field, fallback);
}
function fieldRequired(field: string): boolean {
  return schemaRequired(channelSchema.required.value, field);
}

// 回调地址：企微走 /wecom/<name>（未来其它 kind 各自前缀）
function callbackUrlFor(name: string, kind = 'wecom'): string {
  const prefix = kind === 'wecom' ? 'wecom' : kind;
  return `${location.origin}/${prefix}/${name}`;
}
function callbackUrl(row: any): string { return callbackUrlFor(row.name, row.kind); }
function routeName(routeKey?: string): string {
  const r = routes.value.find((x) => x.route_key === routeKey);
  return r?.name || routeKey || '-';
}
function canPush(row: any): boolean {
  const c = row.config || {};
  return !!(c.corpid && c.agentid && (c.secret || c.secret_masked || c.has_secret));
}
function recipientsText(recipients: unknown): string {
  const arr = Array.isArray(recipients) ? recipients.map((x) => String(x)).filter(Boolean) : [];
  if (!arr.length) return '-';
  if (arr.length <= 3) return arr.join('、');
  return `${arr.slice(0, 3).join('、')} 等 ${arr.length} 人`;
}

async function load(): Promise<void> { list.value = await api('/admin/api/channels'); }
function openCreate(): void { editing.value = false; channelFormTab.value = 'basic'; Object.assign(form, blank); open.value = true; }
function openEdit(row: any): void {
  editing.value = true;
  channelFormTab.value = 'basic';
  const c = row.config || {};
  Object.assign(form, {
    name: row.name, kind: row.kind, route_key: row.route_key,
    // 非密钥项回填；密钥（token/aes_key/secret）留空=保留原值
    corpid: c.corpid || '', token: '', aes_key: '', agentid: c.agentid || '', secret: '',
    reply_wait_ms: Number(c.reply_wait_ms) || 4000, bucket: c.bucket || '',
    description: row.description || '', enabled: !!row.enabled,
  });
  open.value = true;
}
async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = {
      name: form.name, kind: form.kind, route_key: form.route_key,
      description: form.description, enabled: form.enabled,
      config: { corpid: form.corpid, token: form.token, aes_key: form.aes_key, agentid: form.agentid, secret: form.secret, reply_wait_ms: form.reply_wait_ms, bucket: form.bucket },
    };
    await api('/admin/api/channels', { method: 'POST', body: JSON.stringify(body) });
    ElMessage.success('已保存（密钥不再回显完整值）'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function del(name: string): Promise<void> {
  try { await api('/admin/api/channels/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}

// ---- 告警通知规则（系统告警→渠道→收件人）----
const EVENT_LABEL: Record<string, string> = {
  executor_offline: '执行器离线', queue_backlog: '任务积压', error_burst: '任务失败激增',
  spec_change: '工具源 spec 变更', spec_refresh_fail: '工具源 spec 刷新失败', authz_probe: '工具源鉴权探针告警',
};
const rules = ref<any[]>([]);
const ruleOpen = ref(false);
const ruleEditing = ref(false);
const ruleSaving = ref(false);
const ruleBlank = { id: 0, event_prefix: '', channel: '', recipients: [] as string[], cooldown_min: 60, description: '', enabled: true };
const ruleForm = reactive({ ...ruleBlank });
async function loadRules(): Promise<void> { try { rules.value = await api('/admin/api/alert-rules'); } catch { /* 可选 */ } }
function openRuleCreate(): void { ruleEditing.value = false; Object.assign(ruleForm, ruleBlank, { recipients: [] }); ruleOpen.value = true; }
function openRuleEdit(row: any): void {
  ruleEditing.value = true;
  Object.assign(ruleForm, { id: row.id, event_prefix: row.event_prefix || '', channel: row.channel, recipients: [...(row.recipients || [])], cooldown_min: row.cooldown_min || 60, description: row.description || '', enabled: !!row.enabled });
  ruleOpen.value = true;
}
async function saveRule(): Promise<void> {
  if (!ruleForm.channel) { ElMessage.error('请选择渠道'); return; }
  if (!ruleForm.recipients.length) { ElMessage.error('至少填一个收件人'); return; }
  ruleSaving.value = true;
  try {
    await api('/admin/api/alert-rules', { method: 'POST', body: JSON.stringify({ ...ruleForm, id: ruleForm.id || undefined }) });
    ElMessage.success('已保存'); ruleOpen.value = false; await loadRules();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { ruleSaving.value = false; }
}
async function delRule(id: number): Promise<void> {
  try { await api('/admin/api/alert-rules/' + id, { method: 'DELETE' }); await loadRules(); }
  catch (e) { ElMessage.error((e as Error).message); }
}

// ---- 调用代码：业务后端经本渠道主动推消息（POST /send）----
// 有资格推本渠道的接入方 = allowed_channels 含本渠道名 或 '*'
const eligibleClients = computed(() => clients.value.filter((c) => (c.allowed_channels || []).includes('*') || (c.allowed_channels || []).includes(codeChannel.value?.name)));
async function openCode(row: any): Promise<void> {
  codeChannel.value = row;
  codeTab.value = 'curl';
  codeToken.value = '<接入方token>';
  const eligible = clients.value.filter((c) => (c.allowed_channels || []).includes('*') || (c.allowed_channels || []).includes(row.name));
  codeClientId.value = eligible[0]?.app_id || '';
  codeOpen.value = true;
  if (codeClientId.value) await fetchCodeToken();
}
// 取真实 token（列表只给掩码；要可直接运行就显式取回完整值，后端 clients:write 鉴权 + 审计留痕）
async function fetchCodeToken(): Promise<void> {
  if (!codeClientId.value) { codeToken.value = '<接入方token>'; return; }
  try {
    const r = await api<{ token: string }>('/admin/api/clients/' + encodeURIComponent(codeClientId.value) + '/token');
    codeToken.value = r.token;
  } catch { codeToken.value = '<接入方token>'; } // 无权限取回则留占位，开发者自行替换
}
const phpCode = computed(() => {
  const ch = codeChannel.value; if (!ch) return '';
  const base = location.origin;
  const fn = 'bailing_send_' + String(ch.name).replace(/[^a-z0-9]+/gi, '_');
  const prefix = codeClientId.value ? codeClientId.value + '_' : '';
  return `/**
 * 百灵中枢 · 经「${ch.name}」渠道主动给某用户推一条消息（文字 / 图片 / 附件）
 * 会作为「回复方」记进该用户在本渠道的会话历史；用户随后追问，大脑接得上。
 * 用法：
 *   ${fn}('事件号', 'UserA', '您的请求已处理完成');                            // 纯文字（单收件人）
 *   ${fn}('事件号', ['UserA','UserB'], '有新的待处理任务');                     // 一次发多人（数组，渠道原生合并、占一次限速）
 *   ${fn}('事件号', 'UserA', '处理报告与附件', ['https://.../report.jpg'],      // 文字 + 图片 + 附件
 *       [['url' => 'https://.../attachment.pdf', 'name' => 'attachment.pdf']]);
 *   ${fn}('事件号', 'UserA', '任务已分配给你', [], [], [                        // 企业微信卡片（textcard）
 *       'title' => '[待处理] 任务 TASK-2026-001 已分配给你',
 *       'description' => '<div class="highlight">…</div>',
 *       'url' => 'https://open.weixin.qq.com/connect/oauth2/authorize?...',     // 免登深链
 *       'btntxt' => '查看详情']);
 */
function ${fn}(string $requestId, $to, string $text, array $images = [], array $files = [], ?array $card = null): array
{
    $payload = [
        'request_id' => '${prefix}' . $requestId, // 幂等键：失败要重试请换新号
        'channel'    => '${ch.name}',
        'to'         => $to,                        // 收件人渠道原生 id（企业微信 UserID）；可传数组或 "A|B|C" 发多人
        'text'       => $text,                      // 原样投递、≤2000 字；也是卡片/不支持渠道的降级文案 + 入会话历史
    ];
    if ($images) $payload['images'] = $images;     // 图片 URL 数组，≤10MB/张，中枢拉取→上传→投递
    if ($files)  $payload['files']  = $files;      // [['url'=>..,'name'=>..], ...]，≤20MB/个
    if ($card)   $payload['card']   = $card;       // 企业微信 textcard：{title,description,url,btntxt}，仅企业微信渠道生效
    $ch = curl_init('${base}/send');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Authorization: Bearer ${codeToken.value}'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT        => 20, // 带附件要拉取+上传，给足时间
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    // 成功 {"ok":true,"job_id":...}；失败 {"ok":false,"error":...}
    return json_decode($resp ?: '{}', true) ?: [];
}`;
});
const curlCode = computed(() => {
  const ch = codeChannel.value; if (!ch) return '';
  const base = location.origin;
  const prefix = codeClientId.value ? codeClientId.value + '_' : '';
  return `# ① 纯文字
curl -X POST '${base}/send' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${codeToken.value}' \\
  -d '{"request_id":"${prefix}demo-1","channel":"${ch.name}","to":"<收件人id>","text":"您的请求已处理完成"}'

# ② 文字 + 图片 + 附件（URL 制：中枢拉取→上传→投递；text 可省，纯发图也行）
curl -X POST '${base}/send' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${codeToken.value}' \\
  -d '{"request_id":"${prefix}demo-2","channel":"${ch.name}","to":"<收件人id>","text":"处理报告与附件","images":["https://你的域名/report.jpg"],"files":[{"url":"https://你的域名/attachment.pdf","name":"attachment.pdf"}]}'

# ③ 企业微信卡片 textcard（标题+描述+「查看详情」按钮+免登深链；text 作降级/入历史）
curl -X POST '${base}/send' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${codeToken.value}' \\
  -d '{"request_id":"${prefix}demo-3","channel":"${ch.name}","to":"<收件人id>","text":"任务 TASK-2026-001 已分配给你","card":{"type":"textcard","title":"[待处理] 任务 TASK-2026-001 已分配给你","description":"<div class=\\"highlight\\">对象：示例记录</div>","url":"https://open.weixin.qq.com/connect/oauth2/authorize?...","btntxt":"查看详情"}}'

# ④ 一次发多人（to 传数组或 "A|B|C"，渠道原生合并，一次调用、占一次限速）
curl -X POST '${base}/send' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${codeToken.value}' \\
  -d '{"request_id":"${prefix}demo-4","channel":"${ch.name}","to":["UserA","UserB","UserC"],"text":"有新的待处理任务"}'`;
});
const nodeCode = computed(() => {
  const ch = codeChannel.value; if (!ch) return '';
  const base = location.origin;
  const prefix = codeClientId.value ? codeClientId.value + '_' : '';
  return `// 百灵中枢 · 经「${ch.name}」渠道主动推消息
// to 使用渠道原生用户 id；企业微信即成员 UserID。可传数组一次发多人。

const payload = {
  request_id: '${prefix}demo-1',
  channel: '${ch.name}',
  to: '<收件人id>',
  text: '您的请求已处理完成',
  // images: ['https://你的域名/report.jpg'],
  // files: [{ url: 'https://你的域名/attachment.pdf', name: 'attachment.pdf' }],
  // card: { type: 'textcard', title: '[待处理] 任务 TASK-2026-001', description: '<div class="highlight">对象：示例记录</div>', url: 'https://...', btntxt: '查看详情' },
};

const response = await fetch('${base}/send', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ${codeToken.value}',
  },
  body: JSON.stringify(payload),
});

console.log(await response.json());`;
});
const pythonCode = computed(() => {
  const ch = codeChannel.value; if (!ch) return '';
  const base = location.origin;
  const prefix = codeClientId.value ? codeClientId.value + '_' : '';
  return `# 百灵中枢 · 经「${ch.name}」渠道主动推消息
# to 使用渠道原生用户 id；企业微信即成员 UserID。可传数组一次发多人。
# pip install requests

import requests

payload = {
    "request_id": "${prefix}demo-1",
    "channel": "${ch.name}",
    "to": "<收件人id>",
    "text": "您的请求已处理完成",
    # "images": ["https://你的域名/report.jpg"],
    # "files": [{"url": "https://你的域名/attachment.pdf", "name": "attachment.pdf"}],
    # "card": {"type": "textcard", "title": "[待处理] 任务 TASK-2026-001", "description": "<div class=\\"highlight\\">对象：示例记录</div>", "url": "https://...", "btntxt": "查看详情"},
}

response = requests.post(
    "${base}/send",
    json=payload,
    headers={"Authorization": "Bearer ${codeToken.value}"},
    timeout=20,
)
print(response.json())`;
});

onMounted(async () => {
  await Promise.all([channelSchema.load().catch(() => undefined), load(), loadRules()]);
  if (s.can('routes:read')) { try { routes.value = await api('/admin/api/routes'); } catch { /* 可选 */ } }
  if (s.can('storage:read')) { try { buckets.value = await api('/admin/api/storage-buckets'); } catch { /* 桶列表可选，仍可手填 */ } }
  if (s.can('clients:read')) { try { clients.value = await api('/admin/api/clients'); } catch { /* 「调用代码」要选接入方，可选 */ } }
});
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { margin-top: 4px; line-height: 1.5; }
.channel-main,
.channel-stack {
  display: grid;
  align-items: start;
  gap: 4px;
  min-width: 0;
}
.channel-main b {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tagline,
.callback-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.callback-line .mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-code-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 12px;
  border: 1px solid var(--el-border-color-lighter);
}
.channel-code-summary > div {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.channel-code-summary > div:last-child { border-right: 0; }
.channel-code-summary span,
.channel-code-summary em {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-style: normal;
}
.channel-code-summary b {
  display: block;
  margin: 4px 0 2px;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.code-client { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.codehead { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.codehead b { font-size: 13px; }
.codeblock { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); padding: 12px; overflow: auto; font: 12px/1.55 var(--bz-mono); margin: 0; white-space: pre; }
@media (max-width: 900px) {
  .channel-code-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .channel-code-summary > div:nth-child(2) { border-right: 0; }
  .channel-code-summary > div:nth-child(-n + 2) { border-bottom: 1px solid var(--el-border-color-lighter); }
}
</style>
