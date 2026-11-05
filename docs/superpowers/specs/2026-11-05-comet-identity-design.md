# Comet identity: export, import, and a later upgrade to a planet

Status: export and import built (branch feat-comet-identity, desktop/src/cometid.rs). Upgrade to a planet: design only.

## Problem

Anonymous mode runs a comet in the desktop app (desktop/src/engine.rs), kept in `<app_data_dir>/urb/`. Its @p is the author name on every comment and forum post the user makes. A reinstall or a new computer mints a new comet, so the user loses their name and every publisher sees a stranger.

## What a comet needs to resume elsewhere

- **Keyfile** (`comet.key`): the ship, its life (1) and rift (0), and its secret keys. A comet's @p is the fingerprint of its key, so the key is the identity.
- **Store** (`<name>.db`, plus `<name>.db-wal` if present): libmesa's SQLite rows. libmesa does let a comet open on an empty store (`MESA_E_FRESH` is only for ranks other than pawn), but then every flow to a publisher restarts at message 1. A publisher that heard from the comet before acks those numbers as duplicates and drops them, so comments would report success and never arrive. The store carries the flows' sequence numbers forward, so the file includes it.
- **Attestation**: nothing to move. Peers ask the comet itself for its attestation (`+peek-pawn`, served by libmesa from the keyfile's keys), so the imported comet attests exactly as before. Its sponsor (the star it was mined under, and that star's galaxy) is fixed by its name. No re-registration is needed.
- **UDP port** (`.db.port`): not moved. The new computer has a new address anyway and peers learn the new lane from the next packet.

## The file

Binary, big-endian, extension `.latticeid`:

| field | size |
| --- | --- |
| magic `LATCOMET` | 8 |
| version (1) | 1 |
| kdf (1 = PBKDF2-HMAC-SHA256) | 1 |
| iterations (600000) | 4 |
| salt | 16 |
| nonce | 12 |
| ChaCha20-Poly1305 of the payload, header as associated data | rest |

Payload: a 4-byte length, a JSON meta (`ship`, `keyfile`, `db_len`, `wal_len`, `exported`), the store's bytes, then the WAL's.

Crypto comes from ring, already in the tree through rustls, so there is no new crate and cargo deny is unchanged. PBKDF2 is not memory-hard like argon2; the trade was made for zero new dependencies, with OWASP's iteration count, a 16-byte random salt and an 8-character minimum passphrase. Reads refuse iteration counts below 100000 or above 10 million, so a crafted file can neither skip the work nor hang the app. The header is authenticated: a hand-edited version or iteration count fails like a damaged file.

Errors are distinct where they can be: not an identity file (bad magic), a newer format (version above 1: "update lattice"), damaged (bad header, bad sealed contents), and "wrong passphrase, or the file is damaged" (AEAD cannot tell those apart).

## Export

Settings, Connection tab, the anonymous card: "Export this identity", with two passphrase fields and a plain warning that anyone with the file and passphrase can comment and post as you. `export_reader_identity` opens a native save dialog; the page never gets the bytes. The engine is closed (now dropping its store before it answers) so the copy is whole, then restarted if it was running. An exported identity is claimed (connecting a node keeps it) and marked `exported` with a timestamp.

## Import

The same card, on the login page and in settings: "Use an existing anonymous identity", a passphrase field and a native open dialog (`import_reader_identity`). After the file opens, a native confirmation names both @ps, every time, on every page. The old identity's files move into `urb/replaced-<ms>/`, never deleted; the reading history stays. The new store is written first and the keyfile last, so a crash part way mines a new comet rather than open half a store. The keyfile must parse as a comet and match the @p in the file. The engine restarts as the imported comet.

## Two computers, one comet

Unsafe: both would send from the same sequence numbers, and each publisher would drop whichever copy arrives second. Neither libmesa nor the publisher reports this to the comet, so the engine cannot detect it directly. Mitigations:

- the export text and the import confirmation both say to run the identity on one computer at a time and to stop using it on the old one;
- the source computer shows a standing warning after an export ("you exported this identity on <date>; if it now runs elsewhere, stop using it here");
- the import confirmation warns that an old file can make the next messages go missing (a stale store rewinds sequence numbers the same way). Export again just before moving.

A later improvement: a "retire this computer's identity after export" option that sets the old comet aside on the source as soon as the file is written.

## Upgrade to a planet (design only)

Goal: someone who started anonymous and later gets a planet can carry their comet's history and reputation to it, without letting anyone else claim a comet's past.

### The claim

A link record, signed by both identities:

```
[%link comet=@p planet=@p life-comet=@ud life-planet=@ud when=@da]
```

1. The desktop app (holding the comet keyfile) and the user's planet build the same record.
2. The planet signs it with its networking key at its current life (verifiable from Azimuth).
3. The comet signs it with its key (verifiable from the comet's @p alone, since the @p is the key's fingerprint).
4. The doubly signed claim is published by the planet at a well-known scry path, for example `/pub/formerly`, a list of comets it was.

Both signatures are required: the planet signature stops a comet holder from attaching their history to someone else's planet, and the comet signature stops a planet from claiming a comet it does not control.

### Hosts

A publisher or forum host that has comments or posts by the comet:

- learns of the claim when the planet sends it (a poke to the host's inbox with the claim) or when a reader asks;
- verifies both signatures, the planet's against its Azimuth key at `life-planet`, the comet's against its @p;
- records `formerly ~comet` on the planet, and `now ~planet` on the comet, in its own state;
- shows the comet's past comments and posts as "~comet (now ~planet)" and the planet's as "~planet (formerly ~comet)".

A host never rewrites the author of old items: the comet wrote them, and the record says so. The link is a display annotation backed by a verifiable proof.

### Impersonation and abuse

- **Someone else's comet**: impossible without its keyfile; the comet signature fails.
- **Someone else's planet**: impossible without the planet's networking key; the planet signature fails.
- **A stolen comet keyfile**: the thief can link it to their own planet. Mitigation: first link wins at each host, and a comet can be linked only once; a second, different claim for the same comet is shown as disputed, not applied. Users who suspect theft should link early.
- **Planet breach**: a claim names `life-planet`. After the planet breaches, hosts keep the old claim (it was valid when made) but may ask for a re-signature at the new life before showing "formerly" on new items.
- **Revocation**: the planet can publish a signed `%unlink`. Hosts drop the annotation going forward and keep the record.
- **Readers**: a reader shows "formerly" only from a host's verified record or by verifying the claim itself from the planet's `/pub/formerly`, never from a bare assertion in a comment body.

### What the app would need

- An export of a signing capability rather than the whole keyfile: the desktop signs the link record locally, so the comet key never leaves the computer.
- A lattice agent change on hosts to accept, verify and store link claims, and to render them in comments and forum threads.
- Reader support in urb-fetch for `/pub/formerly`.

None of this is built.
