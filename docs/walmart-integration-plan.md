# Walmart API integration plan

**Goal:** Get Walmart to work like Kroger — the user connects their account once,
picks a store, and then search and add-to-cart happen through APIs instead of
WebView automation.

**Verdict up front:** the Kroger shape is *probably* reachable, but not in one
step, and one link in the chain is genuinely uncertain. Three of the four pieces
(identity, store selection, product search) have documented APIs. The fourth —
writing to the cart — is the one Walmart does not clearly expose, and the plan
below is structured so we find that out early and still ship value if the answer
is no.

This supersedes the "no cart API" conclusion in
`walmart-cart-api-feasibility.md`, which was wrong: it tested an undocumented URL
and missed most of the walmart.io surface.

---

## 1. How Kroger works today, piece by piece

The thing we're trying to reproduce. All of this exists and ships:

| Piece | Implementation |
|---|---|
| Consent | `POST /api/kroger/connect` → OAuth authorize URL, `scope=cart.basic:write product.compact` |
| Callback | `GET /api/kroger/callback` → exchanges code, encrypts refresh token, stores it |
| Session | `user_profiles.kroger_refresh_token` (AES-encrypted), refreshed on demand |
| Store choice | `GET /api/kroger/locations` → `POST /api/kroger/set-location`, saved per banner in `kroger_locations` |
| Search | `krogerSearchProducts()` → `GET /products?filter.term=&filter.locationId=` |
| Cart write | `krogerAddToCart()` → `PUT /cart/add` with `{upc, quantity, modality}` |
| Confirmation | HTTP status from the cart call. Done. |

The whole thing is ~1,080 lines and has no WebView anywhere in it.

## 2. What Walmart offers for each piece

Read directly from walmart.io (the docs are client-rendered; I rendered them in a
browser rather than relying on search snippets this time).

| Kroger piece | Walmart equivalent | Status |
|---|---|---|
| Consumer OAuth | **Walmart Identity Platform** — OAuth 2.0, Authorization Code + PKCE, access + refresh tokens, Basic Profile | Documented. Onboarding required. |
| Store choice | **Store Service Locator** (`affil/storeservice/v1/storeServiceLocator`) — POST a zip, get back `accessPointId` + `fulfillmentStoreId` | Documented. Subscription-based. |
| Product search | **Affiliate Search API** (`affil/product/v2/search`) — text search, facets, category filter, 25/page | `OPEN API` |
| Per-store price/stock | **OPD Pricing & Availability (Realtime / Snapshot / Deltas)** | Subscription-based |
| Ingredients → products | **Recipe & Bundles API** — "shop Walmart products given a list of ingredients" | Subscription-based |
| **Cart write** | **Add To Cart Service** — a URL, not an API | `PUBLIC ACCESS` |
| Order placement | **Checkout API** — Prepare Order / Place Order / Account Linking | Marked `DISABLED` on the services page |

### The one that matters

Walmart has **no documented `cart.basic:write` equivalent**. The only cart-shaped
thing is the ATC service, and it is a *browser destination*:

```
https://www.walmart.com/sc/cart/addToCart?items=938038697_3,751727670_2&storeId=5435&ap=<accessPointId>
```

- `items` — comma-separated `itemId_qty` (qty omittable when 1)
- `offers` — comma-separated `offerId_qty`
- `storeId` — `fulfillmentStoreId` from the Store Locator
- `ap` — `accessPointId` from the Store Locator

Walmart's docs label it **PUBLIC ACCESS** and state it is "available to
partners/publishers whether they are onboarded to Impact Radius or not." No key,
no approval.

Its failure mode is a UI modal, not a status code:

> If any items from request is not added to Walmart cart, an error message modal
> will be shown and customer will be taken to home page of Walmart site

So even in the best case, the cart write happens in a browser holding the user's
Walmart session, and confirmation means reading the page. **The WebView does not
go away.** What changes is how much work happens inside it.

---

## 3. The plan

Five phases. Each one ships something on its own, and the risky, slow, or
approval-gated work starts as early as possible.

### Phase 0 — Answer the one question that reshapes everything (½ day)

**Does the ATC URL merge into the signed-in user's real cart?**

Everything downstream depends on this and nothing can proceed without it. It's a
manual test, on a real device, with a real signed-in Walmart account:

1. Sign into Walmart inside Mealio's existing Walmart WebView.
2. Navigate that same WebView to
   `https://www.walmart.com/sc/cart/addToCart?items=<realGroceryItemId>_2`
3. Then open the normal Walmart cart and look.

**Three possible outcomes, three different plans:**

| Outcome | Meaning | Consequence |
|---|---|---|
| Item is in the user's normal cart | Best case | Phase 3 becomes a single navigation. Huge. |
| Lands in a separate "Native Checkout / Review Order" session | Likely, given the page title I saw | Still usable, but it's a *checkout handoff*, not a cart merge — a product decision, not just an engineering one |
| Nothing happens / error modal | Needs affiliate referrer or params we don't have | Fall back to Phase 5 only |

Use a real grocery item id from our own fixtures, e.g. `18220268394` (in
`tests/fixtures/walmart/search-results-sour-cream.html`).

Also worth capturing while you're there: whether it accepts **multiple** items in
one URL, since that's where the WAF savings come from.

### Phase 1 — Start every approval clock now (in parallel, calendar weeks)

These are slow and independent of code, so they should be in flight during
Phases 2–3. In rough priority order:

1. **Walmart affiliate program signup** → yields an Impact Radius Publisher ID,
   which the Search API wants as a query param. Free, open to US publishers.
2. **Walmart I/O onboarding** → `wm_consumer.id`, `client_id`, `client_secret`.
   Needed for anything under the api-proxy.
3. **Request OPD access** (Store Locator + Pricing & Availability). Subscription-
   based, so expect a conversation about use case.
4. **Ask about Recipe & Bundles.** "Shop Walmart products given a list of
   ingredients" is a literal description of Mealio. Even if it's a long shot,
   the ask costs an email and it's the single best-fit product they publish.
5. **Ask about Walmart Identity + Checkout / Account Linking.** This is the
   Kroger model. Checkout shows `DISABLED` publicly, which usually means
   "contact us," not "never."

Worth raising internally alongside this: joining the affiliate program has a
revenue dimension. Mealio drives real grocery baskets, and affiliate programs pay
on them. Grocery rates are typically low with category exclusions, so this needs
actual numbers rather than optimism — but the paperwork overlaps entirely with
the API access we want anyway.

**Note the dependency risk:** Phases 3–5 are gated on approvals we do not
control. Phase 2 deliberately is not.

### Phase 2 — Server-side product search (1–2 weeks, only needs Phase 1.1–1.2)

The first real win, and it needs no cart access at all.

Today, resolving "sour cream" to a Walmart product means loading a search page in
a WebView and scraping it with selectors that break on redesign. Replace that with
the Search API.

**Build:**
- `lib/walmart.ts` — mirror `lib/kroger.ts`: credentials, signed/OAuth request
  helper, `walmartSearchProducts()`, `scoreProductMatch()` reuse
- `POST /api/walmart/search-products` — mirror the Kroger route
- Return `itemId` alongside name/price/image. **The `itemId` is the currency for
  every later phase** — it's what ATC and any future cart API consume

**Why this is worth doing even if every later phase fails:** it deletes the most
selector-fragile half of the Walmart flow. The `extract` script and its
`card`/`title` selectors stop being load-bearing for finding products. And the
funnel we just shipped will *measure* the improvement per store rather than us
guessing at it.

**Watch for:** the Affiliate Search API indexes *walmart.com online catalogue*.
Grocery is heavily store-local, so results may not match what's actually on the
shelf at the user's store. That's what Phase 3 fixes; until then, treat search
results as candidates, not as availability.

### Phase 3 — Store selection + real availability (1 week, needs Phase 1.3)

Reproduce Kroger's store picker.

**Build:**
- `GET /api/walmart/locations?postalCode=` → Store Service Locator, returns
  `accessPointId` + `fulfillmentStoreId` per store
- `POST /api/walmart/set-location` → persist to `user_profiles.walmart_location`
- Feed `storeId`/`ap` into both search and the ATC URL

**Schema** (mirroring the Kroger columns):

```sql
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS walmart_location      jsonb,   -- {accessPointId, fulfillmentStoreId, name}
  ADD COLUMN IF NOT EXISTS walmart_refresh_token text,    -- encrypted; Phase 5
  ADD COLUMN IF NOT EXISTS walmart_connected_at  timestamptz;
```

Once this lands, pair it with **Pricing & Availability Realtime** so we stop
offering items that aren't in that store — a correctness improvement the WebView
path never gave us.

### Phase 4 — Cart via one navigation (1 week, needs Phase 0 to be favorable)

Assuming Phase 0 says the ATC URL works, this is the big reduction in WAF surface.

**Today:** for N ingredients — N search page loads, N button clicks, N
confirmation reads, each one an opportunity to be blocked.

**After:** one navigation carrying all N items.

**Build:**
- `POST /api/walmart/add-to-cart` — takes ingredients, resolves them to `itemId`s
  via Phase 2, and returns a **built ATC URL** rather than performing the write.
  This is the shape difference from Kroger worth designing around: Kroger's route
  *does* the write server-side; Walmart's route can only *prepare* it, because the
  write needs the user's browser session.
- Client navigates the existing Walmart WebView to that URL.
- Confirmation stays DOM-based: read the resulting cart page. The existing
  `cart-count` / reconcile machinery already does exactly this and should be
  reused unchanged.

**Keep the current automation behind the remote config flag we just shipped**, so
this can be rolled out to a fraction of runs and rolled back with a config push
instead of a release. The telemetry funnel then answers whether it's actually
better, per store, with numbers.

**Risks to plan for:**
- The error modal is the only failure signal. Budget for detecting it, and treat
  "couldn't tell" as a reconcile job rather than a success.
- Very long URLs if a basket is large. Chunk into batches; measure the real cap.
- If Phase 0 says "separate checkout session," this phase becomes a *product*
  question — is handing the user to a Walmart checkout acceptable? — and should
  not be built until that's answered.

### Phase 5 — The actual Kroger model (unbounded, needs Phase 1.5)

Only reachable with Walmart's cooperation, so treat it as a goal rather than a
schedule.

- **Walmart Identity OAuth**: Authorization Code + PKCE. Structurally identical to
  the Kroger connect/callback pair, so `lib/kroger.ts`'s token encryption, state
  token, and refresh logic port over nearly unchanged.
- **Checkout API / Account Linking**: the only documented path to a server-side
  order. Marked `DISABLED`, so this is a conversation, not an integration task.

If this ever lands, Walmart exits the WebView entirely, exactly like Kroger did.
I would not plan around it.

---

## 4. Sequencing

```
Phase 0  ██                                    ½ day, do first, unblocks everything
Phase 1  ████████████████████████████████████  start now, runs in background (weeks)
Phase 2      ████████████                      needs 1.1–1.2 only — the safe win
Phase 3                  ████████              needs 1.3
Phase 4                          ████████      needs Phase 0 favorable
Phase 5                                  ????  needs Walmart to say yes
```

The shape to notice: **Phase 2 is the only phase that depends on nothing risky**,
and it's also the one that fixes the problem we actually have (selector
fragility). If everything else stalls in approvals, Phase 2 still pays for itself.

## 5. What I'd want decided before writing code

1. **Phase 0's result.** Not worth designing Phase 4 in the dark.
2. **Is a Walmart-hosted checkout handoff acceptable** if the cart doesn't merge?
   Product call, not an engineering one.
3. **Affiliate program terms** — becoming a Walmart affiliate has disclosure and
   commission implications that touch more than this codebase.
4. **Whether to generalize the Kroger code or copy it.** `lib/kroger.ts` has a lot
   that's genuinely store-agnostic (token encryption, state tokens, match
   scoring). My inclination is to copy first and extract the shared pieces once
   Walmart is actually working — extracting an abstraction from one example tends
   to produce the wrong abstraction.

## 6. Honest uncertainty

- I have **not** verified the ATC URL works with a logged-in session. My
  unauthenticated test returned 200 with an empty page, which proves nothing.
- Several walmart.io doc pages (Recipes, OPD OAuth, Pricing & Availability
  details) returned empty even in a real browser, so my account of those comes
  from index listings and one-line summaries rather than the specs.
- "Subscription-based" appears on several APIs. I do not know what it costs.
- Access timelines are unknown. Walmart's *Solution Provider* path quotes three to
  five weeks; these are different programs and may differ.
