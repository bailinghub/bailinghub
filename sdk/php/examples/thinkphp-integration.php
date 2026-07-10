<?php

declare(strict_types=1);

/**
 * ThinkPHP 8 接入示例（复制改造，不是可直接运行的文件）。
 * 三件事：①spec 发布路由 ②验签中间件 ③（可选）聊天票据签发。
 */

// ============================================================
// ① spec 发布路由 —— route/app.php
// ============================================================
/*
use think\facade\Route;

Route::get('.well-known/bailing/tools.json', function () {
    $spec = (new \Bailing\Connect\SpecBuilder(title: '你的业务系统'))
        ->addClass(\app\opentenantapi\controller\StaffController::class)
        ->addClass(\app\opentenantapi\controller\OrderController::class);
    // 传 secret = 只对中枢开放（中枢拉取带 sha256= 签名）；传 null = 公开
    [$status, $body] = \Bailing\Connect\SpecServer::handle(
        $spec,
        config('bailing.tool_secret'),
        request()->method(),
        request()->url(),
        request()->header(),
    );
    return response($body, $status)->contentType('application/json');
});
*/

// ============================================================
// ② 验签中间件 —— app/common/middleware/BailingVerify.php
//    挂在暴露给 AI 的路由分组上；验签通过后主体放进 request，
//    控制器里照常走你自己的权限体系裁决。
// ============================================================
/*
namespace app\common\middleware;

use Bailing\Connect\Verify;
use Closure;
use think\Request;
use think\Response;

class BailingVerify
{
    public function handle(Request $request, Closure $next): Response
    {
        $ok = Verify::toolCall(
            config('bailing.tool_secret'),       // 与中枢「工具源」登记一致
            $request->method(),
            $request->url(),                      // 含 query
            $request->getInput(),                 // 原始 body
            $request->header('x-bailing-timestamp', ''),
            $request->header('x-bailing-signature', ''),
        );
        if (!$ok) {
            return json(['error' => 'bad signature'], 401);
        }
        // 操作主体（可能为空 = 匿名任务）：用你既有的权限体系裁决，
        // AI 调用与人点按钮走同一条路径
        $request->aiOperator = $request->header('x-bailing-on-behalf-of', '');
        return $next($request);
    }
}
*/

// ============================================================
// ③ 聊天组件带登录身份 —— 页面渲染处
// ============================================================
/*
$ticket = \Bailing\Connect\Ticket::sign(
    config('bailing.client_token'),   // 你在中枢「接入方」的 token，永不进前端
    (string) $user->id,
);
// <script src="https://中枢域名/widget.js" data-entry="pub_xxx" data-ticket="<?= $ticket ?>"></script>
*/
