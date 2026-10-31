#!/usr/bin/env bash
# 一键启动：开发模式（Vite 5173 + API 5174）+ Cloudflare 快速隧道
# 用法：bash scripts/tunnel.sh            # 开发模式，隧道指向 5173
#       bash scripts/tunnel.sh --prod     # 隧道指向 5174（后端直接托管构建产物）
#       PORT=8080 bash scripts/tunnel.sh  # 自定义本地端口
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TARGET_PORT="${PORT:-5173}"
MODE="dev"
[[ "${1:-}" == "--prod" ]] && { MODE="prod"; TARGET_PORT="${PORT:-5174}"; }

DEV_LOG="$ROOT/.tunnel/dev.log"
TUNNEL_LOG="$ROOT/.tunnel/tunnel.log"
mkdir -p "$ROOT/.tunnel"

command -v cloudflared >/dev/null 2>&1 || {
  echo "✗ 未找到 cloudflared，请先安装："
  echo "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"
  exit 1
}

cleanup() {
  echo ""
  echo "→ 正在停止隧道与本地服务…"
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "${DEV_PID:-}" ]] && kill "$DEV_PID" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://localhost:${TARGET_PORT}" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ---------- 1. 本地服务 ----------
if lsof -ti "tcp:${TARGET_PORT}" >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ":${TARGET_PORT} "; then
  echo "• 端口 ${TARGET_PORT} 已有服务在运行，复用现有进程"
else
  if [[ "$MODE" == "dev" ]]; then
    echo "• 启动开发模式：pnpm dev（Vite 5173 + API 5174，热更新）"
    pnpm dev >"$DEV_LOG" 2>&1 &
  else
    echo "• 启动生产模式：node server/dist/index.js"
    [[ -d server/dist ]] || pnpm build
    (cd server && PORT=5174 node dist/index.js) >"$DEV_LOG" 2>&1 &
  fi
  DEV_PID=$!
  for _ in $(seq 1 40); do
    sleep 0.5
    ss -ltn 2>/dev/null | grep -q ":${TARGET_PORT} " && break
  done
fi

for _ in $(seq 1 30); do
  sleep 0.4
  ss -ltn 2>/dev/null | grep -q ":${TARGET_PORT} " && break
done
if ! ss -ltn 2>/dev/null | grep -q ":${TARGET_PORT} "; then
  echo "✗ 本地服务未能在 :${TARGET_PORT} 启动，日志：$DEV_LOG"
  tail -20 "$DEV_LOG" || true
  exit 1
fi
echo "  ✓ 本地服务就绪 http://localhost:${TARGET_PORT}"

# ---------- 2. Cloudflare Tunnel ----------
echo "• 建立 Cloudflare 快速隧道 → http://localhost:${TARGET_PORT}"
: >"$TUNNEL_LOG"
cloudflared tunnel --url "http://localhost:${TARGET_PORT}" --no-autoupdate --protocol http2 >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 60); do
  sleep 0.5
  PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "✗ 隧道建立失败，日志：$TUNNEL_LOG"
  tail -20 "$TUNNEL_LOG" || true
  cleanup
fi

for _ in $(seq 1 20); do
  sleep 0.5
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${PUBLIC_URL}/v1/health" || true)"
  [[ "$code" == "200" ]] && break
done

echo ""
echo "┌──────────────────────────────────────────────────────────────"
echo "│  Public URL : ${PUBLIC_URL}"
echo "│  Local      : http://localhost:${TARGET_PORT}"
echo "│  Health     : ${PUBLIC_URL}/v1/health  (HTTP ${code:-?})"
echo "│  日志        : ${DEV_LOG} / ${TUNNEL_LOG}"
echo "└──────────────────────────────────────────────────────────────"
echo "  临时域名随隧道进程结束失效；按 Ctrl+C 同时停止隧道与本地服务。"

# 写入可被其他工具读取的地址
printf '%s\n' "$PUBLIC_URL" >"$ROOT/.tunnel/url.txt"

wait "$TUNNEL_PID"
