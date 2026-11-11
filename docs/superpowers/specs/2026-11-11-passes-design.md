# Passes: paid access to boards, folders and lodgings

Date: 2026-11-11. Branch: task/5j6hcsko. Prompt: lattice wiki `specs/urbit-solver/prompts/06-passes`.

## Goal

A host earns when people stay. A reader buys a pass: the right to read, or read and post in, one board, folder or lodging for a period. The access check asks whether the reader holds a valid pass, and a pass that runs out closes access without the owner doing anything. A ship pays in ecash or over Lightning. A reader with no ship pays the same way or by card.

## Licence

Lattice is under PolyForm Noncommercial 1.0.0, which forbids commercial use, so a host selling passes is outside the licence as it stands. The owner decides how to resolve this (relicense, dual-license or a written exception). The owner chose not to block the work on it, so it is recorded here as open and nothing below depends on the answer.

## Decisions (my calls, marked so the owner can overturn them)

- **Paid boards first.** Private boards, invites, the member roster and the read group already exist, so a pass is a timed invite. Folders come second on the same ledger. Lodgings do not exist yet (sibling prompt 05), so this spec gives them a scope and a hook only.
- **Tessera is not on the read path.** Its checks are asynchronous pokes to the issuer, it has no scry for validity, its windows are global rather than starting at purchase, and it was built with no paid issuance. Lattice keeps its own ledger and check, and uses the same Cashu maths through furum's `lib/cashu.hoon`. Tessera stays optional: see "What tessera provides" below.
- **No new dependency between desks.** Lattice talks to any Cashu mint over HTTP (iris), the same as furum did. On a ship running `%ecash`, that mint is `http://localhost:<port>`. Nothing has to be installed beside lattice.
- **Card payment on the open web is in v1**, as one-off Stripe Checkout Sessions in register's pattern. No Stripe subscriptions: renewal is buying again.
- **Furum's paid-board code is the starting point.** Furum's grubbery port (`~/software/personal/furum`, `code/nex/furum/app.hoon` payments section and `code/lib/cashu.hoon`) already had crash-safe ecash swaps, Lightning invoices through the board's mint, NUT-09 restore after a lost answer, a per-board wallet, withdrawal by melt, and a lapse sweeper. The lattice forum port cut all of it (forum design spec, "paid boards deferred"). This work brings it back, fitted to lattice's groups and roster.

## What exists and where a pass plugs in

| part | today | with passes |
| --- | --- | --- |
| Read gate, ships | grubbery weir: usergroup `/sys/ames/usergroups/forum-<b>.grp`, `who.ships`. A non-member's peek of `/forum/boards/<b>/{pub,content}` returns nothing | `who.ships` = hand invites plus live pass holders, recomputed when a pass starts or lapses |
| Post gate, ships | `+forum-remote-apply`: private board needs `src` in `/forum/members/<b>` (app.hoon, the roster check) | member = in the roster, or holding a live `%post` pass. The pass check reads `until` directly, so it is exact even before the lapse sweep runs |
| Read gate, web | `serve-forum-public` 404s a private board | a private board with an offer serves its buy page, or the board to a request whose pass cookie hashes to a live web pass |
| Folders | per-ship groups `<ship>.grp` and folder `share-grants` | phase 4: a pass adds the folder road to a pass group `pass-<key>.grp` |
| Inbox | `+notify-add`, kinds `?(%comment ... %asked)` | new kinds `%sale` and `%lapse` for the seller |
| Notes to a remote ship | `+forum-note-send` to the peer's `/forum.sig` | the buyer's answers (`%invoice`, `%paid`, `%failed`) and a `%lapsed` notice |
| Timers | `soft-behn` writer timers, sweep loops | a `/pass-sweep.sig` loop sleeping until the earliest `until` |

## Data

All pass state lives at the nexus root under `/passes`, outside `/page` (so outside the page tree), outside `/pub` (so peers cannot read it), and out of `+wants` in `lattice-keys.hoon` (so no agent key reaches it). Every grub is bounded by buyers, never by the corpus.

```
+$  scope   $%([%board name=@tas] [%folder pax=path] [%lodging who=@p])
+$  mode    ?(%read %post)
+$  holder  $%([%ship who=@p] [%web key=@uv])     ::  key: sha-256 of the bearer code
+$  unit    ?(%sat %usd)                          ::  %usd in cents
+$  offer
  $:  price=@ud  =unit  period=@dr  =mode
      mint=(unit @t)                              ::  ecash and Lightning; ~ takes none
      card=?                                      ::  card on the open web
      open=?                                      ::  on sale; closed keeps existing passes
  ==
+$  pass
  $:  =holder  =mode  until=@da  since=@da
      paid=@ud  =unit  via=?(%ecash %lightning %card %gift)  ref=@t
  ==
+$  sale    [at=@da =holder paid=@ud =unit via=?(%ecash %lightning %card %gift)]
```

| grub | type | bound |
| --- | --- | --- |
| `/passes/offers/<scope-key>` | `[%1 offer]` | one per scope |
| `/passes/held/<scope-key>` | `[%1 (map holder pass)]` | buyers of that scope; a pass lapsed over 90 days is dropped by the sweep |
| `/passes/sales/<scope-key>` | `[%1 (list sale)]`, newest first | the last 1.000 |
| `/passes/next` | `[%1 (unit @da)]` | the earliest live `until`, for the sweeper |
| `/passes/wallet/<scope-key>` | `[%1 (map mint (list cashu-proof))]` | the seller's takings, ecash |
| `/passes/pay/<id>` | `[%1 pay]` and its fiber | at most 3 per payer and 50 in all |
| `/passes/secrets` | `[%1 stripe-key=@t]` | one |

`<scope-key>` is `b-<board>` for a board, the folder's `@uv` hash for a folder (so a deep path is not a deep grub tree), and `l-<ship>` for a lodging.

Secrets: the wallet proofs and the Stripe key are payment secrets. They sit only in `/passes/wallet/*` and `/passes/secrets`. Neither is in the page tree, under `/pub`, in a route an agent key may call, in a backup export (the export skips `/passes/secrets` and masks it, as register masks `*_key`), or echoed by any read route: the settings route returns `****` for a stored key and keeps the stored value when `****` comes back. A bearer code is stored only as its sha-256.

## The access check

One pure arm in `lib/lattice-pass.hoon`, run on every post and every web read of a paid scope:

```
++  live
  |=  [held=(map holder pass) h=holder now=@da want=mode]
  ^-  ?
  =/  p  (~(get by held) h)
  ?~  p  |
  ?&  (gth until.u.p now)
      |(=(want %read) =(mode.u.p %post))
  ==
```

That is one grub peek (`/passes/held/<key>`) and one map lookup. A ship's read over Ames costs nothing extra: grubbery's weir already decides it from `who.ships`, which the pass code keeps equal to `hand ∪ {ships with a live pass}`:

```
++  group-ships
  |=  [hand=(set @p) held=(map holder pass) now=@da]
  ^-  (set @p)
```

The owner and mods always pass. A banned ship never does: `+is-banned:ls` runs before the check and the ban culls its group membership as today.

### Lapse without the owner

- Posting and web reads check `until` against `now` themselves, so a lapse closes them at the second it happens.
- Ship reads close when the ship leaves `who.ships`. The sweeper fiber `/pass-sweep.sig` reads `/passes/next`, sets a behn timer for it, and on the wake asks the writer to sweep: for each scope with a lapse it recomputes `group-ships`, writes the group with `ug-over`, files a `%lapse` inbox item, sends the holder a `%lapsed` note, and rewrites `/passes/next`. Furum's sweeper is the model (a writer that will not take the ask is asked again in a minute). A behn timer fires on time, so the gap is one event.
- A hand invite outlives its pass: `hand` comes from the roster `/forum/members/<b>`, which passes never write.

## Buying on Urbit (a ship)

The buyer uses their own lattice. A board page that a ship cannot read but that has an offer (the host advertises offers at `/pub/passes/<scope-key>`, world-readable and holding only the public offer: price, unit, period, mode, mint, whether card is taken) shows "Buy a pass: 1.000 sats for 30 days".

```
buyer UI ──POST /pass-buy──▶ buyer lattice ──poke /forum.sig [%pass-buy key nonce how]──▶ host
                                                                   │ how = [%ecash token] | [%lightning ~]
host: /passes/pay/<id> fiber ──iris──▶ mint  (/v1/swap, or /v1/mint/quote/bolt11 then /v1/mint/bolt11)
host ──note [%pass key nonce %invoice bolt11 expiry]──▶ buyer   (Lightning only; the buyer pays it from any wallet)
host ──note [%pass key nonce %paid until] | [%failed why]──▶ buyer
```

1. **Ecash.** The buyer pastes a `cashuA`/`cashuB` token from any wallet. The host refuses a token from a mint other than the offer's (`+mint-accepted`), a short one (net of the input fee below the price), and a fourth payment under way from one payer. It writes the step before each mint call, swaps the proofs for its own blinded outputs, unblinds the signatures (checking DLEQ), and keeps the new proofs in the wallet. A lost answer is recovered by NUT-09 restore on the same outputs. The swap succeeding is the payment.
2. **Lightning.** The host asks the offer's mint for a bolt11 quote, sends the invoice to the buyer, and polls the quote every 5 seconds for 5 minutes, then every minute until it is paid or expires. Paid, it mints its outputs and keeps the proofs. The host never runs a Lightning node: the mint does.
3. **Settle** (the writer, once per payment id): wallet first, then the pass. A renewal extends from `max(now, until)`, so paying early loses nothing. The pass goes in `/passes/held`, the sale in `/passes/sales`, the ship into `who.ships`, a `%sale` item into the inbox, and `%paid until` back to the buyer.

Authorship of every buy poke comes from the Ames transport, as for forum posts. A comet may buy (it is a ship) but its pass is `%read` only, the same rule as comets on boards.

## Buying on the open web (no ship)

A private board with an offer serves a public buy page at `/apps/lattice/forum/<b>` instead of a 404. It offers what the offer takes:

- **Ecash or Lightning**: the same pay fiber, started by an anonymous `POST /apps/lattice/pass/buy?key=` carrying the token, or asking for an invoice. The page polls `GET /apps/lattice/pass/state?id=&t=`, where `t` is a 128-bit token returned with the id (register's pattern), until it is paid.
- **Card**: `POST /apps/lattice/pass/card?key=` creates a Stripe Checkout Session (`mode=payment`, inline `price_data`, `client_reference_id` the pay id, `metadata[pay]` the pay id, `expires_at` now plus an hour) and returns its URL. The success URL is `/apps/lattice/pass/return?id=&t=&sid={CHECKOUT_SESSION_ID}`. The return page and the webhook `POST /apps/lattice/hooks/stripe` both settle by fetching the session from Stripe and reading only `id`, `payment_status == paid`, `amount_total` and `metadata.pay`, so neither the query string nor the webhook body is trusted and the webhook needs no signing secret. The pay grub's step makes settling happen once, whichever arrives first. Stripe's `livemode` is shown in the seller's settings so a test key is never mistaken for a live one.

On settle the host mints a bearer code (128 random bits, shown once as `lp-` plus base32), stores `[%web (sham code)]` as the holder, and sets the cookie `lattice-pass-<scope-key>=<code>` (HttpOnly, Secure, SameSite=Lax, Path=/apps/lattice/, Max-Age the pass's remaining time). The page tells the reader to keep the code to read on another device; `POST /apps/lattice/pass/use` with a code sets the cookie there. A web pass is `%read`: posting needs a ship, and a reader who gets one can buy again as that ship.

Anonymous routes are capped: 50 pay grubs pending in all, a token at most 64 KB, and a per-address rate limit as forum posting uses.

## Privacy

| path | what the seller learns |
| --- | --- |
| a ship, ecash or Lightning | the ship (it reads over Ames as itself, so this cannot be hidden), never the wallet or the funding source. The mint cannot link the swap to the minting of the buyer's tokens |
| the web, ecash or Lightning | nothing: the holder is the hash of a bearer code. The seller sees "web reader 3f2a" |
| the web, card | whatever Stripe gives the seller's Stripe account (the card holder's name and email). Lattice stores only the session id |

Blind tokens would let a ship buy without the seller learning which ship bought, but the ship then reads as itself, so it would gain nothing. The web code already does what an anonymous blind token would. This is why tessera is not needed in v1.

## Lifecycle

- **Expiry**: at `until`. Posting and web reads close at once, and ship reads close at the sweeper's wake.
- **Reminder**: three days before a ship's pass lapses, the sweeper sends `%ending until` to the holder. Their lattice shows it in the inbox with a Renew button.
- **Renewal**: buying again extends from `max(now, until)`. There is no automatic renewal: ecash cannot be pulled, and Stripe subscriptions are left out.
- **Refund**: the seller presses Refund on a pass. The pass ends now and a refund line is added to the sales log with the amount negative. Money goes back by hand: for ecash or Lightning the seller withdraws from the wallet and sends it, and for card they refund in the Stripe dashboard. This is register's model. Lattice never calls the refund API.
- **Gift**: the seller grants a pass with no payment (`via %gift`, paid 0), for comps and testing.
- **What a lapsed reader sees**: a ship's lattice keeps the `%lapsed` note and shows the board's page as "Your pass to Board ended on 12 Nov. Renew: 1.000 sats for 30 days" instead of "unreachable or denied". A web reader whose cookie names a lapsed pass gets the buy page with "Your pass ended on 12 Nov".
- **Offer changes**: a new price or period applies to the next purchase. Closing an offer keeps every pass until it lapses. Deleting a board ends its passes and keeps its sales log and wallet.

## The seller's view

`GET /passes?key=` (owner cookie only), shown as a Passes tab in the board's settings:

- **Active**: count, and a list of holder, mode, until and via, soonest lapse first.
- **Income**: for this calendar month, and for the last 30 days, by unit (sats and USD separately, never converted), net of refunds.
- **Lapses**: passes that lapsed in the period and were not renewed, which is churn.
- **Wallet**: the ecash balance by mint, with Withdraw (melt to a Lightning invoice the seller pastes, furum's `%melt` step) and Export (a `cashuB` token shown once, removed from the wallet only when the seller confirms they copied it).
- **Offer**: edit price, unit, period, mode, mint, card, open.
- **Settings, Payments**: the Stripe secret key (masked), with a check that reports test or live.

## Cost

- Every check is one grub peek and one map lookup. No check walks ancestors or enumerates a directory.
- `/passes/held/<key>` grows with that scope's buyers and loses passes 90 days after they lapse.
- A sweep touches only scopes with a lapse due; `/passes/next` keeps it from scanning the rest.
- Pay fibers are capped at 50, and each makes at most one mint call at a time.
- `/passes` is about 5 grubs per scope with an offer, plus the pay grubs.

## What tessera provides against what must be built

| need | tessera | built here |
| --- | --- | --- |
| Blind signatures, hash-to-curve, DLEQ | `lib/blind`, `lib/bdhke`, `lib/curve` | reuse furum's `lib/cashu.hoon`, which carries the same maths and the swap, mint, melt and restore requests |
| A pass that starts at purchase and lasts a period | global calendar windows only | the ledger and `+live` |
| A synchronous validity check | none (poke and wait; no scry) | `+live` over one grub |
| Taking payment | none, by design | the pay fiber, ecash and Lightning through any mint, card through Stripe |
| Prices, products, periods | none | `offer` |
| Renewal, refund | none | settle extends, refund ends |
| Anonymous holders | NUT-22 auth tokens over HTTP | web bearer codes, stored hashed |
| Seller view | admin counters | the Passes tab |

A later version could issue a web pass as a tessera NUT-22 token, so a reader keeps it in a Cashu wallet rather than a cookie. That needs a tessera poke to issue to a holder and a validity scry, neither of which exists today.

## Folders and lodgings (after boards)

- **Folders**: a pass on a folder adds the folder's dir road to a group `pass-<scope-key>.grp` whose `who.ships` is kept as for boards. A web pass reads the folder's pages through `/c/<page>` when the cookie is live, as a clearweb read scoped to that folder. Everything else (ledger, payment, lifecycle, seller view) is shared.
- **Lodgings**: when lodgers exist, a lodging's quota and sign-in can require a live pass on scope `[%lodging who]`. The ledger and payment are the same. The hook is one `+live` call at sign-in and at the start of each write.

## Phases

1. `lib/lattice-pass.hoon` (types, `+live`, `+group-ships`, `+extend`, `+next-lapse`, `+lapsed`, `+summary`, `+web-key`, `+cookie-code`) and `lib/lattice-cashu.hoon` (furum's `cashu.hoon`), with suites in `tests/lib/`.
2. Paid boards for ships: offers, the ledger, the post gate, group upkeep, the sweeper, ecash and Lightning purchase, the seller routes, inbox kinds, notes to the buyer.
3. The open web: the buy page, web ecash and Lightning, Stripe, bearer codes and the cookie.
4. Folders.
5. Lodgings, once they exist.

## Testing

- Hoon suites for both libs, run offline (`scripts/offline-tests.sh`) and on the ship.
- An integration matrix `scripts/pass-matrix.sh` on the `lattice-dev` fleet, using `%ecash` on a second fake ship as the mint (its `self` quote method pays Lightning quotes without a node): a ship buys with ecash, buys with Lightning, renews, posts, lapses (a pass of one minute), loses read and post, and the seller's numbers match. Card runs against Stripe test mode only, and only with a test key the owner puts in.

## Not in scope

A marketplace or directory of paid content, revenue sharing between ships, tokens other than ecash, Stripe subscriptions, and automatic refunds.
