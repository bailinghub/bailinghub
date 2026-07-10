<?php

declare(strict_types=1);

namespace Bailing\Connect;

/**
 * 百灵中枢工具调用验签（CONTRACT.md §2.4b）。签名方案 sha256=（算法名，非版本号）。
 *
 * 职责边界：验签只回答"真是中枢发的吗"；X-Bailing-On-Behalf-Of 是谁、
 * 有没有权限做这件事，由你接着用自己既有的权限体系裁决——
 * AI 调用与人点按钮走同一条裁决路径。
 */
final class Verify
{
    /**
     * 验工具调用签名。任何一步不过都返回 false（调用方应回 401）。
     *
     * @param string $secret        控制台「工具源」登记的签名密钥
     * @param string $method        $_SERVER['REQUEST_METHOD']
     * @param string $pathWithQuery 含 query 的请求路径（ThinkPHP: $request->url()；裸 PHP: $_SERVER['REQUEST_URI']）
     * @param string $rawBody       原始请求体（GET 为空串）：file_get_contents('php://input')
     * @param string $timestamp     X-Bailing-Timestamp 头（unix 秒）
     * @param string $signature     X-Bailing-Signature 头（形如 sha256=abc...）
     */
    public static function toolCall(
        string $secret,
        string $method,
        string $pathWithQuery,
        string $rawBody,
        string $timestamp,
        string $signature,
        int $windowSec = 300,
        string $onBehalfOf = '',
        string $jobId = '',
    ): bool {
        return self::failureReason($secret, $method, $pathWithQuery, $rawBody, $timestamp, $signature, $windowSec, $onBehalfOf, $jobId) === null;
    }

    /**
     * 验签并返回失败原因（null = 通过）。接入期头号坑是服务器时钟偏移——
     * 401 响应里区分 `timestamp_out_of_window` 与 `bad_signature` 能省一半联调时间，
     * 且不泄密（时间窗机制本就写在公开契约里）。记得先给服务器对时（ntp/chrony）。
     *
     * @return null|'timestamp_out_of_window'|'bad_signature'
     */
    public static function failureReason(
        string $secret,
        string $method,
        string $pathWithQuery,
        string $rawBody,
        string $timestamp,
        string $signature,
        int $windowSec = 300,
        string $onBehalfOf = '',
        string $jobId = '',
    ): ?string {
        if (abs(time() - (int) $timestamp) >= $windowSec) {
            return 'timestamp_out_of_window';
        }
        $base = $timestamp . '.' . strtoupper($method) . '.' . $pathWithQuery . '.' . hash('sha256', $rawBody);
        // 签名方案 sha256=（算法名，非版本号；GitHub webhook 同款约定）：材料含 On-Behalf-Of + Job-Id，
        // 把"谁、为哪个任务"钉进 HMAC，杜绝窗口内重放再篡改这两个头换租户/绕幂等（CONTRACT §2.4b）。
        $expect = 'sha256=' . hash_hmac('sha256', $base . '.' . $onBehalfOf . '.' . $jobId, $secret);
        return hash_equals($expect, $signature) ? null : 'bad_signature'; // 恒时比较，防时序侧信道
    }

    /**
     * 裸 PHP 便捷入口：直接验当前请求（从超全局取齐材料）。
     *
     * 中枢签名的 path 段是你 spec 里声明的 operation path（不含工具源 base_url 的路径前缀，见 CONTRACT §2.4b）。
     * - base_url 为纯源站（无路径前缀）时：REQUEST_URI 即等于签名 path，$knownPath 留空即可；
     * - base_url 带路径前缀（如 https://shop.com/openapi），或框架会重写 REQUEST_URI（ThinkPHP pathinfo 等）时：
     *   传 $knownPath = 该端点的 spec path（如 '/goods/create'）——只借用 REQUEST_URI 的 query 段，路径段用你给的
     *   spec path，与 base_url 前缀 / 框架重写彻底解耦（推荐）。
     */
    public static function currentRequest(string $secret, ?string $knownPath = null): bool
    {
        $uri = $_SERVER['REQUEST_URI'] ?? '';
        if ($knownPath !== null) {
            $q = strpos($uri, '?');
            $uri = $knownPath . ($q !== false ? substr($uri, $q) : '');
        }
        return self::toolCall(
            $secret,
            $_SERVER['REQUEST_METHOD'] ?? '',
            $uri,
            file_get_contents('php://input') ?: '',
            $_SERVER['HTTP_X_BAILING_TIMESTAMP'] ?? '',
            $_SERVER['HTTP_X_BAILING_SIGNATURE'] ?? '',
            300,
            // sha256 签名材料：原样取这两个头（中枢签的就是它发的，逐字一致）。
            $_SERVER['HTTP_X_BAILING_ON_BEHALF_OF'] ?? '',
            $_SERVER['HTTP_X_BAILING_JOB_ID'] ?? '',
        );
    }

    /**
     * 工具端点的【推荐】关卡：验签 + 强制授权裁决，一步到位、fail-closed。
     *
     * 为什么不用 currentRequest 然后自己判断权限？因为那会让"授权"沦为可选的、可被忘记/注释掉的一步——
     * 中枢整套安全模型的支柱正是"业务管 authority"。gate() 把 $authorize 做成**必填回调**，不传根本调不了本方法，
     * 从代码层把"这个人此刻能不能做这件事"钉成必填依赖。
     *
     * ⚠️ 切勿写成 `fn() => true`：那等于把授权整个关掉，洞原样还在、还更隐蔽（看起来像实现了）。
     *    回调拿到 ($operator, $tool, $params) 三个入参，就是要你用**既有权限表**真正裁决——
     *    AI 调用与人点按钮必须走同一条裁决路径。盲目返回 true = 在代码上显眼地把这三个参数全扔了。
     *
     * 注意服务器到服务器调用没有用户 session：业务平时基于登录态的鉴权对中枢调用不生效，
     * 所以把 $operator(On-Behalf-Of) 接进你的权限表，是这条链路【唯一】的授权闸，不接 = 认证了但没授权。
     *
     * @param string   $secret    控制台「工具源」登记的签名密钥
     * @param callable $authorize function(string $operator, string $tool, array $params): bool —— 能否执行。
     *                            $operator 空串=匿名任务（网页访客等），按你的业务语义决定拒绝或只读放行。
     * @param string      $tool      本端点对应的工具名/operationId（拼进回调，便于按工具分流授权）
     * @param string|null $knownPath spec 里声明的 path（base_url 带前缀/框架重写 REQUEST_URI 时传，见 currentRequest）
     * @return array{ok:bool,code:int,error:?string,operator:string,jobId:string}
     *         ok=true 放行；否则按 code 回错：401=验签失败（不是中枢发的）/ 403=授权拒绝（这个人不能做）。
     */
    public static function gate(string $secret, callable $authorize, string $tool = '', ?string $knownPath = null): array
    {
        $uri = $_SERVER['REQUEST_URI'] ?? '';
        if ($knownPath !== null) {
            $q = strpos($uri, '?');
            $uri = $knownPath . ($q !== false ? substr($uri, $q) : '');
        }
        $rawBody = file_get_contents('php://input') ?: '';
        $operator = $_SERVER['HTTP_X_BAILING_ON_BEHALF_OF'] ?? '';
        $jobId = $_SERVER['HTTP_X_BAILING_JOB_ID'] ?? '';
        $reason = self::failureReason(
            $secret,
            $_SERVER['REQUEST_METHOD'] ?? '',
            $uri,
            $rawBody,
            $_SERVER['HTTP_X_BAILING_TIMESTAMP'] ?? '',
            $_SERVER['HTTP_X_BAILING_SIGNATURE'] ?? '',
            300,
            $operator,
            $jobId,
        );
        if ($reason !== null) {
            return ['ok' => false, 'code' => 401, 'error' => $reason, 'operator' => $operator, 'jobId' => $jobId];
        }
        // 强制授权：必填回调用既有权限表裁决（不接 authority = 没接好这套安全模型）
        $allowed = (bool) $authorize($operator, $tool, self::paramsFrom($rawBody));
        if (!$allowed) {
            return ['ok' => false, 'code' => 403, 'error' => 'forbidden', 'operator' => $operator, 'jobId' => $jobId];
        }
        return ['ok' => true, 'code' => 200, 'error' => null, 'operator' => $operator, 'jobId' => $jobId];
    }

    /** 合并本次调用参数（query + JSON body），喂给 gate 的 authorize 回调做参数级裁决。 */
    private static function paramsFrom(string $rawBody): array
    {
        $params = $_GET ?? [];
        if ($rawBody !== '') {
            $body = json_decode($rawBody, true);
            if (is_array($body)) {
                $params = array_merge($params, $body);
            }
        }
        return $params;
    }

    /** 当前请求的操作主体（验签通过后再用！）；匿名任务（网页访客等）返回 null。 */
    public static function onBehalfOf(): ?string
    {
        $v = $_SERVER['HTTP_X_BAILING_ON_BEHALF_OF'] ?? '';
        return $v !== '' ? $v : null;
    }

    /** 当前请求所属的中枢任务号（审计回查用）。 */
    public static function jobId(): ?string
    {
        $v = $_SERVER['HTTP_X_BAILING_JOB_ID'] ?? '';
        return $v !== '' ? $v : null;
    }
}
