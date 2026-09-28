package com.batona.mobile.data

/** Keep failure distinct from a legitimate empty list. Never display raw server payloads. */
class GatewayFailure(val code: String) : Exception(when (code) {
    "dsh-http-error" -> "DSH 认证失败，请在电脑端重启 Batona PC 管理的 DSH 服务后重试。"
    "codex-desktop-owned" -> "此会话由 Codex 电脑端持有，历史可查看；当前桥无法代替电脑端发送，请在电脑端继续。"
    "codex-native-control-unavailable" -> "这项操作暂不能安全同步到 Codex 电脑端，请在电脑端完成后刷新。"
    "native-task-ambiguous", "native-task-identity-mismatch", "native-task-history-incomplete",
    "native-task-not-listed", "native-task-list-incomplete", "native-task-title-missing" ->
        "无法确认电脑端当前 Codex 任务，输入已保留。请在电脑端打开目标任务后重试。"
    "native-desktop-unavailable", "native-window-missing", "native-window-changed", "native-task-window-unverified",
    "native-process-unverified", "native-control-unavailable" ->
        "无法安全操作电脑端 Codex 窗口，输入已保留。请解锁电脑并确认 Codex 正在运行。"
    "native-composer-unavailable", "native-send-unavailable", "native-draft-not-confirmed" ->
        "电脑端 Codex 输入控件不可用，输入已保留。请检查电脑端窗口后重试。"
    "native-composer-has-draft" -> "电脑端输入框已有草稿，手机输入已保留。请先处理电脑端草稿。"
    "native-submit-unconfirmed" -> "未能确认电脑端是否已发送。输入已保留，请先查看电脑端或刷新历史，避免重复提交。"
    "native-model-control-unavailable", "native-model-unavailable", "native-model-invalid", "native-model-unconfirmed" ->
        "电脑端模型或思考强度未能确认，请检查 Codex 原生窗口后重试。"
    "native-profile-unavailable" ->
        "电脑端权限未能确认。切换到完全访问时，请先在 Codex 电脑端完成确认。"
    "native-profile-unconfirmed" -> "电脑端权限已操作，但后台状态尚未确认，请刷新核对。"
    "native-workspace-rename-unavailable" -> "未能在电脑端唯一定位目标 Codex 工作区，请检查电脑端工作区名称后刷新重试。"
    "native-workspace-rename-unconfirmed" -> "电脑端未确认工作区重命名结果，请刷新工作区列表核对名称。"
    "workspace-not-found" -> "工作区列表已变化，请刷新后重新选择工作区。"
    "workspace-write-unconfirmed" -> "电脑端尚未确认工作区更改，请刷新列表核对后重试。"
    "workspace-ambiguous" -> "工作区对应多个项目或目录，请在 Codex 电脑端管理后刷新。"
    "workspace-invalid-path" -> "电脑上的目录不存在或不可用，请重新选择。"
    "codex-projects-unavailable", "shared-transport-readonly" -> "请在电脑端启用 Codex 共享连接，并确认 Codex 版本支持项目管理后重试。"
    "native-control-busy" -> "电脑端正在执行另一项操作，请稍后重试。"
    "codex-offline", "codex-unavailable" -> "Codex 电脑端未连接，请确认 Batona PC 与 Codex 正在运行。"
    "timeout", "not-connected", "send-failed", "transport-error" -> "连接中断或请求超时，请检查电脑端与网络后重试。"
    else -> when {
        code.startsWith("native-model-unavailable:") ->
            "电脑端模型或思考强度未能确认，请检查 Codex 原生窗口后重试。"
        code.startsWith("native-control-failed:confirm-submission:") ->
            "电脑端未能确认发送结果。请先查看 Codex 会话，避免重复发送。"
        code.startsWith("native-control-failed:") ->
            "电脑端 Codex 界面操作失败。请先查看电脑端会话状态，再决定是否重试。"
        else -> "请求未完成，请刷新后重试。"
    }
})

/** Permission selection never submits a message, so draft warnings do not apply. */
fun permissionFailureMessage(error: Exception): String = when ((error as? GatewayFailure)?.code) {
    "native-task-ambiguous", "native-task-identity-mismatch", "native-task-not-listed",
    "native-task-list-incomplete", "native-task-title-missing" ->
        "无法确认电脑端当前 Codex 任务。若权限标签已变化，请刷新核对后再重试。"
    "native-profile-unconfirmed", "native-profile-unavailable" ->
        "电脑端权限可能已变化，请刷新核对当前档位后再重试。"
    "request-failed", "invalid-response", "bridge-error" ->
        "权限切换结果尚未确认，请刷新核对电脑端当前档位。"
    else -> error.message ?: "权限切换结果尚未确认，请刷新核对电脑端当前档位。"
}

internal fun <T> RpcResult<T>.requireValue(): T {
    if (!ok) throw GatewayFailure(error?.code ?: "request-failed")
    return value ?: throw GatewayFailure("invalid-response")
}
