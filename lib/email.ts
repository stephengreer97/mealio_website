import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

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
  await resend.emails.send({
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
}

export async function sendCreatorApprovedEmail(to: string, displayName: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';
  await resend.emails.send({
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
}

export async function sendCreatorRejectedEmail(to: string, displayName: string) {
  await resend.emails.send({
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
}

export async function sendCreatorApplicationEmail(applicantName: string, applicantEmail: string, adminEmails: string[]) {
  if (adminEmails.length === 0) return;
  await resend.emails.send({
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

  await resend.emails.send({
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
}

export interface SyncedMealLink {
  id: string;
  name: string;
}

/**
 * "We published these under your name" (MEAL-90).
 *
 * Admin sync publishes straight to Discover without waiting for the creator to
 * approve anything — defensible only because a human operator read the
 * extraction first, during an onboarding the creator agreed to. This email is
 * the other half of that bargain: the model is *notify and correct*, not *ask
 * permission*, and it only holds if the creator learns what went live in time to
 * do something about it.
 *
 * Transactional, and therefore NOT routed through sendMarketingEmail():
 * `marketing_opt_out` must not suppress it. A creator who unsubscribed from
 * campaigns still has to be told that nine recipes were published under their
 * name — the unsubscribe page already promises exactly that ("You'll still get
 * important account emails").
 *
 * One message per run, listing only what published. Gate rejections and
 * extraction failures are the operator's problem, not something to explain to a
 * creator who did not ask for the sync.
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

  await resend.emails.send({
    from: 'Mealio <noreply@mealio.co>',
    to,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display: block; border: 0; margin-bottom: 24px;" />
        <h2 style="color: #222; font-size: 20px; margin: 0 0 8px;">Hi ${escapeHtml(displayName)},</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          We imported ${count === 1 ? 'a recipe' : `${count} recipes`} from your own site and published ${count === 1 ? 'it' : 'them'} to your Mealio creator profile.
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
  await resend.emails.send({
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
}
