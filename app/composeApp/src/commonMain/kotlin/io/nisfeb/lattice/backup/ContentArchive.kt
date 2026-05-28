package io.nisfeb.lattice.backup

import io.nisfeb.lattice.knowledge.KnowledgeClient
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One published gemtext page in a backup bundle. */
@Serializable
data class BackupFile(val path: String, val body: String)

/** One private knowledge item in a backup bundle (key, body, cross-cutting tags). */
@Serializable
data class BackupNote(val key: String, val body: String, val tags: List<String> = emptyList())

/**
 * A portable snapshot of everything a ship's %lattice holds in agent state:
 * published gemtext pages AND the private knowledge store. The agent keeps both
 * in state (not Clay), so a |nuke/reinstall or pier loss wipes them — this one
 * bundle backs them up and restores them.
 *
 * version 2 adds `notes`; a version-1 (pages-only) bundle still imports (notes
 * defaults empty), and an older client ignores the field it doesn't know.
 * Out of scope: soft-deleted trash (already deleted) and app prefs
 * (bookmarks/theme/subscriptions persist separately via the settings agent).
 */
@Serializable
data class ContentBundle(
    val version: Int = 2,
    val ship: String,
    val files: List<BackupFile> = emptyList(),
    val notes: List<BackupNote> = emptyList(),
)

/** How many pages + notes a restore wrote. */
data class RestoreCount(val files: Int, val notes: Int)

/** Export/import a ship's published pages AND knowledge store as one JSON bundle,
 *  over the existing endpoints. */
object ContentArchive {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    /** Gather every published page + knowledge note on [ship] into a JSON bundle. */
    suspend fun export(client: LatticeClient, knowledge: KnowledgeClient, ship: String): Result<String> {
        val paths = client.list().getOrElse { return Result.failure(it) }
        val files = ArrayList<BackupFile>(paths.size)
        for (p in paths) {
            val doc = client.fetch("urb://$ship/$p").getOrElse { return Result.failure(it) }
            files.add(BackupFile(p, doc.body))
        }
        val entries = knowledge.all().getOrElse { return Result.failure(it) }
        val notes = entries.map { BackupNote(it.key, it.body, it.tags) }
        return Result.success(
            json.encodeToString(
                ContentBundle.serializer(),
                ContentBundle(ship = ship, files = files, notes = notes),
            ),
        )
    }

    /**
     * Restore a bundle: re-save each page, then each note (and re-apply its tags).
     * Fails fast (surfacing which write failed) rather than swallowing errors.
     * Idempotent — re-importing overwrites by path/key.
     */
    suspend fun import(client: LatticeClient, knowledge: KnowledgeClient, bundle: String): Result<RestoreCount> {
        val parsed = runCatching { json.decodeFromString(ContentBundle.serializer(), bundle) }
            .getOrElse { return Result.failure(IllegalArgumentException("not a lattice backup file", it)) }
        for (f in parsed.files) {
            client.save(f.path, f.body).getOrElse { return Result.failure(it) }
        }
        for (n in parsed.notes) {
            knowledge.save(n.key, n.body).getOrElse { return Result.failure(it) }
            for (t in n.tags) knowledge.tag(n.key, t).getOrElse { return Result.failure(it) }
        }
        return Result.success(RestoreCount(parsed.files.size, parsed.notes.size))
    }
}
