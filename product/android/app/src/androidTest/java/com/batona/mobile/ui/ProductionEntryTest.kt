package com.batona.mobile.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.batona.mobile.SettingsStore
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlinx.serialization.json.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Explicit opt-in, no real credentials and no Agent calls. Use a dedicated AVD. */
class ProductionEntryTest {
    @get:Rule val compose = createComposeRule()

    @Test fun trustedPublicGatewayAndInvalidPairRecovery() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("productionSmoke") == "true")
        val http = OkHttpClient()
        http.newCall(Request.Builder().url("https://117.72.10.87/healthz").build()).execute().use {
            assertEquals(200, it.code)
            val health = Json.parseToJsonElement(it.body!!.string()).jsonObject
            assertEquals("hosted", health["accessMode"]!!.jsonPrimitive.content)
            assertEquals("0.2.0", health["version"]!!.jsonPrimitive.content)
        }
        val store = SettingsStore(ApplicationProvider.getApplicationContext<Application>())
        val before = store.loadAccess()
        compose.setContent { MaterialTheme { Surface { PairScreen(store) { fail("Invalid code authorized a phone") } } } }
        compose.onNodeWithText("电脑上的配对码").assertIsDisplayed().performTextInput("INVALID-PRODUCTION-SMOKE")
        compose.onNodeWithText("请求配对").performClick()
        compose.waitUntil(15000) {
            compose.onAllNodesWithText("配对码已失效，请重新打开电脑端配对页。").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("请求配对").assertIsEnabled()
        assertEquals(before, store.loadAccess())
    }
}
