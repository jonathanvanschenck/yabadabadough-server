import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { useTheme } from '../contexts/ThemeContext.jsx';
import styles from './ThemeToggle.module.css';

const OPTIONS = [
    { value: 'light',  icon: 'fa-sun',                label: 'Light' },
    { value: 'system', icon: 'fa-circle-half-stroke', label: 'Follow system' },
    { value: 'dark',   icon: 'fa-moon',               label: 'Dark' },
];

/**
 * Three-way color theme control (light / follow-system / dark), a radio group
 * of icon buttons. Reads and writes the preference through ThemeContext; the
 * stylesheet reacts on its own via <html data-theme>.
 */
export function ThemeToggle({ className, style }) {
    const { preference, resolved, setPreference } = useTheme();

    return (
        <div
            className={`${styles.group} ${className || ''}`}
            style={style}
            role="radiogroup"
            aria-label="Color theme"
        >
            {OPTIONS.map(({ value, icon, label }) => {
                const selected = value === preference;
                const title = value === 'system'
                    ? `${label} (currently ${resolved})`
                    : label;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={label}
                        title={title}
                        className={`${styles.option} ${selected ? styles.selected : ''}`}
                        onClick={() => setPreference(value)}
                    >
                        <FontAwesomeIcon icon={icon} />
                    </button>
                );
            })}
        </div>
    );
}
