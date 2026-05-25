package io.nisfeb.lattice.ui

/** Top-level screens. Browse is the default; Settings is reachable from each. */
sealed interface AppScreen {
    data object Browse : AppScreen
    data object Workspace : AppScreen
    data object Settings : AppScreen
    data object Discover : AppScreen
    data object Updates : AppScreen
}
