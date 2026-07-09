/**
 * Re-export of the SERVER's fund color registry -- the single source of
 * truth shared by both sides, exactly like queryKeys.js. Funds store a
 * color SLUG (the API rejects anything else); the color values live in
 * public/styles.css as --fund-<slug>* custom properties, so retuning the
 * rendered palette never touches stored data.
 */
export { FUND_COLORS } from '../../../lib/fund_colors.mjs';

/**
 * Each slug carries four tone-matched variants in styles.css (see there):
 *   'dot'   (default) -- bright saturated fill for dots / swatches / marks
 *   'text'  -- readable label color on dark surfaces
 *   'main'  -- dark row background (the bare --fund-<slug> variable)
 *   'muted' -- dark alt-row background
 */
export const FUND_COLOR_VARIANTS = Object.freeze(['dot', 'text', 'main', 'muted']);

/**
 * CSS value for a fund color slug + variant (resolves via public/styles.css).
 * A null/undefined slug resolves to the neutral `--fund-default*` fallback --
 * funds have no auto-assigned color, so "no color chosen" renders as default.
 * Defaults to the bright 'dot' variant -- the bare slug is a dark row bg, not
 * a mark color, so dots/swatches must go through here rather than --fund-<slug>.
 */
export const fundColorVar = (slug, variant = 'dot') => {
    const base = slug ? `--fund-${slug}` : '--fund-default';
    return variant === 'main' ? `var(${base})` : `var(${base}-${variant})`;
};
