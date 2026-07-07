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
