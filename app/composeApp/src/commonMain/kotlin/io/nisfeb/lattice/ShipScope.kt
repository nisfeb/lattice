package io.nisfeb.lattice

/**
 * A filesystem-/prefs-safe key for one ship's local storage, so bookmarks,
 * theme, etc. are scoped per ship (logging in as another ship shows that
 * ship's own data, not the previous ship's). `~sampel-palnet` → `sampel-palnet`.
 */
fun shipScope(ship: String): String =
    ship.removePrefix("~").lowercase().replace(Regex("[^a-z0-9-]"), "_")
