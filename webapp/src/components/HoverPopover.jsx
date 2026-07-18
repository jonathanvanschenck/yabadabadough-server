import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './HoverPopover.module.css';

/**
 * A lightweight anchored popover: shows `children` on hover of `trigger`, and
 * click-to-pin so touch users (no hover) can open and keep it open. Rendered in
 * a portal at `document.body` with fixed positioning, so it is never clipped by
 * a scrolling/overflow ancestor (e.g. the transactions grid). Closes on scroll,
 * resize, Escape, and outside click while pinned.
 *
 * The trigger swallows its own pointer events (stopPropagation) so wrapping it
 * inside a click/drag-selectable surface doesn't start a selection or dismiss it.
 */
export function HoverPopover({ trigger, children, className = '', triggerClassName = '' }) {
    const triggerRef = useRef(null);
    const popoverRef = useRef(null);
    const [ hovering, setHovering ] = useState(false);
    const [ pinned, setPinned ] = useState(false);
    const [ pos, setPos ] = useState(null);
    const open = hovering || pinned;

    const computePos = useCallback(() => {
        const el = triggerRef.current;
        if ( el == null ) return;
        const r = el.getBoundingClientRect();
        // Anchor the popover's right edge to the trigger's right edge (the cell
        // content is right-aligned), just below it; the CSS translates it left.
        // Clamp so it can't run off the right edge of the viewport.
        setPos({ top: r.bottom + 4, left: Math.min(r.right, window.innerWidth - 8) });
    }, []);

    // Hover is tracked with NATIVE mouseenter/mouseleave on the trigger element,
    // not React's synthetic onMouseLeave. The popover renders in a portal that is
    // a React-tree child of this span, so React treats hovering the portal card as
    // still "inside" the trigger and keeps a hover-only card open until the pointer
    // leaves the card too -- and since a card can overlap a neighboring trigger,
    // scanning across several gets stuck. Native mouseleave fires as soon as the
    // pointer leaves the trigger's OWN DOM box (the portal lives elsewhere in the
    // DOM), so a hover-only card closes immediately on leaving the icon. Pin
    // (click) to keep it open for interaction.
    useEffect(() => {
        const el = triggerRef.current;
        if ( el == null ) return;
        const onEnter = () => setHovering(true);
        const onLeave = () => setHovering(false);
        el.addEventListener('mouseenter', onEnter);
        el.addEventListener('mouseleave', onLeave);
        return () => {
            el.removeEventListener('mouseenter', onEnter);
            el.removeEventListener('mouseleave', onLeave);
        };
    }, []);

    // Position while open, and close on any scroll/resize (fixed coords go stale)
    useEffect(() => {
        if ( !open ) return;
        computePos();
        const dismiss = () => { setHovering(false); setPinned(false); };
        window.addEventListener('scroll', dismiss, true);
        window.addEventListener('resize', dismiss);
        return () => {
            window.removeEventListener('scroll', dismiss, true);
            window.removeEventListener('resize', dismiss);
        };
    }, [open, computePos]);

    // Pinned-only: dismiss on outside click / Escape
    useEffect(() => {
        if ( !pinned ) return;
        const onPointerDown = (e) => {
            if ( triggerRef.current?.contains(e.target) || popoverRef.current?.contains(e.target) ) return;
            setPinned(false);
        };
        const onKeyDown = (e) => { if ( e.key === 'Escape' ) setPinned(false); };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [pinned]);

    return (
        <span
            ref={triggerRef}
            className={triggerClassName}
            onClick={(e) => { e.stopPropagation(); setPinned(prev => !prev); }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {trigger}
            { open && pos != null && createPortal(
                <div
                    ref={popoverRef}
                    className={`${styles.popover} ${className}`}
                    style={{ top: pos.top, left: pos.left }}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    {children}
                </div>,
                document.body
            )}
        </span>
    );
}
