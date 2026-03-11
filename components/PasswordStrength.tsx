'use client';

interface Rule {
  label: string;
  test: (p: string) => boolean;
}

const RULES: Rule[] = [
  { label: 'At least 8 characters',          test: p => p.length >= 8 },
  { label: 'At least one uppercase letter',  test: p => /[A-Z]/.test(p) },
  { label: 'At least one lowercase letter',  test: p => /[a-z]/.test(p) },
  { label: 'At least one number',            test: p => /[0-9]/.test(p) },
];

export default function PasswordStrength({ password }: { password: string }) {
  if (!password) return null;
  return (
    <div className="mt-2 space-y-1">
      {RULES.map(rule => {
        const ok = rule.test(password);
        return (
          <div key={rule.label} className="flex items-center gap-1.5">
            <svg
              width="13" height="13" viewBox="0 0 14 14" fill="none"
              style={{ flexShrink: 0, color: ok ? 'var(--success, #16a34a)' : 'var(--text-3)' }}
            >
              {ok ? (
                <circle cx="7" cy="7" r="6.5" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1">
                  <animate attributeName="opacity" from="0" to="0.15" dur="0.2s" fill="freeze" />
                </circle>
              ) : (
                <circle cx="7" cy="7" r="6.5" stroke="currentColor" strokeWidth="1" />
              )}
              {ok && (
                <path d="M4.5 7l1.8 1.8 3.2-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
            <span className="text-xs" style={{ color: ok ? 'var(--success, #16a34a)' : 'var(--text-3)' }}>
              {rule.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
