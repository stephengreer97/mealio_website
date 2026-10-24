/**
 * The stores a meal can be saved for, with their display names.
 *
 * The same 34 ids as `STORES` in mealio_app's `src/constants/stores.ts`; the two
 * repos share no package, so keep them identical. The server checks a default
 * store against this list, so a store missing here cannot be chosen at all.
 */
export const STORE_LABELS: Record<string, string> = {
  heb:           'H-E-B',
  walmart:       'Walmart',
  kroger:        'Kroger',
  aldi:          'ALDI',
  albertsons:    'Albertsons',
  safeway:       'Safeway',
  vons:          'Vons',
  jewel_osco:    'Jewel-Osco',
  shaws:         "Shaw's",
  acme:          'Acme Markets',
  tom_thumb:     'Tom Thumb',
  randalls:      'Randalls',
  pavilions:     'Pavilions',
  star_market:   'Star Market',
  haggen:        'Haggen',
  carrs:         'Carrs',
  kings:         'Kings Food Markets',
  balduccis:     "Balducci's",
  ralphs:        'Ralphs',
  fred_meyer:    'Fred Meyer',
  king_soopers:  'King Soopers',
  smiths:        "Smith's Food & Drug",
  frys:          "Fry's Food",
  qfc:           'QFC',
  city_market:   'City Market',
  dillons:       'Dillons',
  bakers:        "Baker's",
  marianos:      "Mariano's",
  pick_n_save:   "Pick 'n Save",
  metro_market:  'Metro Market',
  pay_less:      'Pay-Less',
  harris_teeter: 'Harris Teeter',
  united:        'United Supermarkets',
  wegmans:       'Wegmans',
};

export function isSupportedStore(storeId: unknown): storeId is string {
  return typeof storeId === 'string' && Object.prototype.hasOwnProperty.call(STORE_LABELS, storeId);
}
