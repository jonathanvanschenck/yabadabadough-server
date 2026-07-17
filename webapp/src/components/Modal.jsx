
import { useEffect, useRef, useState, useCallback } from 'react';

import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';

import { Card, CardActionHeader, CardActionFooter, CardSection, CardErrorSection } from './Card.jsx';

import { CloseButton, SpinnerButton } from './Buttons.jsx';

import styles from './Modal.module.css';


const MODAL_SIZE_CLASS = {
    sm: styles.sizeSm,
    md: styles.sizeMd,
    lg: styles.sizeLg,
};

// Controls we treat as "the first field" for initial focus. Buttons are
// deliberately excluded so a modal never opens with a destructive/close action
// focused; a modal with no form control (e.g. a read-only view) simply opens
// with nothing focused, which is fine — Escape still works via the global
// capture-phase stack, not DOM focus.
const AUTOFOCUS_FALLBACK_SELECTOR = [
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="combobox"]:not([aria-disabled="true"])',
].join(', ');

export function CardModal({ isOpen, setIsOpen, title, level, children, size = 'md', cardClassName='' }) {

    const closeModal = useCallback(() => setIsOpen(false), [setIsOpen]);
    useStackedEscapeKey(closeModal, isOpen);

    // Move focus into the modal when it opens: a [data-autofocus]-flagged
    // control if the modal declares one, else the first focusable form control.
    // Scoped to the form container so the header close button is never the
    // fallback. Runs after paint (rAF) so async/portaled children settle first.
    // Nested modals each run their own copy of this effect against their own
    // container, so opening a child never fights the parent's initial focus.
    const formRef = useRef(null);
    useEffect(() => {
        if (!isOpen) return;
        const raf = requestAnimationFrame(() => {
            const container = formRef.current;
            if (!container) return;
            const target = container.querySelector('[data-autofocus]')
                ?? container.querySelector(AUTOFOCUS_FALLBACK_SELECTOR);
            target?.focus();
        });
        return () => cancelAnimationFrame(raf);
    }, [isOpen]);

    return (
        isOpen
        ? <div className={styles.modalContainer}>
            <Card className={`${cardClassName} ${styles.cardBaseStyles} ${MODAL_SIZE_CLASS[size] ?? MODAL_SIZE_CLASS.md}`}>
                <CardActionHeader title={title} level={level}>
                    <CloseButton onClick={() => setIsOpen(false)} />
                </CardActionHeader>
                <div className={styles.modalFormContainer} ref={formRef}>
                    { children }
                </div>
            </Card>
        </div>
        : null
    );
}

export function ConfirmationModal({ isOpen, setIsOpen, title, message, content, onConfirm, confirmText='Confirm', confirmButtonClassName='', buttonIsDisabled=false, size='md' }) {

    const [ error, setError ] = useState(null);
    const [ isPending, setIsPending ] = useState(false);

    const closeModal = useCallback(() => setIsOpen(false), [setIsOpen]);
    useStackedEscapeKey(closeModal, isOpen);

    // Reset error when modal is opened/closed
    useEffect(() => {
        if (!isOpen) {
            setError(null);
            setIsPending(false);
        }
    }, [isOpen]);

    const handleConfirm = useCallback(async () => {
        try {
            setIsPending(true);
            await onConfirm();
            setIsPending(false);
            setIsOpen(false);
        } catch (err) {
            setIsPending(false);
            setError({
                message: err?.message || 'An error occurred',
                details: err?.details?.message
            });
        }
    }, [onConfirm, setIsOpen, setError]);

    return (
        <CardModal isOpen={isOpen} setIsOpen={setIsOpen} title={title} level={2} size={size}>
            <CardSection>
                { message && <p>{message}</p> }
                { content }
            </CardSection>
            <CardActionFooter>
                <SpinnerButton
                    text={confirmText}
                    isPending={isPending}
                    disabled={buttonIsDisabled}
                    buttonClassName={confirmButtonClassName}
                    onClick={handleConfirm}
                    ariaLabel="Confirm"
                />
            </CardActionFooter>
            {error && (
                <CardErrorSection
                    errorMessage={error.message}
                    errorMessageDetails={error.details}
                />
            )}
        </CardModal>
    );
}
