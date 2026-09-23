# PC 端工作记忆

## 适用范围与优先级

本文件仅约束 `product/pc/**`。开始 PC 任务前阅读它；涉及网关/手机协议时，再阅读 [../README.md](../README.md) 的跨端契约。不要把服务器端口、部署目录或 Android 生命周期模型套用到桌面端。

## 当前实现

- Windows 桌面客户端：Electron 33，CommonJS；应用入口为 `main.js`，安全桥为 `preload.js`，渲染进程位于 `renderer/`。
- 接入密钥登录（`access-client.js`）、DSH 启动与生命周期、网关 API、配对二维码、窗口行为由 `main.js` 协调；渲染端经 preload 暴露的窄 API 与主进程交互。
- 自研 WSS 隧道客户端在 `tunnel/client.js`，帧协议在 `tunnel/protocol.js`；它连接到服务器内置隧道服务端，并将流量安全转发至本机 DSH。
- Codex 桥在 `codex-bridge.js`：默认以 stdio 启动本机 Codex App Server，且只监听 `127.0.0.1:3082`。该端口只能由既有隧道转发；桥必须在 PC 端脱敏事件，不能记录或转发认证资料、连接串、原始工具输出或私钥。涉及实验共享 WebSocket 接入时，先读 [共享传输探针](tools/shared-transport-probe/README.md)；共享模式默认只读，只有本机显式设置 `BATONA_SHARED_CODEX_WRITES=1` 才开启文本发送与审批应答探针。
- 依赖与打包配置在 `package.json`。`electron-builder` 的 `files` 白名单决定进安装包的文件：`main.js` 直接 `require` 的每个本地文件或目录（当前包括 `tunnel/**/*`）都必须列入。Windows 发布包只允许内置 WSS 隧道模块，不能打包或下载第三方隧道二进制。

## 托管接入候选版

生产网关为 Batona Gateway 0.3.2；Batona PC 0.5.4 便携版仍在本机运行。PC 0.5.5 共享连接测试包已构建并用独立数据目录启动检查，但尚未替换运行版；切换尝试未启动新版，旧版已恢复并复核 3080/3081/3082、DSH 认证与网关连接。新安装默认使用 `Batona PC` 产品名与 `%APPDATA%\Batona PC` 数据目录；改名前安装不会因源码改名自动搬迁。当前入口固定 117.72.10.87:443；旧 `binding.json` 不再加载。Windows safeStorage 加密 `access.bin`，保留独立设备身份；原始接入密钥仅用于登录交换，不进 renderer 状态或磁盘。明确 401 清除授权回登录页，网络故障保留授权。配对页面关闭时通知撤销，窗口最小化保持续租（禁止后台节流）。退出账号/解绑/禁用只断远程链路，不停止 DSH/Codex 本地任务。发布或迁移先读 [运维边界](../server/hosted-access-operations.md)。

## 端内约束

- DSH、Agent、LLM 与工具始终在 PC 执行；不要将 DSH API、launch token 或本地端口暴露到公网，也不要让渲染进程直接持有敏感凭据。
- 账号/设备授权、配对二维码、launch-token 上报、网关 RPC 与隧道协议变更必须遵循 `../README.md` 的跨端契约，并与 Android/服务器一起做兼容评估。
- 保持 Electron 进程隔离：优先将特权操作放入主进程，通过 `preload.js` 暴露最小、显式的 IPC 接口；不要关闭 `contextIsolation` 或把 Node API 直接暴露给 renderer。
- 隧道需保持 PC 出站连接和本地 DSH 回环转发的模型；不可改成服务器主动连接用户 PC，或将本地监听改为公网可达。
- Codex 可用性须由本机 `app-server` 初始化、`thread/list`、`model/list` 与 `permissionProfile/list` 实测决定；不可在不可用时改用 `codex exec` 伪装成已有桌面会话控制。手机的三档权限只能使用 PC 校验为 allowed 的内建 profile。
- 修改 Codex 原生任务的发送、审批、同步或远程控制前，先读 [ADR 0003](../../docs/adr/0003-native-codex-window-control.md)。现有安装版仍用原生窗口写入，独立 stdio `app-server` 只读镜像；实验分支可让 Desktop 与 Batona 加入**同一个**回环 WebSocket app-server，以协议事件和 `turn/start` 交互。该实验不能按“两个独立 app-server”放开写入，亦未通过手机端完整验收。
- 共享实验的 Codex Desktop 必须由 [native-handoff.ps1](tools/shared-transport-probe/native-handoff.ps1) 的 `-Launch` 启动；普通快捷方式不会继承临时共享地址。下次关闭 Desktop 后再次运行 `-Launch` 会复用经进程身份、端口和健康检查验证的监听；`-Status` 只读核验实际连接，`-Stop` 仅在 Desktop 关闭后结束实验。不得以旧 PID 作为新进程身份依据。
- Windows 路径、子进程、DSH 未启动、令牌过期、网络重连和应用退出都必须有明确处理；不要只在打包环境或仅在开发环境假定某个路径存在。

## 验证

界面改动以 `output/pc-ui-demo/pc-overview-v5.png` 为视觉参考；配对沿用托管版短码/二维码与 PC 确认流程。顶部只展示隧道和网关，DSH/Codex 的真实状态放在各自卡片中；“本地认证”不能把桥初始化成功解释为账号认证成功。`npm run test:ui` 使用隔离用户目录与测试 preload 验证实际 renderer，覆盖窄窗口、导航、配对关闭/批准及授权失效，截图写入根目录 `output/ui-implementation/`；它不替代真实接入联调。

在 `product/pc/` 运行：

```powershell
npm run smoke
npm run dist
```

改动隧道连接/停止生命周期时，额外运行 `npm run test:tunnel-client`；它覆盖 TLS 握手未完成就停止时不得让 Electron 主进程崩溃。改动 Codex 桥时，先用本机只读探针验证会话/模型/profile 枚举，再验证桥 `/healthz`、`/v1/sessions`、`/v1/models`、`/v1/profiles`；根据改动范围补充实际验证：接入密钥登录、手机请求/PC 确认、DSH 自动启动、隧道重连、launch-token 上报和手机配对。`dist/`、`node_modules/` 与临时下载的二进制均为构建/运行产物，不能作为源码修改的一部分。

## 运行、打包与更新

在 `product/pc/` 执行 `npm install` 后，`npm start` 用于开发验证，`npm run dist` 用 electron-builder 产出 NSIS 安装包和便携版。产物位于 `dist/`：安装包可覆盖安装并保留用户数据；便携版替换前必须退出旧进程。每次可发布的 PC 改动都应递增 `package.json` 的 `version`，先完成 `npm run smoke` 与人工启动验证，再打包。

首次下载 Electron/electron-builder 较慢时，可临时设：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

绑定、日志和本地运行数据在 `%APPDATA%\Batona PC`；卸载/覆盖安装不应主动删除它。正式发布不含外部隧道可执行文件：出现安全软件拦截或隧道离线时，应检查服务器内置隧道状态、443/TLS 与该数据目录日志，而不是下载或运行第三方隧道程序。

## 首次运行与隧道排障

- 2026-09-22 定位并经用户授权恢复：3080 的 DSH 进程启动于当天 10:34，Batona PC 缓存仍是前一天 20:47 的令牌，`session/list` 返回 401。仅终止已验证的 DSH 进程，再由 Batona PC 托管启动，16:56 捕获新令牌后同一探针返回 200；Codex 本体未重启。复发时先核验缓存时间、端口所有者和认证结果，再取得重启许可。

- 2026-09-23 联合迁移后，3080 被 08:07 的旧 DSH 孤立进程占用，Batona PC 数据目录没有对应令牌；旧 `DSH Link` 目录的令牌保存于前一天，已失效。核验进程路径、命令行、端口所有者与无子进程后，停止该 PID，让 Batona PC 0.5.3 托管启动；只读 `session/list` 返回 200，手机 DSH 工作区恢复。Codex 原生进程未重启。

- PC 0.5.4 在原生模型菜单查找“选择模型”前等待控件出现，并在失败码附加非敏感阶段名（如 `native-model-unavailable:picker`）。新进程上的手机模型与强度切换通过；Android 0.3.3 对阶段码显示原有友好错误，并在成功后清除旧会话错误。

- DSH 只有 `session/list` 认证成功才算就绪。旧进程占用端口且缓存 token 失效时，报告认证失败，不重复启动或自动终止未知进程。启动输出按完整行捕获 token；日志必须脱敏，禁止保存分片 token。
- Codex 打开已有会话使用 `thread/read`。Desktop 持有的任务发送、模型/思考强度与权限菜单经 `native-codex-control.js` 和受身份绑定的原生窗口操作，不能调用第二个 app-server 的写接口。身份、签名、桌面、权限或控件验证失败时拒绝并保留手机草稿；审批/提问及运行中增量镜像仍待接入，详见 [ADR 0003](../../docs/adr/0003-native-codex-window-control.md)。
- `node test/live-backends.cjs` 只读探针检查缓存 token 的 DSH 列表、Codex 既有会话打开及历史；不发送 prompt、不输出凭据。PC 确实运行后再执行，401/空历史会让探针失败。

默认启动时，DSH 恢复与“目录/Codex 桥 + 隧道”并行执行：Codex 不应等待 DSH 取得 launch token 或排除遗留端口占用。隧道只经 `/tunnel` 发起出站 WSS 连接；服务器未启用内置隧道时，客户端保持离线并报告原因。发布客户端始终使用系统 CA 校验的 WSS，不读取旧连接串，不接受环境变量关闭 TLS。

状态灯中 DSH 与隧道在线最关键；网关灯是乐观探测，不能单独用它判断手机端是否可用。隧道失败时检查 PC 授权有效性、服务器内置隧道状态、PC 日志和 launch-token 上报；不要以关闭 TLS 校验或公开本地端口作为修复手段。
