import { useCallback, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';

import styles from './MonthPaginator.module.css';

/**
 * A deliberately slim month selector: [<] March 2026 [>] with the label
 * opening a scrollable dropdown of months (newest at the top, initially
 * scrolled to the selected month, so scrolling up moves toward the future
 * and down toward the past).
 *
 * `value`/`onChange` speak the FIRST of the month as YYYY-MM-DD (the same
 * shape as LabeledMonthInput -- what the month-oriented APIs want).
 * `pastMonths`/`futureMonths` bound the dropdown range around today; the
 * arrows are unbounded.
 */
export function MonthPaginator({
    value,
    onChange,
    pastMonths = 120,
    futureMonths = 24,
    className = ''
}) {
    const [ isOpen, setIsOpen ] = useState(false);
    const containerRef = useRef(null);
    const selectedRef = useRef(null);

    const selected = (value ? dayjs(value) : dayjs()).startOf('month');

    const emit = useCallback((month) => {
        if ( onChange ) onChange(month.format('YYYY-MM-01'));
    }, [onChange]);

    const close = useCallback(() => setIsOpen(false), []);
    useStackedEscapeKey(close, isOpen);

    // Close on any click outside the component
    useEffect(() => {
        if ( !isOpen ) return;
        const handleMouseDown = (event) => {
            if ( containerRef.current && !containerRef.current.contains(event.target) ) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [isOpen]);

    // Open with the selected month centered in the scroll window
    useEffect(() => {
        if ( isOpen && selectedRef.current ) {
            selectedRef.current.scrollIntoView({ block: 'center' });
        }
    }, [isOpen]);

    // Newest first: index 0 is the latest month offered
    const today = dayjs().startOf('month');
    const latest = today.add(futureMonths, 'month');
    const monthCount = pastMonths + futureMonths + 1;
    const months = Array.from({ length: monthCount }, (_, i) => latest.subtract(i, 'month'));

    return (
        <div className={`${styles.container} ${className}`} ref={containerRef}>
            <button
                type="button"
                className={styles.arrowButton}
                aria-label="Previous month"
                title="Previous month"
                onClick={() => emit(selected.subtract(1, 'month'))}
            >
                <FontAwesomeIcon icon="fa-solid fa-chevron-left" size="xs" />
            </button>
            <button
                type="button"
                className={styles.labelButton}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => setIsOpen(open => !open)}
            >
                <span>{selected.format('MMMM YYYY')}</span>
                <FontAwesomeIcon icon="fa-solid fa-angle-down" size="xs" />
            </button>
            <button
                type="button"
                className={styles.arrowButton}
                aria-label="Next month"
                title="Next month"
                onClick={() => emit(selected.add(1, 'month'))}
            >
                <FontAwesomeIcon icon="fa-solid fa-chevron-right" size="xs" />
            </button>

            { isOpen && (
                <div className={styles.dropdown} role="listbox">
                    { months.map((month) => {
                        const isSelected = month.isSame(selected, 'month');
                        const isCurrent = month.isSame(today, 'month');
                        return (
                            <div
                                key={month.format('YYYY-MM')}
                                ref={isSelected ? selectedRef : null}
                                role="option"
                                aria-selected={isSelected}
                                className={`${styles.option} ${isSelected ? styles.optionSelected : ''} ${isCurrent ? styles.optionCurrent : ''}`}
                                onClick={() => {
                                    emit(month);
                                    setIsOpen(false);
                                }}
                            >
                                {month.format('MMMM YYYY')}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
