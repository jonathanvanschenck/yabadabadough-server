import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import styles from './Banner.module.css';

/**
 * A tinted callout block: an explanatory notice attached to a page or modal
 * section ("this month isn't finalized", "this group is read-only").
 *
 * Colors come from the `--u-<role>` ramps, so a variant is a semantic role
 * rather than a color choice. Layout is deliberately minimal -- callers own
 * their own spacing via `className`, because the same block wants different
 * margins stacked inside a modal versus standing alone under a page header.
 *
 * @param {'warn'|'info'|'danger'|'success'} variant  which --u-* ramp to tint with
 * @param {string} [icon]   FontAwesome name (e.g. "fa-triangle-exclamation");
 *                          when set the content is laid out beside it
 * @param {boolean} [dense] tighter vertical padding, for stacked modal notes
 */
export function Banner({
    variant = 'warn',
    icon = null,
    dense = false,
    className,
    children,
    ...rest
}) {
    const classes = [
        styles.banner,
        styles[variant],
        dense ? styles.dense : null,
        icon ? styles.withIcon : null,
        className,
    ].filter(Boolean).join(' ');

    return (
        <div className={classes} role="note" {...rest}>
            {icon
                ? <>
                    <FontAwesomeIcon icon={`fa-solid ${icon}`} className={styles.icon} />
                    <div className={styles.body}>{children}</div>
                </>
                : children
            }
        </div>
    );
}
