# IntranetPenetration
内网穿透utools插件

配置统一在「设置」中管理：输入框失焦保存，选择项修改后立即保存。FRP 服务器由内网穿透和代理目录共用。

默认值、FRP 服务器和代理规则沿用 uTools 数据同步，两台电脑需要登录同一账号并开启同步。可执行文件、分享目录等本机设置使用设备 ID 隔离；换电脑后需选择本机文件路径。旧版本路径仅在当前设备确实存在时迁移。[uTools 存储说明](https://www.u-tools.cn/docs/developer/api-reference/db/db-storage.html)

FRP 支持勾选一条或多条代理，点击「启动选中」同时转发对应端口，也可全选；未勾选的代理不会启动。列表显示各自注册状态和失败原因。保存和启动时检查重复名称、远程 TCP 端口及 HTTP 域名；本地端口可以复用。服务端其他客户端的端口占用由 frps 在注册时确认。更换勾选规则前，需先停止本次启动。

开发：`npm run dev`；构建：`npm run build`；回归测试：`npm test`。
