<?php

declare(strict_types=1);

namespace Bailing\Connect;

use InvalidArgumentException;

/**
 * 业务后端对接 BailingHub Agent Auth v1 的薄客户端。
 *
 * 使用现有接入方 Client Token 读取授权上下文，并在业务系统
 * 已完成登录和权限判定后批准/拒绝。不签发套餐、付费或权益数据。
 */
final class AgentAuth
{
    private HubClient $hub;

    public function __construct(string $baseUrl, string $clientToken, int $timeoutSeconds = 8)
    {
        $this->hub = new HubClient($baseUrl, $clientToken, $timeoutSeconds);
    }

    /** @return array<string,mixed> */
    public function context(string $authorizationId): array
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->get('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId));
    }

    /**
     * @param array{id:string,tenant?:string,roles?:array<int,string>,audience?:string,channel?:string} $principal
     * @param array<int,string> $allowedRoutes
     * @return array<string,mixed>
     */
    public function approve(string $authorizationId, array $principal, string $onBehalfOf, array $allowedRoutes): array
    {
        self::assertId($authorizationId, 'authorizationId');
        if (!isset($principal['id']) || trim((string) $principal['id']) === '') {
            throw new InvalidArgumentException('principal.id 必填');
        }
        if ($onBehalfOf === '') {
            throw new InvalidArgumentException('onBehalfOf 必填');
        }
        if ($allowedRoutes === []) {
            throw new InvalidArgumentException('allowedRoutes 至少包含一条路由');
        }
        if (!isset($principal['roles'])) {
            $principal['roles'] = [];
        }
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/approve', [
            'principal' => $principal,
            'on_behalf_of' => $onBehalfOf,
            'allowed_routes' => array_values($allowedRoutes),
        ]);
    }

    /** @return array<string,mixed> */
    public function deny(string $authorizationId): array
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/deny', []);
    }

    /** @return array<string,mixed> */
    public function revokeSession(string $sessionId): array
    {
        self::assertId($sessionId, 'sessionId');
        return $this->hub->post('/agent-auth/v1/sessions/' . rawurlencode($sessionId) . '/revoke', []);
    }

    private static function assertId(string $value, string $name): void
    {
        if (!preg_match('/^[0-9a-f-]{36}$/i', $value)) {
            throw new InvalidArgumentException($name . ' 必须是 UUID');
        }
    }
}
