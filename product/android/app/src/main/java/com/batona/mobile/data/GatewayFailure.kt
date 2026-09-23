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
    "native-model-control-unavailable", "native-model-unavailable", "native-model-invalid" ->
        "电脑端模型或思考强度未能确认，请检查 Codex 原生窗口后重试。"
    "native-profile-unavailable" ->
        "电脑端权限未能确认。切换到完全访问时，请先在 Codex 电脑端完成确认。"
    "native-control-busy" -> "电脑端正在执行另一项操作，请稍后重试。"
    "codex-offline", "codex-unavailable" -> "Codex 电脑端未连接，请确认 Batona PC 与 Codex 正在运行。"
    "timeout", "not-connected", "send-failed", "transport-error" -> "连接中断或请求超时，请检查电脑端与网络后重试。"
    else -> "请求未完成，请刷新后重试。"
})

internal fun <T> RpcResult<T>.requireValue(): T {
    if (!ok) throw GatewayFailure(error?.code ?: "request-failed")
    return value ?: throw GatewayFailure("invalid-response")
}
