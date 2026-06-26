'use client';

import { useState } from 'react';

/**
 * Web bug-report form (Help page). Posts to /api/bug-report → contact@mealio.co.
 * The website has no cart-automation logs, so it sends the description + light
 * browser context (no PII).
 */
export default function BugReportForm() {
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (description.trim().length < 5) {
      setError('Please describe what went wrong.');
      return;
    }
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          source: 'web',
          context: {
            url: typeof window !== 'undefined' ? window.location.href : null,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
            viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : null,
          },
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to send');
      setStatus('sent');
      setDescription('');
    } catch (err: any) {
      setStatus('error');
      setError(err?.message || 'Could not send. Please try again.');
    }
  }

  if (status === 'sent') {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: 20, color: '#15803d', fontSize: 14 }}>
        Thanks! Your report was sent. We appreciate you helping us improve Mealio.
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe the problem — what you were doing and what happened."
        rows={5}
        disabled={status === 'sending'}
        style={{
          width: '100%', boxSizing: 'border-box', padding: 14, fontSize: 15, fontFamily: 'inherit',
          border: '1px solid #ddd', borderRadius: 10, resize: 'vertical', color: '#222',
        }}
      />
      {error ? <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div> : null}
      <button
        type="submit"
        disabled={status === 'sending'}
        style={{
          alignSelf: 'flex-start', background: '#dd0031', color: '#fff', border: 'none',
          padding: '11px 22px', borderRadius: 8, fontSize: 15, fontWeight: 600,
          cursor: status === 'sending' ? 'default' : 'pointer', opacity: status === 'sending' ? 0.6 : 1,
        }}
      >
        {status === 'sending' ? 'Sending…' : 'Send report'}
      </button>
    </form>
  );
}
