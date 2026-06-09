package io.nisfeb.lattice.urbit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Parse an /apps/lattice response body as the agent's JSON object, translating
 * the non-JSON shapes a ship can answer with into readable errors. The agent
 * itself always answers JSON (even its own 4xx errors carry an {error} body),
 * so anything else came from Eyre: a body-less reply is its bare 404 when
 * nothing is bound at /apps/lattice (agent not installed / not running), and an
 * HTML page is the /~/login form an expired urbauth cookie redirects to.
 */
internal fun agentJson(json: Json, body: String, code: Int): JsonObject {
    if (body.isBlank()) {
        error(
            "no response from the %lattice agent (HTTP $code) — " +
                "is the %lattice desk installed and running on this ship?",
        )
    }
    if (body.trimStart().startsWith("<")) {
        error("the ship answered with a web page instead of data — your session has likely expired; log in again")
    }
    return runCatching { json.parseToJsonElement(body).jsonObject }
        .getOrElse { error("unexpected response from the %lattice agent (HTTP $code)") }
}
