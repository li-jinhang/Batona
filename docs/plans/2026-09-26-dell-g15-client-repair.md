# 戴尔 G15 客户端问题修复规格

## Problem Statement

用户使用网站当前发布的 Batona PC 0.5.21 与 Batona Mobile 0.3.16 在戴尔 G15 上测试时，手机不能可靠地看到 Codex 会话的运行、思考和重连进度；界面控制模式下选择模型或思考强度，弹窗虽出现但实际设置未变；PC 切换共享连接时报出 PowerShell `about_Execution_Policies` 错误。PC 的 DSH 详情缺少启动服务和打开界面的入口，手机助手 Markdown 正文气泡偏灰，DSH 未分组会话不显示，Codex 无可确认工作区的会话也需在列表末尾显示。Codex 控制方式的按钮顺序和说明文字还需调整。

## Solution

手机以本地 Agent 主机可确认的 **Session Progress** 显示 Codex 运行、思考和重连状态；有真实重试次数才显示 `x/5`，不借用手机到网关的重连计数。模型选择允许在目标模型不支持当前思考强度时切到其支持的默认强度，手机只在后端确认 **Effective Model Selection** 后报告成功；下一轮使用该组合，Desktop 标签暂时滞后时给出独立提示。

PC 对受信任的内置共享连接脚本采用仅限本次进程的 PowerShell 执行策略处理，不更改系统或用户策略；策略仍禁止执行时提供可读错误并保留现有 Codex 进程。DSH 详情提供独立的“启动 DSH 服务”与“打开 DSH 界面”按钮：启动前核对实际 Node.js 依赖，缺失时提示用户安装后重试；DSH 未运行时浏览器按钮灰显，运行且认证就绪后由 PC 安全打开本地界面。手机只调淡助手 Markdown 正文气泡。DSH 与 Codex 的 **Ungrouped Session** 均在真实工作区后单独显示，不提供工作区专属操作。Codex 控制方式中共享连接排在界面控制上方，标注“（推荐）”，说明分别为“更快速，版本鲁棒性差”和“协议更迭时的平替方案”。

## User Stories

1. As a Codex mobile user, I want a newly submitted request to enter a visible running state immediately, so that I know it was accepted.
2. As a Codex mobile user, I want confirmed thinking progress to appear while the backend is thinking, so that a quiet response is not mistaken for a stalled request.
3. As a Codex mobile user, I want a genuine backend reconnection state to appear during a turn, so that I can distinguish retrying from idle time.
4. As a Codex mobile user, I want a retry count only when the PC actually reports it, so that `x/5` does not misrepresent a separate phone connection.
5. As a Codex mobile user, I want connection loss to remain understandable when no count is available, so that I can decide whether to wait or retry later.
6. As a Codex mobile user, I want progress updates attached to the correct Backend Session, so that another session's state never appears in my open chat.
7. As a Codex mobile user, I want running and retry states to clear on completion or failure, so that stale indicators do not remain visible.
8. As a Codex mobile user, I want the model picker to remain usable when the current reasoning effort is unknown, so that an unsynchronised value does not block all models.
9. As a Codex mobile user, I want to choose a model whose supported efforts differ from my current one, so that I am not trapped on the old model.
10. As a Codex mobile user, I want the final model and adjusted effort shown together before they are treated as active, so that I understand the resulting choice.
11. As a Codex mobile user, I want a model change to be reported as successful only after the backend confirms it, so that a clicked menu is not mistaken for an effective setting.
12. As a Codex mobile user, I want the next turn to use the confirmed model and effort, so that the change affects actual work.
13. As a Codex mobile user, I want the previous value and a useful error preserved when a setting cannot be confirmed, so that I can retry without false success.
14. As a Codex mobile user, I want a temporarily stale Desktop label distinguished from the backend result, so that a display lag does not erase a real setting change.
15. As a PC user, I want switching to shared connection to work under a normal restrictive PowerShell policy, so that the Codex control mode can be enabled without changing my global policy.
16. As a PC user, I want an enforced policy failure described in readable Chinese, so that I know the script did not run and what to check next.
17. As a PC user, I want a failed shared connection switch to leave my current Codex Desktop process and control mode intact, so that I can continue working.
18. As a PC user, I want the DSH details dialog to contain a dedicated service start button, so that I can start DSH without also requesting unrelated actions.
19. As a PC user without a working Node.js dependency, I want a clear installation prompt and a safe failed start, so that I can prepare the environment myself.
20. As a PC user with DSH already running, I want another start click to avoid a duplicate service, so that the existing session remains stable.
21. As a PC user, I want “打开 DSH 界面” disabled until DSH is ready, so that the button does not open a broken page.
22. As a PC user, I want the ready DSH button to open the authenticated local interface in my browser, so that I can use DSH directly.
23. As a PC user, I want the browser launch to keep the DSH credential inside the privileged PC process, so that the interface does not expose it to page code.
24. As a mobile user, I want assistant Markdown content to sit on a lighter background, so that it is easier to read while still distinguishable from plain chat.
25. As a mobile user, I want the analysis card to retain its separate visual role, so that the Markdown color change does not blur different message types.
26. As a DSH mobile user, I want Backend Sessions without a Workspace association under “未分组” at the end of the list, so that they are not lost.
27. As a Codex mobile user, I want Desktop Sessions whose work directory cannot be confirmed under the same “未分组” section, so that I can still find them.
28. As a mobile user, I want every visible session to appear in exactly one real workspace or the ungrouped section, so that a session is neither hidden nor duplicated.
29. As a mobile user, I want the ungrouped section to expand and load older sessions like other session collections, so that I can browse beyond the newest entries.
30. As a mobile user, I want the ungrouped section to omit workspace creation and removal actions, so that I cannot mistake it for a real directory.
31. As a mobile user, I want refreshing the session list to update ownership when the backend later confirms a workspace, so that a session moves to its real group without duplication.
32. As a PC user, I want “共享连接（推荐）” above “界面控制”, so that the suggested control mode is visible first.
33. As a PC user, I want the shared option to say “更快速，版本鲁棒性差”, so that I understand its speed and compatibility trade-off.
34. As a PC user, I want the interface option to say “协议更迭时的平替方案”, so that I understand when to use it.
35. As a tester on the Dell G15, I want updated versioned PC and Android packages after verification, so that I can retest the fixes without confusing them with 0.5.21 and 0.3.16.
36. As an operator, I want any required gateway change deployed before dependent clients, so that the new session collection and progress fields work through the production route.

## Implementation Decisions

- Keep the PC backend as the authority for Session Progress. Map gateway session identifiers to backend session identifiers before changing a mobile session's displayed state. Project confirmed thinking and retry states through the existing session event route; represent a retry count only if the backend supplies it.
- Treat the model picker, the selection request, the backend's effective setting, and the Desktop label as separate states. On an unsupported or unknown current effort, choose a supported default for the target model and show the resulting pair. Verify the effective pair before reporting success; preserve the previous pair when verification fails. Confirm next-turn behavior in end-to-end acceptance.
- For shared connection, run only the packaged handoff script with a process-scoped PowerShell policy option. Keep path and process identity checks, and surface an explicit policy error when Group Policy or another enforced scope still blocks execution. Do not change machine or user execution policy.
- Give the DSH dialog a start action separate from the existing combined service action. Check whether its actual launcher has a working Node.js dependency before launching. Do not install Node.js automatically. Open DSH only when the local service and authentication are ready; perform the browser action in the privileged PC process.
- Change only the assistant Markdown body bubble color. Keep the analysis card styling and message type distinction.
- Add a backward-compatible optional ungrouped collection alongside real workspace entries. DSH derives it from sessions absent from every workspace association. Codex resolves available work directory data before classifying a session with no confirmed directory. Show this collection last, with session actions and paging but without workspace actions. Preserve the existing per-workspace limit and apply the same initial limit to ungrouped sessions.
- Make the Codex control option order and copy match the user's exact wording. Keep the existing explicit restart confirmation and control-mode state handling.
- Build new client versions after affected tests pass. If the gateway contract changes, deploy the gateway first; then publish the versioned installers and site release data using the existing installation-package workflow.

## Testing Decisions

- Tests should assert user-observable state and backend effects, not merely that a dialog opened or a handler returned `accepted`.
- Use the existing mobile UI fixture at the session event boundary to reproduce gateway-ID versus backend-ID mismatch, then assert running, thinking, retry, completion, and session isolation. Include no-count retry as a distinct case.
- Use the existing model selection UI and PC bridge fixtures to click an option, cover unknown/unsupported effort, read back the effective pair, and reject an accepted-but-unchanged backend. Check the model and effort used by the next turn during full-chain acceptance.
- Use the existing PC handoff fixture and a read-only PowerShell 5.1 invocation with a restrictive process policy. The pre-fix command reproduces the `about_Execution_Policies` error with exit code 1; after the fix, test both a process-scoped successful run and a still-enforced policy failure without touching global policy or terminating Desktop.
- Use the PC renderer fixture for DSH button enabled/disabled states and Codex option order/copy. Use the main-process service seam for missing Node.js, already-running DSH, and authenticated browser launch; verify no credential reaches the renderer.
- Use the existing gateway adapter/session fixtures for DSH and Codex membership conservation: each listed session appears once, in a real workspace or ungrouped. Exercise missing Codex work directory, later directory resolution, empty workspaces, ordering, paging, and old-client tolerance of the optional field.
- Review the assistant Markdown bubble visually on the Android test emulator at narrow and normal widths. This reversible color adjustment does not require a test that merely repeats the chosen color value.
- Run affected PC, gateway, and Android unit/UI suites, package both PC outputs and the Android APK, then perform a Dell G15 smoke pass for shared switching, model/effort change, live progress, DSH launch, and ungrouped browsing.

## Out of Scope

- Installing Node.js automatically or altering Windows machine/user execution policy.
- Fabricating Codex Desktop retry counts or equating the phone's network reconnection with the Agent's retry state.
- Treating a temporarily stale Desktop label as proof that backend model selection failed.
- Changing the analysis-process card color, adding image or voice input, or redesigning unrelated chat components.
- Turning “未分组” into a real workspace or permitting workspace management actions on it.
- Changing Windows code signing or replacing the Android Debug signing identity in this repair.

## Further Notes

- The Dell G15 reports PC 0.5.21 and Android 0.3.16. The exact execution-policy scope and whether model options were disabled or accepted without effect were not provided; implementation tests must cover both relevant paths. A locally restricted PowerShell 5.1 invocation of the packaged handoff script reproduced the same `about_Execution_Policies` message and exit code 1.
- The domain terms Backend Session, Ungrouped Session, Session Progress, and Effective Model Selection are recorded in the project glossary. The ungrouped collection boundary is recorded in ADR 0005; the Codex control boundary remains governed by ADR 0003.
- Issue-tracker publication and the `ready-for-agent` label are pending project issue-tracker configuration. This document is the local specification until that destination is supplied.
