# DSH Link PC 端打包与更新流程

> 适用：Windows 11。把 PC 端软件打包成独立 exe，以及后续改代码后的更新步骤。

---

## 一、打包（产出独立 exe）

在 PC 端目录执行：

```powershell
cd D:\_Projects\26-009DSHplugin\product\pc

# ① 确保依赖已装
npm install

# ② 打包（NSIS 安装包 + 便携版单文件 exe）
npm run dist
```

**产物**在 `D:\_Projects\26-009DSHplugin\product\pc\dist\`：

| 文件 | 用途 |
|---|---|
| `DSH Link Setup <版本>.exe` | NSIS 安装包（推荐，双击安装，会建开始菜单/桌面快捷方式） |
| `DSH Link <版本>.exe` | 便携版单文件（免安装，直接双击运行，数据存 `%APPDATA%\DSH Link`） |
| `win-unpacked\` | 解压版（内含 `DSH Link.exe`，可整体拷贝到别处运行） |

> 首次打包 electron-builder 会下载打包工具（winCodeSign、nsis），**国内慢**：打包前设镜像
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> ```

### 双击运行说明
- **便携版**：双击 exe 即启动，不注册系统，移动便携；
- **安装包**：安装后有开始菜单「DSH Link」入口 + 桌面快捷方式；
- 数据（绑定连接串、frpc、日志）存 `C:\Users\你的用户名\AppData\Roaming\DSH Link`，卸载不自动删（想重置可手动删该目录）。

---

## 二、更新（改了代码之后重新打包）

**PC 端几乎任何改动都只需：重新打包 → 替换文件**，绑定数据不丢。

### 2.1 改代码
- 改 `main.js`（主进程）、`renderer/`（界面）、`preload.js` 等；
- **改完 `npm start` 先自测一遍**（能启动、隧道灯绿、二维码出来）。

### 2.2 重新打包
```powershell
cd D:\_Projects\26-009DSHplugin\product\pc
npm run dist
```

### 2.3 分发/替换
- **已装安装包**：直接跑新的 `DSH Link Setup.exe`，会覆盖安装（数据保留）；
- **便携版**：用新的 `DSH Link <新版本>.exe` 替换旧的（先关闭旧进程）。

### 2.4 版本号
- 升级版本号：改 `product\pc\package.json` 里的 `"version"`（如 `0.1.0 → 0.2.0`），重新打包后文件名带新版本号。

---

## 三、打包常见问题

| 现象 | 处理 |
|---|---|
| 打包卡在下载工具/超时 | 设上面的镜像环境变量后重试 |
| 报 `EPERM` / 杀毒拦截 | 把 `product\pc\dist`、`%APPDATA%\DSH Link` 加入 Defender 排除 |
| `frpc` 下载被拦 | 用 `npm run fetch-frpc`（镜像）或浏览器下载 frpc.exe 放 `pc\frpc-bin\` |
| 双击便携版无反应 | 看 `%APPDATA%\DSH Link\` 日志；可能杀毒拦了 frpc，加白名单 |

---

## 四、当前版本默认行为（一键启动）

打包好的软件打开后自动：
1. 检测笔记本 DSH(127.0.0.1:3080)，没跑就拉起；
2. 启动 frpc 隧道（连接服务器 7000）；
3. 显示「手机配对二维码」。

状态灯：DSH 绿=DSH在跑；隧道绿=frpc通（关键）；网关灯为乐观探测可能显示红，**忽略**（手机能连即网关通）。
