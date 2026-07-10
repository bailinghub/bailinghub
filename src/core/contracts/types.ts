// 边界契约的类型定义。改动须与 docs/CONTRACT.md 同步，且按兼容方式演进。

/** 会话目标：续聊已有会话(isContinue) 还是用指定 id 开新会话 */
export interface SessionTarget {
  sessionId: string;
  isContinue: boolean;
}

export type JobStatus = 'queued' | 'running' | 'dispatched' | 'done' | 'error' | 'rejected';

/** 调查任务（单一真值源） */
export interface Job {
  job_id: string;
  request_id: string;
  status: JobStatus;
  target?: string;
  profile: string;
  project: string;
  source: string;
  client_app_id?: string; // 触发方 app_id（admin token 触发为空）
  thread_id?: number;     // 对话线索（总账），finish 时回写 out 消息
  session_id?: string;
  input_preview: string;
  input?: string; // 完整输入（远端执行器认领时回传给执行器）
  report?: Record<string, unknown>; // 结构化结论（structuredOutput 能力档产出；schema 由该档的提示词约定）
  raw_result?: string;
  result?: Record<string, unknown>; // 适配器统一输出（{text} 或 {report}）
  usage?: { duration_ms?: number; num_turns?: number; cost_usd?: number; tokens?: number };
  error?: string;
  metadata: Record<string, unknown>;
  callback_url?: string;
  // 远端执行器派活相关（含 route 快照：route 之后可能改/删，故落到 job 上）；kb_refs=知识检索命中快照（引用来源回流）
  // user_images/user_audio/user_files=用户原始输入里的媒体 URL 快照（只取用户发的，不含知识库注入资产）；多模态适配器据此送模型，rerun 也能复现
  dispatch?: { target_config?: Record<string, unknown>; is_continue?: boolean; delivery?: Record<string, unknown>; route_key?: string; route_name?: string; retry?: Record<string, unknown>; tools?: Record<string, unknown>; memory?: Record<string, unknown>; kb_refs?: Array<{ seq: number; doc_id: number; title: string; score: number; snippet: string }>; user_images?: string[]; user_audio?: string[]; user_files?: Array<{ url: string; name?: string }> };
  attempts?: number; // 已重试次数
  run_after?: string; // queued 可被认领的最早时间（重试退避 / 延迟调度）
  claimed_at?: string; // 最近一次被 worker/executor 原子认领的时间
  lease_until?: string; // 当前认领租约到期时间；到期未续租则可恢复回队列
  executor_id?: string;
  dispatched_at?: string;
  claim_token?: string;
  created_at: string;
  updated_at: string;
}

/** 业务触发请求体 */
export interface RunRequest {
  request_id: string;
  input: string;
  project?: string; // 显式指定项目（与 route 二选一）
  route?: string;   // 触发路由 key（由 bz_routes 配置解析出 project/session/profile）
  profile?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  callback_url?: string;
}

/** 中枢标准主体：业务侧声明“代表谁操作”，中枢归一后只认这个形状。 */
export interface NormalizedPrincipal {
  id: string;
  tenant?: string;
  roles: string[];
  audience?: string;
  channel?: string;
  client_app_id?: string;
}

/** 路由受众策略：决定某个主体能否进入该路由，以及 route=auto 是否可把请求分到这里。 */
export interface AudiencePolicy {
  enabled?: boolean;
  auto?: boolean;
  priority?: number;
  keywords?: string[];
  clients?: string[];
  channels?: string[];
  tenants?: string[];
  roles?: string[];
  principals?: string[];
  audiences?: string[];
  anonymous?: boolean;
}

export type TraceStage =
  | 'launch'
  | 'context'
  | 'execution'
  | 'tool'
  | 'approval'
  | 'delivery'
  | 'summary'
  | 'recovery'
  | 'channel'
  | 'config'
  | 'system';

export type TraceSeverity = 'info' | 'warning' | 'error';

export interface AuditEntry {
  ts: string;
  job_id: string;
  request_id: string;
  event: string;
  stage?: TraceStage;
  severity?: TraceSeverity;
  title?: string;
  summary?: string;
  detail: Record<string, unknown>;
}

// ---- web 后台管理的配置（DB 驱动，非文件写死）----

/** 项目目录注册（哪个项目名 → Mac 上哪个绝对目录） */
export interface ProjectReg {
  name: string;
  path: string;
  enabled: boolean;
  description?: string;
}

/** 接入方：业务系统的凭证与策略（开放接入模型，每方一把可吊销的钥匙） */
export interface Client {
  app_id: string;
  name: string;
  token: string;
  allowed_routes: string[]; // 路由白名单（触发 /run），['*'] = 全部
  allowed_channels: string[]; // 主动出站渠道白名单（POST /send），['*'] = 全部，空 = 禁止（fail-closed）
  rate_limit_per_min: number; // 0 = 不限
  budget?: Record<string, unknown>; // 成本预算闸：{window/window_hours, hard_cost_usd?, hard_tokens?, ...}
  enabled: boolean;
  description?: string;
  last_used_at?: string;
}

/** 模型凭证（后台可配，不硬编码）：llm 对话与知识库 embedding 共用，按名引用。key 入库不回显。 */
export interface Credential {
  name: string;
  kind: 'chat' | 'embedding' | 'both';
  base_url: string; // OpenAI 兼容接口前缀
  api_key: string;
  default_model?: string;
  enabled: boolean;
  description?: string;
  last_used_at?: string;
}

/** 知识库（图书馆）：embedding 模型跟库走——建库定模型，检索必须同模型同坐标系 */
export interface KbBase {
  kb_id: string;
  name: string;
  credential: string; // embedding 凭证名
  model: string;
  dim: number;
  enabled: boolean;
  description?: string;
  writers?: string[]; // 可写接入方 app_id 白名单（入库插座：空 = 仅控制台可写）
}

export interface KbDoc {
  doc_id: number;
  kb_id: string;
  source_key?: string; // 外部源幂等键（接入方推送/连接器同步；控制台手工添加为空）
  title: string;
  status: 'embedding' | 'ready' | 'error';
  error?: string;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

/** 知识库数据源连接器（拉取式入库）：连接 + 取数 SQL + 字段映射，定时拉业务库渲染成文档。 */
export interface KbDatasource {
  ds_id: number;
  kb_id: string;
  name: string;
  db_host: string;
  db_port: number;
  db_user: string;
  db_password: string;
  db_database: string;
  query_sql: string;        // 只读硬校验的单条 SELECT
  key_field: string;        // 幂等键字段（source_key = ds{ds_id}:{该字段值}）
  title_field: string;
  content_template: string; // ${字段} 占位渲染 markdown
  interval_min: number;     // 0 = 仅手动
  enabled: boolean;
  last_sync_at?: string;
  last_status?: string;     // running / ok / error
  last_error?: string;
  last_stats?: { rows: number; upserted: number; skipped: number; deleted: number; errors: number; ms: number };
}

export type SessionPolicy = 'new' | 'fixed' | 'per_key' | 'passthrough';

/** 发给哪个 AI/通道（插座化后为开放集合：bz_targets 注册即合法，这里只约束字符串） */
export type TargetKind = string;

/** 调度目标定义（插座板的一个插孔）。inhub=中枢进程内适配器执行；executor=远端执行器拉取认领。 */
export interface TargetDef {
  name: string;
  kind: 'inhub' | 'executor';
  stateless: boolean;      // 无状态大脑：派活时必从总账装配上下文
  needs_project: boolean;  // 需要 project（代码目录）
  timeout_ms: number;      // inhub 执行超时；0=默认
  enabled: boolean;
  description?: string;
}

/** 执行器接入令牌：执行器通道(claim/result)的专用鉴权凭证，按 target 白名单授权、可吊销、可审计——取代共享管理员 token。 */
export interface ExecutorToken {
  name: string;               // 人可读标识
  token: string;              // 实际令牌（出列表时掩码）
  allowed_targets: string[];  // 可认领的 target 白名单（["*"]=全部）
  enabled: boolean;
  last_seen_at?: string | null;
  description?: string;
}

/** 执行器自报能力（随 claim/心跳上报）：让中枢看得见每台执行器能跑什么，并校验路由的 (target,profile) 覆盖度。
 * 全部可选——执行器是异构的（CLI agent / workflow / 自研智能体），报多少由各执行器自己决定，中枢只存不强求。 */
export interface ExecutorCapabilities {
  profiles?: string[];        // 该执行器能处理的「能力档(profile)」名——用于校验路由 profile 覆盖度；无此概念的执行器可省略
  runtime?: string;           // 自报「这是什么智能体/引擎」的自由字符串（如 "codex-cli" / "my-agent" / 自研名）；可省略
  labels?: string[];          // 部署方自定义标签（可选，便于人识别这台机器的角色）
}

/** 触发路由：某业务场景 → 发给哪个 target / 哪个项目 / 哪个会话策略 / 哪个能力档 */
export interface Route {
  route_key: string;
  name: string;
  enabled: boolean;
  target: TargetKind;                       // 发给哪个 AI/通道
  // target 专属参数。llm: { credential, model, system_prompt, temperature?,
  //   input?:{ image?, audio?, file?, video? } }
  //   —— input 段把图片、语音、文件等素材理解从编排大脑中解耦，见 docs/TOOLS_DESIGN.md「多模态输入层」。
  target_config: Record<string, unknown>;
  project?: string;                         // 注册表标 needs_project 的目标需要（如本地代码类执行器）
  profile: string;
  // 权限档：'readonly'|'readwrite'|'full'（只读/可写/全开）。派发时中枢据此给任务正文前置一段【权限】提示词
  // 指导执行器——是"提示词指导"非硬沙箱，执行器是否遵守由其自身决定，中枢不保证强制。空/缺省=不加限制。
  // 与 profile（角色/技能档，后续并入云端 skill）正交：profile 管"怎么干活/什么角色"，permission 管"允许动多少东西"。
  permission?: string;
  session_policy: SessionPolicy;
  session_fixed_id?: string;   // policy=fixed 时固定续聊的会话 id
  session_key_field?: string;  // policy=per_key 时取 metadata 的哪个字段做会话键
  default_callback_url?: string;
  delivery?: Record<string, unknown>; // ⑤送达层：{type:'webhook'|'channel'|<自定义X>, ...}；webhook 内置签名直发，channel 内置经 channelSend 直推 delivery.channel 的收件人（to_field/to），其余类型 X 由注册的 X-notify 执行器目标承接
  knowledge?: Record<string, unknown>; // 知识注入：{kb_id, top_k?, min_score?}，派发前检索注入【知识参考】（故障可降级）
  retry?: Record<string, unknown>;    // 重试策略：{max, backoff_ms}，只对瞬时失败生效
  tools?: Record<string, unknown>;    // 工具治理层：{sources:[{provider,allow[],subject_field?,retrieval?}],max_calls?,builtin:{send_message:{channels[]}},approval:{type,url?}}，见 docs/TOOLS_DESIGN.md
  audience?: AudiencePolicy;          // 身份/Audience 策略：谁能进本路由，route=auto 如何把意图分到本路由
  memory?: Record<string, unknown>;   // 记忆层：{recent_messages, recent_budget_chars, summary_enabled, summary_trigger_chars, summary_keep_recent, summary_model, ...}，见 src/core/runtime/memory.ts
  budget?: Record<string, unknown>;   // 成本预算闸：{window/window_hours, hard_cost_usd?, hard_tokens?, ...}
  description?: string;
}

/** 聊天入口：网页聊天组件的公开插座。entry_key 可公开（页面源码可见），防滥用靠 Origin 白名单+IP 限速+可停用。绑路由不绑大脑。 */
export interface ChatEntry {
  entry_key: string;
  name: string;
  route_key: string;
  enabled: boolean;
  allowed_origins: string[];   // 空数组 = 不限
  rate_limit_per_min: number;  // 按访客 IP
  ticket_client?: string;      // 签发访客票据的接入方 app_id（空=不启用票据，纯匿名）
  bucket?: string;             // 关联的媒体存储登记名；留空走内置本地存储；落盘/落桶 URL 永久供追溯、多模态输入和业务接口入参
  title?: string;
  greeting?: string;
  color?: string;
  appearance?: ChatAppearance;  // 外观（窗口尺寸/标题对齐/气泡位置偏移/头像/自定义气泡图标/AI 提示）；缺省走组件内置默认
  description?: string;
}

/** 聊天组件外观：全可选，缺省走 widget.js 内置默认值。落 bz_chat_entries.appearance(JSON)。 */
export interface ChatAppearance {
  width?: number;             // 展开面板宽度 px（默认 400，受视口封顶）
  height?: number;            // 展开面板高度 px（默认 600，受视口封顶）
  title_align?: 'center' | 'left';  // 标题对齐（默认 center）
  position?: 'right' | 'left';      // 气泡/面板贴哪个下角（默认 right）
  offset_x?: number;          // 距所贴侧边的水平距离 px（默认 24）
  offset_y?: number;          // 距底部的垂直距离 px（默认 24）
  avatar?: string;            // 头部 Logo/客服头像 URL（空=不显示）
  launcher_icon?: string;     // 自定义气泡图标 URL（空=用内置对话气泡图标）
  resizable?: boolean;        // 允许访客拖面板边框改宽高（默认 false；桌面端生效，手机端全屏忽略；尺寸按访客本地持久化，夹到 width/height 同上下限）
  ai_notice?: boolean;        // AI 内容提示（默认 true）：每条 AI 回复下方展示提示，复制时附带提示；关闭则两处都不加
}

/** 媒体存储登记：聊天上传的图片/语音/附件落盘或落桶取永久 URL。local 开箱即用；业务桶=业务 CDN、加商品零转存。secret_key 不回显。 */
export interface StorageBucket {
  name: string;
  kind: 'local' | 'cos' | 'oss' | 's3'; // 当前实现 local/cos
  region: string;              // ap-shanghai
  bucket: string;              // 桶名（COS 带 appid 后缀）
  endpoint?: string;           // 自定义 endpoint；留空按 kind+region 拼
  access_key: string;          // SecretId / AccessKeyId
  secret_key: string;          // SecretKey（不回显）
  public_base_url: string;     // 拼最终 URL 的公开域名前缀（无尾斜杠）
  path_prefix: string;         // 写入对象键前缀，如 bailing/chat
  enabled: boolean;
  description?: string;
}

/** 入站消息渠道（通用）：外部平台消息进中枢的前门，后台可配。kind 区分平台，config 放平台专属参数，
 *  route_key 把"消息进来"与"谁来处理"解耦。name = 回调 URL 路径段（企微回调=/wecom/<name>）。
 *  wecom 的 config: { corpid?, token, aes_key, agentid?, secret?, reply_wait_ms? }（corpid 可空，运行时从消息自动识别）。 */
export interface Channel {
  name: string;
  kind: 'wecom' | string;            // 当前实现 wecom；未来 feishu 等加对应 handler
  route_key: string;                 // 绑定的路由（大脑）
  config: Record<string, unknown>;   // 平台专属配置（含密钥，API 层掩码）
  enabled: boolean;
  description?: string;
}

/** 告警通知规则：系统告警(executor_offline/queue_backlog/error_burst/spec_change…)「通知谁/什么事/走哪个渠道」可配，落 bz_alert_rules。
 *  经通用出站原语 channelSend(渠道,收件人,正文) 推送，复用 bz_channels 凭证；event_prefix 按告警 key 前缀匹配（''=全部）。 */
export interface AlertRule {
  id: number;
  event_prefix: string;        // 告警 key 前缀；''=全部
  channel: string;             // bz_channels.name（出站渠道）
  recipients: string[];        // 渠道原生收件人 id（如企微 userid）
  cooldown_min: number;        // 同一事件 key 冷却分钟
  enabled: boolean;
  description?: string;
}

/** 聊天回答评价（一答一评，重评覆盖）：知识库运营的最小反馈闭环。note 表示仅提交文字反馈。 */
export interface JobRating {
  job_id: string;
  entry_key: string;
  visitor_id: string;
  rating: 'up' | 'down' | 'note';
  comment?: string;
  created_at: string;
  updated_at: string;
}

/** 工具调用审批单（确认车道，B 方案）：批准锁定"那个具体调用快照"，job+tool+args_hash 精确匹配后一次性消费。 */
export interface ToolApproval {
  id: number;
  job_id: string;
  request_id: string;
  provider: string;
  tool: string;
  scope: string;
  risk: string;
  policy?: string;
  reason?: string;
  method?: string;
  path?: string;
  summary?: string;
  args_json?: string;
  args_hash: string;
  intent_json?: string;
  intent?: Record<string, unknown>;
  on_behalf_of?: string;
  status: 'pending' | 'approved' | 'denied';
  decision_id?: string;
  decided_by?: string;
  decision_comment?: string;
  decided_at?: string;
  used_at?: string;
  created_at: string;
}

/** 工具源：业务系统的 Agent 可调接口清单（OpenAPI + x-agent-capability 契约）。secret 用于 v2 调用签名，不回显。 */
export interface ToolProvider {
  name: string;
  base_url: string;
  spec_source: 'url' | 'inline';
  spec_url?: string;
  spec_json?: string;
  spec_refreshed_at?: string;
  authz_probe?: {
    status: 'pass' | 'suspect' | 'inconclusive' | 'skipped';
    http?: number;
    tool?: string;
    requires_subject?: boolean;
    reason?: string;
    at: string;
  };
  secret: string;
  log_payload: boolean;
  timeout_ms: number;
  rate_limit_per_min: number;
  auto_refresh_min: number; // 自动刷新间隔（分钟）；0=关闭，仅 spec_source=url 生效
  enabled: boolean;
  description?: string;
  // 工具语义检索（工具 RAG）的 embedding 坐标系：按名引用 bz_credentials（kind embedding/both），无硬编码默认。
  // 三者齐备且工具数 > 内联阈值时启用检索（派发时按用户问题召回相关工具内联）；空 = 不开检索，退回目录+find_tools。
  // 坐标系（模型/维度）跟索引锁定：改它 = 整源重算（reindexProvider 检测到不一致会整源重建）。
  embed_credential?: string;
  embed_model?: string;
  embed_dim?: number;
}
