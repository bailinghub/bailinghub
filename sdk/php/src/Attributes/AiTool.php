<?php

declare(strict_types=1);

namespace Bailing\Connect\Attributes;

use Attribute;

/**
 * 把一个控制器方法声明为 Agent 可调工具（字段遵循 ACC，接入约定见百灵中枢 CONTRACT.md §2.4a）。
 *
 * 字段按"宁可全不可缺"原则一次定稿——按本注解标注的接口无需回头补字段；
 * 中枢对不认识的字段一律忽略（前向兼容），可放心全量标注。
 *
 * 示例：
 *   #[AiTool(
 *       description: '查询门店员工列表',
 *       scope: 'tenant.staff.read',
 *       path: '/opentenantapi/staff/list',
 *       whenToUse: '用户问员工、排班、人事相关问题时',
 *       returns: '{code:1, data:[{id,name,role,dept}]}',
 *       examples: [['dept' => '前厅']],
 *   )]
 *   #[AiParam('dept', description: '按部门过滤，如 前厅')]
 *   public function list() { ... }
 */
#[Attribute(Attribute::TARGET_METHOD)]
final class AiTool
{
    public function __construct(
        /** 工具一句话说明（必填）——AI 判断何时调用的首要依据，务必写人话 */
        public string $description,
        /** 权限标识（必填），如 tenant.staff.read；中枢路由白名单按它放行（支持前缀通配） */
        public string $scope,
        /** 接口路径（必填），如 /opentenantapi/staff/list——中枢调用时拼在 base_url 后 */
        public string $path,
        /** HTTP 方法，默认 GET */
        public string $method = 'GET',
        /** 工具名（operationId），缺省 = 蛇形(类名去Controller)_蛇形(方法名)，如 StaffController::list → staff_list。建议显式指定；定了就别改：改名会让 AI 认为这是另一个新工具 */
        public ?string $name = null,
        /** 风险级：low（默认，直接放行）/ medium（放行留痕）/ high（先进人工审批） */
        public string $risk = 'low',
        /** true = 不论风险级一律先人工审批（批准后任务自动重跑执行） */
        public bool $confirm = false,
        /** 参数级确认规则，如 [['param' => 'amount', 'op' => '>', 'value' => 500, 'label' => '大额退款需确认']] */
        public array $confirmWhen = [],
        /** 语义只读声明：GET 默认只读；POST 实现的查询接口务必标 true，AI 才敢放心调用 */
        public ?bool $readonly = null,
        /** true = 必须有操作主体（X-Bailing-On-Behalf-Of）才有意义；匿名任务（网页访客）直接看不到该工具 */
        public bool $requiresSubject = false,
        /** 可安全重试（GET 默认 true）；网络抖动时大脑可凭此决定是否自动重发 */
        public ?bool $idempotent = null,
        /** true = 参数含敏感数据（手机号/身份证等）：中枢审计只记参数键名不记值 */
        public bool $sensitive = false,
        /** 单工具限流，如 "30/min"、"600/hour"，中枢侧执行 */
        public ?string $rateLimit = null,
        /** 慢接口（报表等）单独覆盖超时（1~600000 毫秒），缺省用工具源超时 */
        public ?int $timeoutMs = null,
        /** 何时该用/不该用的补充提示（拼进工具描述），如 "问工资别用本工具，走 salary_query" */
        public ?string $whenToUse = null,
        /** 返回结构的人话说明（拼进工具描述），如 "返回 {code, data: 员工数组}" */
        public ?string $returns = null,
        /** 示例参数数组（如 [['dept' => '前厅']]），首例拼进工具描述做示范 */
        public array $examples = [],
        /** 审批通知的人话模板，{参数名} 占位，如 "AI 申请删除员工 #{id}"——审批人不用读 JSON */
        public ?string $confirmPrompt = null,
        /** 业务自定义字符串数组，中枢原样透传——注册表没有的私有标记放这里（扩展阀门） */
        public array $context = [],
        /** 分组标签（控制台工具清单导航用，预留） */
        public array $tags = [],
        /** true = 弃用：不再暴露给 Agent；接口本身是否继续服务由业务侧决定 */
        public bool $deprecated = false,
    ) {
    }
}
