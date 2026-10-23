/**
 * Limits on pasted recipe text, shared by the import route and the form that
 * counts characters as the user types. Separate from `pipeline.ts`, which the
 * browser must never bundle.
 */

/** Pasted characters accepted. About 5K tokens, under a cent to read. */
export const PASTED_TEXT_MAX = 20_000;
/** Below this there is no recipe to read, and the gate would only say so at a price. */
export const PASTED_TEXT_MIN = 40;
