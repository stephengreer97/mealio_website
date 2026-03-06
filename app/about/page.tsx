import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description: 'Learn about Mealio — the grocery shopping app that saves your meal recipes and adds ingredients to your cart in one click.',
};

export default function AboutPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(160deg, #c40029 0%, #dd0031 55%, #e8193a 100%)', color: 'white', padding: '28px 24px' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700 }}>About Mealio</h1>
          <p style={{ margin: '6px 0 0', fontSize: '14px', opacity: 0.85 }}>Grocery shopping, simplified.</p>
        </div>
      </div>

      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 24px', lineHeight: 1.75, color: '#333', fontSize: '15px' }}>

        {/* Mission */}
        <div style={{ background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: '20px', fontWeight: 700, color: '#222' }}>What is Mealio?</h2>
          <p style={{ margin: 0, color: '#555' }}>
            Mealio is a browser extension that takes the friction out of grocery shopping. Instead of manually searching for every ingredient every week, you save your favorite meals once — and Mealio adds everything to your cart automatically, at whichever store you're shopping at.
          </p>
        </div>

        {/* How it works */}
        <div style={{ background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ margin: '0 0 20px', fontSize: '20px', fontWeight: 700, color: '#222' }}>How it works</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {[
              { step: '1', title: 'Save your meals', desc: 'Add meals with their ingredients — manually or by saving them while you shop. Each meal remembers exactly what you need.' },
              { step: '2', title: 'Go to your grocery store', desc: 'Visit any supported grocery store online. Mealio detects the store automatically.' },
              { step: '3', title: 'Add to cart in one click', desc: 'Select the meals you want to cook this week and hit Add to Cart. Mealio searches for and adds every ingredient.' },
            ].map(item => (
              <div key={item.step} style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#dd0031', color: 'white', fontWeight: 700, fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {item.step}
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: '#222', marginBottom: '4px' }}>{item.title}</div>
                  <div style={{ color: '#666', fontSize: '14px' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Stores */}
        <div style={{ background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: '20px', fontWeight: 700, color: '#222' }}>Supported Stores</h2>
          <p style={{ color: '#555', margin: '0 0 16px' }}>Mealio currently supports the following online grocery platforms:</p>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {['HEB', 'Walmart', 'Kroger'].map(store => (
              <div key={store} style={{ background: '#f5f5f5', borderRadius: '8px', padding: '10px 20px', fontWeight: 600, color: '#333', fontSize: '14px' }}>
                {store}
              </div>
            ))}
          </div>
          <p style={{ color: '#999', fontSize: '13px', marginTop: '14px', marginBottom: 0 }}>More stores coming soon.</p>
        </div>

        {/* Creator program */}
        <div style={{ background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: '20px', fontWeight: 700, color: '#222' }}>Creator Partner Program</h2>
          <p style={{ color: '#555', margin: '0 0 12px' }}>
            Mealio partners with food creators to bring professionally curated meals to the Discover tab, available to all users. Approved Creator Partners earn a share of quarterly subscription revenue based on how often their meals are saved.
          </p>
          <p style={{ color: '#555', margin: 0 }}>
            If you're a food creator interested in partnering with Mealio, log in and apply from your dashboard.
          </p>
        </div>

        {/* Contact */}
        <div style={{ background: 'white', borderRadius: '14px', padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: '20px', fontWeight: 700, color: '#222' }}>Get in touch</h2>
          <p style={{ color: '#555', margin: '0 0 16px' }}>
            Questions, feedback, or partnership inquiries? We'd love to hear from you.
          </p>
          <a
            href="mailto:contact@mealio.co"
            style={{ display: 'inline-block', background: '#dd0031', color: 'white', padding: '12px 24px', borderRadius: '8px', textDecoration: 'none', fontWeight: 600, fontSize: '14px' }}
          >
            contact@mealio.co
          </a>
        </div>

        <p style={{ fontSize: '13px', color: '#999', textAlign: 'center', marginTop: '40px' }}>
          © {new Date().getFullYear()} Mealio. All rights reserved.
        </p>
      </div>
    </div>
  );
}
