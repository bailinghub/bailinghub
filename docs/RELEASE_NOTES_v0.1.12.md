# BailingHub v0.1.12：语音转写策略与失败关闭

发布日期：2026-07-30。

`v0.1.12` 修正网页聊天语音输入在主模型不支持 `input_audio` 时直接失败的问题，并把音频处理从隐式回退改为显式、可审计的路由策略。

## 主要变化

### 1. 音频处理策略改为显式配置

LLM 路由现在支持三种明确模式：

- `transcribe`：先由专用语音模型转成文本，再把文本交给主模型；
- `inline`：仅在部署方明确确认主模型支持音频输入时，才把音频直接交给主模型；
- `off`：拒绝语音输入并返回确定性提示。

缺少音频配置时默认 `off`，不再猜测主模型能力。

### 2. 转写配置不完整时失败关闭

当路由选择 `transcribe`，但转写凭证、模型或端点缺失、禁用或无法解析时，中枢不会把音频退回给主模型，也不会根据文件名或其他元数据猜测内容。任务会返回明确的用户提示，并记录脱敏后的失败原因。

### 3. 支持两类 OpenAI-compatible 转写协议

专用语音模型支持：

- `transcriptions`：通过 `/audio/transcriptions` 发送 multipart 请求；
- `chat_input_audio`：通过 `/chat/completions` 发送 Data URL 形式的 `input_audio`。

后者可用于兼容采用 Chat Completions 音频输入形式的语音模型。

### 4. 控制台与配置 Schema 对齐

路由编辑页新增语音协议选择，并明确说明转写模型与主模型的职责。配置 Schema 同步约束协议枚举与默认值，避免控制台、运行时和机器可读配置出现不同语义。

### 5. 保持可审计但不记录音频正文

语音审计记录包含处理结果、模式、协议、模型、MIME 类型和字节数，不记录音频内容、Data URL、凭证或转写请求正文。转写后的文本继续按现有任务与会话边界处理。

## 对接影响

- 没有数据库迁移。
- Client API、执行器协议、工具签名、审批语义和 ACC 均未改变。
- 文本聊天与现有主模型配置不受影响。
- 依赖旧版隐式音频直传的路由，需要显式选择 `inline`，或者配置专用转写模型并选择 `transcribe`。
- 推荐生产环境使用 `transcribe`，让主模型只处理文本和工具调用。

## 验证

发布前完成：

- `npm run typecheck`
- `npm test`
- `npm run web-admin:check`
- `npm run release:check`

端到端验证覆盖真实 MP3 上传、专用语音模型转写、文本进入主模型、流式回复和任务终态；验证过程中未在公开材料中记录内部地址、凭证、音频正文或任务标识。

## 相关文档

- [工具治理设计](TOOLS_DESIGN.md)
- [配置 Schema](../schemas/config/common.schema.json)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.1.12.en.md)
