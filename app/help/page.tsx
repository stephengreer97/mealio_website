import type { Metadata } from 'next';
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

      {/* Intro banner */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e8e8e8' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: '20px 24px' }}>
          <div style={{ fontWeight: 700, fontSize: '15px', color: '#111', marginBottom: '4px' }}>Two ways to fill your cart</div>
          <div style={{ fontSize: '13px', color: '#666' }}>
            Connect your Kroger account to add ingredients on the web, or use the Mealio app for H-E-B, Walmart, Amazon Fresh, the Albertsons family, and more.
          </div>
        </div>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '48px 24px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: '48px', alignItems: 'start' }}>

        {/* Sidebar nav */}
        <nav style={{ position: 'sticky', top: '24px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', fontSize: '13px' }}>
            {[
              { label: 'Getting Started',        href: '#getting-started' },
              { label: 'Adding to Cart (Web)',   href: '#web-cart' },
              { label: 'Using the Mobile App',   href: '#mobile-app' },
              { label: 'Supported Stores',       href: '#stores' },
              { label: 'Discover',               href: '#discover' },
              { label: 'Managing Your Account',  href: '#account' },
              { label: 'Subscription Plans',     href: '#subscription' },
              { label: 'Creator Program',        href: '#creator' },
              { label: 'Troubleshooting',        href: '#troubleshooting' },
              { label: 'FAQ',                    href: '#faq' },
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

            <h3 style={h3}>How Mealio adds ingredients to your cart</h3>
            <p style={p}>
              Mealio saves your meals and adds their ingredients to your online grocery cart. There are two ways to do this, depending on where you shop:
            </p>
            <ul style={ul}>
              <li style={li}><strong>On the web</strong> — for Kroger and its sister banners, connect your Kroger account once and add ingredients to your cart directly from <a href="/my-meals" style={a}>mealio.co</a>.</li>
              <li style={li}><strong>In the mobile app</strong> — for H-E-B, Walmart, Amazon Fresh, the Albertsons family, and more, the Mealio app opens the store in a secure in-app browser and adds your ingredients automatically.</li>
            </ul>

            <h3 style={h3}>Logging in</h3>
            <p style={p}>
              Log in with your email and password on <a href="/signin" style={a}>mealio.co</a> or in the mobile app. Your login persists for 90 days — you should not need to sign in again unless you explicitly log out or clear your data.
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

          {/* ── Adding to Cart on the Web ── */}
          <section id="web-cart" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Adding to Cart on the Web (Kroger Brands)</h2>

            <h3 style={h3}>Connecting your Kroger account</h3>
            <p style={p}>
              Go to <a href="/account" style={a}>mealio.co/account</a> and click <strong>Connect Kroger Account</strong> under <strong>Kroger Brands Integration</strong>. You will be sent to Kroger to sign in and authorize Mealio, then returned to your account. This works with Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, and more than ten other Kroger banners.
            </p>

            <h3 style={h3}>Setting your store</h3>
            <p style={p}>
              After connecting, choose your local store location so prices and availability match where you shop. You can update this at any time from your account.
            </p>

            <h3 style={h3}>Adding a meal to your cart</h3>
            <p style={p}>
              On <a href="/my-meals" style={a}>My Meals</a>, pick a Kroger-family store from the store filter, select one or more meals, and click <strong>Add to Cart</strong>. Mealio matches each ingredient to a product and adds it to your Kroger cart. You then review and check out on the store's own site as usual.
            </p>

            <h3 style={h3}>Choosing products</h3>
            <p style={p}>
              When an ingredient could match several products, Mealio asks you to <strong>Choose Product</strong> so the right item lands in your cart. Pick the product you want once and Mealio remembers it for that meal.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Using the Mobile App ── */}
          <section id="mobile-app" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Using the Mobile App</h2>

            <h3 style={h3}>Getting the app</h3>
            <p style={p}>
              Download Mealio for iOS from the App Store and sign in with your Mealio account. Your saved meals and subscription carry over automatically — they are stored on Mealio's servers, not on any single device.
            </p>

            <h3 style={h3}>Choosing a store</h3>
            <p style={p}>
              Open a meal and tap <strong>Add to Cart</strong>, then pick the store you want to shop. Meals are stored separately per store, since each retailer sells different products under different names.
            </p>

            <h3 style={h3}>Signing in to the store</h3>
            <p style={p}>
              The first time you add to cart at a store, Mealio opens that store's site in a secure in-app browser and asks you to log in with your grocery account. Mealio never sees or stores your store credentials — you log in directly with the retailer, and the store keeps you signed in for next time.
            </p>

            <h3 style={h3}>Adding ingredients automatically</h3>
            <p style={p}>
              Once you're signed in, Mealio searches for each ingredient and adds it to your cart. A progress indicator shows how many items are done. You can send the job to the background — a floating progress bubble keeps you posted while you use the rest of the app — and Mealio notifies you when it finishes.
            </p>
            <p style={p}>
              When the run completes, Mealio shows a cart summary so you can confirm everything made it in before you check out on the store's site.
            </p>

            <h3 style={h3}>Resolving items that need attention</h3>
            <p style={p}>
              If an ingredient could match several products, Mealio asks you to <strong>Choose Product</strong>. If an item can't be found or is out of stock, it's flagged in <strong>Review Ingredients</strong>, where you can pick an alternative or skip it. The rest of the meal continues adding normally.
            </p>

            <h3 style={h3}>Saving and editing meals</h3>
            <p style={p}>
              Save preset meals from Discover, or create your own with a name and a list of ingredients. Tap a meal to expand it and edit its ingredients. Free accounts can save up to <strong>3 meals per store</strong>; Full Access removes the limit.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Supported Stores ── */}
          <section id="stores" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Supported Stores</h2>

            <h3 style={h3}>On the web (connect your Kroger account)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 16px', margin: '0 0 16px' }}>
              {[
                'Kroger', 'Ralphs', 'Fred Meyer', 'King Soopers', "Smith's Food & Drug",
                "Fry's Food", 'QFC', 'City Market', 'Dillons', "Baker's",
                "Mariano's", "Pick 'n Save", 'Metro Market', 'Pay-Less', 'Harris Teeter',
              ].map(name => (
                <div key={name} style={{ fontSize: '13px', color: '#555', padding: '3px 0' }}>
                  <strong style={{ color: '#333' }}>{name}</strong>
                </div>
              ))}
            </div>

            <h3 style={h3}>In the mobile app</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 16px', margin: '0 0 12px' }}>
              {[
                'H-E-B', 'Walmart', 'Amazon Fresh', 'ALDI', 'Wegmans',
                'Albertsons', 'Safeway', 'Vons', 'Jewel-Osco', "Shaw's",
                'Acme Markets', 'Tom Thumb', 'Randalls', 'Pavilions', 'Star Market',
                'Haggen', 'Carrs', 'Kings Food Markets', "Balducci's",
              ].map(name => (
                <div key={name} style={{ fontSize: '13px', color: '#555', padding: '3px 0' }}>
                  <strong style={{ color: '#333' }}>{name}</strong>
                </div>
              ))}
            </div>
            <p style={p}>
              Meals are stored separately per store. A meal saved at H-E-B will not appear when you switch to Walmart, since product names and availability differ across stores. We're always adding support for more retailers — if a store you use isn't listed, let us know.
            </p>
          </section>

          <hr style={divider} />

          {/* ── Discover ── */}
          <section id="discover" style={{ marginBottom: '56px' }}>
            <h2 style={h2}>Discover</h2>

            <h3 style={h3}>What is Discover?</h3>
            <p style={p}>
              Discover shows preset meals published by Mealio's approved creator partners. These are ready-made meals with pre-configured ingredients that you can save to your meal list with one tap. Discover is available on the website at <a href="/discover" style={a}>mealio.co/discover</a> and in the mobile app.
            </p>

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
              Use the search box at the top of Discover to filter meals. Search matches against the meal name, author, recipe website, and ingredients. For example, searching "pasta" will show any meal with pasta in the name or ingredient list.
            </p>

            <h3 style={h3}>Saving a preset meal</h3>
            <p style={p}>
              Tap <strong>Save</strong> on any Discover meal to add it to your My Meals for the current store. You can then add it to your cart the same way as any other saved meal.
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
              Click <strong>Account</strong> in the top navigation, then click <strong>Log Out</strong> from the dropdown. This clears your session on that device. In the mobile app, log out from the Account tab.
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
                  price: '$4.99/mo or $49.99/yr',
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
              Go to <a href="/account" style={a}>mealio.co/account</a> and click <strong>Upgrade to Full Access</strong>. You will be taken to the checkout page. Both monthly and annual plans are available — the annual plan works out to about $4.17/month — billed as $49.99/year.
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
              The Mealio Creator Program allows approved food creators to publish meals to the Discover tab, which is visible to all Mealio users. Popular meals earn a share of quarterly subscription profit.
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

            <h3 style={h3}>How profit share is calculated</h3>
            <p style={p}>
              Each quarter, one-third of Mealio's subscription profit is distributed to active Creator Partners. Your share is determined by two equally weighted factors:
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

            <h3 style={h3}>Items are not being added to my cart</h3>
            <p style={p}>
              This can happen when:
            </p>
            <ul style={ul}>
              <li style={li}>The ingredient name doesn't match what the store sells — try editing the meal with a simpler or more generic product name</li>
              <li style={li}>You are not signed in to the grocery store — make sure your store session is active (in the mobile app, log in again when prompted)</li>
              <li style={li}>The item is out of stock or not available in your area</li>
              <li style={li}>The store's website changed its layout — contact us so we can update the integration</li>
            </ul>
            <p style={p}>
              Items that can't be added are flagged so you can pick an alternative product or skip them.
            </p>

            <h3 style={h3}>My Kroger account won't connect</h3>
            <p style={p}>
              Make sure you complete the sign-in and authorization steps on Kroger's site and allow the pop-up to return to mealio.co. If the connection expires, reconnect from <a href="/account" style={a}>mealio.co/account</a>. Your saved meals are never affected by a disconnected store account.
            </p>

            <h3 style={h3}>The store won't keep me logged in (mobile app)</h3>
            <p style={p}>
              Some stores sign you out after a period of inactivity or require periodic re-verification. When that happens, Mealio will prompt you to log in again in the in-app browser. Your saved meals are stored on our servers and are never lost.
            </p>

            <h3 style={h3}>I did not receive my verification or 2FA email</h3>
            <p style={p}>
              Check your spam or junk folder. Emails are sent from <strong>contact@mealio.co</strong>. If you still don't see it, add that address to your contacts and use the resend option. Codes expire after 10 minutes, so request a fresh one if needed.
            </p>
          </section>

          <hr style={divider} />

          {/* ── FAQ ── */}
          <section id="faq">
            <h2 style={h2}>Frequently Asked Questions</h2>

            {[
              {
                q: 'Is Mealio free to use?',
                a: 'Yes. The free plan lets you save up to 3 meals per grocery store and includes full cart automation and access to Discover. The Full Access plan ($4.99/month or $49.99/year) removes the meal limit and adds shareable meal links.',
              },
              {
                q: 'Which grocery stores does Mealio support?',
                a: 'On the web, Mealio works with Kroger and its sister banners (Ralphs, Fred Meyer, King Soopers, Harris Teeter, and more) once you connect your Kroger account. In the mobile app, Mealio supports H-E-B, Walmart, Amazon Fresh, ALDI, Wegmans, and the Albertsons family (Safeway, Vons, Jewel-Osco, Acme, and more). See the Supported Stores section above for the full list.',
              },
              {
                q: 'Do my meals sync across devices?',
                a: 'Yes. Your meals are stored on Mealio\'s servers, not on any single device. Log in on the website or the mobile app and your meals will be there.',
              },
              {
                q: 'Does Mealio have access to my grocery account or payment information?',
                a: 'No. For Kroger, you authorize Mealio through Kroger\'s own sign-in, and we never see your password. In the mobile app, you log in directly with the store in a secure in-app browser. We never see or store your grocery credentials or payment details.',
              },
              {
                q: 'Why are my meals separate for each store?',
                a: 'Each store sells different products under different names. A meal saved at H-E-B uses H-E-B product names which may not match what Walmart calls the same item. Keeping meals per-store ensures the cart automation works correctly.',
              },
              {
                q: 'What happens if an ingredient is not found?',
                a: 'Mealio flags it so you can pick an alternative from the store\'s search results or skip that item. The rest of the meal continues adding normally.',
              },
              {
                q: 'How do I cancel my subscription?',
                a: 'Go to mealio.co/account and click Manage Subscription. This opens the billing portal where you can cancel. You keep Full Access until the end of your current billing period.',
              },
              {
                q: 'I\'m a food creator. How much can I earn?',
                a: 'Earnings depend on how often your meals are saved relative to other creators. One-third of Mealio\'s quarterly subscription profit is split among all Creator Partners based on their share of saves. Your Creator Portal shows your current percentage and a breakdown of the calculation. Payouts are issued quarterly for amounts above $25.',
              },
              {
                q: 'Can I publish meals as a creator and still use Mealio as a regular user?',
                a: 'Yes. Your creator account and your personal meal library are completely separate. You can save and use personal meals just like any other user.',
              },
              {
                q: 'How do I report a bug or request a feature?',
                a: 'Email contact@mealio.co with a description of the issue or idea. If it\'s a bug report, include which grocery store you were using and whether you were on the website or the mobile app.',
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

const li: React.CSSProperties = {
  fontSize: '14px', lineHeight: 1.7, marginBottom: '4px',
};

const a: React.CSSProperties = {
  color: '#dd0031', textDecoration: 'underline',
};

const divider: React.CSSProperties = {
  border: 'none', borderTop: '1px solid #e8e8e8', margin: '0 0 48px',
};
