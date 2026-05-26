package io.nisfeb.lattice

import io.nisfeb.lattice.urbit.AgentInstaller
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Locks the kiln-install Eyre poke shape against base's mar/kiln/install.hoon
 * grab: { local, ship (with ~), desk } poked to %hood/kiln-install.
 */
class AgentInstallerTest {

    @Test fun `installActions pokes hood kiln-install with the verified json shape`() {
        val actions = AgentInstaller.installActions("sampel-palnet")
        assertEquals(1, actions.size)
        val action = actions[0].jsonObject

        assertEquals("poke", action["action"]!!.jsonPrimitive.content)
        assertEquals("hood", action["app"]!!.jsonPrimitive.content)
        assertEquals("kiln-install", action["mark"]!!.jsonPrimitive.content)
        // Poke target is our own ship, without the leading ~.
        assertEquals("sampel-palnet", action["ship"]!!.jsonPrimitive.content)

        val json = action["json"]!!.jsonObject
        assertEquals("lattice", json["local"]!!.jsonPrimitive.content)
        assertEquals("lattice", json["desk"]!!.jsonPrimitive.content)
        // Source ship parses via ;~(pfix sig ...) — must include the ~.
        assertEquals("~ricsul-bilwyt", json["ship"]!!.jsonPrimitive.content)
    }
}
