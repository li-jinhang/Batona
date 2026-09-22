# 开发前基线登记

采集日期：2026-09-22。本文件是只读检查快照，不是备份、提交或“已通过测试”证明。

## Git 状态

- 当前分支：main。
- HEAD：460d5891292ab37e128dd7341115640053fcdf64。
- 本轮写文档前：27 个已跟踪文件有修改，汇总为 539 行增加、263 行删除；另有未跟踪源码、测试、ADR 与 output 目录。
- HEAD 不包含这些未提交成果。不能从 HEAD 单独新建干净检出后，就宣称保留了当前功能。
- 本轮只新增本目录的草案；未移动、删除、暂存、提交或覆盖任何旧改动。
- output/ 只登记其存在，未读取或复制内容。以下哈希清单仅覆盖 Git 报告变化的产品/文档文件，排除忽略的凭据和产物；不是全工作区快照。

## 已知限制与待更新文档

- 本地包文件标记 PC 0.3.8、网关 0.1.35，不等于当前在线版本。服务器记忆登记的 v0.1.34 是历史核查，本轮未 SSH 复核。
- PC 记忆明确：Codex Desktop 已持有会话仍存在 writer 限制；历史可读取不能证明手机可发送。此能力差距不能由账号改造掩盖。
- Android 现有记忆保留模拟器验收要求。业务迁移应替换旧连接串/TOTP 验证步骤，但继续使用独立 AVD，不能卸载用户当前 AVD 应用以清空状态。
- 共享 README 仍有旧 frp 回退、连接串/TOTP、单实例认证描述；Android 记忆有不预设网关地址的旧约束；服务器记忆有旧全局适配器与一般凭据不回显规则。授权实施时按本规格同步修订：公开 IP 可预设，后台完整密钥查看是受控例外；不能宽泛放开日志/推送泄密。
- 服务器首页和 Nginx 规则已有其他工作变更；这次不得以根路径反代覆盖静态首页或其他项目。
- 现有证书供应商相关历史断言未核实，本草案不依赖它。TLS 具体方案在任务 08 验证。

## 可复用的测试证据入口（已阅读，未执行）

- [网关 mock 冒烟](../../../product/server/gateway/test/smoke.ts)：真实 HTTP/WS 装配，假 Adapter，登录、请求、推送和审批往返。
- [隧道端到端](../../../product/server/gateway/test/tunnel-e2e.ts)：临时端口、假上游与真实隧道服务，可扩展多 PC 场景。
- [Android UI 回归](../../../product/android/app/src/androidTest/java/com/batona/mobile/ui/BackendNavigationTest.kt)：DSH/Codex/Claude 导航与模型/权限状态；并非登录端到端证明。
- [PC 生命周期约束](../../../product/pc/AGENTS.md)、[Android 验收约束](../../../product/android/AGENTS.md)、[服务器运维约束](../../../product/server/AGENTS.md) 是后续任务的必读入口。
- 构建/测试命令以各端 package/Gradle 配置和记忆为准；本轮只做文档结构、链接、依赖和 Git 差异检查。

## 既有变更指纹

用途：后续实施前比对，发现新的并行改动时重新协调。表内路径已按 Batona 当前命名归一化，哈希仍表示采集时的改名前内容，因此品牌迁移后不应与当前文件直接比对。指纹不是恢复数据；需要恢复能力时须另行安排受控备份或获准提交，不能用此表替代。

| 相对仓库路径 | SHA-256（写入本轮草案前） |
|---|---|
| CONTEXT.md | 29c713df8195f0fdb24dde328df0f761f91e4cd60d803d6e117e1f6c66c393fd |
| docs/adr/0002-hosted-invite-only-accounts.md | 15b75b2f8ddb8abdf977d508c8e10fd0d458614e3741b64fac5e1276d7d9b1dd |
| product/android/AGENTS.md | d75caf1e2ece7a98d7f27e7448a449fdcd1224778082ca5b4ff761130244fb3b |
| product/android/app/build.gradle.kts | ab37a2d8909fa219fb1bcf1487cc69d0983cfcc6e6792ef0527d34c4ed4bfccf |
| product/android/app/src/androidTest/java/com/batona/mobile/ui/BackendNavigationTest.kt | c3ca09a4c5c8410d93c5ebd0bf94cb7675f585143b8c70dde2d4f91639a731c6 |
| product/android/app/src/main/java/com/batona/mobile/data/GatewayClient.kt | 01a1e16431905a2c1c6b3984c423ac61ff006e65f843631fa6c354d5d6cc2f3b |
| product/android/app/src/main/java/com/batona/mobile/data/GatewayFailure.kt | 8fdb4b5504e94cf9ab606a8389bf106f726d7ad05896006dbdb478e6e3988b3f |
| product/android/app/src/main/java/com/batona/mobile/data/Models.kt | f7785133f79b72c86dca5672f0849224ec84358e9f1b9a6bc376d78c69687c41 |
| product/android/app/src/main/java/com/batona/mobile/ui/BindScreen.kt | 601c892f15a4d1cd6cd5e3fa93c592c061ee4ca359b42e16c435e53f93e8e9a8 |
| product/android/app/src/main/java/com/batona/mobile/ui/HomeScreen.kt | 03b07ab7a2917aa3a7c3d5ed1e3c19a207cbeb506eeac96e4d21f1eda333eb61 |
| product/android/app/src/test/java/com/batona/mobile/ui/HomeStateTest.kt | e6eebf29bf14f80d6bf06045bae26d5d52580d3f933028a891fc68175d2d7f38 |
| product/docs/需求-Batona远程接入网关.md | 22d91c32cc1a8e933339b3fe0eff220ec033d064ac8f4de4e9b3b916bb394916 |
| product/pc/AGENTS.md | 4883d85f140f0d03e18d21058d7afe4c1ad45a1cedace1bf7addf1e234ba4779 |
| product/pc/codex-bridge.js | 2f12e188eca056be456c55376e00e94cb6ae41e7a1aa771ecc2e1e8d3d3d4336 |
| product/pc/dsh-launcher.js | 33c32b09a0cfe5edb984e5f0fe5eb7ca9899ee43070bca2037af00061fcda350 |
| product/pc/main.js | 7be4befb762499ab794a2e6d456d8e2d87326224455751a52f8705a48436ec72 |
| product/pc/package-lock.json | 71c9dd73cdf4475f054a6d2ceacd137481b92a109185b0f400741c038e0bb7d8 |
| product/pc/package.json | 77f0a5f3b70b7c91d62b547e66d1aa9c903a742365a416ed1c4313f04e9ea164 |
| product/pc/renderer/app.js | 6b1fe382231827b852636c29d573b0a5f7b203044e99ed5cd4f02c381e2cf956 |
| product/pc/renderer/index.html | ab2567dc62b6e38667e71da4755abcf5fb78ac1cd2e4b5b5ca61a6c5fc4587a8 |
| product/pc/renderer/style.css | 45f1231704d5e5989ae6a814fcea342655b4f942368c2ef0efea3f67caa8f6ed |
| product/pc/software-status.js | 359f8588f96d4c93b5ea59d8f86a83888dd008d19752c7a2e5c0dcb1fbb8a7d0 |
| product/pc/test/codex-open.test.js | 261becab5aa2d9b341772d11cc63d8b86dcea749f7dfb92dcf43ba0001fa8a29 |
| product/pc/test/dsh-launcher.test.js | ab2fa5bd59a3a4aacb759e848845d1b58d88602f17a481b9f0e1147e23989ac3 |
| product/pc/test/live-backends.cjs | 008cd437ced8c87c923b64f3bc013d8eb66f89c4b2a49f2aa5ae570067886364 |
| product/pc/test/software-status.test.js | c5ef3fee2dc47b237cf7e44bb320cc04549de644f117e06f378c59dfcf5b2a64 |
| product/README.md | 06bf12de865860ecbab323fb9c9ec7280e1d0b77816256f9d0e7a32b38f3286c |
| product/server/服务器操作指南.md | 63baf3d626c8e62a21a5182045e9cc17637c788c01a2c2b31a03ad63e1ad2f9f |
| product/server/AGENTS.md | bf732da9337ef9a20dd6266b327c6e532e1aa5711471757d02c2a3bf6b9d0725 |
| product/server/gateway/package-lock.json | 16873a358f0b527f1a4c48b9b32b54ca39e64ad602c80c147648c45aca468f14 |
| product/server/gateway/package.json | ef42026979b51d70cb8e03e2b4069031758ef85a1d013e0a404e8c37ec67785e |
| product/server/gateway/src/adapter/codex/adapter.ts | dee0fb744fa6ecd607616f8ccf4de8a15081f8679e1baebebc62ff31a7e66624 |
| product/server/gateway/src/adapter/contract.ts | 1960cdbaa9488f25f2c45ee7e73c54392dd9cb7387ef4ef3385d934052ebe15d |
| product/server/gateway/src/adapter/dsh/adapter.ts | 01e1f7f7fceebfee65dbfcf68a27aa9c1461e05a7e7220c5d0a3233154e9d18a |
| product/server/gateway/src/session/router.ts | cae64790a2fb82462b369229da619b7d360a070b2a4e9b089bba7f523e324e3b |
| product/server/gateway/test/session-model.ts | 86328c67341d76c32d1326731e8215c1bed4f08e5acc538942d65be65db7dbcd |
| product/server/nginx-batona-gateway-routes.conf | 47806fb513ae2c9221f39f1c959c1b499befd2abe1f1166d5ab34cb1a0a4c0d9 |
| product/server/nginx-batona-gateway.conf | e897f846513a61f0afe83f312142872a7dcb093d189ed5b8af10682d3426c414 |
