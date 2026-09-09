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
     * 查询当前接入方的授权会话；principal_id 必须同时指定 tenant。
     * tenant='' 精确选择无租户主体，省略 tenant 则不按租户过滤。
     *
     * @param array{authorization_id?:string,on_behalf_of?:string,principal_id?:string,tenant?:string,state?:string,limit?:int,cursor?:string} $filters
     * @return array<string,mixed>
     */
    public function listSessions(array $filters = []): array
    {
        $allowed = ['authorization_id', 'on_behalf_of', 'principal_id', 'tenant', 'state', 'limit', 'cursor'];
        foreach ($filters as $key => $value) {
            if (!in_array($key, $allowed, true)) {
                throw new InvalidArgumentException('未知会话筛选字段');
            }
            if ($key === 'authorization_id') {
                if (!is_string($value) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value)) {
                    throw new InvalidArgumentException('authorization_id 必须是 UUID');
                }
            } elseif (in_array($key, ['on_behalf_of', 'principal_id', 'tenant'], true)) {
                self::assertFilterString($value, $key, $key === 'on_behalf_of' ? 191 : 128, $key === 'tenant');
            } elseif ($key === 'state' && !in_array($value, ['active', 'expired', 'revoked'], true)) {
                throw new InvalidArgumentException('state 必须是 active、expired 或 revoked');
            } elseif ($key === 'limit' && (!is_int($value) || $value < 1 || $value > 100)) {
                throw new InvalidArgumentException('limit 必须是 1 到 100 的整数');
            } elseif ($key === 'cursor' && (!is_string($value) || strlen($value) > 2048 || !preg_match('/^[A-Za-z0-9_-]+$/D', $value))) {
                throw new InvalidArgumentException('cursor 必须是非空、不带填充的 base64url 字符串，长度不超过 2048');
            }
        }
        if (array_key_exists('principal_id', $filters) && !array_key_exists('tenant', $filters)) {
            throw new InvalidArgumentException('principal_id 必须同时指定 tenant');
        }
        $query = http_build_query($filters, '', '&', PHP_QUERY_RFC3986);
        return $this->hub->get('/agent-auth/v1/sessions' . ($query === '' ? '' : '?' . $query));
    }

    /** @return array<string,mixed> */
    public function revokeAuthorization(string $authorizationId): array
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/revoke', []);
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
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value)) {
            throw new InvalidArgumentException($name . ' 必须是 UUID');
        }
    }

    private static function assertFilterString(mixed $value, string $name, int $max, bool $allowEmpty): void
    {
        if (!is_string($value) || (!$allowEmpty && $value === '') ||
            preg_match('/[\x00-\x1f\x7f]|^[\p{Z}\x{FEFF}]|[\p{Z}\x{FEFF}]$/u', $value) ||
            preg_match_all('/./us', $value, $characters) === false) {
            throw new InvalidArgumentException($name . ' 必须是无首尾空白或控制字符的有效字符串');
        }
        // 与 HTTP 服务端的 UTF-16 长度一致，不依赖 mbstring 扩展。
        $length = 0;
        foreach ($characters[0] as $character) {
            $length += strlen($character) > 3 ? 2 : 1;
        }
        if ($length > $max) {
            throw new InvalidArgumentException($name . ' 长度超出限制');
        }
    }
}
