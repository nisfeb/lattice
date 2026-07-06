package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.explainNetworkError
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import kotlin.test.Test
import kotlin.test.assertTrue

class NetworkErrorTest {

    @Test fun dnsFailureNamesTheShipAndUrl() {
        val m = explainNetworkError(UnknownHostException("sampel.arvo.network"), "~sampel-palnet")
        assertTrue("~sampel-palnet" in m && "Can't find" in m, m)
    }

    @Test fun connectionRefused() {
        val m = explainNetworkError(ConnectException("Failed to connect to /127.0.0.1:80"), "~tyr")
        assertTrue("connect" in m.lowercase() && "running" in m, m)
    }

    @Test fun readTimeoutExplainsTheDozenCauses() {
        val m = explainNetworkError(SocketTimeoutException("timeout"), "~tyr")
        assertTrue("didn't respond in time" in m, m)
        // names several likely causes, not just "timeout"
        assertTrue("offline" in m && "URL" in m, m)
    }

    @Test fun callTimeoutIsAlsoATimeout() {
        // okhttp's overall callTimeout throws InterruptedIOException("timeout").
        val m = explainNetworkError(InterruptedIOException("timeout"), "~tyr")
        assertTrue("didn't respond in time" in m, m)
    }

    @Test fun tlsFailure() {
        val m = explainNetworkError(SSLHandshakeException("trust anchor for certification path not found"), "~tyr")
        assertTrue("HTTPS" in m || "secure" in m.lowercase(), m)
    }

    @Test fun peerNoResponsePassesThroughAsPageShipDown() {
        val m = explainNetworkError(RuntimeException("no response from peer"), "~zod")
        assertTrue("didn't respond" in m || "offline" in m, m)
    }

    @Test fun agentLevelMessagesPassThroughUnchanged() {
        val agent = "no response from the %lattice agent (HTTP 404) — is the %lattice desk installed and running on this ship?"
        assertTrue(explainNetworkError(RuntimeException(agent), "~tyr") == agent)
        val login = "the ship answered with a web page instead of data — your session has likely expired; log in again"
        assertTrue(explainNetworkError(RuntimeException(login), "~tyr") == login)
    }

    @Test fun nullShipFallsBackGracefully() {
        val m = explainNetworkError(SocketTimeoutException("timeout"), null)
        assertTrue("the ship" in m, m)
    }
}
