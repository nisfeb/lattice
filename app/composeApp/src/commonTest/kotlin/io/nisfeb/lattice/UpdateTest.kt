package io.nisfeb.lattice

import io.nisfeb.lattice.update.NoopUpdateInstallerHook
import io.nisfeb.lattice.update.StaticUpdateRuntime
import io.nisfeb.lattice.update.UpdateManifest
import io.nisfeb.lattice.update.UpdateState
import io.nisfeb.lattice.update.UpdateStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdateManifestParseTest {
    private val valid = """
        {"versionCode":5,"versionName":"0.3.0",
         "url":"https://github.com/nisfeb/lattice/releases/download/v0.3.0/lattice-0.3.0.apk",
         "sha256":"$ABC","minSdk":26,"changelog":"stuff","mandatory":false}
    """.trimIndent()

    @Test fun parsesValidManifest() {
        val m = UpdateManifest.parse(valid)!!
        assertEquals(5, m.versionCode)
        assertEquals("0.3.0", m.versionName)
        assertEquals(ABC, m.sha256)
        assertEquals(26, m.minSdk)
        assertEquals(false, m.mandatory)
    }

    @Test fun rejectsNonHttpsUrl() {
        assertNull(UpdateManifest.parse(valid.replace("https://", "http://")))
    }

    @Test fun rejectsMalformedSha256() {
        assertNull(UpdateManifest.parse(valid.replace(ABC, "deadbeef")))
    }

    @Test fun rejectsMissingVersionCode() {
        assertNull(UpdateManifest.parse("""{"url":"https://x/a.apk","sha256":"$ABC","versionName":"1"}"""))
    }

    @Test fun rejectsGarbage() {
        assertNull(UpdateManifest.parse("not json"))
    }

    @Test fun defaultsMinSdkAndMandatory() {
        val m = UpdateManifest.parse(
            """{"versionCode":1,"versionName":"0.1.0","url":"https://x/a.apk","sha256":"$ABC"}""",
        )!!
        assertEquals(26, m.minSdk)
        assertEquals(false, m.mandatory)
    }

    companion object {
        const val ABC = "0000000000000000000000000000000000000000000000000000000000000000"
    }
}

class UpdateStateTest {
    private val scope = CoroutineScope(Dispatchers.Unconfined)
    private val noop = NoopUpdateInstallerHook()

    private fun manifest(code: Int, minSdk: Int = 26) = UpdateManifest(
        versionCode = code, versionName = "v$code",
        url = "https://x/a.apk", sha256 = UpdateManifestParseTest.ABC,
        minSdk = minSdk, changelog = "", mandatory = false,
    )

    private fun state(installed: Int, sdk: Int = 35) =
        UpdateState(scope, StaticUpdateRuntime(installed, sdk), noop)

    @Test fun newerManifestBecomesAvailable() {
        val s = state(installed = 1)
        s.onManifest(manifest(2))
        assertTrue(s.status.value is UpdateStatus.Available)
    }

    @Test fun sameOrOlderIgnored() {
        val s = state(installed = 5)
        s.onManifest(manifest(5)); assertEquals(UpdateStatus.Idle, s.status.value)
        s.onManifest(manifest(4)); assertEquals(UpdateStatus.Idle, s.status.value)
    }

    @Test fun minSdkTooHighIgnored() {
        val s = state(installed = 1, sdk = 26)
        s.onManifest(manifest(2, minSdk = 99))
        assertEquals(UpdateStatus.Idle, s.status.value)
    }

    @Test fun dismissClearsAvailable() {
        val s = state(installed = 1)
        s.onManifest(manifest(2))
        s.dismiss()
        assertEquals(UpdateStatus.Idle, s.status.value)
    }

    @Test fun noopInstallerReportsFailure() = runTest {
        var msg: String? = null
        noop.download(manifest(2), onProgress = {}, onReady = {}, onFailure = { msg = it })
        assertTrue(msg != null)
        noop.install("/tmp/x.apk") // no-op, must not throw
    }
}
