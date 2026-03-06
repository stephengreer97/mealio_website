import type { Metadata } from 'next';
import ExtensionCTAButton from '@/components/ExtensionCTAButton';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';

export const metadata: Metadata = {
  title: 'Help',
  description: 'Find answers to common questions about Mealio — saving meals, adding ingredients to your cart, supported stores, and more.',
};

export default function HelpPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <style>{`
        .help-nav-link { display: block; color: #555; text-decoration: none; padding: 7px 0; border-bottom: 1px solid #f0f0f0; line-height: 1.4; transition: color 0.15s; }
        .help-nav-link:hover { color: #dd0031; }
      `}</style>

      <AppHeader />

      {/* Extension CTA */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e8e8e8' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111', marginBottom: '4px' }}>Get the Mealio extension</div>
            <div style={{ fontSize: '13px', color: '#666' }}>Add ingredients to your grocery cart in one click — available for Chrome, Firefox, and Edge.</div>
          </div>
          <ExtensionCTAButton />
        </div>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '48px 24px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: '48px', alignItems: 'start' }}>

        {/* Sidebar nav */}
        <nav style={{ position: 'sticky', top: '24px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', fontSize: '13px' }}>
            {[
              { label: 'Getting Started',       href: '#getting-started' },
              { label: 'Using the Extension',   href: '#using-extension' },
              { label: 'Discover',               href: '#discover' },
              { label: 'Managing Your Account', href: '#account' },
              { label: 'Subscription Plans',    href: '#subscription' },
              { label: 'Creator Program',       href: '#creator' },
              { label: 'Troubleshooting',       href: '#troubleshooting' },
              { label: 'FAQ',                   href: '#faq' },
            ].map(item => (
              <a key={item.href} href={item.href} className="help-nav-link">
                {item.label}
              </a>
            ))}
            <a
              href="mailto:contact@mealio.co"
              style={{ display: 'block', color: '#dd0031', textDecoration: 'none', padding: '10px 0 0', fontWeight: 600 }}
            >
              Contact Support →
            </a>
          </div>
        </nav>

        {/* Main content */}
        <main style={{ minWidth: 0 }}>

          {/* Page title */}
          <div style={{ marginBottom: '40px' }}>
            <h1 style={{ margin: '0 0 8px', fontSize: '28px', fontWeight: 700, color: '#111' }}>Help & Documentation</h1>
            <p style={{ margin: 0, color: '#555', fontSize: '15px' }}>
              Everything you need to know about using Mealio.{' '}
              <a href="mailto:contact@mealio.co" style={{ color: '#dd0031', textDecoration: 'underline' }}>Contact us</a>
              {' '}if you can't find what you're looking for.
            </p>
          </div>

          {/* ── Getting Started ── */}
          <section id="getting-started" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Getting Started</h2>

            <h3 style={h3}>Creating an account</h3>
            <p style={p}>
              Go to <a href="/" style={a}>mealio.co</a> and click the <strong>Sign Up</strong> tab. Enter your email address and choose a password, then click <strong>Create Account</strong>. You will receive a verification email — click the link inside to confirm your address before logging in.
            </p>

            <h3 style={h3}>Installing the Chrome extension</h3>
            <p style={p}>
              Visit the Mealio listing in the Chrome Web Store and click <strong>Add to Chrome</strong>. Once installed, the Mealio icon will appear in your browser toolbar. If you don't see it, click the puzzle piece icon in Chrome's toolbar and pin Mealio from the list.
            </p>

            <h3 style={h3}>Logging in through the extension</h3>
            <p style={p}>
              Click the Mealio icon in your toolbar to open the side panel. If you are not logged in, click <strong>Sign In with Mealio</strong>. A tab will open to mealio.co — log in there, and the extension will detect your session automatically within a few seconds. You do not need to do anything else in the tab once you have logged in.
            </p>
            <p style={p}>
              Your login persists for 90 days. You should not need to log in again unless you explicitly log out or clear your browser data.
            </p>

            <h3 style={h3}>Two-factor authentication (creators and admins)</h3>
            <p style={p}>
              If your account has creator or admin status, you will be asked to enter a 6-digit code sent to your email each time you log in from a new device. Enter the code within 10 minutes. You can check the <strong>Remember this device for 30 days</strong> box to skip this step on trusted devices.
            </p>
            <p style={p}>
              If you don't receive the code within a minute, check your spam folder or use the <strong>Resend code</strong> link. A new code can be requested once every 60 seconds.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Using the Extension ── */}
          <section id="using-extension" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Using the Extension</h2>

            <h3 style={h3}>The side panel</h3>
            <p style={p}>
              The Mealio side panel opens when you click the extension icon. It has three main tabs:
            </p>
            <ul style={ul}>
              <li style={li}><strong>My Meals</strong> — your saved meals for the current grocery store</li>
              <li style={li}><strong>Discover</strong> — preset meals published by Mealio's creator partners</li>
              <li style={li}><strong>Store selector</strong> — appears when you are not on a supported store site</li>
            </ul>

            <h3 style={h3}>Store detection</h3>
            <p style={p}>
              Mealio automatically detects which grocery store you are browsing. Currently supported stores:
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 16px', margin: '0 0 12px' }}>
              {[
                ['H-E-B', 'heb.com'],
                ['Walmart', 'walmart.com'],
                ['Kroger', 'kroger.com'],
                ['ALDI', 'aldi.us'],
                ['Central Market', 'centralmarket.com'],
                ['Costco', 'costco.com'],
                ['Albertsons', 'albertsons.com'],
                ['Amazon Fresh', 'amazon.com'],
                ['Safeway', 'safeway.com'],
                ['Vons', 'vons.com'],
                ['Jewel-Osco', 'jewelosco.com'],
                ["Shaw's", 'shaws.com'],
                ['Acme Markets', 'acmemarkets.com'],
                ['Tom Thumb', 'tomthumb.com'],
                ['Randalls', 'randalls.com'],
                ['Pavilions', 'pavilions.com'],
                ['Star Market', 'starmarket.com'],
                ['Haggen', 'haggen.com'],
                ['Carrs', 'carrsqc.com'],
                ['Kings Food Markets', 'kingsfoodmarkets.com'],
                ["Balducci's", 'balduccis.com'],
                ['Ralphs', 'ralphs.com'],
                ['Fred Meyer', 'fredmeyer.com'],
                ['King Soopers', 'kingsoopers.com'],
                ["Smith's Food & Drug", 'smithsfoodanddrug.com'],
                ["Fry's Food", 'frysfood.com'],
                ['QFC', 'qfc.com'],
                ['City Market', 'citymarket.com'],
                ['Dillons', 'dillons.com'],
                ["Baker's", 'bakersplus.com'],
                ["Mariano's", 'marianos.com'],
                ["Pick 'n Save", 'picknsave.com'],
                ['Metro Market', 'metromarket.net'],
                ['Pay-Less', 'pay-less.com'],
                ['Harris Teeter', 'harristeeter.com'],
                ['Wegmans', 'wegmans.com'],
              ].map(([name, domain]) => (
                <div key={domain} style={{ fontSize: '13px', color: '#555', padding: '3px 0' }}>
                  <strong style={{ color: '#333' }}>{name}</strong>
                </div>
              ))}
            </div>
            <p style={p}>
              If you open the extension while not on one of these sites, you will see a store selector. Tap the store you want to use and Mealio will open it in a new tab.
            </p>
            <p style={p}>
              Meals are stored separately per store. A meal saved while shopping at HEB will not appear when you're on Walmart, and vice versa. This prevents confusion from different product names and availability across stores.
            </p>

            <h3 style={h3}>Recording a meal</h3>
            <p style={p}>
              The best way to save a new meal is to record it as you shop:
            </p>
            <ol style={ol}>
              <li style={li}>Go to a supported grocery store and open the Mealio side panel.</li>
              <li style={li}>Click <strong>Add Meal</strong> and give it a name (e.g., "Chicken Tacos").</li>
              <li style={li}>Search for and add each ingredient to your cart normally. Mealio watches your cart and records each item you add.</li>
              <li style={li}>When you are done, click <strong>Save Meal</strong> in the panel.</li>
            </ol>
            <p style={p}>
              The meal is now saved and can be re-added to your cart in future sessions with a single click.
            </p>

            <h3 style={h3}>Adding a saved meal to your cart</h3>
            <p style={p}>
              On a supported grocery store, open the side panel and find the meal you want. Check the box next to it (or check multiple meals), then click <strong>Add to Cart</strong>. Mealio will search for each ingredient and add it automatically. A progress indicator shows which items are being added.
            </p>
            <p style={p}>
              If an item cannot be found, Mealio will flag it as a conflict. You can resolve conflicts by selecting an alternative product or skipping that item.
            </p>

            <h3 style={h3}>Editing a meal</h3>
            <p style={p}>
              Tap a meal's name to expand it and see its ingredients. You can remove individual ingredients or delete the meal entirely. To change a meal's name or add ingredients, delete it and re-record it.
            </p>

            <h3 style={h3}>Meal limits</h3>
            <p style={p}>
              Free accounts can save up to <strong>3 meals per store</strong>. Full Access accounts have no limit. If you hit the limit on a free account, you will need to delete an existing meal or upgrade to Full Access before adding more.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Discover ── */}
          <section id="discover" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Discover</h2>

            <h3 style={h3}>What is Discover?</h3>
            <p style={p}>
              Discover shows preset meals published by Mealio's approved creator partners. These are ready-made meals with pre-configured ingredients that you can save directly to your meal list with one click. You can browse Discover in two places:
            </p>
            <ul style={ul}>
              <li style={li}><strong>On the website</strong> — visit <a href="/discover" style={a}>mealio.co/discover</a>, the main page after logging in</li>
              <li style={li}><strong>In the extension</strong> — the Discover tab in the Mealio side panel</li>
            </ul>

            <h3 style={h3}>Trending vs. New</h3>
            <p style={p}>
              Discover has two sub-tabs:
            </p>
            <ul style={ul}>
              <li style={li}><strong>Trending</strong> — meals ranked by a score weighted toward recent saves (last 30 days count most)</li>
              <li style={li}><strong>New</strong> — meals sorted by publish date, newest first</li>
            </ul>

            <h3 style={h3}>Searching Discover</h3>
            <p style={p}>
              Use the search box at the top of the Discover tab to filter meals. Search matches against the meal name, author, recipe website, and ingredients. For example, searching "pasta" will show any meal with pasta in the name or ingredient list.
            </p>

            <h3 style={h3}>Saving a preset meal</h3>
            <p style={p}>
              Tap the <strong>Save</strong> button on any Discover meal to add it to your My Meals tab for the current store. You can then add it to your cart the same way as any other saved meal.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Account ── */}
          <section id="account" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Managing Your Account</h2>

            <h3 style={h3}>Changing your password</h3>
            <p style={p}>
              Go to <a href="/account" style={a}>mealio.co/account</a>, enter your current password, then choose and confirm a new password. Click <strong>Update Password</strong>.
            </p>

            <h3 style={h3}>Updating your email</h3>
            <p style={p}>
              Email changes are not currently supported through the account page. Contact us at <a href="mailto:contact@mealio.co" style={a}>contact@mealio.co</a> and we will update it manually after verifying your identity.
            </p>

            <h3 style={h3}>Logging out</h3>
            <p style={p}>
              Click <strong>Account</strong> in the top navigation, then click <strong>Log Out</strong> from the dropdown. This clears your session from the browser. The extension will return to the login screen on its next check.
            </p>

            <h3 style={h3}>Deleting your account</h3>
            <p style={p}>
              Account deletion is handled by request. Email <a href="mailto:contact@mealio.co" style={a}>contact@mealio.co</a> from the address associated with your account. We will delete your data within 30 days per our Privacy Policy.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Subscription ── */}
          <section id="subscription" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Subscription Plans</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              {[
                {
                  name: 'Free',
                  price: '$0',
                  features: ['Up to 3 saved meals per store', 'Full cart automation', 'Access to Discover', 'All supported stores'],
                },
                {
                  name: 'Full Access',
                  price: '$3.49/mo or $29.99/yr',
                  features: ['Unlimited saved meals', 'Full cart automation', 'Access to Discover', 'All supported stores', 'Shareable meal links', 'Priority support'],
                  highlight: true,
                },
              ].map(plan => (
                <div key={plan.name} style={{
                  background: 'white', borderRadius: '12px', padding: '20px',
                  border: plan.highlight ? '2px solid #dd0031' : '1px solid #e8e8e8',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}>
                  <div style={{ fontWeight: 700, fontSize: '16px', color: plan.highlight ? '#dd0031' : '#222', marginBottom: '4px' }}>{plan.name}</div>
                  <div style={{ fontSize: '13px', color: '#888', marginBottom: '14px' }}>{plan.price}</div>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {plan.features.map(f => (
                      <li key={f} style={{ fontSize: '13px', color: '#555', padding: '4px 0', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                        <span style={{ color: '#dd0031', fontWeight: 700, flexShrink: 0 }}>—</span> {f}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <h3 style={h3}>Upgrading to Full Access</h3>
            <p style={p}>
              Go to <a href="/account" style={a}>mealio.co/account</a> and click <strong>Upgrade to Full Access</strong>. You will be taken to the checkout page. Both monthly and annual plans are available — the annual plan works out to about $2.50/month — billed as $29.99/year.
            </p>

            <h3 style={h3}>Managing or cancelling your subscription</h3>
            <p style={p}>
              Go to <a href="/account" style={a}>mealio.co/account</a> and click <strong>Manage Subscription</strong> to open the billing portal, where you can update your payment method, view invoices, or cancel. Cancellation takes effect at the end of your current billing cycle — you retain Full Access until then.
            </p>

            <h3 style={h3}>Comped Full Access for creators</h3>
            <p style={p}>
              Approved Creator Partners automatically receive Full Access at no charge for as long as they remain active partners.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Creator ── */}
          <section id="creator" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Creator Program</h2>

            <h3 style={h3}>What is the Creator Program?</h3>
            <p style={p}>
              The Mealio Creator Program allows approved food creators to publish meals to the Discover tab, which is visible to all Mealio users. Popular meals earn a share of quarterly subscription revenue.
            </p>

            <h3 style={h3}>How to apply</h3>
            <p style={p}>
              Log in, then visit <a href="/creator/apply" style={a}>mealio.co/creator/apply</a>. Fill in your display name and any social media or website links so we can find your work. Applications are reviewed manually — you will hear back via email.
            </p>

            <h3 style={h3}>Publishing meals</h3>
            <p style={p}>
              Once approved, go to <a href="/creator" style={a}>mealio.co/creator</a> — you will also find a <strong>Creator Portal</strong> link under <strong>Account</strong> in the navigation. Click <strong>Publish New Meal</strong> and fill in:
            </p>
            <ul style={ul}>
              <li style={li}><strong>Meal name</strong> (required)</li>
              <li style={li}><strong>Ingredients</strong> with quantities (required) — the product name is used as the cart search term automatically</li>
              <li style={li}><strong>Photo</strong> (optional but strongly recommended)</li>
              <li style={li}><strong>Recipe instructions</strong> (optional)</li>
              <li style={li}><strong>Recipe URL</strong> (optional) — link to the original recipe on your website or blog</li>
              <li style={li}><strong>Difficulty</strong> (optional, 1–5)</li>
            </ul>
            <p style={p}>
              Once published, the meal is immediately visible in Discover for all users.
            </p>

            <h3 style={h3}>How revenue share is calculated</h3>
            <p style={p}>
              Each quarter, one-third of Mealio's subscription revenue is distributed to active Creator Partners. Your share is determined by two equally weighted factors:
            </p>
            <ul style={ul}>
              <li style={li}><strong>Quarterly saves (50%)</strong> — your meals saved this quarter as a percentage of all creator meal saves this quarter</li>
              <li style={li}><strong>All-time saves (50%)</strong> — your total meal saves as a percentage of all creator meal saves of all time</li>
            </ul>
            <p style={p}>
              Your Creator Portal shows these numbers in real time, including the exact formula breakdown. Payouts are issued quarterly via Tremendous for amounts above $25. Recipients choose their preferred payout method (bank transfer, PayPal, Venmo, gift cards, etc.) when claiming.
            </p>

            <h3 style={h3}>Creator Partner exclusivity</h3>
            <p style={p}>
              Creator Partners agree not to formally partner with competing grocery cart automation apps while participating in the program. This does not restrict general social media posting, personal blogs, or unrelated brand deals. See <a href="/terms#4.3" style={a}>Section 4.3 of the Terms and Conditions</a> for the full details.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Troubleshooting ── */}
          <section id="troubleshooting" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Troubleshooting</h2>

            <h3 style={h3}>The extension shows the login screen even though I'm logged in</h3>
            <p style={p}>
              This usually means your session has expired or your access token could not be refreshed. Log in again at mealio.co — the extension should pick up the new session within a few seconds. If it keeps happening, try clearing the extension's storage from the Chrome extension developer tools and logging in fresh.
            </p>

            <h3 style={h3}>My meal disappeared after adding it to the cart</h3>
            <p style={p}>
              This can happen if the extension's service worker was restarted by Chrome (Chrome suspends inactive extensions to save memory) and the login token expired in the interim. We use persistent background alarms to refresh your token every 55 minutes to prevent this, but if the browser was off for an extended period you may need to log in again. Your saved meals are stored server-side and are not lost — they will reappear once you are logged back in.
            </p>

            <h3 style={h3}>Items are not being added to my cart</h3>
            <p style={p}>
              This can happen when:
            </p>
            <ul style={ul}>
              <li style={li}>The ingredient name doesn't match what the store sells — try editing the meal with a simpler or more generic product name</li>
              <li style={li}>The store's website has updated its layout — contact us so we can update the integration</li>
              <li style={li}>You are not logged in to the grocery store — make sure you have an active session on the store's site</li>
              <li style={li}>The item is out of stock or not available in your area</li>
            </ul>
            <p style={p}>
              Items that cannot be found are flagged as conflicts in the side panel. You can pick an alternative product or skip those items.
            </p>

            <h3 style={h3}>The extension is not detecting the grocery store</h3>
            <p style={p}>
              Make sure you are on a supported store's main shopping site and not on a subdomain or third-party delivery service. If the store selector appears, select the correct store and Mealio will open the right page.
            </p>

            <h3 style={h3}>I did not receive my verification or 2FA email</h3>
            <p style={p}>
              Check your spam or junk folder. Emails are sent from <strong>contact@mealio.co</strong>. If you still don't see it, add that address to your contacts and use the resend option. Codes expire after 10 minutes, so request a fresh one if needed.
            </p>

            <h3 style={h3}>The extension is not loading or shows a blank panel</h3>
            <p style={p}>
              Try these steps in order:
            </p>
            <ol style={ol}>
              <li style={li}>Reload the page you are on</li>
              <li style={li}>Close and reopen the side panel</li>
              <li style={li}>Go to <strong>chrome://extensions</strong>, find Mealio, and click the reload button</li>
              <li style={li}>Remove and reinstall the extension from the Chrome Web Store</li>
            </ol>
            <p style={p}>
              If none of these work, contact us with your Chrome version and a description of the problem.
            </p>
          </section>

          <hr style={divider} />

          {/* ── FAQ ── */}
          <section id="faq">
            <h2 style={h2}>Frequently Asked Questions</h2>

            {[
              {
                q: 'Is Mealio free to use?',
                a: 'Yes. The free plan lets you save up to 3 meals per grocery store and includes full cart automation and access to Discover. The Full Access plan ($3.49/month or $29.99/year) removes the meal limit and adds shareable meal links.',
              },
              {
                q: 'Which grocery stores does Mealio support?',
                a: 'Mealio supports 36 stores including H-E-B, Walmart, Kroger, Albertsons, Safeway, Costco, Amazon Fresh, ALDI, and many more. See the full list in the Using the Extension section above.',
              },
              {
                q: 'Do my meals sync across devices?',
                a: 'Yes. Your meals are stored on Mealio\'s servers, not locally in the extension. Log in on any Chrome browser and your meals will be there.',
              },
              {
                q: 'Does Mealio have access to my grocery account or payment information?',
                a: 'No. Mealio interacts with the grocery store\'s website on your behalf using your existing logged-in browser session. We never see or store your grocery account credentials or payment details.',
              },
              {
                q: 'Why are my meals separate for each store?',
                a: 'Each store sells different products under different names. A meal saved at HEB uses HEB product names which may not match what Walmart calls the same item. Keeping meals per-store ensures the cart automation works correctly.',
              },
              {
                q: 'What happens if an ingredient is not found?',
                a: 'Mealio flags it as a conflict in the side panel. You can select an alternative from the store\'s search results or skip that item. The rest of the meal will continue adding normally.',
              },
              {
                q: 'How do I get the extension to recognize my login?',
                a: 'After logging in at mealio.co, the extension polls for your session every few seconds. It should detect the login automatically and switch to the main view within about 5–10 seconds. You do not need to click anything in the extension.',
              },
              {
                q: 'Can I use Mealio on multiple computers?',
                a: 'Yes. Install the extension on each computer, log in at mealio.co, and your meals and account will be available on each one.',
              },
              {
                q: 'Will Mealio work on Firefox or Safari?',
                a: 'Currently only Chrome is officially supported. Firefox support involves minimal code changes and may be added in the future. Safari requires a separate native app wrapper and is a longer-term consideration.',
              },
              {
                q: 'How do I cancel my subscription?',
                a: 'Go to mealio.co/account and click Manage Subscription. This opens the billing portal where you can cancel. You keep Full Access until the end of your current billing period.',
              },
              {
                q: 'I\'m a food creator. How much can I earn?',
                a: 'Earnings depend on how often your meals are saved relative to other creators. One-third of Mealio\'s quarterly subscription revenue is split among all Creator Partners based on their share of saves. Your Creator Portal shows your current percentage and a breakdown of the calculation. Payouts are issued quarterly for amounts above $25.',
              },
              {
                q: 'Can I publish meals as a creator and still use Mealio as a regular user?',
                a: 'Yes. Your creator account and your personal meal library are completely separate. You can save personal meals in the extension just like any other user.',
              },
              {
                q: 'How do I report a bug or request a feature?',
                a: 'Email contact@mealio.co with a description of the issue or idea. Include your Chrome version and which grocery store you were using if it\'s a bug report.',
              },
            ].map((item, i) => (
              <div key={i} style={{ marginBottom: '24px', background: 'white', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 600, color: '#222' }}>{item.q}</h4>
                <p style={{ margin: 0, fontSize: '14px', color: '#555', lineHeight: 1.65 }}>{item.a}</p>
              </div>
            ))}
          </section>

          {/* Footer contact */}
          <div style={{ marginTop: '48px', background: '#fff8f0', border: '1px solid #ffe0b2', borderRadius: '12px', padding: '24px', textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px', fontWeight: 600, color: '#222', fontSize: '15px' }}>Still have questions?</p>
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: '14px' }}>We're happy to help. Reach out and we'll get back to you.</p>
            <a
              href="mailto:contact@mealio.co"
              style={{ display: 'inline-block', background: '#dd0031', color: 'white', padding: '11px 24px', borderRadius: '8px', textDecoration: 'none', fontWeight: 600, fontSize: '14px' }}
            >
              contact@mealio.co
            </a>
          </div>

        </main>
      </div>
      <AppFooter />
    </div>
  );
}

const h2: React.CSSProperties = {
  fontSize: '22px', fontWeight: 700, color: '#111', margin: '0 0 20px',
  paddingBottom: '10px', borderBottom: '2px solid #f0f0f0',
};

const h3: React.CSSProperties = {
  fontSize: '16px', fontWeight: 600, color: '#222', margin: '28px 0 8px',
};

const p: React.CSSProperties = {
  margin: '0 0 12px', color: '#555', fontSize: '14px', lineHeight: 1.7,
};

const ul: React.CSSProperties = {
  margin: '0 0 12px', paddingLeft: '20px', color: '#555',
};

const ol: React.CSSProperties = {
  margin: '0 0 12px', paddingLeft: '20px', color: '#555',
};

const li: React.CSSProperties = {
  fontSize: '14px', lineHeight: 1.7, marginBottom: '4px',
};

const a: React.CSSProperties = {
  color: '#dd0031', textDecoration: 'underline',
};

const divider: React.CSSProperties = {
  border: 'none', borderTop: '1px solid #e8e8e8', margin: '0 0 48px',
};
