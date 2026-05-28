package io.nisfeb.lattice

import kotlin.random.Random

/**
 * Seeded generators + runner for property-style fuzzing. Dep-free — kotlin.random
 * + kotlin.test is enough to find crashes and invariant violations in our parsers,
 * mirroring talon's `Fuzz`. Failures surface the seed so they replay exactly:
 * re-running with the same seed reproduces the offending sequence.
 */
object Fuzz {

    /** Tokens biased toward what the urb:// + gemtext parsers actually branch on. */
    private val WORDS = listOf(
        "", " ", "a", "a/b", "/", "//", "../", "./", "..", ".", "/a/../b",
        "urb://", "urb://~zod", "urb://~zod/a/b", "urb://~ricsul-bilwyt/x/y",
        "~zod", "~ricsul-bilwyt", "https://x", "http://", "HTTPS://",
        "mailto:a@b", "javascript:alert(1)", "data:text/html,x", "ftp://h",
        "=> /x  go", "=>", "=> urb://~zod/p desc", "# h", "## ", "#### ",
        "```", "```alt", "* item", "> quote", "<b>", "&amp;", "\"", "\\",
        ":", "%", "\t", "\r", "/apps/lattice", "notes/intro", "pub/x/gmi",
    )

    fun randomString(rnd: Random, maxLen: Int = 120): String {
        val parts = rnd.nextInt(0, 6)
        return buildString {
            repeat(parts) { append(WORDS.random(rnd)) }
            // occasional stray printable bytes to stretch the parsers
            repeat(rnd.nextInt(0, 5)) { append(rnd.nextInt(0x20, 0x7F).toChar()) }
        }.take(maxLen)
    }

    /** A multi-line gemtext-ish body. */
    fun randomBody(rnd: Random): String =
        (0 until rnd.nextInt(0, 12)).joinToString("\n") { randomString(rnd, 60) }

    /**
     * Run [body] against [iterations] seeded inputs. On a throw, the seed is
     * surfaced so the failing run can be replayed deterministically. Default seed
     * is a constant (not a clock) so it stays multiplatform and reproducible.
     */
    fun run(iterations: Int = 500, seed: Long = 0xC0FFEEL, body: (Random, Int) -> Unit) {
        val rnd = Random(seed)
        try {
            for (i in 0 until iterations) body(rnd, i)
        } catch (t: Throwable) {
            throw AssertionError("fuzz failed: seed=$seed (rerun with this seed to reproduce)", t)
        }
    }
}
