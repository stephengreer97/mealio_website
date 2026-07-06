# Mealio Email System — Plan

End-to-end plan for lifecycle + marketing email. All work is in `mealio_central`.
Transactional email (OTP, creator app status, bug report) stays as-is in
`lib/email.ts` and is out of scope here.

## Emails in scope

| # | Email | Class | Trigger | Build |
|---|---|---|---|---|
| A | Creator onboarding (welcome + tips) | Lifecycle | On creator approval | **Extend existing** `sendCreatorApprovedEmail` — expand its tips list. No new send. |
| B | Creator publish-reminder | Marketing | Daily cron — publishing inactivity | New |
| C | User upsell → Full Access | Marketing | Daily cron — days after signup, still free | New |
| D | Creator invite (cold outreach) | Marketing | **Manual send** | **No build** — sourcing list only |

## A — Creator onboarding
`sendCreatorApprovedEmail` already exists and already has a "Tips for more saves"
section. Just expand it. Must-have tip: **publish regularly** (biggest lever on
saves/earnings). Full tip list is drafted; [S] approves copy.

## B — Creator publish-reminder (marketing)
Runs in the daily cron. Schedule:
- **Never-published nudge:** day 7 after approval if 0 meals published.
- **Re-engage:** 14 days after the last published meal.
- **Follow-ups:** every 21 idle days, capped at 3, then quarterly "we miss you".

Gets full marketing treatment: unsubscribe, suppression, `email_sends` logging.

## C — User upsell drip (time-based, NOT inactivity)
3-touch sequence keyed off signup date, only while `subscription_tier = 'free'`,
**stops the moment they upgrade**:

| Send | Day after signup | Angle |
|---|---|---|
| 1 | **4** | Value recap — unlimited saves vs. the 3-meal cap. Soft CTA. |
| 2 | **12** | Benefit + variety — top paid feature + creator/meal breadth. |
| 3 | **28** | Last call / incentive — urgency or first-month discount → `/pricing`. |

Rationale: day 4 = value realized without fatigue; day 12 = mid-consideration;
day 28 = closes the ~4-week decision window. Optional later add: an
event-triggered upsell when a free user hits the 3-saved-meal limit (intent, not
inactivity).

## D — Creator invite (manual)
No code. [S] sends manually to a sourced list. Target: recipe/home-cooking
creators (weeknight dinners, meal-prep, grocery hauls, budget/family cooking),
**micro (10k–100k) and mid (100k–500k)** tiers — highest engagement + response.
Emails come from IG business "Email" button, bio "business inquiries", linktree,
blog contact page, or YouTube About. [C] compiles candidate handles.

---

## Shared foundation — M0 (this PR)
- **DB** (`supabase/add-email-marketing.sql`): `user_profiles.marketing_opt_out`
  + `unsubscribe_token`; `email_sends` log (dedup_key, resend_message_id,
  status, opened_at/clicked_at).
- **`sendMarketingEmail()`** (`lib/marketing-email.ts`): physical-address gate,
  suppression (opt-out / bounce / complaint), idempotency (dedup_key),
  unsubscribe footer + `List-Unsubscribe` headers, logs to `email_sends`.
- **Shared layout** (`marketingEmailLayout` in `lib/email.ts`): Mealio shell +
  CAN-SPAM footer.
- **Unsubscribe** (`GET/POST /api/email/unsubscribe`): token → opt-out;
  one-click (RFC 8058) + branded confirmation page.
- **Resend webhook** (`POST /api/webhooks/resend`): Svix-verified; updates
  `email_sends` on delivered/opened/clicked; bounce/complaint → auto opt-out.
- **Daily cron scaffold** (`GET /api/cron/daily`, `vercel.json`): `CRON_SECRET`
  guarded; one job to stay within Vercel Hobby limits.

### Env vars this introduces
- `RESEND_WEBHOOK_SECRET` — Svix signing secret from the Resend webhook config.
- `CRON_SECRET` — protects the cron route (Vercel sends it as a Bearer token).
- `MEALIO_MAILING_ADDRESS` — **required before any marketing send** (CAN-SPAM).
  `sendMarketingEmail` refuses to send until it's set. Use a **PO Box or virtual
  mailbox (CMRA)** — never the home address.

## Build order
- **M0** — foundation (this PR). Nothing sends yet.
- **M1** — A: expand the creator onboarding tips.
- **M2** — B + C: fill in the two passes in `/api/cron/daily` via
  `sendMarketingEmail`.
- **M3** — Admin dashboard: `email_sends` aggregates (sent/delivered/open/click/
  unsubscribe per campaign) + a per-recipient debug view.

## Deliverability & compliance
- Resend domain auth (SPF/DKIM/DMARC) for `mealio.co`; consider a marketing
  subdomain so reputation issues can't hurt transactional/OTP deliverability.
- Every marketing email carries a working unsubscribe + physical address.

## Cron tier
Stay on **Vercel Hobby**: one consolidated daily job. Loose daily window is fine
for lifecycle email. Move to Pro only if we later need more frequent/precise
sends (folds into the separate "Upgrade Vercel?" decision).

## Owner split
- **[C]** builds M0–M3, drafts copy/tips, compiles creator-invite candidates.
- **[S]** approves copy, sets cadence thresholds if changing defaults, provides
  `MEALIO_MAILING_ADDRESS`, sends invites (D).
