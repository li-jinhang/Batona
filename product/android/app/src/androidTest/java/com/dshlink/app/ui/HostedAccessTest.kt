package com.dshlink.app.ui

import android.app.Application
import android.util.Base64
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.dshlink.app.SettingsStore
import com.dshlink.app.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.*

/** Real TLS -> hosted gateway -> mock Agent. Dedicated AVD; no production credentials. */
class HostedAccessTest {
    @get:Rule val compose = createComposeRule()

    @Test fun manualPairApprovalSubmitAndRevocation() = runBlocking {
        val ca = InstrumentationRegistry.getArguments().getString("fixtureCA")
        assumeTrue("Run with test/android-fixture.ts and fixtureCA", ca != null)
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(Base64.decode(ca, Base64.DEFAULT).inputStream())
        val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("fixture", cert) }
        val tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }.trustManagers.single() as X509TrustManager
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        val http = OkHttpClient.Builder().sslSocketFactory(context.socketFactory, tm).build()
        val base = "https://10.0.2.2:19443"
        fun fixture(op: String): JsonObject = http.newCall(Request.Builder().url("$base/_fixture/$op").build()).execute().use {
            assertTrue(it.isSuccessful); Json.parseToJsonElement(it.body!!.string()).jsonObject
        }
        // Adding trust for this fixture must not weaken the production/default client.
        try { OkHttpClient().newCall(Request.Builder().url("$base/healthz").build()).execute().close(); fail("Untrusted certificate accepted") }
        catch (_: SSLException) { }
        val store = SettingsStore(ApplicationProvider.getApplicationContext<Application>())
        store.clear()
        val code = fixture("open")["code"]!!.jsonPrimitive.content
        val result = AtomicReference<String?>(null)
        val binding = Binding("10.0.2.2", gwPort = 19443)
        val pairing = GatewayClient(binding, {}, {}, client = http)
        compose.setContent { MaterialTheme { PairScreen(store, pairing) { result.set(it) } } }
        compose.onNodeWithText("电脑上的配对码").performTextInput(code)
        compose.onNodeWithText("请求配对").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("请在电脑端允许这部手机。").fetchSemanticsNodes().isNotEmpty() }
        fixture("approve")
        compose.waitUntil(10000) { result.get() != null }
        assertEquals(result.get(), store.loadAccess())
        val pushes = CopyOnWriteArrayList<ServerRequest>()
        val connected = AtomicReference(false)
        val revoked = AtomicReference(false)
        val client = GatewayClient(binding, { pushes.add(it) }, { connected.set(it) }, { revoked.set(true) }, http)
        client.token = result.get()!!
        try {
            assertFalse(client.sessionPrompt("not-yet-connected", "must not queue").ok)
            client.connect()
            withTimeout(10000) { while (!connected.get()) delay(100) }
            val session = client.sessionCreate("mock")!!
            assertTrue(client.sessionPrompt(session.id, "[ask] isolated Android fixture").ok)
            withTimeout(10000) { while (pushes.none { it.method == "question/requested" }) delay(100) }
            assertEquals(1, fixture("count")["count"]!!.jsonPrimitive.int)
            val question = pushes.first { it.method == "question/requested" }
            assertTrue(client.respond(session.id, question.rpcId, buildJsonObject { put("answer", "a") }).ok)
            assertEquals(1, fixture("count")["count"]!!.jsonPrimitive.int)
            fixture("unbind")
            withTimeout(10000) { while (!revoked.get()) delay(100) }
        } finally { client.disconnect(); pairing.disconnect(); store.clear() }
    }
}
