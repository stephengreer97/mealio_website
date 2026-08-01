import type { FieldNotice } from '@/lib/import/draft-form';

/**
 * The line under a flagged field on an imported draft (MEAL-73).
 *
 * Only exceptions are flagged. A field the pipeline verified against the source
 * renders nothing at all — silence is the signal, and the summary line above
 * the form is what tells a creator that silence means *checked*, not *skipped*.
 *
 * The evidence is here, in plain text, rather than behind a marker you have to
 * tap. A creator can read "we read: “juice of 1 lime”" and decide in a glance
 * whether 2 tbsp is right; no symbol to learn, nothing to hover, and nothing
 * that behaves differently on a phone.
 *
 * Carries no colour. The dotted underline on the field and the sentence itself
 * do the work, so this adds nothing to DESIGN.md's palette and reads the same
 * to a creator who cannot separate amber from red.
 */

/** Dotted underline for a flagged input. Hairline Strong, 1px — DESIGN.md has no 2px border and should not gain one. */
export const FLAGGED_FIELD_STYLE: React.CSSProperties = {
  borderBottomStyle: 'dotted',
  borderBottomColor: '#D1CEC8',
};

export default function ImportFieldNotice({
  notice,
  fieldLabel,
}: {
  notice: FieldNotice | null;
  /** Names the field for screen readers, which do not get the visual adjacency. */
  fieldLabel: string;
}) {
  if (!notice) return null;

  return (
    <p
      className="text-xs mt-1 leading-relaxed"
      style={{ color: '#52525B' }}
      data-testid="import-notice"
      data-kind={notice.kind}
    >
      <span className="sr-only">{fieldLabel}: </span>
      {notice.text}
      {notice.text && notice.evidence ? ' ' : null}
      {notice.evidence && (
        <>
          {/* Sentence case only when it follows one — "…check it. we read:" reads as a typo. */}
          {notice.text ? 'We read: ' : 'we read: '}
          <span style={{ color: '#18181B' }}>&ldquo;{notice.evidence}&rdquo;</span>
        </>
      )}
    </p>
  );
}
