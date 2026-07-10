#!/usr/bin/env python3
# 百灵中枢 · 验签/签名参考实现（Python 3，零依赖，仅标准库 hashlib + hmac）。
# 任意语言照此翻 ~40 行即可对接，无需读 PHP。生产可直接复制本文件，或据此实现。
#
# 签名方案统一为 sha256=（算法名，非版本号；GitHub webhook 同款约定）。构造见 CONTRACT.md §2.4b：
#   工具调用 / spec 拉取： "sha256=" + HMAC_SHA256(secret, "<ts>.<METHOD>.<path?query>.<sha256hex(body)>.<On-Behalf-Of>.<Job-Id>")
#   回调 / webhook 送达：  "sha256=" + HMAC_SHA256(secret, "<毫秒ts>.<原始body>")      ← 时间戳是毫秒，构造更短（无 method/path/主体）
# 直接 `python3 bailing-tool-verify.py` 跑自检：比对下方冻结测试向量（与 CONTRACT §2.4b、bailing-tool-verify.mjs 逐字一致）。
# 自检通过 = 你的 canonical 串拼对了，可放心连真 hub。
import hashlib
import hmac
import json
import time


def _sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _hmac_hex(secret: str, msg: str) -> str:
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def _tool_mac(secret, ts, method, path_with_query, body="", on_behalf_of="", job_id=""):
    return _hmac_hex(secret, f"{ts}.{method.upper()}.{path_with_query}.{_sha256hex(body)}.{on_behalf_of}.{job_id}")


def sign_tool_call(secret, ts, method, path_with_query, body="", on_behalf_of="", job_id=""):
    """生成工具调用签名头值（'sha256=...'）。业务侧一般只需 verify_tool_call；本函数便于自检与调试。"""
    return "sha256=" + _tool_mac(secret, ts, method, path_with_query, body, on_behalf_of, job_id)


def verify_tool_call(secret, method, path_with_query, body, timestamp, signature,
                     on_behalf_of="", job_id="", window_sec=300) -> bool:
    """验工具调用签名。True=确实是中枢发的——之后仍须按 on_behalf_of 用你自己的权限表做授权裁决（验签 ≠ 授权）。
    关键：必须用收到的【原始 body 字节】算 sha256（中枢「签所发即所发」），别把 JSON 重新序列化后再签。"""
    if not signature or abs(int(time.time()) - int(timestamp)) >= window_sec:
        return False  # 时间窗防重放
    return hmac.compare_digest(sign_tool_call(secret, timestamp, method, path_with_query, body, on_behalf_of, job_id), signature)


def authz_probe_response(secret, method, path_with_query, body, timestamp, signature, authorize,
                         on_behalf_of="", job_id=""):
    """独立授权探针端点参考实现。正确行为是验签通过、authorize 对不存在主体返回 False。"""
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


def verify_callback(secret, raw_body, timestamp, signature, window_ms=300000) -> bool:
    """验回调 / webhook 送达签名（毫秒时间戳，构造 = '<ts>.<原始body>'）。"""
    if not signature or abs(int(time.time() * 1000) - int(timestamp)) >= window_ms:
        return False
    return hmac.compare_digest("sha256=" + _hmac_hex(secret, f"{timestamp}.{raw_body}"), signature)


# ---------- 自检：直接运行本文件即比对冻结测试向量 ----------
if __name__ == "__main__":
    SECRET = "bailing-test-secret"
    cases = [
        ("工具调用",
         sign_tool_call(SECRET, 1718000000, "POST", "/goods/create", '{"title":"test","price":9.9}', "179:1", "job-test-001"),
         "sha256=6deb8dbd54268eee4631129b442acbc9797431642473326a10a5b0826431aae5"),
        ("spec 拉取（空体/空主体/空任务）",
         sign_tool_call(SECRET, 1718000000, "GET", "/bailing/tools.json"),
         "sha256=505ab99763cd20b50ba4066ee2ac315fe6af12a8638e7dabef63508abddedc74"),
        ("回调（毫秒时间戳）",
         "sha256=" + _hmac_hex(SECRET, '1718000000000.{"kind":"delivery","job_id":"job-test-001","status":"done"}'),
         "sha256=ca81d247422d926be3066f065a8c92a1beaffc6f37f01ef7d3e2c47b46f63210"),
    ]
    bad = 0
    for name, got, want in cases:
        ok = got == want
        print(f"{'✓' if ok else '✗'} {name}\n    {got}")
        if not ok:
            bad += 1
            print(f"    期望 {want}")
    probe_ts = str(int(time.time()))
    probe_body = '{"subject":"__bailing_authz_probe__:nobody","reason":"bailing-authz-probe","expect":"deny"}'
    probe_sig = sign_tool_call(SECRET, probe_ts, "POST", "/bailing/authz-probe", probe_body)
    status, probe = authz_probe_response(
        SECRET,
        "POST",
        "/bailing/authz-probe",
        probe_body,
        probe_ts,
        probe_sig,
        lambda subject: subject != "__bailing_authz_probe__:nobody",
    )
    probe_ok = status == 200 and probe["authorized"] is False
    print(f"{'✓' if probe_ok else '✗'} 授权探针默认拒绝")
    if not probe_ok:
        bad += 1
    print(f"\n{bad} 个向量不匹配——实现与契约不一致。" if bad else "\n全部匹配 ✓ 实现与 CONTRACT §2.4b 一致，可连真 hub。")
    raise SystemExit(1 if bad else 0)
