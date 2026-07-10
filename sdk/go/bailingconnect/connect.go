package bailingconnect

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func SignTicket(clientToken, uid string, ttlSeconds int64) (string, error) {
	return SignTicketExpiresAt(clientToken, uid, time.Now().Unix()+ttlSeconds)
}

func SignTicketExpiresAt(clientToken, uid string, expiresAt int64) (string, error) {
	if uid == "" || len([]byte(uid)) > 64 {
		return "", errors.New("uid must be 1..64 bytes")
	}
	body, _ := json.Marshal(map[string]any{"uid": uid, "exp": expiresAt})
	payload := base64.RawURLEncoding.EncodeToString(body)
	return "v1." + payload + "." + hmacHex(clientToken, payload), nil
}

func SignToolCall(secret string, ts int64, method, pathWithQuery, body, onBehalfOf, jobID string) string {
	msg := fmt.Sprintf("%d.%s.%s.%s.%s.%s", ts, strings.ToUpper(method), pathWithQuery, sha256Hex(body), onBehalfOf, jobID)
	return "sha256=" + hmacHex(secret, msg)
}

func VerifyToolCall(secret, method, pathWithQuery, body string, timestamp int64, signature, onBehalfOf, jobID string, windowSec int64) bool {
	if signature == "" || abs(time.Now().Unix()-timestamp) >= windowSec {
		return false
	}
	expected := SignToolCall(secret, timestamp, method, pathWithQuery, body, onBehalfOf, jobID)
	return hmac.Equal([]byte(expected), []byte(signature))
}

func VerifyCallback(secret, rawBody string, timestampMs int64, signature string, windowMs int64) bool {
	if signature == "" || abs(time.Now().UnixMilli()-timestampMs) >= windowMs {
		return false
	}
	expected := "sha256=" + hmacHex(secret, fmt.Sprintf("%d.%s", timestampMs, rawBody))
	return hmac.Equal([]byte(expected), []byte(signature))
}

func AuthzProbeResponse(secret, method, pathWithQuery, body string, timestamp int64, signature, onBehalfOf, jobID string, authorize func(string) bool) (int, map[string]any) {
	if !VerifyToolCall(secret, method, pathWithQuery, body, timestamp, signature, onBehalfOf, jobID, 300) {
		return 401, map[string]any{"authorized": false, "error": "bad_signature"}
	}
	subject := onBehalfOf
	var parsed map[string]any
	if json.Unmarshal([]byte(body), &parsed) == nil {
		if v, ok := parsed["subject"].(string); ok {
			subject = v
		}
	}
	authorized := false
	if authorize != nil {
		authorized = authorize(subject)
	}
	return 200, map[string]any{"authorized": authorized}
}

type Param struct {
	Name        string
	In          string
	Type        string
	ItemsType   string
	Description string
	Required    bool
	Format      string
	Enum        []string
}

type Tool struct {
	Name            string
	Description     string
	Scope           string
	Path            string
	Method          string
	Risk            string
	Confirm         bool
	ConfirmWhen     []map[string]any
	Readonly        *bool
	RequiresSubject bool
	Idempotent      *bool
	Sensitive       bool
	RateLimit       string
	TimeoutMs       *int
	WhenToUse       string
	Returns         string
	Examples        []any
	ConfirmPrompt   string
	Context         []any
	Tags            []string
	Deprecated      bool
	Params          []Param
}

func normalizeRateLimit(value string) map[string]any {
	text := strings.ToLower(strings.ReplaceAll(value, " ", ""))
	if text == "" {
		return nil
	}
	m := regexp.MustCompile(`^(\d+)/(s|sec|second|min|minute|h|hour|d|day)$`).FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	window := "1m"
	switch m[2] {
	case "s", "sec", "second":
		window = "1s"
	case "h", "hour":
		window = "1h"
	case "d", "day":
		window = "1d"
	}
	return map[string]any{"count": atoi(m[1]), "window": window}
}

func buildCapability(t Tool, method string) map[string]any {
	capability := map[string]any{"version": 1, "enabled": true, "scope": t.Scope}
	if t.Risk != "" && t.Risk != "low" {
		capability["risk"] = map[string]any{"level": t.Risk}
	}
	if t.Confirm || len(t.ConfirmWhen) > 0 || t.ConfirmPrompt != "" {
		approval := map[string]any{}
		if t.Confirm {
			approval["required"] = true
		}
		if len(t.ConfirmWhen) > 0 {
			approval["when"] = t.ConfirmWhen
		}
		if t.ConfirmPrompt != "" {
			approval["prompt"] = t.ConfirmPrompt
		}
		capability["approval"] = approval
	}
	if t.RequiresSubject {
		capability["subject"] = map[string]any{"required": true}
	}
	execution := map[string]any{}
	if t.Readonly != nil && *t.Readonly && method != "GET" {
		execution["readonly"] = true
	}
	if t.Idempotent != nil && *t.Idempotent && method != "GET" {
		execution["idempotent"] = true
	}
	if rl := normalizeRateLimit(t.RateLimit); rl != nil {
		execution["rate_limit"] = rl
	}
	if t.TimeoutMs != nil {
		execution["timeout_ms"] = *t.TimeoutMs
	}
	if len(execution) > 0 {
		capability["execution"] = execution
	}
	if t.Sensitive {
		capability["audit"] = map[string]any{"sensitive": true}
	}
	guidance := map[string]any{}
	if t.WhenToUse != "" {
		guidance["when_to_use"] = t.WhenToUse
	}
	if t.Returns != "" {
		guidance["returns"] = t.Returns
	}
	if len(t.Examples) > 0 {
		guidance["examples"] = t.Examples
	}
	if len(t.Context) > 0 {
		guidance["context"] = t.Context
	}
	if len(guidance) > 0 {
		capability["guidance"] = guidance
	}
	return capability
}

func BuildOpenAPISpec(title, version string, tools []Tool, authzProbe map[string]string) map[string]any {
	paths := map[string]any{}
	for _, t := range tools {
		method := strings.ToUpper(or(t.Method, "GET"))
		operationID := t.Name
		if operationID == "" {
			operationID = defaultName(method, t.Path)
		}
		op := map[string]any{
			"operationId":        operationID,
			"summary":            t.Description,
			"x-agent-capability": buildCapability(t, method),
		}
		if len(t.Tags) > 0 {
			op["tags"] = t.Tags
		}
		if t.Deprecated {
			op["deprecated"] = true
		}

		queryParams := []any{}
		bodyProps := map[string]any{}
		bodyRequired := []string{}
		for _, p := range t.Params {
			typ := or(p.Type, "string")
			schema := map[string]any{"type": typ}
			if p.Description != "" {
				schema["description"] = p.Description
			}
			if len(p.Enum) > 0 {
				schema["enum"] = p.Enum
			}
			if p.Format != "" {
				schema["format"] = p.Format
			}
			if typ == "array" {
				schema["items"] = map[string]any{"type": or(p.ItemsType, "string")}
			}
			loc := p.In
			if loc == "" {
				if method == "GET" {
					loc = "query"
				} else {
					loc = "body"
				}
			}
			if loc == "query" || loc == "path" {
				queryParams = append(queryParams, map[string]any{"name": p.Name, "in": loc, "required": p.Required, "schema": schema})
			} else {
				bodyProps[p.Name] = schema
				if p.Required {
					bodyRequired = append(bodyRequired, p.Name)
				}
			}
		}
		if len(queryParams) > 0 {
			op["parameters"] = queryParams
		}
		if len(bodyProps) > 0 {
			schema := map[string]any{"type": "object", "properties": bodyProps}
			if len(bodyRequired) > 0 {
				schema["required"] = bodyRequired
			}
			op["requestBody"] = map[string]any{"content": map[string]any{"application/json": map[string]any{"schema": schema}}}
		}
		pathItem, _ := paths[t.Path].(map[string]any)
		if pathItem == nil {
			pathItem = map[string]any{}
			paths[t.Path] = pathItem
		}
		pathItem[strings.ToLower(method)] = op
	}
	spec := map[string]any{"openapi": "3.0.0", "info": map[string]any{"title": title, "version": version}, "paths": paths}
	if authzProbe != nil {
		spec["x-bailing-authz-probe"] = authzProbe
	}
	return spec
}

type HubClient struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

func NewHubClient(baseURL, token string) *HubClient {
	return &HubClient{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTPClient: &http.Client{Timeout: 8 * time.Second}}
}

func (c *HubClient) Run(requestID, route, input string, metadata map[string]any) ([]byte, error) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	return c.Post("/run", map[string]any{"request_id": requestID, "route": route, "input": input, "metadata": metadata})
}

func (c *HubClient) GetJob(jobID string) ([]byte, error) {
	return c.Get("/jobs/" + url.PathEscape(jobID))
}

func (c *HubClient) Send(requestID, channel string, to any, text string) ([]byte, error) {
	return c.Post("/send", map[string]any{"request_id": requestID, "channel": channel, "to": to, "text": text})
}

func (c *HubClient) Get(path string) ([]byte, error) {
	return c.Request("GET", path, nil)
}

func (c *HubClient) Post(path string, body map[string]any) ([]byte, error) {
	raw, _ := json.Marshal(body)
	return c.Request("POST", path, raw)
}

func (c *HubClient) Request(method, path string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return raw, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(raw))
	}
	return raw, nil
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacHex(secret, msg string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}

func defaultName(method, path string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9]+`)
	out := strings.Trim(re.ReplaceAllString(strings.ToLower(method)+"_"+path, "_"), "_")
	if len(out) > 64 {
		return out[:64]
	}
	return out
}

func or(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
