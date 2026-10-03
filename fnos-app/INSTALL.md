# 安装、升级与备份

## 准备

准备一台已经初始化、有可用存储空间的飞牛 fnOS 测试设备和管理员账号。应用当前声明最低系统版本 `1.2.0`，依赖应用中心的 Node.js 22 包 `nodejs_v22`。下载或拉取依赖时，NAS 需要可用网络。

## 生成安装包

开发电脑需要 Node.js 22 或更新版本，以及与当前电脑架构对应的官方 fnpack。本地交付目录的 Apple Silicon 版工具位于 `.tools/fnpack`；该工具不会上传到 GitHub。从 GitHub 克隆后，请按[官方 fnpack 页面](https://developer.fnnas.com/docs/cli/fnpack/)下载对应平台工具，放到 `.tools/fnpack` 并赋予执行权限，或将其加入 PATH。工具不安装到系统目录，也不进入应用包。

在本目录执行：

```bash
bash scripts/build.sh
```

生成文件：`dist/DangjianRecorder.fpk`。构建脚本只复制包配置、生命周期脚本、服务代码和前端资源，不读取父目录的 `.env`、Windows 或 Halo 文件。

## 安装与首次设置

1. 登录飞牛管理员账号，打开应用中心的手动安装入口，选择 `DangjianRecorder.fpk`。
2. 完成安装，并确认 `nodejs_v22` 依赖已安装、可启用。
3. 从桌面打开「党建会议记录生成器」。入口是 `/app/DangjianRecorder`，会转到当前页面路径；默认页面为 `/app/DangjianRecorder/dangjian`。
4. 进入页面设置，填写 DeepSeek API Key 并选择模型，保存后生成一份测试记录。应用固定调用 DeepSeek 官方接口，无需设置服务地址。
5. API Key 编辑框不会显示已经保存的值；留空保存会保留现有密钥。请不要把密钥写进安装包或截图。

生成时默认检索公开参考材料，可根据需要关闭。会议输入和生成结果需要使用者自行核对。结果可以编辑、复制和下载；重新打开页面不会恢复上次记录，请下载保存。

重复安装测试时，也可在 NAS 终端运行官方命令：

```bash
appcenter-cli install-fpk /path/to/DangjianRecorder.fpk
appcenter-cli list
appcenter-cli start DangjianRecorder
appcenter-cli stop DangjianRecorder
```

这些命令在飞牛设备执行，开发电脑不需要安装 appcenter-cli。

## 升级、备份和恢复

升级前先在应用中心停止应用，再备份 `/var/apps/DangjianRecorder/var/config.json`。如需排障，可以同时备份该目录的 `app.log`。该目录保存配置和日志，不保存会议记录；已生成的记录请从浏览器下载后另行保存，本版不自动归档。

安装同一应用标识的新版本包后，重新启动并检查模型设置和生成流程。升级脚本不清理配置。卸载前也请备份，不能仅依赖系统卸载时保留数据。

需要恢复配置时，停止应用，由有权限的管理员将自己的备份放回原数据目录，保持应用用户可读写及配置文件 `0600` 权限，再启动应用。不要把备份放入前端公开目录。

## 域名入口和排查

桌面与域名访问都应走已有的飞牛登录网关。包内没有部署公网代理规则；裸 `/dangjian` 不作为本包注册的网关地址。

- 页面打不开：检查应用状态、Node.js 22 依赖，以及是否通过飞牛管理员登录访问完整路径。
- 启动失败：查看 `/var/apps/DangjianRecorder/var/app.log`，确认安装目录可创建 `app.sock`。
- 模型调用失败：检查 DeepSeek 设置和 NAS 到官方接口的网络访问。修改其他设置时，密钥可留空保留。
- 升级后设置丢失：停止应用并检查原运行数据目录，必要时恢复自己的配置备份。

本机代码与打包检查不能替代 NAS 实机验证。安装、网关权限、升级和卸载行为须在目标系统上确认。
