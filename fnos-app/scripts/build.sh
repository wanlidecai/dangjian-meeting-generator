#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/dist"
if [ -x "$PROJECT_DIR/.tools/fnpack" ]; then
  FNPACK_BIN="$PROJECT_DIR/.tools/fnpack"
elif command -v fnpack >/dev/null 2>&1; then
  FNPACK_BIN="$(command -v fnpack)"
else
  printf '%s\n' "未找到 fnpack。请将官方工具保存为 .tools/fnpack 并设置执行权限，或加入 PATH。" >&2
  printf '%s\n' "官方工具：https://developer.fnnas.com/docs/cli/fnpack/" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { printf '%s\n' "本机构建检查需要 Node.js 22 或更新版本。" >&2; exit 1; }
for script in "$PROJECT_DIR"/cmd/*; do
  bash -n "$script"
  [ -x "$script" ] || { printf '生命周期脚本没有执行权限：%s\n' "$script" >&2; exit 1; }
done

mkdir -p "$OUTPUT_DIR"
STAGING_DIR="$(mktemp -d "$OUTPUT_DIR/.package.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
# Allowlist only package metadata, service code and public UI assets.
# No parent-project files, .env, local settings, data directories or dev tools are read.
node - "$PROJECT_DIR" "$STAGING_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const source = process.argv[2], target = process.argv[3];
function copy(relative) {
  const from = path.join(source, relative), to = path.join(target, relative);
  if (!fs.lstatSync(from).isFile()) throw new Error(`打包文件必须是普通文件：${relative}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}
function json(relative) { JSON.parse(fs.readFileSync(path.join(source, relative), 'utf8')); }
for (const relative of ['config/privilege', 'config/resource', 'app/ui/config', 'wizard/install', 'wizard/uninstall']) json(relative);
for (const relative of ['manifest', 'config/privilege', 'config/resource', 'ICON.PNG', 'ICON_256.PNG',
  'app/server.js', 'app/ui/config', 'app/ui/images/icon_64.png', 'app/ui/images/icon_256.png',
  'wizard/install', 'wizard/uninstall']) copy(relative);
for (const name of ['main', 'install_init', 'install_callback', 'upgrade_init', 'upgrade_callback',
  'uninstall_init', 'uninstall_callback', 'config_init', 'config_callback']) copy(`cmd/${name}`);
function tree(relative, extensions) {
  const directory = path.join(source, relative);
  if (!fs.existsSync(directory)) throw new Error(`缺少应用目录：${relative}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) tree(child, extensions);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) copy(child);
  }
}
tree('app/lib', new Set(['.js']));
tree('app/public', new Set(['.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']));
if (!fs.existsSync(path.join(target, 'app/public/index.html'))) throw new Error('缺少 app/public/index.html');
NODE
while IFS= read -r -d '' javascript; do
  node --check "$javascript"
done < <(find "$STAGING_DIR/app" -type f -name '*.js' -print0)

cd "$OUTPUT_DIR"
"$FNPACK_BIN" build --directory "$STAGING_DIR"
[ -s "$OUTPUT_DIR/DangjianRecorder.fpk" ] || { printf '%s\n' "fnpack 未生成预期的 DangjianRecorder.fpk。" >&2; exit 1; }
printf '可安装测试包：%s\n' "$OUTPUT_DIR/DangjianRecorder.fpk"
