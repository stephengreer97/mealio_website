# Walmart cart APIs — what exists, and whether Mealio can use them

**Date:** 2026-07-29
**Question:** Can Mealio replace its Walmart WebView automation with an API, the
way it already did for the Kroger family?
**Answer (2026-07-29):** No — not today, and not with any currently-documented Walmart product.
**Corrected 2026-09-09:** the add-to-cart LINK does work for a signed-in shopper,
and lands items in their real cart. See the addendum at the bottom. It is still
not an API: no response to read, no way to learn what happened.
Walmart has no equivalent of Kroger's `cart.basic:write`. The one cart-shaped
thing it offers is a *link* for human clicks, not a cart-write API, and I measured
it being served a bot challenge.

---

## The short version

| Question | Answer |
|---|---|
| Is there an API to add items to a signed-in customer's cart? | **No.** Nothing public or documented. |
| Is there anything cart-shaped? | Yes — the **Add To Cart (ATC) link service**, a URL you send a *user* to. |
| Can we call it server-to-server? | No. It is a browser destination, not an API. |
| Does it work unauthenticated? | The URL needs no API key, but see the measurement below. |
| Is it bot-protected? | **Yes** — I got PerimeterX's "Robot or human?" challenge. |
| Is there a product-search API? | Yes (Affiliate API), but gated on Impact Radius approval. |
| Does any of this remove the WebView? | **No.** |

---

## What Walmart actually offers

Walmart's developer surface splits into three families, and only one is even
adjacent to what we need.

### 1. Marketplace API — wrong direction entirely

For **sellers**: manage items, orders, prices, inventory, promotions. It writes
*listings*, not carts. Access requires being an approved Walmart Seller or
Solution Provider; the Solution Provider path involves an application form, a
functionality demo, and a stated **three-to-five week** review.

Irrelevant to us. Mealio is a buyer-side tool.

### 2. Affiliate API (walmart.io) — useful for *search*, not for carts

Read-only endpoints including **Product Lookup**, **Catalog Product**, and
search/taxonomy. Localized price and availability by ZIP is available. Requests
reference an **Impact Radius Publisher ID**, and Walmart's docs note that
`storeId`-based lookup "requires additional approval from the business team."

This is genuinely interesting for one thing we currently scrape: resolving an
ingredient name to a real Walmart item. It would let us do the *search* half
server-side and skip the extract script's selector fragility. But it does not add
anything to a cart.

### 3. Add To Cart (ATC) service — the only cart-shaped thing, and it's a link

Documented format:

```
https://www.walmart.com/sc/cart/addToCart
  ?items=$ITEM_ID_$QUANTITY
  &offers=$OFFER_ID_$QUANTITY
  &ap=$AP
  &storeId=$STORE_ID
```

Multiple items are comma-separated; the legacy pipe delimiter (`items=$ID|$QTY`)
still works. Affiliate publishers on Impact Radius are told to wrap it:

```
https://goto.walmart.com/m/$PUBLISHER_ID/$AD_ID/$CAMPAIGN_ID
  ?veh=aff&sourceid=$SOURCE_ID&u=$URL_ENCODED_ATC_LINK
```

Note what this is: **a destination you navigate a user to.** There is no JSON
response, no auth header, no idempotency, no way to learn what happened. It is a
conversion funnel for publishers, and it is measured in clicks.

---

## What I measured

Real Walmart grocery item IDs, pulled from our own captured search fixtures
(`tests/fixtures/walmart/search-results-sour-cream.html`), driven through a real
mobile Chromium with our production Android UA.

**`/sc/cart/addToCart?items=18220268394_2`**
- HTTP 200. Page title: `Walmart Native Checkout | Review Order`.
- The SPA **rendered nothing** — empty body after 6s. No cart, no error, no
  redirect. Adding the documented `ap` parameter didn't change it, and the page
  never reaches network-idle, so I could not get it to a settled state.
- Honest conclusion: I **could not get this endpoint to demonstrably work**. It may
  require a genuine affiliate referrer, a session, or parameters the public docs
  don't spell out. I'm not claiming it's broken — I'm saying it did not function in
  the one context we'd care about.

**`/affil/cart/addToCart?items=18220268394_2,16552715343_1`**
- HTTP 307 → **`https://www.walmart.com/blocked?url=...`**
- Title: **`Robot or human?`** — "Activate and hold the button to confirm that
  you're human." PerimeterX captcha element present.

That second result is the load-bearing finding. **The official affiliate
add-to-cart URL sits behind the same bot wall as the storefront** — the same
`/blocked` page and press-and-hold challenge our WebView engine already handles
today. The "API path" is protected by the identical defense as the "scraping path,"
because from Walmart's perspective they are the same request.

Also worth noting: the title on both is *Native Checkout — Review Order*, not
"cart." This looks like a Walmart-hosted checkout session for affiliate
conversions, not a merge into the shopper's existing cart. Whether items land in
the user's real cart is **untested** — it needs a signed-in Walmart account, which
I don't have.

---

## Why Kroger worked and Walmart doesn't

Worth being precise, because "we did it for Kroger" is the natural next question.

Kroger publishes a **real OAuth 2.0 authorization-code API with a cart write
scope**. Our integration requests exactly:

```
scope: 'cart.basic:write product.compact'
```

(`app/api/kroger/connect/route.ts:59`)

That gives us the four things an API integration needs and a link cannot provide:

1. **Delegated authority** — the user consents, we hold a refreshable token.
2. **A server-side write** — `POST /cart/add` from our backend, no browser, no
   WebView, no bot defense in the path.
3. **A response** — we know whether each UPC was accepted.
4. **A stable contract** — versioned, documented, and it doesn't break when Kroger
   restyles a button.

Walmart offers **none** of these for carts. There is no consumer-facing OAuth
scope for cart writes anywhere in their published surface. The ATC link has no
identity model at all — it can't, because it's a URL.

This is a deliberate product difference, not an oversight. Kroger monetizes
partner integrations. Walmart monetizes *traffic*, so its buyer-side surface is
affiliate links with click attribution, and its bot defense exists specifically to
stop programmatic use of that surface.

---

## Feasibility verdict

**Cannot replace the Walmart WebView. Recommend not pursuing it as a cart
strategy.**

| Approach | Verdict | Why |
|---|---|---|
| Marketplace API | Not applicable | Seller-side; writes listings, not carts |
| ATC link, server-side | **Not possible** | It's a browser destination, not an API |
| ATC link, in our WebView | **No better than today** | Measured: PerimeterX `/blocked` challenge |
| ATC link, hand off to system browser | Possible, but a product regression | Leaves the app; user finishes manually; we lose all confirmation |
| Affiliate API for cart | **Does not exist** | Read-only |
| Affiliate API for **search** | **Worth pursuing** | Real value, unrelated to carts |
| Direct partnership | Long shot | Needs volume we don't have yet |

### The one thing actually worth doing

Apply for **Impact Radius / Walmart affiliate approval to use the Affiliate API for
product lookup and search.** Not because it helps the cart — it doesn't — but
because it attacks a different failure. Today the `extract` script scrapes search
results with selectors that break on redesign; an API resolution of
name → itemId is a stable contract and would collapse a large share of our Walmart
selector surface. Signup is free and open to US publishers, so the downside is
paperwork.

The add-to-cart click would still have to happen in the WebView. But a run whose
*search* half is API-backed has far fewer moving parts, and the funnel we just
shipped will show exactly how much that's worth per store.

### What would change this verdict

- Walmart shipping a consumer cart OAuth scope (nothing suggests it's coming).
- Getting far enough into a Walmart partnership to be offered the **Commerce API**,
  which reportedly "enables users to complete customer transactions" but "requires
  additional approval and a sound business case." That's the door worth knocking on
  *if* Mealio's Walmart volume becomes a number worth quoting — which is itself an
  argument for the telemetry funnel.
- An aggregator sitting in front of Walmart. Several exist for programmatic
  purchasing, but they're paid, they insert a third party into checkout, and
  several are themselves scrapers wearing an API costume — which would hand our
  reliability problem to someone else while still owning the blame.

---

## Addendum, 2026-09-09: the ATC link DOES work, in a signed-in session (MEAL-17)

Everything above was measured logged out. That turns out to be the whole story:
run the same URLs inside a signed-in Walmart session and they work, land in the
shopper's own cart, and never see a bot challenge.

**Measured on a Pixel, in the Mealio app's WebView** (which is where the only
signed-in Walmart session lives; Chrome has its own cookie jar and is not signed
in). Two real item ids from `tests/fixtures/walmart/search-results-sour-cream.html`,
different quantities on purpose:

`/sc/cart/addToCart?items=12335111_2,10309448_1`

| | Before | After |
|---|---|---|
| Cart | 73 items, $448.87 | **76 items, $454.29** |

- +$5.42 is exactly 2 x $1.84 (Great Value Original Sour Cream, 16 oz) plus
  1 x $1.74 (Daisy Pure and Natural, 8 oz).
- Each item's product page then showed **"2 added"** and **"1 added"**, so both
  landed as their own lines at the quantities asked for.
- It rendered the shopper's real cart page: same pickup store, same 73 existing
  items, no affiliate interstitial and nothing to click through.

`/affil/cart/addToCart?items=12335111_2,10309448_1` behaved identically: 73 to 76,
$448.87 to $454.29. **No PerimeterX challenge, no Impact onboarding, no `ap`
parameter.** The `/blocked` "Robot or human?" result above is what an
out-of-session request gets, not what the URL does.

**Calling it twice stacks.** A second identical call took the cart 76 to 79
($459.71), so the link ADDS to whatever is already there rather than setting a
quantity. That matches Mealio's existing rule that cart writes add on top.

**Not tested, and each one could still sink it:** more than two items in one
URL, an out-of-stock or store-unavailable item (does it drop it silently, and can
the caller tell?), weight-priced items, a second account, and what happens when
the session has expired. Every measurement here is one account, one store, two
grocery items.

The cart was returned to exactly 73 items / $448.87 afterwards.

---

## Addendum 2, 2026-09-09: what it does at the edges, and under load

Fifty-odd navigations on the Pixel, in the app's WebView, same signed-in account.
Every number below is a cart total read back after the step, because the cart is
the only thing that tells the truth here.

### It only works as a NAVIGATION

Calling the same URLs with `fetch()` from inside the walmart.com origin returns
**200 with an identical 1761-byte SPA shell** for a real id, a bogus id and no id
at all, and adds **nothing**: nine such calls left the cart untouched. The add is
done by the page after it boots, so this cannot be fired quietly in the
background, and anything built on it pays for a full page load per call.

### The `items` parameter, case by case

| Case | Result |
|---|---|
| Valid ids, fresh session | All land, at the quantities asked for |
| Bogus id alone | Nothing added. No error, same page, cart unchanged |
| Valid + bogus together | **The valid one lands, the bogus one is silently dropped** |
| Eight real ids in one URL | All landed on a fresh session (+$13.38); a later run added only +$11.54 |
| `qty 0` | No-op. Does not add, does not remove |
| `qty 99` | **Nothing added at all.** Silently rejected rather than clamped |
| Same id twice in one URL | Both apply (two units) |
| Legacy pipe, `items=ID|1` | Works |
| A UPC instead of an item id | Nothing |
| No `items` at all | Nothing |
| `offers=<offerId>_1`, which the docs list | Nothing added. **Probably my offerId, not the parameter** -- see the correction below |
| `items=...&storeId=2280` | Cart total fell $24.06 and two items went "currently unavailable". **The store id was invented** -- see the correction below |

### Correction, after reading the actual spec

The two odd results above were mine, not Walmart's. `/docs/atc/v1/add-to-cart`
renders for an unauthenticated reader (the service is Public access) and says:

- `offers` takes `offerId` + quantity, exactly the shape I sent. The offerId I
  used came out of a July fixture, so the likely explanation is a stale offer
  rather than an inert parameter. **Re-test with a fresh offerId before
  believing the row above.**
- `storeId` is documented as "the fulfillmentStoreId corresponding to the
  accessPointId obtained from the response of the storeLocator api", with a
  sibling `ap` parameter for the accessPointId. I passed 2280, which I made up.
  A cart that re-points itself to the store you named is what asking for that
  store does, not a booby trap. The caution survives in weaker form: this
  parameter moves the fulfilment context of the WHOLE cart, so it carries the
  user's own store or nothing at all.

Two other things that page settles:

- **The endpoint I have been testing IS the sanctioned one**, in its documented
  form, and "This service is available to partners/publishers whether they are
  onboarded to Impact Radius or not" -- which is why it worked with no
  credentials.
- **Walmart's own documented failure mode is a modal shown to the CUSTOMER**:
  "If any items from request is not added to Walmart cart, an error message
  modal will be shown and customer will be taken to home page of Walmart site
  when user choose to go to cart as the last step." The silence I measured is
  silence toward the CALLER, by design. In this model the customer verifies the
  cart, not the partner.

### The WAF never fired. Something quieter did.

- Six identical adds back to back: no challenge, no `/blocked`, no error, and
  **2 of 6 landed**.
- The same burst again: **0 of 6**.
- The same burst with a unique throwaway parameter on each URL, to rule out the
  WebView serving a cached page: still **0 of 6**.
- After a 90-second pause, adds worked again, but only partly: one of the four
  valid cases in that run landed.

So under sustained use the endpoint starts **silently not applying adds**. Every
response still renders "Walmart Native Checkout | Review Order", every status is
200, and nothing anywhere says an item was dropped. In ~50 navigations we never
once saw the PerimeterX challenge from the original measurement.

For a cart-filling product that is worse than a hard block: a block is a
signal you can act on, and this is a success that is not one. Anything built on
this has to read the cart back afterwards to know what actually happened -- which
is precisely what the network rail already does.

### Is there a search version? No.

- `searchTerm=` and `q=` on the add-to-cart endpoint: no effect.
- `https://www.walmart.com/search?q=sour%20cream` renders normally in-session
  (title "sour cream - Walmart.com", no challenge), but it is a page for a
  person, not a way to add anything.
- Turning "sour cream" into a usItemId still needs a product search. Walmart's
  documented one is the Affiliate API (`affil/product/v2/search`), behind an
  Impact Radius publisher id and approval -- the same gate as the rest of
  walmart.io. Our own GraphQL rail already does this without it.

The cart was deliberately NOT cleaned up after this round (Stephen's call), so it
is carrying the test items.

---

## Sources

- [Add To Cart — walmart.io](https://walmart.io/docs/atc/v1/add-to-cart)
- [GM Add To Cart — walmart.io](https://walmart.io/docs/affiliate/gm-add-to-cart)
- [Walmart APIs index](https://walmart.io/apirefservices)
- [Affiliate API](https://www.walmart.io/docs/affiliate/)
- [Product Lookup](https://walmart.io/docs/affiliates/v1/product-lookup)
- [Introduction to Walmart Marketplace APIs](https://developer.walmart.com/us-marketplace/docs/introduction-to-marketplace-apis)
- [Get started as an approved Solution Provider](https://developer.walmart.com/us-marketplace/docs/get-started-as-a-solution-provider)
- [Walmart Affiliate Program](https://affiliates.walmart.com/)
- [Walmart Shopping API guide (Zinc)](https://www.zinc.com/blog/walmart-api)

Note: `walmart.io` documentation pages are client-rendered and could not be read
directly; their contents above come from search-result extracts. The measurements
in "What I measured" are first-hand and reproducible.
