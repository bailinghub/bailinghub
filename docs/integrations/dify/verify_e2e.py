#!/usr/bin/env python3
"""Run a minimal BailingHub /run -> /jobs/{id} integration check.

The client token is read from BAILINGHUB_TOKEN and is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


TERMINAL_STATUSES = {"done", "error", "rejected"}


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def request_json(method: str, url: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=payload,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            **({"Content-Type": "application/json"} if payload is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"{method} {url} returned HTTP {exc.code}: {detail[:500]}")
    except URLError as exc:
        fail(f"{method} {url} failed: {exc.reason}")

    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        fail(f"{method} {url} did not return JSON: {raw[:500]}")
    if not isinstance(decoded, dict):
        fail(f"{method} {url} returned a non-object JSON value")
    return decoded


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="BailingHub HTTPS origin, without a trailing slash")
    parser.add_argument("--route", required=True, help="A harmless route allowed for the dedicated Dify client")
    parser.add_argument(
        "--input",
        default="Return exactly DIFY_BAILINGHUB_E2E_OK. Do not call any business tool.",
        help="Harmless input sent through the selected route",
    )
    parser.add_argument("--timeout", type=int, default=180, help="Maximum polling time in seconds")
    parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("BAILINGHUB_TOKEN", "").strip()
    if not token:
        fail("set BAILINGHUB_TOKEN to a dedicated BailingHub client token")

    base_url = args.base_url.rstrip("/")
    request_id = f"dify-e2e:{int(time.time())}:{uuid.uuid4().hex[:12]}"
    created = request_json(
        "POST",
        f"{base_url}/run",
        token,
        {"request_id": request_id, "route": args.route, "input": args.input},
    )
    job_id = str(created.get("job_id", "")).strip()
    if not job_id:
        fail(f"/run response has no job_id: {json.dumps(created, ensure_ascii=False)}")
    if created.get("request_id") != request_id:
        fail("/run response request_id does not match the submitted idempotency key")

    print(f"created job_id={job_id} status={created.get('status', 'unknown')} route={created.get('route', args.route)}")
    deadline = time.monotonic() + max(1, args.timeout)
    last_status = ""
    job: dict[str, Any] = {}
    while time.monotonic() < deadline:
        job = request_json("GET", f"{base_url}/jobs/{job_id}", token)
        status = str(job.get("status", "")).strip()
        if status != last_status:
            print(f"status={status or 'unknown'}")
            last_status = status
        if status in TERMINAL_STATUSES:
            break
        time.sleep(max(0.2, args.interval))
    else:
        fail(f"job {job_id} did not reach a terminal status within {args.timeout}s")

    status = str(job.get("status", ""))
    if status != "done":
        detail = job.get("error") or job.get("result") or "no error detail"
        fail(f"job {job_id} ended with status={status}: {str(detail)[:500]}")

    print(f"PASS: BailingHub E2E completed for request_id={request_id} job_id={job_id}")


if __name__ == "__main__":
    main()
