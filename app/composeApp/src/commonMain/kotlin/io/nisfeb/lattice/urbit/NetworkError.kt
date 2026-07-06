package io.nisfeb.lattice.urbit

import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Turn a request failure into a specific, actionable message. A transport
 * failure (timeout / refused / DNS / TLS) otherwise surfaces as an opaque okhttp
 * string — "timeout", "Failed to connect to /1.2.3.4:80" — that doesn't say which
 * of the dozen possible causes it was. Agent-level failures already carry human
 * messages (see [agentJson]) and pass through unchanged. Names [ship] so the user
 * can sanity-check the target it was trying to reach.
 */
fun explainNetworkError(t: Throwable?, ship: String?): String {
    val who = ship?.trim()?.ifBlank { null } ?: "the ship"
    val msg = t?.message.orEmpty()
    val low = msg.lowercase()
    return when {
        // Already explained by agentJson / the agent's own error envelope.
        "%lattice" in msg || "log in" in low || "session has" in low || "no response from the" in low -> msg
        // The agent's 504 when a REMOTE page's ship didn't answer the peek.
        "no response from peer" in low ->
            "$who answered, but the page's ship didn't respond — it may be offline, or isn't publishing this with Lattice."
        t is UnknownHostException || "unable to resolve host" in low || "nodename nor servname" in low ->
            "Can't find $who — check the ship's URL, and that this device is online."
        t is ConnectException || "connection refused" in low || "failed to connect" in low ->
            "Couldn't connect to $who — is the ship running, and are the URL and port right?"
        t is SSLException || "trust anchor" in low || "certificate" in low || "sslhandshake" in low ->
            "The secure (HTTPS) connection to $who failed — check its certificate, or use http if it's on your local network."
        t is SocketTimeoutException || t is InterruptedIOException || "timeout" in low || "timed out" in low ->
            "$who didn't respond in time — it may be offline or overloaded, the URL may be wrong, or this device's connection may be down."
        msg.isBlank() -> "Couldn't reach $who — unknown network error."
        else -> "Couldn't reach $who: $msg"
    }
}
