<?php

declare(strict_types=1);

namespace Bailing\Connect;

use RuntimeException;

/**
 * 中枢主动 API 客户端：封装 POST /run、GET /jobs/{id}、POST /send。
 *
 * 这只是薄封装，稳定契约仍是 HTTP + Bearer token。适合业务后端在事件点触发任务、
 * 查询结果，或经入站渠道主动给用户推消息。
 */
final class HubClient
{
    private string $baseUrl;
    private string $token;
    private int $timeoutSeconds;

    public function __construct(string $baseUrl, string $token, int $timeoutSeconds = 8)
    {
        if ($baseUrl === '') {
            throw new RuntimeException('baseUrl 必填');
        }
        if ($token === '') {
            throw new RuntimeException('token 必填');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->token = $token;
        $this->timeoutSeconds = $timeoutSeconds;
    }

    /** @param array<string,mixed> $metadata @return array<string,mixed> */
    public function run(string $requestId, string $route, string $input, array $metadata = [], ?string $callbackUrl = null, ?int $waitMs = null): array
    {
        $body = ['request_id' => $requestId, 'route' => $route, 'input' => $input, 'metadata' => $metadata];
        if ($callbackUrl !== null && $callbackUrl !== '') {
            $body['callback_url'] = $callbackUrl;
        }
        if ($waitMs !== null) {
            $body['wait_ms'] = $waitMs;
        }
        return $this->post('/run', $body);
    }

    /** @return array<string,mixed> */
    public function getJob(string $jobId): array
    {
        return $this->get('/jobs/' . rawurlencode($jobId));
    }

    /**
     * @param string|array<int,string> $to
     * @param array<int,string> $images
     * @param array<int,array<string,mixed>> $files
     * @param array<string,mixed>|null $card
     * @return array<string,mixed>
     */
    public function send(string $requestId, string $channel, string|array $to, string $text, array $images = [], array $files = [], ?array $card = null): array
    {
        $body = ['request_id' => $requestId, 'channel' => $channel, 'to' => $to, 'text' => $text];
        if ($images !== []) {
            $body['images'] = $images;
        }
        if ($files !== []) {
            $body['files'] = $files;
        }
        if ($card !== null) {
            $body['card'] = $card;
        }
        return $this->post('/send', $body);
    }

    /** @return array<string,mixed> */
    public function get(string $path): array
    {
        return $this->request('GET', $path);
    }

    /** @param array<string,mixed> $body @return array<string,mixed> */
    public function post(string $path, array $body): array
    {
        return $this->request('POST', $path, $body);
    }

    /** @param array<string,mixed>|null $body @return array<string,mixed> */
    public function request(string $method, string $path, ?array $body = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->token];
        $content = '';
        if ($body !== null) {
            $content = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}';
            $headers[] = 'Content-Type: application/json';
        }
        $http = [
            'method' => strtoupper($method),
            'header' => implode("\r\n", $headers),
            'timeout' => $this->timeoutSeconds,
            'ignore_errors' => true,
        ];
        if ($body !== null) {
            $http['content'] = $content;
        }
        $raw = file_get_contents($this->baseUrl . $path, false, stream_context_create(['http' => $http]));
        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $m)) {
                $status = (int) $m[1];
                break;
            }
        }
        $data = json_decode($raw !== false ? $raw : '{}', true);
        if (!is_array($data)) {
            $data = ['raw' => $raw];
        }
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException((string) ($data['error'] ?? $data['message'] ?? ('HTTP ' . $status)));
        }
        return $data;
    }
}
