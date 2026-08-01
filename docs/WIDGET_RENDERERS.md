# 嵌入聊天组件富内容渲染器

BailingHub 的嵌入聊天组件原生支持 Markdown 文本、表格、图片和文件链接。图表、动态报表等交互内容通过一个可选的可信渲染器注册表扩展，核心组件继续保持零第三方运行时依赖。

## 适用边界

- 模型只能输出声明式数据，不能输出或选择要执行的 JavaScript、HTML、远程脚本地址或组件代码。
- 渲染器由嵌入页面的开发者预先安装并注册，属于宿主应用的可信代码。
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
  mount({ container, payload, source, type, version, theme, signal }) {
    // payload 是不可信输入，适配器必须校验字段、数量和取值范围。
    const chart = createMyChart(container, payload, theme);
    return () => chart.destroy();
  },
});

// 不再接受该类型时：
unregister();
```

`mount` 可以返回销毁函数、带 `destroy()` 的对象、Promise，或不返回值。`signal` 在消息离开视图时触发 abort，异步渲染器应及时停止工作。

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
    "renderers": ["bailing-chart"]
  }
}
```

`client_capabilities` 只用于回答呈现提示：

- 不提供时，中枢不会因为客户端“可能支持图表”而主动要求模型输出图表；
- 声明 `bailing-chart` 只表示客户端能安全展示该声明，不改变身份、权限、审批、路由、工具白名单或业务授权；
- 不要把尚未安装的渲染器写进能力列表；服务端最多接受 16 个符合命名规则的类型；
- 运行时是否输出图表仍由真实数据和表达需要决定，不能用图表填补缺失数据。

创建任务后，连接 `GET /chat/:entry_key/events/:job_id`。自建客户端必须遵循以下生命周期：

1. `delta` 只追加到临时文本气泡，不在增量阶段执行富内容渲染；
2. `reset` 立即清空临时文本和对应渲染状态；
3. `done.reply` 是权威最终文本，必须替换临时气泡；
4. 只有 `done` 到达后，才用成熟 Markdown 解析器读取完整 fenced code block，并把白名单类型交给可信渲染器；
5. `failed` 或 `timeout` 不得把临时文本冒充成最终业务结果。

最小传输范例见 [`docs/examples/custom-streaming-chat-client.mjs`](examples/custom-streaming-chat-client.mjs)。它故意不包含 Markdown 解析器和图表库：业务前端应复用自己的 Markdown AST/token 流，在 fenced code token 层识别渲染类型，不要用 `eval`、`innerHTML` 或远程脚本解释模型输出。

### 自建渲染器的最低门槛

- 类型必须命中本地白名单，例如只接受 `bailing-chart`；
- JSON 必须是对象或数组，并限制字节数、嵌套深度、字符串长度和数据点数量；
- 图表字段应继续做枚举与数值校验，例如 `kind` 只允许 `bar/line/pie`，`value` 必须是有限数值；
- 未知类型、解析失败、超限或渲染异常必须回退成普通代码块/文本，不得放宽校验重试；
- 最终消息替换、路由切换和组件卸载时，应销毁图表实例与监听器；
- 附件、引用、图表和业务执行结果是不同契约，不能互相推断。

一句话判断：官方 Widget 负责开箱即用；自建客户端负责能力自报、SSE 生命周期、最终文本解析和可信渲染，BailingHub 不会把宿主前端的安全责任隐式接管。
