using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Bailing.Connect;

public static class BailingConnect
{
    public static string SignTicket(string clientToken, string uid, long ttlSeconds = 7200)
    {
        return SignTicketExpiresAt(clientToken, uid, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ttlSeconds);
    }

    public static string SignTicketExpiresAt(string clientToken, string uid, long expiresAt)
    {
        if (string.IsNullOrEmpty(uid) || Encoding.UTF8.GetByteCount(uid) > 64)
            throw new ArgumentException("uid must be 1..64 bytes", nameof(uid));
        var body = JsonSerializer.Serialize(new Dictionary<string, object?> { ["uid"] = uid, ["exp"] = expiresAt });
        var payload = Base64Url(body);
        return $"v1.{payload}.{HmacHex(clientToken, payload)}";
    }

    public static string SignToolCall(string secret, long ts, string method, string pathWithQuery, string body = "", string onBehalfOf = "", string jobId = "")
    {
        var msg = $"{ts}.{method.ToUpperInvariant()}.{pathWithQuery}.{Sha256Hex(body ?? "")}.{onBehalfOf ?? ""}.{jobId ?? ""}";
        return "sha256=" + HmacHex(secret, msg);
    }

    public static bool VerifyToolCall(string secret, string method, string pathWithQuery, string body, long timestamp, string signature, string onBehalfOf = "", string jobId = "", long windowSec = 300)
    {
        if (string.IsNullOrEmpty(signature) || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - timestamp) >= windowSec) return false;
        var expected = SignToolCall(secret, timestamp, method, pathWithQuery, body, onBehalfOf, jobId);
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(signature));
    }

    public static bool VerifyCallback(string secret, string rawBody, long timestampMs, string signature, long windowMs = 300000)
    {
        if (string.IsNullOrEmpty(signature) || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - timestampMs) >= windowMs) return false;
        var expected = "sha256=" + HmacHex(secret, $"{timestampMs}.{rawBody ?? ""}");
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(signature));
    }

    public static (int Status, Dictionary<string, object?> Body) AuthzProbeResponse(
        string secret,
        string method,
        string pathWithQuery,
        string body,
        long timestamp,
        string signature,
        Func<string, bool> authorize,
        string onBehalfOf = "",
        string jobId = "")
    {
        if (!VerifyToolCall(secret, method, pathWithQuery, body, timestamp, signature, onBehalfOf, jobId))
            return (401, new Dictionary<string, object?> { ["authorized"] = false, ["error"] = "bad_signature" });
        var subject = onBehalfOf ?? "";
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
            if (doc.RootElement.TryGetProperty("subject", out var s) && s.ValueKind == JsonValueKind.String)
                subject = s.GetString() ?? subject;
        }
        catch { subject = onBehalfOf ?? ""; }
        var authorized = false;
        try { authorized = authorize(subject); } catch { authorized = false; }
        return (200, new Dictionary<string, object?> { ["authorized"] = authorized });
    }

    public static Dictionary<string, object?> BuildOpenApiSpec(string title, string version, IEnumerable<Tool> tools, Dictionary<string, string>? authzProbe = null)
    {
        var paths = new Dictionary<string, object?>();
        foreach (var t in tools)
        {
            var method = string.IsNullOrEmpty(t.Method) ? "GET" : t.Method.ToUpperInvariant();
            var op = new Dictionary<string, object?>
            {
                ["operationId"] = string.IsNullOrEmpty(t.Name) ? DefaultName(method, t.Path) : t.Name,
                ["summary"] = t.Description,
                ["x-agent-capability"] = BuildCapability(t, method),
            };
            if (t.Tags.Count > 0) op["tags"] = t.Tags;
            if (t.Deprecated) op["deprecated"] = true;

            var queryParams = new List<object?>();
            var bodyProps = new Dictionary<string, object?>();
            var bodyRequired = new List<string>();
            foreach (var p in t.Params)
            {
                var schema = new Dictionary<string, object?> { ["type"] = string.IsNullOrEmpty(p.Type) ? "string" : p.Type };
                if (!string.IsNullOrEmpty(p.Description)) schema["description"] = p.Description;
                if (p.Enum.Count > 0) schema["enum"] = p.Enum;
                if (!string.IsNullOrEmpty(p.Format)) schema["format"] = p.Format;
                if ((string)schema["type"]! == "array") schema["items"] = new Dictionary<string, object?> { ["type"] = string.IsNullOrEmpty(p.ItemsType) ? "string" : p.ItemsType };
                var loc = string.IsNullOrEmpty(p.In) ? (method == "GET" ? "query" : "body") : p.In;
                if (loc == "query" || loc == "path")
                    queryParams.Add(new Dictionary<string, object?> { ["name"] = p.Name, ["in"] = loc, ["required"] = p.Required, ["schema"] = schema });
                else
                {
                    bodyProps[p.Name] = schema;
                    if (p.Required) bodyRequired.Add(p.Name);
                }
            }
            if (queryParams.Count > 0) op["parameters"] = queryParams;
            if (bodyProps.Count > 0)
            {
                var schema = new Dictionary<string, object?> { ["type"] = "object", ["properties"] = bodyProps };
                if (bodyRequired.Count > 0) schema["required"] = bodyRequired;
                op["requestBody"] = new Dictionary<string, object?> { ["content"] = new Dictionary<string, object?> { ["application/json"] = new Dictionary<string, object?> { ["schema"] = schema } } };
            }
            if (!paths.TryGetValue(t.Path, out var pathObj) || pathObj is not Dictionary<string, object?> pathItem)
            {
                pathItem = new Dictionary<string, object?>();
                paths[t.Path] = pathItem;
            }
            pathItem[method.ToLowerInvariant()] = op;
        }
        var spec = new Dictionary<string, object?> { ["openapi"] = "3.0.0", ["info"] = new Dictionary<string, object?> { ["title"] = title, ["version"] = version }, ["paths"] = paths };
        if (authzProbe is not null) spec["x-bailing-authz-probe"] = authzProbe;
        return spec;
    }

    private static Dictionary<string, object?>? NormalizeRateLimit(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var parts = value.Replace(" ", "").ToLowerInvariant().Split('/', 2);
        if (parts.Length != 2 || !int.TryParse(parts[0], out var count)) return null;
        var window = parts[1] switch
        {
            "s" or "sec" or "second" => "1s",
            "h" or "hour" => "1h",
            "d" or "day" => "1d",
            "m" or "min" or "minute" => "1m",
            _ => "",
        };
        if (window == "") return null;
        return new Dictionary<string, object?> { ["count"] = count, ["window"] = window };
    }

    private static Dictionary<string, object?> BuildCapability(Tool t, string method)
    {
        var capability = new Dictionary<string, object?> { ["version"] = 1, ["enabled"] = true, ["scope"] = t.Scope };
        if (!string.IsNullOrEmpty(t.Risk) && t.Risk != "low") capability["risk"] = new Dictionary<string, object?> { ["level"] = t.Risk };
        if (t.Confirm || t.ConfirmWhen.Count > 0 || !string.IsNullOrEmpty(t.ConfirmPrompt))
        {
            var approval = new Dictionary<string, object?>();
            if (t.Confirm) approval["required"] = true;
            if (t.ConfirmWhen.Count > 0) approval["when"] = t.ConfirmWhen;
            if (!string.IsNullOrEmpty(t.ConfirmPrompt)) approval["prompt"] = t.ConfirmPrompt;
            capability["approval"] = approval;
        }
        if (t.RequiresSubject) capability["subject"] = new Dictionary<string, object?> { ["required"] = true };
        var execution = new Dictionary<string, object?>();
        if (t.Readonly == true && method != "GET") execution["readonly"] = true;
        if (t.Idempotent == true && method != "GET") execution["idempotent"] = true;
        var rateLimit = NormalizeRateLimit(t.RateLimit);
        if (rateLimit is not null) execution["rate_limit"] = rateLimit;
        if (t.TimeoutMs is not null) execution["timeout_ms"] = t.TimeoutMs;
        if (execution.Count > 0) capability["execution"] = execution;
        if (t.Sensitive) capability["audit"] = new Dictionary<string, object?> { ["sensitive"] = true };
        var guidance = new Dictionary<string, object?>();
        if (!string.IsNullOrEmpty(t.WhenToUse)) guidance["when_to_use"] = t.WhenToUse;
        if (!string.IsNullOrEmpty(t.Returns)) guidance["returns"] = t.Returns;
        if (t.Examples.Count > 0) guidance["examples"] = t.Examples;
        if (t.Context.Count > 0) guidance["context"] = t.Context;
        if (guidance.Count > 0) capability["guidance"] = guidance;
        return capability;
    }

    public static string ToJson(object value) => JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true });

    private static string Base64Url(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static string Sha256Hex(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    private static string HmacHex(string secret, string msg) => Convert.ToHexString(new HMACSHA256(Encoding.UTF8.GetBytes(secret)).ComputeHash(Encoding.UTF8.GetBytes(msg))).ToLowerInvariant();
    private static string DefaultName(string method, string path)
    {
        var chars = (method.ToLowerInvariant() + "_" + path).Select(ch => char.IsLetterOrDigit(ch) ? ch : '_').ToArray();
        var s = new string(chars).Trim('_');
        while (s.Contains("__")) s = s.Replace("__", "_");
        return s.Length > 64 ? s[..64] : s;
    }
}

public sealed class Param
{
    public string Name { get; init; } = "";
    public string In { get; init; } = "";
    public string Type { get; init; } = "string";
    public string ItemsType { get; init; } = "string";
    public string Description { get; init; } = "";
    public bool Required { get; init; }
    public string Format { get; init; } = "";
    public List<string> Enum { get; init; } = [];
}

public sealed class Tool
{
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public string Scope { get; init; } = "";
    public string Path { get; init; } = "";
    public string Method { get; init; } = "GET";
    public string Risk { get; init; } = "low";
    public bool Confirm { get; init; }
    public List<Dictionary<string, object?>> ConfirmWhen { get; init; } = [];
    public bool? Readonly { get; init; }
    public bool RequiresSubject { get; init; }
    public bool? Idempotent { get; init; }
    public bool Sensitive { get; init; }
    public string RateLimit { get; init; } = "";
    public int? TimeoutMs { get; init; }
    public string WhenToUse { get; init; } = "";
    public string Returns { get; init; } = "";
    public List<object?> Examples { get; init; } = [];
    public string ConfirmPrompt { get; init; } = "";
    public List<object?> Context { get; init; } = [];
    public List<string> Tags { get; init; } = [];
    public bool Deprecated { get; init; }
    public List<Param> Params { get; init; } = [];
}

public sealed class HubClient
{
    private readonly string _baseUrl;
    private readonly string _token;
    private readonly HttpClient _http;

    public HubClient(string baseUrl, string token, HttpClient? http = null)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _token = token;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
    }

    public Task<string> RunAsync(string requestId, string route, string input, Dictionary<string, object?>? metadata = null)
    {
        return PostAsync("/run", new Dictionary<string, object?> { ["request_id"] = requestId, ["route"] = route, ["input"] = input, ["metadata"] = metadata ?? new() });
    }

    public Task<string> GetJobAsync(string jobId) => GetAsync("/jobs/" + Uri.EscapeDataString(jobId));

    public Task<string> SendAsync(string requestId, string channel, object to, string text)
    {
        return PostAsync("/send", new Dictionary<string, object?> { ["request_id"] = requestId, ["channel"] = channel, ["to"] = to, ["text"] = text });
    }

    public Task<string> GetAsync(string path) => RequestAsync(HttpMethod.Get, path, null);
    public Task<string> PostAsync(string path, object body) => RequestAsync(HttpMethod.Post, path, JsonSerializer.Serialize(body));

    public async Task<string> RequestAsync(HttpMethod method, string path, string? body)
    {
        using var req = new HttpRequestMessage(method, _baseUrl + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        if (body is not null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
        using var res = await _http.SendAsync(req).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)res.StatusCode}: {text}");
        return text;
    }
}
