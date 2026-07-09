

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
            className={`${styles.iconButton} ${variant === 'primary' ? styles.primaryButton : ''} ${buttonClassName || ''}`}
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

export function TightIconButton({ icon, size="md", styles:_styles, ...props }) {
    const styles = { ..._styles };
    switch (size) {
        case "xs":
            styles.borderRadius = "0.125rem";
            styles.padding = "0.1rem";
            styles.width = "1.25rem";
            styles.height = "1.25rem";
            break;
        case "md":
            styles.width = "2rem";
            styles.height = "2rem";
            break;
    }
    return (
        <IconButton
            icon={icon}
            style={styles}
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
