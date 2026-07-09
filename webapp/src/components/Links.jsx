
import { NavLink } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import styles from './Links.module.css';

export function BackLink({ to, linkText }) {
    return (
        <NavLink to={to} className={styles.backLink}>
            <FontAwesomeIcon icon="fa-solid fa-chevron-left" widthAuto />
            <span>{linkText}</span>
        </NavLink>
    );
};


export function AnchorLink({ fragment, linkText, ...rest }) {
    return (
        <NavLink to={`#${fragment}`} className={styles.anchorLink} {...rest}>
            <span>{linkText}</span>
            <FontAwesomeIcon icon="fa-solid fa-link" widthAuto />
        </NavLink>
    );
}