'use client';

import { useEffect, useId, useState } from 'react';
import type { FieldConfidence } from '@/lib/import/types';
import { MARKER_COLORS, markerLabel, NO_EVIDENCE_COPY } from '@/lib/import/draft-form';

/**
 * The per-field confidence marker on an imported draft (MEAL-73).
 *
 * A colour on its own is decoration. What makes this actionable is the panel
 * behind it: the evidence span MEAL-72 verified, quoted back as "we got this
 * from …", so a creator can decide in one glance whether to trust the value or
 * retype it.
 *
 * Three deliberate choices:
 *
 *  - **Never brand red.** Per The Two Reds Rule a bad-confidence marker uses
 *    the semantic error red (#DC2626), never #DD0031, which means *act*. And
 *    per The One Tap Rule the markers stay quiet — tinted fills and small text,
 *    no filled buttons — so Publish remains the only accent on the screen.
 *  - **The word carries the meaning, the colour reinforces it.** Amber and red
 *    are the hardest pair to tell apart with a red-green deficiency, so every
 *    marker is labelled.
 *  - **The panel is anchored to the field, not floated.** It spans the field's
 *    width, so it can never be clipped by the modal's scroll container and
 *    never lands off-screen on a phone. The parent must be `position: relative`.
 */

export interface ConfidenceMarkerProps {
  field: FieldConfidence;
  /** Field name, spoken to screen readers: "Serves: Adjusted…". */
  fieldLabel: string;
  /** `pill` carries the word; `dot` is for dense ingredient rows where it wouldn't fit. */
  variant?: 'pill' | 'dot';
  /** Extra sentence from the form, e.g. that Serves was shortened to fit. */
  note?: string | null;
}

export default function ConfidenceMarker({
  field,
  fieldLabel,
  variant = 'pill',
  note,
}: ConfidenceMarkerProps) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const panelId = useId();
  const open = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  const colors = MARKER_COLORS[field.level];
  const label = markerLabel(field);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${fieldLabel}: ${label}. Show where this came from.`}
        title={`${label} — ${field.reason}`}
        onClick={() => setPinned(p => !p)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-full cursor-pointer transition-colors"
        style={{
          background: colors.fill,
          color: colors.ink,
          border: `1px solid ${colors.fill}`,
          padding: variant === 'dot' ? '4px' : '2px 8px',
          fontSize: '11px',
          fontWeight: 500,
          lineHeight: 1.4,
          letterSpacing: '0.01em',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: colors.dot, display: 'block', flexShrink: 0,
          }}
        />
        {variant === 'pill' && <span>{label}</span>}
      </button>

      {open && (
        <div
          id={panelId}
          role="note"
          className="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-xl p-3"
          style={{
            background: '#FFFFFF',
            // A panel that overlays the fields beneath it is the one thing
            // DESIGN.md permits a shadow for. Border *or* shadow, never both.
            boxShadow: '0 6px 20px rgba(24,24,27,0.14)',
          }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: colors.ink }}>
            {label}
          </p>
          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#52525B' }}>
            {field.reason}
          </p>

          {field.evidence ? (
            <>
              <p className="text-[11px] mt-2.5" style={{ color: '#A1A1AA' }}>We got this from:</p>
              <blockquote
                className="mt-1 rounded-lg px-2.5 py-2 text-xs leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap"
                style={{ background: '#F4F3F1', color: '#18181B', margin: 0 }}
              >
                {field.evidence}
              </blockquote>
            </>
          ) : (
            <p className="text-xs mt-2.5 leading-relaxed" style={{ color: '#52525B' }}>
              {NO_EVIDENCE_COPY}
            </p>
          )}

          {note && (
            <p className="text-[11px] mt-2.5 leading-relaxed" style={{ color: '#A1A1AA' }}>{note}</p>
          )}

          <p className="text-[11px] mt-2.5 leading-relaxed" style={{ color: '#A1A1AA' }}>
            Edit the field and this marker clears — the value becomes yours.
          </p>
        </div>
      )}
    </>
  );
}
