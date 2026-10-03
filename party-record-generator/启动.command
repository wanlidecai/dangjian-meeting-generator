#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PORT_LINE=$(grep -E '^PORT=' .env 2>/dev/null | tail -n 1)
HOST_LINE=$(grep -E '^HOST=' .env 2>/dev/null | tail -n 1)
PORT="${PORT_LINE#PORT=}"
HOST="${HOST_LINE#HOST=}"
[[ -z "$PORT" ]] && PORT="8787"
[[ -z "$HOST" ]] && HOST="127.0.0.1"
URL="http://${HOST}:${PORT}"

echo "正在启动党建会议记录生成器..."
echo "网页地址：${URL}"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "未找到 Node.js，无法启动。请先安装 Node.js 后再双击本文件。"
  echo "官方下载地址：https://nodejs.org/"
  read "?按回车关闭窗口..."
  exit 1
fi

if curl -fsS "${URL}/api/defaults" >/dev/null 2>&1; then
  echo "服务已经在运行，正在打开网页..."
  open "${URL}"
  exit 0
fi

(
  for attempt in {1..25}; do
    if curl -fsS "${URL}/api/defaults" >/dev/null 2>&1; then
      open "${URL}"
      exit 0
    fi
    sleep 0.3
  done
) &

node server.js
STATUS=$?
echo ""
echo "服务已停止。如看到端口占用提示，请先关闭其他正在运行的生成器窗口。"
read "?按回车关闭窗口..."
exit $STATUS
