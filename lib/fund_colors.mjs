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
 * The auto-assignment cycle. Order derived by farthest-first greedy selection
 * under a Machado-2009 dichromat simulation (protanopia + deuteranopia, the
 * ~8%-of-men red-green deficiencies): each next slug maximizes its minimum
 * perceptual distance (OKLab ΔE) to all already-picked slugs, so the FIRST few
 * auto-assigned funds are as distinguishable as this palette allows.
 *
 * HARD LIMIT (by design of the palette, not this order): every -dot swatch is
 * iso-lightness/iso-chroma (L0.80 C0.13), differing ONLY in hue — and red-green
 * CVD collapses the hue axis. So distinctness holds for ~4 funds (worst-pair
 * ΔE ≈ 0.06) then decays to the just-noticeable floor by ~6; past a handful the
 * dots are not reliably separable for red-green viewers. Anything rendering
 * many funds at once (charts, dense tables) MUST carry direct labels — the dot
 * alone is not sufficient. Retune the L/C spread in styles.css if that ceiling
 * ever needs raising.
 */
export const FUND_COLOR_ASSIGNMENT_ORDER = Object.freeze([
    "citron", "indigo", "rose", "teal", "ember",
    "magenta", "fern", "purple", "sky", "amber",
]);
