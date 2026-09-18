package com.dshlink.app.data

import java.net.URI

/** dsh-gw:// 连接串解析（与 product/docs/绑定协议.md 一致） */
data class Binding(
    val serverIp: String,
    val frpPort: Int = 7000,
    val gwPort: Int = 443,
    val frpToken: String = "",
    val gwUser: String = "admin",
    val gwPass: String = "",
    val pair: String = "",
    val createdAt: Long = System.currentTimeMillis(),
) {
    /** 网关 HTTPS 基址（含端口，无域名场景自签证书） */
    val gatewayBase: String get() = "https://$serverIp:$gwPort"
    /** WebSocket 基址（连接时再拼 /ws?token=） */
    val wsHost: String get() = serverIp
    val wsPort: Int get() = gwPort
}

object ConnectionParser {
    /** 解析 dsh-gw://host?frpPort=..&gwPort=..&frpToken=..&gwUser=..&gwPass=..&pair=.. */
    fun parse(text: String): Binding? {
        val t = text.trim()
        if (!t.startsWith("dsh-gw://", ignoreCase = true)) return null
        return try {
            val uri = URI(t)
            val host = uri.host ?: return null
            val q = uri.query ?: ""
            fun param(name: String): String? =
                q.split("&").mapNotNull { kv ->
                    val p = kv.split("=", limit = 2)
                    if (p.size == 2 && p[0] == name) java.net.URLDecoder.decode(p[1], "UTF-8") else null
                }.firstOrNull()
            val token = param("frpToken") ?: return null
            Binding(
                serverIp = host,
                frpPort = param("frpPort")?.toIntOrNull() ?: 7000,
                gwPort = param("gwPort")?.toIntOrNull() ?: 443,
                frpToken = token,
                gwUser = param("gwUser") ?: "admin",
                gwPass = param("gwPass") ?: "",
                pair = param("pair") ?: "",
            )
        } catch (_: Exception) {
            null
        }
    }
}
