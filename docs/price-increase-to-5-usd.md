# How-To: Raise Full Access to $5/month everywhere

Status: PLAN ONLY. Nothing has been changed. Two decisions are needed from
Stephen before execution (marked DECISION below). Everything else is
mechanical and Claude can execute it, except the store-dashboard steps that
require account owner access (marked YOU).

Current state (verified in code 2026-06-12): $3.49/mo and $29.99/yr via
Stripe on web; RevenueCat (`full_access` entitlement) wired in the mobile
app with products living in App Store Connect / Google Play; help docs
hardcode the old amounts.

---

## Decisions needed first

**DECISION 1 — Annual price.** "$5/mo" leaves the yearly plan open. Options:
- $49.99/yr: keeps roughly the current ~17% annual discount. Recommended.
- $39.99/yr: deepens the annual discount to ~33%, pushes users to annual
  (better retention, worse near-term revenue).
- Kill the annual plan (not recommended; it exists on every surface already).

**DECISION 2 — Existing subscribers.** Recommended: **grandfather everyone.**
- Stripe: this is the default. Prices are immutable; existing subscriptions
  keep billing at $3.49/$29.99 forever unless actively migrated. Migrating
  requires a subscription update per customer plus advance notice emails,
  and (in several US states) explicit consent. Not worth it at current
  subscriber counts.
- Apple: raising the price of an existing subscription product triggers
  Apple's mandatory price-increase consent flow (emails, sheets in the App
  Store, auto-cancel for users who don't respond). Avoid it entirely by
  creating NEW products at $5 (see below) and leaving the old products
  untouched for existing subscribers. Same logic on Google Play.

---

## Execution order

Order matters: stores first (their review cycles are the long pole), web
last (instant). Nothing user-visible changes until step 4, so steps 1 to 3
can be done any time.

### 1. App Store Connect (YOU — needs account holder)
1. Create two new in-app subscription products in the existing subscription
   group: e.g. `full_access_monthly_5` at $4.99/mo and `full_access_annual_50`
   at the DECISION 1 price. (Apple price tiers: $4.99 is the tier; "$5" is
   not an available tier.)
2. Do NOT touch the existing products. Old subscribers keep renewing at the
   old price with zero consent friction.
3. Submit the new products with the next app build for review.

### 2. Google Play Console (YOU — when Android ships)
Same pattern: new subscription products at the new price, old ones left
alone. Skippable today since the Android app has not shipped.

### 3. RevenueCat dashboard (YOU or Claude with dashboard access)
1. Attach the new store products to the `full_access` entitlement.
2. Update the current Offering's packages to point at the NEW products.
   The mobile paywall reads prices dynamically from the offering, so no app
   code change and no app release is needed for the price itself (the
   products just need to have passed App Store review).

### 4. Stripe (Claude can execute via dashboard access or API key)
1. In the existing Full Access Product, create two new Prices: $5.00/mo and
   the DECISION 1 annual amount. Stripe prices are immutable, hence new ones.
2. Existing subscriptions are untouched (grandfathered automatically).
3. The checkout route takes the price ID from env, so no code change.

### 5. Vercel env vars (Claude, after step 4)
Update and redeploy:
- `NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID` → new $5 price ID
- `NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID` → new annual price ID
- `NEXT_PUBLIC_LS_MONTHLY_PRICE` → `5.00`
- `NEXT_PUBLIC_LS_ANNUAL_PRICE` → new annual amount
In-flight checkout sessions are safe: a Stripe Checkout session pins its
price at creation, so anyone mid-checkout at the old price completes at the
old price and is then grandfathered like other existing subscribers.

### 6. Copy updates (Claude — one PR)
- `app/help/page.tsx`: three hardcoded spots ($3.49/mo, $29.99/yr, and the
  "works out to about $2.50/month" math) → new amounts.
- `app/pricing/page.tsx`: hardcoded fallback defaults `3.49` / `29.99` →
  new amounts (display already prefers the env vars).
- Sweep both extensions + mobile app + email templates for price strings
  (initial grep found none in mealio_app outside the store-script noise,
  but re-verify in the PR).
- Webhook/tier mapping needs nothing: it keys off subscription status and
  product, not amount.

### 7. Verify (Claude)
- Stripe test-mode checkout completes at $5.00 and the webhook flips
  `user_profiles.tier`.
- Mobile paywall shows $4.99 from the new offering (TestFlight build).
- Help and pricing pages render the new amounts (API tests + screenshot).

## Rollback
Web: revert the four Vercel env vars to the old price IDs/amounts and
redeploy (minutes; the old Stripe prices still exist because prices are
never deleted). Mobile: repoint the RevenueCat offering back to the old
products (no app release needed). Anyone who subscribed at $5 in the window
keeps that price unless you choose to credit them.

## Revenue note
Creator payouts are described in the help docs as a share of subscription
profit, so the payout copy needs no change; the quarterly pool simply grows.
