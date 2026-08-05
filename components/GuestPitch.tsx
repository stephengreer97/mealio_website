import Link from 'next/link';
import {
  PITCH_HEADLINE,
  PITCH_SUBHEAD,
  PITCH_STEPS,
  PITCH_NOTHING_ORDERED,
  PITCH_FREE_TIER,
} from '@/lib/pitch';

/**
 * What Mealio does, shown above the Discover grid to signed-out visitors only
 * (MEAL-86).
 *
 * Deliberately not a gate and not a modal. Guests can already browse every
 * meal on the page and that stays true — this band explains the product on the
 * way past it, so the first time a visitor meets the cart is here rather than
 * on the signup wall they hit by tapping a meal.
 *
 * Signed-in users never render it. They converted; the three steps are noise
 * between them and their meals, and Discover is a page they use weekly.
 *
 * The sign-up link is the quieter of the two calls to action, and the louder
 * one is "browse below" doing nothing at all. Someone who has been told what
 * the app does and is looking at recipes is one tap from the signup wall
 * already; asking twice on the same screen reads as a demand, not an offer.
 */
export default function GuestPitch() {
  return (
    <section
      aria-labelledby="guest-pitch-heading"
      className="rounded-2xl px-4 py-4 sm:px-7 sm:py-6 mb-6"
      style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)' }}
    >
      <h1
        id="guest-pitch-heading"
        className="text-2xl sm:text-3xl font-bold leading-tight"
        style={{ color: 'var(--text-1)', letterSpacing: '-0.02em' }}
      >
        {PITCH_HEADLINE}
      </h1>

      <p className="text-sm sm:text-base mt-2 max-w-[62ch] leading-relaxed" style={{ color: 'var(--text-2)' }}>
        {PITCH_SUBHEAD}
      </p>

      <ol className="grid gap-2 sm:gap-3 sm:grid-cols-3 mt-4 sm:mt-5 mb-0 p-0 list-none">
        {PITCH_STEPS.map((step, i) => (
          <li
            key={step.title}
            className="rounded-xl px-3 py-2.5 sm:px-4 sm:py-3"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold"
                style={{ background: 'var(--brand)', color: '#fff' }}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                {step.title}
              </span>
            </div>
            <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {step.body}
            </p>
          </li>
        ))}
      </ol>

      <p className="text-xs mt-3 sm:mt-4 max-w-[62ch] leading-relaxed" style={{ color: 'var(--text-2)' }}>
        {PITCH_NOTHING_ORDERED}
      </p>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-2 sm:mt-3">
        <Link
          href="/signin?tab=signup"
          className="text-xs font-semibold hover:underline"
          style={{ color: 'var(--brand)' }}
        >
          Create a free account &rarr;
        </Link>
        <span className="text-xs" style={{ color: 'var(--text-3)' }}>{PITCH_FREE_TIER}</span>
      </div>
    </section>
  );
}
