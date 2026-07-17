<template>
  <el-card shadow="never">
    <template #header>
      <div class="head"><b>触发路由</b> <HelpTip title="触发路由是什么">
          <p>业务场景 → 发给哪个 AI / 会话连续性 / 怎么送达；保存后点该行「调用代码」给业务系统。</p>
          <p>完整生命周期、字段对照与对接三步，见官网「<b>开发文档</b>」。</p>
        </HelpTip>
        <el-button style="margin-left: auto" @click="openDocs('routes')">开发文档</el-button>
        <el-button type="primary" @click="openCreate">新建路由</el-button></div>
    </template>
    <el-empty v-if="!list.length" description="还没有路由：业务系统的每个触发场景对应一条路由">
      <el-button type="primary" @click="openCreate">建第一条</el-button>
    </el-empty>
    <el-table v-else :data="list">
      <el-table-column label="场景" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="route-main">
            <code>{{ row.route_key }}</code>
            <b>{{ row.name || row.route_key }}</b>
            <span v-if="row.description" class="muted ellipsis">{{ row.description }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="调度链路" min-width="210">
        <template #default="{ row }">
          <div class="route-stack">
            <div>
              <el-tag effect="plain" type="info">{{ row.target }}</el-tag>
              <span v-if="row.project" class="muted mono"> / {{ row.project }}</span>
            </div>
            <span class="muted">{{ sessionLabel(row) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="能力与治理" min-width="280">
        <template #default="{ row }">
          <div class="feature-tags">
            <el-tag v-for="tag in featureTags(row)" :key="tag.label" size="small" effect="plain" :type="tag.type">{{ tag.label }}</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="运行状态" width="190">
        <template #default="{ row }">
          <div class="status-stack">
            <div>
              <el-tag size="small" effect="plain" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag>
              <el-tag size="small" effect="plain" :type="permTag(row.permission).type">{{ permTag(row.permission).label }}</el-tag>
            </div>
            <el-tooltip :content="coverage(row).hint" placement="top">
              <span class="coverage" :class="coverage(row).tagType">{{ coverage(row).text }}</span>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>
      <el-table-column width="162" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openCode(row)">调用代码</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="删除该路由？业务侧再调用会报未知 route。" width="240" @confirm="del(row.route_key)">
            <template #reference><el-button link type="danger">删</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 新建/编辑路由 -->
  <el-drawer v-model="open" :title="editing ? '编辑路由' : '新建路由'" size="640px">
    <el-form label-position="top">
      <el-tabs v-model="routeFormTab" class="console-tabs route-form-tabs">
        <el-tab-pane label="基础与大脑" name="basic">
      <el-form-item>
        <template #label>{{ routeFieldTitle('route_key', '场景标识') }} <span v-if="routeFieldRequired('route_key')" class="field-required">*</span> <HelpTip :title="routeFieldTitle('route_key', '场景标识')">
          <p>{{ routeFieldDesc('route_key', '本场景的唯一标识，触发方凭它调用。') }}</p>
          <p><b>建好后不可改</b>（触发方代码里写死了它）；小写字母 / 数字 / 中划线。场景配置随时改，key 不变触发方就无感知。</p>
        </HelpTip></template>
        <el-input v-model="form.route_key" :disabled="editing" placeholder="如 business-assistant" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ routeFieldTitle('name', '名称') }} <span v-if="routeFieldRequired('name')" class="field-required">*</span> <HelpTip :title="routeFieldTitle('name', '名称')">
          <p>{{ routeFieldDesc('name', '后台展示的人类可读名称。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.name" placeholder="如 业务助手" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ routeFieldTitle('target', '调度目标') }} <span v-if="routeFieldRequired('target')" class="field-required">*</span> <HelpTip :title="routeFieldTitle('target', '调度目标')">
          <p>{{ routeFieldDesc('target', '本场景交给哪个目标处理。') }}</p>
          <p><code>llm</code> = OpenAI 兼容模型目标，适合聊天、问答、调业务工具；可接云厂商、本地模型或企业模型网关。</p>
          <p>执行器类 = 外部 agent / worker 异步认领干活，适合代码处理、长任务、专有工具链等场景。</p>
          <p>选项来自「调度目标」注册表。</p>
        </HelpTip></template>
        <el-select v-model="form.target" style="width: 100%">
          <el-option v-for="t in targetOptions" :key="t.name" :value="t.name"
            :label="t.name + (t.description ? '（' + t.description + '）' : '')" :disabled="!t.enabled" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="curTargetNeedsProject">
        <template #label>{{ routeFieldTitle('project', '项目') }} <HelpTip :title="routeFieldTitle('project', '项目')">
          <p>{{ routeFieldDesc('project', '需要本地项目目录的目标使用的项目登记名。') }}</p>
        </HelpTip></template>
        <el-select v-model="form.project" filterable allow-create style="width: 100%" placeholder="在「项目目录」登记后选择">
          <el-option v-for="p in projectNames" :key="p" :value="p" :label="p" />
        </el-select>
      </el-form-item>
      <!-- llm：凭证/模型关联「模型凭证」注册表，不再手拼 JSON -->
      <template v-if="form.target === 'llm'">
        <el-form-item>
          <template #label>模型凭证 <span class="field-required">必填</span> <HelpTip title="模型凭证">
            <p>来自「模型凭证」注册表，密钥只存中枢、调用时注入，任务里不落明文。</p>
            <p>下拉标注的"默认模型"是凭证级缺省；<b>若默认是向量模型（text-embedding-*，给知识库用的），聊天必须在下面显式填对话模型</b>，否则触发时报 LLM 404。</p>
          </HelpTip></template>
          <el-select v-model="llm.credential" filterable allow-create style="width: 100%" placeholder="选择凭证"
            @change="llm.model = ''">
            <el-option v-for="c in credOptions" :key="c.name" :value="c.name"
              :label="c.name + (c.default_model ? '（默认模型 ' + c.default_model + '）' : '')" :disabled="!c.enabled" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <template #label>模型 <HelpTip title="选了凭证为什么这里还能填模型？">
            <p>一把凭证 = 某服务商的一个 key，通常能调它家<b>很多</b>模型；同一凭证也可能被多条路由复用。<b>这里是「本路由用哪个模型」的覆盖</b>：<b>留空就用凭证的默认模型</b>，只有本路由想用别的（比如换成视觉或长文档模型）才在这里选。</p>
            <p>下拉项是该凭证对应平台的<b>常用模型建议</b>，图片/文件等标签只表示模型能力。聚合平台（OpenRouter 等）模型上百，列表只是建议、可直接手填准确 ID——⚠️ OpenRouter 等必须带 <code>org/</code> 前缀（如 <code>qwen/qwen3.7-plus</code>），写裸名会被服务商 400 拒绝。</p>
          </HelpTip></template>
          <el-select v-model="llm.model" filterable allow-create clearable default-first-option class="mono" style="width: 100%"
            :placeholder="curCredDefaultModel ? '留空 = 用凭证默认：' + curCredDefaultModel : '选模型，或手填准确 ID'">
            <el-option-group v-for="g in routeModelGroups" :key="g.label" :label="g.label">
              <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
            </el-option-group>
          </el-select>
          <div v-if="curCredProviderFree" class="field-hint">该平台模型很多/需准确 ID，列表仅常用建议，可手填——记得带 <code>org/</code> 前缀（如 <code>qwen/…</code>、<code>anthropic/…</code>）</div>
        </el-form-item>
        <el-form-item>
          <template #label>系统提示词 <HelpTip title="系统提示词（可选）">
            <p>这个场景下 AI 的角色与边界：人设、口吻、能答什么不能答什么。如"你是业务系统助手，回答简洁专业，拿不准就说不知道"。</p>
            <p>当前北京时间、工具使用纪律由中枢自动注入，不用写。</p>
          </HelpTip></template>
          <el-input v-model="llm.system_prompt" type="textarea" :rows="3" placeholder="如：你是业务系统助手，回答简洁专业，拿不准就说不知道。" />
        </el-form-item>
        <div class="form-section-title">
          <span>多模态输入策略</span>
          <HelpTip title="多模态输入策略">
            <p>这里定义用户素材进入大脑前的处理方式。图片、语音、文件都走同一套 input 契约：可以由中枢先理解/抽取，也可以直送给具备对应能力的模型或执行器。</p>
            <p>视频等后续素材类型会继续挂在同一个 input 契约下扩展；当前版本不开放半成品视频开关。</p>
          </HelpTip>
        </div>
        <el-form-item>
          <template #label>图片策略 <HelpTip title="图片输入策略">
            <p>定义用户发图时中枢如何处理图片。主模型负责推理和工具编排；图片理解可以交给单独模型，也可以直送给具备多模态能力的主模型。</p>
            <p>不开启图片策略时，图片仍会作为用户附件留痕；是否能直接理解取决于主模型和执行器自身能力。</p>
          </HelpTip></template>
          <el-switch v-model="vis.on" active-text="启用图片策略" />
        </el-form-item>
        <template v-if="vis.on">
          <el-form-item label="图片模型凭证">
            <el-select v-model="vis.credential" filterable allow-create clearable style="width: 100%" placeholder="留空 = 复用上面的对话凭证" @change="vis.model = ''">
              <el-option v-for="c in credOptions" :key="c.name" :value="c.name"
                :label="c.name + (c.default_model ? '（默认模型 ' + c.default_model + '）' : '')" :disabled="!c.enabled" />
            </el-select>
          </el-form-item>
          <el-form-item label="图片模型">
            <el-select v-model="vis.model" filterable allow-create clearable default-first-option class="mono" style="width: 100%"
              :placeholder="visCredDefaultModel ? '留空 = 用凭证默认：' + visCredDefaultModel : '选图片理解模型，或手填准确 ID'">
              <el-option-group v-for="g in visionModelGroups" :key="g.label" :label="g.label">
                <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
              </el-option-group>
            </el-select>
            <div v-if="visCredProviderFree" class="field-hint">该平台模型多/需准确 ID，列表仅常用建议，可手填——记得带 <code>org/</code> 前缀</div>
          </el-form-item>
          <el-form-item>
            <template #label>接入方式 <HelpTip title="图片怎么交给大脑">
              <p><b>见图工具（推荐）</b>：大脑按需调 <code>see_image</code> 看图，适合“纯文本强工具模型 + 图片模型”的组合。</p>
              <p><b>前置识图</b>：每次先把图识别成文字再交给大脑，确定性最高，但每张图都会识图（成本略高）。</p>
              <p><b>直送大脑</b>：图直接喂主模型，适合主模型本身具备图片理解能力的场景。</p>
            </HelpTip></template>
            <el-radio-group v-model="vis.mode">
              <el-radio-button value="tool">见图工具</el-radio-button>
              <el-radio-button value="prepass">前置识图</el-radio-button>
              <el-radio-button value="inline">直送大脑</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="vis.mode === 'tool'" label="单任务看图次数上限">
            <el-input-number v-model="vis.max_calls" :min="1" :max="30" />
            <span class="muted" style="margin-left: 8px">see_image 调用上限（不占业务工具的 max_calls）</span>
          </el-form-item>
        </template>
        <el-form-item>
          <template #label>语音策略 <HelpTip title="语音输入策略">
            <p>定义用户发语音时中枢如何处理音频。可以先转写为文字进入知识、工具和审计链路，也可以直送给具备语音理解能力的模型或执行器。</p>
            <p>不开启语音策略时，语音只作为附件留痕。</p>
          </HelpTip></template>
          <el-switch v-model="voice.on" active-text="启用语音策略" />
        </el-form-item>
        <template v-if="voice.on">
          <el-form-item>
            <template #label>接入方式 <HelpTip title="语音怎么交给大脑">
              <p><b>中枢先转写</b>：调用 OpenAI-compatible <code>/audio/transcriptions</code>，把语音变成文字后进入路由、知识、工具和审计链路。</p>
              <p><b>直送大脑</b>：音频作为媒体输入直接交给主模型或执行器，适合接入方已有语音理解模型的场景。</p>
            </HelpTip></template>
            <el-radio-group v-model="voice.mode">
              <el-radio-button value="transcribe">中枢先转写</el-radio-button>
              <el-radio-button value="inline">直送大脑</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <template v-if="voice.mode === 'transcribe'">
            <el-form-item label="语音模型凭证">
              <el-select v-model="voice.credential" filterable allow-create clearable style="width: 100%" placeholder="留空 = 复用上面的对话凭证" @change="voice.model = ''">
                <el-option v-for="c in credOptions" :key="c.name" :value="c.name"
                  :label="c.name + (c.default_model ? '（默认模型 ' + c.default_model + '）' : '')" :disabled="!c.enabled" />
              </el-select>
            </el-form-item>
            <el-form-item label="语音模型">
              <el-select v-model="voice.model" filterable allow-create clearable default-first-option class="mono" style="width: 100%"
                :placeholder="voiceCredDefaultModel ? '留空 = 用凭证默认：' + voiceCredDefaultModel : '选语音模型，或手填准确 ID'">
                <el-option-group v-for="g in voiceModelGroups" :key="g.label" :label="g.label">
                  <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
                </el-option-group>
              </el-select>
              <div v-if="voiceCredProviderFree" class="field-hint">该平台模型多/需准确 ID，列表仅常用建议，可手填——记得带 <code>org/</code> 前缀</div>
            </el-form-item>
          </template>
          <el-form-item label="单段大小上限">
            <el-input-number v-model="voice.max_bytes_mb" :min="1" :max="50" />
            <span class="muted" style="margin-left: 8px">MB；默认 12MB</span>
          </el-form-item>
        </template>
        <el-form-item>
          <template #label>文件策略 <HelpTip title="文件输入策略">
            <p>定义用户上传 PDF、Word、Excel、CSV、TSV、TXT、Markdown、JSON、日志等文件时中枢如何处理。文本型 PDF、DOCX 和常见文本文件可本地抽取；扫描件、复杂表格/PPT/压缩包建议走 OCR、文件模型或业务解析器。</p>
            <p>不开启文件策略时，文件只作为附件留痕，不参与大脑上下文。</p>
          </HelpTip></template>
          <el-switch v-model="fileInput.on" active-text="启用文件策略" />
        </el-form-item>
        <template v-if="fileInput.on">
          <el-form-item>
            <template #label>接入方式 <HelpTip title="文件怎么交给大脑">
              <p><b>中枢抽取文本</b>：适合文本型 PDF、DOCX、TXT、Markdown、CSV、TSV、JSON、HTML、日志、配置、SQL 等；不可抽取的文件会明确提示，而不是伪装已读懂。</p>
              <p><b>抽取后摘要</b>：先抽取文本，再用文件模型压缩成摘要，适合较长文档。</p>
              <p><b>直送大脑</b>：保留文件链接给具备文件读取能力的模型或执行器。注意很多 OpenAI-compatible Chat API 不能直接读取 PDF。</p>
            </HelpTip></template>
            <el-radio-group v-model="fileInput.mode">
              <el-radio-button value="extract">中枢抽取文本</el-radio-button>
              <el-radio-button value="summarize">抽取后摘要</el-radio-button>
              <el-radio-button value="inline">直送大脑</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <template v-if="fileInput.mode === 'summarize' || fileInput.mode === 'inline'">
            <el-form-item label="文件模型凭证">
              <el-select v-model="fileInput.credential" filterable allow-create clearable style="width: 100%" placeholder="留空 = 复用上面的对话凭证" @change="fileInput.model = ''">
                <el-option v-for="c in credOptions" :key="c.name" :value="c.name"
                  :label="c.name + (c.default_model ? '（默认模型 ' + c.default_model + '）' : '')" :disabled="!c.enabled" />
              </el-select>
            </el-form-item>
            <el-form-item label="文件模型">
              <el-select v-model="fileInput.model" filterable allow-create clearable default-first-option class="mono" style="width: 100%"
                :placeholder="fileCredDefaultModel ? '留空 = 用凭证默认：' + fileCredDefaultModel : '选文件/长文档模型，或手填准确 ID'">
                <el-option-group v-for="g in fileModelGroups" :key="g.label" :label="g.label">
                  <el-option v-for="mname in g.models" :key="mname" :value="mname" :label="g.tag ? mname + '  · ' + g.tag : mname" />
                </el-option-group>
              </el-select>
              <div v-if="fileCredProviderFree" class="field-hint">该平台模型多/需准确 ID，列表仅常用建议，可手填——记得带 <code>org/</code> 前缀</div>
            </el-form-item>
          </template>
          <el-form-item label="单文件大小上限">
            <el-input-number v-model="fileInput.max_bytes_mb" :min="1" :max="100" />
            <span class="muted" style="margin-left: 8px">MB；默认 20MB</span>
          </el-form-item>
          <el-form-item v-if="fileInput.mode !== 'inline'" label="注入字符上限">
            <el-input-number v-model="fileInput.max_chars" :min="1000" :max="200000" :step="1000" />
            <span class="muted" style="margin-left: 8px">默认 24000 字符，按文件数自动分配</span>
          </el-form-item>
        </template>
      </template>
      <el-form-item v-else>
        <template #label>{{ routeFieldTitle('target_config', '自定义配置') }} <HelpTip :title="routeFieldTitle('target_config', '目标配置')">
          <p>{{ routeFieldDesc('target_config', '传给目标适配器的结构化配置。') }}</p>
          <p>执行器通道的自定义配置，原样传给执行器适配器解析；不需要就留空。</p>
        </HelpTip></template>
        <el-input v-model="form.target_config" type="textarea" :rows="2" class="mono" placeholder="{}" />
      </el-form-item>
      <el-form-item>
        <template #label>{{ routeFieldTitle('permission', '权限') }} <HelpTip :title="routeFieldTitle('permission', '权限')">
          <p>{{ routeFieldDesc('permission', '发送给执行器或大脑的权限边界提示。') }}</p>
          <p>三档固定值，<b>中枢内置、人人都一样</b>，不依赖任何执行器上报：</p>
          <p>· <b>只读</b>——只查询/读取/分析，不许改任何东西、不跑有副作用的操作（给公开聊天入口这种不可信来源的安全档）；<br />· <b>可写</b>——允许常规读写，删除/外发等不可逆动作要谨慎；<br />· <b>全开</b>——不加限制（只给你完全信任的内部入口）。</p>
          <p><b>实现方式 = 提示词指导，不是硬沙箱。</b>中枢把这条要求作为一段【权限】说明前置进任务发给执行器；执行器是否照做由它自己决定，<b>中枢不保证强制</b>。需要强制隔离时，应由具备沙箱能力的执行器配合实现。</p>
        </HelpTip></template>
        <el-select v-model="form.permission" style="width: 100%">
          <el-option value="readonly" label="只读 · 只查不改" />
          <el-option value="readwrite" label="可写 · 允许常规读写" />
          <el-option value="full" label="全开 · 不加限制" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.target !== 'llm'">
        <template #label>{{ routeFieldTitle('profile', '角色档') }} <HelpTip :title="routeFieldTitle('profile', '角色档')">
          <p>{{ routeFieldDesc('profile', '执行器可选的角色档或任务模板。') }}</p>
          <p>执行器侧可选的角色档（profile），比如结构化输出、某类专业任务模板。它管“以什么角色、按什么 schema 干活”，<b>跟上面的「权限」是两回事</b>。</p>
          <p><b>非必填，留空即可。</b>下拉里是服务当前 target 的在线执行器自报的档，也可手填。执行器是否支持 profile，由该执行器自己的适配器决定。</p>
        </HelpTip></template>
        <el-select v-model="form.profile" filterable allow-create clearable default-first-option style="width: 100%" placeholder="留空即可（实验性，后续并入云端 skill）">
          <el-option v-for="p in profileOptions" :key="p.name" :value="p.name" :label="p.name + (p.by.length ? ` · 来自 ${p.by.join('、')}` : '（手填 · 本 target 在线池暂未上报此档）')" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <template #label>{{ routeFieldTitle('session_policy', '会话连续性') }} <span class="scope-tag">· 仅 /run API 触发</span> <span v-if="routeFieldRequired('session_policy')" class="field-required">*</span> <HelpTip :title="routeFieldTitle('session_policy', '会话连续性')">
          <p>{{ routeFieldDesc('session_policy', '仅 /run API 直接触发生效，控制业务触发多次调用是否接续同一会话。') }}</p>
          <p>控制<b>用 /run API 触发本路由</b>时，多次调用之间要不要接续同一会话：</p>
          <p><code>new</code> 每次独立；<code>per_key</code> 按 metadata 某字段值各自续聊；<code>fixed</code> 全路由共用一条常驻会话；<code>passthrough</code> 会话 id 由业务侧在 /run 里直接给，中枢只转发、不持有任何 id。</p>
          <p><b>聊天入口与渠道入站不读此项</b>——它们天然按访客/用户各自续聊，多会话用聊天 body 的 <code>thread_id</code> 切分。</p>
        </HelpTip>
          <el-tooltip v-if="sessionPolicyBindings.inert" placement="top" effect="dark"
            :content="`本路由正被 ${sessionPolicyBindings.label} 使用；这些入口自动按访客/用户续聊，本项对它们无效，仅 /run API 直接触发时生效。`">
            <el-icon class="field-warning"><WarningFilled /></el-icon>
          </el-tooltip>
        </template>
        <el-select v-model="form.session_policy" style="width: 100%">
          <el-option value="new" label="new（每次新会话，默认）" />
          <el-option value="per_key" label="per_key（按 metadata 某字段值各自一会话续聊，id 中枢自动保管）" />
          <el-option value="fixed" label="fixed（本路由所有任务进同一常驻会话）" />
          <el-option value="passthrough" label="passthrough（会话 id 由业务侧 /run 直接给，中枢只转发；不给则新建）" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.session_policy === 'per_key'">
        <template #label>{{ routeFieldTitle('session_key_field', '会话键字段') }} <HelpTip :title="routeFieldTitle('session_key_field', '会话键字段')">
          <p>{{ routeFieldDesc('session_key_field', '从 metadata 中读取该字段作为会话键。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.session_key_field" placeholder="如 ticket_id" class="mono" />
      </el-form-item>
      <el-form-item v-if="form.session_policy === 'passthrough'">
        <template #label>{{ routeFieldTitle('session_key_field', '会话 ID 字段') }} <HelpTip :title="routeFieldTitle('session_key_field', '会话 ID 字段')">
          <p>{{ routeFieldDesc('session_key_field', '从 metadata 中读取该字段作为会话键。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.session_key_field" placeholder="留空即用 session_id" class="mono" />
        <div class="muted hint">业务每次 /run 带 <code>metadata.{{ form.session_key_field || 'session_id' }}</code> = 续那个会话；不带 = 新开一个。中枢不存、不管这个 id，主权全在业务侧。</div>
      </el-form-item>
      <el-form-item v-if="form.session_policy === 'fixed'">
        <template #label>{{ routeFieldTitle('session_fixed_id', '固定会话 ID') }} <HelpTip :title="routeFieldTitle('session_fixed_id', '固定会话 ID')">
          <p>{{ routeFieldDesc('session_fixed_id', '固定会话标识；留空时可由运行期自动创建。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.session_fixed_id" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>对话记忆 <HelpTip title="对话记忆（喂多少历史给 AI）">
          <p>每次派发前，中枢从对话总账装配最近若干轮历史注入上下文（<b>无状态大脑每轮装、有状态大脑仅会话首轮装</b>）。</p>
          <p><b>逐字条数 / 字符预算</b>：保留最近多少条原文、总字符上限（两者取先到者，单条超长自动截断）。</p>
          <p><b>滚动摘要</b>：开启后，更早的对话在累计超阈值时由轻模型<b>异步</b>压成结构化摘要（关键事实/决策/待办/偏好），连同最近逐字一起喂——这样最初几轮的内容也不会被遗忘。摘要在后台进行，<b>不拖慢回复</b>；失败自动降级为仅逐字窗口。</p>
        </HelpTip></template>
        <div class="inline-row">
          <span class="muted">最近</span><el-input-number v-model="mem.recent_messages" :min="1" :max="50" />
          <span class="muted">条逐字 · 预算</span><el-input-number v-model="mem.recent_budget_chars" :min="200" :max="20000" :step="500" /><span class="muted">字符</span>
        </div>
      </el-form-item>
      <el-form-item label="滚动摘要">
        <el-switch v-model="mem.summary_enabled" />
      </el-form-item>
      <el-form-item v-if="mem.summary_enabled" label="摘要触发">
        <div class="inline-row">
          <span class="muted">未摘对话超</span><el-input-number v-model="mem.summary_trigger_chars" :min="500" :max="40000" :step="500" /><span class="muted">字符时压缩，保留最近</span>
          <el-input-number v-model="mem.summary_keep_recent" :min="0" :max="40" /><span class="muted">条逐字不压</span>
        </div>
      </el-form-item>
      <el-form-item v-if="mem.summary_enabled">
        <template #label>摘要模型 <HelpTip title="摘要模型（可选）">
          <p>压缩用的模型，建议用便宜快的（如 <code>qwen-turbo</code>）。留空 = 复用本路由凭证的默认模型。</p>
          <p>摘要在后台异步进行，不影响回复速度；其凭证沿用本路由 llm 的「模型凭证」。</p>
        </HelpTip></template>
        <el-input v-model="mem.summary_model" placeholder="留空=用本路由凭证默认模型" class="mono" />
      </el-form-item>
      <el-form-item>
        <template #label>成本预算闸 <HelpTip title="成本预算闸">
          <p>按本路由在指定窗口内的历史用量做入口硬限。达到成本或 token 上限后，新任务会直接记为 <code>rejected</code>，不会再进入模型、执行器或工具链路。</p>
          <p>这里是场景级预算；接入方页还可以配置调用方级预算。两边任一命中都会拒绝。</p>
        </HelpTip></template>
        <el-switch v-model="budget.enabled" />
      </el-form-item>
      <template v-if="budget.enabled">
        <el-form-item label="预算窗口">
          <el-radio-group v-model="budget.window">
            <el-radio-button value="hour">每小时</el-radio-button>
            <el-radio-button value="day">每天</el-radio-button>
            <el-radio-button value="month">每月</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="硬限">
          <div class="inline-row">
            <span class="muted">成本 USD</span><el-input-number v-model="budget.hard_cost_usd" :min="0" :step="0.1" :precision="4" />
            <span class="muted">Token</span><el-input-number v-model="budget.hard_tokens" :min="0" :step="1000" />
          </div>
          <div class="muted hint">两个都为空等于不设硬限；任一达到上限即拒绝新任务。</div>
        </el-form-item>
      </template>
        </el-tab-pane>
        <el-tab-pane label="受众" name="audience">
      <el-form-item>
        <template #label>受众策略 <HelpTip title="受众策略">
          <p>定义哪些主体能进入这条路由，以及 <code>route=auto</code> 是否可以把请求分诊到这里。</p>
          <p>业务侧应在 <code>metadata.principal</code> 声明 <code>id/tenant/roles/audience</code>。这里是 AI 车道闸，不替代业务自己的权限表。</p>
        </HelpTip></template>
        <div class="inline-row">
          <el-switch v-model="au.enabled" active-text="启用受众闸" />
          <el-switch v-model="au.auto" active-text="参与自动分诊" />
          <el-switch v-model="au.anonymous" active-text="允许匿名" />
        </div>
      </el-form-item>
      <el-form-item>
        <template #label>自动分诊 <HelpTip title="自动分诊">
          <p><code>route=auto</code> 只会选择已开启自动分诊或配置了关键词的路由。</p>
          <p>多个候选同分时会返回 409，不随机分配；用优先级或关键词拉开分数。</p>
        </HelpTip></template>
        <div class="inline-row">
          <span class="muted">优先级</span><el-input-number v-model="au.priority" :min="-1000" :max="1000" />
        </div>
        <el-select v-model="au.keywords" multiple filterable allow-create default-first-option style="width: 100%; margin-top: 8px" placeholder="关键词，如 查询 / 创建 / 统计">
          <el-option v-for="k in au.keywords" :key="k" :value="k" :label="k" />
        </el-select>
      </el-form-item>
      <el-form-item label="允许接入方">
        <el-select v-model="au.clients" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制接入方">
          <el-option v-for="c in clients" :key="c.app_id" :value="c.app_id" :label="c.name ? c.app_id + '（' + c.name + '）' : c.app_id" />
        </el-select>
      </el-form-item>
      <el-form-item label="允许渠道">
        <el-select v-model="au.channels" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制渠道">
          <el-option v-for="c in channels" :key="c.name" :value="c.name" :label="c.name + '（' + c.kind + '）'" />
        </el-select>
      </el-form-item>
      <el-form-item label="允许租户">
        <el-select v-model="au.tenants" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制租户；值来自 metadata.principal.tenant" />
      </el-form-item>
      <el-form-item label="允许角色">
        <el-select v-model="au.roles" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制角色；值来自 metadata.principal.roles" />
      </el-form-item>
      <el-form-item label="允许主体">
        <el-select v-model="au.principals" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制主体；值来自 metadata.principal.id" />
      </el-form-item>
      <el-form-item label="允许受众类型">
        <el-select v-model="au.audiences" multiple filterable allow-create default-first-option style="width: 100%" placeholder="空 = 不限制受众；如 employee / customer / admin" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="知识" name="knowledge">
      <el-form-item>
        <template #label>知识注入 <HelpTip title="知识注入（可选，可绑多个库）">
          <p>选一个或多个知识库：每次派发前按本次输入跨所选库检索，取最相关的 top_k 条注入【知识参考】供 AI 引用作答。</p>
          <p><b>多库检索</b>：各库分别检索后按相关度合并排序、全局取 top_k；某个库故障会跳过不影响其它库。</p>
          <p>⚠️ 跨库分数可比的前提是<b>同一 embedding 模型</b>（如都用 text-embedding-v4）。混不同模型时合并为近似排序，建议只把同模型、主题相关的库放一起。</p>
          <p>知识库故障不影响任务执行（只丢增强，不丢任务）。不选 = 不注入。</p>
        </HelpTip></template>
        <el-select v-model="kn.kb_ids" multiple filterable clearable style="width: 100%" placeholder="不注入（可多选）">
          <el-option v-for="k in kbOptions" :key="k.kb_id" :value="k.kb_id" :label="k.kb_id + (k.name ? '（' + k.name + '）' : '')" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="kn.kb_ids.length" label="检索条数">
        <el-input-number v-model="kn.top_k" :min="1" :max="20" />
      </el-form-item>
      <el-form-item v-if="kn.kb_ids.length">
        <template #label>注入方式 <HelpTip title="片段 vs 整篇">
          <p><b>片段注入</b>（默认）：只把命中的几个文本块给 AI——省 token，适合 FAQ、长手册这类"一问一两个知识点"的库。</p>
          <p><b>整篇注入</b>：命中后回带<b>整篇原文</b>（含截图链接）给 AI。适合操作指南、产品文档这类"一篇一主题、图文步骤"的短文档——命中一个薄片段不够用，整篇才有完整步骤，截图也能随原文带回渲染。</p>
          <p>整篇注入会按命中去重到最多几篇父文档（默认 4 篇，单篇超长截断），比片段更耗 token，但回答更完整。</p>
        </HelpTip></template>
        <el-radio-group v-model="kn.inject">
          <el-radio value="chunk">片段（默认）</el-radio>
          <el-radio value="doc">整篇</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="kn.kb_ids.length" label="最低相关度（低于此分的命中直接丢弃，0~1）">
        <el-input-number v-model="kn.min_score" :min="0" :max="1" :step="0.05" :precision="2" />
      </el-form-item>
      <el-form-item v-if="kn.kb_ids.length && kn.inject === 'doc'" label="整篇篇数上限">
        <el-input-number v-model="kn.max_docs" :min="1" :max="20" />
      </el-form-item>
      <el-form-item v-if="kn.kb_ids.length">
        <template #label>页面感知检索 <HelpTip title="页面感知检索（按访客当前页面偏置）">
          <p>开启后：网页聊天访客在某页面提问时，中枢把该页面主题（来自「聊天入口 → 页面登记」解析出的页面名+说明）前置进知识检索，<b>优先召回与当前页相关的文档</b>，全局文档仍兜底（min_score 把关）。</p>
          <p>仅对<b>命中页面登记</b>的网页聊天生效；API 或渠道入站等无页面上下文的触发自动不受影响。</p>
        </HelpTip></template>
        <el-switch v-model="kn.page_boost" />
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="送达" name="delivery">
      <el-form-item>
        <template #label>送达 <HelpTip title="送达（结果怎么推出去）">
          <p>任务结束后把结果推出去，<b>成功、失败都会回调</b>（失败只回调 webhook，不推人渠道）。</p>
          <p><code>webhook</code> = 中枢签名 POST 到业务回调地址，载荷、验签和重试规范见官网「开发文档」。</p>
          <p><code>渠道直推</code> = 中枢内置，任务跑完<b>自动经某渠道把结果推给指定用户</b>，等于"中枢替业务自动调一次 /send"。收件人由触发时 metadata 的某字段动态给，一条路由即可服务多人。</p>
          <p>自定义渠道 = 已注册的 <code>*-notify</code> 执行器承接。</p>
          <p>聊天入口触发：首跑同步回复、不投递；<b>审批意图通过后的重跑走本送达回流</b>。</p>
        </HelpTip></template>
        <el-select v-model="dv.type" filterable allow-create clearable style="width: 100%" placeholder="不推送（业务方自己轮询或无需结果）">
          <el-option value="webhook" label="webhook（中枢签名 POST 到业务回调地址）" />
          <el-option value="channel" label="渠道直推（中枢内置：任务跑完自动经渠道推给指定用户，无需执行器）" />
          <el-option v-for="n in notifyChannels" :key="n.value" :value="n.value" :label="n.label" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="dv.type === 'webhook'" label="回调地址">
        <el-input v-model="dv.url" placeholder="https://your-system.example.com/callback" class="mono" />
      </el-form-item>
      <template v-else-if="dv.type === 'channel'">
        <el-form-item label="推送渠道">
          <el-select v-model="dv.channel" filterable allow-create clearable style="width: 100%" placeholder="选一个渠道">
            <el-option v-for="c in channels" :key="c.name" :value="c.name"
              :label="c.name + '（' + (c.kind === 'wecom' ? '企业微信' : c.kind) + '）'" :disabled="c.enabled === false" />
          </el-select>
        </el-form-item>
        <el-form-item label="收件人字段">
          <el-input v-model="dv.to_field" placeholder="如 channel_user_id" class="mono" />
          <div class="muted hint">值支持单个 id、数组或 <code>"A|B|C"</code> 推给多人；中枢按它定位收件人，不写死在路由上。</div>
        </el-form-item>
        <el-form-item label="后备收件人">
          <el-input v-model="dv.to" placeholder="渠道原生 id；多人用 A|B|C" class="mono" />
        </el-form-item>
      </template>
      <template v-else-if="dv.type">
        <el-form-item label="收件人字段">
          <el-input v-model="dv.to_field" placeholder="如 channel_user_id" class="mono" />
        </el-form-item>
        <el-form-item label="后备收件人">
          <el-input v-model="dv.to" class="mono" />
        </el-form-item>
      </template>
      <el-form-item>
        <template #label>重试 <HelpTip title="重试（仅瞬时失败）">
          <p>只对网络 / 超时 / 5xx 等瞬时失败按间隔重排；配置类错误（模型名不存在等）不重试——重试也不会好。0 = 不重试。</p>
        </HelpTip></template>
        <div class="inline-row">
          <el-input-number v-model="rt.max" :min="0" :max="5" />
          <template v-if="rt.max > 0"><span class="muted">次，间隔</span>
            <el-input-number v-model="rt.backoff_ms" :min="1000" :max="600000" :step="1000" /><span class="muted">ms</span></template>
        </div>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="工具治理" name="tools">
      <div class="tool-sources-head">
        <span>业务工具源 <HelpTip title="工具（Agent 的手）">
          <p>一条路由可以接入多个业务系统。每个工具源分别按 scope 勾选放行范围，Agent 即可跨系统查询或操作。<b>建议先只放只读 scope 跑通，再逐步放开写权限</b>。</p>
          <p>风险闸：标 high / 需确认的调用会先冻结为审批意图；业务侧或控制台兜底批准后，任务按原调用快照自动重跑执行。</p>
        </HelpTip></span>
        <el-button @click="addToolSource">添加工具源</el-button>
      </div>
      <div v-if="!tl.sources.length" class="muted tool-sources-empty">未挂载业务工具源；该路由仍可只使用模型、知识库或执行器。</div>
      <div v-for="(source, index) in tl.sources" :key="source.form_key" class="tool-source-editor">
        <div class="tool-source-editor__head"><b>工具源 {{ index + 1 }}</b><el-button link type="danger" @click="removeToolSource(index)">移除</el-button></div>
        <el-form-item label="工具源">
          <el-select v-model="source.provider" filterable allow-create clearable style="width: 100%" placeholder="选择工具源" @change="onProviderChange(source)">
            <el-option v-for="p in providerOptions" :key="p.name" :value="p.name"
              :label="p.name + (p.description ? '（' + p.description + '）' : '')" :disabled="!p.enabled" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="source.provider">
          <template #label>放行范围 <HelpTip title="放行范围（scope 白名单）">
            <p>来自该工具源派生的工具清单，按 scope 整组放行（选项里列了每个 scope 覆盖哪些工具）。没勾的 scope 对 AI 完全不可见——这是第一道也是最硬的一道闸。</p>
            <p><b><code>*</code> 全部放行</b>：免维护——工具源以后新增接口自动对本路由生效，不用再回中枢加 scope。代价是新工具会自动暴露，<b>但写操作仍受逐工具治理</b>（标「需主体」的匿名访客看不到、标 high/需确认的仍先形成审批意图），安全闸不因 <code>*</code> 失效。自部署、工具源可信时推荐用它。</p>
          </HelpTip></template>
          <el-select v-model="source.allow" multiple filterable allow-create style="width: 100%" placeholder="选择放行的 scope" :loading="source.scopesLoading">
            <el-option value="*" label="*（全部放行 —— 工具源新增接口自动生效，免维护；写工具仍受逐工具风险/主体治理）" />
            <el-option v-for="sc in source.scopeOptions" :key="sc.scope" :value="sc.scope" :label="sc.scope + '（' + sc.names.join(' / ') + '）'" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="source.provider">
          <template #label>操作主体字段 <HelpTip title="操作主体字段（字段名 subject_field）：操作主体从哪取">
            <p>指向任务 metadata 的哪个键取"操作人"。<b>通常留空</b>：默认取 <code>visitor_uid</code>——聊天访客票据验签通过后由中枢写入的标准字段。</p>
            <p>仅 API 触发方想用别的字段名（如 <code>operator_uid</code>）才需要选 / 填；配了别的字段也不影响聊天——取不到时 <code>visitor_uid</code> 永远兜底，已验签身份不会丢。</p>
            <p>业务系统侧无需关心此名字——它收到的是 <code>X-Bailing-On-Behalf-Of</code> 头里的用户 ID 值（票据 uid 原样透传）。标「需主体」的工具拿不到主体不会暴露给 AI。</p>
          </HelpTip></template>
          <el-select v-model="source.subject_field" filterable allow-create clearable default-first-option style="width: 100%"
            placeholder="留空 = visitor_uid（聊天入口的登录身份自动可用）">
            <el-option value="visitor_uid" label="visitor_uid —— 聊天入口的票据身份（默认值，可不填）" />
            <el-option value="operator_uid" label="operator_uid —— API 触发常用约定（调用方 metadata 带同名字段）" />
          </el-select>
        </el-form-item>
      </div>
      <template v-if="tl.sources.length">
        <el-form-item label="单任务业务工具调用上限">
          <el-input-number v-model="tl.max_calls" :min="1" :max="50" />
        </el-form-item>
        <el-form-item>
          <template #label>高风险审批承接 <HelpTip title="高风险审批承接">
            <p>标 <code>risk.level=high</code> 或 <code>approval.required=true</code> 的工具调用不会立即执行，中枢先冻结调用快照并生成审批意图。</p>
            <p><b>业务侧 webhook（推荐生产）</b>：中枢把审批意图签名 POST 给业务系统，业务系统在自己的审批页/OA/IM 里决定谁审、几级审，然后回调 <code>/approvals/:id/decision</code>。</p>
            <p><b>控制台兜底</b>：不配置承接时，审批意图仍进入「审批意图」页，适合开发、demo 或运维兜底。</p>
          </HelpTip></template>
          <el-select v-model="ap.type" clearable style="width: 100%" placeholder="控制台兜底（不主动投递业务审批流）">
            <el-option value="business_webhook" label="业务侧 webhook（推荐生产）" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="ap.type === 'business_webhook'" label="审批意图接收地址">
          <el-input v-model="ap.url" placeholder="https://your-system.example.com/ai/approvals" class="mono" />
          <div class="muted hint">中枢会签名 POST <code>tool_approval_request</code>；业务审批完成后回调 <code>/approvals/&lt;id&gt;/decision</code>。</div>
        </el-form-item>
      </template>
      <el-form-item>
        <template #label>主动发消息 <HelpTip title="主动发消息（大脑/执行器自己决定发给谁）">
          <p>给大脑一个内置的 <code>send_message</code> 动作：<b>它完成某件事后，自己当场决定把消息发给谁</b>——收件人由大脑指定、不在这里写死。这里只声明<b>准发哪些渠道</b>（出站凭证从渠道取），收件人是谁、发几次全是大脑自己定，<b>中枢不持有任何人↔身份映射</b>。</p>
          <p>和「送达·渠道直推」的区别：渠道直推是<b>任务结果由中枢统一送达</b>给触发时指定的人；这里是<b>大脑执行过程中自主发送</b>给它自己判断的人，可发多人、多次。两者可同时配。</p>
          <p>留空 = 不给大脑发消息能力。需所选渠道已配好出站凭证（corpid/secret/agentid）。</p>
        </HelpTip></template>
        <el-select v-model="tl.send_channels" multiple filterable clearable style="width: 100%" placeholder="留空 = 大脑不能主动发消息">
          <el-option value="*" label="*（所有启用渠道都可发）" />
          <el-option v-for="c in channels" :key="c.name" :value="c.name"
            :label="c.name + '（' + (c.kind === 'wecom' ? '企业微信' : c.kind) + '）'" :disabled="c.enabled === false" />
        </el-select>
      </el-form-item>
        </el-tab-pane>
        <el-tab-pane label="发布" name="publish">
      <el-form-item>
        <template #label>{{ routeFieldTitle('description', '说明') }} <HelpTip :title="routeFieldTitle('description', '说明')">
          <p>{{ routeFieldDesc('description', '给后台管理员看的补充备注。') }}</p>
        </HelpTip></template>
        <el-input v-model="form.description" />
      </el-form-item>
      <el-form-item v-if="editing">
        <template #label>{{ routeFieldTitle('enabled', '启用') }} <HelpTip :title="routeFieldTitle('enabled', '启用')">
          <p>{{ routeFieldDesc('enabled', '关闭后该路由不再接受触发。') }}</p>
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

  <!-- 调用代码（开放接入：业务后端 / 联调 / 本地智能体两个方向，复制即接入） -->
  <el-dialog v-model="codeOpen" :title="'调用代码 · ' + (codeRoute?.name || codeRoute?.route_key || '')" width="860px" class="code-dialog">
    <div class="code-context">
      <div class="code-context-main">
        <span class="code-context-label">接入方</span>
        <el-select v-model="codeClientId" class="code-context-select">
          <el-option v-for="c in eligibleClients" :key="c.app_id" :value="c.app_id" :label="c.name + '（' + c.app_id + '）'" />
        </el-select>
      </div>
      <div class="code-context-note">下方示例使用所选接入方的 token；送达 webhook 验签也应使用同一把 token。</div>
    </div>

    <div v-if="codeRoute" class="code-route-summary">
      <div>
        <span>场景</span>
        <b class="mono">{{ codeRoute.route_key }}</b>
        <em>{{ codeRoute.name || '未命名路由' }}</em>
      </div>
      <div>
        <span>调度目标</span>
        <b>{{ codeRoute.target }}</b>
        <em>{{ sessionLabel(codeRoute) }}</em>
      </div>
      <div>
        <span>接入方</span>
        <b class="mono">{{ codeClient?.app_id || '-' }}</b>
        <em>{{ eligibleClients.length }} 个接入方可调用</em>
      </div>
      <div>
        <span>触发状态</span>
        <b>{{ codeRoute.enabled ? '可触发' : '已停用' }}</b>
        <em>{{ codeCoverage?.text || '-' }}</em>
      </div>
    </div>

    <div v-if="codeRoute" class="code-route-tags">
      <el-tag v-for="tag in featureTags(codeRoute)" :key="tag.label" size="small" effect="plain" :type="tag.type">{{ tag.label }}</el-tag>
    </div>

    <div v-if="eligibleClients.length > 1 || codeRoute?.delivery?.type === 'channel'" class="code-notices">
      <div v-if="eligibleClients.length > 1" class="code-notice warning">
        <b>接入方需要确认</b>
        <span>当前有 {{ eligibleClients.length }} 个接入方可调用本路由，复制前确认示例属于「{{ codeClientId }}」。</span>
      </div>
      <div v-if="codeRoute?.delivery?.type === 'channel'" class="code-notice success">
        <b>渠道直推已开启</b>
        <span v-if="codeRoute.delivery.to_field">触发时 metadata 需要带 <code>{{ codeRoute.delivery.to_field }}</code>，任务完成后会经「{{ codeRoute.delivery.channel }}」自动推给该用户。</span>
        <span v-else>当前固定推给「{{ codeRoute.delivery.to || '未配置收件人' }}」。需要按调用动态指定收件人时，到路由送达配置里填写“收件人字段”。</span>
      </div>
    </div>
    <div class="code-notices compact">
      <div class="code-notice info">
        <b>完整 SDK</b>
        <span>本弹窗保留 HTTP / Node.js / Python / PHP 的高频示例；Java、Go、.NET 与任意语言接入见官网 SDK 文档。</span>
        <el-button link type="primary" @click="openDoc('/docs/sdk')">打开 SDK 文档</el-button>
      </div>
    </div>

    <el-tabs v-model="codeTab" class="code-tabs">
      <el-tab-pane label="HTTP / cURL" name="curl">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>HTTP 联调示例</b>
              <p>这是最小协议契约；任意语言按这个请求即可触发路由。</p>
            </div>
            <el-button type="primary" @click="copyText(curlCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ curlCode }}</pre>
        </section>
      </el-tab-pane>
      <el-tab-pane label="Node.js" name="node">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>Node.js 触发示例</b>
              <p>放在业务事件点调用；设置短超时，避免中枢异常拖慢业务主流程。</p>
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
              <b>Python 触发示例</b>
              <p>适合 Python 后端、脚本服务或数据任务系统接入。</p>
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
              <b>PHP 触发示例</b>
              <p>适合 ThinkPHP、Laravel 或存量 PHP 系统；失败只记日志，不阻塞业务主流程。</p>
            </div>
            <el-button type="primary" @click="copyText(phpCode)">复制代码</el-button>
          </div>
          <pre class="snippet-code">{{ phpCode }}</pre>
        </section>
      </el-tab-pane>
      <el-tab-pane label="Agent 触发" name="skill">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>给 Agent 的触发说明</b>
              <p>把这段交给受信 agent，让它知道何时、如何触发本路由。</p>
            </div>
            <el-button type="primary" @click="copyText(skillCode)">复制说明</el-button>
          </div>
          <pre class="snippet-code">{{ skillCode }}</pre>
          <div class="snippet-notes">
            <span>内容包含接入密钥，只能放在受信环境，不要提交进代码仓库。</span>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane v-if="codeTargetIsExecutor" label="执行器接入" name="exec">
        <section class="snippet-card">
          <div class="snippet-head">
            <div>
              <b>给 Agent 的执行器接入引导</b>
              <p>这里只复制本次连接参数；完整流程由版本化 Skill 承载，支持原生 Skill 或普通 Markdown 阅读。</p>
            </div>
            <el-button type="primary" @click="copyText(execCode)">复制引导</el-button>
          </div>
          <pre class="snippet-code tall">{{ execCode }}</pre>
          <div class="snippet-notes">
            <span>这段引导不包含令牌；Agent 应让你在本机安全输入，不能要求把令牌粘贴进对话。</span>
            <span>执行器 token 请在「执行器」页签发，按 target 授权、可吊销、可审计。</span>
            <span>出站长轮询即可工作，内网机器不需要公网 IP，也不需要开放端口。</span>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { WarningFilled } from '@element-plus/icons-vue';
import { api } from '../request';
import { openDoc } from '../docs';
import { copyText } from '../util';
import HelpTip from '../components/HelpTip.vue';
import { useMe } from '../store';
import { LLM_PROVIDERS, detectProvider } from '../llm-catalog';
import { schemaDescription, schemaRequired, schemaTitle, useConfigSchema } from '../schema';

const s = useMe();
const routeSchema = useConfigSchema('route');
const list = ref<any[]>([]);
const projectNames = ref<string[]>([]);
const clients = ref<any[]>([]);
const chatEntries = ref<any[]>([]); // 用于判断当前路由是否被聊天入口/渠道入站使用（这些入口自动续聊、不读会话策略）
const channels = ref<any[]>([]);
const open = ref(false);
const editing = ref(false);
const saving = ref(false);
const routeFormTab = ref<'basic' | 'audience' | 'knowledge' | 'delivery' | 'tools' | 'publish'>('basic');
const form = reactive({
  route_key: '', name: '', target: 'llm', project: '', profile: '', permission: 'full',
  session_policy: 'new', session_key_field: '', session_fixed_id: '',
  target_config: '', description: '', enabled: true,
});

function routeFieldTitle(field: string, fallback: string): string {
  return schemaTitle(routeSchema.schema.value, field, fallback);
}
function routeFieldDesc(field: string, fallback = ''): string {
  return schemaDescription(routeSchema.schema.value, field, fallback);
}
function routeFieldRequired(field: string): boolean {
  return schemaRequired(routeSchema.required.value, field);
}

function openDocs(page: 'routes' | 'tools' | 'knowledge' | 'api' | 'approvals' | 'operations' = 'routes'): void {
  const paths: Record<typeof page, string> = {
    routes: '/docs#routes',
    tools: '/docs/tools',
    knowledge: '/docs/knowledge',
    api: '/docs/api',
    approvals: '/docs/approvals',
    operations: '/docs/operations',
  };
  openDoc(paths[page]);
}

// ---- 结构化子表单：保存时装配回 JSON，编辑时从 JSON 拆出；未识别的键留在 *Rest 原样回写（不丢高级配置） ----
const llm = reactive({ credential: '', model: '', system_prompt: '' });
// 多模态输入：落 target_config.input.{image,audio,file}，主模型仍是编排大脑，素材理解按类型解耦。
const vis = reactive({ on: false, credential: '', model: '', mode: 'tool', max_calls: 6 });
let visRest: Record<string, unknown> = {};
const voice = reactive({ on: false, credential: '', model: '', mode: 'transcribe', max_bytes_mb: 12 });
let voiceRest: Record<string, unknown> = {};
const fileInput = reactive({ on: false, credential: '', model: '', mode: 'extract', max_bytes_mb: 20, max_chars: 24000 });
let fileRest: Record<string, unknown> = {};
const kn = reactive({ kb_ids: [] as string[], top_k: 5, inject: 'chunk', min_score: 0.35, max_docs: 4, page_boost: false });
const dv = reactive({ type: '', url: '', channel: '', to_field: '', to: '' });
const rt = reactive({ max: 0, backoff_ms: 5000 });
interface ToolSourceForm {
  form_key: string;
  provider: string;
  allow: string[];
  subject_field: string;
  scopeOptions: Array<{ scope: string; names: string[] }>;
  scopesLoading: boolean;
  rest: Record<string, unknown>;
}
let toolSourceSeq = 0;
function newToolSource(over: Partial<ToolSourceForm> = {}): ToolSourceForm {
  return { form_key: `tool-source-${++toolSourceSeq}`, provider: '', allow: [], subject_field: '', scopeOptions: [], scopesLoading: false, rest: {}, ...over };
}
const tl = reactive({ sources: [] as ToolSourceForm[], max_calls: 5, send_channels: [] as string[] });
const ap = reactive({ type: '', url: '' });
const au = reactive({
  enabled: false, auto: false, anonymous: false, priority: 0,
  keywords: [] as string[], clients: [] as string[], channels: [] as string[],
  tenants: [] as string[], roles: [] as string[], principals: [] as string[], audiences: [] as string[],
});
const mem = reactive({ recent_messages: 12, recent_budget_chars: 3500, summary_enabled: false, summary_trigger_chars: 4000, summary_keep_recent: 6, summary_model: '' });
const budget = reactive<{ enabled: boolean; window: 'hour' | 'day' | 'month'; hard_cost_usd?: number; hard_tokens?: number }>({ enabled: false, window: 'day', hard_cost_usd: undefined, hard_tokens: undefined });
let llmRest: Record<string, unknown> = {}, inputRest: Record<string, unknown> = {}, knRest: Record<string, unknown> = {}, dvRest: Record<string, unknown> = {}, rtRest: Record<string, unknown> = {}, tlRest: Record<string, unknown> = {}, builtinRest: Record<string, unknown> = {}, sendRest: Record<string, unknown> = {}, apRest: Record<string, unknown> = {}, audienceRest: Record<string, unknown> = {}, memRest: Record<string, unknown> = {}, budgetRest: Record<string, unknown> = {};

// 会话策略只对 /run API 触发生效；聊天入口与渠道入站走自己的 scope 自动续聊、不读此项。
// 算出当前编辑路由被哪些入口/渠道使用，据此提示用户「本项在这条路由下到底有没有用」。
const sessionPolicyBindings = computed(() => {
  const rk = form.route_key;
  if (!rk) return { inert: false, label: '' };
  const entries = chatEntries.value.filter((e) => e.route_key === rk).map((e) => `聊天入口「${e.name || e.entry_key}」`);
  const chans = channels.value.filter((c) => c.route_key === rk).map((c) => `${c.kind === 'wecom' ? '企微渠道' : '渠道'}「${c.name}」`);
  const all = [...entries, ...chans];
  return { inert: all.length > 0, label: all.join('、') };
});

function splitKnown(obj: unknown, keys: string[]): [Record<string, unknown>, Record<string, unknown>] {
  const known: Record<string, unknown> = {}, rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) (keys.includes(k) ? known : rest)[k] = v;
  return [known, rest];
}

// ---- 关联注册表的下拉数据（无权限时静默退化为手输——下拉都带 allow-create） ----
const credOptions = ref<Array<{ name: string; default_model?: string; base_url?: string; enabled: boolean }>>([]);
const kbOptions = ref<Array<{ kb_id: string; name?: string }>>([]);
const providerOptions = ref<Array<{ name: string; description?: string; enabled: boolean }>>([]);
const notifyTargetsRaw = ref<Array<{ name: string; description?: string }>>([]);

const curCred = computed(() => credOptions.value.find((c) => c.name === llm.credential));
const curCredDefaultModel = computed(() => curCred.value?.default_model ?? '');
// 选了凭证 → 按其 base_url 反查平台，给「模型」下拉常用建议；聚合平台标记可手填。
const curCredProviderId = computed(() => detectProvider(curCred.value?.base_url ?? ''));
const curCredProviderFree = computed(() => LLM_PROVIDERS.find((p) => p.id === curCredProviderId.value)?.freeModel ?? false);
const routeModelGroups = computed(() => {
  const p = LLM_PROVIDERS.find((x) => x.id === curCredProviderId.value);
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
  if (p.vision?.length) g.push({ label: '视觉理解 / 图片输入', tag: '图片', models: p.vision });
  if (p.file?.length) g.push({ label: '文件 / 长文档理解', tag: '文件', models: p.file });
  return g;
});
// 视觉模型下拉：按 vis.credential 反查平台，识图组优先（缺省 = 复用 brain 凭证，按 brain 凭证平台给建议）
const visCred = computed(() => credOptions.value.find((c) => c.name === (vis.credential || llm.credential)));
const visCredDefaultModel = computed(() => visCred.value?.default_model ?? '');
const visCredProviderId = computed(() => detectProvider(visCred.value?.base_url ?? ''));
const visCredProviderFree = computed(() => LLM_PROVIDERS.find((p) => p.id === visCredProviderId.value)?.freeModel ?? false);
const visionModelGroups = computed(() => {
  const p = LLM_PROVIDERS.find((x) => x.id === visCredProviderId.value);
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (p.vision?.length) g.push({ label: '视觉理解 / 图片输入', tag: '图片', models: p.vision });
  if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
  return g;
});
// 语音模型下拉：按 voice.credential 反查平台，语音组优先；缺省复用主模型凭证。
const voiceCred = computed(() => credOptions.value.find((c) => c.name === (voice.credential || llm.credential)));
const voiceCredDefaultModel = computed(() => voiceCred.value?.default_model ?? '');
const voiceCredProviderId = computed(() => detectProvider(voiceCred.value?.base_url ?? ''));
const voiceCredProviderFree = computed(() => LLM_PROVIDERS.find((p) => p.id === voiceCredProviderId.value)?.freeModel ?? false);
const voiceModelGroups = computed(() => {
  const p = LLM_PROVIDERS.find((x) => x.id === voiceCredProviderId.value);
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (p.audio?.length) g.push({ label: '语音转写 / 音频理解', tag: '语音', models: p.audio });
  if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
  return g;
});
const fileCred = computed(() => credOptions.value.find((c) => c.name === (fileInput.credential || llm.credential)));
const fileCredDefaultModel = computed(() => fileCred.value?.default_model ?? '');
const fileCredProviderId = computed(() => detectProvider(fileCred.value?.base_url ?? ''));
const fileCredProviderFree = computed(() => LLM_PROVIDERS.find((p) => p.id === fileCredProviderId.value)?.freeModel ?? false);
const fileModelGroups = computed(() => {
  const p = LLM_PROVIDERS.find((x) => x.id === fileCredProviderId.value);
  if (!p) return [] as Array<{ label: string; tag?: string; models: string[] }>;
  const g: Array<{ label: string; tag?: string; models: string[] }> = [];
  if (p.file?.length) g.push({ label: '文件 / 长文档理解', tag: '文件', models: p.file });
  if (p.chat?.length) g.push({ label: '文本对话 / 推理', models: p.chat });
  return g;
});
// 角色档下拉：按「当前路由选的 target」收窄——只列服务该 target 的在线执行器自报的 profiles，并带上来源（谁报的），
// 而不是把所有执行器的档堆成一锅。再并上本 target 已配置过的值 + readonly 兜底；allow-create 仍可手填：
// 执行器那边定义好同名档即可生效，控制台「可执行性」会预警还没覆盖的）。
const profileOptions = computed(() => {
  const tgt = form.target;
  const serving = execs.value.filter((e) => e.online && Array.isArray(e.targets) && e.targets.includes(tgt));
  const by = new Map<string, string[]>(); // profile 名 -> 上报它的执行器（id·runtime）
  for (const e of serving) {
    const who = e.capabilities?.runtime ? `${e.executor_id}·${e.capabilities.runtime}` : e.executor_id;
    for (const p of (e.capabilities?.profiles ?? [])) { if (!by.has(p)) by.set(p, []); by.get(p)!.push(who); }
  }
  const historical = list.value.filter((r) => r.target === tgt).map((r) => String(r.profile || '')).filter(Boolean);
  const names = new Set<string>(['readonly', ...historical, ...by.keys()]);
  return Array.from(names).map((name) => ({ name, by: by.get(name) ?? [] }));
});
const notifyChannels = computed(() => notifyTargetsRaw.value.map((t) => {
  const ch = t.name.replace(/-notify$/, '');
  return { value: ch, label: `${ch}（执行器 ${t.name} 承接${t.description ? '：' + t.description : ''}）` };
}));

async function loadScopes(source: ToolSourceForm): Promise<void> {
  source.scopesLoading = true; source.scopeOptions = [];
  try {
    const d = await api<{ tools: Array<{ name: string; scope: string }> }>('/admin/api/tool-providers/' + encodeURIComponent(source.provider) + '/tools');
    const m = new Map<string, string[]>();
    for (const t of d.tools) { if (!m.has(t.scope)) m.set(t.scope, []); m.get(t.scope)!.push(t.name); }
    source.scopeOptions = Array.from(m, ([scope, names]) => ({ scope, names }));
  } catch { /* 无权限/源异常 → 手输 scope（allow-create） */ }
  finally { source.scopesLoading = false; }
}
function onProviderChange(source: ToolSourceForm): void {
  source.allow = [];
  if (source.provider) void loadScopes(source);
}
function addToolSource(): void { tl.sources.push(newToolSource()); }
function removeToolSource(index: number): void { tl.sources.splice(index, 1); }

// 调度目标插座：下拉来自注册表（无权限时退化为唯一内置目标）
const targetOptions = ref<Array<{ name: string; kind: string; needs_project: boolean; enabled: boolean; description?: string }>>([
  { name: 'llm', kind: 'inhub', needs_project: false, enabled: true },
]);
const curTargetNeedsProject = computed(() => targetOptions.value.find((t) => t.name === form.target)?.needs_project ?? false);

// 执行器池（用于「可执行性」覆盖度判定）：route → target → 服务该 target 的在线执行器，且其自报 profiles 是否覆盖本路由的 profile。
const execs = ref<Array<{ executor_id: string; online: boolean; targets: string[]; capabilities: { profiles?: string[]; runtime?: string } | null }>>([]);
// 权限档 → 表格徽标（与表单三档一致）
function permTag(p?: string): { label: string; type: 'info' | 'success' | 'warning' | 'danger' } {
  if (p === 'readonly') return { label: '只读', type: 'success' };
  if (p === 'readwrite') return { label: '可写', type: 'warning' };
  return { label: '全开', type: 'info' }; // full / 空
}
type RouteFeatureTag = { label: string; type: 'primary' | 'success' | 'warning' | 'danger' | 'info' };
function sessionLabel(row: any): string {
  if (row.session_policy === 'per_key') return `按 ${row.session_key_field || 'metadata 字段'} 续聊`;
  if (row.session_policy === 'fixed') return '固定会话';
  if (row.session_policy === 'passthrough') return `业务自管会话${row.session_key_field ? ' · ' + row.session_key_field : ''}`;
  return '每次新会话';
}
function knowledgeLabel(row: any): string {
  const ids = row.knowledge?.kb_ids || (row.knowledge?.kb_id ? [row.knowledge.kb_id] : []);
  if (!ids.length) return '';
  return ids.length === 1 ? `知识:${ids[0]}` : `知识:${ids.length}库`;
}
function deliveryLabel(row: any): string {
  if (!row.delivery?.type) return '';
  if (row.delivery.type === 'channel') return `送达:${row.delivery.channel || '渠道'}`;
  return `送达:${row.delivery.type}`;
}
function featureTags(row: any): RouteFeatureTag[] {
  const tags: RouteFeatureTag[] = [];
  const kb = knowledgeLabel(row);
  if (kb) tags.push({ label: kb, type: 'success' });
  const toolSources = Array.isArray(row.tools?.sources) ? row.tools.sources.filter((source: any) => source?.provider) : [];
  if (toolSources.length === 1) tags.push({ label: `工具:${toolSources[0].provider}`, type: 'success' });
  else if (toolSources.length > 1) tags.push({ label: `工具:${toolSources.length}源`, type: 'success' });
  if (row.tools?.builtin?.send_message?.channels?.length) tags.push({ label: '主动发消息', type: 'warning' });
  const delivery = deliveryLabel(row);
  if (delivery) tags.push({ label: delivery, type: 'warning' });
  const input = row.target_config?.input || {};
  if (input.image?.mode) tags.push({ label: input.image.mode === 'inline' ? '图片直送' : input.image.mode === 'prepass' ? '前置识图' : '见图工具', type: 'info' });
  if (input.audio?.mode) tags.push({ label: input.audio.mode === 'inline' ? '语音直送' : '语音转写', type: 'info' });
  if (input.file?.mode) tags.push({ label: input.file.mode === 'inline' ? '文件直送' : input.file.mode === 'summarize' ? '文件摘要' : '文件抽取', type: 'info' });
  if (row.tools?.approval?.type) tags.push({ label: '高危审批', type: 'danger' });
  if (row.budget?.enabled !== false && (row.budget?.hard_cost_usd || row.budget?.hard_tokens)) tags.push({ label: '预算闸', type: 'danger' });
  if (row.audience?.auto || row.audience?.keywords?.length) tags.push({ label: '自动分诊', type: 'warning' });
  else if (row.audience) tags.push({ label: '受众闸', type: 'warning' });
  if (row.memory?.summary_enabled) tags.push({ label: '摘要记忆', type: 'info' });
  return tags.length ? tags : [{ label: '基础路由', type: 'info' }];
}
// 可执行性：只看「有没有在线执行器认领这个 target」（权限是提示词、不再依赖执行器能力上报）。inhub 目标在中枢内跑、恒可执行。
function coverage(row: any): { text: string; tagType: 'success' | 'danger' | 'warning' | 'info'; hint: string } {
  const def = targetOptions.value.find((t) => t.name === row.target);
  if (def && def.kind === 'inhub') return { text: '中枢内', tagType: 'info', hint: 'inhub 目标在中枢进程内执行，无需执行器' };
  const online = execs.value.filter((e) => e.online && Array.isArray(e.targets) && e.targets.includes(row.target));
  if (!online.length) return { text: '⚠ 无在线执行器', tagType: 'danger', hint: `没有在线执行器认领调度目标「${row.target}」，触发后任务会一直排队。去「执行器」页确认。` };
  return { text: `✓ ${online.length} 在线`, tagType: 'success', hint: `${online.length} 个在线执行器在认领调度目标「${row.target}」` };
}

async function load(): Promise<void> { list.value = await api('/admin/api/routes'); }
function resetSubForms(): void {
  Object.assign(llm, { credential: '', model: '', system_prompt: '' });
  Object.assign(vis, { on: false, credential: '', model: '', mode: 'tool', max_calls: 6 }); visRest = {};
  Object.assign(voice, { on: false, credential: '', model: '', mode: 'transcribe', max_bytes_mb: 12 }); voiceRest = {};
  Object.assign(fileInput, { on: false, credential: '', model: '', mode: 'extract', max_bytes_mb: 20, max_chars: 24000 }); fileRest = {};
  Object.assign(kn, { kb_ids: [] as string[], top_k: 5, inject: 'chunk', min_score: 0.35, max_docs: 4, page_boost: false });
  Object.assign(dv, { type: '', url: '', channel: '', to_field: '', to: '' });
  Object.assign(rt, { max: 0, backoff_ms: 5000 });
  Object.assign(tl, { sources: [], max_calls: 5, send_channels: [] });
  Object.assign(ap, { type: '', url: '' }); builtinRest = {}; sendRest = {}; apRest = {};
  Object.assign(au, { enabled: false, auto: false, anonymous: false, priority: 0, keywords: [], clients: [], channels: [], tenants: [], roles: [], principals: [], audiences: [] });
  Object.assign(mem, { recent_messages: 12, recent_budget_chars: 3500, summary_enabled: false, summary_trigger_chars: 4000, summary_keep_recent: 6, summary_model: '' });
  Object.assign(budget, { enabled: false, window: 'day', hard_cost_usd: undefined, hard_tokens: undefined });
  llmRest = {}; inputRest = {}; knRest = {}; dvRest = {}; rtRest = {}; tlRest = {}; audienceRest = {}; memRest = {}; budgetRest = {};
}
function openCreate(): void {
  editing.value = false;
  routeFormTab.value = 'basic';
  Object.assign(form, { route_key: '', name: '', target: 'llm', project: '', profile: '', permission: 'full', session_policy: 'new', session_key_field: '', session_fixed_id: '', target_config: '', description: '', enabled: true });
  resetSubForms();
  open.value = true;
}
function openEdit(row: any): void {
  editing.value = true;
  routeFormTab.value = 'basic';
  const j = (o: unknown): string => (o && Object.keys(o as object).length ? JSON.stringify(o) : '');
  resetSubForms();
  Object.assign(form, {
    route_key: row.route_key ?? '', name: row.name ?? '', target: row.target, project: row.project || '',
    profile: row.profile || '', permission: row.permission || 'full', session_policy: row.session_policy,
    session_key_field: row.session_key_field || '', session_fixed_id: row.session_fixed_id || '',
    target_config: '', description: row.description || '', enabled: !!row.enabled,
  });
  // 把已存 JSON 拆回结构化控件；不认识的键留在 *Rest，保存时原样合回
  if (row.target === 'llm') {
    const [c, r] = splitKnown(row.target_config, ['credential', 'model', 'system_prompt', 'input']);
    Object.assign(llm, { credential: String(c['credential'] ?? ''), model: String(c['model'] ?? ''), system_prompt: String(c['system_prompt'] ?? '') });
    llmRest = r;
    const [inputKnown, inputUnknown] = splitKnown(c['input'], ['image', 'audio', 'file']);
    inputRest = inputUnknown;
    const vraw = inputKnown['image'];
    if (vraw && typeof vraw === 'object') {
      const [vv, vr] = splitKnown(vraw, ['credential', 'model', 'mode', 'max_calls']);
      const mode = String(vv['mode'] ?? 'tool');
      Object.assign(vis, {
        on: true, credential: String(vv['credential'] ?? ''), model: String(vv['model'] ?? ''),
        mode: ['tool', 'prepass', 'inline', 'off'].includes(mode) ? mode : 'tool', max_calls: Number(vv['max_calls'] ?? 6),
      });
      visRest = vr;
    }
    const araw = inputKnown['audio'];
    if (araw && typeof araw === 'object') {
      const [aa, ar] = splitKnown(araw, ['credential', 'model', 'mode', 'max_bytes', 'max_seconds']);
      const mode = String(aa['mode'] ?? 'transcribe');
      const maxBytes = Number(aa['max_bytes'] ?? 12 * 1024 * 1024);
      Object.assign(voice, {
        on: true,
        credential: String(aa['credential'] ?? ''),
        model: String(aa['model'] ?? ''),
        mode: ['transcribe', 'inline', 'off'].includes(mode) ? mode : 'transcribe',
        max_bytes_mb: Math.max(1, Math.round(maxBytes / 1024 / 1024)),
      });
      voiceRest = ar;
    }
    const fraw = inputKnown['file'];
    if (fraw && typeof fraw === 'object') {
      const [ff, fr] = splitKnown(fraw, ['credential', 'model', 'mode', 'max_bytes', 'max_chars']);
      const mode = String(ff['mode'] ?? 'extract');
      const maxBytes = Number(ff['max_bytes'] ?? 20 * 1024 * 1024);
      Object.assign(fileInput, {
        on: true,
        credential: String(ff['credential'] ?? ''),
        model: String(ff['model'] ?? ''),
        mode: ['extract', 'summarize', 'inline', 'off'].includes(mode) ? mode : 'extract',
        max_bytes_mb: Math.max(1, Math.round(maxBytes / 1024 / 1024)),
        max_chars: Number(ff['max_chars'] ?? 24000),
      });
      fileRest = fr;
    }
  } else form.target_config = j(row.target_config);
  const [k, kr] = splitKnown(row.knowledge, ['kb_id', 'kb_ids', 'top_k', 'inject', 'min_score', 'max_docs', 'page_boost']);
  Object.assign(kn, { kb_ids: Array.isArray(k['kb_ids']) ? (k['kb_ids'] as string[]).slice() : (k['kb_id'] ? [String(k['kb_id'])] : []), top_k: Number(k['top_k'] ?? 5), inject: k['inject'] === 'doc' ? 'doc' : 'chunk', min_score: Number(k['min_score'] ?? 0.35), max_docs: Number(k['max_docs'] ?? 4), page_boost: k['page_boost'] === true }); knRest = kr;
  const [d, dr] = splitKnown(row.delivery, ['type', 'url', 'channel', 'to_field', 'to']);
  Object.assign(dv, { type: String(d['type'] ?? ''), url: String(d['url'] ?? ''), channel: String(d['channel'] ?? ''), to_field: String(d['to_field'] ?? ''), to: String(d['to'] ?? '') }); dvRest = dr;
  const [t, tr] = splitKnown(row.retry, ['max', 'backoff_ms']);
  Object.assign(rt, { max: Number(t['max'] ?? 0), backoff_ms: Number(t['backoff_ms'] ?? 5000) }); rtRest = tr;
  const [w, wr] = splitKnown(row.tools, ['sources', 'max_calls', 'builtin', 'approval']);
  tlRest = wr;
  tl.max_calls = Number(w['max_calls'] ?? 5);
  const [aud, audRest] = splitKnown(row.audience, ['enabled', 'auto', 'anonymous', 'priority', 'keywords', 'clients', 'channels', 'tenants', 'roles', 'principals', 'audiences']);
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : (typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  Object.assign(au, {
    enabled: row.audience ? aud['enabled'] !== false : false,
    auto: aud['auto'] === true,
    anonymous: aud['anonymous'] === true,
    priority: Number(aud['priority'] ?? 0),
    keywords: arr(aud['keywords']),
    clients: arr(aud['clients']),
    channels: arr(aud['channels']),
    tenants: arr(aud['tenants']),
    roles: arr(aud['roles']),
    principals: arr(aud['principals']),
    audiences: arr(aud['audiences']),
  });
  audienceRest = audRest;
  if (Array.isArray(w['sources'])) {
    tl.sources = w['sources'].flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const [src, rest] = splitKnown(raw, ['provider', 'allow', 'subject_field']);
      return [newToolSource({
        provider: String(src['provider'] ?? ''),
        allow: Array.isArray(src['allow']) ? (src['allow'] as string[]).slice() : [],
        subject_field: String(src['subject_field'] ?? ''),
        rest,
      })];
    });
  }
  if (w['builtin'] && typeof w['builtin'] === 'object') {
    const [bi, br] = splitKnown(w['builtin'], ['send_message']);
    builtinRest = br;
    if (bi['send_message'] && typeof bi['send_message'] === 'object') {
      const [sm, sr] = splitKnown(bi['send_message'], ['channels']);
      Object.assign(tl, { send_channels: Array.isArray(sm['channels']) ? (sm['channels'] as string[]).slice() : [] });
      sendRest = sr;
    }
  }
  if (w['approval'] && typeof w['approval'] === 'object') {
    const [aa, ar] = splitKnown(w['approval'], ['type', 'url']);
    Object.assign(ap, { type: String(aa['type'] ?? ''), url: String(aa['url'] ?? '') });
    apRest = ar;
  }
  // 记忆层：未在 UI 暴露的高级键(per_message_chars/summary_max_chars)留在 memRest，保存时原样合回
  const [me, mr] = splitKnown(row.memory, ['recent_messages', 'recent_budget_chars', 'summary_enabled', 'summary_trigger_chars', 'summary_keep_recent', 'summary_model']);
  Object.assign(mem, {
    recent_messages: Number(me['recent_messages'] ?? 12), recent_budget_chars: Number(me['recent_budget_chars'] ?? 3500),
    summary_enabled: me['summary_enabled'] === true, summary_trigger_chars: Number(me['summary_trigger_chars'] ?? 4000),
    summary_keep_recent: Number(me['summary_keep_recent'] ?? 6), summary_model: String(me['summary_model'] ?? ''),
  }); memRest = mr;
  const [bu, bur] = splitKnown(row.budget, ['enabled', 'window', 'window_hours', 'hard_cost_usd', 'hard_tokens', 'soft_cost_usd', 'soft_tokens']);
  const windowFromHours = Number(bu['window_hours']) === 1 ? 'hour' : Number(bu['window_hours']) === 720 ? 'month' : 'day';
  const win = ['hour', 'day', 'month'].includes(String(bu['window'])) ? String(bu['window']) as 'hour' | 'day' | 'month' : windowFromHours;
  Object.assign(budget, {
    enabled: !!row.budget && bu['enabled'] !== false,
    window: win,
    hard_cost_usd: bu['hard_cost_usd'] == null ? undefined : Number(bu['hard_cost_usd']),
    hard_tokens: bu['hard_tokens'] == null ? undefined : Number(bu['hard_tokens']),
  });
  budgetRest = bur;
  for (const source of tl.sources) if (source.provider) void loadScopes(source);
  open.value = true;
}
function parseJson(label: string, text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try { return JSON.parse(t) as Record<string, unknown>; }
  catch { throw new Error(`${label} 不是合法 JSON`); }
}
async function save(): Promise<void> {
  saving.value = true;
  try {
    // 防御：表单字段一律先 String 兜底再 trim，任何字段为 undefined/null 都不会炸（读到异常路由行也能编辑保存）
    const TR = (v: unknown): string => String(v ?? '').trim();
    // 结构化控件装配回 JSON；空值键不写入，*Rest 里的高级键原样合回
    const drop = (o: Record<string, unknown>): Record<string, unknown> | undefined => {
      const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));
      return Object.keys(out).length ? out : undefined;
    };
    if (ap.type === 'business_webhook' && !TR(ap.url)) throw new Error('高风险审批承接选择业务侧 webhook 时，审批意图接收地址必填');
    const sourceCfgs = tl.sources.filter((source) => source.provider).map((source) => ({
      provider: source.provider,
      allow: source.allow,
      ...(source.subject_field.trim() ? { subject_field: source.subject_field.trim() } : {}),
      ...source.rest,
    }));
    const builtinCfg = tl.send_channels.length || Object.keys(builtinRest).length || Object.keys(sendRest).length
      ? drop({ ...(tl.send_channels.length || Object.keys(sendRest).length ? { send_message: { channels: tl.send_channels, ...sendRest } } : {}), ...builtinRest })
      : undefined;
    const approvalCfg = ap.type ? drop({ type: ap.type, ...(ap.type === 'business_webhook' ? { url: TR(ap.url) } : {}), ...apRest }) : undefined;
    const hasAudienceFilters = au.keywords.length || au.clients.length || au.channels.length || au.tenants.length || au.roles.length || au.principals.length || au.audiences.length;
    const audienceCfg = (au.enabled || au.auto || au.anonymous || au.priority !== 0 || hasAudienceFilters || Object.keys(audienceRest).length)
      ? drop({
        enabled: au.enabled || !!hasAudienceFilters,
        ...(au.auto ? { auto: true } : {}),
        ...(au.anonymous ? { anonymous: true } : {}),
        ...(au.priority !== 0 ? { priority: au.priority } : {}),
        ...(au.keywords.length ? { keywords: au.keywords } : {}),
        ...(au.clients.length ? { clients: au.clients } : {}),
        ...(au.channels.length ? { channels: au.channels } : {}),
        ...(au.tenants.length ? { tenants: au.tenants } : {}),
        ...(au.roles.length ? { roles: au.roles } : {}),
        ...(au.principals.length ? { principals: au.principals } : {}),
        ...(au.audiences.length ? { audiences: au.audiences } : {}),
        ...audienceRest,
      })
      : undefined;
    const body: Record<string, unknown> = {
      route_key: TR(form.route_key), name: TR(form.name) || TR(form.route_key),
      target: form.target, project: TR(form.project) || undefined, profile: TR(form.profile) || undefined,
      permission: form.permission || 'full',
      session_policy: form.session_policy,
      session_key_field: TR(form.session_key_field) || undefined,
      session_fixed_id: TR(form.session_fixed_id) || undefined,
      target_config: form.target === 'llm'
        ? drop({
          credential: llm.credential.trim(), model: llm.model.trim(), system_prompt: llm.system_prompt.trim(),
          input: drop({
            ...(vis.on ? { image: {
              ...(vis.credential.trim() ? { credential: vis.credential.trim() } : {}),
              ...(vis.model.trim() ? { model: vis.model.trim() } : {}),
              mode: vis.mode,
              ...(vis.mode === 'tool' && vis.max_calls && vis.max_calls !== 6 ? { max_calls: vis.max_calls } : {}),
              ...visRest,
            } } : {}),
            ...(voice.on ? { audio: {
              ...(voice.mode === 'transcribe' && voice.credential.trim() ? { credential: voice.credential.trim() } : {}),
              ...(voice.mode === 'transcribe' && voice.model.trim() ? { model: voice.model.trim() } : {}),
              mode: voice.mode,
              ...(voice.max_bytes_mb && voice.max_bytes_mb !== 12 ? { max_bytes: Math.round(voice.max_bytes_mb * 1024 * 1024) } : {}),
              ...voiceRest,
            } } : {}),
            ...(fileInput.on ? { file: {
              ...((fileInput.mode === 'summarize' || fileInput.mode === 'inline') && fileInput.credential.trim() ? { credential: fileInput.credential.trim() } : {}),
              ...((fileInput.mode === 'summarize' || fileInput.mode === 'inline') && fileInput.model.trim() ? { model: fileInput.model.trim() } : {}),
              mode: fileInput.mode,
              ...(fileInput.max_bytes_mb && fileInput.max_bytes_mb !== 20 ? { max_bytes: Math.round(fileInput.max_bytes_mb * 1024 * 1024) } : {}),
              ...(fileInput.max_chars && fileInput.max_chars !== 24000 ? { max_chars: fileInput.max_chars } : {}),
              ...fileRest,
            } } : {}),
            ...inputRest,
          }),
          ...llmRest,
        })
        : parseJson('target_config', form.target_config),
      knowledge: kn.kb_ids.length ? { kb_ids: kn.kb_ids, top_k: kn.top_k, inject: kn.inject, min_score: kn.min_score, ...(kn.inject === 'doc' ? { max_docs: kn.max_docs } : {}), ...(kn.page_boost ? { page_boost: true } : {}), ...knRest } : undefined,
      delivery: dv.type
        ? drop({ type: dv.type, ...(dv.type === 'webhook' ? { url: dv.url.trim() } : dv.type === 'channel' ? { channel: dv.channel.trim(), to_field: dv.to_field.trim(), to: dv.to.trim() } : { to_field: dv.to_field.trim(), to: dv.to.trim() }), ...dvRest })
        : undefined,
      retry: rt.max > 0 ? { max: rt.max, backoff_ms: rt.backoff_ms, ...rtRest } : undefined,
      // tools：业务工具源(sources)、全局调用预算、中枢内置动作与审批承接分离。
      tools: (sourceCfgs.length || builtinCfg || approvalCfg || Object.keys(tlRest).length)
        ? {
          ...(sourceCfgs.length ? { sources: sourceCfgs, max_calls: tl.max_calls } : {}),
          ...(builtinCfg ? { builtin: builtinCfg } : {}),
          ...(approvalCfg ? { approval: approvalCfg } : {}),
          ...tlRest,
        }
        : undefined,
      audience: audienceCfg,
      // 记忆层：默认且未开摘要、无高级键 → 不写；否则落配置
      memory: (mem.summary_enabled || mem.recent_messages !== 12 || mem.recent_budget_chars !== 3500 || Object.keys(memRest).length)
        ? {
          recent_messages: mem.recent_messages, recent_budget_chars: mem.recent_budget_chars, summary_enabled: mem.summary_enabled,
          ...(mem.summary_enabled ? { summary_trigger_chars: mem.summary_trigger_chars, summary_keep_recent: mem.summary_keep_recent, ...(mem.summary_model.trim() ? { summary_model: mem.summary_model.trim() } : {}) } : {}),
          ...memRest,
        }
        : undefined,
      budget: (budget.enabled && (Number(budget.hard_cost_usd) > 0 || Number(budget.hard_tokens) > 0 || Object.keys(budgetRest).length))
        ? {
          enabled: true,
          window: budget.window,
          ...(Number(budget.hard_cost_usd) > 0 ? { hard_cost_usd: Number(budget.hard_cost_usd) } : {}),
          ...(Number(budget.hard_tokens) > 0 ? { hard_tokens: Math.round(Number(budget.hard_tokens)) } : {}),
          ...budgetRest,
        }
        : undefined,
      description: TR(form.description) || undefined, enabled: form.enabled,
    };
    await api('/admin/api/routes', { method: 'POST', body: JSON.stringify(body) });
    ElMessage.success('已保存'); open.value = false; await load();
  } catch (e) { ElMessage.error((e as Error).message); }
  finally { saving.value = false; }
}
async function del(key: string): Promise<void> {
  try { await api('/admin/api/routes/' + encodeURIComponent(key), { method: 'DELETE' }); await load(); }
  catch (e) { ElMessage.error((e as Error).message); }
}

// ---- 调用代码 ----
const codeOpen = ref(false);
const codeTab = ref('curl');
const codeRoute = ref<any | null>(null);
const codeClientId = ref('');
const eligibleClients = computed(() => clients.value.filter((c) => (c.allowed_routes || []).includes('*') || (c.allowed_routes || []).includes(codeRoute.value?.route_key)));
const codeClient = computed(() => clients.value.find((c) => c.app_id === codeClientId.value));
const codeCoverage = computed(() => codeRoute.value ? coverage(codeRoute.value) : null);
// 目标是执行器类时，多给一页「执行器接入」
const codeTargetIsExecutor = computed(() => targetOptions.value.find((t) => t.name === codeRoute.value?.target)?.kind === 'executor');
function openCode(row: any): void {
  codeRoute.value = row;
  codeTab.value = 'curl';
  const eligible = clients.value.filter((c) => (c.allowed_routes || []).includes('*') || (c.allowed_routes || []).includes(row.route_key));
  if (!eligible.length) { ElMessage.warning(`还没有可调用该路由的接入方——先在「接入方」建一个，可调路由含 ${row.route_key} 或 *`); return; }
  codeClientId.value = eligible[0]!.app_id;
  codeOpen.value = true;
}
// 示例 metadata：把会话键（per_key）与「渠道直推」的收件人字段都带进去，免得开发者漏传收件人。
function demoMetaJson(r: any, sessionVal: string): string {
  const m: Record<string, string> = {};
  if (r.session_policy === 'per_key' && r.session_key_field) m[r.session_key_field] = sessionVal;
  if (r.delivery?.type === 'channel' && r.delivery?.to_field) m[r.delivery.to_field] = '<收件人id>';
  return Object.keys(m).length ? JSON.stringify(m) : '{}';
}
const phpCode = computed(() => {
  const r = codeRoute.value; const c = clients.value.find((x) => x.app_id === codeClientId.value);
  if (!r || !c) return '';
  const base = location.origin;
  const fn = 'bailing_' + r.route_key.replace(/[^a-z0-9]+/gi, '_');
  const keyField = r.session_policy === 'per_key' && r.session_key_field ? r.session_key_field : '';
  const rcpt = r.delivery?.type === 'channel' ? String(r.delivery.to_field || '').trim() : '';
  const metaPairs = [keyField ? `'${keyField}' => $bizId` : '', rcpt ? `'${rcpt}' => $userId` : ''].filter(Boolean);
  const metaExample = metaPairs.length ? `, [${metaPairs.join(', ')}]` : '';
  return `/**
 * 百灵中枢 · ${r.name}（route: ${r.route_key}）
 * 在业务事件点调用，如：${fn}('唯一事件号', $content${metaExample});
 * request_id 是幂等键：同一事件重复触发不会重复跑，建议用业务唯一号。${rcpt ? `\n * ⚠ 本路由配了「渠道直推」：metadata 必须带 '${rcpt}'（收件人在「${r.delivery.channel}」渠道里的原生 id）——任务跑完自动推给 ta，无需再调 /send。` : ''}
 */
function ${fn}(string $requestId, string $input, array $metadata = []): void
{
    try {
        $ch = curl_init('${base}/run');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode([
                'request_id' => '${c.app_id}_' . $requestId,
                'route'      => '${r.route_key}',
                'input'      => $input,
                'metadata'   => $metadata,
            ], JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Authorization: Bearer ${c.token}'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 1,
            CURLOPT_TIMEOUT        => 2, // 解耦保护：中枢不可用时最多拖慢业务 2 秒
        ]);
        curl_exec($ch);
        curl_close($ch);
    } catch (\\Throwable $e) {
        // 只记日志，绝不影响业务主流程
    }
}`;
});
const curlCode = computed(() => {
  const r = codeRoute.value; const c = clients.value.find((x) => x.app_id === codeClientId.value);
  if (!r || !c) return '';
  const base = location.origin;
  const metaJson = demoMetaJson(r, 'demo-1');
  return `# 触发
curl -m 2 -X POST '${base}/run' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${c.token}' \\
  -d '{"request_id":"${c.app_id}_demo-1","route":"${r.route_key}","input":"联调测试内容","metadata":${metaJson}}'

# 查询结果（用上一步返回的 job_id）
curl -H 'Authorization: Bearer ${c.token}' '${base}/jobs/<job_id>'`;
});
const nodeCode = computed(() => {
  const r = codeRoute.value; const c = clients.value.find((x) => x.app_id === codeClientId.value);
  if (!r || !c) return '';
  const base = location.origin;
  const metaJson = demoMetaJson(r, 'demo-1');
  return `// 百灵中枢 · ${r.name}（route: ${r.route_key}）
// request_id 是幂等键：同一业务事件重复触发不会重复执行。
// 需要回流结果时配置路由 callback；需要主动查询时，用返回的 job_id 调 GET /jobs/{job_id}。

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 2000);

try {
  const response = await fetch('${base}/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ${c.token}',
    },
    body: JSON.stringify({
      request_id: '${c.app_id}_demo-1',
      route: '${r.route_key}',
      input: '联调测试内容',
      metadata: ${metaJson},
    }),
    signal: controller.signal,
  });

  const data = await response.json();
  console.log(data.job_id, data.status);
} catch (err) {
  // 只记录，不影响业务主流程
  console.error('bailing trigger failed', err);
} finally {
  clearTimeout(timeout);
}`;
});
const pythonCode = computed(() => {
  const r = codeRoute.value; const c = clients.value.find((x) => x.app_id === codeClientId.value);
  if (!r || !c) return '';
  const base = location.origin;
  const metaJson = demoMetaJson(r, 'demo-1');
  return `# 百灵中枢 · ${r.name}（route: ${r.route_key}）
# request_id 是幂等键：同一业务事件重复触发不会重复执行。
# pip install requests

import requests

payload = {
    "request_id": "${c.app_id}_demo-1",
    "route": "${r.route_key}",
    "input": "联调测试内容",
    "metadata": ${metaJson},
}

try:
    response = requests.post(
        "${base}/run",
        json=payload,
        headers={"Authorization": "Bearer ${c.token}"},
        timeout=2,
    )
    print(response.json())
except requests.RequestException as exc:
    # 只记录，不影响业务主流程
    print("bailing trigger failed", exc)`;
});
// 触发方向：给任意 agent 一段可保存的提示词/技能说明
const skillCode = computed(() => {
  const r = codeRoute.value; const c = clients.value.find((x) => x.app_id === codeClientId.value);
  if (!r || !c) return '';
  const base = location.origin;
  const metaJson = demoMetaJson(r, '<业务编号>');
  return `# Agent Skill: bailing-${r.route_key}

当用户要求「${r.name}」或当前工作产生适合交给该场景处理的任务时，调用百灵中枢路由 \`${r.route_key}\`。

派单（fire-and-forget，返回 202 + job_id）：

\`\`\`bash
curl -m 5 -X POST '${base}/run' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${c.token}' \\
  -d '{"request_id":"${c.app_id}_<本次事件唯一号>","route":"${r.route_key}","input":"<任务内容>","metadata":${metaJson}}'
\`\`\`

- request_id 是幂等键：用本次事件的唯一编号，重复触发不会重复执行
- 需要结果时轮询（通常异步任务无需等待）：

\`\`\`bash
curl -H 'Authorization: Bearer ${c.token}' '${base}/jobs/<job_id>'
\`\`\`
`;
});
// 承接方向：后台只交付本次连接参数；稳定流程由公开、可版本化的 Skill 承载。
const execCode = computed(() => {
  const r = codeRoute.value;
  if (!r) return '';
  const base = location.origin;
  return `# 任务：把本机安全接入百灵中枢执行器

请先读取并严格执行这份版本化接入 Skill：
${base}/connect/skills/connect-bailinghub-executor/SKILL.md

本次连接参数：
- HUB_URL: ${base}
- TARGET: ${r.target}
- ROUTE_CONTEXT: ${r.route_key}（仅供理解场景，执行器按 TARGET 认领）
- EXECUTOR_ID: 先询问用户并取得确认，不得自行猜测

执行要求：
1. 如果运行时原生支持 Skill，可将上述文档及其 references 作为 Skill 使用；否则把它当作机器可读操作手册执行，不要因缺少原生 Skill 功能而改写协议。
2. 先完成文档中的环境预检和模式选择。默认使用官方通用执行器，只有能可靠维护常驻循环时才走直连协议。
3. 执行器令牌必须让用户在本机隐藏输入或通过可信 secret manager 注入；不得要求用户把令牌粘贴进对话，不得写入命令参数、脚本、仓库或日志。
4. 完成后只汇报 executor_id、target、运行时、常驻方式和验证结果，禁止回显任何密钥。
5. 成功标准：控制台显示同一 executor_id 在线且 target 为「${r.target}」，专用测试任务返回真实处理结果而不是原样复读。`;
});

onMounted(async () => {
  void routeSchema.load().catch(() => undefined);
  await load();
  if (s.can('targets:read')) {
    try {
      const ts = await api<any[]>('/admin/api/targets');
      // 送达承接者(*-notify)不作为路由 target，单独留给「送达」渠道下拉
      targetOptions.value = ts.filter((t) => !t.name.endsWith('-notify'));
      notifyTargetsRaw.value = ts.filter((t) => t.name.endsWith('-notify'));
    } catch { /* 退化为内置 */ }
  }
  if (s.can('runs:read')) {
    try { execs.value = await api('/admin/api/executors'); } catch { /* 覆盖度可选，无则不显示 */ }
  }
  if (s.can('projects:read')) {
    try { projectNames.value = (await api<any[]>('/admin/api/projects')).map((p) => p.name); } catch { /* 可选 */ }
  }
  if (s.can('clients:read')) {
    try { clients.value = await api('/admin/api/clients'); } catch { /* 可选 */ }
  }
  // 路由的入口/渠道绑定：用于「会话策略」上下文提示（判断本项在该路由下是否生效）。失败则静默退化为通用提示。
  if (s.can('routes:read')) {
    try { chatEntries.value = await api('/admin/api/chat-entries'); } catch { /* 可选 */ }
    try { channels.value = await api('/admin/api/channels'); } catch { /* 可选 */ }
  }
  // 表单下拉的关联注册表（无权限时静默退化为 allow-create 手输）
  if (s.can('credentials:read')) {
    try { credOptions.value = await api('/admin/api/credentials'); } catch { /* 可选 */ }
  }
  if (s.can('kb:read')) {
    try { kbOptions.value = await api('/admin/api/kb'); } catch { /* 可选 */ }
  }
  if (s.can('tools:read')) {
    try { providerOptions.value = await api('/admin/api/tool-providers'); } catch { /* 可选 */ }
  }
});
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--bz-mono); font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.route-main,
.route-stack,
.status-stack {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.route-main b {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.route-stack > div,
.status-stack > div,
.feature-tags,
.code-route-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.coverage {
  font-size: 12px;
  line-height: 1.5;
  cursor: help;
}
.coverage.success { color: var(--el-color-success); }
.coverage.danger { color: var(--el-color-danger); }
.coverage.warning { color: var(--el-color-warning); }
.coverage.info { color: var(--el-text-color-secondary); }
.code-route-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 12px;
  border: 1px solid var(--el-border-color-lighter);
}
.code-route-summary > div {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.code-route-summary > div:last-child { border-right: 0; }
.code-route-summary span,
.code-route-summary em {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-style: normal;
}
.code-route-summary b {
  display: block;
  margin: 4px 0 2px;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.code-route-tags {
  margin: -2px 0 12px;
}
.route-form-tabs :deep(.el-tabs__content) { min-height: 360px; }
.scope-tag { color: var(--el-text-color-secondary); font-weight: normal; font-size: 12px; }
.field-warning { margin-left: 4px; color: var(--el-color-danger); cursor: help; font-size: 14px; vertical-align: -2px; }
.inline-row { display: flex; align-items: center; gap: 8px; }
.form-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px 0 12px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 650;
}
.tool-sources-head,
.tool-source-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.tool-sources-head { margin-bottom: 12px; color: var(--el-text-color-primary); font-size: 13px; font-weight: 650; }
.tool-sources-empty { margin: -2px 0 18px; }
.tool-source-editor {
  margin-bottom: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.tool-source-editor__head { margin-bottom: 10px; font-size: 12px; }
.field-hint { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
.field-hint code { font-family: var(--bz-mono); font-size: 11px; background: var(--el-fill-color-light); padding: 1px 4px; }
@media (max-width: 900px) {
  .code-route-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .code-route-summary > div:nth-child(2) { border-right: 0; }
  .code-route-summary > div:nth-child(-n + 2) { border-bottom: 1px solid var(--el-border-color-lighter); }
}
</style>
