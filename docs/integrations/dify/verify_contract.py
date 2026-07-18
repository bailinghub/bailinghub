#!/usr/bin/env python3
"""Static, dependency-free checks for the Dify -> BailingHub OpenAPI recipe."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


SPEC_PATH = Path(__file__).with_name("bailinghub-control-plane.openapi.json")
ALLOWED_OPERATIONS = {
    ("/run", "post", "bailinghub_start_job"),
    ("/jobs/{job_id}", "get", "bailinghub_get_job"),
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate(spec: dict[str, Any]) -> None:
    require(spec.get("openapi") == "3.0.3", "OpenAPI version must be 3.0.3")
    servers = spec.get("servers")
    require(isinstance(servers, list) and len(servers) == 1, "exactly one server URL is required")
    require(isinstance(servers[0].get("url"), str) and servers[0]["url"].startswith("https://"), "server URL must use HTTPS")

    operations: set[tuple[str, str, str]] = set()
    for path, path_item in spec.get("paths", {}).items():
        require(path in {"/run", "/jobs/{job_id}"}, f"direct business path is forbidden: {path}")
        for method in ("get", "post", "put", "patch", "delete"):
            operation = path_item.get(method)
            if operation is not None:
                operation_id = operation.get("operationId")
                require(isinstance(operation_id, str) and operation_id, f"missing operationId for {method.upper()} {path}")
                operations.add((path, method, operation_id))
    require(operations == ALLOWED_OPERATIONS, f"unexpected operations: {operations!r}")

    start = spec["paths"]["/run"]["post"]
    schema = start["requestBody"]["content"]["application/json"]["schema"]
    required = set(schema.get("required", []))
    require(required == {"request_id", "route", "input"}, "start request must require request_id, route, and input")
    require(schema.get("additionalProperties") is False, "start request must reject undeclared control-plane fields")
    require(set(schema.get("properties", {})) == required, "minimal recipe must not expose project, profile, tokens, or business credentials")
    for name in required:
        require(schema["properties"][name].get("type") == "string", f"{name} must be a string for Dify Swagger API Tool")

    status = spec["paths"]["/jobs/{job_id}"]["get"]
    path_params = [parameter for parameter in status.get("parameters", []) if parameter.get("in") == "path"]
    require(len(path_params) == 1 and path_params[0].get("name") == "job_id", "status tool must require job_id as its only path parameter")
    require(path_params[0].get("required") is True, "job_id path parameter must be required")

    scheme = spec["components"]["securitySchemes"]["bailinghubClientToken"]
    require(scheme.get("type") == "http" and scheme.get("scheme") == "bearer", "client authentication must use a bearer token")


def verify_negative_cases(spec: dict[str, Any]) -> None:
    missing_id = copy.deepcopy(spec)
    missing_id["paths"]["/run"]["post"]["requestBody"]["content"]["application/json"]["schema"]["required"].remove("request_id")
    try:
        validate(missing_id)
    except AssertionError:
        pass
    else:
        raise AssertionError("negative case failed: missing request_id was accepted")

    bypass = copy.deepcopy(spec)
    bypass["paths"]["/orders/refund"] = {"post": {"operationId": "refund_directly"}}
    try:
        validate(bypass)
    except AssertionError:
        pass
    else:
        raise AssertionError("negative case failed: direct business API path was accepted")


def main() -> None:
    with SPEC_PATH.open("r", encoding="utf-8") as handle:
        spec = json.load(handle)
    validate(spec)
    verify_negative_cases(spec)
    print("PASS: Dify -> BailingHub minimal integration contract is structurally valid.")


if __name__ == "__main__":
    main()
