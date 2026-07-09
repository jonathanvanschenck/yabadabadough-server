
import { useEffect } from 'react';

const GLOBAL_STACK = new Set();

/**
 * A hook that manages a global stack of dismissal handlers.
 *
 * WARNING : this hook assumes NO ONE ELSE is listening for the escape key. To prevent conflicts,
 * we capture the event before anyone else can see it, and then stop its propagation. If you want
 * to use escape keys for something else -- tough luck bro.
 */
function globalEscapeHandler(event) {
    if ( event.key !== 'Escape' || GLOBAL_STACK.size === 0 ) return;

    event.preventDefault();
    event.stopPropagation(); // prevent any other escape handlers from firing
    event.stopImmediatePropagation(); // prevent any other captured escape handlers from firing

    const topOfStack = Array.from(GLOBAL_STACK).at(-1); // NOTE: modern js ensures the order of the set is maintained over time
    if ( typeof topOfStack === 'function' ) {
        topOfStack();
    }
}

if ( typeof window !== 'undefined' ) {
    window.addEventListener(
        'keydown',
        globalEscapeHandler,
        {
            capture: true, // Make sure we are the only escape handler that fire by capturing the event first
            passive: false, // We want to be able to call preventDefault
        }
    );
}

/**
 * A hook that adds a an event hanlder to the global escape key stack when active.
 * When the escape key is pressed, only the top-most handler in the stack will be called.
 *
 * @param {Function} onEscapeKeyDown - The handler to call when the escape key is pressed.
 * @param {boolean} active - Whether the handler should be active.
 */
export function useStackedEscapeKey(onEscapeKeyDown, active = true) {
    useEffect(() => {
        if ( !active ) return;

        GLOBAL_STACK.add(onEscapeKeyDown);
        return () => {
            GLOBAL_STACK.delete(onEscapeKeyDown); // NOTE : when this clean up runs, react will work background magic to ensure the "onEscapeKeyDown" refernces the original value we added
        }
    }, [active, onEscapeKeyDown]);
}
