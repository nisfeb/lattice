package io.nisfeb.lattice.theme

import kotlinx.serialization.Serializable

/** A user-named theme. */
@Serializable
data class SavedTheme(val name: String, val settings: ThemeSettings)
