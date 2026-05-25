package io.nisfeb.lattice.social

import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * The set of ships you follow, synced to %settings (desk "lattice", bucket
 * "follows", entry "ships") so it appears on all your installs — same
 * mechanism as saved themes.
 */
class FollowRepository(private val settings: SettingsClient) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(String.serializer())

    private companion object {
        const val DESK = "lattice"
        const val BUCKET = "follows"
        const val ENTRY = "ships"
    }

    /** Pull the follow-list from %settings, or null if unset/unreachable. */
    suspend fun pull(): List<String>? {
        val raw = settings.readEntry(DESK, BUCKET, ENTRY) ?: return null
        return runCatching { json.decodeFromString(ser, raw) }.getOrNull()
    }

    /** Persist the follow-list to %settings. */
    suspend fun push(ships: List<String>) {
        settings.putEntry(DESK, BUCKET, ENTRY, json.encodeToString(ser, ships))
    }
}
