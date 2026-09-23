<?php
namespace Bailing\Connect;

/** Optional, server-only Usage issuer API. This credential is not a business Client Token. */
final class UsageClient
{
    private $baseUrl;
    private $issuerToken;
    private $timeout;
    private $transport;

    public function __construct($baseUrl, $issuerToken, $timeoutSeconds = 15, $transport = null)
    {
        $url = is_string($baseUrl) ? parse_url($baseUrl) : false;
        if (!$url || !isset($url['scheme'], $url['host']) || !in_array($url['scheme'], array('https', 'http'), true)
            || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])
            || ($url['scheme'] === 'http' && !in_array($url['host'], array('localhost', '127.0.0.1', '[::1]'), true))) {
            throw new \InvalidArgumentException('Use HTTPS, or loopback HTTP for development.');
        }
        if (!is_string($issuerToken) || !preg_match('/^bhu_i_[A-Za-z0-9_-]{43}$/D', $issuerToken)) {
            throw new \InvalidArgumentException('A separate Usage issuer credential is required.');
        }
        if (!is_int($timeoutSeconds) || $timeoutSeconds < 1 || $timeoutSeconds > 60 || ($transport !== null && !is_callable($transport))) {
            throw new \InvalidArgumentException('Invalid transport configuration.');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->issuerToken = $issuerToken;
        $this->timeout = $timeoutSeconds;
        $this->transport = $transport;
    }

    public function __debugInfo() { return array('credential' => '[redacted]', 'timeoutSeconds' => $this->timeout); }
    private function key($value)
    {
        if (!is_string($value) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/D', $value)) {
            throw new \InvalidArgumentException('An exact identifier is required.');
        }
        return $value;
    }
    private function accountPath($accountId, $action)
    {
        return '/usage/v1/external/billing/accounts/' . rawurlencode($this->key($accountId)) . '/' . $action;
    }
    public function exchangeSession(array $input) { return $this->request('POST', '/usage/v1/sessions/exchange', $input); }
    public function revokeUser(array $input) { return $this->request('POST', '/usage/v1/external/users/revoke', $input); }
    public function listBillingPlans() { return $this->request('GET', '/usage/v1/external/billing/plans'); }
    public function grantBillingPlan($accountId, array $input) { return $this->request('POST', $this->accountPath($accountId, 'grant'), $input); }
    public function controlBillingPlan($accountId, array $input) { return $this->request('POST', $this->accountPath($accountId, 'control'), $input); }
    public function getBillingSummary($accountId) { return $this->request('GET', $this->accountPath($accountId, 'summary')); }
    private function request($method, $path, array $body = null)
    {
        $requestKey = $body === null || $path === '/usage/v1/external/users/revoke' ? null : $this->key(isset($body['request_key']) ? $body['request_key'] : null);
        $encoded = $body === null ? null : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($body !== null && $encoded === false) throw new \InvalidArgumentException('The request must be JSON encodable.');
        $headers = array('Authorization: Bearer ' . $this->issuerToken, 'Accept: application/json');
        if ($body !== null) $headers[] = 'Content-Type: application/json';
        try {
            if ($this->transport !== null) {
                $result = call_user_func($this->transport, $method, $this->baseUrl . $path, $headers, $encoded, $this->timeout);
                $status = isset($result['status']) ? (int) $result['status'] : 0;
                $raw = isset($result['body']) ? $result['body'] : false;
            } else {
                $http = array('method' => $method, 'header' => implode("\r\n", $headers), 'timeout' => $this->timeout,
                    'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0);
                if ($encoded !== null) $http['content'] = $encoded;
                // Suppress transport warnings that otherwise embed private URLs in PHP logs.
                $raw = @file_get_contents($this->baseUrl . $path, false, stream_context_create(array('http' => $http)), 0, 1048577);
                $status = 0;
                if (isset($http_response_header)) foreach ($http_response_header as $line) {
                    if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $match)) { $status = (int) $match[1]; break; }
                }
            }
        } catch (\Throwable $error) {
            throw new UsageClientException('USAGE_TRANSPORT_UNAVAILABLE', null, $method === 'GET' ? 'rejected' : 'unknown', $requestKey);
        }
        if ($raw === false || $status === 0) throw new UsageClientException('USAGE_TRANSPORT_UNAVAILABLE', null, $method === 'GET' ? 'rejected' : 'unknown', $requestKey);
        $data = null;
        $validJson = false;
        if (is_string($raw) && strlen($raw) <= 1048576) {
            $data = json_decode($raw, true);
            $validJson = json_last_error() === JSON_ERROR_NONE;
        }
        if (!$validJson || !is_array($data)) throw new UsageClientException($status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_RESPONSE_INVALID', $status, $method === 'GET' || $status === 404 ? 'rejected' : 'unknown', $requestKey);
        if ($status < 200 || $status >= 300) {
            $candidate = isset($data['code']) ? $data['code'] : (isset($data['error']) ? $data['error'] : '');
            $code = is_string($candidate) && preg_match('/^[A-Z][A-Z0-9_]{1,90}$/D', $candidate) ? $candidate : ($status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_REQUEST_REJECTED');
            $feedback = array();
            if (isset($data['feedback']) && is_array($data['feedback'])) foreach (array('schema', 'code', 'dispatch', 'retryable', 'next_action', 'resetAt', 'reset_at') as $key) {
                if (isset($data['feedback'][$key]) && is_scalar($data['feedback'][$key])) $feedback[$key] = $data['feedback'][$key];
            }
            throw new UsageClientException($code, $status, $status >= 500 && $method !== 'GET' ? 'unknown' : 'rejected', $requestKey, $feedback);
        }
        return $data;
    }
}
