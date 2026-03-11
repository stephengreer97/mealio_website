'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';

export default function CreatorApply() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [findUs, setFindUs] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  useEffect(() => {
    verifyAuth();
  }, []);

  const verifyAuth = async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      if (!accessToken) { router.push('/'); return; }

      const res = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { localStorage.clear(); router.push('/'); return; }

      const data = await res.json();
      setUserEmail(data.user.email);

      const meRes = await fetch('/api/creator/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.creator) { router.push('/creator'); return; }
        if (meData.application) { setSubmitted(true); }
      }

      setLoading(false);
    } catch {
      router.push('/');
    }
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPhoto(true);
    setError('');
    const reader = new FileReader();
    reader.onload = async ev => {
      const imageData = ev.target?.result as string;
      setPhotoPreview(imageData);
      try {
        const token = localStorage.getItem('accessToken');
        const res = await fetch('/api/images/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ imageData }),
        });
        const data = await res.json();
        if (res.ok) setPhotoUrl(data.url);
        else setError(data.error || 'Photo upload failed.');
      } catch {
        setError('Photo upload failed.');
      } finally {
        setUploadingPhoto(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) { setError('Display name is required.'); return; }
    if (!photoUrl) { setError('A profile photo is required.'); return; }
    if (!findUs.trim()) { setError('Please tell us where we can find you online.'); return; }
    if (!agreedToTerms) { setError('You must agree to the Terms and Conditions to apply.'); return; }
    setError('');
    setSubmitting(true);

    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/creator/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ displayName, phone, findUs, photoUrl: photoUrl || null }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      setSubmitted(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <AppHeader />

      <div style={{ maxWidth: '600px', margin: '32px auto', padding: '0 20px' }}>
        <h1 style={{ margin: '0 0 24px', fontSize: '22px', fontWeight: 700, color: '#111' }}>Become a Creator Partner</h1>
        {submitted ? (
          <div style={{ background: 'white', borderRadius: '12px', padding: '40px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎉</div>
            <h2 style={{ margin: '0 0 12px', color: '#222' }}>Application Submitted!</h2>
            <p style={{ color: '#666', margin: '0 0 24px', lineHeight: 1.6 }}>
              Thanks for applying! We'll review your application and reach out with next steps.
            </p>
            <button onClick={() => router.push('/discover')} style={{ background: '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '12px 24px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
              Back to Dashboard
            </button>
          </div>
        ) : (
          <>
            <div style={{ background: 'white', borderRadius: '12px', padding: '28px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' }}>
              <h2 style={{ margin: '0 0 8px', fontSize: '18px', color: '#222' }}>Share your recipes with the world</h2>
              <p style={{ margin: 0, color: '#666', lineHeight: 1.6, fontSize: '14px' }}>
                As a Mealio creator partner, your meals appear in the Discover tab for all users. Popular meals earn a share of quarterly subscription profit — the more people add your meals, the more you earn.
              </p>
            </div>

            <div style={{ background: 'white', borderRadius: '12px', padding: '28px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <form onSubmit={handleSubmit}>
                {/* Photo upload */}
                <div style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', alignSelf: 'flex-start' }}>
                    Profile Photo <span style={{ color: '#dd0031' }}>*</span>
                  </label>
                  <label htmlFor="photoInput" style={{ cursor: 'pointer', position: 'relative', display: 'inline-block' }}>
                    <div style={{
                      width: '88px', height: '88px', borderRadius: '50%', overflow: 'hidden',
                      border: '2px dashed #ddd', background: '#fafafa',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '28px', flexShrink: 0,
                    }}>
                      {photoPreview ? (
                        <img src={photoPreview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span>📷</span>
                      )}
                    </div>
                    {uploadingPhoto && (
                      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: '20px', height: '20px', border: '2px solid #ddd', borderTopColor: '#dd0031', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                      </div>
                    )}
                  </label>
                  <input id="photoInput" type="file" accept="image/*" onChange={handlePhotoChange} style={{ display: 'none' }} />
                  <p style={{ margin: 0, fontSize: '12px', color: '#999' }}>
                    {photoPreview ? (uploadingPhoto ? 'Uploading…' : 'Click photo to change') : 'Click to upload'}
                  </p>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px' }}>Account</label>
                  <input value={userEmail} disabled style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: '8px', fontSize: '14px', color: '#888', background: '#fafafa', boxSizing: 'border-box' }} />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px' }}>
                    Display Name <span style={{ color: '#dd0031' }}>*</span>
                  </label>
                  <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Chef Sarah" style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }} />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px' }}>
                    How can we find you? <span style={{ color: '#dd0031' }}>*</span>
                  </label>
                  <input value={findUs} onChange={e => setFindUs(e.target.value)} placeholder="e.g. instagram.com/chefsarah, chefsarah.com" style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }} />
                </div>

                <div style={{ marginBottom: '24px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px' }}>
                    Phone Number <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. (555) 123-4567" style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }} />
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#999' }}>
                    We'll only use this to confirm your identity during the review process.
                  </p>
                </div>

                {/* Terms agreement */}
                <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                  <input
                    type="checkbox"
                    id="agreeTerms"
                    checked={agreedToTerms}
                    onChange={e => setAgreedToTerms(e.target.checked)}
                    style={{ marginTop: '2px', width: '16px', height: '16px', accentColor: '#dd0031', flexShrink: 0, cursor: 'pointer' }}
                  />
                  <label htmlFor="agreeTerms" style={{ fontSize: '13px', color: '#444', lineHeight: 1.5, cursor: 'pointer' }}>
                    I have read and agree to the Mealio{' '}
                    <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#dd0031', textDecoration: 'underline' }}>
                      Terms and Conditions
                    </a>
                    , including the Creator Partner Program terms and the exclusivity obligation in Section 4.3.
                  </label>
                </div>

                {error && (
                  <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '14px', color: '#c40029' }}>
                    {error}
                  </div>
                )}

                <button type="submit" disabled={submitting || !agreedToTerms} style={{ width: '100%', background: submitting || !agreedToTerms ? '#aaa' : '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '14px', fontSize: '15px', fontWeight: 600, cursor: submitting || !agreedToTerms ? 'not-allowed' : 'pointer' }}>
                  {submitting ? 'Submitting…' : 'Submit Application'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
      <AppFooter />
    </div>
  );
}
