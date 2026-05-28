# Mutation report

_Run: 2026-05-27T21:57:34-04:00_

| Status | File | Line | Operator | Before → After |
|---|---|---|---|---|
| ❌ SURVIVED | `app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/browser/UrlPaths.kt` | 13 | plus1-to-plus0 | `val path = if (slash >= 0) after.substring(slash + 1).trim('/') else ""` → `val path = if (slash >= 0) after.substring(slash + 0).trim('/') else ""` |
| ❌ SURVIVED | `app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/knowledge/KnowledgeClient.kt` | 55 | true-to-false | `private val json = Json { ignoreUnknownKeys = true }` → `private val json = Json { ignoreUnknownKeys = false }` |
| ❌ SURVIVED | `app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/knowledge/KnowledgeClient.kt` | 142 | mark-query-to-tags | `if (!resp.isSuccessful) error("know-query HTTP ${resp.code}")` → `if (!resp.isSuccessful) error("know-tags HTTP ${resp.code}")` |

## Summary

- Killed:   28
- Survived: 3
- Skipped:  2
- Mutation score: 90.3%
