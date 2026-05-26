package io.nisfeb.lattice

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ShipScopeTest {

    @Test fun `strips the sig and keeps patp chars`() {
        assertEquals("sampel-palnet", shipScope("~sampel-palnet"))
        assertEquals("zod", shipScope("~zod"))
    }

    @Test fun `distinct ships get distinct scopes`() {
        assertNotEquals(shipScope("~ricsul-bilwyt"), shipScope("~martyr-sanryg"))
    }

    @Test fun `unsafe characters become underscores`() {
        // Defensive: no path separators or prefs-hostile chars survive.
        assertEquals("a_b_c", shipScope("a/b.c"))
        assertEquals("dev_42", shipScope("DEV~42"))
    }
}
