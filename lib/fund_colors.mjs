/**
 * The fund color registry: the single source of truth for the color SLUGS a
 * fund may carry. Funds store the slug (never a hex value) so the rendered
 * palette can be retuned without touching stored data: the webapp maps each
 * slug to its `--fund-<slug>` CSS custom property in public/styles.css,
 * which owns the actual hex values.
 *
 * This file is ESM (.mjs) because it is SHARED with the webapp, exactly like
 * query_keys.mjs: the CJS server require()s it (Node >= 22.12 supports
 * require(esm)) and the webapp imports it (via the src/hooks/fundColors.js
 * shim), so the slugs the API accepts and the swatches the picker offers can
 * never drift. Keep it runtime-agnostic: no node builtins, no requires of
 * server code.
 *
 * The list is 10 hues evenly spaced around the OKLCH wheel. Each slug carries
 * FOUR tone-matched CSS variables in styles.css (main row bg / -muted alt row /
 * -text label / -dot mark); the webapp picks one via fundColorVar(slug, variant).
 * Adding or renaming a slug means updating THREE places in one commit: this
 * list, the `--fund-<slug>*` variables in webapp/public/styles.css, and the
 * CHECK constraint on funds.color in db/migrations/_schema.sql (schema edits
 * are in-place; there are no migrations).
 */
export const FUND_COLORS = Object.freeze([
    "ember", "amber", "citron", "fern", "teal",
    "sky", "indigo", "purple", "magenta", "rose",
]);

/**
 * The auto-assignment cycle: all 10 slugs ordered for maximal hue separation
 * between consecutive picks (every adjacency > 150° around the wheel), so a
 * handful of sibling funds get visibly distinct colors. When the webapp
 * assigns a default color to a fund, it walks this order.
 *
 * NOTE: this is a hue-spread order, NOT re-run through CVD/contrast simulation
 * against the Warm Stone surfaces — that validation is a tracked follow-up
 * (see styles.css). Charts drawing many funds must carry direct labels.
 */
export const FUND_COLOR_ASSIGNMENT_ORDER = Object.freeze([
    "rose", "teal", "ember", "sky", "amber",
    "indigo", "citron", "purple", "fern", "magenta",
]);
