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
     * 查询当前接入方的授权会话；principal_id 必须同时指定 tenant。
     * tenant='' 精确选择无租户主体，省略 tenant 则不按租户过滤。
     * @param array $filters authorization_id/on_behalf_of/principal_id/tenant/state/limit/cursor
     * @return array
     */
    public function listSessions(array $filters = array())
    {
        $allowed = array('authorization_id', 'on_behalf_of', 'principal_id', 'tenant', 'state', 'limit', 'cursor');
        foreach ($filters as $key => $value) {
            if (!in_array($key, $allowed, true)) {
                throw new InvalidArgumentException('未知会话筛选字段');
            }
            if ($key === 'authorization_id') {
                if (!is_string($value) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value)) {
                    throw new InvalidArgumentException('authorization_id 必须是 UUID');
                }
            } elseif (in_array($key, array('on_behalf_of', 'principal_id', 'tenant'), true)) {
                self::assertFilterString($value, $key, $key === 'on_behalf_of' ? 191 : 128, $key === 'tenant');
            } elseif ($key === 'state' && !in_array($value, array('active', 'expired', 'revoked'), true)) {
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

    /** @return array */
    public function revokeAuthorization($authorizationId)
    {
        self::assertId($authorizationId, 'authorizationId');
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/revoke', array());
    }

    /**
     * @param array $principal     业务后端从当前登录态推导的主体，必须包含 id
     * @param array $allowedRoutes 本次授权允许的路由标识
     * @param array|null $subjectDisplay 业务服务端提供的显示名称，不参与身份判定
     * @return array
     */
    public function approve($authorizationId, array $principal, $onBehalfOf, array $allowedRoutes, $subjectDisplay = null)
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
        $body = array(
            'principal' => $principal,
            'on_behalf_of' => $onBehalfOf,
            'allowed_routes' => array_values($allowedRoutes),
        );
        // Existing four-argument calls keep their original HTTP shape for older Core versions.
        if (func_num_args() >= 5) {
            $body['subject_display'] = self::normalizeSubjectDisplay($subjectDisplay);
        }
        return $this->hub->post('/agent-auth/v1/authorizations/' . rawurlencode($authorizationId) . '/approve', $body);
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

    /**
     * 同步当前接入方已有有效授权的显示名称；不修改身份、权限或有效期。
     * @param array{name:string}|null $subjectDisplay 业务服务端读取的名称，null 表示清除
     * @return array
     */
    public function updateSubjectDisplay($sessionId, $subjectDisplay)
    {
        self::assertId($sessionId, 'sessionId');
        return $this->hub->request('PUT', '/agent-auth/v1/sessions/' . rawurlencode($sessionId) . '/subject-display', array(
            'subject_display' => self::normalizeSubjectDisplay($subjectDisplay),
        ));
    }

    private static function normalizeSubjectDisplay($value)
    {
        if ($value === null) {
            return null;
        }
        if (!is_array($value) || array_keys($value) !== array('name') || !is_string($value['name'])) {
            throw new InvalidArgumentException('subjectDisplay 只能包含字符串 name');
        }
        $name = $value['name'];
        // Reject controls before trimming; line breaks must not become a valid one-line name.
        if (preg_match('//u', $name) !== 1 || preg_match('/[\x00-\x1f\x7f-\x9f\x{2028}\x{2029}]/u', $name)) {
            throw new InvalidArgumentException('subjectDisplay.name 必须是无控制字符的单行文本');
        }
        $name = preg_replace('/^[\p{Z}\x{FEFF}]+|[\p{Z}\x{FEFF}]+$/u', '', $name);
        self::assertFilterString($name, 'subjectDisplay.name', 120, false);
        return array('name' => $name);
    }

    private static function assertId($value, $name)
    {
        if (!is_string($value) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value)) {
            throw new InvalidArgumentException($name . ' 必须是 UUID');
        }
    }

    private static function assertFilterString($value, $name, $max, $allowEmpty)
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
