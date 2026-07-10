<?php

namespace Bailing\Connect;

use InvalidArgumentException;

/**
 * 签名访客票据（CONTRACT.md §1.1，聊天入口带登录身份）。PHP 7.3 兼容版（逻辑同 8.x 版）。
 *
 * 用法：用户已登录你的系统后，页面渲染时签一张短票塞给聊天组件：
 *   $ticket = Ticket::sign($接入方token, (string) $user->id);
 *   <script src="https://中枢/widget.js" data-entry="pub_x" data-ticket="<?= $ticket ?>"></script>
 *
 * 铁律：接入方 token 只存在你的服务器上，永远不进前端——进前端的只有签好的短票。
 */
final class Ticket
{
    /**
     * @param string $clientToken 你在中枢「接入方」的 token（服务端密钥，勿外泄）
     * @param string $uid         你系统里该用户的唯一标识（1~64 字符）
     * @param int      $ttlSeconds 有效期（默认 2 小时）；过期后组件会收到 401，页面重刷即再签
     * @param int|null $expiresAt  固定过期时间（unix 秒）。传入后优先于 ttl，便于测试或业务统一会话过期时间。
     */
    public static function sign($clientToken, $uid, $ttlSeconds = 7200, $expiresAt = null)
    {
        if ($uid === '' || strlen($uid) > 64) {
            throw new InvalidArgumentException('uid 长度需 1~64 字节');
        }
        $json = json_encode(array('uid' => $uid, 'exp' => $expiresAt !== null ? (int) $expiresAt : time() + $ttlSeconds), JSON_UNESCAPED_UNICODE);
        $payload = rtrim(strtr(base64_encode($json !== false ? $json : ''), '+/', '-_'), '=');
        return 'v1.' . $payload . '.' . hash_hmac('sha256', $payload, $clientToken);
    }
}
