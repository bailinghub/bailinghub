# 嵌入聊天组件富内容渲染器

BailingHub 的嵌入聊天组件原生支持 Markdown 文本、表格、图片和文件链接。图表、动态报表等展示内容通过可信渲染器注册表扩展；受限的 `bailing-form` v1 则由官方 Widget 原生渲染。两者都消费声明式 fenced payload，核心组件继续保持零第三方运行时依赖。

## 适用边界

- 模型只能输出声明式数据，不能输出或选择要执行的 JavaScript、HTML、远程脚本地址或组件代码。
- 自定义渲染器由嵌入页面的开发者预先安装并注册，属于宿主应用的可信代码；官方 `bailing-form` 实现使用同一白名单和失败回退边界。
- 渲染器不会收到聊天票据、业务凭证、会话身份或完整页面上下文。
- 未注册类型、非法 JSON、超限载荷和渲染异常都会降级成使用 `textContent` 展示的代码块。
- 富内容只在完整闭合的 fenced code block 到达后挂载；流式增量阶段不会反复创建图表。
- 消息重绘、历史重载和开启新对话时，组件会中止渲染任务并调用渲染器的销毁函数。

这不是让模型拥有前端执行权，而是让模型在一个固定白名单内提交数据，由宿主选择如何展示。

## 注册接口

当前渲染器接口版本为 `window.BailingChat.rendererApiVersion === "1"`。

```js
const unregister = window.BailingChat.registerRenderer({
  type: 'bailing-chart',
  version: 1,
  label: '业务图表',
  contentType: 'application/json', // 或 text/plain
  maxPayloadBytes: 64 * 1024,
  mount({ container, payload, source, type, version, theme, signal, message, respond }) {
    // payload 是不可信输入，适配器必须校验字段、数量和取值范围。
    const chart = createMyChart(container, payload, theme);
    return () => chart.destroy();
  },
});

// 不再接受该类型时：
unregister();
```

`mount` 可以返回销毁函数、带 `destroy()` 的对象、Promise，或不返回值。`signal` 在消息离开视图时触发 abort，异步渲染器应及时停止工作。

Widget API v1 为需要交互回传的渲染器兼容新增了两个可选上下文：

- `message` 提供当前助手消息的 `jobId` 和已知 `responses`。`responses` 每项只含 `type/version/source_job_id/form_id/submission_id/action`，不含表单值。
- `respond(response, presentation?)` 返回 Promise，用于发起同 thread 的下一条用户消息。表单 response 体为 `{form_id, submission_id, action:"submit"|"cancel", values?}`，`submission_id` 匹配 `[A-Za-z0-9_-]{8,64}`，`values` 最大 32 KiB；Widget 从当前消息闭包强制补入 `type:"bailing-form"` / `version:1` / `source_job_id`，渲染器不能指定任意端点、方法或源 job。`presentation` 目前只支持本地用户气泡文案 `{displayText}`，不发往服务端。

旧渲染器可继续只解构原有参数；增加 `message/respond` 不改变 `rendererApiVersion === "1"`。`respond` 不会向渲染器暴露 `ticket`、`visitor_id`、`thread_id` 或其他身份材料。

## 输出格式

注册 `bailing-chart` 后，完整回复中的以下代码块会交给对应渲染器：

````markdown
```bailing-chart
{
  "kind": "bar",
  "title": "近七日营业额",
  "data": [
    { "label": "周一", "value": 12800 },
    { "label": "周二", "value": 15300 }
  ]
}
```
````

类型名只接受小写字母开头的字母、数字、点、下划线、加号和连字符组合，最长 64 个字符。JSON 渲染器只接受对象或数组；字符串等标量请使用 `text/plain`。

## 官方 `bailing-form` v1

官方 Widget 自动声明并渲染 `bailing-form`，不需要宿主引入 React、Vue、JSON Schema 运行时或表单库。模型只能输出数据，字段控件、校验、提交和回执由 Widget 固定实现。

宿主可在异步 Widget 加载前预注册同名 `bailing-form` 渲染器以显式覆盖内置 UI；这是宿主可信代码的责任，必须完整实现本节的校验、回传和销毁契约。服务端无论如何都会重读源回复验值，宿主覆盖不会放宽权威边界。

````markdown
```bailing-form
{
  "version": 1,
  "form_id": "refund_info",
  "title": "请补充退款信息",
  "description": "提交后将在当前会话继续处理",
  "schema": {
    "reason": {
      "type": "textarea",
      "label": "退款原因",
      "required": true,
      "maxLength": 200
    },
    "method": {
      "type": "single_select",
      "label": "退款方式",
      "required": true,
      "options": [
        { "label": "原路退回", "value": "original" },
        { "label": "余额退回", "value": "balance" }
      ]
    }
  },
  "submit_label": "提交信息",
  "cancel_label": "取消"
}
```
````

顶层只接受 `version:1`、`form_id`、`title`、`description?`、`schema`、`submit_label?`、`cancel_label?`。`form_id` 和字段名匹配 `[a-z][a-z0-9_-]{0,63}`；单个 fenced JSON 最大 32 KiB，`schema` 包含 1–12 个字段。标题和字段标签最长 80 字符，顶层说明 300，字段说明 200，占位文字 120，按钮文字 32。

| `type` | 额外字段与限制 |
|---|---|
| `text` | `minLength?` / `maxLength?`，最长上限 500 |
| `textarea` | `minLength?` / `maxLength?`，最长上限 2000 |
| `number` | 可选有限数值 `min?` / `max?` |
| `date` | 可选 `min?` / `max?`，格式固定为 `YYYY-MM-DD` |
| `boolean` | 无额外字段 |
| `single_select` | 必填 `options`，1–50 项，单选 |
| `multi_select` | 必填 `options`，1–50 项，多选 |

所有字段可使用 `label`、`description?`、`placeholder?`、`required?`。选项只包含 `{label,value}`，label 最长 80、value 最长 120，且同一字段的 value 唯一。未声明字段、嵌套对象、文件、正则表达式、HTML/JavaScript/CSS、远程脚本/数据源和内含三反引号的值会被拒绝。

### 提交、回执与历史恢复

1. 表单只在源回答完整 `done` 后挂载，源 job 不会进入等待状态。
2. 用户提交或取消后，Widget 将 `interaction_response` 发往原入口，服务端在同 thread 创建新 job，再走既有 SSE 流。
3. 发送中控件禁用；创建新 job 成功后，源表单变为只读的“已提交”或“已取消”回执。请求失败时恢复控件，不把本地点击冒充成功。
4. `/thread` 返回的用户消息可带 `interaction` 摘要；Widget 用 `source_job_id + form_id` 重建已回复状态，跨设备/刷新后不会再显示可重复提交的表单。

表单只用来收集普通信息或选择，不是审批单、授权凭据或工具执行确认。表单标题/说明、字段名/标签/说明/占位文字如疑似密码、API Key、Token、私钥、银行卡号或 CVV 会被拒绝；部署方还应注意，用户提交的非秘密值会作为对话消息进入总账和模型上下文，须按自己的数据保留与合规规则使用。

## 加载顺序

### Widget 加载后注册

```html
<script src="https://hub.example.com/widget.js" data-entry="store_assistant"></script>
<script type="module">
  import { registerBailingChartRenderer } from './widget-chart-renderer-adapter.mjs';
  registerBailingChartRenderer(createChart);
</script>
```

### Widget 异步加载前预注册

```html
<script>
  window.BailingChat = {
    renderers: [{
      type: 'bailing-chart',
      mount(context) { return mountTrustedChart(context); }
    }]
  };
</script>
<script async src="https://hub.example.com/widget.js" data-entry="store_assistant"></script>
```

## 第三方图表库

ECharts、GPT-Vis、Mermaid 或内部报表组件都应放在宿主适配器中，不进入 BailingHub 核心包。适配器负责：

1. 校验声明结构和数据规模；
2. 把声明映射成具体库的配置；
3. 禁止任意 HTML、脚本、事件处理器和不受信任的数据源；
4. 在 `signal` 中止或组件销毁时释放实例、监听器和定时器。

可从 [`docs/examples/widget-chart-renderer-adapter.mjs`](examples/widget-chart-renderer-adapter.mjs) 开始实现具体适配器。

## 自建流式客户端（不加载 widget.js）

业务侧如果自行消费聊天接口和 SSE，不会自动获得官方 Widget 的渲染行为。客户端必须只声明自己已经安装、校验并信任的渲染类型：

```http
POST /chat/store_assistant
Content-Type: application/json

{
  "message": "分析近七日营业额",
  "visitor_id": "visitor_01HXYZ",
  "client_capabilities": {
    "renderers": ["bailing-chart", "bailing-form"]
  }
}
```

`client_capabilities` 只用于回答呈现提示：

- 不提供时，中枢不会因为客户端“可能支持图表”而主动要求模型输出图表；
- 声明 `bailing-chart` 或 `bailing-form` 只表示客户端能安全展示该声明，不改变身份、权限、审批、路由、工具白名单或业务授权；
- 不要把尚未安装的渲染器写进能力列表；服务端最多接受 16 个符合命名规则的类型；
- 运行时是否输出图表仍由真实数据和表达需要决定，不能用图表填补缺失数据。

创建任务后，连接 `GET /chat/:entry_key/events/:job_id`。自建客户端必须遵循以下生命周期：

1. `delta` 只追加到临时文本气泡，不在增量阶段执行富内容渲染；
2. `reset` 立即清空临时文本和对应渲染状态；
3. `done.reply` 是权威最终文本，必须替换临时气泡；
4. 只有 `done` 到达后，才用成熟 Markdown 解析器读取完整 fenced code block，并把白名单类型交给可信渲染器；表单回传必须保留此 `done.job_id` 作为 `source_job_id`；
5. `failed` 或 `timeout` 不得把临时文本冒充成最终业务结果。

最小传输范例见 [`docs/examples/custom-streaming-chat-client.mjs`](examples/custom-streaming-chat-client.mjs)。它故意不包含 Markdown 解析器和图表库：业务前端应复用自己的 Markdown AST/token 流，在 fenced code token 层识别渲染类型，不要用 `eval`、`innerHTML` 或远程脚本解释模型输出。

自建客户端提交表单时，向同一 `POST /chat/:entry_key` 发送 `{interaction_response:{type:"bailing-form",version:1,source_job_id,form_id,submission_id,action,values?}, visitor_id?, ticket?, thread_id?}`。服务端会核对源 job/入口/身份/thread，从权威回复重新取 schema 验值，并以 `submission_id` 幂等去重；客户端不得同时发 `message`，也不得把自己的 schema 当作权威传回。完整 HTTP 契约见 [CONTRACT.md §1.1.1](CONTRACT.md#111-bailing-form-非阻塞交互回传)。

### 自建渲染器的最低门槛

- 类型必须命中本地白名单，例如只接受 `bailing-chart`；
- JSON 必须是对象或数组，并限制字节数、嵌套深度、字符串长度和数据点数量；
- 图表字段应继续做枚举与数值校验，例如 `kind` 只允许 `bar/line/pie`，`value` 必须是有限数值；
- 未知类型、解析失败、超限或渲染异常必须回退成普通代码块/文本，不得放宽校验重试；
- 最终消息替换、路由切换和组件卸载时，应销毁图表实例与监听器；
- 附件、引用、图表和业务执行结果是不同契约，不能互相推断。
- `bailing-form` 须实现本文的字段白名单、范围验证、唯一提交标识、失败恢复和历史回执；不得把任意 JSON Schema 直接交给动态表单引擎。

一句话判断：官方 Widget 负责开箱即用；自建客户端负责能力自报、SSE 生命周期、最终文本解析和可信渲染，BailingHub 不会把宿主前端的安全责任隐式接管。
