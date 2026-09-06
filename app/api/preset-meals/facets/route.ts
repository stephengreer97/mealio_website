import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { getCachedAllPresetMeals } from '@/lib/trending-cache';
import { buildFacets } from '@/lib/preset-meal-facets';

// GET /api/preset-meals/facets — what the Discover filter panel can offer.
//
// Every tag in use and every author name, across the whole catalogue. The
// clients used to derive both from the meals they had already loaded, so an
// author on page 4 was never suggested and a custom tag nobody had scrolled to
// was missing from the tag list. Same defect as the filters themselves, quieter
// because typing the name by hand still worked.
//
// Public, like the Trending and New feeds it describes. It exposes creator
// display names and tags, both of which are already on every meal card.
//
// Reads the same 10-minute cached catalogue the feeds read, so this costs a
// pass over an array that is already in memory rather than a query.

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const meals = await getCachedAllPresetMeals();
    return NextResponse.json(buildFacets(meals));
  } catch (error) {
    log({ event: 'MEAL:GET', status: 'error', error });
    // An empty answer rather than a 500. A filter panel with no suggestions is
    // a degraded panel; a panel that fails to load is a broken screen, and the
    // filters underneath it work perfectly well without the autocomplete.
    return NextResponse.json({ tags: [], authors: [] });
  }
}
