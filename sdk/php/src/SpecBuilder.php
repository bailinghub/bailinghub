<?php

declare(strict_types=1);

namespace Bailing\Connect;

use Bailing\Connect\Attributes\AiParam;
use Bailing\Connect\Attributes\AiTool;
use InvalidArgumentException;
use ReflectionClass;
use ReflectionMethod;

/**
 * 反射扫描 #[AiTool] 注解 → 构建带 x-agent-capability 的 OpenAPI 3.0 spec。
 *
 * 设计原则：**会被中枢跳过/误用的问题在构建期报错**，而不是发布后才在控制台
 * 「工具清单·被跳过」里发现——CI 跑构建即完成体检。
 *
 * 用法：
 *   $spec = (new SpecBuilder(title: '某某业务系统'))
 *       ->addClass(StaffController::class)
 *       ->addClass(OrderController::class)
 *       ->build();
 */
final class SpecBuilder
{
    /** @var array<class-string> */
    private array $classes = [];

    /** @var string[] 构建期警告（不阻塞构建；CI 里打到 stderr 提醒整改） */
    private array $warnings = [];

    /** @var array{method:string,path:string}|null */
    private ?array $authzProbe = null;

    public function __construct(
        private readonly string $title = '业务系统',
        private readonly string $version = '1.0.0',
    ) {
    }

    /** @return string[] 最近一次 build() 产生的警告 */
    public function warnings(): array
    {
        return $this->warnings;
    }

    /** 登记一个含 #[AiTool] 方法的类（通常是控制器）。 */
    public function addClass(string $class): static
    {
        if (!class_exists($class)) {
            throw new InvalidArgumentException("类不存在：{$class}");
        }
        $this->classes[] = $class;
        return $this;
    }

    /**
     * 声明独立授权探针端点。中枢刷新工具源时会用不存在的主体探测业务侧授权闸是否 fail-closed。
     */
    public function authzProbe(string $path = '/.well-known/bailing/authz-probe', string $method = 'POST'): static
    {
        $method = strtoupper(trim($method));
        if (!in_array($method, ['GET', 'POST'], true)) {
            throw new InvalidArgumentException("authzProbe method 仅支持 GET/POST，收到 {$method}");
        }
        if (!str_starts_with($path, '/')) {
            throw new InvalidArgumentException("authzProbe path 必须以 / 开头，收到 {$path}");
        }
        $this->authzProbe = ['method' => $method, 'path' => $path];
        return $this;
    }

    /** @return array<string, mixed> openapi 数组 */
    public function build(): array
    {
        $this->warnings = [];
        $paths = [];
        $seenNames = [];   // operationId 去重
        $seenRoutes = [];  // method+path 去重

        foreach ($this->classes as $class) {
            $ref = new ReflectionClass($class);
            foreach ($ref->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
                $toolAttrs = $m->getAttributes(AiTool::class);
                if (!$toolAttrs) {
                    continue;
                }
                /** @var AiTool $t */
                $t = $toolAttrs[0]->newInstance();
                $where = "{$class}::{$m->getName()}()";

                // ---- 构建期体检（中枢派生规则的前移）----
                $method = strtoupper(trim($t->method));
                if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true)) {
                    throw new InvalidArgumentException("{$where}: method 仅支持 GET/POST/PUT/PATCH/DELETE，收到 {$t->method}");
                }
                if (!str_starts_with($t->path, '/')) {
                    throw new InvalidArgumentException("{$where}: path 必须以 / 开头，收到 {$t->path}");
                }
                if (trim($t->scope) === '') {
                    throw new InvalidArgumentException("{$where}: scope 不能为空（中枢会直接跳过该接口）");
                }
                if (!in_array($t->risk, ['low', 'medium', 'high'], true)) {
                    throw new InvalidArgumentException("{$where}: risk 仅支持 low/medium/high，收到 {$t->risk}");
                }
                if ($t->rateLimit !== null && self::parseRateLimit($t->rateLimit) === null) {
                    throw new InvalidArgumentException("{$where}: rateLimit 格式应为 \"30/min\"、\"600/hour\"、\"10/s\" 或 \"1000/day\"，收到 {$t->rateLimit}");
                }
                if ($t->timeoutMs !== null && ($t->timeoutMs < 1 || $t->timeoutMs > 600000)) {
                    throw new InvalidArgumentException("{$where}: timeoutMs 取值 1~600000，收到 {$t->timeoutMs}");
                }
                // 弱校验：工具多时中枢走渐进披露，目录阶段 AI 只看到 description 第一句——首句必须自含语义
                $firstSentence = explode('。', $t->description)[0];
                if (mb_strlen(trim($firstSentence)) < 6) {
                    $this->warnings[] = "{$where}: description 首句过短（\"{$firstSentence}\"）——工具目录阶段 AI 只看到这一句，请写自含语义的完整说明（如\"查询门店员工列表\"）";
                }

                // 默认工具名 = 蛇形(类名去 Controller) + 蛇形(方法名)：StaffController::list → staff_list。
                // 裸方法名（list/delete）对 AI 是无上下文的烂名字；显式 name 仍是最佳实践（定了就别改）。
                $name = $t->name ?? self::snake(preg_replace('/Controller$/', '', $ref->getShortName()) ?? '') . '_' . self::snake($m->getName());
                if (isset($seenNames[$name])) {
                    throw new InvalidArgumentException("{$where}: 工具名 {$name} 与 {$seenNames[$name]} 重复（operationId 必须唯一）");
                }
                $seenNames[$name] = $where;
                $routeKey = "{$method} {$t->path}";
                if (isset($seenRoutes[$routeKey])) {
                    throw new InvalidArgumentException("{$where}: {$routeKey} 与 {$seenRoutes[$routeKey]} 重复");
                }
                $seenRoutes[$routeKey] = $where;

                // ---- 参数 ----
                $params = array_map(
                    static fn ($a) => $a->newInstance(),
                    $m->getAttributes(AiParam::class),
                );
                if ($method !== 'GET' && !$params && !$t->deprecated) {
                    throw new InvalidArgumentException(
                        "{$where}: 写接口（{$method}）必须用 #[AiParam] 声明至少一个参数——中枢不暴露无参数 schema 的写接口（防 AI 瞎猜参数）"
                    );
                }

                $op = $this->buildOperation($t, $name, $method, $params, $where);
                $paths[$t->path][strtolower($method)] = $op;
            }
        }

        if (!$paths) {
            throw new InvalidArgumentException('没有发现任何 #[AiTool] 注解：请确认 addClass 的类里有公开方法标注了 AiTool');
        }

        $spec = [
            'openapi' => '3.0.0',
            'info' => ['title' => $this->title, 'version' => $this->version],
            'paths' => $paths,
        ];
        if ($this->authzProbe !== null) {
            $spec['x-bailing-authz-probe'] = $this->authzProbe;
        }
        return $spec;
    }

    /** build() 的 JSON 形态（发布到 /.well-known/bailing/tools.json 的就是它）。 */
    public function buildJson(bool $pretty = true): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | ($pretty ? JSON_PRETTY_PRINT : 0);
        return json_encode($this->build(), $flags) ?: '{}';
    }

    /** 驼峰/帕斯卡 → 蛇形：DemoStaff → demo_staff、memberQuery → member_query */
    private static function snake(string $s): string
    {
        return strtolower(preg_replace('/(?<!^)[A-Z]/', '_$0', $s) ?? $s);
    }

    /** @return array{count:int,window:string}|null */
    private static function parseRateLimit(?string $value): ?array
    {
        if ($value === null) {
            return null;
        }
        $text = strtolower(preg_replace('/\s+/', '', $value) ?? '');
        if (!preg_match('#^(\d+)/(s|sec|second|min|minute|h|hour|d|day)$#', $text, $m)) {
            return null;
        }
        $unit = $m[2];
        $window = match ($unit) {
            's', 'sec', 'second' => '1s',
            'h', 'hour' => '1h',
            'd', 'day' => '1d',
            default => '1m',
        };
        return ['count' => (int) $m[1], 'window' => $window];
    }

    /** @return array<string,mixed> */
    private function buildCapability(AiTool $t, string $method): array
    {
        $capability = ['version' => 1, 'enabled' => true, 'scope' => $t->scope];
        if ($t->risk !== 'low') {
            $capability['risk'] = ['level' => $t->risk];
        }
        if ($t->confirm || $t->confirmWhen || $t->confirmPrompt !== null) {
            $approval = [];
            if ($t->confirm) {
                $approval['required'] = true;
            }
            if ($t->confirmWhen) {
                $approval['when'] = $t->confirmWhen;
            }
            if ($t->confirmPrompt !== null) {
                $approval['prompt'] = $t->confirmPrompt;
            }
            $capability['approval'] = $approval;
        }
        if ($t->requiresSubject) {
            $capability['subject'] = ['required' => true];
        }
        $execution = [];
        if (($t->readonly ?? ($method === 'GET')) && $method !== 'GET') {
            $execution['readonly'] = true;
        }
        if (($t->idempotent ?? ($method === 'GET')) && $method !== 'GET') {
            $execution['idempotent'] = true;
        }
        $rateLimit = self::parseRateLimit($t->rateLimit);
        if ($rateLimit !== null) {
            $execution['rate_limit'] = $rateLimit;
        }
        if ($t->timeoutMs !== null) {
            $execution['timeout_ms'] = $t->timeoutMs;
        }
        if ($execution) {
            $capability['execution'] = $execution;
        }
        if ($t->sensitive) {
            $capability['audit'] = ['sensitive' => true];
        }
        $guidance = [];
        if ($t->whenToUse !== null) {
            $guidance['when_to_use'] = $t->whenToUse;
        }
        if ($t->returns !== null) {
            $guidance['returns'] = $t->returns;
        }
        if ($t->examples) {
            $guidance['examples'] = $t->examples;
        }
        if ($t->context) {
            $guidance['context'] = array_values(array_map('strval', $t->context));
        }
        if ($guidance) {
            $capability['guidance'] = $guidance;
        }
        return $capability;
    }

    /** @param AiParam[] $params */
    private function buildOperation(AiTool $t, string $name, string $method, array $params, string $where): array
    {
        $op = [
            'operationId' => $name,
            'summary' => $t->description,
            'x-agent-capability' => $this->buildCapability($t, $method),
        ];
        // 非核心 OpenAPI 字段才继续落到 operation 顶层；治理字段统一放入 ACC。
        if ($t->tags) {
            $op['tags'] = array_values(array_map('strval', $t->tags));
        }
        if ($t->deprecated) {
            $op['deprecated'] = true;
        }

        // 参数分流：query 进 parameters、body 聚合成 requestBody schema
        $queryParams = [];
        $bodyProps = [];
        $bodyRequired = [];
        foreach ($params as $p) {
            if (!in_array($p->type, ['string', 'integer', 'number', 'boolean', 'array'], true)) {
                throw new InvalidArgumentException("{$where}: 参数 {$p->name} type 仅支持 string/integer/number/boolean/array，收到 {$p->type}");
            }
            $schema = ['type' => $p->type];
            if ($p->description !== '') {
                $schema['description'] = $p->description;
            }
            if ($p->enum !== null) {
                $schema['enum'] = array_values($p->enum);
            }
            if ($p->default !== null) {
                $schema['default'] = $p->default;
            }
            if ($p->format !== null) {
                $schema['format'] = $p->format;
            }
            if ($p->type === 'array') {
                $schema['items'] = ['type' => $p->itemsType ?? 'string'];
            }
            $in = $p->in ?? ($method === 'GET' ? 'query' : 'body');
            if (!in_array($in, ['query', 'body'], true)) {
                throw new InvalidArgumentException("{$where}: 参数 {$p->name} in 仅支持 query/body，收到 {$in}");
            }
            if ($in === 'query') {
                $queryParams[] = [
                    'name' => $p->name,
                    'in' => 'query',
                    'required' => $p->required,
                    'schema' => $schema,
                ];
            } else {
                $bodyProps[$p->name] = $schema;
                if ($p->required) {
                    $bodyRequired[] = $p->name;
                }
            }
        }
        if ($queryParams) {
            $op['parameters'] = $queryParams;
        }
        if ($bodyProps) {
            $op['requestBody'] = ['content' => ['application/json' => ['schema' => [
                'type' => 'object',
                'properties' => $bodyProps,
                ...($bodyRequired ? ['required' => $bodyRequired] : []),
            ]]]];
        }
        return $op;
    }
}
