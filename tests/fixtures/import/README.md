# Import pipeline fixtures

## `html/`

Recorded pages, captured with `curl` on 2026-08-01 and committed **byte for byte**.
They are large because real recipe blogs are large — that is the point. A hand-written
"looks like a blog post" fixture would not exercise the ad wrappers, lazy-loaded
`<noscript>` images, inline JSON blobs and 400-comment threads that the text cleaner
and the JSON-LD finder actually have to survive.

| File | Source | Why it's here |
| --- | --- | --- |
| `cookieandkate-guacamole.html` | `https://cookieandkate.com/best-guacamole-recipe/` | JSON-LD `Recipe` inside `@graph`, 7 ingredients, `recipeYield` as an array |
| `minimalistbaker-black-bean-soup.html` | `https://minimalistbaker.com/easy-1-pot-black-bean-soup/` | JSON-LD `Recipe`, 17 ingredients, `recipeInstructions` as `HowToStep` objects |
| `cookieandkate-about.html` | `https://cookieandkate.com/about/` | A food blog page that is **not** a recipe — the gate's job |
| `synthetic-no-jsonld-recipe.html` | hand-written | The raw-HTML path. Every real page we could capture carried JSON-LD, so this one is synthetic and labelled as such. |

To re-capture:

```sh
curl -sSL -A 'Mozilla/5.0' -o tests/fixtures/import/html/<name>.html '<url>'
```

Pages change. If a fixture stops parsing after a re-capture that is a finding about the
real web, not a broken test — check whether the site dropped its JSON-LD before editing
the parser.

## `eval/`

The extraction eval set (MEAL-71). One JSON file per source:

```jsonc
{
  "url": "…",
  "note": "what makes this case interesting",
  "source": { "title": "…", "text": "…", "jsonLd": { … } },   // the SourceDocument the model sees
  "expected": {
    "name": "…",
    "serves": "…",
    "ingredients": [ { "ingredientName": "…", "qty": 1, "unit": "qty", "measure": null } ]
  }
}
```

`source` for the `derived-from-fixture` items is produced by running `toSourceDocument`
over the recorded HTML above (see `scripts/build-eval-source.mjs`), so the eval runs
against exactly what production would send. The rest are hand-written to cover shapes we
have not captured — video metadata, a recipe with no amounts, a partial JSON-LD object.

`expected` is hand-written. It is the contract the model is graded against, not something
generated from a model run — generating it from output would make the eval agree with
whatever it measures.

Run it with `node scripts/eval-extraction.mjs` (**requires `ANTHROPIC_API_KEY`**).
`npm test` never touches it.
