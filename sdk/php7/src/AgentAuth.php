<?php

namespace Bailing\Connect;

use InvalidArgumentException;

/**
 * 业务后端对接 BailingHub Agent Auth v1 的薄客户端。
 *
 * 使用现有接入方 Client Token 读取授权上下文，并在业务系统
 * 已完成登录和权限判定后批准/拒绝。不签发套餐、付费或权益数据。
 * PHP 7.3 兼容版，语义与 8.x SDK 的 AgentAuth 一致。
 */
final class AgentAuth
{
    private $hub;

    public function __construct($baseUrl, $clientToken, $timeoutSeconds = 8)
    {
        $this->hub = new HubClient($baseUrl, $clientToken, $timeoutSeconds);
    }

    /** @return array */
    public function context($authorizationId)
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->get('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId));
    }

    /**
     * @param array $principal     业务后端从当前登录态推导的主体，必须包含 id
     * @param array $allowedRoutes 本次授权允许的路由标识
     * @return array
     */
    public function approve($authorizationId, array $principal, $onBehalfOf, array $allowedRoutes)
    {
        self::assertId($authorizationId, 'authorizationId');
        if (!isset($principal['id']) || trim((string) $principal['id']) === '') {
            throw new InvalidArgumentException('principal.id 必填');
        }
        if ($onBehalfOf === '') {
            throw new InvalidArgumentException('onBehalfOf 必填');
        }
        if ($allowedRoutes === array()) {
            throw new InvalidArgumentException('allowedRoutes 至少包含一条路由');
        }
        if (!isset($principal['roles'])) {
            $principal['roles'] = array();
        }
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/approve', array(
            'principal' => $principal,
            'on_behalf_of' => $onBehalfOf,
            'allowed_routes' => array_values($allowedRoutes),
        ));
    }

    /** @return array */
    public function deny($authorizationId)
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/deny', array());
    }

    /** @return array */
    public function revokeSession($sessionId)
    {
        self::assertId($sessionId, 'sessionId');
        return $this->hub->post('/agent-auth/v1/sessions/' . rawurlencode($sessionId) . '/revoke', array());
    }

    private static function assertId($value, $name)
    {
        if (!is_string($value) || !preg_match('/^[0-9a-f-]{36}$/i', $value)) {
            throw new InvalidArgumentException($name . ' 必须是 UUID');
        }
    }
}
