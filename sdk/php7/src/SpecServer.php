<?php

namespace Bailing\Connect;

/**
 * spec 发布端：把 spec 挂到中枢「工具源」登记的 spec_url 上。PHP 7.3 兼容版。
 *
 * 两种姿势：
 *  - 框架路由里：list($status, $body) = SpecServer::handle($spec, $secret, $method, $uri, $headers);
 *  - 裸 PHP 单文件：SpecServer::respond($spec, $secret);（直接输出并退出）
 *
 * $secret 传中枢「工具源」登记的同一把签名密钥时，本端点只对中枢开放
 * （中枢拉取 spec 的 GET 请求带 sha256= 签名，空体/空主体/空任务参与签名）；传 null 则公开。
 *
 * 缓存：传 $cacheFile 时优先读缓存文件（CI 部署后跑 build-spec.php 落盘），
 * 不传则每次请求实时构建（毫秒级，多数业务无需缓存）。
 */
final class SpecServer
{
    /**
     * 纯函数处理（方便接入任意框架）。
     *
     * @param ToolSpec|array|string $spec    builder / openapi 数组 / 现成 JSON 串
     * @param string|null           $secret  工具源签名密钥；null = 公开
     * @param string                $method
     * @param string                $pathWithQuery
     * @param array                 $headers 请求头（键不区分大小写）
     * @param string|null           $cacheFile
     * @return array  [HTTP 状态码, JSON 响应体]
     */
    public static function handle($spec, $secret, $method, $pathWithQuery, array $headers, $cacheFile = null)
    {
        if (strtoupper($method) !== 'GET') {
            return array(405, '{"error":"method not allowed"}');
        }
        if ($secret !== null) {
            $h = array_change_key_case($headers, CASE_LOWER);
            $reason = Verify::failureReason(
                $secret,
                $method,
                $pathWithQuery,
                '',
                isset($h['x-bailing-timestamp']) ? $h['x-bailing-timestamp'] : '',
                isset($h['x-bailing-signature']) ? $h['x-bailing-signature'] : ''
            );
            if ($reason !== null) {
                // 区分时钟偏移与签名错：接入期联调头号坑是服务器没对时（不泄密，机制在公开契约里）
                $j = json_encode(array('error' => 'bad signature', 'reason' => $reason));
                return array(401, $j !== false ? $j : '{"error":"bad signature"}');
            }
        }
        if ($cacheFile !== null && is_file($cacheFile)) {
            // 注意：缓存优先——改 spec 后忘了重新生成缓存文件 = 一直发旧 spec
            return array(200, file_get_contents($cacheFile) ?: '{}');
        }
        try {
            if ($spec instanceof ToolSpec) {
                $json = $spec->buildJson();
            } elseif (is_array($spec)) {
                $json = json_encode($spec, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                if ($json === false) {
                    $json = '{}';
                }
            } else {
                $json = (string) $spec;
            }
        } catch (\Throwable $e) {
            // 实时构建模式下写错不该裸 500：错误信息回给调用方（中枢拉取失败告警里能直接看到原因）
            $j = json_encode(array('error' => 'spec 构建失败：' . $e->getMessage()), JSON_UNESCAPED_UNICODE);
            return array(500, $j !== false ? $j : '{"error":"spec build failed"}');
        }
        return array(200, $json);
    }

    /**
     * 处理独立授权探针。$authorize 必须走业务自己的权限表；探针主体默认不存在，正确结果应为 authorized=false。
     *
     * @param callable $authorize function (string $subject): bool
     * @return array [HTTP 状态码, JSON 响应体]
     */
    public static function authzProbe($secret, $authorize, $method, $pathWithQuery, $rawBody, array $headers)
    {
        if (!is_callable($authorize)) {
            return array(500, '{"authorized":false,"error":"authorize callback required"}');
        }
        $h = array_change_key_case($headers, CASE_LOWER);
        $operator = isset($h['x-bailing-on-behalf-of']) ? (string) $h['x-bailing-on-behalf-of'] : '';
        $jobId = isset($h['x-bailing-job-id']) ? (string) $h['x-bailing-job-id'] : '';
        $reason = Verify::failureReason(
            $secret,
            $method,
            $pathWithQuery,
            $rawBody,
            isset($h['x-bailing-timestamp']) ? $h['x-bailing-timestamp'] : '',
            isset($h['x-bailing-signature']) ? $h['x-bailing-signature'] : '',
            300,
            $operator,
            $jobId
        );
        if ($reason !== null) {
            $j = json_encode(array('authorized' => false, 'error' => $reason));
            return array(401, $j !== false ? $j : '{"authorized":false}');
        }
        $body = json_decode($rawBody !== '' ? $rawBody : '{}', true);
        $subject = is_array($body) && array_key_exists('subject', $body) ? (string) $body['subject'] : $operator;
        try {
            $authorized = (bool) call_user_func($authorize, $subject);
        } catch (\Throwable $e) {
            $authorized = false;
        }
        $j = json_encode(array('authorized' => $authorized), JSON_UNESCAPED_UNICODE);
        return array(200, $j !== false ? $j : '{"authorized":false}');
    }

    /** 裸 PHP 便捷入口：处理当前请求、输出响应并退出。 */
    public static function respond($spec, $secret = null, $cacheFile = null)
    {
        $headers = array();
        foreach ($_SERVER as $k => $v) {
            if (strpos($k, 'HTTP_') === 0) {
                $headers[strtolower(strtr(substr($k, 5), '_', '-'))] = (string) $v;
            }
        }
        list($status, $body) = self::handle(
            $spec,
            $secret,
            isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET',
            isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/',
            $headers,
            $cacheFile
        );
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo $body;
        exit;
    }

    /**
     * 裸 PHP 授权探针入口。$knownPath 适用于框架/网关重写 REQUEST_URI 的场景：路径按 spec 声明值验签，query 沿用当前请求。
     *
     * @param callable $authorize function (string $subject): bool
     */
    public static function respondAuthzProbe($secret, $authorize, $knownPath = null)
    {
        $headers = array();
        foreach ($_SERVER as $k => $v) {
            if (strpos($k, 'HTTP_') === 0) {
                $headers[strtolower(strtr(substr($k, 5), '_', '-'))] = (string) $v;
            }
        }
        $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
        if ($knownPath !== null) {
            $query = parse_url($uri, PHP_URL_QUERY);
            $uri = $knownPath . (is_string($query) && $query !== '' ? '?' . $query : '');
        }
        list($status, $body) = self::authzProbe(
            $secret,
            $authorize,
            isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'POST',
            $uri,
            file_get_contents('php://input') ?: '',
            $headers
        );
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo $body;
        exit;
    }
}
