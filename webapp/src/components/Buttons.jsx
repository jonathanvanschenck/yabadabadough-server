

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import Spinner from './Spinner.jsx';
import styles from './Buttons.module.css';


export function SpinnerButton({
    isPending = false,
    text,
    buttonClassName,
    variant,
    spinnerSize = '1rem',
    spinnerMargin = '0.5rem',
    disabled = false,
    onClick,
    style,
    ariaLabel
}) {
    return (
        <button
            className={`${styles.spinnerButton} ${variant === 'primary' ? styles.primaryButton : ''} ${buttonClassName || ''}`}
            disabled={isPending || disabled}
            onClick={onClick}
            style={style}
            aria-label={ariaLabel}
        >
            <span>{text}</span>
            {isPending && <Spinner size={spinnerSize} marginLeft={spinnerMargin} />}
        </button>
    );
}

export function IconButton({
    text,
    isPending,
    pendingText,
    buttonClassName,
    textClassName,
    variant,
    tone,
    icon,
    onClick,
    disabled = false,
    style,
    size,
    ariaLabel,
    isError = false,
    errorMessage,
    title
}) {
    return (
        <button
            className={`${styles.iconButton} ${variant === 'primary' ? styles.primaryButton : ''} ${tone ? styles[`tone_${tone}`] : ''} ${buttonClassName || ''}`}
            onClick={onClick}
            disabled={disabled || isPending || isError}
            title={isError ? errorMessage : title}
            style={style}
            aria-label={ariaLabel}
        >
            {icon && <FontAwesomeIcon icon={`fa-solid ${icon}`} widthAuto size={size}/>}
            { text && !isPending && <span className={textClassName}>{text}</span> }
            { (text||pendingText) && isPending && <span>{pendingText || text}</span> }
        </button>
    );
}

export function TightIconButton({ icon, size="md", style:_style, ...props }) {
    // NB: keep the inline-style object under its own name -- calling it `styles`
    // shadows the CSS-module import, which silently dropped `.tightIconButton`
    // (padding reset) and left these as non-square rectangles.
    const style = { ..._style };
    switch (size) {
        case "xs":
            style.borderRadius = "0.125rem";
            style.padding = "0.1rem";
            style.width = "1.25rem";
            style.height = "1.25rem";
            break;
        case "md":
            style.width = "2rem";
            style.height = "2rem";
            break;
    }
    return (
        <IconButton
            icon={icon}
            style={style}
            size={size}
            buttonClassName={`${styles.tightIconButton} ${props.buttonClassName || ''}`}
            {...props}
        />
    );
}

export function CloseButton({ ...props }) {
    return (
        <TightIconButton
            icon="fa-times"
            ariaLabel="Close"
            {...props}
        />
    );
}

export function CollapseButton({ isCollapsed, ...props }) {
    return (
        <TightIconButton
            icon={ isCollapsed ? "fa-chevron-down" : "fa-chevron-up" }
            ariaLabel="Toggle Collapse"
            {...props}
        />
    );
}
