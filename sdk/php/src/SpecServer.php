<?php

declare(strict_types=1);

namespace Bailing\Connect;

/**
 * spec 发布端：把 SpecBuilder 的产物挂到约定路径 `/.well-known/bailing/tools.json`。
 *
 * 两种姿势：
 *  - 框架路由里：`[$status, $body] = SpecServer::handle($spec, $secret, $method, $uri, $headers);`
 *  - 裸 PHP 单文件：`SpecServer::respond($spec, $secret);`（直接输出并退出）
 *
 * $secret 传中枢「工具源」登记的同一把签名密钥时，本端点只对中枢开放
 * （中枢拉取 spec 的 GET 请求带 sha256= 签名，空体/空主体/空任务参与签名）。
 * 公开发布请优先调用 handlePublic()/respondPublic() 明确表达意图；旧的 null 传法继续兼容。
 *
 * 缓存：传 $cacheFile 时优先读缓存文件（CI 部署后跑 build-spec.php 落盘），
 * 不传则每次请求实时反射构建（几百个接口也只是毫秒级，多数业务无需缓存）。
 */
final class SpecServer
{
    /**
     * 纯函数处理（方便接入任意框架）。
     *
     * @param SpecBuilder|array<string,mixed>|string $spec    构建器 / openapi 数组 / 现成 JSON 串
     * @param array<string,string>                   $headers 请求头（键不区分大小写）
     * @return array{0:int, 1:string} [HTTP 状态码, JSON 响应体]
     */
    public static function handle(
        SpecBuilder|array|string $spec,
        ?string $secret,
        string $method,
        string $pathWithQuery,
        array $headers,
        ?string $cacheFile = null,
    ): array {
        if (strtoupper($method) !== 'GET') {
            return [405, '{"error":"method not allowed"}'];
        }
        if ($secret !== null) {
            $h = array_change_key_case($headers, CASE_LOWER);
            $reason = Verify::failureReason(
                $secret,
                $method,
                $pathWithQuery,
                '',
                $h['x-bailing-timestamp'] ?? '',
                $h['x-bailing-signature'] ?? '',
            );
            if ($reason !== null) {
                // 区分时钟偏移与签名错：接入期联调头号坑是服务器没对时（不泄密，机制在公开契约里）
                return [401, json_encode(['error' => 'bad signature', 'reason' => $reason]) ?: '{"error":"bad signature"}'];
            }
        }
        if ($cacheFile !== null && is_file($cacheFile)) {
            // 注意：缓存优先——改注解后忘了重新生成缓存文件 = 一直发旧 spec
            return [200, file_get_contents($cacheFile) ?: '{}'];
        }
        try {
            $json = match (true) {
                $spec instanceof SpecBuilder => $spec->buildJson(),
                is_array($spec) => json_encode($spec, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) ?: '{}',
                default => $spec,
            };
        } catch (\Throwable $e) {
            // 实时反射模式下注解写错不该裸 500：错误信息回给调用方（中枢拉取失败告警里能直接看到原因）
            return [500, json_encode(['error' => 'spec 构建失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE) ?: '{"error":"spec build failed"}'];
        }
        return [200, $json];
    }

    /**
     * 显式公开发布的纯函数入口。与 handle($spec, null, ...) 等价，但不会把公开暴露藏在一个 null 里。
     *
     * @param SpecBuilder|array<string,mixed>|string $spec
     * @param array<string,string>                   $headers
     * @return array{0:int, 1:string}
     */
    public static function handlePublic(
        SpecBuilder|array|string $spec,
        string $method,
        string $pathWithQuery,
        array $headers = [],
        ?string $cacheFile = null,
    ): array {
        return self::handle($spec, null, $method, $pathWithQuery, $headers, $cacheFile);
    }

    /**
     * HTTP 响应头。框架接入 handle() 时应把返回值写入响应；respond() 会自动写入。
     * 受签名保护的 spec 禁止被浏览器、代理或 CDN 缓存，避免一次合法响应被旁路复用。
     *
     * @return array<string,string>
     */
    public static function responseHeaders(?string $secret): array
    {
        $headers = ['Content-Type' => 'application/json; charset=utf-8'];
        if ($secret !== null) {
            $headers['Cache-Control'] = 'private, no-store';
        }
        return $headers;
    }

    /**
     * 处理独立授权探针。authorize 必须走业务自己的权限表；探针主体默认不存在，正确结果应为 authorized=false。
     *
     * @param callable(string):bool $authorize
     * @param array<string,string>  $headers 请求头（键不区分大小写）
     * @return array{0:int, 1:string}
     */
    public static function authzProbe(
        string $secret,
        callable $authorize,
        string $method,
        string $pathWithQuery,
        string $rawBody,
        array $headers,
    ): array {
        $h = array_change_key_case($headers, CASE_LOWER);
        $operator = (string) ($h['x-bailing-on-behalf-of'] ?? '');
        $jobId = (string) ($h['x-bailing-job-id'] ?? '');
        $reason = Verify::failureReason(
            $secret,
            $method,
            $pathWithQuery,
            $rawBody,
            $h['x-bailing-timestamp'] ?? '',
            $h['x-bailing-signature'] ?? '',
            300,
            $operator,
            $jobId,
        );
        if ($reason !== null) {
            return [401, json_encode(['authorized' => false, 'error' => $reason]) ?: '{"authorized":false}'];
        }
        $body = json_decode($rawBody !== '' ? $rawBody : '{}', true);
        $subject = is_array($body) && array_key_exists('subject', $body) ? (string) $body['subject'] : $operator;
        try {
            $authorized = (bool) $authorize($subject);
        } catch (\Throwable $e) {
            $authorized = false;
        }
        return [200, json_encode(['authorized' => $authorized], JSON_UNESCAPED_UNICODE) ?: '{"authorized":false}'];
    }

    /** 裸 PHP 便捷入口：处理当前请求、输出响应并退出。传 secret 时自动禁止缓存。 */
    public static function respond(SpecBuilder|array|string $spec, ?string $secret = null, ?string $cacheFile = null): never
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(strtr(substr($k, 5), '_', '-'))] = (string) $v;
            }
        }
        [$status, $body] = self::handle(
            $spec,
            $secret,
            $_SERVER['REQUEST_METHOD'] ?? 'GET',
            $_SERVER['REQUEST_URI'] ?? '/',
            $headers,
            $cacheFile,
        );
        http_response_code($status);
        foreach (self::responseHeaders($secret) as $name => $value) {
            header($name . ': ' . $value);
        }
        echo $body;
        exit;
    }

    /** 裸 PHP 显式公开入口。旧的 respond($spec, null, ...) 继续兼容。 */
    public static function respondPublic(SpecBuilder|array|string $spec, ?string $cacheFile = null): never
    {
        self::respond($spec, null, $cacheFile);
    }

    /**
     * 裸 PHP 授权探针入口。$knownPath 适用于框架/网关重写 REQUEST_URI 的场景：路径按 spec 声明值验签，query 沿用当前请求。
     *
     * @param callable(string):bool $authorize
     */
    public static function respondAuthzProbe(string $secret, callable $authorize, ?string $knownPath = null): never
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(strtr(substr($k, 5), '_', '-'))] = (string) $v;
            }
        }
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        if ($knownPath !== null) {
            $query = parse_url($uri, PHP_URL_QUERY);
            $uri = $knownPath . (is_string($query) && $query !== '' ? '?' . $query : '');
        }
        [$status, $body] = self::authzProbe(
            $secret,
            $authorize,
            $_SERVER['REQUEST_METHOD'] ?? 'POST',
            $uri,
            file_get_contents('php://input') ?: '',
            $headers,
        );
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo $body;
        exit;
    }
}
