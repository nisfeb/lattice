package io.nisfeb.lattice.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * A `~ship ▾` pill that, when tapped, lists every logged-in ship, with an
 * "Add ship" entry and a "Log out current" entry at the bottom.
 *
 * The picker is the only way to switch ships at runtime — login/logout flow
 * sets `activeShip` in App.kt, which is what makes the `key(activeShip)` block
 * rebuild every per-ship singleton. See multi-ship plan + talon's pattern.
 */
@Composable
fun ShipPicker(
    activeShip: String,
    ships: List<String>,
    onSwitch: (String) -> Unit,
    onAdd: () -> Unit,
    onLogoutCurrent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        TextButton(onClick = { open = true }) {
            Text(activeShip, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            Icon(Icons.Filled.ArrowDropDown, null, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            ships.forEach { s ->
                val selected = s == activeShip
                DropdownMenuItem(
                    text = { Text(s, style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = {
                        if (selected) Icon(Icons.Filled.Check, "active", modifier = Modifier.size(18.dp))
                        else Spacer(Modifier.width(18.dp))
                    },
                    onClick = {
                        open = false
                        if (!selected) onSwitch(s)
                    },
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("Add ship") },
                leadingIcon = { Icon(Icons.Filled.Add, null, modifier = Modifier.size(18.dp)) },
                onClick = { open = false; onAdd() },
            )
            DropdownMenuItem(
                text = { Text("Log out $activeShip") },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null, modifier = Modifier.size(18.dp)) },
                onClick = { open = false; onLogoutCurrent() },
            )
        }
    }
}
