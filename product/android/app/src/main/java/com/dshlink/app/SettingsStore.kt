package com.dshlink.app

import android.app.Application
import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.dshlink.app.data.Binding
import com.dshlink.app.data.ConnectionParser
import kotlinx.coroutines.flow.first

private val Context.dataStore by preferencesDataStore(name = "dshlink")

/** 绑定与令牌的本地存储（DataStore） */
class SettingsStore(private val app: Application) {
    private val KEY_BINDING = stringPreferencesKey("binding")
    private val KEY_TOKEN = stringPreferencesKey("token")

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

    suspend fun clear() {
        app.dataStore.edit { it.remove(KEY_BINDING); it.remove(KEY_TOKEN) }
    }

    companion object {
        /** 与 PC 端一致的连接串格式 */
        fun connectionString(b: Binding): String =
            "dsh-gw://${b.serverIp}?frpPort=${b.frpPort}&gwPort=${b.gwPort}&frpToken=${b.frpToken}&gwUser=${b.gwUser}&gwPass=${b.gwPass}&pair=${b.pair}"
    }
}
