import type { Metadata } from 'next';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Read the Mealio Privacy Policy to understand how we collect, use, and protect your information.',
};

export default function PrivacyPage() {
  const effective = 'February 22, 2026';

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <AppHeader />

      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 24px', lineHeight: 1.75, color: '#333', fontSize: '15px' }}>
        <div style={{ marginBottom: '32px' }}>
          <p style={{ margin: '0 0 4px', fontSize: '13px', color: '#888' }}>Legal</p>
          <h1 style={{ margin: '0 0 6px', fontSize: '26px', fontWeight: 700, color: '#111' }}>Privacy Policy</h1>
          <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>Effective date: {effective}</p>
        </div>

        <p>
          Mealio ("we," "us," or "our") operates the Mealio browser extension and the website located at mealio.co (collectively, the "Service"). This Privacy Policy explains how we collect, use, disclose, and protect information about you when you use our Service. By using the Service, you agree to the collection and use of information in accordance with this policy.
        </p>
        <p>
          If you have questions about this policy, contact us at <a href="mailto:contact@mealio.co" style={{ color: '#dd0031' }}>contact@mealio.co</a>.
        </p>

        <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '32px 0' }} />

        {/* 1 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginBottom: '12px' }}>1. Information We Collect</h2>

        <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#333', marginTop: '20px', marginBottom: '8px' }}>1.1 Information You Provide Directly</h3>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Account information:</strong> When you register, we collect your email address and a hashed password.</li>
          <li style={{ marginBottom: '6px' }}><strong>Creator application:</strong> If you apply to the Creator Partner Program, we collect your display name, phone number (optional), and social media or website links you choose to provide.</li>
          <li style={{ marginBottom: '6px' }}><strong>Meal and recipe data:</strong> Meal names, ingredients, recipes, photos, and associated store information that you save or publish through the Service.</li>
          <li style={{ marginBottom: '6px' }}><strong>Support communications:</strong> Any information you provide when contacting us at contact@mealio.co.</li>
        </ul>

        <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#333', marginTop: '20px', marginBottom: '8px' }}>1.2 Information Collected Automatically</h3>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Authentication data:</strong> Session tokens, refresh tokens, and device identifiers used to keep you logged in securely.</li>
          <li style={{ marginBottom: '6px' }}><strong>Log data:</strong> IP addresses, user agent strings, and timestamps associated with authentication events (login, logout, token refresh). These are used for security monitoring and abuse prevention.</li>
          <li style={{ marginBottom: '6px' }}><strong>Usage data:</strong> Information about how you interact with the Service, including which meals you save and which grocery stores you use. This data is used to calculate creator profit share and improve the Service.</li>
        </ul>

        <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#333', marginTop: '20px', marginBottom: '8px' }}>1.3 Information from Third Parties</h3>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Payment processors:</strong> If you subscribe to a paid plan, payment is processed by our third-party payment provider (Lemon Squeezy). We receive a customer identifier and subscription status but do not store your full payment card details.</li>
          <li style={{ marginBottom: '6px' }}><strong>Grocery platforms:</strong> The extension interacts with grocery store websites on your behalf to add items to your cart. We do not store your grocery account credentials. Any data exchanged with grocery platforms is used solely to complete the cart action you initiate.</li>
        </ul>

        {/* 2 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>2. How We Use Your Information</h2>
        <p>We use the information we collect to:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}>Provide, operate, and maintain the Service;</li>
          <li style={{ marginBottom: '6px' }}>Authenticate your identity and maintain the security of your account;</li>
          <li style={{ marginBottom: '6px' }}>Process subscription payments and manage your subscription status;</li>
          <li style={{ marginBottom: '6px' }}>Calculate and distribute Creator Partner profit share;</li>
          <li style={{ marginBottom: '6px' }}>Send you transactional emails, including login verification codes and account notifications;</li>
          <li style={{ marginBottom: '6px' }}>Respond to your support requests;</li>
          <li style={{ marginBottom: '6px' }}>Detect, investigate, and prevent fraudulent or unauthorized activity;</li>
          <li style={{ marginBottom: '6px' }}>Improve and develop new features for the Service;</li>
          <li style={{ marginBottom: '6px' }}>Comply with legal obligations.</li>
        </ul>
        <p style={{ marginTop: '12px' }}>
          We do not sell your personal information to third parties. We do not use your information for targeted advertising.
        </p>

        {/* 3 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>3. How We Share Your Information</h2>
        <p>We may share your information in the following limited circumstances:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Service providers:</strong> We share information with third-party vendors who help us operate the Service, including our database host (Supabase), payment processor (Lemon Squeezy), email delivery provider (Resend), and payout provider (Tremendous). These providers are contractually obligated to protect your information and may only use it to provide services to us.</li>
          <li style={{ marginBottom: '6px' }}><strong>Legal requirements:</strong> We may disclose your information if required to do so by law, court order, or valid governmental request, or to protect the rights, property, or safety of Mealio, our users, or the public.</li>
          <li style={{ marginBottom: '6px' }}><strong>Business transfers:</strong> If Mealio is involved in a merger, acquisition, or sale of assets, your information may be transferred as part of that transaction. We will notify you via email and/or a prominent notice on the Service before your information becomes subject to a different privacy policy.</li>
          <li style={{ marginBottom: '6px' }}><strong>With your consent:</strong> We may share your information for any other purpose with your explicit consent.</li>
        </ul>

        {/* 4 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>4. Data Retention</h2>
        <p>
          We retain your account information for as long as your account is active or as needed to provide the Service. Authentication log data (IP addresses, user agents) is retained for up to 90 days for security purposes. Meal and recipe data is retained until you delete it or close your account. If you close your account, we will delete or anonymize your personal information within 30 days, except where we are required to retain it for legal or financial compliance purposes.
        </p>

        {/* 5 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>5. Data Security</h2>
        <p>
          We implement industry-standard technical and organizational security measures to protect your information, including:
        </p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}>Passwords are hashed and never stored in plain text;</li>
          <li style={{ marginBottom: '6px' }}>Authentication tokens are signed with a secret key and expire automatically;</li>
          <li style={{ marginBottom: '6px' }}>Refresh tokens are stored as SHA-256 hashes in the database;</li>
          <li style={{ marginBottom: '6px' }}>Session cookies are HTTP-only and not accessible by JavaScript;</li>
          <li style={{ marginBottom: '6px' }}>All data in transit is encrypted using TLS/HTTPS;</li>
          <li style={{ marginBottom: '6px' }}>Database access is controlled via row-level security policies.</li>
        </ul>
        <p style={{ marginTop: '12px' }}>
          No method of electronic transmission or storage is 100% secure. While we strive to protect your information, we cannot guarantee absolute security.
        </p>

        {/* 6 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>6. Browser Extension Permissions</h2>
        <p>
          The Mealio browser extension requests certain permissions to function. Here is what each permission is used for:
        </p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Storage:</strong> To save your authentication tokens and meal data locally in Chrome's secure storage on your device.</li>
          <li style={{ marginBottom: '6px' }}><strong>Active Tab:</strong> To detect which grocery store website you are currently viewing so the extension can display relevant meals and initiate cart filling.</li>
          <li style={{ marginBottom: '6px' }}><strong>Tabs:</strong> To open the Mealio login page when you choose to sign in, and to communicate between the extension's side panel and the active grocery store tab.</li>
          <li style={{ marginBottom: '6px' }}><strong>Scripting / Content scripts:</strong> To interact with supported grocery store web pages for the sole purpose of automating cart additions on your behalf. Content scripts read product names and button elements on the page to locate items — this data is used only locally to complete the action you initiate and is never transmitted to our servers.</li>
          <li style={{ marginBottom: '6px' }}><strong>Side Panel:</strong> To display the Mealio meal manager in Chrome's built-in side panel alongside the grocery store website.</li>
        </ul>
        <p style={{ marginTop: '12px' }}>
          The extension does not monitor your general browsing history, track websites unrelated to the Service, read or store the contents of grocery pages beyond what is necessary to fill your cart, or transmit your grocery account credentials to our servers.
        </p>

        {/* 7 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>7. Your Rights and Choices</h2>
        <p>Depending on your location, you may have the following rights regarding your personal information:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li style={{ marginBottom: '6px' }}><strong>Access:</strong> Request a copy of the personal information we hold about you.</li>
          <li style={{ marginBottom: '6px' }}><strong>Correction:</strong> Request correction of inaccurate or incomplete information.</li>
          <li style={{ marginBottom: '6px' }}><strong>Deletion:</strong> Request deletion of your personal information, subject to our legal retention obligations.</li>
          <li style={{ marginBottom: '6px' }}><strong>Portability:</strong> Request your data in a machine-readable format.</li>
          <li style={{ marginBottom: '6px' }}><strong>Objection:</strong> Object to processing of your information in certain circumstances.</li>
        </ul>
        <p style={{ marginTop: '12px' }}>
          To exercise any of these rights, contact us at <a href="mailto:contact@mealio.co" style={{ color: '#dd0031' }}>contact@mealio.co</a>. We will respond within 30 days.
        </p>

        {/* 8 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>8. Children's Privacy</h2>
        <p>
          The Service is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected personal information from a child under 13, we will take steps to delete that information promptly. If you believe a child under 13 has provided us with personal information, please contact us at contact@mealio.co.
        </p>

        {/* 9 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>9. International Users</h2>
        <p>
          The Service is operated from the United States. If you access the Service from outside the United States, your information may be transferred to and processed in the United States, where data protection laws may differ from those in your country. By using the Service, you consent to this transfer. We take steps to ensure that any such transfers comply with applicable data protection requirements.
        </p>

        {/* 10 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>10. Cookies and Local Storage</h2>
        <p>
          We use HTTP-only cookies to maintain your authenticated session on the website. These cookies are strictly necessary for the Service to function and cannot be disabled without logging out. We do not use advertising cookies or third-party tracking cookies. The browser extension uses Chrome's <code style={{ background: '#f5f5f5', padding: '1px 5px', borderRadius: '3px' }}>chrome.storage.local</code> API to store your authentication tokens locally on your device.
        </p>

        {/* 11 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>11. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of material changes by posting the updated policy on this page with a new effective date and, where appropriate, by sending an email to the address associated with your account. We encourage you to review this policy periodically. Your continued use of the Service after any changes constitutes your acceptance of the revised policy.
        </p>

        {/* 12 */}
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#222', marginTop: '32px', marginBottom: '12px' }}>12. Contact Us</h2>
        <p>
          If you have questions, concerns, or requests relating to this Privacy Policy, please contact us at:
        </p>
        <p style={{ marginTop: '8px' }}>
          <strong>Mealio</strong><br />
          <a href="mailto:contact@mealio.co" style={{ color: '#dd0031' }}>contact@mealio.co</a>
        </p>

      </div>
      <AppFooter />
    </div>
  );
}
