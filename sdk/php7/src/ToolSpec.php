<?php

namespace Bailing\Connect;

use InvalidArgumentException;

/**
 * PHP 7.3 兼容的工具 spec 构建器（fluent builder，无注解无反射）。
 *
 * 与 8.x 注解版（SpecBuilder + #[AiTool]）产出**完全一致**的 OpenAPI spec——
 * 中枢不关心 spec 怎么生成的，只认 spec 内容。PHP 7.3/7.4 项目用这个，无需迁 PHP 版本。
 *
 * 设计原则同 8.x 版：**会被中枢跳过/误用的问题在构建期就报错**，而不是发布后才在控制台发现。
 *
 * 用法：
 *   $spec = ToolSpec::create('示例商城')
 *       ->tool('staff_list', 'GET', '/openapi/staff/list', 'tenant.staff.read', '查询门店员工列表',
 *           function (ToolDef $t) {
 *               $t->query('dept', 'string', false, '按部门过滤');
 *           })
 *       ->tool('staff_delete', 'DELETE', '/openapi/staff/delete', 'tenant.staff.delete', '删除门店员工',
 *           function (ToolDef $t) {
 *               $t->risk('high')->confirm('AI 申请删除员工 #{id}')->requiresSubject();
 *               $t->body('id', 'integer', true, '员工 ID');
 *           })
 *       ->buildJson();
 */
final class ToolSpec
{
    /** @var string */
    private $title;
    /** @var string */
    private $version;
    /** @var ToolDef[] */
    private $tools = array();
    /** @var string[] 构建期警告（不阻塞，CI 里打到 stderr 提醒整改） */
    private $warnings = array();
    /** @var array|null */
    private $authzProbe = null;

    public function __construct($title = '业务系统', $version = '1.0.0')
    {
        $this->title = $title;
        $this->version = $version;
    }

    public static function create($title = '业务系统', $version = '1.0.0')
    {
        return new self($title, $version);
    }

    /**
     * 声明一个工具。$configure 为闭包 function (ToolDef $t)，在其中设可选字段与参数。
     * @param callable|null $configure
     */
    public function tool($name, $method, $path, $scope, $description, $configure = null)
    {
        $def = new ToolDef($name, $method, $path, $scope, $description);
        if ($configure !== null) {
            if (!is_callable($configure)) {
                throw new InvalidArgumentException('tool() 第 6 个参数须为闭包 function (ToolDef $t) {...}');
            }
            call_user_func($configure, $def);
        }
        $this->tools[] = $def;
        return $this;
    }

    /** 声明独立授权探针端点。中枢刷新工具源时会探测业务侧授权闸是否 fail-closed。 */
    public function authzProbe($path = '/.well-known/bailing/authz-probe', $method = 'POST')
    {
        $method = strtoupper(trim((string) $method));
        if (!in_array($method, array('GET', 'POST'), true)) {
            throw new InvalidArgumentException("authzProbe method 仅支持 GET/POST，收到 {$method}");
        }
        if (strpos((string) $path, '/') !== 0) {
            throw new InvalidArgumentException("authzProbe path 必须以 / 开头，收到 {$path}");
        }
        $this->authzProbe = array('method' => $method, 'path' => (string) $path);
        return $this;
    }

    /** @return string[] 最近一次 build() 产生的警告 */
    public function warnings()
    {
        return $this->warnings;
    }

    /** @return array openapi 数组 */
    public function build()
    {
        $this->warnings = array();
        $paths = array();
        $seenNames = array();
        $seenRoutes = array();

        foreach ($this->tools as $d) {
            $where = "工具 {$d->name}";

            // ---- 构建期体检（与中枢派生规则、8.x SpecBuilder 一致）----
            if (!in_array($d->method, array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'), true)) {
                throw new InvalidArgumentException("{$where}: method 仅支持 GET/POST/PUT/PATCH/DELETE，收到 {$d->method}");
            }
            if (strpos((string) $d->path, '/') !== 0) {
                throw new InvalidArgumentException("{$where}: path 必须以 / 开头，收到 {$d->path}");
            }
            if (trim((string) $d->scope) === '') {
                throw new InvalidArgumentException("{$where}: scope 不能为空（中枢会直接跳过该接口）");
            }
            if (trim((string) $d->name) === '') {
                throw new InvalidArgumentException("path {$d->path}: 工具名（第 1 个参数）不能为空");
            }
            $risk = isset($d->opt['risk']) ? $d->opt['risk'] : 'low';
            if (!in_array($risk, array('low', 'medium', 'high'), true)) {
                throw new InvalidArgumentException("{$where}: risk 仅支持 low/medium/high，收到 {$risk}");
            }
            if (isset($d->opt['rateLimit']) && self::parseRateLimit($d->opt['rateLimit']) === null) {
                throw new InvalidArgumentException("{$where}: rateLimit 格式应为 \"30/min\"、\"600/hour\"、\"10/s\" 或 \"1000/day\"，收到 {$d->opt['rateLimit']}");
            }
            if (isset($d->opt['timeoutMs']) && ($d->opt['timeoutMs'] < 1 || $d->opt['timeoutMs'] > 600000)) {
                throw new InvalidArgumentException("{$where}: timeoutMs 取值 1~600000，收到 {$d->opt['timeoutMs']}");
            }
            // 弱校验：工具多时中枢走渐进披露，目录阶段 AI 只看到 description 第一句——首句必须自含语义
            $firstSentence = explode('。', (string) $d->description);
            $firstSentence = $firstSentence[0];
            if (mb_strlen(trim($firstSentence)) < 6) {
                $this->warnings[] = "{$where}: description 首句过短（\"{$firstSentence}\"）——工具目录阶段 AI 只看到这一句，请写自含语义的完整说明（如\"查询门店员工列表\"）";
            }

            if (isset($seenNames[$d->name])) {
                throw new InvalidArgumentException("{$where}: 工具名 {$d->name} 与 {$seenNames[$d->name]} 重复（operationId 必须唯一）");
            }
            $seenNames[$d->name] = $where;
            $routeKey = "{$d->method} {$d->path}";
            if (isset($seenRoutes[$routeKey])) {
                throw new InvalidArgumentException("{$where}: {$routeKey} 与 {$seenRoutes[$routeKey]} 重复");
            }
            $seenRoutes[$routeKey] = $where;

            $isDeprecated = !empty($d->opt['deprecated']);
            if ($d->method !== 'GET' && !$d->params && !$isDeprecated) {
                throw new InvalidArgumentException(
                    "{$where}: 写接口（{$d->method}）必须用 body()/query() 声明至少一个参数——中枢不暴露无参数 schema 的写接口（防 AI 瞎猜参数）"
                );
            }

            $paths[$d->path][strtolower($d->method)] = $this->buildOperation($d, $where);
        }

        if (!$paths) {
            throw new InvalidArgumentException('没有声明任何工具：请用 ->tool(...) 至少声明一个');
        }

        $spec = array(
            'openapi' => '3.0.0',
            'info' => array('title' => $this->title, 'version' => $this->version),
            'paths' => $paths,
        );
        if ($this->authzProbe !== null) {
            $spec['x-bailing-authz-probe'] = $this->authzProbe;
        }
        return $spec;
    }

    /** build() 的 JSON 形态（发布到工具源 spec_url 的就是它）。 */
    public function buildJson($pretty = true)
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | ($pretty ? JSON_PRETTY_PRINT : 0);
        $json = json_encode($this->build(), $flags);
        return $json !== false ? $json : '{}';
    }

    private static function parseRateLimit($value)
    {
        if ($value === null || $value === '') {
            return null;
        }
        $text = strtolower(preg_replace('/\s+/', '', (string) $value));
        if (!preg_match('#^(\d+)/(s|sec|second|min|minute|h|hour|d|day)$#', $text, $m)) {
            return null;
        }
        $unit = $m[2];
        if ($unit === 's' || $unit === 'sec' || $unit === 'second') {
            $window = '1s';
        } elseif ($unit === 'h' || $unit === 'hour') {
            $window = '1h';
        } elseif ($unit === 'd' || $unit === 'day') {
            $window = '1d';
        } else {
            $window = '1m';
        }
        return array('count' => (int) $m[1], 'window' => $window);
    }

    private function buildCapability(ToolDef $d)
    {
        $o = $d->opt;
        $method = $d->method;
        $capability = array('version' => 1, 'enabled' => true, 'scope' => $d->scope);
        $risk = isset($o['risk']) ? $o['risk'] : 'low';
        if ($risk !== 'low') {
            $capability['risk'] = array('level' => $risk);
        }
        if (!empty($o['confirm']) || !empty($o['confirmWhen']) || isset($o['confirmPrompt'])) {
            $approval = array();
            if (!empty($o['confirm'])) {
                $approval['required'] = true;
            }
            if (!empty($o['confirmWhen'])) {
                $approval['when'] = $o['confirmWhen'];
            }
            if (isset($o['confirmPrompt'])) {
                $approval['prompt'] = $o['confirmPrompt'];
            }
            $capability['approval'] = $approval;
        }
        if (!empty($o['requiresSubject'])) {
            $capability['subject'] = array('required' => true);
        }
        $execution = array();
        $readonly = array_key_exists('readonly', $o) ? $o['readonly'] : ($method === 'GET');
        if ($readonly && $method !== 'GET') {
            $execution['readonly'] = true;
        }
        $idempotent = array_key_exists('idempotent', $o) ? $o['idempotent'] : ($method === 'GET');
        if ($idempotent && $method !== 'GET') {
            $execution['idempotent'] = true;
        }
        if (isset($o['rateLimit'])) {
            $rateLimit = self::parseRateLimit($o['rateLimit']);
            if ($rateLimit !== null) {
                $execution['rate_limit'] = $rateLimit;
            }
        }
        if (isset($o['timeoutMs'])) {
            $execution['timeout_ms'] = $o['timeoutMs'];
        }
        if ($execution) {
            $capability['execution'] = $execution;
        }
        if (!empty($o['sensitive'])) {
            $capability['audit'] = array('sensitive' => true);
        }
        $guidance = array();
        if (isset($o['whenToUse'])) {
            $guidance['when_to_use'] = $o['whenToUse'];
        }
        if (isset($o['returns'])) {
            $guidance['returns'] = $o['returns'];
        }
        if (!empty($o['examples'])) {
            $guidance['examples'] = $o['examples'];
        }
        if (!empty($o['context'])) {
            $guidance['context'] = array_values(array_map('strval', $o['context']));
        }
        if ($guidance) {
            $capability['guidance'] = $guidance;
        }
        return $capability;
    }

    private function buildOperation(ToolDef $d, $where)
    {
        $o = $d->opt;
        $method = $d->method;
        $op = array(
            'operationId' => $d->name,
            'summary' => $d->description,
            'x-agent-capability' => $this->buildCapability($d),
        );
        // 非核心 OpenAPI 字段才继续落到 operation 顶层；治理字段统一放入 ACC。
        if (!empty($o['tags'])) {
            $op['tags'] = array_values(array_map('strval', $o['tags']));
        }
        if (!empty($o['deprecated'])) {
            $op['deprecated'] = true;
        }

        // 参数分流：query 进 parameters、body 聚合成 requestBody schema
        $queryParams = array();
        $bodyProps = array();
        $bodyRequired = array();
        foreach ($d->params as $p) {
            if (!in_array($p['type'], array('string', 'integer', 'number', 'boolean', 'array'), true)) {
                throw new InvalidArgumentException("{$where}: 参数 {$p['name']} type 仅支持 string/integer/number/boolean/array，收到 {$p['type']}");
            }
            $schema = array('type' => $p['type']);
            if (isset($p['description']) && $p['description'] !== '') {
                $schema['description'] = $p['description'];
            }
            if (array_key_exists('enum', $p) && $p['enum'] !== null) {
                $schema['enum'] = array_values($p['enum']);
            }
            if (array_key_exists('default', $p) && $p['default'] !== null) {
                $schema['default'] = $p['default'];
            }
            if (array_key_exists('format', $p) && $p['format'] !== null) {
                $schema['format'] = $p['format'];
            }
            if ($p['type'] === 'array') {
                $schema['items'] = array('type' => isset($p['itemsType']) && $p['itemsType'] !== null ? $p['itemsType'] : 'string');
            }
            $in = isset($p['in']) ? $p['in'] : ($method === 'GET' ? 'query' : 'body');
            if (!in_array($in, array('query', 'body'), true)) {
                throw new InvalidArgumentException("{$where}: 参数 {$p['name']} in 仅支持 query/body，收到 {$in}");
            }
            if ($in === 'query') {
                $queryParams[] = array(
                    'name' => $p['name'],
                    'in' => 'query',
                    'required' => $p['required'],
                    'schema' => $schema,
                );
            } else {
                $bodyProps[$p['name']] = $schema;
                if ($p['required']) {
                    $bodyRequired[] = $p['name'];
                }
            }
        }
        if ($queryParams) {
            $op['parameters'] = $queryParams;
        }
        if ($bodyProps) {
            $bodySchema = array('type' => 'object', 'properties' => $bodyProps);
            if ($bodyRequired) {
                $bodySchema['required'] = $bodyRequired;
            }
            $op['requestBody'] = array('content' => array('application/json' => array('schema' => $bodySchema)));
        }
        return $op;
    }
}
