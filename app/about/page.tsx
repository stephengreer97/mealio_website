import type { Metadata } from 'next';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';
import { PITCH_STORES } from '@/lib/pitch';

/**
 * What Mealio is, for someone who has never seen it.
 *
 * Written because Google's OAuth verification failed on "your home page does
 * not explain the purpose of your app", and it was right: `/` redirects to
 * `/discover`, and `/discover` renders client-side, so a reviewer — or any
 * crawler — loaded the site and saw no text at all.
 *
 * So this is server-rendered on purpose. Everything a first-time visitor needs
 * is in the HTML that arrives, not assembled afterwards by JavaScript.
 *
 * It also names the YouTube integration explicitly. A reviewer assessing the
 * `youtube.readonly` and `youtube.force-ssl` scopes is asking whether the app's
 * stated purpose justifies them; a homepage that never mentions reading a
 * creator's videos makes that question harder to answer than it needs to be.
 */

export const metadata: Metadata = {
  title: 'About Mealio — save meals, fill your grocery cart',
  description:
    'Mealio saves the meals you want to cook and adds every ingredient to your online grocery cart in one step. '
    + 'Creators can connect their YouTube channel so their recipes arrive automatically.',
};

const section: React.CSSProperties = { marginTop: '40px' };
const h2: React.CSSProperties = { fontSize: '20px', fontWeight: 700, color: '#111', margin: '0 0 12px' };
const p: React.CSSProperties = { margin: '0 0 14px', maxWidth: '68ch' };
const link: React.CSSProperties = { color: '#dd0031' };

export default function AboutPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <AppHeader />

      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 24px', lineHeight: 1.75, color: '#333', fontSize: '15px' }}>
        <h1 style={{ margin: '0 0 12px', fontSize: '30px', fontWeight: 700, color: '#111', lineHeight: 1.25 }}>
          Shop meals. We&rsquo;ll fill the cart.
        </h1>
        <p style={{ ...p, fontSize: '17px', color: '#555' }}>
          Mealio is a recipe app that does the shopping part. Save a meal you want to cook, pick your grocery
          store, and Mealio adds every ingredient to your online cart — so deciding what to eat and buying
          what it needs stop being two separate chores.
        </p>

        <div style={section}>
          <h2 style={h2}>What you can do with it</h2>
          <ul style={{ paddingLeft: '22px', margin: 0, maxWidth: '68ch' }}>
            <li style={{ marginBottom: '8px' }}>
              <strong>Browse meals</strong> published by cooks and creators, or save your own.
            </li>
            <li style={{ marginBottom: '8px' }}>
              <strong>Send the ingredients to your grocery cart</strong> in one step. Mealio supports{' '}
              {PITCH_STORES}.
            </li>
            <li style={{ marginBottom: '8px' }}>
              <strong>Adjust before you buy.</strong> Nothing is ordered — the items land in your own cart at
              your own store, and you check out there.
            </li>
            <li>
              <strong>Share a meal</strong> with anyone, whether or not they use Mealio.
            </li>
          </ul>
        </div>

        <div style={section}>
          <h2 style={h2}>For recipe creators</h2>
          <p style={p}>
            Creators publish recipes to Mealio so their audience can cook them without copying an ingredient
            list into a shopping app by hand.
          </p>
          <p style={p}>
            A creator can also <strong>connect the place they already publish</strong> — a website, or their
            YouTube channel. With their permission, Mealio reads new posts from that one source, pulls the
            ingredients and steps out of them, and puts the result in front of the creator to approve, edit or
            decline. Nothing is published under anyone&rsquo;s name without them saying so.
          </p>
          <p style={p}>
            Creators who connect a YouTube channel can optionally have Mealio add a link to their recipe at the
            end of that video&rsquo;s description. That setting is off unless the creator turns it on, and it
            only ever touches videos on their own channel.
          </p>
          <p style={p}>
            <Link href="/creator/apply" style={link}>Apply to be a creator</Link>
          </p>
        </div>

        <div style={section}>
          <h2 style={h2}>What we ask for, and why</h2>
          <p style={p}>
            Mealio asks for the least it needs to do each job, and nothing is requested until you take the
            action that needs it.
          </p>
          <ul style={{ paddingLeft: '22px', margin: '0 0 14px', maxWidth: '68ch' }}>
            <li style={{ marginBottom: '10px' }}>
              <strong>Your email address</strong> &mdash; so that you can sign in, recover your account, and be
              told about your own recipes. It is not sold or shared for advertising.
            </li>
            <li style={{ marginBottom: '10px' }}>
              <strong>Access to your grocery store, granted by you at the store</strong> &mdash; so that Mealio
              can search that store&rsquo;s products and add the ingredients to your cart. Mealio never
              receives your store password, never places an order, and does not read pages unrelated to
              filling that cart.
            </li>
            <li style={{ marginBottom: '10px' }}>
              <strong>Read access to a creator&rsquo;s own YouTube channel, if they connect one</strong> &mdash;
              so that Mealio can find recipes they have already published and turn them into something their
              audience can cook and shop from. We read the video list, titles and descriptions of the channel
              that was connected, and nothing else. Every recipe found this way is shown to the creator to
              approve, edit or decline before it appears anywhere.
            </li>
            <li style={{ marginBottom: '10px' }}>
              <strong>Permission to read that channel&rsquo;s captions</strong> &mdash; because a great many
              recipe videos say the ingredients out loud instead of listing them in the description, and without
              the captions there is nothing for Mealio to read. <strong>We only ask for this if a creator asks
              us to read their captions</strong>, from the YouTube card in their creator portal; connecting a
              channel by itself asks to read titles and descriptions and nothing more. Captions are read only
              for videos on the channel that was connected, and only for a video whose description is too short
              to hold the recipe.
            </li>
            <li>
              <strong>Permission to edit that channel&rsquo;s video descriptions</strong> &mdash; so that a
              creator can have Mealio add a link to their recipe at the end of the description of the video it
              came from. <strong>We only ask for this if a creator turns that feature on.</strong> It only ever
              adds our link and changes nothing else, and it applies only to videos on the channel they
              connected. A creator can turn it off, disconnect the channel in Mealio, or revoke access from
              their Google account at any time.
              <br />
              <em>
                Google grants these last two through one permission
                (&ldquo;youtube.force-ssl&rdquo;), so a creator who asks for either will see Google&rsquo;s own
                wording, which mentions both. Mealio treats them as two separate decisions and asks for the
                permission on whichever one the creator made: editing a description additionally requires a
                setting the creator turns on themselves, which is off by default, is checked on our server
                before every edit, and which asking to have captions read does not change.
              </em>
            </li>
          </ul>
          <p style={p}>
            Mealio does not use information obtained from Google APIs for advertising, does not sell or
            transfer it, and does not use it to train machine-learning models. The{' '}
            <a href="https://mealio.co/privacy" style={link}>privacy policy</a> sets out all of it in full.
          </p>
        </div>

        <div style={section}>
          <h2 style={h2}>What it costs</h2>
          <p style={p}>
            Free to use for up to three saved meals. Full access is a paid subscription — see{' '}
            <Link href="/pricing" style={link}>pricing</Link> for the current plans.
          </p>
        </div>

        <div style={section}>
          <h2 style={h2}>Your data</h2>
          <p style={p}>
            Mealio never receives your grocery store password: you sign in to the store directly, and Mealio
            acts on your behalf only to search products and add them to your cart. It does not monitor your
            browsing or read pages unrelated to filling that cart.
          </p>
          <p style={p}>
            The <a href="https://mealio.co/privacy" style={link}>privacy policy</a> covers all of it,
            including exactly what a connected YouTube channel allows and how to disconnect it. The{' '}
            <a href="https://mealio.co/terms" style={link}>terms of service</a> set out the rest.
          </p>
        </div>

        <div style={{ ...section, paddingTop: '28px', borderTop: '1px solid #e0e0e0' }}>
          <p style={p}>
            <Link href="/discover" style={{ ...link, fontWeight: 600 }}>Browse meals &rarr;</Link>
          </p>
          <p style={{ ...p, fontSize: '13px', color: '#888' }}>
            Mealio is operated by <strong>Mealio LLC</strong>. Questions:{' '}
            <a href="mailto:contact@mealio.co" style={link}>contact@mealio.co</a>
          </p>
        </div>
      </div>

      <AppFooter />
    </div>
  );
}
