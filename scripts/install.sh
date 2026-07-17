#!/bin/sh
set -eu

APP_NAME="bailinghub"
SOURCE_TGZ="${BAILING_SOURCE_TGZ:-https://www.bailinghub.com/connect/bailinghub-source.tgz}"
REPO="${BAILING_REPO:-}"
REF="${BAILING_REF:-main}"
INSTALL_DIR="${BAILING_INSTALL_DIR:-$HOME/bailinghub}"
INSTALL_MODE="${BAILING_INSTALL_MODE:-image}"
PUBLIC_PORT="${BAILING_PUBLIC_PORT:-18900}"
DEMO_PORT="${BAILING_DEMO_PUBLIC_PORT:-19080}"
MYSQL_PORT="${BAILING_MYSQL_PUBLIC_PORT:-3307}"
SKIP_SMOKE="${BAILING_INSTALL_SKIP_SMOKE:-0}"
PUBLIC_HOST="${BAILING_PUBLIC_HOST:-}"
SKIP_PORT_CHECK="${BAILING_SKIP_PORT_CHECK:-0}"
DEFAULT_IMAGE_REGISTRY="crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com"
DEFAULT_IMAGE_NAMESPACE="bailinghub"
DEFAULT_MYSQL_IMAGE="$DEFAULT_IMAGE_REGISTRY/$DEFAULT_IMAGE_NAMESPACE/bailing-mysql:8.4"
COMPOSE_FILES=""

log() { printf '%s\n' "[$APP_NAME] $*"; }
die() { printf '%s\n' "[$APP_NAME] ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "需要 root 权限执行：$*。请安装 sudo 或切换 root 后重试。"
  fi
}

secret() {
  if have openssl; then
    openssl rand -base64 24 | tr -d '\n'
  else
    date +%s | sha256sum | awk '{print $1}'
  fi
}

install_packages() {
  if have git && have curl && have tar; then return; fi
  if have apt-get; then
    log "安装基础工具 git/curl/tar/ca-certificates"
    as_root apt-get update
    as_root apt-get install -y ca-certificates curl git tar openssl
    return
  fi
  die "未找到 git/curl/tar，且当前系统没有 apt-get。请先安装 git、curl、tar、openssl。"
}

install_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then return; fi
  if ! have apt-get; then
    die "未找到 Docker Compose。请先安装 Docker Engine 与 compose plugin。"
  fi
  log "安装 Docker 与 Docker Compose plugin"
  as_root apt-get update
  as_root apt-get install -y docker.io docker-compose-plugin || as_root apt-get install -y docker.io docker-compose-v2
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker 已安装但 docker compose 不可用，请检查 Docker Compose plugin。"
  fi
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    as_root docker "$@"
  fi
}

compose_cmd() {
  if [ -n "$COMPOSE_FILES" ]; then
    # shellcheck disable=SC2086
    docker_cmd compose $COMPOSE_FILES "$@"
  else
    docker_cmd compose "$@"
  fi
}

validate_port() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) die "$name 必须是 1-65535 之间的端口号，当前为：$value" ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    die "$name 必须是 1-65535 之间的端口号，当前为：$value"
  fi
}

port_in_use() {
  port="$1"
  if have ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$port$"
    return $?
  fi
  if have lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if have netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$port$"
    return $?
  fi
  return 1
}

preflight_environment() {
  validate_port BAILING_PUBLIC_PORT "$PUBLIC_PORT"
  validate_port BAILING_DEMO_PUBLIC_PORT "$DEMO_PORT"
  validate_port BAILING_MYSQL_PUBLIC_PORT "$MYSQL_PORT"
  if [ "$PUBLIC_PORT" = "$DEMO_PORT" ] || [ "$PUBLIC_PORT" = "$MYSQL_PORT" ] || [ "$DEMO_PORT" = "$MYSQL_PORT" ]; then
    die "三个对外端口不能重复：BAILING_PUBLIC_PORT=$PUBLIC_PORT, BAILING_DEMO_PUBLIC_PORT=$DEMO_PORT, BAILING_MYSQL_PUBLIC_PORT=$MYSQL_PORT"
  fi

  arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$arch" in
    x86_64|amd64) ;;
    aarch64|arm64)
      if [ "$INSTALL_MODE" = "image" ] || [ "$INSTALL_MODE" = "images" ]; then
        if [ "${BAILING_ALLOW_UNTESTED_ARCH:-0}" != "1" ]; then
          die "当前机器架构为 $arch。官方预构建镜像首版优先覆盖 x86_64；请改用 BAILING_INSTALL_MODE=source，或设置 BAILING_ALLOW_UNTESTED_ARCH=1 后自行确认镜像兼容。"
        fi
      fi
      ;;
    *)
      if [ "${BAILING_ALLOW_UNTESTED_ARCH:-0}" != "1" ]; then
        die "当前机器架构为 $arch，未在安装脚本白名单内。确认可运行后可设置 BAILING_ALLOW_UNTESTED_ARCH=1。"
      fi
      ;;
  esac

  if [ "$SKIP_PORT_CHECK" != "1" ]; then
    for item in "$PUBLIC_PORT:中枢控制台" "$DEMO_PORT:demo 业务系统" "$MYSQL_PORT:demo MySQL"; do
      port="${item%%:*}"
      label="${item#*:}"
      if port_in_use "$port"; then
        die "$label 端口 $port 已被占用。请换端口，例如：BAILING_PUBLIC_PORT=28900 BAILING_DEMO_PUBLIC_PORT=29080 BAILING_MYSQL_PUBLIC_PORT=13307 curl -fsSL https://www.bailinghub.com/install.sh | sh"
      fi
    done
  fi
}

preflight_docker() {
  if ! docker_cmd info >/dev/null 2>&1; then
    die "Docker daemon 不可用。请确认 Docker 服务已启动，当前用户可运行 docker，或已安装 sudo。"
  fi
}

preflight_images() {
  APP_DIR="$1"
  cd "$APP_DIR"
  if [ "$INSTALL_MODE" = "image" ] || [ "$INSTALL_MODE" = "images" ]; then
    log "检查官方镜像是否可拉取"
    if ! compose_cmd pull; then
      cat >&2 <<'EOF'

[bailinghub] 官方镜像拉取失败。

常见原因：
1. 当前网络无法访问官方镜像仓库；
2. 指定的 BAILING_IMAGE_TAG 尚未发布；
3. 当前机器架构暂未提供对应镜像。

可选处理：
  BAILING_INSTALL_MODE=source curl -fsSL https://www.bailinghub.com/install.sh | sh

或显式指定你自己的镜像仓库：
  BAILINGHUB_IMAGE=<registry>/bailinghub:<tag> \
  BAILING_DEMO_BUSINESS_IMAGE=<registry>/bailing-demo-business:<tag> \
  BAILING_MYSQL_IMAGE=<registry>/bailing-mysql:8.4 \
  curl -fsSL https://www.bailinghub.com/install.sh | sh
EOF
      exit 1
    fi
  else
    log "检查源码构建基础镜像"
    if ! compose_cmd pull mysql; then
      die "MySQL 基础镜像拉取失败。请检查 BAILING_MYSQL_IMAGE 或当前网络。"
    fi
    node_image="${BAILING_NODE_IMAGE:-node:22-bookworm-slim}"
    if ! docker_cmd pull "$node_image"; then
      die "Node 基础镜像 $node_image 拉取失败。请配置 Docker registry mirror，或设置 BAILING_NODE_IMAGE 为当前网络可访问的等价镜像。"
    fi
  fi
}

wait_hub_ready() {
  URL="http://127.0.0.1:$PUBLIC_PORT/health"
  log "等待中枢就绪：$URL"
  i=0
  while [ "$i" -lt 90 ]; do
    if curl -fsS "$URL" >/dev/null 2>&1; then
      log "中枢已就绪"
      return
    fi
    i=$((i + 1))
    sleep 2
  done
  compose_cmd ps || true
  compose_cmd logs --tail=120 bailinghub || true
  die "中枢启动后 180 秒内未通过健康检查：$URL"
}

resolve_app_dir() {
  if [ -f "./package.json" ] && [ -f "./docker-compose.yml" ] && [ -d "./scripts" ]; then
    pwd
    return
  fi
  printf '%s\n' "$INSTALL_DIR"
}

checkout_code() {
  APP_DIR="$1"
  if [ -f "$APP_DIR/package.json" ] && [ -f "$APP_DIR/docker-compose.yml" ]; then
    log "使用已有目录：$APP_DIR"
    return
  fi
  if [ -z "$REPO" ]; then
    if [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
      die "$APP_DIR 已存在且不是可识别的百灵中枢目录。请换一个 BAILING_INSTALL_DIR，或手动处理该目录。"
    fi
    TMP_DIR="$(mktemp -d)"
    log "下载开源分发包：$SOURCE_TGZ"
    curl -fsSL "$SOURCE_TGZ" -o "$TMP_DIR/source.tgz"
    tar -xzf "$TMP_DIR/source.tgz" -C "$TMP_DIR"
    SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [ -n "$SRC_DIR" ] || die "开源分发包格式不正确"
    mkdir -p "$APP_DIR"
    (cd "$SRC_DIR" && tar -cf - .) | (cd "$APP_DIR" && tar -xf -)
    rm -rf "$TMP_DIR"
    return
  fi
  if [ -e "$APP_DIR" ] && [ ! -d "$APP_DIR/.git" ]; then
    die "$APP_DIR 已存在但不是 git 仓库。请换一个 BAILING_INSTALL_DIR，或手动处理该目录。"
  fi
  if [ -d "$APP_DIR/.git" ]; then
    log "更新已有仓库：$APP_DIR"
    git -C "$APP_DIR" fetch --depth 1 origin "$REF"
    git -C "$APP_DIR" checkout FETCH_HEAD
    return
  fi
  log "拉取代码：$REPO ($REF) → $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$APP_DIR"
}

write_env() {
  APP_DIR="$1"
  ENV_FILE="$APP_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    log ".env 已存在，保持原样"
    return
  fi
  ADMIN_PASSWORD="${BAILING_DEMO_ADMIN_PASSWORD:-$(secret)}"
  ADMIN_TOKEN="${BAILING_TOKEN:-$(secret)}"
  MYSQL_ROOT_PASSWORD="${BAILING_DEMO_MYSQL_ROOT_PASSWORD:-$(secret)}"
  MYSQL_PASSWORD="${BAILING_DEMO_MYSQL_PASSWORD:-$(secret)}"
  TOOL_SECRET="${DEMO_TOOL_SECRET:-$(secret)}"
  CLIENT_TOKEN="${DEMO_CLIENT_TOKEN:-$(secret)}"
  IMAGE_TAG="${BAILING_IMAGE_TAG:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -1)}"
  [ -n "$IMAGE_TAG" ] || IMAGE_TAG="0.1.3"
  IMAGE_REGISTRY="${BAILING_IMAGE_REGISTRY:-$DEFAULT_IMAGE_REGISTRY}"
  IMAGE_NAMESPACE="${BAILING_IMAGE_NAMESPACE:-$DEFAULT_IMAGE_NAMESPACE}"
  cat > "$ENV_FILE" <<EOF
# Generated by scripts/install.sh. Safe to edit, but do not commit.
BAILING_INSTALL_MODE=$INSTALL_MODE
BAILING_PUBLIC_PORT=$PUBLIC_PORT
BAILING_DEMO_PUBLIC_PORT=$DEMO_PORT
BAILING_MYSQL_PUBLIC_PORT=$MYSQL_PORT

BAILINGHUB_IMAGE=${BAILINGHUB_IMAGE:-$IMAGE_REGISTRY/$IMAGE_NAMESPACE/bailinghub:$IMAGE_TAG}
BAILING_DEMO_BUSINESS_IMAGE=${BAILING_DEMO_BUSINESS_IMAGE:-$IMAGE_REGISTRY/$IMAGE_NAMESPACE/bailing-demo-business:$IMAGE_TAG}
BAILING_MYSQL_IMAGE=${BAILING_MYSQL_IMAGE:-$DEFAULT_MYSQL_IMAGE}
BAILING_NODE_IMAGE=${BAILING_NODE_IMAGE:-node:22-bookworm-slim}

BAILING_TOKEN=$ADMIN_TOKEN
BAILING_DEMO_ADMIN_PASSWORD=$ADMIN_PASSWORD

BAILING_DEMO_MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
BAILING_DEMO_MYSQL_DATABASE=bailinghub
BAILING_DEMO_MYSQL_USER=bailing
BAILING_DEMO_MYSQL_PASSWORD=$MYSQL_PASSWORD

DEMO_TOOL_SECRET=$TOOL_SECRET
DEMO_CLIENT_TOKEN=$CLIENT_TOKEN
EOF
  chmod 600 "$ENV_FILE"
  log "已生成 .env（不会被 git 跟踪）"
}

host_ip() {
  if [ -n "$PUBLIC_HOST" ]; then
    printf '%s\n' "$PUBLIC_HOST"
    return
  fi
  if have curl; then
    PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    case "$PUBLIC_IP" in
      ''|127.*|10.*|172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*|192.168.*) ;;
      *) printf '%s\n' "$PUBLIC_IP"; return ;;
    esac
  fi
  hostname -I 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i !~ /^127\\./ && $i !~ /^10\\./ && $i !~ /^172\\.(1[6-9]|2[0-9]|3[0-1])\\./ && $i !~ /^192\\.168\\./) {
        print $i;
        exit;
      }
    }
    print $1;
  }'
}

select_compose_mode() {
  APP_DIR="$1"
  case "$INSTALL_MODE" in
    image|images)
      [ -f "$APP_DIR/docker-compose.images.yml" ] || die "缺少 docker-compose.images.yml，不能使用 BAILING_INSTALL_MODE=image。"
      COMPOSE_FILES="-f docker-compose.images.yml"
      log "安装模式：官方预构建镜像"
      ;;
    source|build)
      COMPOSE_FILES=""
      log "安装模式：源码构建"
      ;;
    *)
      die "BAILING_INSTALL_MODE 只支持 source 或 image，当前为：$INSTALL_MODE"
      ;;
  esac
}

main() {
  preflight_environment
  install_packages
  install_docker
  preflight_docker
  APP_DIR="$(resolve_app_dir)"
  checkout_code "$APP_DIR"
  write_env "$APP_DIR"
  select_compose_mode "$APP_DIR"
  preflight_images "$APP_DIR"

  log "启动 Docker demo"
  cd "$APP_DIR"
  if [ "$INSTALL_MODE" = "image" ] || [ "$INSTALL_MODE" = "images" ]; then
    UP_ARGS="-d"
  else
    UP_ARGS="-d --build"
  fi
  # shellcheck disable=SC2086
  if ! compose_cmd up $UP_ARGS; then
    cat >&2 <<'EOF'

[bailinghub] Docker demo 启动失败。

如果使用 BAILING_INSTALL_MODE=image 且日志里包含 bailinghub 或 bailing-demo-business 拉取失败，
说明当前网络无法访问官方镜像仓库，或官方镜像版本尚未发布。可切到源码构建：

   BAILING_INSTALL_MODE=source curl -fsSL https://www.bailinghub.com/install.sh | sh

如果日志里包含 docker.io、registry-1.docker.io 或 node:22-bookworm-slim 超时，
说明当前服务器无法稳定访问 Docker Hub。可选处理方式：

1. 给 Docker 配置当前云环境可用的 registry mirror，然后重试：
   cd <安装目录>
   docker compose up -d --build

2. 或在安装前显式指定可访问的等价镜像：
   BAILING_NODE_IMAGE=<registry>/library/node:22-bookworm-slim \
   curl -fsSL https://www.bailinghub.com/install.sh | sh

一键安装默认使用官方预构建镜像；如需本机源码构建，可设置 BAILING_INSTALL_MODE=source。
EOF
    exit 1
  fi

  if [ "$SKIP_SMOKE" != "1" ]; then
    wait_hub_ready
    log "运行 smoke 验证"
    if ! compose_cmd exec -T bailinghub npm run smoke; then
      compose_cmd ps || true
      compose_cmd logs --tail=160 bailinghub || true
      die "smoke 验证失败"
    fi
  fi

  IP="$(host_ip)"
  [ -n "$IP" ] || IP="localhost"
  ADMIN_PASSWORD="$(grep '^BAILING_DEMO_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
  CLIENT_TOKEN="$(grep '^DEMO_CLIENT_TOKEN=' .env | cut -d= -f2-)"
  COMPOSE_HINT="docker compose"
  if [ -n "$COMPOSE_FILES" ]; then
    COMPOSE_HINT="docker compose $COMPOSE_FILES"
  fi

  cat <<EOF

[$APP_NAME] 安装完成

控制台:
  http://$IP:$PUBLIC_PORT/console/

demo 业务系统:
  http://$IP:$DEMO_PORT/

后台账号:
  username: admin
  password: $ADMIN_PASSWORD

demo 接入方:
  route: demo_support
  token: $CLIENT_TOKEN

常用命令:
  cd $APP_DIR
  $COMPOSE_HINT ps
  $COMPOSE_HINT logs -f bailinghub
  $COMPOSE_HINT exec bailinghub npm run smoke
  $COMPOSE_HINT exec bailinghub npm run demo:e2e

安装模式:
  $INSTALL_MODE

如果上面的地址不是公网地址，可重新安装时指定：
  BAILING_PUBLIC_HOST=<server-public-ip-or-domain> curl -fsSL https://www.bailinghub.com/install.sh | sh

EOF
}

main "$@"
