package io.nisfeb.lattice.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * The ship-switcher rows, for use INSIDE a DropdownMenu's content: every
 * logged-in ship (✓ on the active one), a divider, then "Add ship" and
 * "Log out current". [closeMenu] dismisses the host menu on selection.
 *
 * This lives in the browser toolbar's ⋮ overflow menu rather than its own
 * pill — the pill crowded the address bar on mobile. Switching ships is what
 * makes the `key(activeShip)` block in App.kt rebuild every per-ship singleton
 * (see the multi-ship plan + talon's pattern).
 */
@Composable
fun ShipMenuItems(
    activeShip: String,
    ships: List<String>,
    onSwitch: (String) -> Unit,
    onAdd: () -> Unit,
    onLogoutCurrent: () -> Unit,
    closeMenu: () -> Unit,
) {
    ships.forEach { s ->
        val selected = s == activeShip
        DropdownMenuItem(
            text = { Text(s, style = MaterialTheme.typography.bodyMedium) },
            leadingIcon = {
                if (selected) Icon(Icons.Filled.Check, "active", modifier = Modifier.size(18.dp))
                else Spacer(Modifier.width(18.dp))
            },
            onClick = {
                closeMenu()
                if (!selected) onSwitch(s)
            },
        )
    }
    HorizontalDivider()
    DropdownMenuItem(
        text = { Text("Add ship") },
        leadingIcon = { Icon(Icons.Filled.Add, null, modifier = Modifier.size(18.dp)) },
        onClick = { closeMenu(); onAdd() },
    )
    DropdownMenuItem(
        text = { Text("Log out $activeShip") },
        leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null, modifier = Modifier.size(18.dp)) },
        onClick = { closeMenu(); onLogoutCurrent() },
    )
}
