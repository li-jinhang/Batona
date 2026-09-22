package com.batona.mobile.data

/** Keep failure distinct from a legitimate empty list. Never display raw server payloads. */
class GatewayFailure(val code: String) : Exception(when (code) {
    "dsh-http-error" -> "DSH 认证失败，请在电脑端重启 Batona PC 管理的 DSH 服务后重试。"
    "codex-desktop-owned" -> "此会话由 Codex 电脑端持有，历史可查看；当前桥无法代替电脑端发送，请在电脑端继续。"
    "codex-offline", "codex-unavailable" -> "Codex 电脑端未连接，请确认 Batona PC 与 Codex 正在运行。"
    "timeout", "not-connected", "send-failed", "transport-error" -> "连接中断或请求超时，请检查电脑端与网络后重试。"
    else -> "请求未完成，请刷新后重试。"
})

internal fun <T> RpcResult<T>.requireValue(): T {
    if (!ok) throw GatewayFailure(error?.code ?: "request-failed")
    return value ?: throw GatewayFailure("invalid-response")
}
