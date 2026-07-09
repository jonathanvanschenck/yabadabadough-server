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
 * There is NO auto-assignment: a fund with no chosen color stores null, and the
 * webapp renders it with the neutral `--fund-default*` fallback in styles.css
 * (resolved via fundColorVar(null)). Color is an explicit, opt-in signal — which
 * also sidesteps the palette's CVD ceiling (the -dot swatches are iso-lightness/
 * iso-chroma, so more than a handful are not separable for red-green viewers;
 * many-fund views must carry direct labels regardless of color).
 */
