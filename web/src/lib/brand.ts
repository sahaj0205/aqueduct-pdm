/**
 * The product's name, in one place.
 *
 * WHY IT IS A CONSTANT AND NOT A STRING IN THREE COMPONENTS. The first name this build
 * carried turned out to belong to somebody else's product, and it was written into the
 * masthead, the front door's wordmark, a sentence of body copy and four browser storage
 * keys. Finding all eight was a grep rather than a rename. It will not be a grep again.
 *
 * WHY AUGUR. An augur read signs to say what was coming — the word survives in English
 * as the verb for exactly that. It is a real word rather than a vowel-dropped invention,
 * it is short enough to sit in a masthead, and it names the thing this system does rather
 * than the industry it does it in.
 *
 * The storage keys are namespaced from the same constant, so renaming the product also
 * resets anybody mid-session rather than leaving them with a stale flag under a name that
 * no longer exists.
 */

export const BRAND = {
  name: "Augur",
  /** Shown beside the wordmark on the front door. Kept under six words. */
  tagline: "Predictive maintenance for building plant",
} as const;

/** Namespaced browser storage, so keys and product name can never drift apart. */
export const storageKey = (suffix: string): string =>
  `${BRAND.name.toLowerCase()}.${suffix}`;
