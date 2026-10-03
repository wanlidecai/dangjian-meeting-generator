# 党建会议记录生成器 · 飞牛应用

独立的飞牛 fnOS 原生应用，应用标识 `DangjianRecorder`，版本 `1.0.0`。支持三类会议、DeepSeek 模型配置与公开材料检索。安装后从飞牛桌面打开，用管理员账号整理会议要点并生成记录。

应用使用官方 `nodejs_v22` 运行时，以专用包用户运行。生产服务只监听 Unix Socket，经飞牛登录网关提供页面，不开放应用自己的 TCP 端口。包内不包含本地 `.env`、API Key 或原项目运行数据。

## 安装与使用

1. 由开发者在本目录运行 `bash scripts/build.sh`，生成 `dist/DangjianRecorder.fpk`。构建使用项目 `.tools/fnpack` 或 PATH 中的官方工具。
2. 在飞牛应用中心手动安装 `.fpk`。应用会声明 Node.js 22 运行时依赖；安装后确认该依赖可用。
3. 使用飞牛管理员账号，从桌面打开「党建会议记录生成器」。
4. 在页面设置中填写 DeepSeek API Key 并选择模型，再保存。再次编辑设置时，API Key 留空表示保留已保存的密钥。
5. 填写会议要点并生成记录。公开材料检索默认开启，可以在生成页面关闭。生成结果可以在页面编辑、复制和下载；请下载保存，重新打开页面不会恢复上次记录。

详细步骤见 [安装说明](INSTALL.md)。手动安装是本地验证流程；公开上架需按飞牛开发者平台的提交流程办理。

## 访问路径

应用入口和统一网关前缀为 `/app/DangjianRecorder`。根入口会转到当前配置的页面路径，默认页面为 `/app/DangjianRecorder/dangjian`。修改页面路径后仍从根入口打开；必须先通过飞牛管理员登录。

如果 NAS 已配置 HTTPS 域名入口和安全代理，可在该登录网关的同一域名下访问上述路径。本包不会创建公网域名、证书或反向代理规则，也没有部署裸 `/dangjian` 的公开路由。需要短路径时，应由现有安全代理转到完整网关路径，并保留飞牛登录和管理员校验。

## 配置、升级和备份

运行配置位于飞牛分配的 `TRIM_PKGVAR/config.json`，启动日志为 `TRIM_PKGVAR/app.log`；通常可通过 `/var/apps/DangjianRecorder/var/` 访问。API Key 保存在服务器配置中，不回填到浏览器表单。

升级前停止应用并备份配置，随后在应用中心安装新包。升级脚本保留现有数据目录。运行数据目录用于配置和日志，不是会议记录库。卸载脚本不主动删除运行数据，但系统版本的卸载保留行为仍需实机确认；卸载前请另行备份配置和已经下载到自己电脑的记录。配置备份含密钥，应保存在自己控制的私有位置。

## 本地验证

在项目根目录执行 `npm run test:fnos`，18 项 Node.js 22 测试通过，覆盖真实 Unix Socket 服务启动与重启、配置保留、管理员校验、自定义路径、三类会议的模拟生成，以及网络检索的地址、大小、超时和并发限制。原桌面版 13 项会议规则测试也通过。

浏览器中验证了设置保存、路径跳转、密钥留空保留和三类会议的模拟生成；375、390、414、430 像素手机及 768 像素平板宽度均无横向溢出，手机输入框 16px、按钮点击区域至少 44px。模型响应与材料检索均使用测试替身，未读取原项目 `.env` 或发送真实请求。

## 当前限制

- 仅供飞牛管理员使用，暂不提供普通用户入口。
- 本版声明最低 fnOS `1.2.0`；NAS 安装、网关 Socket 权限和升级行为仍需实机测试。
- 模型调用固定使用 DeepSeek 官方接口，需要 NAS 能访问该服务。生成与公开材料检索需要可用网络。
- 会议记录由模型生成，日期、人员、事项和表述需要使用者核对；本版不自动建立会议记录归档库。

## 官方依据

- [运行时环境](https://developer.fnnas.com/docs/core-concepts/runtime/)：`install_dep_apps=nodejs_v22`，运行路径 `/var/apps/nodejs_v22/target/bin`。
- [统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration/)：通过应用目录的 Unix Socket 转发，提供飞牛用户 Header。
- [应用入口](https://developer.fnnas.com/docs/core-concepts/app-entry/)：管理员入口使用 `allUsers=false` 和 `control.accessPerm=readonly`。
- [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)：使用官方打包工具生成可安装 `.fpk`。
