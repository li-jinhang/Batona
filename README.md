# Batona

**用手机接上电脑里的 Codex 与 DSH 会话。**

Connect your phone to Codex and DSH running on your Windows PC.

[项目介绍](https://117.72.10.87/projects/batona/) · [客户端下载](https://117.72.10.87/projects/batona/download/) · [iPhone 网页应用](https://117.72.10.87/projects/dsh-link/pwa/) · [问题反馈](https://github.com/li-jinhang/Batona/issues)

Batona 是一款面向 Coding Agent 的手机远程接入工具。你可以在电脑上开始工作，再从手机查看工作区、打开会话、继续发送文字，并在支持的后端中处理审批与提问。

Agent、模型调用和工具执行始终在你的电脑上进行；手机通过网关连接电脑。使用时需要保持电脑、Batona PC 和对应的 Agent 在线。

> **当前处于内测阶段。** 使用需要测试账号接入密钥，并在电脑端批准手机配对。本仓库包含 Batona 客户端与网关源码，使用方式和能力仍在迭代。

## 可以做什么

- **接续会话**：在手机查看工作区与会话历史，继续发送文字。
- **跟进进度**：查看支持的后端提供的回复、工具活动和处理状态。
- **回应请求**：在支持的会话中处理审批和提问。
- **分别使用多个后端**：DSH 与 Codex 保持各自的工作区、会话和设置。
- **从电脑管理连接**：查看本地服务状态、连接网关并批准手机配对。

DSH 支持会话历史、流式回复、审批与提问。Codex 的可用功能取决于本机版本和连接方式；共享连接属于实验性接入，部分操作需要在 PC 端启用。请以客户端实际显示的能力为准。Claude Code 尚未接入。

## 下载与支持平台

| 平台 | 提供形式 | 使用要求 |
| --- | --- | --- |
| Windows | 安装版、便携版 | x64；电脑上已配置 DSH 或 Codex |
| Android | APK | Android 8.0 及以上 |
| iPhone | PWA 网页应用 | 推荐 iOS 16.4 及以上，使用 Safari 添加到主屏幕 |

**[前往 Batona 下载页 →](https://117.72.10.87/projects/batona/download/)**

下载页提供当前版本、系统要求、文件大小、SHA-256 校验值和发布记录。建议配套更新 Windows 与 Android 客户端。

当前 Windows 内测包未进行代码签名；Android 使用 Debug 签名，未来正式签名版可能无法直接覆盖安装。具体说明以下载页为准。

## 开始使用

1. **准备账号与电脑**：取得内测账号接入密钥，在 Windows 上安装并配置需要使用的 DSH 或 Codex。
2. **连接 Batona PC**：安装电脑端，输入接入密钥，确认网关与对应本地服务就绪。
3. **打开手机端**：安装 Android APK，或在 iPhone Safari 中打开网页应用并添加到主屏幕。
4. **完成配对**：在电脑端显示配对信息，手机扫码或输入配对码，再由电脑端批准。
5. **选择会话**：进入 DSH 或 Codex，选择工作区与会话，查看历史或继续发送文字。

## 常见问题

### 电脑关机后，还能继续任务吗？

不能。Agent 与工具运行在电脑上，远程操作需要电脑和对应服务保持在线。

### iPhone 需要从 App Store 安装吗？

不需要。当前提供 PWA，通过 Safari 的“分享 → 添加到主屏幕”安装。配对后可按提示主动开启通知。

### DSH 与 Codex 的功能完全相同吗？

不同。两者的协议和连接方式不同，支持的操作也有差异。Codex 的共享连接仍在迭代，不应将历史可读等同于所有远程操作均可用。

### 支持图片和语音输入吗？

当前手机端以文字输入为主，尚未提供图片和语音输入。

## 源码结构

| 目录 | 内容 |
| --- | --- |
| [`product/pc/`](product/pc/) | Windows 客户端、Agent 接入与 Codex 桥 |
| [`product/android/`](product/android/) | Android 原生客户端 |
| [`product/pwa/`](product/pwa/) | iPhone 网页应用 |
| [`product/server/`](product/server/) | 网关、协议适配与部署脚本 |
| [`docs/`](docs/) | 架构决策、设计与验证记录 |

开发前请阅读 [跨端说明](product/README.md) 和对应目录的开发约定。各组件独立构建，所需环境与命令以组件文档和构建配置为准。项目介绍网站单独维护，不包含在本仓库中。

源码公开不代表所有功能均已完成生产环境验收；当前仓库尚未提供统一的开源许可证。

## 反馈问题

请在 [GitHub Issues](https://github.com/li-jinhang/Batona/issues) 中说明：

- 使用平台，以及 PC、手机端版本；
- 使用的后端（DSH 或 Codex）与连接方式；
- 复现步骤、预期结果和实际结果；
- 可公开的错误提示或截图。

请勿在公开反馈中附带接入密钥、配对码、设备令牌或私人会话内容。

## About Batona

Batona connects Android phones and an iPhone web app to coding agents running on a Windows PC. It provides remote access to workspaces and conversations, with progress, approvals and questions available where supported by the backend.

The PC remains responsible for agent execution and tool use. Batona is currently in a pilot phase and requires an access key and PC-approved phone pairing. This repository contains the Windows, Android and PWA clients, the gateway source code, development documentation and download links. The project website is maintained separately. A repository-wide open-source license has not yet been provided.
