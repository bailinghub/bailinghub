<?php
/**
 * 百灵中枢 · 工具调用接入参考实现（CONTRACT.md §2.4）
 *
 * 工具端点要扣【两道闸】，缺一不可：
 *   ① 验签（authentication）——"真是中枢发的吗"。本文件 bailing_verify_tool_call()。
 *   ② 授权（authorization）——"这个操作主体此刻能不能做这件事"。本文件 bailing_authorize()，
 *      你【必须】用自己既有的权限表实现，默认拒绝。Agent 调用与人点按钮走同一条裁决路径。
 *
 * ⚠️ 最常见、也最致命的接入错误：只做①、把②留成注释或写成 `return true`。
 *    服务器到服务器调用【没有用户 session】，你平时基于登录态的鉴权对中枢调用不生效——
 *    所以把 On-Behalf-Of 主体接进权限表，是这条链路【唯一】的授权闸。只做①=认证了但没授权，
 *    结果是：只要主体是合法的、工具在 allow 白名单里，任何人都能让 Agent 替任何主体执行写操作。
 *
 * 用 PHP？直接用官方 SDK 的 Bailing\Connect\Verify::gate()——它把 authorize 做成必填回调、fail-closed，
 * 比抄本文件更难写错。本文件是零依赖参考，给非 PHP 或不想引 SDK 的接入方照抄。
 * 非 PHP 语言另见同目录 bailing-tool-verify.mjs（Node）/ .py（Python），均含冻结测试向量自检。
 */

/**
 * ① 验签。签名方案 sha256=（算法名，非版本号）。任何一步不过都返回 false（调用方应回 401）。
 *
 * 关键：必须用收到的【原始 body 字节】算 sha256（中枢「签所发即所发」），别把 JSON 重新序列化后再签。
 *
 * @param string $secret        控制台「工具源」登记的签名密钥
 * @param string $method        $_SERVER['REQUEST_METHOD']
 * @param string $pathWithQuery 含 query 的请求路径（ThinkPHP: $request->url()；裸 PHP: $_SERVER['REQUEST_URI']）
 * @param string $rawBody       原始请求体（GET 为空串）：file_get_contents('php://input')
 * @param string $timestamp     X-Bailing-Timestamp 头（unix 秒）
 * @param string $signature     X-Bailing-Signature 头（形如 sha256=abc...）
 * @param string $onBehalfOf    X-Bailing-On-Behalf-Of 头（签名材料含它；匿名为空串）
 * @param string $jobId         X-Bailing-Job-Id 头（签名材料含它）
 */
function bailing_verify_tool_call(
    string $secret,
    string $method,
    string $pathWithQuery,
    string $rawBody,
    string $timestamp,
    string $signature,
    string $onBehalfOf = '',
    string $jobId = ''
): bool {
    // 时间窗 300 秒防重放
    if (abs(time() - (int) $timestamp) >= 300) {
        return false;
    }
    $base = $timestamp . '.' . strtoupper($method) . '.' . $pathWithQuery . '.' . hash('sha256', $rawBody);
    // 签名材料把 On-Behalf-Of + Job-Id 也钉进去（防窗口内重放篡头换租户/绕幂等）。
    $expect = 'sha256=' . hash_hmac('sha256', $base . '.' . $onBehalfOf . '.' . $jobId, $secret);
    return hash_equals($expect, $signature); // 恒时比较，防时序侧信道
}

/**
 * 独立授权探针端点参考实现。中枢刷新工具源时会用不存在的主体探测它；
 * 正确行为是验签通过、授权回调返回 false，即响应 {"authorized":false}。
 *
 * @return array{0:int,1:array}
 */
function bailing_authz_probe_response(
    string $secret,
    string $method,
    string $pathWithQuery,
    string $rawBody,
    string $timestamp,
    string $signature,
    callable $authorize,
    string $onBehalfOf = '',
    string $jobId = ''
): array {
    if (!bailing_verify_tool_call($secret, $method, $pathWithQuery, $rawBody, $timestamp, $signature, $onBehalfOf, $jobId)) {
        return [401, ['authorized' => false, 'error' => 'bad_signature']];
    }
    $subject = $onBehalfOf;
    $body = json_decode($rawBody !== '' ? $rawBody : '{}', true);
    if (is_array($body) && array_key_exists('subject', $body)) {
        $subject = (string) $body['subject'];
    }
    try {
        $authorized = (bool) $authorize($subject);
    } catch (\Throwable $e) {
        $authorized = false;
    }
    return [200, ['authorized' => $authorized]];
}

/**
 * ② 授权裁决——【你必须用自己既有的权限表真正实现，默认拒绝】。
 *
 * ⚠️ 切勿写成 `return true;`：那等于把授权整个关掉，跟没接一样（且更隐蔽，看起来像实现了）。
 *    下面三个入参就是要你真正用上：用 $operator 的角色/租户绑定/数据范围，判断他能否对本 $tool、本 $params 执行。
 *    若你的权限校验在控制器内（如已有的 cv()/PermissionService），就在这里委托过去；别在这里 return true 把它架空。
 *
 * @param string $operator On-Behalf-Of 主体（空串=匿名任务，如网页访客；按你的业务语义决定拒绝或只读放行）
 * @param string $tool     工具名/operationId
 * @param array  $params   本次调用参数（query + body 合并），用于参数级裁决（如金额上限、目标账户归属）
 */
function bailing_authorize(string $operator, string $tool, array $params): bool
{
    // ——— 删掉这行、换成你真正的权限判断 ———
    throw new \RuntimeException('bailing_authorize 未实现：必须用你的权限表裁决 $operator 能否执行 $tool，切勿直接 return true');

    // 典型实现（示意，按你的体系改）：
    // if ($operator === '') { return false; }                       // 匿名禁写（只读端点可另行放行）
    // [$tenant, $uid] = array_pad(explode(':', $operator, 2), 2, ''); // 多租户主体一般是 "{租户}:{uid}"
    // return PermissionService::can($tenant, $uid, $tool, $params);  // 走你既有的角色/数据范围裁决
}

/* ---------------------------------------------------------------------------
 * ThinkPHP 8 中间件示例：挂在你暴露给 AI 的路由分组上。两道闸都在这里，缺一不可。
 * ------------------------------------------------------------------------- */
/*
namespace app\common\http\middleware;

use Closure;
use think\Request;
use think\Response;

class BailingToolVerify
{
    public function handle(Request $request, Closure $next): Response
    {
        $secret = config('bailing.tool_secret'); // 与控制台「工具源」里登记的一致
        $operator = (string) $request->header('x-bailing-on-behalf-of', '');
        $jobId    = (string) $request->header('x-bailing-job-id', '');

        // —— 闸① 验签：真是中枢发的吗 ——
        $ok = bailing_verify_tool_call(
            $secret,
            $request->method(),
            $request->url(),                    // 含 query 的路径
            $request->getInput(),               // 原始 body（GET 为空串）
            (string) $request->header('x-bailing-timestamp', ''),
            (string) $request->header('x-bailing-signature', ''),
            $operator,                          // On-Behalf-Of，纳入签名材料
            $jobId
        );
        if (!$ok) {
            return json(['code' => 0, 'msg' => 'bad signature'], 401);
        }

        // —— 闸② 授权：这个主体能不能做这件事（fail-closed，必做，别注释掉）——
        $tool = $request->rule()->getName();                 // 或你给该端点定的 operationId
        $params = array_merge($request->get(), $request->post());
        if (!bailing_authorize($operator, $tool, $params)) {
            return json(['code' => 0, 'msg' => 'forbidden'], 403);
        }

        $request->aiOperator = $operator;       // 控制器/服务层取这个当操作人
        $request->aiJobId = $jobId;             // 留痕用
        return $next($request);
    }
}
*/
