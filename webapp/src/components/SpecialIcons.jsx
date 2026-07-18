
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { fundTypeOf, statementStateOf } from './domain.js';
import { fundColorVar } from '../hooks/fundColors.js';

import styles from './SpecialIcons.module.css';

/**
 * A fund's color as a small round swatch. `color` is a palette slug, or null
 * for funds with no color chosen -- which renders the neutral default swatch.
 * Purely decorative -- always pair it with the fund's name or a label.
 */
export function FundColorDot({ color, size = "0.7rem", className, marginRight, marginLeft, style, ...restProps }) {
    return <span
        className={styles.fundColorDot + (className ? " " + className : "")}
        style={{
            width: size,
            height: size,
            backgroundColor: fundColorVar(color),
            marginRight,
            marginLeft,
            ...style
        }}
        title={color ? color.replace(/-/g, " ") : "default"}
        {...restProps}
    />;
}


export function BooleanIcon({ value, trueIcon, falseIcon, className, marginRight, marginLeft, ...restProps }) {
    const icon = value ? trueIcon : falseIcon;

    if ( !restProps.style ) {
        restProps.style = {};
    }
    if ( marginRight ) {
        restProps.style.marginRight = marginRight;
    }
    if ( marginLeft ) {
        restProps.style.marginLeft = marginLeft;
    }

    return <FontAwesomeIcon
        className={className}
        icon={`fa-solid ${icon}`}
        {...restProps}
    />;
}

export function FundTypeIcon({ status, className, marginRight, marginLeft, ...restProps }) {
    let fundTypeIcon;
    switch (fundTypeOf(status)) {
        case "pool":
            fundTypeIcon = "fa-solid fa-vault";
            break;
        case "monthly":
            fundTypeIcon = "fa-solid fa-arrows-rotate";
            break;
        case "tracked":
            fundTypeIcon = "fa-solid fa-coins";
            break;
        case "untracked":
            fundTypeIcon = "fa-solid fa-folder";
            break;
        default:
            fundTypeIcon = "fa-regular fa-circle";
            break;
    }

    if ( !restProps.style ) {
        restProps.style = {};
    }
    if ( marginRight ) {
        restProps.style.marginRight = marginRight;
    }
    if ( marginLeft ) {
        restProps.style.marginLeft = marginLeft;
    }

    return <FontAwesomeIcon
        className={styles.fundTypeIcon + (className ? (" "+className) : "")}
        icon={fundTypeIcon}
        {...restProps}
    />;
}

export function StatementStateIcon({ statement, className, marginRight, marginLeft, ...restProps }) {
    let stateIcon;
    switch (statementStateOf(statement)) {
        case "reconciled":
            stateIcon = "fa-solid fa-link";
            break;
        case "ignored":
            stateIcon = "fa-solid fa-eye-slash";
            break;
        case "pending":
            stateIcon = "fa-solid fa-hourglass-half";
            break;
        default:
            stateIcon = "fa-regular fa-circle";
            break;
    }

    if ( !restProps.style ) {
        restProps.style = {};
    }
    if ( marginRight ) {
        restProps.style.marginRight = marginRight;
    }
    if ( marginLeft ) {
        restProps.style.marginLeft = marginLeft;
    }

    return <FontAwesomeIcon
        className={className}
        icon={stateIcon}
        {...restProps}
    />;
}

export function RoleIcon({ role, className, marginRight, marginLeft, ...restProps }) {
    let roleIcon;
    switch (role) {
        case "admin":
            roleIcon = "fa-solid fa-user-shield";
            break;
        case "editor":
            roleIcon = "fa-solid fa-pen-to-square";
            break;
        case "reader":
            roleIcon = "fa-solid fa-book-open";
            break;
        default:
            roleIcon = "fa-regular fa-circle";
            break;
    }

    if ( !restProps.style ) {
        restProps.style = {};
    }
    if ( marginRight ) {
        restProps.style.marginRight = marginRight;
    }
    if ( marginLeft ) {
        restProps.style.marginLeft = marginLeft;
    }

    return <FontAwesomeIcon
        className={className}
        icon={roleIcon}
        {...restProps}
    />;
}
