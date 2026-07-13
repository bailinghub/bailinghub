<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>聊天入口</b> <HelpTip title="聊天入口是什么">
          <p>网页聊天组件的公开插座：建入口绑一条路由 → 拿一行 <code>script</code> 贴进任何网页；背后是 LLM 还是执行器智能体，入口无感。</p>
        </HelpTip>
        <el-button type="primary" style="margin-left: auto" @click="openCreate">新建入口</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有聊天入口：绑一条触发路由即可生成可嵌入的网页聊天组件">
      <el-button type="primary" @click="openCreate">新建第一个</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="入口" min-width="230" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="entry-main">
            <b>{{ row.name || row.entry_key }}</b>
            <code>{{ row.entry_key }}</code>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="绑定场景" min-width="230">
        <template #default="{ row }">
          <div class="entry-stack">
            <div>
              <el-tag size="small" effect="plain" type="info">{{ row.route_key }}</el-tag>
              <span class="muted">{{ routeTarget(row.route_key) }}</span>
            </div>
            <span class="muted">{{ routeName(row.route_key) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="发布边界" min-width="300">
        <template #default="{ row }">
          <div class="entry-stack">
            <div class="tagline">
              <span class="muted">站点</span>
              <template v-if="row.allowed_origins?.length">
                <el-tag v-for="origin in previewList(row.allowed_origins, '全部站点')" :key="origin" size="small" effect="plain" type="info">{{ origin }}</el-tag>
              </template>
              <el-tag v-else size="small" type="warning" effect="plain">不限 Origin</el-tag>
            </div>
            <div class="tagline">
              <el-tag size="small" effect="plain" :type="row.ticket_client ? 'success' : 'info'">{{ row.ticket_client ? '登录票据:' + row.ticket_client : '匿名入口' }}</el-tag>
              <el-tag size="small" effect="plain" type="success">媒体上传:{{ row.bucket || '本地' }}</el-tag>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="运行保护" width="126">
        <template #default="{ row }">
          <div class="protection-stack">
            <el-tooltip :content="row.enabled ? '聊天组件展示中' : '聊天组件已暂停'" placement="top">
              <el-switch :model-value="!!row.enabled" :loading="entryToggleKey === row.entry_key" @change="toggleEntry(row, Boolean($event))" />
            </el-tooltip>
            <span class="muted">限速 {{ row.rate_limit_per_min }}/分/IP</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="274" align="right">
        <template #default="{ row }">
          <div class="table-actions">
            <el-button link type="primary" @click="openEmbed(row)">嵌入代码</el-button>
            <el-button link type="primary" @click="openDemo(row)">试聊</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-dropdown trigger="click" @command="(cmd) => handleEntryCommand(String(cmd), row)">
              <el-button link type="primary">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="page-context">页面登记</el-dropdown-item>
                  <el-dropdown-item command="ratings">评价记录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-popconfirm title="删除该入口？已嵌入的页面组件会立即失效。" width="260" @confirm="del(row.entry_key)">
              <template #reference><el-button link type="danger">删</el-button></template>
            </el-popconfirm>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 新建/编辑 -->
  <el-drawer v-model="open" :title="editing ? '编辑聊天入口' : '新建聊天入口'" size="520px">
    <el-form label-position="top">
      <el-tabs v-model="chatFormTab" class="console-tabs">
        <el-tab-pane label="基础接入" name="basic">
      <el-form-item>
        <template #label>聊天组件 <HelpTip title="聊天组件启停">
          <p>关闭后，已经嵌入业务页面的脚本仍可保留，但悬浮按钮和聊天窗口都不会展示，新消息、历史、上传和评价接口也会停止服务。</p>
          <p>重新开启后，业务页面无需改代码，访客下次加载页面即可恢复。</p>
        </HelpTip></template>
        <el-switch v-model="form.enabled" />
        <span class="state-copy">{{ form.enabled ? '展示并接收新会话' : '暂停展示与新会话' }}</span>
      </el-form-item>
      <el-form-item label="名称"><el-input v-model="form.name" placeholder="如 在线助手" /></el-form-item>
      <el-form-item>
        <template #label>绑定路由 <span class="field-required">必填</span> <HelpTip title="绑定路由">
          <p>入口的所有提问交给这条路由处理——它决定大脑（target / 模型 / 提示词）、知识库、可用工具。</p>
          <p>聊天按访客自动续会话（带票按 uid、匿名按 visitor_id），<b>路由的会话策略对入口不生效</b>；业务多会话 UI 用聊天 body 的 <code>thread_id</code> 切分。</p>
        </HelpTip></template>
        <el-select v-model="form.route_key" filterable style="width: 100%">
          <el-option v-for="r in routes" :key="r.route_key" :label="`${r.name}（${r.route_key} → ${r.target}）`" :value="r.route_key" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>站点 Origin <HelpTip title="Origin 白名单">
          <p>一行一个，如 <code>https://www.example.com</code>。留空 = 不限（试用模式），<b>正式上线建议配置</b>。</p>
          <p>它只防"别家网页盗嵌"——<b>小程序 / 服务端调用不带浏览器 Origin 头，不会被白名单拦截</b>，可放心配。</p>
        </HelpTip></template>
        <el-input v-model="form.origins_text" type="textarea" :rows="3" class="mono" placeholder="https://www.example.com" />
      </el-form-item>
      <el-form-item>
        <template #label>票据签发方 <HelpTip title="票据签发方（登录身份怎么进来）">
          <p>业务后端用该接入方的 token 给<b>登录用户</b>签短票（HMAC 算法或任意语言 SDK，默认 2 小时），组件带 <code>data-ticket</code> 即获可信身份——uid 进 <code>metadata.visitor_uid</code>，解锁标「需主体」的工具，并原样透传到业务侧 On-Behalf-Of。</p>
          <p>同一把 token 也用于「送达 webhook」回调验签（一钥贯通）。留空 = 纯匿名入口；<b>token 永不进前端</b>，进前端的只有签好的短票。</p>
        </HelpTip></template>
        <el-select v-model="form.ticket_client" clearable filterable style="width: 100%" placeholder="不启用票据">
          <el-option v-for="c in clients" :key="c.app_id" :label="`${c.name}（${c.app_id}）`" :value="c.app_id" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>媒体存储 <HelpTip title="媒体存储">
          <p>图片和语音都会先变成永久 URL，再进入会话、视觉/语音模型和业务工具参数。</p>
          <p>留空 = 使用服务器本地 <code>data/uploads</code>，开箱可用；选择外部对象存储 = 使用业务 CDN、生命周期管理和多副本共享，适合生产。</p>
        </HelpTip></template>
        <el-select v-model="form.bucket" clearable filterable style="width: 100%" placeholder="使用服务器本地存储（默认）">
          <el-option v-for="b in buckets" :key="b.name" :label="`${b.name}（${b.kind === 'local' ? '本地' : b.bucket}）`" :value="b.name" :disabled="!b.enabled" />
        </el-select>
      </el-form-item>
      <el-form-item label="按 IP 限速"><el-input-number v-model="form.rate_limit_per_min" :min="1" :max="600" /><span class="muted" style="margin-left: 8px">次/分钟</span></el-form-item>
        </el-tab-pane>
        <el-tab-pane label="外观" name="appearance">
      <el-form-item label="组件标题"><el-input v-model="form.title" placeholder="留空用名称" /></el-form-item>
      <el-form-item label="开场白（组件首条气泡）"><el-input v-model="form.greeting" placeholder="你好，有什么可以帮你？" /></el-form-item>
      <el-form-item label="主色">
        <el-color-picker v-model="form.color" :predefine="['#3fb950', '#3a6ea5', '#3a7a55', '#8a4f7d']" />
      </el-form-item>

      <el-form-item label="标题对齐">
        <el-radio-group v-model="form.title_align">
          <el-radio-button value="center">居中</el-radio-button>
          <el-radio-button value="left">居左</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="展开窗口尺寸（px）">
        <div class="row">
          <span class="muted">宽</span><el-input-number v-model="form.width" :min="280" :max="720" :step="10" controls-position="right" style="width: 128px" />
          <span class="muted">高</span><el-input-number v-model="form.height" :min="360" :max="900" :step="10" controls-position="right" style="width: 128px" />
          <span class="muted">手机端自动接近全屏，不受此值限制</span>
        </div>
      </el-form-item>
      <el-form-item>
        <template #label>允许访客拖动改尺寸 <HelpTip title="访客可调整窗口大小">
          <p>开启后，访客可把鼠标放在展开面板的<b>上边框</b>拖动改高、<b>靠内一侧的边框</b>（贴右下角时为左边、贴左下角时为右边）拖动改宽，夹在上面的宽高上下限内，按访客本地记住。</p>
          <p class="muted">适合当工作台用、要读长回答/表格的场景；轻量问答可保持关闭。手机端面板本就接近全屏，此开关自动不生效。</p></HelpTip></template>
        <el-switch v-model="form.resizable" />
      </el-form-item>
      <el-form-item>
        <template #label>AI 内容提示 <HelpTip title="AI 内容提示">
          <p>开启后，每条 AI 回复下方显示「由 AI 生成，请结合实际业务结果核验」，复制回复时也会附带该提示。</p>
          <p>如果业务侧已经在自己的页面统一声明 AI 生成内容，可以关闭这里的组件内提示。</p>
        </HelpTip></template>
        <el-switch v-model="form.ai_notice" />
      </el-form-item>
      <el-form-item>
        <template #label>品牌标识 <HelpTip title="组件底部品牌标识">
          <p>控制聊天窗口底部是否展示品牌文案。关闭后整行收起，不会留下空白区域。</p>
          <p>开源版允许部署方使用自己的品牌；留空文案时使用当前中枢的默认品牌名称。</p>
        </HelpTip></template>
        <el-switch v-model="form.powered_by_visible" />
        <span class="state-copy">{{ form.powered_by_visible ? '显示' : '隐藏' }}</span>
      </el-form-item>
      <el-form-item v-if="form.powered_by_visible" label="品牌文案">
        <el-input v-model="form.powered_by_text" maxlength="80" show-word-limit placeholder="留空使用当前中枢的默认品牌文案" />
      </el-form-item>
      <el-form-item label="气泡位置">
        <div class="position-config">
          <div class="row">
            <el-radio-group v-model="form.position">
              <el-radio-button value="right">右下角</el-radio-button>
              <el-radio-button value="left">左下角</el-radio-button>
            </el-radio-group>
          </div>
          <div class="row offset-row">
            <span class="muted">距侧边</span><el-input-number v-model="form.offset_x" :min="0" :max="400" :step="4" controls-position="right" style="width: 116px" />
            <span class="muted">距底部</span><el-input-number v-model="form.offset_y" :min="0" :max="400" :step="4" controls-position="right" style="width: 116px" />
          </div>
        </div>
      </el-form-item>
      <el-form-item>
        <template #label>头部 Logo / 头像 <HelpTip title="头部头像">
          <p>标题旁的小圆头像，填图片 URL（http/https）。留空 = 不显示。</p></HelpTip></template>
        <el-input v-model="form.avatar" placeholder="https://…/logo.png（留空不显示）" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>自定义气泡图标 <HelpTip title="气泡图标">
          <p>右下角悬浮气泡里的图标，填图片 URL（http/https）。留空 = 用内置对话气泡图标。</p></HelpTip></template>
        <el-input v-model="form.launcher_icon" placeholder="https://…/icon.png（留空用默认气泡）" class="mono" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item label="说明（可选）"><el-input v-model="form.description" /></el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>

  <!-- 嵌入代码 -->
  <el-dialog v-model="embedOpen" :title="'嵌入代码 · ' + embedRow?.name" width="820px" class="code-dialog">
    <div class="code-notices compact">
      <div class="code-notice info">
        <b>entry_key 可公开</b>
        <span>页面源码可见是预期行为；防滥用依靠 Origin 白名单、按 IP 限速和入口停用。</span>
      </div>
      <div class="code-notice warning" v-if="!embedRow?.ticket_client">
        <b>当前匿名入口</b>
        <span>匿名访客没有业务操作主体，挂工具的路由里写操作会被业务侧拒绝。</span>
      </div>
    </div>

    <div v-if="embedRow" class="embed-entry-summary">
      <div>
        <span>入口</span>
        <b class="mono">{{ embedRow.entry_key }}</b>
        <em>{{ embedRow.name }}</em>
      </div>
      <div>
        <span>绑定路由</span>
        <b class="mono">{{ embedRow.route_key }}</b>
        <em>{{ routeName(embedRow.route_key) }}</em>
      </div>
      <div>
        <span>站点边界</span>
        <b>{{ originSummary(embedRow) }}</b>
        <em>{{ embedRow.rate_limit_per_min }}/分/IP</em>
      </div>
      <div>
        <span>访客身份</span>
        <b>{{ embedRow.ticket_client ? '登录票据' : '匿名' }}</b>
        <em>{{ embedRow.ticket_client || '无票据签发方' }}</em>
      </div>
    </div>

    <el-tabs v-model="embedTab" class="code-tabs">
      <el-tab-pane label="网页嵌入" name="script">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>页面组件代码</b>
              <p>贴到任意页面的 <code>&lt;/body&gt;</code> 前，页面右下角会出现聊天气泡。</p>
            </div>
            <el-button type="primary" @click="copy(embedScript)">复制代码</el-button>
          </div>
          <pre class="snippet-code compact">{{ embedScript }}</pre>
        </section>
      </el-tab-pane>

      <el-tab-pane label="演示链接" name="demo">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>在线演示页</b>
              <p>无需嵌入页面，适合发给业务方快速试聊。</p>
            </div>
            <el-button type="primary" @click="copy(demoUrl)">复制链接</el-button>
          </div>
          <pre class="snippet-code compact">{{ demoUrl }}</pre>
        </section>
      </el-tab-pane>

      <el-tab-pane label="接口直调" name="api">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>聊天接口示例</b>
              <p>不用网页组件、自己做 UI 时按这个接口收发消息。</p>
            </div>
            <el-button type="primary" @click="copy(curlText)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ curlText }}</pre>
          <div class="snippet-notes">
            <span>聊天任务结果只能走 <code>/chat/&lt;入口&gt;/result/&lt;job_id&gt;</code>，不能用接入方 token 调 <code>/jobs/&lt;id&gt;</code>。</span>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane v-if="embedRow?.ticket_client" label="访客票据" name="ticket">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>登录访客票据生成</b>
              <p>业务后端在登录态里执行，接入方 token 永不进入前端；任选一种语言实现同一签名算法。</p>
            </div>
            <el-button type="primary" @click="copy(ticketCode)">复制代码</el-button>
          </div>
          <el-tabs v-model="ticketTab" class="code-subtabs">
            <el-tab-pane label="Node.js" name="node" />
            <el-tab-pane label="Python" name="python" />
            <el-tab-pane label="PHP" name="php" />
          </el-tabs>
          <pre class="snippet-code">{{ ticketCode }}</pre>
          <div class="snippet-notes">
            <span>带票据的访客会成为可信身份，uid 会进入 <code>metadata.visitor_uid</code> 并透传给业务工具。</span>
            <span>Java、Go、.NET 也提供同等票据签发 helper，完整用法见官网 SDK 文档。</span>
            <el-button link type="primary" @click="openDoc('/docs/sdk')">打开 SDK 文档</el-button>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>

  <!-- 评价记录：包含有用/没用/文字反馈，供运营回看回答质量 -->
  <el-drawer v-model="ratingsOpen" :title="'评价记录 · ' + ratingsRow?.name" size="920px">
    <el-empty v-if="!ratings.length" description="还没有评价：访客在组件里点「有用 / 没用 / 反馈」后在这里汇总" />
    <el-table v-else :data="ratings" size="small">
      <el-table-column label="评价" width="70">
        <template #default="{ row }">
          <el-tag size="small" :type="ratingTagType(row.rating)" effect="plain">{{ ratingLabel(row.rating) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="问题" min-width="160" show-overflow-tooltip><template #default="{ row }">{{ row.question || '（任务已清理）' }}</template></el-table-column>
      <el-table-column label="回答" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ row.reply || '-' }}</template></el-table-column>
      <el-table-column label="文字反馈" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.comment || '-' }}</template></el-table-column>
      <el-table-column label="时间" width="150"><template #default="{ row }"><span class="muted">{{ fmtTime(row.updated_at) }}</span></template></el-table-column>
      <el-table-column width="80" align="right">
        <template #default="{ row }"><el-button link type="primary" @click="$router.push('/runs?job=' + row.job_id)">看任务</el-button></template>
      </el-table-column>
    </el-table>
  </el-drawer>

  <!-- 页面登记：URL 模式 → 页面说明，中枢匹配后注入 AI 并落任务详情 -->
  <el-drawer v-model="pageCtxOpen" :title="'页面登记 · ' + pageCtxRow?.name" size="640px">
    <el-alert type="info" :closable="false" style="margin-bottom: 14px"
      title="组件每条消息自动上报当前页 URL（path+hash，去 query）。这里声明「URL 模式 → 页面说明」，中枢匹配后把页面背景注入 AI、并落到任务详情，便于精准定位用户从哪个页面发起。只需声明你在意的页面，未命中的自动按原始路径兜底；几百上千路由也无需逐个写代码。" />
    <el-form label-position="top">
      <el-form-item>
        <template #label>URL 模式 <HelpTip title="URL 模式">
          <p><code>*</code> 为通配，匹配组件抓到的 <code>path+hash</code>（子串命中即可）。如 <code>*/users/list*</code>、<code>/admin/settings</code>、<code>#/records/*/detail</code>。</p>
          <p>多条命中时取优先级高者；同级取模式更长（更具体）者。</p>
        </HelpTip></template>
        <el-input v-model="pageForm.url_pattern" placeholder="如 */users/list*" class="mono" />
      </el-form-item>
      <div class="row2">
        <el-form-item label="页面标识 page_key（可选）" style="flex: 1">
          <el-input v-model="pageForm.page_key" placeholder="如 users.list" class="mono" />
        </el-form-item>
        <el-form-item label="页面名（可选）" style="flex: 1">
          <el-input v-model="pageForm.page_name" placeholder="如 用户列表" />
        </el-form-item>
      </div>
      <el-form-item label="页面说明（注入给 AI：这页承载什么功能）">
        <el-input v-model="pageForm.description" type="textarea" :rows="3" placeholder="如：承载用户检索、标记、导出；权限配置在「设置」页维护" />
      </el-form-item>
      <div class="row2">
        <el-form-item label="优先级（高者先匹配）"><el-input-number v-model="pageForm.priority" :min="0" :max="100" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="pageForm.enabled" /></el-form-item>
      </div>
      <el-button type="primary" :loading="pageSaving" @click="savePageRule">{{ pageForm.id ? '更新规则' : '新增规则' }}</el-button>
      <el-button v-if="pageForm.id" @click="resetPageForm">取消编辑</el-button>
    </el-form>
    <el-divider />
    <el-empty v-if="!pageRules.length" description="还没有页面登记：上面加一条 URL 模式 → 页面说明" />
    <el-table v-else :data="pageRules" size="small">
      <el-table-column label="URL 模式" min-width="150"><template #default="{ row }"><code class="mono">{{ row.url_pattern }}</code></template></el-table-column>
      <el-table-column label="页面" min-width="120"><template #default="{ row }"><b>{{ row.page_name || '-' }}</b><div class="muted mono">{{ row.page_key }}</div></template></el-table-column>
      <el-table-column label="优先级" width="70" align="center"><template #default="{ row }">{{ row.priority }}</template></el-table-column>
      <el-table-column label="启用" width="56" align="center"><template #default="{ row }">{{ row.enabled ? '✓' : '停' }}</template></el-table-column>
      <el-table-column width="100" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="editPageRule(row)">编辑</el-button>
          <el-popconfirm title="删除该规则？" width="200" @confirm="delPageRule(row.id)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { api } from '../request';
import { openDoc } from '../docs';
import { fmtTime } from '../util';
import HelpTip from '../components/HelpTip.vue';

const list = ref<any[]>([]);
const routes = ref<any[]>([]);
const clients = ref<any[]>([]);
const buckets = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const chatFormTab = ref<'basic' | 'appearance' | 'publish'>('basic');
const APPEARANCE_DEFAULTS = { title_align: 'center', width: 400, height: 600, position: 'right', offset_x: 24, offset_y: 24, avatar: '', launcher_icon: '', resizable: false, ai_notice: true, powered_by_visible: true, powered_by_text: '' };
const form = reactive({ entry_key: '', name: '', route_key: '', origins_text: '', ticket_client: '', bucket: '', title: '', greeting: '', color: '#3fb950', ...APPEARANCE_DEFAULTS, rate_limit_per_min: 20, description: '', enabled: true });
const entryToggleKey = ref('');

function routeOf(routeKey?: string): any | undefined {
  return routes.value.find((r) => r.route_key === routeKey);
}
function routeName(routeKey?: string): string {
  const r = routeOf(routeKey);
  if (!r) return '未找到路由';
  return r.name || r.route_key;
}
function routeTarget(routeKey?: string): string {
  const r = routeOf(routeKey);
  return r?.target ? `→ ${r.target}` : '';
}
function previewList(values: unknown, allLabel: string): string[] {
  const arr = Array.isArray(values) ? values.map((x) => String(x)).filter(Boolean) : [];
  if (!arr.length) return [];
  if (arr.includes('*')) return [allLabel];
  if (arr.length <= 2) return arr;
  return [...arr.slice(0, 2), `+${arr.length - 2}`];
}
function originSummary(row: any): string {
  const origins = Array.isArray(row.allowed_origins) ? row.allowed_origins.filter(Boolean) : [];
  if (!origins.length) return '不限 Origin';
  return origins.length === 1 ? origins[0] : `${origins.length} 个站点`;
}

const ratingsOpen = ref(false);
const ratingsRow = ref<any | null>(null);
const ratings = ref<any[]>([]);
function ratingLabel(v: string): string {
  return v === 'up' ? '有用' : v === 'down' ? '没用' : '反馈';
}
function ratingTagType(v: string): 'success' | 'danger' | 'info' {
  return v === 'up' ? 'success' : v === 'down' ? 'danger' : 'info';
}

// 页面登记
const pageCtxOpen = ref(false);
const pageCtxRow = ref<any | null>(null);
const pageRules = ref<any[]>([]);
const pageSaving = ref(false);
const pageForm = reactive({ id: 0, url_pattern: '', page_key: '', page_name: '', description: '', priority: 0, enabled: true });

const embedOpen = ref(false);
const embedRow = ref<any | null>(null);
const embedTab = ref<'script' | 'demo' | 'api' | 'ticket'>('script');
const ticketTab = ref<'node' | 'python' | 'php'>('node');
const HOST = location.origin;
const embedScript = computed(() => `<script src="${HOST}/widget.js" data-entry="${embedRow.value?.entry_key}" async><\/script>`);
const demoUrl = computed(() => `${HOST}/widget/demo/${embedRow.value?.entry_key}`);
const curlText = computed(() => [
  `curl -X POST '${HOST}/chat/${embedRow.value?.entry_key}' \\`,
  `  -H 'content-type: application/json' \\`,
  `  -d '{"message":"你好","visitor_id":"demo-visitor-01","wait_ms":8000,"ticket":"<可选：登录身份票据，签法见下方票据生成>"}'`,
  `# 带 ticket = 登录身份（验签失败回 401，不会静默降级为匿名）；不带 = 匿名访客`,
  `# 可选 thread_id（字母数字_-，≤32 字符）：同一身份下按它切分平行会话——开新会话=换新值，续旧会话=复用；不带=该身份单线程续聊`,
  `# 返回 {done,reply,job_id,visitor_id,references?,attachments?}；done=false 时轮询 GET /chat/<入口>/result/<job_id>?wait=8000`,
  `# reply=markdown 回复；attachments=解析好的富内容数组(图片/文件)，无 md 渲染器的端按 type 渲染（详见官网 /docs#routes）`,
  `# 注意：聊天任务归属本入口，不能用接入方 token 走 GET /jobs/<id> 查（那是 API 触发任务的取法），结果只走上面的 result 端点`,
  `# 审批类操作（如删除）：首跑回"已提交审批"，业务侧或控制台兜底批准后任务重跑，最终结果经路由「送达 webhook」回调业务后端`,
  `# 载荷、签名和重试规范见官网 /docs/api；同 job_id 的 result 端点也会更新，可作轮询兜底`,
  `# 评价：POST /chat/<入口>/rate/<job_id>  体 {"rating":"up|down|note","visitor_id":"<同上>","comment":"可选；rating=note 时必填"}`,
  `# 小程序/服务端调用不带浏览器 Origin 头：站点 Origin 白名单不拦（它只防别家网页盗嵌）`,
].join('\n'));
const ticketPhp = computed(() => [
  `// 用接入方「${embedRow.value?.ticket_client}」的 token 签发（1 小时有效，按需调整）`,
  `// uid 是中枢原样回传的「操作主体」串：多租户务必把租户编进去（如 "{$tenantId}:{$uid}"），别只签裸 uid——`,
  `// 否则接第二个租户时 uid 跨租户撞车，中枢无处补救（详见官网 /docs#security）。单租户也建议直接用 "1:1"。`,
  `$subject = $tenantId . ':' . $当前登录用户ID;   // 单租户可只写 (string)$当前登录用户ID`,
  `$payload = rtrim(strtr(base64_encode(json_encode(['uid' => $subject, 'exp' => time() + 3600])), '+/', '-_'), '=');`,
  `$ticket  = 'v1.' . $payload . '.' . hash_hmac('sha256', $payload, $接入方token);`,
  `// 页面输出（登录用户才输出 data-ticket；游客不输出即匿名聊）：`,
  `<script src="${HOST}/widget.js" data-entry="${embedRow.value?.entry_key}" data-ticket="<?= $ticket ?>" async><\/script>`,
].join('\n'));
const ticketNode = computed(() => [
  `// 用接入方「${embedRow.value?.ticket_client}」的 token 签发（1 小时有效，按需调整）`,
  `// uid 是中枢原样回传的「操作主体」串：多租户务必把租户编进去，如 tenantId + ':' + userId。`,
  `import { createHmac } from 'node:crypto';`,
  ``,
  `const clientToken = process.env.BAILING_CLIENT_TOKEN || '<接入方token>';`,
  `const subject = tenantId + ':' + userId;`,
  `const body = JSON.stringify({ uid: subject, exp: Math.floor(Date.now() / 1000) + 3600 });`,
  `const payload = Buffer.from(body)`,
  `  .toString('base64')`,
  `  .replace(/\\+/g, '-')`,
  `  .replace(/\\//g, '_')`,
  `  .replace(/=+$/, '');`,
  `const signature = createHmac('sha256', clientToken).update(payload).digest('hex');`,
  `const ticket = 'v1.' + payload + '.' + signature;`,
  ``,
  `// 页面输出（登录用户才输出 data-ticket；游客不输出即匿名聊）：`,
  `<script src="${HOST}/widget.js" data-entry="${embedRow.value?.entry_key}" data-ticket="\${ticket}" async><\/script>`,
].join('\n'));
const ticketPython = computed(() => [
  `# 用接入方「${embedRow.value?.ticket_client}」的 token 签发（1 小时有效，按需调整）`,
  `# uid 是中枢原样回传的「操作主体」串：多租户务必把租户编进去，如 f"{tenant_id}:{user_id}"。`,
  `import base64`,
  `import hashlib`,
  `import hmac`,
  `import json`,
  `import os`,
  `import time`,
  ``,
  `client_token = os.getenv("BAILING_CLIENT_TOKEN", "<接入方token>")`,
  `subject = f"{tenant_id}:{user_id}"`,
  `body = json.dumps({"uid": subject, "exp": int(time.time()) + 3600}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")`,
  `payload = base64.urlsafe_b64encode(body).decode("utf-8").rstrip("=")`,
  `signature = hmac.new(client_token.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()`,
  `ticket = f"v1.{payload}.{signature}"`,
  ``,
  `# 页面输出（登录用户才输出 data-ticket；游客不输出即匿名聊）：`,
  `# <script src="${HOST}/widget.js" data-entry="${embedRow.value?.entry_key}" data-ticket="{ticket}" async><\\/script>`,
].join('\n'));
const ticketCode = computed(() => {
  if (ticketTab.value === 'php') return ticketPhp.value;
  if (ticketTab.value === 'python') return ticketPython.value;
  return ticketNode.value;
});

async function load(): Promise<void> {
  list.value = await api('/admin/api/chat-entries');
  routes.value = await api('/admin/api/routes');
  clients.value = await api('/admin/api/clients');
  buckets.value = await api('/admin/api/storage-buckets').catch(() => []); // 无 storage 权限时静默退化为空（选项仅 admin 可见）
}
function openCreate(): void {
  editing.value = false;
  chatFormTab.value = 'basic';
  Object.assign(form, { entry_key: '', name: '', route_key: '', origins_text: '', ticket_client: '', bucket: '', title: '', greeting: '', color: '#3fb950', ...APPEARANCE_DEFAULTS, rate_limit_per_min: 20, description: '', enabled: true });
  open.value = true;
}
function openEdit(row: any): void {
  editing.value = true;
  chatFormTab.value = 'basic';
  const ap = row.appearance || {};
  Object.assign(form, {
    entry_key: row.entry_key, name: row.name, route_key: row.route_key,
    origins_text: (row.allowed_origins || []).join('\n'), ticket_client: row.ticket_client || '', bucket: row.bucket || '',
    title: row.title || '', greeting: row.greeting || '', color: row.color || '#3fb950',
    title_align: ap.title_align === 'left' ? 'left' : 'center',
    width: Number(ap.width) || 400, height: Number(ap.height) || 600,
    position: ap.position === 'left' ? 'left' : 'right',
    offset_x: Number.isFinite(Number(ap.offset_x)) ? Number(ap.offset_x) : 24,
    offset_y: Number.isFinite(Number(ap.offset_y)) ? Number(ap.offset_y) : 24,
    avatar: ap.avatar || '', launcher_icon: ap.launcher_icon || '', resizable: !!ap.resizable, ai_notice: ap.ai_notice !== false,
    powered_by_visible: ap.powered_by_visible !== false, powered_by_text: ap.powered_by_text || '',
    rate_limit_per_min: row.rate_limit_per_min, description: row.description || '', enabled: !!row.enabled,
  });
  open.value = true;
}
async function openRatings(row: any): Promise<void> {
  ratingsRow.value = row;
  ratings.value = await api('/admin/api/chat-ratings?entry=' + encodeURIComponent(row.entry_key));
  ratingsOpen.value = true;
}
function resetPageForm(): void { Object.assign(pageForm, { id: 0, url_pattern: '', page_key: '', page_name: '', description: '', priority: 0, enabled: true }); }
async function loadPageRules(): Promise<void> {
  pageRules.value = await api('/admin/api/page-contexts?entry=' + encodeURIComponent(pageCtxRow.value.entry_key));
}
async function openPageCtx(row: any): Promise<void> {
  pageCtxRow.value = row; resetPageForm(); await loadPageRules(); pageCtxOpen.value = true;
}
function editPageRule(r: any): void {
  Object.assign(pageForm, { id: r.id, url_pattern: r.url_pattern, page_key: r.page_key || '', page_name: r.page_name || '', description: r.description || '', priority: r.priority || 0, enabled: r.enabled !== false });
}
async function savePageRule(): Promise<void> {
  if (!pageForm.url_pattern.trim()) { ElMessage.error('URL 模式必填'); return; }
  pageSaving.value = true;
  try {
    await api('/admin/api/page-contexts', { method: 'POST', body: JSON.stringify({ ...pageForm, entry_key: pageCtxRow.value.entry_key, url_pattern: pageForm.url_pattern.trim() }) });
    ElMessage.success('已保存'); resetPageForm(); await loadPageRules();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { pageSaving.value = false; }
}
async function delPageRule(id: number): Promise<void> {
  try {
    await api('/admin/api/page-contexts/' + id + '?entry=' + encodeURIComponent(pageCtxRow.value.entry_key), { method: 'DELETE' });
    if (pageForm.id === id) resetPageForm();
    await loadPageRules();
  } catch (e) { ElMessage.error((e as Error).message); }
}
async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = {
      entry_key: form.entry_key || undefined, name: form.name.trim(), route_key: form.route_key,
      allowed_origins: form.origins_text.split('\n').map((s) => s.trim()).filter(Boolean),
      ticket_client: form.ticket_client || undefined, bucket: form.bucket || undefined,
      title: form.title.trim() || undefined, greeting: form.greeting.trim() || undefined,
      color: form.color || undefined, rate_limit_per_min: form.rate_limit_per_min,
      appearance: {
        title_align: form.title_align, width: form.width, height: form.height,
        position: form.position, offset_x: form.offset_x, offset_y: form.offset_y,
        ...(form.avatar.trim() ? { avatar: form.avatar.trim() } : {}),
        ...(form.launcher_icon.trim() ? { launcher_icon: form.launcher_icon.trim() } : {}),
        ...(form.resizable ? { resizable: true } : {}),
        ...(form.ai_notice === false ? { ai_notice: false } : {}),
        ...(form.powered_by_visible === false ? { powered_by_visible: false } : {}),
        ...(form.powered_by_text.trim() ? { powered_by_text: form.powered_by_text.trim() } : {}),
      },
      description: form.description.trim() || undefined, enabled: form.enabled,
    };
    const r = await api<{ entry_key: string }>('/admin/api/chat-entries', { method: 'POST', body: JSON.stringify(body) });
    ElMessage.success('已保存');
    open.value = false;
    await load();
    if (!editing.value) { // 新建后直接亮嵌入代码，少一次寻找
      const row = list.value.find((x) => x.entry_key === r.entry_key);
      if (row) openEmbed(row);
    }
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
function openEmbed(row: any): void { embedRow.value = row; embedTab.value = 'script'; ticketTab.value = 'node'; embedOpen.value = true; }
function openDemo(row: any): void { window.open(`${HOST}/widget/demo/${row.entry_key}`, '_blank'); }
function entryPayload(row: any, enabled: boolean): Record<string, unknown> {
  return {
    entry_key: row.entry_key,
    name: row.name,
    route_key: row.route_key,
    enabled,
    allowed_origins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
    rate_limit_per_min: row.rate_limit_per_min,
    ticket_client: row.ticket_client || undefined,
    bucket: row.bucket || undefined,
    title: row.title || undefined,
    greeting: row.greeting || undefined,
    color: row.color || undefined,
    appearance: row.appearance || undefined,
    description: row.description || undefined,
  };
}
async function toggleEntry(row: any, enabled: boolean): Promise<void> {
  const previous = !!row.enabled;
  row.enabled = enabled;
  entryToggleKey.value = row.entry_key;
  try {
    await api('/admin/api/chat-entries', { method: 'POST', body: JSON.stringify(entryPayload(row, enabled)) });
    ElMessage.success(enabled ? '聊天组件已恢复展示' : '聊天组件已暂停并隐藏');
  } catch (e) {
    row.enabled = previous;
    ElMessage.error((e as Error).message);
  } finally {
    entryToggleKey.value = '';
  }
}
async function handleEntryCommand(command: string, row: any): Promise<void> {
  if (command === 'page-context') { await openPageCtx(row); return; }
  if (command === 'ratings') { await openRatings(row); }
}
async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); ElMessage.success('已复制'); }
  catch { ElMessage.error('复制失败，请手动选择复制'); }
}
async function del(key: string): Promise<void> {
  try { await api('/admin/api/chat-entries/' + encodeURIComponent(key), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}
onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row2 { display: flex; gap: 12px; }
.position-config {
  display: grid;
  gap: 10px;
}
.offset-row {
  padding-top: 2px;
}
.state-copy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-main,
.entry-stack,
.protection-stack {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.protection-stack {
  min-width: 86px;
}
.entry-main b {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-stack > div,
.tagline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.embed-entry-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 12px;
  border: 1px solid var(--el-border-color-lighter);
}
.embed-entry-summary > div {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.embed-entry-summary > div:last-child { border-right: 0; }
.embed-entry-summary span,
.embed-entry-summary em {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-style: normal;
}
.embed-entry-summary b {
  display: block;
  margin: 4px 0 2px;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  width: 100%;
  line-height: 1;
  white-space: nowrap;
}
.table-actions :deep(.el-button) {
  margin: 0;
  padding: 0;
  height: 22px;
  line-height: 22px;
}
.table-actions :deep(.el-dropdown) {
  display: inline-flex;
  align-items: center;
  height: 22px;
  line-height: 22px;
  vertical-align: top;
}
@media (max-width: 900px) {
  .embed-entry-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .embed-entry-summary > div:nth-child(2) { border-right: 0; }
  .embed-entry-summary > div:nth-child(-n + 2) { border-bottom: 1px solid var(--el-border-color-lighter); }
}
</style>
