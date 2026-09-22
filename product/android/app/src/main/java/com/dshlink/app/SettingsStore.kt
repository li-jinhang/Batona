package com.dshlink.app

import android.app.Application
import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.dshlink.app.data.Binding
import com.dshlink.app.data.CodexMirrorCache
import com.dshlink.app.data.ConnectionParser
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json

private val Context.dataStore by preferencesDataStore(name = "dshlink")

/** 绑定与令牌的本地存储（DataStore） */
class SettingsStore(private val app: Application) {
    private val KEY_BINDING = stringPreferencesKey("binding")
    private val KEY_TOKEN = stringPreferencesKey("token")
    private val KEY_CODEX_MIRROR = stringPreferencesKey("codex_mirror")
    private val KEY_ACCESS = stringPreferencesKey("hosted_access_v1")
    private val KEY_DEVICE = stringPreferencesKey("hosted_device_v1")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    suspend fun loadBinding(): Binding? {
        val raw = app.dataStore.data.first()[KEY_BINDING] ?: return null
        return ConnectionParser.parse(raw)
    }

    suspend fun saveBinding(binding: Binding) {
        app.dataStore.edit { it[KEY_BINDING] = connectionString(binding) }
    }

    suspend fun loadToken(): String? = app.dataStore.data.first()[KEY_TOKEN]

    suspend fun saveToken(token: String) {
        app.dataStore.edit { it[KEY_TOKEN] = token }
    }

    suspend fun loadCodexMirror(): CodexMirrorCache? {
        val raw = app.dataStore.data.first()[KEY_CODEX_MIRROR] ?: return null
        return runCatching { json.decodeFromString(CodexMirrorCache.serializer(), raw) }.getOrNull()
    }

    /**
     * 存储的是 PC 已脱敏的 Codex 会话投影，供断网时浏览；认证信息仍只在既有
     * binding/token 键中保存，且 clear() 会在注销或重新绑定时一并清掉该镜像。
     */
    suspend fun saveCodexMirror(cache: CodexMirrorCache) {
        app.dataStore.edit { it[KEY_CODEX_MIRROR] = json.encodeToString(CodexMirrorCache.serializer(), cache) }
    }

    suspend fun clear() {
        app.dataStore.edit { it.remove(KEY_BINDING); it.remove(KEY_TOKEN); it.remove(KEY_CODEX_MIRROR); it.remove(KEY_ACCESS) }
    }

    suspend fun loadAccess(): String? = app.dataStore.data.first()[KEY_ACCESS]?.let { runCatching { DeviceSecrets.decrypt(it) }.getOrNull() }
    suspend fun saveAccess(token: String) {
        val encrypted = DeviceSecrets.encrypt(token)
        app.dataStore.edit { it.remove(KEY_BINDING); it.remove(KEY_TOKEN); it.remove(KEY_CODEX_MIRROR); it[KEY_ACCESS] = encrypted }
    }
    suspend fun deviceSecret(): String {
        app.dataStore.data.first()[KEY_DEVICE]?.let { runCatching { DeviceSecrets.decrypt(it) }.getOrNull()?.let { secret -> return secret } }
        val value = java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID().toString()
        val encrypted = DeviceSecrets.encrypt(value)
        app.dataStore.edit { it[KEY_DEVICE] = encrypted }
        return value
    }

    companion object {
        /** 与 PC 端一致的连接串格式 */
        fun connectionString(b: Binding): String =
            "dsh-gw://${b.serverIp}?frpPort=${b.frpPort}&gwPort=${b.gwPort}&frpToken=${b.frpToken}&gwUser=${b.gwUser}&gwPass=${b.gwPass}&pair=${b.pair}"
    }
}
