# IntranetPenetration
内网穿透utools插件

配置统一在「设置」中管理：输入框失焦保存，选择项修改后立即保存。FRP 服务器由内网穿透和代理目录共用。

默认值、FRP 服务器地址与端口、代理规则沿用 uTools 数据同步，两台电脑需要登录同一账号并开启同步。可执行文件、分享目录和 Token 等本机设置使用设备 ID 隔离；换电脑后需选择本机文件路径。旧版本路径仅在当前设备确实存在时迁移。[uTools 存储说明](https://www.u-tools.cn/docs/developer/api-reference/db/db-storage.html)

设备 ID 隔离只区分不同电脑读取的设置，不代表数据只保存在本机。Token 仍存储在参与 uTools 同步的 dbStorage 中，并未加密；请依据账号同步策略管理敏感配置。

FRP 支持勾选一条或多条代理，点击「启动选中」同时转发对应端口，也可全选；未勾选的代理不会启动。列表显示各自注册状态和失败原因。保存和启动时检查重复名称、远程 TCP 端口及 HTTP 域名；本地端口可以复用。服务端其他客户端的端口占用由 frps 在注册时确认。更换勾选规则前，需先停止本次启动。

安装：`npm ci --ignore-scripts`；开发：`npm run dev`；构建：`npm run build`；回归测试：`npm test`；静态检查：`npm run lint`；完整验证：`npm run check`。CI 在 Windows 和 Linux 的 Node 22 上执行完整验证。

文件服务仅监听本机回环地址，异步读取目录和文件；目录元数据最多并发读取 8 项。日志界面保留最近 500 条。目录代理先验证目录和隧道配置再替换运行中的服务，取消复用确认不会停止原隧道。读取配置失败会终止启动；FRP 同步版本变化后需确认刷新后的规则再启动。

在线依赖审计可由开发者显式执行 `npm audit --registry=https://registry.npmjs.org`；该命令会向 npm 发送依赖包名和版本。本地测试不需要真实 DevTunnel/FRP 账号；正式发布前仍需在 uTools 中验收实际登录、代理注册、窗口交互和跨设备同步。
