package io.nisfeb.lattice.gemtext

import io.nisfeb.lattice.Fuzz
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The gemtext parser reads fetched remote content — arbitrary bytes. It must
 *  never throw, be deterministic, and keep heading levels in their clamped range. */
class GemtextFuzzTest {
    private val N = 2_000
    private val SEED = 11L

    @Test fun parseNeverThrows() = Fuzz.run(N, SEED) { rnd, _ ->
        GemtextParser.parse(Fuzz.randomBody(rnd))
    }

    @Test fun parseIsDeterministic() = Fuzz.run(1_000, SEED) { rnd, _ ->
        val b = Fuzz.randomBody(rnd)
        assertEquals(GemtextParser.parse(b), GemtextParser.parse(b))
    }

    @Test fun headingLevelStaysClamped() = Fuzz.run(N, SEED) { rnd, _ ->
        for (line in GemtextParser.parse(Fuzz.randomBody(rnd))) {
            if (line is GemLine.Heading) assertTrue(line.level in 1..3, "level ${line.level}")
        }
    }
}
