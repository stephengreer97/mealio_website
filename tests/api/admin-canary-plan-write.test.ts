/**
 * The canary plan PUT writes only what it was sent.
 *
 * Stephen removed the out-of-stock and no-match text boxes from the panel:
 * those lines are ingredients of the canary meal, and a second place to describe
 * a meal's contents meant the two could disagree, with the panel winning
 * silently.
 *
 * That removal carries a trap. The handler used to write every column on every
 * save -- harmless while the panel has a field for each one, and fatal the
 * moment it does not. With only `enabled` on the wire, a plain ON/OFF toggle
 * would post no mealName and reset every plan's meal to the literal 'Canary'.
 * The runner selects meals BY NAME, so every store would then be looking for a
 * meal that does not exist, and it would present as the canary quietly finding
 * nothing rather than as a bad write.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app', 'api', 'admin', 'canary', 'route.ts'), 'utf8');

describe('PUT /api/admin/canary', () => {
  it('does not default meal_name on a save that omits it', () => {
    expect(src).not.toContain("meal_name: text(body?.mealName) ?? 'Canary'");
    expect(src).toContain('text(body?.mealName) ? { meal_name:');
  });

  it('leaves enabled alone when it was not sent', () => {
    expect(src).toContain('body?.enabled === undefined ? {}');
  });

  it('no longer writes the item columns at all', () => {
    expect(src).not.toContain('out_of_stock_item:');
    expect(src).not.toContain('unmatched_item:');
  });
});
