import { useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';

import { CloseButton } from './Buttons.jsx';

import styles from './Popout.module.css';

export function Popout({ 
    children, 
    isOpen = false, 
    onClose, 
    /*position = 'right',*/
    width = '25rem',
    /* height = 'auto', */
    className = '',
    useBackdrop = false
}) {

    const closeModal = useCallback(() => {
        if ( typeof onClose === 'function' ) {
            onClose();
        }
    }, [onClose]);
    useStackedEscapeKey(closeModal, isOpen);


    // Handle backdrop click
    const handleBackdropClick = (e) => {
        if (e.target === e.currentTarget) {
            onClose?.();
        }
    };

    if (!isOpen) return null;
    
    const style = useBackdrop ? { left: 0 } : {};
    return (
        <div 
            className={styles.overlay} 
            onClick={handleBackdropClick}
            role="dialog"
            aria-modal="true"
            style={style}
        >
            <div 
                className={`${styles.popout} ${className}`}
                style={{ width, /* height */ }}
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
}

export function PopoutHeader({ title, onClose, className = '' }) {
    return (
        <div className={`${styles.header} ${className}`}>
            <h3 className={styles.title}>{title}</h3>
            {onClose && (
                <CloseButton onClick={onClose} />
            )}
        </div>
    );
}

export function PopoutSection({ title, children, className = '' }) {
    return (
        <div className={`${styles.section} ${className}`}>
            {title && <h4 className={styles.sectionTitle}>{title}</h4>}
            <div className={styles.sectionContent}>
                {children}
            </div>
        </div>
    );
}

export function PopoutLabeledValue({ label, value, content, className = '', valueClassName = '' }) {
    return (
        <div className={`${styles.labeledValue} ${className}`}>
            <label>{label}:</label>
            { content ? content : <span className={valueClassName}>{value}</span>}
        </div>
    );
}
