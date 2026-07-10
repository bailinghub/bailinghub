<?php

namespace Bailing\Connect;

/**
 * 单个 AI 工具的 fluent 定义（PHP 7.3 builder；产出等价于 8.x 版的 #[AiTool] 注解）。
 * 字段遵循 ACC，接入语义见百灵中枢 CONTRACT.md §2.4a；中枢对不认识的字段一律忽略（前向兼容）。
 *
 * 由 ToolSpec::tool() 创建并通过闭包配置，无需直接 new。
 */
final class ToolDef
{
    /** @var string */
    public $name;
    /** @var string */
    public $method;
    /** @var string */
    public $path;
    /** @var string */
    public $scope;
    /** @var string */
    public $description;
    /** @var array<string,mixed> 可选治理/语义字段 */
    public $opt = array();
    /** @var array<int,array<string,mixed>> 参数定义 */
    public $params = array();

    public function __construct($name, $method, $path, $scope, $description)
    {
        $this->name = $name;
        $this->method = strtoupper(trim((string) $method));
        $this->path = $path;
        $this->scope = $scope;
        $this->description = $description;
    }

    // ---- 治理面 ----
    /** 风险级 low（默认）/ medium（放行留痕）/ high（先进人工审批） */
    public function risk($level)
    {
        $this->opt['risk'] = $level;
        return $this;
    }
    /** 不论风险级一律先人工审批（批准后任务自动重跑）；可选审批通知人话模板，{参数名} 占位 */
    public function confirm($prompt = null)
    {
        $this->opt['confirm'] = true;
        if ($prompt !== null) {
            $this->opt['confirmPrompt'] = $prompt;
        }
        return $this;
    }
    /** 参数级确认规则，如 array(array('param' => 'amount', 'op' => '>', 'value' => 500)) */
    public function confirmWhen(array $list)
    {
        $this->opt['confirmWhen'] = $list;
        return $this;
    }
    /** 必须有操作主体（X-Bailing-On-Behalf-Of）才暴露；匿名网页访客看不到本工具 */
    public function requiresSubject($v = true)
    {
        $this->opt['requiresSubject'] = (bool) $v;
        return $this;
    }
    /** 参数含敏感数据（手机号/身份证等）：中枢审计只记参数键名不记值 */
    public function sensitive($v = true)
    {
        $this->opt['sensitive'] = (bool) $v;
        return $this;
    }
    /** 语义只读声明：POST 实现的查询接口务必标，AI 才敢放心调用（GET 默认即只读） */
    public function readonly($v = true)
    {
        $this->opt['readonly'] = (bool) $v;
        return $this;
    }
    /** 可安全重试（GET 默认 true）：网络抖动时大脑可凭此自动重发 */
    public function idempotent($v = true)
    {
        $this->opt['idempotent'] = (bool) $v;
        return $this;
    }
    /** 单工具限流，如 "30/min"、"600/hour" */
    public function rateLimit($s)
    {
        $this->opt['rateLimit'] = $s;
        return $this;
    }
    /** 慢接口单独覆盖超时（1~600000 毫秒） */
    public function timeoutMs($ms)
    {
        $this->opt['timeoutMs'] = (int) $ms;
        return $this;
    }

    // ---- 语义增强（拼进工具描述，帮 AI 用对）----
    /** 何时该用/不该用的补充提示 */
    public function whenToUse($s)
    {
        $this->opt['whenToUse'] = $s;
        return $this;
    }
    /** 返回结构的人话说明 */
    public function returns($s)
    {
        $this->opt['returns'] = $s;
        return $this;
    }
    /** 示例参数数组（如 [['dept' => '前厅']]），首例拼进描述做示范 */
    public function examples(array $list)
    {
        $this->opt['examples'] = $list;
        return $this;
    }
    /** 业务自定义字符串数组，中枢原样透传（扩展阀门） */
    public function context(array $list)
    {
        $this->opt['context'] = $list;
        return $this;
    }
    /** 分组标签（控制台工具清单导航用） */
    public function tags(array $list)
    {
        $this->opt['tags'] = $list;
        return $this;
    }
    /** 弃用：spec 里保留声明、中枢不再暴露给 AI（平滑下线） */
    public function deprecated($v = true)
    {
        $this->opt['deprecated'] = (bool) $v;
        return $this;
    }

    // ---- 参数 ----
    /**
     * query 参数（GET 默认进 query）。
     * @param array $opts 可带 enum / default / format / itemsType
     */
    public function query($name, $type = 'string', $required = false, $description = '', array $opts = array())
    {
        return $this->param('query', $name, $type, $required, $description, $opts);
    }
    /**
     * body 参数（非 GET 默认进 body）。
     * @param array $opts 可带 enum / default / format / itemsType
     */
    public function body($name, $type = 'string', $required = false, $description = '', array $opts = array())
    {
        return $this->param('body', $name, $type, $required, $description, $opts);
    }

    private function param($in, $name, $type, $required, $description, array $opts)
    {
        $p = array(
            'in' => $in,
            'name' => $name,
            'type' => $type,
            'required' => (bool) $required,
            'description' => (string) $description,
        );
        foreach (array('enum', 'default', 'format', 'itemsType') as $k) {
            if (array_key_exists($k, $opts)) {
                $p[$k] = $opts[$k];
            }
        }
        $this->params[] = $p;
        return $this;
    }
}
