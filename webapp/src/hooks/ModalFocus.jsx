import { useEffect } from 'react';

/**
 * Modal focus management: trap Tab inside the open modal, and hand focus back
 * to whatever opened it on dismissal.
 *
 * Shaped like the escape-key stack in StackedEscapeKey.jsx, and for the same
 * reason: only the TOP-MOST entry is live, so a nested modal takes over
 * cleanly and hands control back when it closes. One capture-phase listener
 * for the whole app rather than one per modal.
 *
 * WARNING : like that hook, this assumes it is the only Tab-trapping listener
 * in the app. It does NOT stopPropagation (components still need their own
 * Tab handling for things like combobox navigation) -- it only preventDefaults
 * the browser's move when focus would otherwise leave the modal.
 */
const GLOBAL_STACK = [];

// Everything the browser would normally tab through
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

// Controls we treat as "the first field" for INITIAL focus. Buttons are
// deliberately excluded so a modal never opens with a destructive (or close)
// action focused -- they are still reachable by Tab, just not the landing spot.
const AUTOFOCUS_FALLBACK_SELECTOR = [
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="combobox"]:not([aria-disabled="true"])',
].join(', ');

/**
 * Overlays that portal to document.body -- the date-picker popup and the
 * searchable-selector dropdown -- are visually inside the modal but DOM-wise
 * outside it, so a naive `container.contains(...)` test would read them as
 * "focus escaped" and yank it back mid-interaction. They drive their own
 * keyboard handling, so the trap stands down while focus is inside one.
 */
const OVERLAY_SELECTOR = '[data-focus-overlay]';

// A control scrolled out of view is still tabbable; one that is display:none
// (a collapsed section, a hidden branch) is not.
function isVisible(el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
}

function focusablesIn(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

function globalTabHandler(event) {
    if ( event.key !== 'Tab' || GLOBAL_STACK.length === 0 ) return;

    const container = GLOBAL_STACK[GLOBAL_STACK.length - 1].trapRef.current;
    if ( !container ) return;

    const active = document.activeElement;
    if ( active?.closest?.(OVERLAY_SELECTOR) ) return;

    const items = focusablesIn(container);
    if ( items.length === 0 ) {
        // Nothing to land on, but focus still must not fall through to the
        // page behind the modal
        event.preventDefault();
        return;
    }

    const first = items[0];
    const last = items[items.length - 1];

    // Focus is loose in the page behind us (or on <body>, where it lands when
    // a modal opens with nothing focusable): pull it in from the right end
    if ( !container.contains(active) ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
    }

    // Wrap at the ends; everything in between is the browser's own business
    if ( event.shiftKey && active === first ) {
        event.preventDefault();
        last.focus();
    } else if ( !event.shiftKey && active === last ) {
        event.preventDefault();
        first.focus();
    }
}

if ( typeof window !== 'undefined' ) {
    window.addEventListener(
        'keydown',
        globalTabHandler,
        {
            capture: true, // ahead of any component-level Tab handling
            passive: false, // we call preventDefault
        }
    );
}

/**
 * Trap focus inside `trapRef` while `active`, and restore it on teardown.
 *
 * @param {object} trapRef - Ref to the element focus may not leave. This is the
 *   WHOLE modal, header included, so the close button stays tabbable.
 * @param {object} initialFocusRef - Ref to the subtree to take initial focus
 *   from: a `[data-autofocus]` control if the modal names one, else the first
 *   form control. Usually the modal's BODY, so the close button is never what
 *   a modal opens on. Falls back to the trap container itself, which keeps
 *   read-only modals announced and tabbing from a sane place.
 * @param {boolean} active - Whether the modal is open.
 */
export function useModalFocus(trapRef, initialFocusRef, active = true) {
    useEffect(() => {
        if ( !active ) return;

        // Captured BEFORE we move focus anywhere. For a nested modal this is a
        // control in the parent modal -- exactly where focus belongs when the
        // child closes.
        const restoreTo = document.activeElement;

        const entry = { trapRef };
        GLOBAL_STACK.push(entry);

        // After paint, so async and portaled children have settled
        const raf = requestAnimationFrame(() => {
            const container = initialFocusRef.current;
            const target = container?.querySelector('[data-autofocus]')
                ?? container?.querySelector(AUTOFOCUS_FALLBACK_SELECTOR)
                ?? trapRef.current;
            target?.focus();
        });

        return () => {
            cancelAnimationFrame(raf);

            const i = GLOBAL_STACK.indexOf(entry);
            if ( i !== -1 ) GLOBAL_STACK.splice(i, 1);

            // Hand focus back so tabbing resumes where it left off instead of
            // restarting at the top of the document. Guarded on the element
            // still being in the document: whatever opened the modal may have
            // been unmounted by the modal's own work (a deleted row's button).
            // <body> is what `activeElement` reports when the modal was opened
            // from a keyboard shortcut rather than a click. Focusing it would
            // only blur, so leave focus alone in that case.
            if ( restoreTo instanceof HTMLElement
                && restoreTo !== document.body
                && document.contains(restoreTo) ) {
                restoreTo.focus();
            }
        };
    }, [active, trapRef, initialFocusRef]);
}
