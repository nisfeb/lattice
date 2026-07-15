package io.nisfeb.lattice.social

import io.nisfeb.lattice.urbit.LatticeClient
import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * The set of ships you follow. The SHIP is the source of truth: the agent's
 * follow set (GET /follows, POST /follow + /unfollow) is what the catalog
 * crawler actually sweeps, so mutations must land there. %settings (desk
 * "lattice", bucket "follows", entry "ships") stays as a cross-install /
 * offline cache — same mechanism as saved themes — and a non-empty cache
 * seeds an empty ship-side set on pull (migration from builds that synced
 * follows to %settings only).
 */
class FollowRepository(
    private val client: LatticeClient,
    private val settings: SettingsClient,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(String.serializer())

    private companion object {
        const val DESK = "lattice"
        const val BUCKET = "follows"
        const val ENTRY = "ships"
    }

    /**
     * The follow-list, ship first. An empty ship-side set with a non-empty
     * cache means an install that predates the server routes: push the cached
     * ships up so the crawler finally sees them. An unreachable agent falls
     * back to the cache; null if both are unset/unreachable.
     */
    suspend fun pull(): List<String>? {
        val server = client.follows().getOrNull() ?: return pullCache()
        if (server.isNotEmpty()) return server
        val cached = pullCache()
        if (cached.isNullOrEmpty()) return server
        cached.forEach { client.follow(it) }
        return cached
    }

    /**
     * Persist the follow-list: reconcile the ship's follow set to [ships]
     * (follow the additions, unfollow the removals), and mirror the full list
     * to %settings for other installs.
     */
    suspend fun push(ships: List<String>) {
        settings.putEntry(DESK, BUCKET, ENTRY, json.encodeToString(ser, ships))
        val server = client.follows().getOrNull() ?: return
        (ships - server.toSet()).forEach { client.follow(it) }
        (server - ships.toSet()).forEach { client.unfollow(it) }
    }

    /** The %settings cache, or null if unset/unreachable. */
    private suspend fun pullCache(): List<String>? {
        val raw = settings.readEntry(DESK, BUCKET, ENTRY) ?: return null
        return runCatching { json.decodeFromString(ser, raw) }.getOrNull()
    }
}
