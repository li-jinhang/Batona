# PC 端工作记忆

## 适用范围与优先级

本文件仅约束 `product/pc/**`。开始 PC 任务前阅读它；涉及网关/手机协议时，再阅读 [../README.md](../README.md) 的跨端契约。不要把服务器端口、部署目录或 Android 生命周期模型套用到桌面端。

## 当前实现

- Windows 桌面客户端：Electron 33，CommonJS；应用入口为 `main.js`，安全桥为 `preload.js`，渲染进程位于 `renderer/`。
- 连接串导入、DSH 启动与生命周期、网关 API、配对二维码、窗口行为由 `main.js` 协调；渲染端经 preload 暴露的窄 API 与主进程交互。
- 自研 WSS 隧道客户端在 `tunnel/client.js`，帧协议在 `tunnel/protocol.js`；它连接到服务器内置隧道服务端，并将流量安全转发至本机 DSH。
- Codex 桥在 `codex-bridge.js`：它以 stdio 启动本机 Codex App Server，且只监听 `127.0.0.1:3082`。该端口只能由既有隧道转发；桥必须在 PC 端脱敏事件，不能记录或转发认证资料、连接串、原始工具输出或私钥。
- 依赖与打包配置在 `package.json`。`electron-builder` 的 `files` 白名单决定进安装包的文件；任何需由 Windows 直接执行的二进制（当前为 `frpc-bin/frpc.exe`）还必须在 `asarUnpack` 中，不能只封进 `app.asar`。

## 端内约束

- DSH、Agent、LLM 与工具始终在 PC 执行；不要将 DSH API、launch token 或本地端口暴露到公网，也不要让渲染进程直接持有敏感凭据。
- 连接串、配对二维码、launch-token 上报、网关 RPC 与隧道协议变更必须遵循 `../README.md` 的跨端契约，并与 Android/服务器一起做兼容评估。
- 保持 Electron 进程隔离：优先将特权操作放入主进程，通过 `preload.js` 暴露最小、显式的 IPC 接口；不要关闭 `contextIsolation` 或把 Node API 直接暴露给 renderer。
- 隧道需保持 PC 出站连接和本地 DSH 回环转发的模型；不可改成服务器主动连接用户 PC，或将本地监听改为公网可达。
- Codex 可用性须由本机 `app-server` 初始化、`thread/list`、`model/list` 与 `permissionProfile/list` 实测决定；不可在不可用时改用 `codex exec` 伪装成已有桌面会话控制。手机的三档权限只能使用 PC 校验为 allowed 的内建 profile。
- Windows 路径、子进程、DSH 未启动、令牌过期、网络重连和应用退出都必须有明确处理；不要只在打包环境或仅在开发环境假定某个路径存在。

## 验证

在 `product/pc/` 运行：

```powershell
npm run smoke
npm run dist
```

改动隧道连接/停止生命周期时，额外运行 `npm run test:tunnel-client`；它覆盖 TLS 握手未完成就停止时不得让 Electron 主进程崩溃。改动 Codex 桥时，先用本机只读探针验证会话/模型/profile 枚举，再验证桥 `/healthz`、`/v1/sessions`、`/v1/models`、`/v1/profiles`；根据改动范围补充实际验证：导入连接串/扫码、DSH 自动启动、隧道重连、launch-token 上报和手机配对。`dist/`、`node_modules/` 与临时下载的二进制均为构建/运行产物，不能作为源码修改的一部分。

## 运行、打包与更新

在 `product/pc/` 执行 `npm install` 后，`npm start` 用于开发验证，`npm run dist` 用 electron-builder 产出 NSIS 安装包和便携版。产物位于 `dist/`：安装包可覆盖安装并保留用户数据；便携版替换前必须退出旧进程。每次可发布的 PC 改动都应递增 `package.json` 的 `version`，先完成 `npm run smoke` 与人工启动验证，再打包。

首次下载 Electron/electron-builder 较慢时，可临时设：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

绑定、日志和本地运行数据在 `%APPDATA%\DSH Link`；卸载/覆盖安装不应主动删除它。出现 `EPERM`、打包工具下载失败或便携版打不开时，先检查 Defender/杀毒拦截、`dist/` 目录锁定和该数据目录日志。内置隧道不依赖 frpc；只有服务器尚未启用内置隧道或明确回退时，才使用 `npm run fetch-frpc` 获取回退二进制。

## 首次运行与隧道排障

默认启动顺序是：检测 `127.0.0.1:3080` 的 DSH → 未运行则启动 → 读取网关 `/healthz` 的内置隧道状态 → 选择内置 WSS 或 frpc → 显示手机配对二维码。健康状态明确为未启用内置隧道时，`auto` 会直接走 frpc；健康状态不可读时才保留“先试内置、失败回退”的兼容逻辑。内置隧道经 `/tunnel` 出站连服务器；`DSHLINK_TUNNEL=auto|builtin|frp` 可用于定位问题，默认 `auto`。`DSHLINK_INSECURE=1` 仅允许本机明文网关调试，绝不能用于生产。

状态灯中 DSH 与隧道在线最关键；网关灯是乐观探测，不能单独用它判断手机端是否可用。隧道失败时检查连接串 `gwPort`/token、服务器内置隧道状态、PC 日志和 launch-token 上报；不要以关闭 TLS 校验或公开本地端口作为修复手段。
