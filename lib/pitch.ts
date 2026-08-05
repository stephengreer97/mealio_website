/**
 * The one sentence Mealio has to land, and the words it lands in (MEAL-86).
 *
 * `/` is a `permanentRedirect` to `/discover`, so Discover is the front door
 * for everyone who is not signed in. Before this existed, that door showed a
 * signed-out visitor a wall of recipe photos and never once said that Mealio
 * puts a meal's ingredients into their grocery cart — the only claim that
 * separates it from every other recipe site. The pitch was sitting on
 * `/signin` and `/about`, behind the conversion it was supposed to cause.
 *
 * These strings live here rather than in the component that renders them
 * because the same gap exists in the React Native app (MEAL-84: a new user
 * reaches "Choose Products" with nothing explaining what it is). Two surfaces
 * describing the same product in two different sets of words is how a product
 * stops having one story. This module is the story; a surface picks the pieces
 * it has room for and does not reword them.
 *
 * The register is the one `/about` and the creator emails already use: say the
 * concrete thing that happens, name the limits in the same breath. "Every
 * ingredient goes into your cart" is a promise a visitor can check five
 * minutes later. "Effortless meal planning" is not.
 */

/** The headline, identical to the `/about` h1 and the OpenGraph title. */
export const PITCH_HEADLINE = "Shop meals. We'll fill the cart.";

/**
 * One sentence under the headline, carrying the whole claim on its own — a
 * visitor who reads this and nothing else has been told what Mealio does. Kept
 * to a single sentence because on a phone this sits above the recipes, and
 * every line here is a line of the grid pushed off the screen.
 */
export const PITCH_SUBHEAD =
  'Mealio is a recipe app that does the shopping part: pick a meal and the store '
  + 'you shop at, and every ingredient goes into your online cart there.';

/**
 * The stores whose carts Mealio can actually fill. Kept here because `/about`
 * and the Discover pitch both name them, and a store list that is true in one
 * place and stale in the other is worse than no list.
 */
export const PITCH_STORES =
  'H-E-B, Walmart, Kroger and its banners, Albertsons, Safeway, ALDI, Amazon '
  + 'Fresh and Wegmans';

/**
 * The mechanism in three steps. Ordered; a surface with room for one shows the
 * last, because the cart is the part nobody guesses from a grid of photos.
 */
export const PITCH_STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Find a meal you want to cook',
    body: 'Browse recipes from cooks and creators. No account needed to look.',
  },
  {
    title: 'Pick the store you shop at',
    body: `Mealio works with ${PITCH_STORES}.`,
  },
  {
    title: 'Mealio fills your cart',
    body: 'Every ingredient is added to your cart at that store.',
  },
];

/**
 * The limit, stated wherever the promise is. People assume "fills your cart"
 * means "spends your money", and a visitor who suspects that and is not told
 * otherwise leaves instead of asking.
 */
export const PITCH_NOTHING_ORDERED =
  'Nothing is ordered — the items land in your own cart at your own store, and '
  + 'you check out there.';

/** What it costs, in the same words as `/about` and `/pricing`. */
export const PITCH_FREE_TIER = 'Free for up to three saved meals.';
