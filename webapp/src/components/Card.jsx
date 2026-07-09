
import { useState, forwardRef } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import styles from './Card.module.css';

import { CollapseButton } from './Buttons.jsx';


export function Card({ children, className, ...restProps }) {
    return (
        <div className={`${styles.card} ${className}`} {...restProps}>
            { children }
        </div>
    );
}

export function CardActionHeader({ 
    title,
    level = 2,
    children,
    className = '',
    fontSize = '1.5rem',
}) {
    // Render the appropriate heading element based on level
    const renderTitle = ({ fontSize }) => {
        if (!title) return null;

        const style = { fontSize };
        
        switch (level) {
            case 1: return <h1 className={styles.cardHeaderTitle} style={style}>{title}</h1>;
            case 2: return <h2 className={styles.cardHeaderTitle} style={style}>{title}</h2>;
            case 3: return <h3 className={styles.cardHeaderTitle} style={style}>{title}</h3>;
            case 4: return <h4 className={styles.cardHeaderTitle} style={style}>{title}</h4>;
            case 5: return <h5 className={styles.cardHeaderTitle} style={style}>{title}</h5>;
            case 6: return <h6 className={styles.cardHeaderTitle} style={style}>{title}</h6>;
            default: return <h2 className={styles.cardHeaderTitle} style={style}>{title}</h2>;
        }
    };
    
    return (
        <div className={`${styles.cardHeader} ${className}`}>
            <div className={styles.cardHeaderTitleContainer}>
                {renderTitle({ fontSize })}
            </div>
            {children && (
                <div className={styles.cardHeaderActions}>
                    {children}
                </div>
            )}
        </div>
    );
}

export function CardActionFooter({ 
    children,
    className = '',
}) {
    return (
        <div className={`${styles.cardActionFooter} ${className}`}>
            {children}
        </div>
    );
}

export function CardSection({ title, children }) {
    return (
        <div className={styles.cardSection}>
            { title && <h3>{ title }</h3> }
            { children }
        </div>
    );
}

const CardErrorSection = forwardRef(({ errorMessage, errorMessageDetails, style }, ref) => {
    return (
        <div className={styles.cardErrorSection} style={style} role="alert" ref={ref}>
            <div className={styles.cardErrorSectionMessage}>
                <FontAwesomeIcon 
                    icon="fa-solid fa-triangle-exclamation" 
                    widthAuto 
                    size="lg"
                />
                <span>{ errorMessage }</span>
            </div>
            { errorMessageDetails && <div className={styles.cardErrorSectionMessageDetails}>{ errorMessageDetails }</div> }
        </div>
    );
});
export { CardErrorSection };

export function CollapsibleCardSection({ 
    title, 
    children, 
    defaultCollapsed = false,
    isCollapsed,
    setIsCollapsed,
    onCollapseToggle
}) {
    const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
    
    // Use controlled state if provided, otherwise use internal state
    const isCollapsedState = isCollapsed !== undefined ? isCollapsed : internalCollapsed;
    
    const handleToggle = () => {
        let newCollapsedState;
        if (setIsCollapsed) {
            newCollapsedState = !isCollapsedState;
            setIsCollapsed(newCollapsedState);
        } else {
            newCollapsedState = !internalCollapsed;
            setInternalCollapsed(newCollapsedState);
        }
        onCollapseToggle?.(newCollapsedState);
    };

    return (
        <div className={styles.cardSection}>
            {title && (
                <h3 
                    className={styles.collapsibleHeader}
                    onClick={handleToggle}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleToggle();
                        }
                    }}
                    aria-expanded={!isCollapsedState}
                >
                    <div style={{ flexGrow: 1 }}>{title}</div>
                    <CollapseButton isCollapsed={isCollapsedState} size="md"/>
                </h3>
            )}
            <div 
                className={`${styles.collapsibleContent} ${isCollapsedState ? styles.collapsed : ''}`}
            >
                {children}
            </div>
        </div>
    );
}

export function CardAutoGrid({
    children,
    gap,
    responsive = true,
    minColumnWidth = '15rem',
}) {
    return (
        <div
            className={`${responsive ? styles.cardAutoGridCollapsing : ''}`}
            style={{
                display: 'grid',
                gap: gap || '1.5rem',
                gridTemplateColumns: `repeat(auto-fit, minmax(${minColumnWidth}, 1fr))`,
            }}
        >
            { children }
        </div>
    );
}
