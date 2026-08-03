import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Turns Resend's `{ error }` into a thrown error.
 *
 * resend-node reports an API refusal — a bad key, a suppressed address, a
 * rejected domain, a rate limit — in `{ error }` rather than by throwing, so a
 * send that never happened returns exactly like one that did. Every `await
 * resend.emails.send(...)` whose result is dropped on the floor therefore
 * reports success no matter what the API said.
 *
 * Callers treat "returned without throwing" as "the mail is on its way", and
 * every one of them already has handling that a throw is what reaches:
 *
 *   - `/api/auth/login` and `/api/auth/2fa/resend` log `AUTH:2FA_SENT` success
 *     and tell the browser to ask for a code that was never sent. Throwing turns
 *     that into the 500 their `catch` already returns — an error the person can
 *     act on instead of a prompt they can never satisfy.
 *   - `notifyApproved` counts `emailsSent` and puts a per-creator failure in the
 *     response the review queue displays. Silence there means an operator
 *     believes a creator was told that recipes went live under their name.
 *   - `/api/creator/apply` logs `CREATOR:EMAIL_ADMIN` / `CREATOR:EMAIL_APPLICANT`
 *     from a `.catch` and still returns 201, which is right: the application is
 *     saved either way.
 *   - `/api/bug-report` answers 500, which is also right — the email *is* the
 *     bug report, nothing else stores it, so a refused send means the report is
 *     gone and the reporter has to be told.
 *
 * The one exception is `/api/admin/applications`, which had `.catch(() => {})`.
 * A throw there is not worse than the silence it replaces — the approval or
 * rejection has already been written and must not 500 — but it was still
 * nowhere. That caller now logs, so the throw lands somewhere.
 */
function throwIfRefused(result: { error?: { message?: string } | null } | null | undefined, what: string): void {
  const error = result?.error;
  if (error) {
    throw new Error(`Resend refused the ${what} email: ${error.message ?? JSON.stringify(error)}`);
  }
}

/**
 * Shared shell for marketing / lifecycle emails. Adds the Mealio header and a
 * CAN-SPAM-compliant footer (one-click unsubscribe + physical mailing address).
 * All marketing sends must go through this via lib/marketing-email.ts — the
 * transactional emails below (OTP, creator status, bug report) intentionally
 * do NOT use it.
 */
export function marketingEmailLayout(bodyHtml: string, unsubscribeUrl: string): string {
  const mailingAddress = process.env.MEALIO_MAILING_ADDRESS ?? '';
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
      <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
      ${bodyHtml}
      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
      <p style="color: #999; font-size: 12px; line-height: 1.6; margin: 0;">
        You're receiving this because you have a Mealio account.
        <a href="${unsubscribeUrl}" style="color: #999; text-decoration: underline;">Unsubscribe</a> from marketing emails.
      </p>
      ${mailingAddress ? `<p style="color: #bbb; font-size: 11px; margin: 8px 0 0;">${mailingAddress}</p>` : ''}
    </div>
  `;
}

export async function sendCreatorAppliedEmail(to: string, displayName: string) {
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject: 'We received your creator application',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Thanks for applying, ${displayName}!</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">We've received your creator application and our team will review it shortly. You'll get an email as soon as a decision is made.</p>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">In the meantime, feel free to explore Mealio and save meals to your account.</p>
        <p style="color: #999; font-size: 12px; margin: 0;">Questions? Reply to this email or reach us at contact@mealio.co.</p>
      </div>
    `,
  });
  throwIfRefused(sent, 'creator application received');
}

export async function sendCreatorApprovedEmail(to: string, displayName: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject: "You're approved — start publishing on Mealio!",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">You're in, ${displayName}! 🎉</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">Your creator application has been approved. You can now publish meals to the Mealio Discover feed and earn profit based on how often your meals are saved.</p>

        <h3 style="color: #222; font-size: 16px; margin: 0 0 12px;">How to publish your first meal</h3>
        <ol style="color: #666; font-size: 14px; line-height: 2; margin: 0 0 24px; padding-left: 20px;">
          <li>Go to your <a href="${appUrl}/creator" style="color: #dd0031;">Creator Portal</a></li>
          <li>Click <strong>Publish a Meal</strong></li>
          <li>Add your meal name, ingredients, difficulty, and tags</li>
          <li>Upload a photo — meals with photos get significantly more saves</li>
          <li>Optionally add a recipe and a link to the original source</li>
          <li>Hit <strong>Publish</strong> — your meal goes live on Discover immediately</li>
        </ol>

        <h3 style="color: #222; font-size: 16px; margin: 0 0 12px;">Tips for more saves</h3>
        <ul style="color: #666; font-size: 14px; line-height: 1.9; margin: 0 0 24px; padding-left: 20px;">
          <li><strong>Publish regularly.</strong> This is the single biggest lever. The Discover feed favors fresh meals, and consistent posting keeps you in front of savers — a steady weekly cadence far outperforms a one-time dump.</li>
          <li><strong>Get featured.</strong> Our most consistent creators get featured on Discover, putting their meals in front of even more savers — so keep posting.</li>
          <li><strong>Great photo on every meal.</strong> Bright, top-down shots of real food get saved the most.</li>
          <li><strong>Use specific ingredient names</strong> — "boneless chicken thighs," not "chicken."</li>
          <li><strong>Tag accurately</strong> — savers filter by tags, so good tags get you found.</li>
          <li><strong>Share your profile link.</strong> Put your Mealio creator link in your Instagram/TikTok bio and posts to send your audience straight to your meals.</li>
        </ul>

        <a href="${appUrl}/creator" style="display: inline-block; background: #dd0031; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-bottom: 24px;">Go to Creator Portal</a>

        <p style="color: #999; font-size: 12px; margin: 0;">Questions? Reply to this email or reach us at contact@mealio.co.</p>
      </div>
    `,
  });
  throwIfRefused(sent, 'creator approved');
}

export async function sendCreatorRejectedEmail(to: string, displayName: string) {
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject: 'An update on your Mealio creator application',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Hi ${displayName},</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Thank you for your interest in becoming a Mealio Creator Partner. After reviewing your application, we're not able to move forward at this time.</p>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">We encourage you to keep growing your audience and feel free to re-apply in the future. In the meantime, you can continue saving and discovering meals on Mealio.</p>
        <p style="color: #999; font-size: 12px; margin: 0;">Questions? Reach us at <a href="mailto:contact@mealio.co" style="color: #dd0031;">contact@mealio.co</a>.</p>
      </div>
    `,
  });
  throwIfRefused(sent, 'creator declined');
}

/**
 * Who an operator-facing email goes to.
 *
 * The `is_admin` rows first, with `ADMIN_EMAIL` as the fallback for an
 * environment that has none yet — otherwise the very first thing needing an
 * operator on a fresh deploy notifies nobody, which is the one case where it
 * matters most. Shared by every route that raises something for an operator,
 * because a second copy of this is how one of them ends up without the
 * fallback and silently addresses an empty list.
 *
 * Typed structurally rather than against the Supabase client so this module
 * stays free of a runtime dependency on it; it is the only query in here.
 */
export async function adminNotifyEmails(
  supabase: { from: (table: string) => any },
): Promise<string[]> {
  const { data } = await supabase.from('user_profiles').select('email').eq('is_admin', true);
  const fromDb = ((data ?? []) as Array<{ email: string }>).map((row) => row.email).filter(Boolean);
  if (fromDb.length > 0) return fromDb;
  return process.env.ADMIN_EMAIL ? [process.env.ADMIN_EMAIL] : [];
}

export async function sendCreatorApplicationEmail(applicantName: string, applicantEmail: string, adminEmails: string[]) {
  if (adminEmails.length === 0) return;
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to: adminEmails,
    subject: `New creator application: ${applicantName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">New Creator Application</h2>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">Someone has applied to become a creator.</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
          <tr><td style="padding: 8px 0; color: #999; width: 120px;">Name</td><td style="padding: 8px 0; color: #222; font-weight: 600;">${applicantName}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Email</td><td style="padding: 8px 0; color: #222;">${applicantEmail}</td></tr>
        </table>
        <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin" style="display: inline-block; background: #dd0031; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600;">Review in Admin</a>
      </div>
    `,
  });
  throwIfRefused(sent, 'new creator application');
}

/**
 * A creator has moved the link Mealio was polling, and the import is now off
 * (MEAL-94).
 *
 * The edit itself is allowed. A creator who renames their channel or moves their
 * blog has no other way to tell us, and refusing it made a human the only route
 * for an entirely ordinary change. What the permission opens up is substitution:
 * with `primary_source = 'youtube'` and no OAuth grant the channel is resolved
 * straight off `youtube_url`, so the same edit can point an actively-polled
 * source at a stranger's uploads — and every host guard downstream passes,
 * because the videos really are from the channel the row now names.
 *
 * Clearing `import_opt_in` in the same write is what stops that: nothing is
 * polled until an operator turns it back on. This email is what stops *that*
 * being silent. Somebody else's request has just reversed an operator's
 * decision, so the operator is told which creator, which link, where it moved
 * from and to, and that polling is off — rather than finding out weeks later
 * because a creator's imports stopped arriving.
 *
 * Same shape as `broken_reason` on a grant, and for the same reason: a poller
 * that finds nothing must never be the first sign. It could not reuse that
 * column — `broken_reason` describes an OAuth grant, exists for three platforms
 * only, and a creator polled off their website link has no grant row at all.
 *
 * The prompt, and only the prompt. `creators.import_paused_reason` is the
 * durable half: this mail can be deleted, and the row still answers "why is this
 * creator not being polled?".
 *
 * A blank `newUrl` is a removal rather than a move. Same pause, same alert, and
 * the wording has to say which happened — an operator reading "Now: —" and
 * guessing is the kind of ambiguity this email exists to remove.
 */
export async function sendCreatorSourceMovedEmail(opts: {
  adminEmails: string[];
  creatorName: string;
  handle: string | null;
  sourceLabel: string;
  previousUrl: string;
  /** Empty when the creator removed the link instead of replacing it. */
  newUrl: string;
}) {
  if (opts.adminEmails.length === 0) return;
  const removed = !opts.newUrl;
  // Every value below is a string a creator typed, on its way into an inbox that
  // renders HTML. The application email above predates this helper; anything
  // reaching a URL bar or a link text here goes through it.
  const name = escapeHtml(opts.creatorName);
  const handle = opts.handle ? escapeHtml(opts.handle) : '—';
  const source = escapeHtml(opts.sourceLabel);
  const was = escapeHtml(opts.previousUrl);
  const now = removed ? '— removed' : escapeHtml(opts.newUrl);
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to: opts.adminEmails,
    subject: `Import paused: ${opts.creatorName} ${removed ? 'removed' : 'moved'} their ${opts.sourceLabel} link`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Polled link ${removed ? 'removed' : 'changed'} — import paused</h2>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">
          ${removed
            ? 'This creator removed the link Mealio was importing from, so there is nothing left to poll. Nothing '
              + 'will be polled for them until a link is back and you turn import on again.'
            : 'This creator changed the link Mealio was importing from. Nothing is being polled for them now, and '
              + 'nothing will be until you turn import back on. Check that the new link is still theirs before you do.'}
        </p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
          <tr><td style="padding: 8px 0; color: #999; width: 120px;">Creator</td><td style="padding: 8px 0; color: #222; font-weight: 600;">${name}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Handle</td><td style="padding: 8px 0; color: #222;">${handle}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Source</td><td style="padding: 8px 0; color: #222;">${source}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Was</td><td style="padding: 8px 0; color: #222; word-break: break-all;">${was}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Now</td><td style="padding: 8px 0; color: #222; word-break: break-all;">${now}</td></tr>
          <tr><td style="padding: 8px 0; color: #999;">Import</td><td style="padding: 8px 0; color: #c40029; font-weight: 600;">Paused</td></tr>
        </table>
        <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin" style="display: inline-block; background: #dd0031; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600;">Review in Admin</a>
      </div>
    `,
  });
  throwIfRefused(sent, 'import paused alert');
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * Bug report from the app/web Help section → contact@mealio.co. The redacted
 * session logs (already stripped of secrets + PII client-side) ride along as a
 * .txt attachment so the inbox stays readable.
 */
export async function sendBugReportEmail(opts: {
  description: string;
  context?: Record<string, unknown>;
  logs?: string;
  source: 'app' | 'web';
}) {
  const { description, context = {}, logs, source } = opts;
  const ctxRows = Object.entries(context)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#999;width:120px;">${escapeHtml(k)}</td><td style="padding:6px 0;color:#222;">${escapeHtml(String(v))}</td></tr>`)
    .join('');

  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to: 'contact@mealio.co',
    subject: `Bug report (${source}): ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Bug report (${source})</h2>
        <p style="white-space: pre-wrap; color: #222; font-size: 14px; line-height: 1.5; background:#f7f7f7; border-radius:8px; padding:14px; margin:0 0 20px;">${escapeHtml(description)}</p>
        ${ctxRows ? `<table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px;">${ctxRows}</table>` : ''}
        <p style="color:#999; font-size:12px; margin:0;">${logs ? 'Redacted session logs are attached (session-logs.txt).' : 'No session logs were attached.'}</p>
      </div>
    `,
    attachments: logs
      ? [{ filename: 'session-logs.txt', content: Buffer.from(logs, 'utf8').toString('base64') }]
      : undefined,
  });
  throwIfRefused(sent, 'bug report');
}

export interface SyncedMealLink {
  id: string;
  name: string;
}

/**
 * "We published these under your name" (MEAL-90).
 *
 * An operator approves a synced recipe and it goes live under the creator's name
 * without the creator having approved anything — defensible only because a human
 * read the extraction first, during an onboarding the creator agreed to. This
 * email is the other half of that bargain: the model is *notify and correct*,
 * not *ask permission*, and it only holds if the creator learns what went live
 * in time to do something about it.
 *
 * Transactional, and therefore NOT routed through sendMarketingEmail():
 * `marketing_opt_out` must not suppress it. A creator who unsubscribed from
 * campaigns still has to be told that nine recipes were published under their
 * name — the unsubscribe page already promises exactly that ("You'll still get
 * important account emails").
 *
 * One message per creator per batch of approvals, listing only what published.
 * Gate rejections and extraction failures are the operator's problem, not
 * something to explain to a creator who did not ask for the sync.
 *
 * It does not say "from your own site". Catalog mode is host-checked, but the
 * one-link path deliberately is not — an operator can paste a recipe of theirs
 * that lives on a magazine's site — and the sentence would be false in exactly
 * the case where a creator most needs to look. What is true either way is that
 * these are recipes they published and these are now on their profile.
 */
export async function sendCreatorSyncPublishedEmail(
  to: string,
  displayName: string,
  meals: SyncedMealLink[],
) {
  // Nothing published means nothing to say. The caller checks this too; belt and
  // braces, because an empty "here are your new recipes" is worse than silence.
  if (meals.length === 0) return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';
  const count = meals.length;
  const subject = count === 1
    ? 'A recipe of yours is now live on Mealio'
    : `${count} of your recipes are now live on Mealio`;

  const rows = meals
    .map(
      (meal) => `
        <li style="margin: 0 0 8px;">
          <a href="${appUrl}/meal/p/${encodeURIComponent(meal.id)}" style="color: #dd0031; font-size: 14px;">${escapeHtml(meal.name)}</a>
        </li>`,
    )
    .join('');

  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Hi ${escapeHtml(displayName)},</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          We imported ${count === 1 ? 'a recipe' : `${count} recipes`} you published and put ${count === 1 ? 'it' : 'them'} on your Mealio creator profile.
          <strong>${count === 1 ? 'It is' : 'They are'} live on Discover now</strong> — savers can see ${count === 1 ? 'it' : 'them'} today.
        </p>
        <ul style="margin: 0 0 20px; padding-left: 20px; line-height: 1.7;">${rows}</ul>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          Please have a look. We read ${count === 1 ? 'the recipe' : 'each recipe'} off your page automatically, so an ingredient or a step may not
          be quite how you'd write it. Open your <a href="${appUrl}/creator" style="color: #dd0031;">Creator Portal</a> to edit
          anything, or to unpublish a meal entirely — unpublishing removes it from Discover straight away.
        </p>
        <a href="${appUrl}/creator" style="display: inline-block; background: #dd0031; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-bottom: 24px;">Review in Creator Portal</a>
        <p style="color: #999; font-size: 12px; margin: 0;">
          Not expecting this? Reply to this email or reach us at contact@mealio.co and we'll take ${count === 1 ? 'it' : 'them'} down.
        </p>
      </div>
    `,
  });
  // The one whose absence is silent on both sides: the operator's queue counts
  // `emailsSent` and the creator is never told that recipes went live under
  // their name — which is the whole bargain MEAL-90 rests on.
  throwIfRefused(sent, 'published-under-your-name');
}

/** One queued draft, as the poller's email describes it. */
export interface DraftedRecipe {
  draftId: string;
  name: string;
  /** The post it came from, so a creator can check it against what they wrote. */
  sourceUrl: string;
  photoUrl: string | null;
  ingredientCount: number;
  /** Fields MEAL-72 flagged. The honest signal about how much reading this needs. */
  needALook: number;
}

/**
 * "We read these off your feed — have a look" (MEAL-76).
 *
 * The last mile of the poller. **A decision surface, not a notification**: name,
 * photo, ingredient count and an honest quality signal, so a creator can judge
 * from the inbox whether this is a thirty-second confirm or something to sit
 * down with. "3 fields need your attention" beats "your meal is ready" when
 * three fields are red, and a creator who learns that the hard way stops opening
 * these.
 *
 * **One email per batch.** Three recipes on a Tuesday is one message listing
 * three, never three messages — the single biggest determinant of whether this
 * feels helpful or spammy. Nothing drafted means nothing sent.
 *
 * **Nothing here publishes anything.** Every draft sits until the creator acts,
 * which is the entire basis of their trust in an importer that reads their site
 * unattended, and is not negotiable for a "just this once" convenience.
 *
 * Transactional, and therefore NOT routed through sendMarketingEmail():
 * `marketing_opt_out` must not suppress it. A creator who unsubscribed from
 * campaigns has still asked us to import their recipes, and drafts they are
 * never told about are worse than no drafts at all.
 */
export async function sendCreatorDraftsReadyEmail(
  to: string,
  displayName: string,
  drafts: DraftedRecipe[],
) {
  // Belt and braces with the caller. An empty "here is what we found" is the one
  // version of this email that has no reason to exist.
  if (drafts.length === 0) return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';
  const count = drafts.length;
  const flagged = drafts.reduce((total, draft) => total + draft.needALook, 0);

  // The subject says which of the two emails this is before it is opened: a
  // clean batch is a confirm, a flagged one is a job.
  const subject = flagged > 0
    ? `${count === 1 ? 'A recipe' : `${count} recipes`} from your feed — ${flagged} ${flagged === 1 ? 'field needs' : 'fields need'} a look`
    : `${count === 1 ? 'A recipe' : `${count} recipes`} from your feed, ready to publish`;

  const rows = drafts
    .map((draft) => {
      const attention = draft.needALook > 0
        ? `<span style="color: #dd0031; font-weight: 600;">${draft.needALook} ${draft.needALook === 1 ? 'field needs' : 'fields need'} your attention</span>`
        : '<span style="color: #6a9b5a;">Everything checked out</span>';
      const photo = draft.photoUrl
        ? `<td width="72" style="padding: 0 12px 0 0; vertical-align: top;">
             <img src="${escapeHtml(draft.photoUrl)}" alt="" width="72" height="72" style="display: block; border: 0; border-radius: 8px; object-fit: cover;" />
           </td>`
        : '';
      return `
        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 16px;">
          <tr>
            ${photo}
            <td style="vertical-align: top;">
              <div style="color: #222; font-size: 15px; font-weight: 600; margin-bottom: 4px;">${escapeHtml(draft.name)}</div>
              <div style="color: #999; font-size: 13px; line-height: 1.5;">
                ${draft.ingredientCount} ${draft.ingredientCount === 1 ? 'ingredient' : 'ingredients'} &middot; ${attention}
              </div>
              <a href="${escapeHtml(draft.sourceUrl)}" style="color: #999; font-size: 12px; text-decoration: underline;">the post we read</a>
            </td>
          </tr>
        </table>`;
    })
    .join('');

  const { error } = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Hi ${escapeHtml(displayName)},</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
          We spotted ${count === 1 ? 'a new recipe' : `${count} new recipes`} on your feed and read ${count === 1 ? 'it' : 'them'} into ${count === 1 ? 'a draft' : 'drafts'} for you.
          <strong>Nothing is published</strong> — ${count === 1 ? 'it is' : 'they are'} waiting for you to look.
        </p>
        ${rows}
        <a href="${appUrl}/creator" style="display: inline-block; background: #dd0031; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 8px 0 24px;">Review and publish</a>
        <p style="color: #666; font-size: 13px; line-height: 1.6; margin: 0 0 16px;">
          We read ${count === 1 ? 'this' : 'these'} off your page automatically, so a measure or a step may not be quite how you'd write it.
          Edit anything on the review screen before you publish, or discard ${count === 1 ? 'it' : 'them'} — we won't ask about the same post twice.
        </p>
        <p style="color: #999; font-size: 12px; line-height: 1.6; margin: 0;">
          You're getting this because automatic imports are turned on for your account. To turn them off, open your
          <a href="${appUrl}/creator" style="color: #999; text-decoration: underline;">Creator Portal</a> or just reply to this email and we'll do it.
        </p>
      </div>
    `,
  });

  // resend-node reports an API refusal in `{ error }` rather than by throwing,
  // so a send that never happened returns exactly like one that did. The caller
  // counts what it believes it sent and the drafts are already recorded
  // `imported` — so a swallowed error here is a creator who is never told about
  // recipes that will never be new again (MEAL-76).
  if (error) {
    throw new Error(`Resend refused the drafts-ready email: ${error.message ?? JSON.stringify(error)}`);
  }
}

export async function sendOtpEmail(to: string, code: string) {
  const sent = await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject: 'Your Mealio login code',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 420px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Your login code</h2>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">Enter this code to complete sign-in. It expires in 10 minutes.</p>
        <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 40px; font-weight: 700; letter-spacing: 10px; color: #222;">${code}</span>
        </div>
        <p style="color: #999; font-size: 12px; margin: 0;">If you didn't try to log in to Mealio, you can safely ignore this email.</p>
      </div>
    `,
  });
  throwIfRefused(sent, 'login code');
}
