
import styles from './Inputs.module.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import dayjs from 'dayjs';
import Spinner from './Spinner.jsx';

import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';


function ClearButton({ value, onClear }) {
    return (
        <button
            type="button"
            className={styles.clearButton}
            onClick={() => onClear()}
            disabled={value === null}
            aria-label="Clear value"
        >
            <FontAwesomeIcon icon="fa-solid fa-times" />
        </button>
    );
}

function InputLabel({ label, isRequired = false }) {
    return (
        <label className={styles.label}>
            {label}
            {isRequired && <FontAwesomeIcon icon="fa-solid fa-asterisk" size="xs" style={{marginLeft: '0.25rem'}} />}
        </label>
    );
}

export function TextInput({
    value,
    onChange,
    nullPlaceholder="(null)",
    emptyStringPlaceholder="(empty string)",
    whitespacePlaceholder="(whitespace)",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    type = "text",
    validityMessage,
    inputDisabled = false,
    inputTitle = "",
    ...rest
}) {

    const inputRef = useRef(null);

    // Actually update the input's validity
    useEffect(() => {
        if (!validityMessage) {
            inputRef.current?.setCustomValidity('');
        } else {
            inputRef.current?.setCustomValidity(validityMessage);
        }
    }, [validityMessage, isFrozen /* Refresh when frozen changes */]);

    // Handle clear button click
    const handleClear = () => {
        if (allowNull && value !== null) {
            onChange(null);
        }
    };


    // Get display text for frozen state
    const getDisplayText = () => {
        if (value === null || value === undefined) {
            return <span className={styles.placeholder}>{nullPlaceholder}</span>;
        }
        if (value === '' ) {
            return <span className={styles.placeholder}>{emptyStringPlaceholder}</span>;
        }
        if (typeof(value) == "string" && value.match(/^\s+$/)) {
            return <span className={styles.placeholder}>{whitespacePlaceholder}</span>;
        }
        return value;
    };

    return isFrozen ? (
        <div className={styles.textInputFrozen}>{getDisplayText()}</div>
    ) : (
        <div className={styles.textInputContainer}>
            <input
                className={`${styles.textInput} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''}`}
                type={type}
                value={value == null ? '' : value}
                onChange={(e) => {onChange(e.target.value);}}
                placeholder={value == null ? nullPlaceholder : emptyStringPlaceholder}
                ref={inputRef}
                disabled={inputDisabled}
                title={inputTitle}
                {...rest}
            />
            {allowNull && (
                <ClearButton value={value} onClear={handleClear} />
            )}
        </div>
    );
}

export function NumberInput({
    value,
    onChange,
    nullPlaceholder="(null)",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    step = "any",
    min,
    max,
    render,
    validityMessage,
    inputDisabled = false,
    inputTitle = "",
    ...rest
}) {
    const inputRef = useRef(null);

    // Actually update the input's validity
    useEffect(() => {
        if (!validityMessage) {
            inputRef.current?.setCustomValidity('');
        } else {
            inputRef.current?.setCustomValidity(validityMessage);
        }
    }, [validityMessage, isFrozen /* Refresh when frozen changes */]);

    // Handle clear button click
    const handleClear = () => {
        if (allowNull && value !== null) {
            onChange(null);
        }
    };

    // Get display text for frozen state
    const getDisplayText = () => {
        if (value === null || value === undefined) {
            return <span className={styles.placeholder}>{nullPlaceholder}</span>;
        }
        const stringValue = value.toString();
        return render ? render(stringValue, value) : stringValue;
    };

    // Handle change event for number input
    const handleChange = (e) => {
        const inputValue = e.target.value;
        if (inputValue === '') {
            onChange(null);
        } else {
            const numericValue = parseFloat(inputValue);
            if (!isNaN(numericValue)) {
                onChange(numericValue);
            }
        }
    };

    return isFrozen ? (
        <div className={styles.textInputFrozen}>{getDisplayText()}</div>
    ) : (
        <div className={styles.textInputContainer}>
            <input
                className={`${styles.textInput} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''}`}
                type="number"
                value={value == null ? '' : value}
                onChange={handleChange}
                placeholder={nullPlaceholder}
                step={step}
                min={min}
                max={max}
                ref={inputRef}
                disabled={inputDisabled}
                title={inputTitle}
                {...rest}
            />
            {allowNull && (
                <ClearButton value={value} onClear={handleClear} />
            )}
        </div>
    );
}

export function LabeledNumberInput({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <NumberInput isRequired={isRequired} {...rest} />
        </div>
    );
}

export function LabeledTextInput({
    label,
    isRequired = false,
    ...rest
}) {

    return (
        <div className={ styles.labelContainer }>
            <InputLabel label={label} isRequired={isRequired} />
            <TextInput isRequired={isRequired} {...rest} />
        </div>
    );
}

const DP_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// The 42 (6 weeks x 7 days) dayjs dates filling the month grid, starting on the
// Sunday of the week containing the 1st -- so leading/trailing days spill into
// the neighbouring months (rendered dimmed).
function dpCalendarDays(viewMonth) {
    const firstOfMonth = viewMonth.startOf('month');
    const gridStart = firstOfMonth.subtract(firstOfMonth.day(), 'day');
    return Array.from({ length: 42 }, (_, i) => gridStart.add(i, 'day'));
}

/**
 *  A themed date picker replacing the browser-default `<input type="date">`.
 *
 *  Same value contract as the other inputs: `value` is a 'YYYY-MM-DD' string
 *  (or null) and `onChange` is called with the same. The calendar pops open in
 *  a body-level portal, flipping above the trigger when there isn't room below,
 *  supports full keyboard navigation (arrows/Home/End/PageUp/PageDown, Enter or
 *  Space to pick), returns focus to the trigger on close, and dismisses via the
 *  shared Escape stack or an outside click. `min`/`max` (both 'YYYY-MM-DD',
 *  optional) disable out-of-range days.
 */
export function DateInput({
    value,
    onChange,
    nullPlaceholder = "(none)",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    inputTitle = "",
    validityMessage,
    min,
    max,
    displayFormat = "MMM D, YYYY",
}) {
    const selected = value ? dayjs(value) : null;
    const hasValue = !!(selected && selected.isValid());

    const [isOpen, setIsOpen] = useState(false);
    const [viewMonth, setViewMonth] = useState(() => (hasValue ? selected : dayjs()).startOf('month'));
    const [focusedDate, setFocusedDate] = useState(() => (hasValue ? selected : dayjs()));
    const [position, setPosition] = useState({ top: 0, left: 0, flipped: false });

    const triggerRef = useRef(null);
    const popupRef = useRef(null);
    const focusedDayRef = useRef(null);

    const minDate = min ? dayjs(min) : null;
    const maxDate = max ? dayjs(max) : null;
    const isDisabledDate = (d) =>
        (minDate && d.isBefore(minDate, 'day')) || (maxDate && d.isAfter(maxDate, 'day'));

    // Position the portal-ed popup: below the trigger, or flipped above it when
    // there isn't enough room below (and there's more room above).
    const updatePosition = useCallback(() => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        const popupHeight = popupRef.current?.offsetHeight || 340;
        const popupWidth = popupRef.current?.offsetWidth || rect.width;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        const flipped = spaceBelow < popupHeight && spaceAbove > spaceBelow;
        setPosition({
            top: flipped
                ? rect.top + window.scrollY - popupHeight - 4
                : rect.bottom + window.scrollY + 4,
            left: Math.max(8, Math.min(
                rect.left + window.scrollX,
                window.innerWidth - popupWidth - 8,
            )),
            flipped,
        });
    }, []);

    // Measure + reposition (layout effect so it lands before paint), and keep it
    // pinned to the trigger while scrolling/resizing.
    useLayoutEffect(() => {
        if (!isOpen) return;
        updatePosition();
        const handler = () => updatePosition();
        window.addEventListener('scroll', handler, true);
        window.addEventListener('resize', handler);
        return () => {
            window.removeEventListener('scroll', handler, true);
            window.removeEventListener('resize', handler);
        };
    }, [isOpen, updatePosition]);

    // Roving focus: whenever the focused day changes (or on open), move DOM focus
    // to its cell so arrow-key navigation stays on the calendar.
    useEffect(() => {
        if (isOpen) focusedDayRef.current?.focus();
    }, [isOpen, focusedDate]);

    const open = () => {
        if (isFrozen) return;
        const base = hasValue ? selected : dayjs();
        setViewMonth(base.startOf('month'));
        setFocusedDate(base);
        setIsOpen(true);
    };

    const close = useCallback((returnFocus = true) => {
        setIsOpen(false);
        if (returnFocus) triggerRef.current?.focus();
    }, []);

    useStackedEscapeKey(useCallback(() => close(), [close]), isOpen);

    // Dismiss on outside click (without stealing focus back to the trigger).
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e) => {
            if (triggerRef.current?.contains(e.target)) return;
            if (popupRef.current?.contains(e.target)) return;
            setIsOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen]);

    const selectDate = (d) => {
        if (isDisabledDate(d)) return;
        onChange(d.format('YYYY-MM-DD'));
        close();
    };

    const handleGridKeyDown = (e) => {
        let next = null;
        switch (e.key) {
            case 'ArrowLeft': next = focusedDate.subtract(1, 'day'); break;
            case 'ArrowRight': next = focusedDate.add(1, 'day'); break;
            case 'ArrowUp': next = focusedDate.subtract(1, 'week'); break;
            case 'ArrowDown': next = focusedDate.add(1, 'week'); break;
            case 'Home': next = focusedDate.startOf('week'); break;
            case 'End': next = focusedDate.endOf('week'); break;
            case 'PageUp': next = focusedDate.subtract(e.shiftKey ? 12 : 1, 'month'); break;
            case 'PageDown': next = focusedDate.add(e.shiftKey ? 12 : 1, 'month'); break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                selectDate(focusedDate);
                return;
            default:
                return;
        }
        e.preventDefault();
        setFocusedDate(next);
        if (!next.isSame(viewMonth, 'month')) setViewMonth(next.startOf('month'));
    };

    if (isFrozen) {
        return (
            <div className={styles.textInputFrozen}>
                { hasValue
                    ? selected.format(displayFormat)
                    : <span className={styles.placeholder}>{nullPlaceholder}</span> }
            </div>
        );
    }

    const triggerClass = [
        styles.dpTrigger,
        isChanged && styles.changed,
        isRequired && styles.required,
        validityMessage && styles.invalid,
    ].filter(Boolean).join(' ');

    const renderPopup = () => (
        <div
            ref={popupRef}
            className={`${styles.dpPopup} ${position.flipped ? styles.dpFlipped : ''}`}
            style={{ top: position.top, left: position.left }}
            role="dialog"
            aria-label="Choose date"
        >
            <div className={styles.dpHeader}>
                <button
                    type="button"
                    className={styles.dpNav}
                    onClick={() => setViewMonth(m => m.subtract(1, 'month'))}
                    aria-label="Previous month"
                    title="Previous month"
                >
                    <FontAwesomeIcon icon="fa-solid fa-chevron-left" />
                </button>
                <span className={styles.dpTitle}>{viewMonth.format('MMMM YYYY')}</span>
                <button
                    type="button"
                    className={styles.dpNav}
                    onClick={() => setViewMonth(m => m.add(1, 'month'))}
                    aria-label="Next month"
                    title="Next month"
                >
                    <FontAwesomeIcon icon="fa-solid fa-chevron-right" />
                </button>
            </div>
            <div className={styles.dpWeekdays}>
                { DP_WEEKDAYS.map(w => <span key={w} className={styles.dpWeekday}>{w}</span>) }
            </div>
            <div className={styles.dpGrid} role="grid" onKeyDown={handleGridKeyDown}>
                { dpCalendarDays(viewMonth).map(d => {
                    const outside = !d.isSame(viewMonth, 'month');
                    const isSel = hasValue && d.isSame(selected, 'day');
                    const isToday = d.isSame(dayjs(), 'day');
                    const isFocus = d.isSame(focusedDate, 'day');
                    const dayClass = [
                        styles.dpDay,
                        outside && styles.dpDayOutside,
                        isToday && styles.dpDayToday,
                        isSel && styles.dpDaySelected,
                    ].filter(Boolean).join(' ');
                    return (
                        <button
                            key={d.format('YYYY-MM-DD')}
                            ref={isFocus ? focusedDayRef : null}
                            type="button"
                            className={dayClass}
                            tabIndex={isFocus ? 0 : -1}
                            disabled={isDisabledDate(d)}
                            aria-selected={isSel}
                            aria-current={isToday ? 'date' : undefined}
                            onClick={() => selectDate(d)}
                        >
                            {d.date()}
                        </button>
                    );
                }) }
            </div>
            <div className={styles.dpFooter}>
                <button
                    type="button"
                    className={styles.dpFooterBtn}
                    onClick={() => selectDate(dayjs())}
                >
                    Today
                </button>
                { allowNull && value !== null && (
                    <button
                        type="button"
                        className={styles.dpFooterBtn}
                        onClick={() => { onChange(null); close(); }}
                    >
                        Clear
                    </button>
                ) }
            </div>
        </div>
    );

    return (
        <div className={styles.dpContainer}>
            <div className={styles.dpTriggerWrapper}>
                <div
                    ref={triggerRef}
                    className={triggerClass}
                    onClick={() => (isOpen ? close(false) : open())}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            isOpen ? close() : open();
                        } else if (e.key === 'ArrowDown' && !isOpen) {
                            e.preventDefault();
                            open();
                        }
                    }}
                    tabIndex={0}
                    role="combobox"
                    aria-haspopup="dialog"
                    aria-expanded={isOpen}
                    title={validityMessage || inputTitle}
                >
                    <span className={`${styles.dpValue} ${hasValue ? '' : styles.placeholder}`}>
                        { hasValue ? selected.format(displayFormat) : nullPlaceholder }
                    </span>
                    <FontAwesomeIcon icon="fa-solid fa-calendar-days" className={styles.dpIcon} />
                </div>
                { allowNull && (
                    <ClearButton value={value} onClear={() => value !== null && onChange(null)} />
                ) }
            </div>
            { isOpen && createPortal(renderPopup(), document.body) }
        </div>
    );
}

export function LabeledDateInput({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <DateInput isRequired={isRequired} {...rest} />
        </div>
    );
}

/**
 *  An inclusive [since, until] date-range picker: two themed DateInputs that
 *  cross-constrain each other (since's calendar caps at until and vice
 *  versa), so an inverted range is unrepresentable. Either side may be null
 *  (open-ended) -- both sides are always `allowNull`.
 *
 *  Value contract: `value` is `{ since, until }` ('YYYY-MM-DD' strings or
 *  null) and `onChange` receives the whole `{ since, until }` object.
 */
export function DateRangeInput({
    value = { since: null, until: null },
    onChange,
    isFrozen = true,
    isChanged = false,
    sincePlaceholder = "(any start)",
    untilPlaceholder = "(any end)",
    displayFormat = "MMM D, YYYY",
}) {
    const { since = null, until = null } = value ?? {};

    return (
        <div className={styles.dateRangeContainer}>
            <DateInput
                value={since}
                onChange={(v) => onChange({ since: v, until })}
                isFrozen={isFrozen}
                isChanged={isChanged}
                allowNull={true}
                nullPlaceholder={sincePlaceholder}
                max={until ?? undefined}
                displayFormat={displayFormat}
                inputTitle="Items dated on or after this date"
            />
            <span className={styles.dateRangeSeparator} aria-hidden="true">
                <FontAwesomeIcon icon="fa-solid fa-arrow-right" size="xs" />
            </span>
            <DateInput
                value={until}
                onChange={(v) => onChange({ since, until: v })}
                isFrozen={isFrozen}
                isChanged={isChanged}
                allowNull={true}
                nullPlaceholder={untilPlaceholder}
                min={since ?? undefined}
                displayFormat={displayFormat}
                inputTitle="Items dated on or before this date"
            />
        </div>
    );
}

export function LabeledDateRangeInput({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <DateRangeInput {...rest} />
        </div>
    );
}

/**
 *  A selector
 * 
 *  NOTE: when you provide `value`, it can be any javascript type, however, internally,
 *      to this component, we are using a <select> element, which only supports string values.
 *      Thus, we internally create a valueStr = value ? value.toString() : '' to use as when
 *      comparing against optionKeys and when setting the <select>'s value. This means that if you use non-string values,
 *      they will be converted to strings for comparison and display purposes.
 * 
 *  NOTE: Similarly when onChange is called, it is called on the matching optionKey, which is a string.
 *        So you will need to convert it back to your type before seting your `value` state variable.
 *        See FundSearchableSelector (SpecialInputs.jsx) for an example of this conversion in action.
 */
export function Selector({
    value,
    optionKeys,
    optionDisplayNames,
    onChange,
    placeholder,
    isFrozen = true,
    inputDisabled = false,
    inputTitle = "",

    isRequired = false,
    isChanged = false,
    allowNull = false,
    ...rest
}) {
    const valueStr = value ? value.toString() : '';

    // Handle clear button click
    const handleClear = () => {
        if ( allowNull && value !== null ) {
            onChange(null);
        }
    };

    // Get display text for the current value
    const getDisplayText = () => {
        if (!value || value === '') {
            return <span className={styles.placeholder}>{placeholder}</span>;
        }
        
        const valueIndex = optionKeys.indexOf(valueStr);
        if (valueIndex !== -1 && optionDisplayNames) {
            return optionDisplayNames[valueIndex];
        }
        return valueStr;
    };

    return isFrozen ? (
        <div className={styles.selectorFrozen}>{getDisplayText()}</div>
    ) : (
        <div className={styles.selectorContainer}>
            <select
                className={`${styles.selector} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''}`}
                value={valueStr}
                onChange={(e) => onChange(e.target.value || null)}
                disabled={inputDisabled}
                title={inputTitle}
                {...rest}
            >
                <option value="" disabled hidden>{placeholder}</option>
                { (!!valueStr && !optionKeys.includes(valueStr)) && (
                    <option key={valueStr} value={valueStr} disabled hidden>{valueStr} (unknown)</option>
                )}
                {optionKeys.map((key, index) => (
                    <option key={key} value={key}>{
                        optionDisplayNames
                            ? optionDisplayNames[index]
                            : key
                    }</option>
                ))}
            </select>
            {allowNull && (
                <ClearButton value={value} onClear={handleClear} />
            )}
        </div>
    );
}

export function LabeledSelector({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={ styles.labelContainer }>
            <InputLabel label={label} isRequired={isRequired} />
            <Selector isRequired={isRequired} {...rest} />
        </div>
    );
}

export function TextArea({
    value,
    onChange,
    nullPlaceholder="(null)",
    emptyStringPlaceholder="(empty string)",
    whitespacePlaceholder="(whitespace)",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    minHeight = '8rem',
    collapseWhenFrozen = true,
    validityMessage,
    inputDisabled = false,
    inputTitle = "",
    ...rest
}) {
    const textareaRef = useRef(null);

    // Actually update the textarea's validity
    useEffect(() => {
        if (!validityMessage) {
            textareaRef.current?.setCustomValidity('');
        } else {
            textareaRef.current?.setCustomValidity(validityMessage);
        }
    }, [validityMessage, isFrozen /* Refresh when frozen changes */]);

    // Handle clear button click
    const handleClear = () => {
        if (allowNull && value !== null) {
            onChange(null);
        }
    };

    // Get display text for frozen state
    const getDisplayText = () => {
        if (value === null || value === undefined) {
            return <span className={styles.placeholder}>{nullPlaceholder}</span>;
        }
        if (value === '' ) {
            return <span className={styles.placeholder}>{emptyStringPlaceholder}</span>;
        }
        if (typeof(value) == "string" && value.match(/^\s+$/)) {
            return <span className={styles.placeholder}>{whitespacePlaceholder}</span>;
        }
        return value;
    };

    return isFrozen ? (
        <div 
            className={styles.textAreaFrozen}
            style={{
                minHeight: collapseWhenFrozen ? 'auto' : minHeight,
            }}
        >{getDisplayText()}</div>
    ) : (
        <div className={styles.textAreaContainer}>
            <textarea
                className={`${styles.textArea} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''}`}
                value={value == null ? '' : value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={value == null ? nullPlaceholder : emptyStringPlaceholder}
                style={{
                    minHeight,
                }}
                ref={textareaRef}
                disabled={inputDisabled}
                title={inputTitle}
                {...rest}
            />
            {allowNull && (
                <ClearButton value={value} onClear={handleClear} />
            )}
        </div>
    );
}

export function LabeledTextArea({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <TextArea isRequired={isRequired} {...rest} />
        </div>
    );
}

export function BooleanInput({
    value, // true, false, or null
    onChange,
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    trueLabel = "Yes",
    falseLabel = "No",
    placeholder = "Select...",
    ...rest
}) {
    // Convert boolean/null to selector value
    const getSelectorValue = () => {
        if (value === true) return 'true';
        if (value === false) return 'false';
        return null; // null or undefined
    };

    // Convert selector value back to boolean/null
    const handleSelectorChange = (selectorValue) => {
        if (selectorValue === 'true') {
            onChange(true);
        } else if (selectorValue === 'false') {
            onChange(false);
        } else {
            onChange(null); // Handle null from selector
        }
    };

    // Determine option keys and display names
    const optionKeys = ['true', 'false'];
    const optionDisplayNames = [trueLabel, falseLabel];

    return (
        <Selector
            value={getSelectorValue()}
            optionKeys={optionKeys}
            optionDisplayNames={optionDisplayNames}
            onChange={handleSelectorChange}
            placeholder={placeholder}
            isFrozen={isFrozen}
            isRequired={isRequired}
            isChanged={isChanged}
            allowNull={allowNull}
            {...rest}
        />
    );
}

export function LabeledBooleanInput({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <BooleanInput isRequired={isRequired} {...rest} />
        </div>
    );
}

/**
 *  A selector with search build in
 * 
 *  NOTE: when you provide `value`, it can be any javascript type, however, internally,
 *      to this component, we are using a <select> element, which only supports string values.
 *      Thus, we internally create a valueStr = value ? value.toString() : '' to use as when
 *      comparing against optionKeys and when setting the <select>'s value. This means that if you use non-string values,
 *      they will be converted to strings for comparison and display purposes.
 * 
 *  NOTE: Similarly when onChange is called, it is called on the matching optionKey, which is a string.
 *        So you will need to convert it back to your type before seting your `value` state variable.
 *        See FundSearchableSelector (SpecialInputs.jsx) for an example of this conversion in action.
 */
export function SearchableSelector({
    value,
    valueDisplayName, // Optional display name for the current value
    optionKeys = [],
    optionDisplayNames = [],
    onChange,
    onCreateNew = null, // Optional (searchTerm) => void; enables a "create new" row
    createNewLabel = "Create new",
    placeholder = "Select...",
    searchPlaceholder = "Search...",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = false,
    isPending = false,
    isError = false,
    error = null,
    maxHeightDropdown = '300px',
}) {
    // When a create action is offered it occupies index 0 of the dropdown's
    // keyboard navigation, shifting the option indices down by one.
    const hasCreate = typeof onCreateNew === 'function';
    const optionOffset = hasCreate ? 1 : 0;
    const valueStr = value ? value.toString() : '';
    const [isOpen, setIsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0, flipped: false, maxHeight: 300 });
    const [needsRepositioning, setNeedsRepositioning] = useState(false);
    const dropdownRef = useRef(null);
    const triggerRef = useRef(null);
    const searchInputRef = useRef(null);
    const optionsContainerRef = useRef(null);

    // Filter options based on search term
    const filteredOptions = searchTerm 
        ? optionKeys.filter((key, index) => {
            const displayName = optionDisplayNames[index] || key;
            return displayName.toLowerCase().includes(searchTerm.toLowerCase());
        })
        : optionKeys;

    // Update dropdown position when open
    const updateDropdownPosition = useCallback(() => {
        if (triggerRef.current && dropdownRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            
            // Use scrollHeight to get the actual content height, not the constrained height
            let actualDropdownHeight = Math.max(
                dropdownRef.current.scrollHeight,
                dropdownRef.current.getBoundingClientRect().height,
                dropdownRef.current.offsetHeight
            );
            
            // If we still can't get a valid height, estimate based on filtered options
            if (!actualDropdownHeight || actualDropdownHeight < 10) {
                const optionCount = filteredOptions ? filteredOptions.length : 0;
                const maxVisibleOptions = 6; // matches your CSS max-height calculation
                const visibleOptions = Math.min(optionCount, maxVisibleOptions);
                const estimatedHeight = (visibleOptions * 36) + 20; // 36px per option + padding
                actualDropdownHeight = estimatedHeight;
            }

            const spaceBelow = viewportHeight - rect.bottom - 8; // 8px margin from bottom
            const spaceAbove = rect.top - 8; // 8px margin from top
            

            // Determine if dropdown should appear above or below
            // Flip up if there's not enough space below AND there's more space above than below
            const shouldFlipUp = spaceBelow < actualDropdownHeight && spaceAbove > spaceBelow;
            
            let top, maxHeight;
            
            if (shouldFlipUp) {
                // Position above the trigger
                maxHeight = Math.min(actualDropdownHeight, spaceAbove);
                top = rect.top + window.scrollY - maxHeight;
            } else {
                // Position below the trigger  
                maxHeight = Math.min(actualDropdownHeight, spaceBelow);
                top = rect.bottom + window.scrollY;
            }
            
            setDropdownPosition({
                top: top,
                left: Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - rect.width - 8)),
                width: rect.width,
                flipped: shouldFlipUp,
                maxHeight: maxHeight
            });
        } else if (triggerRef.current && !dropdownRef.current) {
            // Initial positioning before dropdown is measured
            const rect = triggerRef.current.getBoundingClientRect();
            setDropdownPosition({
                top: rect.bottom + window.scrollY,
                left: Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - rect.width - 8)),
                width: rect.width,
                flipped: false,
                maxHeight: 'none' // Let it render at full height initially
            });
            setNeedsRepositioning(true);
        }
    }, [filteredOptions]);

    // Update position when opening dropdown or when filtered options change
    useEffect(() => {
        if (isOpen) {
            updateDropdownPosition();
            
            // Add scroll and resize listeners to update position
            const handleScroll = () => updateDropdownPosition();
            const handleResize = () => updateDropdownPosition();
            
            window.addEventListener('scroll', handleScroll, true);
            window.addEventListener('resize', handleResize);
            
            return () => {
                window.removeEventListener('scroll', handleScroll, true);
                window.removeEventListener('resize', handleResize);
            };
        }
    }, [isOpen, filteredOptions.length, updateDropdownPosition]);

    // Reposition dropdown after it renders and we can measure its actual height
    useEffect(() => {
        if (needsRepositioning && dropdownRef.current) {
            // Small delay to ensure the dropdown is fully rendered
            const timeoutId = setTimeout(() => {
                updateDropdownPosition();
                setNeedsRepositioning(false);
            }, 0);
            
            return () => clearTimeout(timeoutId);
        }
    }, [needsRepositioning, updateDropdownPosition]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (triggerRef.current && !triggerRef.current.contains(event.target)) {
                // Check if click is on the dropdown (which is now in a portal)
                if (dropdownRef.current && dropdownRef.current.contains(event.target)) {
                    return; // Click is inside dropdown, don't close
                }
                setIsOpen(false);
                setSearchTerm('');
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    // Reset state on Escape key
    const handleEscapeKey = useCallback(() => {
        setIsOpen(false);
        setSearchTerm('');
        setHighlightedIndex(-1);
    }, [ setIsOpen, setSearchTerm, setHighlightedIndex ]);
    useStackedEscapeKey(handleEscapeKey, isOpen);

    // Focus search input when dropdown opens
    useEffect(() => {
        if (isOpen && searchInputRef.current) {
            searchInputRef.current.focus();
            setHighlightedIndex(-1);
        }
    }, [isOpen]);

    // Scroll highlighted option into view
    useEffect(() => {
        if (highlightedIndex >= 0 && optionsContainerRef.current) {
            const optionElements = optionsContainerRef.current.children;
            const highlightedElement = optionElements[highlightedIndex];
            if (highlightedElement) {
                highlightedElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    }, [highlightedIndex]);

    // Handle highlighting based on filtered options
    useEffect(() => {
        if (isOpen) {
            if (filteredOptions.length === 1) {
                setHighlightedIndex(optionOffset);
            } else if (hasCreate && filteredOptions.length === 0 && searchTerm) {
                // Nothing matched but the user typed something: pre-arm "create"
                setHighlightedIndex(0);
            } else {
                setHighlightedIndex(-1);
            }
        }
    }, [filteredOptions.length, isOpen, searchTerm, hasCreate, optionOffset]);

    // Get display text for current value
    const getDisplayText = () => {

        if (value && valueDisplayName) {
            return valueDisplayName;
        }
        
        if (value) {
            const valueIndex = optionKeys.indexOf(valueStr);
            if (valueIndex !== -1 && optionDisplayNames[valueIndex]) {
                return optionDisplayNames[valueIndex];
            }
            return valueStr;
        }

        if (isPending) {
            return (
                <div className={styles.loadingState}>
                    <Spinner size="0.75rem" />
                    <span>Loading...</span>
                </div>
            );
        }

        return <span className={styles.placeholder}>{placeholder}</span>;
    };

    // Handle option selection
    const handleOptionClick = (selectedKey) => {
        onChange(selectedKey);
        setIsOpen(false);
        setSearchTerm('');
        setHighlightedIndex(-1);
    };

    // Hand off to the create-new action, seeding it with the current search
    const handleCreateNew = () => {
        onCreateNew(searchTerm);
        setIsOpen(false);
        setSearchTerm('');
        setHighlightedIndex(-1);
    };

    // Handle search clear
    const handleClearSearch = () => {
        setSearchTerm('');
        setHighlightedIndex(-1);
        if (searchInputRef.current) {
            searchInputRef.current.focus();
        }
    };

    // Handle value clear (allowNull functionality)
    const handleClearValue = () => {
        if (allowNull && value !== null) {
            onChange(null);
        }
    };

    // Handle keyboard navigation in dropdown
    const handleDropdownKeyDown = (e) => {
        if (!isOpen) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setHighlightedIndex(prev =>
                    prev < filteredOptions.length - 1 + optionOffset ? prev + 1 : prev
                );
                break;
            case 'ArrowUp':
                e.preventDefault();
                setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
                break;
            case 'Enter':
                e.preventDefault();
                if (hasCreate && highlightedIndex === 0) {
                    handleCreateNew();
                } else if (highlightedIndex >= optionOffset && highlightedIndex < filteredOptions.length + optionOffset) {
                    handleOptionClick(filteredOptions[highlightedIndex - optionOffset]);
                }
                break;
            case 'Tab':
                // Let tab work normally to move focus away
                setIsOpen(false);
                setSearchTerm('');
                setHighlightedIndex(-1);
                break;
        }
    };

    // Handle dropdown toggle
    const handleToggle = () => {
        if (!isFrozen && !isPending) {
            setIsOpen(!isOpen);
            if (!isOpen) {
                setHighlightedIndex(-1);
            }
        }
    };

    // Handle keyboard events
    const handleKeyDown = (e) => {
        if (isFrozen || isPending) return;
        
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
        }
    };

    // Render frozen state
    if (isFrozen) {
        return (
            <div className={styles.searchableSelectorFrozen}>
                {getDisplayText()}
            </div>
        );
    }

    // Render dropdown content (will be portaled)
    const renderDropdown = () => {
        if (!isOpen || isPending) return null;

        return (
            <div 
                ref={dropdownRef}
                className={`${styles.searchableSelectorDropdownPortal} ${dropdownPosition.flipped ? styles.flipped : ''}`}
                style={{
                    top: dropdownPosition.top,
                    left: dropdownPosition.left,
                    width: dropdownPosition.width,
                    maxHeight: dropdownPosition.maxHeight,
                }}
            >
                <div className={styles.searchableSelectorDropdown} style={{maxHeight: maxHeightDropdown}}>
                    <div className={styles.searchableSelectorSearch}>
                        <div className={styles.searchableSelectorSearchWrapper}>
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder={searchPlaceholder}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                onKeyDown={handleDropdownKeyDown}
                                className={styles.searchableSelectorSearchInput}
                            />
                            {searchTerm && (
                                <button
                                    type="button"
                                    onClick={handleClearSearch}
                                    className={styles.searchableSelectorSearchClear}
                                    aria-label="Clear search"
                                >
                                    <FontAwesomeIcon icon="fa-solid fa-times" />
                                </button>
                            )}
                        </div>
                    </div>
                    
                    <div className={styles.searchableSelectorOptions} ref={optionsContainerRef}>
                        {hasCreate && (
                            <div
                                className={`${styles.searchableSelectorCreate} ${highlightedIndex === 0 ? styles.searchableSelectorOptionHighlighted : ''}`}
                                onClick={handleCreateNew}
                            >
                                <FontAwesomeIcon icon="fa-solid fa-square-plus" />
                                <span>{createNewLabel}{searchTerm ? `: “${searchTerm}”` : ''}</span>
                            </div>
                        )}
                        {isError ? (
                            <div className={styles.searchableSelectorError}>
                                Error loading options: {error?.message || 'Unknown error'}
                            </div>
                        ) : filteredOptions.length === 0 ? (
                            !hasCreate && (
                                <div className={styles.searchableSelectorNoResults}>
                                    {searchTerm ? 'No matching options found' : 'No options available'}
                                </div>
                            )
                        ) : (
                            filteredOptions.map((key, filteredIndex) => {
                                const originalIndex = optionKeys.indexOf(key);
                                const displayName = optionDisplayNames[originalIndex] || key;
                                const isSelected = key === valueStr;
                                const isHighlighted = filteredIndex + optionOffset === highlightedIndex;

                                return (
                                    <div
                                        key={key}
                                        className={`${styles.searchableSelectorOption} ${isSelected ? styles.searchableSelectorOptionSelected : ''} ${isHighlighted ? styles.searchableSelectorOptionHighlighted : ''}`}
                                        onClick={() => handleOptionClick(key)}
                                    >
                                        {displayName}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className={styles.searchableSelectorContainer}>
            <div className={styles.searchableSelectorTriggerWrapper} ref={triggerRef}>
                <div 
                    className={`${styles.searchableSelectorTrigger} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''} ${isPending ? styles.pending : ''}`}
                    onClick={handleToggle}
                    onKeyDown={handleKeyDown}
                    tabIndex={0}
                    role="combobox"
                    aria-expanded={isOpen}
                    aria-haspopup="listbox"
                    aria-disabled={isPending}
                >
                    <div className={styles.searchableSelectorValue}>
                        {getDisplayText()}
                    </div>
                    <div className={styles.searchableSelectorIcon}>
                        {isPending ? (
                            <Spinner size="1rem" />
                        ) : (
                            <FontAwesomeIcon 
                                icon={isOpen ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down"} 
                                size="xs"
                            />
                        )}
                    </div>
                </div>
                {allowNull && (
                    <ClearButton value={value} onClear={handleClearValue} />
                )}
            </div>

            {/* Portal the dropdown to document.body */}
            {isOpen && createPortal(renderDropdown(), document.body)}
        </div>
    );
}

export function LabeledSearchableSelector({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <SearchableSelector isRequired={isRequired} {...rest} />
        </div>
    );
}

export function SingleFileInput({
    value, // Should be a File object or null
    onChange,
    accept, // File type restrictions (e.g., "image/*", ".pdf,.doc")
    nullPlaceholder = "No file selected",
    isFrozen = true,
    isRequired = false,
    isChanged = false,
    allowNull = true,
    ...rest
}) {
    const fileInputRef = useRef(null);

    // Handle file selection
    const handleFileChange = (e) => {
        const file = e.target.files?.[0] || null;
        onChange(file);
    };

    // Handle clear button click
    const handleClear = () => {
        if (allowNull && value !== null) {
            onChange(null);
            // Reset the input element's value
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    // Get display text for frozen state
    const getDisplayText = () => {
        if (!value) {
            return <span className={styles.placeholder}>{nullPlaceholder}</span>;
        }
        return (
            <span>
                {value.name} ({(value.size / 1024).toFixed(1)} KB)
            </span>
        );
    };

    // Handle click on frozen display (to show file info)
    const handleFrozenClick = () => {
        if (value && !isFrozen) {
            // Could potentially show more file details or trigger download
            console.log('File details:', {
                name: value.name,
                size: value.size,
                type: value.type,
                lastModified: new Date(value.lastModified)
            });
        }
    };

    return isFrozen ? (
        <div className={styles.textInputFrozen} onClick={handleFrozenClick}>
            {getDisplayText()}
        </div>
    ) : (
        <div className={styles.textInputContainer}>
            <input
                ref={fileInputRef}
                className={`${styles.textInput} ${isChanged ? styles.changed : ''} ${isRequired ? styles.required : ''}`}
                type="file"
                onChange={handleFileChange}
                accept={accept}
                {...rest}
            />
            {allowNull && (
                <ClearButton value={value} onClear={handleClear} />
            )}
        </div>
    );
}

export function LabeledSingleFileInput({
    label,
    isRequired = false,
    ...rest
}) {
    return (
        <div className={styles.labelContainer}>
            <InputLabel label={label} isRequired={isRequired} />
            <SingleFileInput isRequired={isRequired} {...rest} />
        </div>
    );
}
