package com.batona.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

internal data class ClientReleaseFile(val label: String, val url: String)

internal data class ClientUpdateCheck(
    val currentVersion: String,
    val latestVersion: String,
    val note: String,
    val download: ClientReleaseFile,
    val updateAvailable: Boolean,
    val siteVersionIsOlder: Boolean,
)

/** Reads the published website manifest. The website remains the source of release versions and files. */
internal class ClientUpdateChecker(private val serverIp: String) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()

    suspend fun check(platform: String, currentVersion: String): ClientUpdateCheck = withContext(Dispatchers.IO) {
        val origin = "https://$serverIp"
        val request = Request.Builder()
            .url("$origin/data/dsh-link.json")
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("官网更新信息暂不可用")
            val body = response.body?.string() ?: throw IOException("官网更新信息为空")
            val root = json.parseToJsonElement(body).jsonObject
            val release = root["platforms"]?.jsonObject?.get(platform)?.jsonObject
                ?: throw IOException("官网未提供此平台的版本信息")
            val latestVersion = release["version"]?.jsonPrimitive?.content
                ?: throw IOException("官网版本号无效")
            val comparison = compareVersions(latestVersion, currentVersion)
            val files = release["files"]?.jsonArray.orEmpty().mapNotNull { entry ->
                val file = runCatching { entry.jsonObject }.getOrNull() ?: return@mapNotNull null
                val rawUrl = file["url"]?.jsonPrimitive?.content ?: return@mapNotNull null
                val label = file["label"]?.jsonPrimitive?.content ?: "下载最新版"
                val downloadUrl = resolveDownloadUrl(origin, rawUrl) ?: return@mapNotNull null
                ClientReleaseFile(label, downloadUrl)
            }
            val download = files.firstOrNull() ?: throw IOException("官网暂未提供有效的安装包")

            ClientUpdateCheck(
                currentVersion = currentVersion,
                latestVersion = latestVersion,
                note = release["note"]?.jsonPrimitive?.content.orEmpty(),
                download = download,
                updateAvailable = comparison > 0,
                siteVersionIsOlder = comparison < 0,
            )
        }
    }

    private fun resolveDownloadUrl(origin: String, rawUrl: String): String? = runCatching {
        val base = URI("$origin/")
        val resolved = base.resolve(rawUrl).normalize()
        if (resolved.scheme != "https" || resolved.host != serverIp || !resolved.path.startsWith("/downloads/dsh-link/")) null
        else resolved.toASCIIString()
    }.getOrNull()

    private fun compareVersions(left: String, right: String): Int {
        fun parts(value: String): List<Int> {
            if (!value.matches(Regex("\\d+(?:\\.\\d+)*"))) throw IOException("版本号格式无效")
            return value.split('.').map { it.toIntOrNull() ?: throw IOException("版本号格式无效") }
        }

        val a = parts(left)
        val b = parts(right)
        for (index in 0 until maxOf(a.size, b.size)) {
            val comparison = (a.getOrElse(index) { 0 }).compareTo(b.getOrElse(index) { 0 })
            if (comparison != 0) return comparison
        }
        return 0
    }
}
