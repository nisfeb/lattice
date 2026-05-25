package io.nisfeb.lattice

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import io.nisfeb.lattice.bookmarks.AndroidBookmarkStore
import io.nisfeb.lattice.theme.AndroidThemeStore
import io.nisfeb.lattice.urbit.AndroidSessionStore

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sessions = AndroidSessionStore(applicationContext)
        val bookmarks = AndroidBookmarkStore(applicationContext)
        val themes = AndroidThemeStore(applicationContext)
        setContent { App(sessions, bookmarks, themes) }
    }
}
