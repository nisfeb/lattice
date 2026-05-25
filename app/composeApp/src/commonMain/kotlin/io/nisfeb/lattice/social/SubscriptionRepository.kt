package io.nisfeb.lattice.social

import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * The urb:// files you've subscribed to for change notifications, synced to
 * %settings (desk "lattice", bucket "subs", entry "urls"). The desk holds the
 * authoritative keen-follow state; this list lets the UI show subscribe state
 * and re-arm the desk on login.
 */
class SubscriptionRepository(private val settings: SettingsClient) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(String.serializer())

    private companion object {
        const val DESK = "lattice"
        const val BUCKET = "subs"
        const val ENTRY = "urls"
    }

    suspend fun pull(): List<String>? {
        val raw = settings.readEntry(DESK, BUCKET, ENTRY) ?: return null
        return runCatching { json.decodeFromString(ser, raw) }.getOrNull()
    }

    suspend fun push(urls: List<String>) {
        settings.putEntry(DESK, BUCKET, ENTRY, json.encodeToString(ser, urls))
    }
}
