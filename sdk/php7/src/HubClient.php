<?php

namespace Bailing\Connect;

use RuntimeException;

/**
 * 中枢主动 API 客户端：封装 POST /run、GET /jobs/{id}、POST /send。
 * PHP 7.3 兼容版，稳定契约仍是 HTTP + Bearer token。
 */
final class HubClient
{
    private $baseUrl;
    private $token;
    private $timeoutSeconds;

    public function __construct($baseUrl, $token, $timeoutSeconds = 8)
    {
        if ($baseUrl === '') {
            throw new RuntimeException('baseUrl 必填');
        }
        if ($token === '') {
            throw new RuntimeException('token 必填');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->token = $token;
        $this->timeoutSeconds = (int) $timeoutSeconds;
    }

    public function run($requestId, $route, $input, array $metadata = array(), $callbackUrl = null, $waitMs = null)
    {
        $body = array('request_id' => $requestId, 'route' => $route, 'input' => $input, 'metadata' => $metadata);
        if ($callbackUrl !== null && $callbackUrl !== '') {
            $body['callback_url'] = $callbackUrl;
        }
        if ($waitMs !== null) {
            $body['wait_ms'] = $waitMs;
        }
        return $this->post('/run', $body);
    }

    public function getJob($jobId)
    {
        return $this->get('/jobs/' . rawurlencode((string) $jobId));
    }

    public function send($requestId, $channel, $to, $text, array $images = array(), array $files = array(), array $card = null)
    {
        $body = array('request_id' => $requestId, 'channel' => $channel, 'to' => $to, 'text' => $text);
        if ($images) {
            $body['images'] = $images;
        }
        if ($files) {
            $body['files'] = $files;
        }
        if ($card !== null) {
            $body['card'] = $card;
        }
        return $this->post('/send', $body);
    }

    public function get($path)
    {
        return $this->request('GET', $path);
    }

    public function post($path, array $body)
    {
        return $this->request('POST', $path, $body);
    }

    public function request($method, $path, array $body = null)
    {
        $headers = array('Authorization: Bearer ' . $this->token);
        $content = '';
        if ($body !== null) {
            $content = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($content === false) {
                $content = '{}';
            }
            $headers[] = 'Content-Type: application/json';
        }
        $http = array(
            'method' => strtoupper($method),
            'header' => implode("\r\n", $headers),
            'timeout' => $this->timeoutSeconds,
            'ignore_errors' => true,
        );
        if ($body !== null) {
            $http['content'] = $content;
        }
        $raw = file_get_contents($this->baseUrl . $path, false, stream_context_create(array('http' => $http)));
        $status = 0;
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $line) {
                if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $m)) {
                    $status = (int) $m[1];
                    break;
                }
            }
        }
        $data = json_decode($raw !== false ? $raw : '{}', true);
        if (!is_array($data)) {
            $data = array('raw' => $raw);
        }
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException((string) (isset($data['error']) ? $data['error'] : (isset($data['message']) ? $data['message'] : ('HTTP ' . $status))));
        }
        return $data;
    }
}
