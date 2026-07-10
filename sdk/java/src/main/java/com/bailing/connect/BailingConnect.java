package com.bailing.connect;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Predicate;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class BailingConnect {
    private BailingConnect() {}

    public static String signTicket(String clientToken, String uid) {
        return signTicket(clientToken, uid, 7200);
    }

    public static String signTicket(String clientToken, String uid, long ttlSeconds) {
        return signTicketExpiresAt(clientToken, uid, Instant.now().getEpochSecond() + ttlSeconds);
    }

    public static String signTicketExpiresAt(String clientToken, String uid, long expiresAt) {
        if (uid == null || uid.isEmpty() || uid.getBytes(StandardCharsets.UTF_8).length > 64) {
            throw new IllegalArgumentException("uid must be 1..64 bytes");
        }
        String payload = base64Url(toJson(mapOf("uid", uid, "exp", expiresAt)));
        return "v1." + payload + "." + hmacHex(clientToken, payload);
    }

    public static String signToolCall(String secret, long ts, String method, String pathWithQuery, String body, String onBehalfOf, String jobId) {
        String msg = ts + "." + method.toUpperCase() + "." + pathWithQuery + "." + sha256Hex(body == null ? "" : body) + "." + safe(onBehalfOf) + "." + safe(jobId);
        return "sha256=" + hmacHex(secret, msg);
    }

    public static boolean verifyToolCall(String secret, String method, String pathWithQuery, String body, long timestamp, String signature,
                                         String onBehalfOf, String jobId, long windowSec) {
        if (signature == null || Math.abs(Instant.now().getEpochSecond() - timestamp) >= windowSec) return false;
        return MessageDigest.isEqual(
            signToolCall(secret, timestamp, method, pathWithQuery, body, onBehalfOf, jobId).getBytes(StandardCharsets.UTF_8),
            signature.getBytes(StandardCharsets.UTF_8)
        );
    }

    public static boolean verifyCallback(String secret, String rawBody, long timestampMs, String signature, long windowMs) {
        if (signature == null || Math.abs(System.currentTimeMillis() - timestampMs) >= windowMs) return false;
        String expected = "sha256=" + hmacHex(secret, timestampMs + "." + safe(rawBody));
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), signature.getBytes(StandardCharsets.UTF_8));
    }

    public static ProbeResult authzProbeResponse(String secret, String method, String pathWithQuery, String body, long timestamp,
                                                 String signature, String onBehalfOf, String jobId, Predicate<String> authorize) {
        boolean ok = verifyToolCall(secret, method, pathWithQuery, body, timestamp, signature, onBehalfOf, jobId, 300);
        if (!ok) return new ProbeResult(401, mapOf("authorized", false, "error", "bad_signature"));
        String subject = firstJsonString(body, "subject", safe(onBehalfOf));
        boolean authorized = false;
        try { authorized = authorize.test(subject); } catch (RuntimeException ignored) { authorized = false; }
        return new ProbeResult(200, mapOf("authorized", authorized));
    }

    private static Map<String, Object> normalizeRateLimit(String value) {
        if (value == null || value.isBlank()) return null;
        String text = value.replaceAll("\\s+", "").toLowerCase();
        String[] parts = text.split("/", 2);
        if (parts.length != 2) return null;
        int count;
        try { count = Integer.parseInt(parts[0]); } catch (NumberFormatException e) { return null; }
        String unit = parts[1];
        String window;
        if ("s".equals(unit) || "sec".equals(unit) || "second".equals(unit)) window = "1s";
        else if ("h".equals(unit) || "hour".equals(unit)) window = "1h";
        else if ("d".equals(unit) || "day".equals(unit)) window = "1d";
        else if ("m".equals(unit) || "min".equals(unit) || "minute".equals(unit)) window = "1m";
        else return null;
        return mapOf("count", count, "window", window);
    }

    private static Map<String, Object> buildCapability(Tool t, String method) {
        Map<String, Object> capability = mapOf("version", 1, "enabled", true, "scope", t.scope);
        if (t.risk != null && !"low".equals(t.risk)) capability.put("risk", mapOf("level", t.risk));
        if (t.confirm || !t.confirmWhen.isEmpty() || t.confirmPrompt != null) {
            Map<String, Object> approval = new LinkedHashMap<>();
            if (t.confirm) approval.put("required", true);
            if (!t.confirmWhen.isEmpty()) approval.put("when", t.confirmWhen);
            if (t.confirmPrompt != null) approval.put("prompt", t.confirmPrompt);
            capability.put("approval", approval);
        }
        if (t.requiresSubject) capability.put("subject", mapOf("required", true));
        Map<String, Object> execution = new LinkedHashMap<>();
        if (Boolean.TRUE.equals(t.readonly) && !"GET".equals(method)) execution.put("readonly", true);
        if (Boolean.TRUE.equals(t.idempotent) && !"GET".equals(method)) execution.put("idempotent", true);
        Map<String, Object> rateLimit = normalizeRateLimit(t.rateLimit);
        if (rateLimit != null) execution.put("rate_limit", rateLimit);
        if (t.timeoutMs != null) execution.put("timeout_ms", t.timeoutMs);
        if (!execution.isEmpty()) capability.put("execution", execution);
        if (t.sensitive) capability.put("audit", mapOf("sensitive", true));
        Map<String, Object> guidance = new LinkedHashMap<>();
        if (t.whenToUse != null) guidance.put("when_to_use", t.whenToUse);
        if (t.returns != null) guidance.put("returns", t.returns);
        if (!t.examples.isEmpty()) guidance.put("examples", t.examples);
        if (!t.context.isEmpty()) guidance.put("context", t.context);
        if (!guidance.isEmpty()) capability.put("guidance", guidance);
        return capability;
    }

    public static Map<String, Object> buildOpenApiSpec(String title, String version, List<Tool> tools, Map<String, String> authzProbe) {
        Map<String, Object> paths = new LinkedHashMap<>();
        for (Tool t : tools) {
            String method = t.method.toUpperCase();
            String operationId = t.name != null && !t.name.isEmpty() ? t.name : defaultName(method, t.path);
            Map<String, Object> op = mapOf("operationId", operationId, "summary", t.description, "x-agent-capability", buildCapability(t, method));
            if (!t.tags.isEmpty()) op.put("tags", t.tags);
            if (t.deprecated) op.put("deprecated", true);

            List<Object> queryParams = new ArrayList<>();
            Map<String, Object> bodyProps = new LinkedHashMap<>();
            List<String> bodyRequired = new ArrayList<>();
            for (Param p : t.params) {
                Map<String, Object> schema = new LinkedHashMap<>();
                schema.put("type", p.type);
                if (p.description != null) schema.put("description", p.description);
                if (!p.enums.isEmpty()) schema.put("enum", p.enums);
                if (p.format != null) schema.put("format", p.format);
                if ("array".equals(p.type)) schema.put("items", mapOf("type", p.itemsType));
                String loc = p.in != null ? p.in : ("GET".equals(method) ? "query" : "body");
                if ("query".equals(loc) || "path".equals(loc)) {
                    queryParams.add(mapOf("name", p.name, "in", loc, "required", p.required, "schema", schema));
                } else {
                    bodyProps.put(p.name, schema);
                    if (p.required) bodyRequired.add(p.name);
                }
            }
            if (!queryParams.isEmpty()) op.put("parameters", queryParams);
            if (!bodyProps.isEmpty()) {
                Map<String, Object> schema = mapOf("type", "object", "properties", bodyProps);
                if (!bodyRequired.isEmpty()) schema.put("required", bodyRequired);
                op.put("requestBody", mapOf("content", mapOf("application/json", mapOf("schema", schema))));
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> pathItem = (Map<String, Object>) paths.computeIfAbsent(t.path, k -> new LinkedHashMap<String, Object>());
            pathItem.put(method.toLowerCase(), op);
        }
        Map<String, Object> spec = mapOf("openapi", "3.0.0", "info", mapOf("title", title, "version", version), "paths", paths);
        if (authzProbe != null) spec.put("x-bailing-authz-probe", authzProbe);
        return spec;
    }

    public static String toJson(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return quote((String) value);
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        if (value instanceof Map<?, ?>) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(quote(String.valueOf(e.getKey()))).append(':').append(toJson(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (value instanceof Iterable<?>) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) sb.append(',');
                first = false;
                sb.append(toJson(item));
            }
            return sb.append(']').toString();
        }
        return quote(String.valueOf(value));
    }

    public static Map<String, Object> mapOf(Object... kv) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) out.put(String.valueOf(kv[i]), kv[i + 1]);
        return out;
    }

    private static String sha256Hex(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return hex(md.digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String hmacHex(String secret, String msg) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(msg.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static String base64Url(String text) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default: sb.append(c < 0x20 ? String.format("\\u%04x", (int) c) : c);
            }
        }
        return sb.append('"').toString();
    }

    private static String defaultName(String method, String path) {
        return (method.toLowerCase() + "_" + path).replaceAll("[^a-zA-Z0-9]+", "_").replaceAll("^_+|_+$", "");
    }

    private static String safe(String s) { return s == null ? "" : s; }

    private static String firstJsonString(String json, String key, String fallback) {
        if (json == null) return fallback;
        String needle = "\"" + key + "\"";
        int p = json.indexOf(needle);
        if (p < 0) return fallback;
        int colon = json.indexOf(':', p + needle.length());
        int start = colon < 0 ? -1 : json.indexOf('"', colon);
        int end = start < 0 ? -1 : json.indexOf('"', start + 1);
        return start >= 0 && end > start ? json.substring(start + 1, end) : fallback;
    }

    public static final class ProbeResult {
        public final int status;
        public final Map<String, Object> body;
        public ProbeResult(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }
    }

    public static final class Param {
        public final String name;
        public String in;
        public String type = "string";
        public String itemsType = "string";
        public String description;
        public boolean required;
        public String format;
        public final List<String> enums = new ArrayList<>();
        public Param(String name) { this.name = Objects.requireNonNull(name); }
        public Param in(String v) { this.in = v; return this; }
        public Param type(String v) { this.type = v; return this; }
        public Param itemsType(String v) { this.itemsType = v; return this; }
        public Param description(String v) { this.description = v; return this; }
        public Param required(boolean v) { this.required = v; return this; }
        public Param format(String v) { this.format = v; return this; }
        public Param enums(String... values) { this.enums.addAll(List.of(values)); return this; }
    }

    public static final class Tool {
        public final String description;
        public final String scope;
        public final String path;
        public String method = "GET";
        public String name;
        public String risk = "low";
        public boolean confirm;
        public Boolean readonly;
        public boolean requiresSubject;
        public Boolean idempotent;
        public boolean sensitive;
        public String rateLimit;
        public Integer timeoutMs;
        public String whenToUse;
        public String returns;
        public String confirmPrompt;
        public boolean deprecated;
        public final List<Param> params = new ArrayList<>();
        public final List<Object> confirmWhen = new ArrayList<>();
        public final List<Object> examples = new ArrayList<>();
        public final List<Object> context = new ArrayList<>();
        public final List<String> tags = new ArrayList<>();
        public Tool(String description, String scope, String path) {
            this.description = Objects.requireNonNull(description);
            this.scope = Objects.requireNonNull(scope);
            this.path = Objects.requireNonNull(path);
        }
        public Tool method(String v) { this.method = v; return this; }
        public Tool name(String v) { this.name = v; return this; }
        public Tool risk(String v) { this.risk = v; return this; }
        public Tool confirm(boolean v) { this.confirm = v; return this; }
        public Tool readonly(boolean v) { this.readonly = v; return this; }
        public Tool requiresSubject(boolean v) { this.requiresSubject = v; return this; }
        public Tool idempotent(boolean v) { this.idempotent = v; return this; }
        public Tool sensitive(boolean v) { this.sensitive = v; return this; }
        public Tool rateLimit(String v) { this.rateLimit = v; return this; }
        public Tool timeoutMs(int v) { this.timeoutMs = v; return this; }
        public Tool whenToUse(String v) { this.whenToUse = v; return this; }
        public Tool returns(String v) { this.returns = v; return this; }
        public Tool confirmPrompt(String v) { this.confirmPrompt = v; return this; }
        public Tool deprecated(boolean v) { this.deprecated = v; return this; }
        public Tool param(Param p) { this.params.add(p); return this; }
        public Tool tag(String v) { this.tags.add(v); return this; }
    }

    public static final class HubClient {
        private final String baseUrl;
        private final String token;
        private final Duration timeout;
        private final HttpClient client;

        public HubClient(String baseUrl, String token) {
            this(baseUrl, token, Duration.ofSeconds(8));
        }

        public HubClient(String baseUrl, String token, Duration timeout) {
            this.baseUrl = baseUrl.replaceAll("/+$", "");
            this.token = token;
            this.timeout = timeout;
            this.client = HttpClient.newHttpClient();
        }

        public String run(String requestId, String route, String input, Map<String, Object> metadata) throws IOException, InterruptedException {
            return post("/run", mapOf("request_id", requestId, "route", route, "input", input, "metadata", metadata == null ? Map.of() : metadata));
        }

        public String getJob(String jobId) throws IOException, InterruptedException {
            return get("/jobs/" + URLEncoder.encode(jobId, StandardCharsets.UTF_8));
        }

        public String send(String requestId, String channel, Object to, String text) throws IOException, InterruptedException {
            return post("/send", mapOf("request_id", requestId, "channel", channel, "to", to, "text", text));
        }

        public String get(String path) throws IOException, InterruptedException {
            return request("GET", path, null);
        }

        public String post(String path, Map<String, Object> body) throws IOException, InterruptedException {
            return request("POST", path, toJson(body));
        }

        public String request(String method, String path, String body) throws IOException, InterruptedException {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(timeout)
                .header("Authorization", "Bearer " + token);
            if (body != null) b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
            else b.method(method, HttpRequest.BodyPublishers.noBody());
            HttpResponse<String> res = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() < 200 || res.statusCode() >= 300) throw new IOException("HTTP " + res.statusCode() + ": " + res.body());
            return res.body();
        }
    }
}
