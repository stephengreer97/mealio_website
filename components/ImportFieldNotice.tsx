'use client';

import { useState } from 'react';
import type { FieldNotice, NoticeKind } from '@/lib/import/draft-form';

/**
 * The line under a flagged field on an imported draft (MEAL-73).
 *
 * Only exceptions are flagged. A field the pipeline verified against the source
 * renders nothing at all — silence is the signal, and the summary line above
 * the form is what tells a creator that silence means *checked*, not *skipped*.
 *
 * Carries no colour. The label, the sentence and the dotted underline on the
 * field do the work, so this adds nothing to DESIGN.md's palette and reads the
 * same to a creator who cannot separate amber from red.
 *
 * ## Two changes the owner's review of the draft card forced
 *
 * **1. The notice names its own field.** `fieldLabel` was screen-reader-only.
 * On a card with three empty fields that produced three identical sentences —
 * "Not found in the source — add this", "Not found in the source — add this",
 * "Not found in the source — add this" — three different missing things and
 * nothing on screen saying which was which. Sighted readers were being asked to
 * infer the field from vertical position, which is exactly the job a label does.
 *
 * **2. The quoted span is one tap away rather than always open.** This reverses
 * a deliberate earlier decision, so it is worth writing down why rather than
 * letting the next reader think it was forgotten. The original rule was "the
 * evidence is here, in plain text, rather than behind a marker you have to tap",
 * and for a form with two flagged fields it was right: no symbol to learn,
 * nothing to hover.
 *
 * What it did not survive is the draft *card*, where the notices sit under a
 * whole recipe. A twenty-ingredient import flags most of its rows, and every one
 * of them printed the span we read at nearly the weight of the value itself.
 * That roughly doubles the text on the card and inverts what the screen is for:
 * the creator is there to read the recipe and decide whether it is theirs, and
 * the recipe was drowning in our working. Evidence is what you want when you
 * doubt a particular value, not on twenty rows at once.
 *
 * So the *reason* is still plain text and still un-tappable — a creator can see
 * at a glance which fields are flagged and why, which is the whole feature. Only
 * the quotation is behind the toggle, and the toggle says what it holds.
 */

/**
 * Dotted underline for a flagged input. 1px — DESIGN.md has no 2px border and
 * should not gain one.
 *
 * Ink Muted rather than Hairline Strong, which is the token this would
 * otherwise reach for. Hairline Strong (`#D1CEC8`) is 1.57:1 against Card
 * White, and WCAG 1.4.11 wants 3:1 for a boundary that carries meaning — at
 * 1.57:1 a flagged input and a plain one are the same input. Ink Muted is
 * 7.4:1, and it is the colour of the sentence directly beneath, which is the
 * thing the underline is pointing at.
 */
export const FLAGGED_FIELD_STYLE: React.CSSProperties = {
  borderBottomStyle: 'dotted',
  borderBottomColor: '#52525B',
};

/**
 * What a notice says when it has no sentence of its own.
 *
 * Only `adjusted` reaches this. `noticeFor` leaves its text empty on purpose —
 * "with a span, the quote is the whole message" — which was true while the span
 * was always on screen and leaves an empty notice now that it is not. The other
 * three kinds always carry their own wording, including the pipeline's `reason`,
 * and none of them is second-guessed here.
 */
const FALLBACK_TEXT: Record<NoticeKind, string> = {
  adjusted: 'Adjusted from what the page said.',
  unverified: 'We could not confirm this against the source. Check it.',
  absent: 'Not found in the source. Add this.',
  generated: 'We chose this rather than reading it.',
};

const toggleStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: '#52525B',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  cursor: 'pointer',
};

export default function ImportFieldNotice({
  notice,
  fieldLabel,
  id,
}: {
  notice: FieldNotice | null;
  /**
   * Names the field. Rendered, not merely announced: see the note above — three
   * unlabelled copies of the same sentence is three sentences and no
   * information.
   */
  fieldLabel: string;
  /**
   * Wired to the field's `aria-describedby`. Without it the notice is static
   * text a forms-mode screen reader tabs straight past, and the callout is the
   * entire value of the feature.
   */
  id?: string;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  if (!notice) return null;

  const text = notice.text || FALLBACK_TEXT[notice.kind];

  return (
    <p
      id={id}
      className="text-xs mt-1 leading-relaxed"
      style={{ color: '#52525B' }}
      data-testid="import-notice"
      data-kind={notice.kind}
    >
      <span style={{ fontWeight: 700 }}>{fieldLabel}</span>
      {': '}
      {text}
      {notice.evidence && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => setShowEvidence(open => !open)}
            aria-expanded={showEvidence}
            style={toggleStyle}
            data-testid="evidence-toggle"
          >
            {showEvidence ? 'Hide what we read' : 'See what we read'}
          </button>
          {showEvidence && (
            <span style={{ display: 'block', marginTop: '2px' }} data-testid="evidence">
              We read: <span style={{ color: '#18181B' }}>&ldquo;{notice.evidence}&rdquo;</span>
            </span>
          )}
        </>
      )}
    </p>
  );
}
