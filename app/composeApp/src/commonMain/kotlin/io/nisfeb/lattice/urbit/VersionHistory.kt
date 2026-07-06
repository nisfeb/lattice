package io.nisfeb.lattice.urbit

/**
 * One revision of a versioned grub (a published page or a knowledge entry).
 * [rev] is the opaque grub revision id to pass back to read-at / restore; revs
 * are NOT contiguous, so the UI keys on [updated] (the revision's date) for
 * display. Shared by [LatticeClient] (pub) and KnowledgeClient (know).
 */
data class Revision(val rev: Int, val updated: String)

/** Result of a history prune: how many old revisions were dropped vs kept. */
data class PruneResult(val dropped: Int, val kept: Int)
