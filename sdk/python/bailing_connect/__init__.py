import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional


def _sha256hex(body: str) -> str:
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


def _hmac_hex(secret: str, msg: str) -> str:
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("utf-8").rstrip("=")


def sign_tool_call(secret: str, ts: Any, method: str, path_with_query: str, body: str = "", on_behalf_of: str = "", job_id: str = "") -> str:
    msg = f"{ts}.{method.upper()}.{path_with_query}.{_sha256hex(body)}.{on_behalf_of}.{job_id}"
    return "sha256=" + _hmac_hex(secret, msg)


def verify_tool_call(secret: str, method: str, path_with_query: str, body: str, timestamp: Any, signature: str,
                     on_behalf_of: str = "", job_id: str = "", window_sec: int = 300) -> bool:
    if not signature or abs(int(time.time()) - int(timestamp)) >= window_sec:
        return False
    expected = sign_tool_call(secret, timestamp, method, path_with_query, body, on_behalf_of, job_id)
    return hmac.compare_digest(expected, signature)


def verify_callback(secret: str, raw_body: str, timestamp: Any, signature: str, window_ms: int = 300000) -> bool:
    if not signature or abs(int(time.time() * 1000) - int(timestamp)) >= window_ms:
        return False
    return hmac.compare_digest("sha256=" + _hmac_hex(secret, f"{timestamp}.{raw_body}"), signature)


def sign_ticket(client_token: str, uid: str, ttl_seconds: int = 7200, expires_at: Optional[int] = None) -> str:
    subject = str(uid or "")
    if not subject or len(subject.encode("utf-8")) > 64:
        raise ValueError("uid 长度需 1~64 字节")
    exp = int(expires_at if expires_at is not None else time.time() + ttl_seconds)
    payload = _b64url(json.dumps({"uid": subject, "exp": exp}, ensure_ascii=False, separators=(",", ":")))
    return "v1." + payload + "." + _hmac_hex(client_token, payload)


def authz_probe_response(secret: str, method: str, path_with_query: str, body: str, timestamp: Any, signature: str,
                         authorize: Callable[[str], bool], on_behalf_of: str = "", job_id: str = ""):
    ok = verify_tool_call(secret, method, path_with_query, body, timestamp, signature, on_behalf_of, job_id)
    if not ok:
        return 401, {"authorized": False, "error": "bad_signature"}
    subject = on_behalf_of
    try:
        parsed = json.loads(body or "{}")
        if isinstance(parsed.get("subject"), str):
            subject = parsed["subject"]
    except Exception:
        subject = on_behalf_of
    try:
        authorized = bool(authorize(subject))
    except Exception:
        authorized = False
    return 200, {"authorized": authorized}


def param(name: str, **opts):
    return {"name": name, **opts}


def tool(**opts):
    if not opts.get("description"):
        raise ValueError("tool.description 必填")
    if not opts.get("scope"):
        raise ValueError("tool.scope 必填")
    if not str(opts.get("path", "")).startswith("/"):
        raise ValueError("tool.path 必须以 / 开头")
    return {
        "description": opts["description"],
        "scope": opts["scope"],
        "path": opts["path"],
        "method": str(opts.get("method", "GET")).upper(),
        "name": opts.get("name"),
        "risk": opts.get("risk", "low"),
        "confirm": bool(opts.get("confirm", False)),
        "confirmWhen": opts.get("confirmWhen", []),
        "readonly": opts.get("readonly"),
        "requiresSubject": bool(opts.get("requiresSubject", False)),
        "idempotent": opts.get("idempotent"),
        "sensitive": bool(opts.get("sensitive", False)),
        "rateLimit": opts.get("rateLimit"),
        "timeoutMs": opts.get("timeoutMs"),
        "whenToUse": opts.get("whenToUse"),
        "returns": opts.get("returns"),
        "examples": opts.get("examples", []),
        "confirmPrompt": opts.get("confirmPrompt"),
        "context": opts.get("context", []),
        "tags": opts.get("tags", []),
        "deprecated": bool(opts.get("deprecated", False)),
        "params": opts.get("params", []),
    }


def _normalize_rate_limit(value: Any) -> Optional[Dict[str, Any]]:
    if not value:
        return None
    if isinstance(value, dict) and "count" in value and "window" in value:
        return {"count": int(value["count"]), "window": str(value["window"])}
    text = str(value).replace(" ", "").lower()
    if "/" not in text:
        return None
    count_text, unit = text.split("/", 1)
    if not count_text.isdigit():
        return None
    window = "1m"
    if unit in ("s", "sec", "second"):
        window = "1s"
    elif unit in ("h", "hour"):
        window = "1h"
    elif unit in ("d", "day"):
        window = "1d"
    elif unit not in ("m", "min", "minute"):
        return None
    return {"count": int(count_text), "window": window}


def _build_capability(t: Dict[str, Any], method: str) -> Dict[str, Any]:
    capability: Dict[str, Any] = {"version": 1, "enabled": True, "scope": t["scope"]}
    if t.get("risk") and t["risk"] != "low":
        capability["risk"] = {"level": t["risk"]}
    if t.get("confirm") or t.get("confirmWhen") or t.get("confirmPrompt"):
        approval: Dict[str, Any] = {}
        if t.get("confirm"):
            approval["required"] = True
        if t.get("confirmWhen"):
            approval["when"] = t["confirmWhen"]
        if t.get("confirmPrompt"):
            approval["prompt"] = t["confirmPrompt"]
        capability["approval"] = approval
    if t.get("requiresSubject"):
        capability["subject"] = {"required": True}
    execution: Dict[str, Any] = {}
    if t.get("readonly") is True and method != "GET":
        execution["readonly"] = True
    if t.get("idempotent") is True and method != "GET":
        execution["idempotent"] = True
    rate_limit = _normalize_rate_limit(t.get("rateLimit"))
    if rate_limit:
        execution["rate_limit"] = rate_limit
    if t.get("timeoutMs") is not None:
        execution["timeout_ms"] = t["timeoutMs"]
    if execution:
        capability["execution"] = execution
    if t.get("sensitive"):
        capability["audit"] = {"sensitive": True}
    guidance: Dict[str, Any] = {}
    if t.get("whenToUse"):
        guidance["when_to_use"] = t["whenToUse"]
    if t.get("returns"):
        guidance["returns"] = t["returns"]
    if t.get("examples"):
        guidance["examples"] = t["examples"]
    if t.get("context"):
        guidance["context"] = t["context"]
    if guidance:
        capability["guidance"] = guidance
    return capability


def build_openapi_spec(title: str = "业务系统", version: str = "1.0.0", tools: Optional[List[Dict[str, Any]]] = None,
                       authz_probe: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    paths: Dict[str, Any] = {}
    names = set()
    for t in tools or []:
        method = str(t.get("method", "GET")).upper()
        if method not in ["GET", "POST", "PUT", "PATCH", "DELETE"]:
            raise ValueError(f"{t.get('name') or t.get('path')}: method 不支持 {method}")
        operation_id = t.get("name") or _default_name(method, t["path"])
        if operation_id in names:
            raise ValueError(f"operationId 重复：{operation_id}")
        names.add(operation_id)
        op: Dict[str, Any] = {
            "operationId": operation_id,
            "summary": t["description"],
            "x-agent-capability": _build_capability(t, method),
        }
        if t.get("tags"):
            op["tags"] = t["tags"]
        if t.get("deprecated"):
            op["deprecated"] = True

        query_params = []
        body_props = {}
        body_required = []
        for p in t.get("params", []):
            schema = {"type": p.get("type", "string")}
            if p.get("description"):
                schema["description"] = p["description"]
            if p.get("enum"):
                schema["enum"] = p["enum"]
            if "default" in p:
                schema["default"] = p["default"]
            if p.get("format"):
                schema["format"] = p["format"]
            if schema["type"] == "array":
                schema["items"] = {"type": p.get("itemsType", "string")}
            loc = p.get("in") or ("query" if method == "GET" else "body")
            if loc == "query":
                query_params.append({"name": p["name"], "in": "query", "required": bool(p.get("required", False)), "schema": schema})
            else:
                body_props[p["name"]] = schema
                if p.get("required"):
                    body_required.append(p["name"])
        if query_params:
            op["parameters"] = query_params
        if body_props:
            op["requestBody"] = {"content": {"application/json": {"schema": {
                "type": "object",
                "properties": body_props,
                **({"required": body_required} if body_required else {}),
            }}}}
        paths.setdefault(t["path"], {})[method.lower()] = op
    spec = {"openapi": "3.0.0", "info": {"title": title, "version": version}, "paths": paths}
    if authz_probe:
        spec["x-bailing-authz-probe"] = authz_probe
    return spec


def _default_name(method: str, path: str) -> str:
    out = "".join(ch if ch.isalnum() else "_" for ch in f"{method.lower()}_{path}").strip("_")
    while "__" in out:
        out = out.replace("__", "_")
    return out[:64]


class HubClient:
    def __init__(self, base_url: str, token: str, timeout: float = 8.0):
        if not base_url:
            raise ValueError("base_url 必填")
        if not token:
            raise ValueError("token 必填")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def run(self, request_id: str, route: str, input: str, metadata: Optional[Dict[str, Any]] = None,
            callback_url: Optional[str] = None, wait_ms: Optional[int] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "request_id": request_id,
            "route": route,
            "input": input,
            "metadata": metadata or {},
        }
        if callback_url:
            payload["callback_url"] = callback_url
        if wait_ms is not None:
            payload["wait_ms"] = wait_ms
        return self.post("/run", payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        return self.get("/jobs/" + urllib.parse.quote(str(job_id), safe=""))

    def send(self, request_id: str, channel: str, to: Any, text: str,
             images: Optional[List[str]] = None, files: Optional[List[Dict[str, Any]]] = None,
             card: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "request_id": request_id,
            "channel": channel,
            "to": to,
            "text": text,
        }
        if images:
            payload["images"] = images
        if files:
            payload["files"] = files
        if card:
            payload["card"] = card
        return self.post("/send", payload)

    def get(self, path: str) -> Dict[str, Any]:
        return self.request("GET", path)

    def post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("POST", path, body)

    def request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = None
        headers = {"Authorization": "Bearer " + self.token}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw or "{}")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except Exception:
                payload = {"error": raw or str(exc)}
            raise RuntimeError(payload.get("error") or payload.get("message") or f"HTTP {exc.code}") from exc
