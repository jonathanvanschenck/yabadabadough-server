import { useEffect, useState } from 'react';

/**
 * A copy of `value` that only updates once it has stopped changing for
 * `delayMs`. Turns fast-changing input (e.g. a search box) into a calm value
 * suitable for a query parameter, without firing a request per keystroke.
 */
export function useDebouncedValue(value, delayMs = 300) {
    const [ debounced, setDebounced ] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
}
