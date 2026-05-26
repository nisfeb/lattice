package io.nisfeb.lattice.backup

import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One published file in a backup bundle. */
@Serializable
data class BackupFile(val path: String, val body: String)

/**
 * A portable snapshot of a ship's published gemtext. Since state-6 the agent
 * keeps content in agent state (not Clay), so a |nuke/reinstall wipes it —
 * this bundle lets the user back it up and restore it.
 */
@Serializable
data class ContentBundle(val version: Int = 1, val ship: String, val files: List<BackupFile>)

/** Export/import a ship's published content as a JSON bundle, over the existing
 *  list/fetch/save endpoints (no agent support needed). */
object ContentArchive {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    /** Gather every published file on [ship] into a JSON bundle. */
    suspend fun export(client: LatticeClient, ship: String): Result<String> {
        val paths = client.list().getOrElse { return Result.failure(it) }
        val files = ArrayList<BackupFile>(paths.size)
        for (p in paths) {
            val doc = client.fetch("urb://$ship/$p").getOrElse { return Result.failure(it) }
            files.add(BackupFile(p, doc.body))
        }
        return Result.success(
            json.encodeToString(ContentBundle.serializer(), ContentBundle(ship = ship, files = files)),
        )
    }

    /** Restore a bundle by re-saving each file. Returns the number restored.
     *  Fails fast (and surfaces which write failed) rather than partially
     *  swallowing errors. */
    suspend fun import(client: LatticeClient, bundle: String): Result<Int> {
        val parsed = runCatching { json.decodeFromString(ContentBundle.serializer(), bundle) }
            .getOrElse { return Result.failure(IllegalArgumentException("not a lattice backup file", it)) }
        for (f in parsed.files) {
            client.save(f.path, f.body).getOrElse { return Result.failure(it) }
        }
        return Result.success(parsed.files.size)
    }
}
