#!/usr/bin/env python3

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


RECIPE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = RECIPE_DIR / "bailian-mcp-config.json"
EXPECTED_PACKAGE = "bailinghub-mcp-server@0.1.0"
EXPECTED_ENV_KEYS = {
    "BAILINGHUB_BASE_URL",
    "BAILINGHUB_CLIENT_TOKEN",
    "BAILINGHUB_ROUTE",
}
FORBIDDEN_ENV_MARKERS = {
    "ADMIN",
    "APPROVAL",
    "BUSINESS",
    "EXECUTOR",
    "MODEL",
    "SERVER_TOKEN",
    "TOOL_TOKEN",
}
ROUTE_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> None:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {CONFIG_PATH.name}: {error}")

    require(set(config) == {"mcpServers"}, "top level must contain only mcpServers")
    servers = config["mcpServers"]
    require(isinstance(servers, dict), "mcpServers must be an object")
    require(set(servers) == {"bailinghub"}, "recipe must define exactly one bailinghub server")

    server = servers["bailinghub"]
    require(isinstance(server, dict), "bailinghub server must be an object")
    require(
        set(server) == {"type", "command", "args", "env"},
        "bailinghub server must contain only type, command, args, and env",
    )
    require(server["type"] == "stdio", "Bailian npx deployment must use stdio")
    require(server["command"] == "npx", "command must be npx")
    require(
        server["args"] == ["-y", EXPECTED_PACKAGE],
        f"args must pin the public package to {EXPECTED_PACKAGE}",
    )

    env = server["env"]
    require(isinstance(env, dict), "env must be an object")
    require(set(env) == EXPECTED_ENV_KEYS, "env must contain only the three client settings")

    base_url = env["BAILINGHUB_BASE_URL"]
    require(isinstance(base_url, str), "BAILINGHUB_BASE_URL must be a string")
    parsed = urlparse(base_url)
    require(parsed.scheme == "https", "cloud recipe must use an HTTPS BailingHub URL")
    require(bool(parsed.netloc), "BAILINGHUB_BASE_URL must include a host")
    require(not parsed.username and not parsed.password, "base URL must not embed credentials")
    require(not parsed.query and not parsed.fragment, "base URL must not include query or fragment")

    token = env["BAILINGHUB_CLIENT_TOKEN"]
    require(
        token == "replace-with-a-route-scoped-client-token",
        "public recipe must contain the documented token placeholder, never a real token",
    )

    route = env["BAILINGHUB_ROUTE"]
    require(isinstance(route, str) and bool(ROUTE_PATTERN.fullmatch(route)), "route is invalid")
    require(route == "bailian_assistant", "public recipe route must remain bailian_assistant")

    for key in env:
        upper_key = key.upper()
        require(
            not any(marker in upper_key for marker in FORBIDDEN_ENV_MARKERS),
            f"privileged credential setting is forbidden: {key}",
        )

    print("PASS: Bailian to BailingHub MCP recipe is structurally valid.")


if __name__ == "__main__":
    main()
