package io.nisfeb.lattice.gemtext

import io.nisfeb.lattice.Fuzz
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Link resolution reads adversarial gemtext link targets — it must never throw,
 *  and its output must always be a well-formed urb:// URL (or null). */
class UrbUrlFuzzTest {
    private val N = 2_000
    private val SEED = 7L

    @Test fun parseNeverThrows() = Fuzz.run(N, SEED) { rnd, _ ->
        UrbUrl.parse(Fuzz.randomString(rnd))
    }

    @Test fun resolveNeverThrows() = Fuzz.run(N, SEED) { rnd, _ ->
        UrbUrl.resolve(Fuzz.randomString(rnd), Fuzz.randomString(rnd))
    }

    @Test fun resolveResultIsUrbOrNull() = Fuzz.run(N, SEED) { rnd, _ ->
        val r = UrbUrl.resolve(Fuzz.randomString(rnd), Fuzz.randomString(rnd))
        if (r != null) assertTrue(r.startsWith("urb://"), "not urb://: $r")
    }

    @Test fun resolveNormalizesAwayDotSegments() = Fuzz.run(N, SEED) { rnd, _ ->
        // only the relative/absolute-path resolution normalizes; absolute urb://
        // links pass through verbatim (and may legitimately keep ./..).
        val link = Fuzz.randomString(rnd, 40)
        if (UrbUrl.isUrb(link) || UrbUrl.hasForeignScheme(link)) return@run
        val r = UrbUrl.resolve("urb://~zod/a/b", link) ?: return@run
        val body = r.removePrefix("urb://")
        val slash = body.indexOf('/')
        if (slash >= 0) for (seg in body.substring(slash + 1).split("/")) {
            assertTrue(seg != "." && seg != "..", "dot segment survived in $r")
        }
    }

    @Test fun isUrbImpliesNavigable() = Fuzz.run(N, SEED) { rnd, _ ->
        val u = Fuzz.randomString(rnd)
        if (UrbUrl.isUrb(u)) assertTrue(UrbUrl.isNavigable(u), "urb not navigable: $u")
    }

    @Test fun foreignSchemeIsNotNavigable() = Fuzz.run(N, SEED) { rnd, _ ->
        val u = Fuzz.randomString(rnd)
        if (!UrbUrl.isUrb(u) && UrbUrl.hasForeignScheme(u)) {
            assertTrue(!UrbUrl.isNavigable(u), "foreign scheme reported navigable: $u")
        }
    }

    @Test fun resolveIdempotentOnUrbLinks() = Fuzz.run(N, SEED) { rnd, _ ->
        val link = "urb://~zod/" + Fuzz.randomString(rnd, 20)
        assertEquals(link, UrbUrl.resolve(Fuzz.randomString(rnd), link))
    }
}
