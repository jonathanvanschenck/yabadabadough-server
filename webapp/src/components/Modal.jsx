
import { useRef, useState, useEffect, useCallback } from 'react';

import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';
import { useModalFocus } from '../hooks/ModalFocus.jsx';

import { Card, CardActionHeader, CardActionFooter, CardSection, CardErrorSection } from './Card.jsx';

import { CloseButton, SpinnerButton } from './Buttons.jsx';

import styles from './Modal.module.css';


const MODAL_SIZE_CLASS = {
    sm: styles.sizeSm,
    md: styles.sizeMd,
    lg: styles.sizeLg,
};

export function CardModal({ isOpen, setIsOpen, title, level, children, size = 'md', cardClassName='' }) {

    const closeModal = useCallback(() => setIsOpen(false), [setIsOpen]);
    useStackedEscapeKey(closeModal, isOpen);

    // Focus lives in one place for every modal in the app (37 of them route
    // through here): trap Tab, and hand focus back on dismissal.
    //   - the TRAP is the whole container, so the header close button stays
    //     tabbable
    //   - INITIAL focus is scoped to the body, so a modal never opens on the
    //     close button
    // Nested modals stack, and only the top-most one traps.
    const containerRef = useRef(null);
    const formRef = useRef(null);
    useModalFocus(containerRef, formRef, isOpen);

    return (
        isOpen
        ? <div
            className={styles.modalContainer}
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            // Focusable only as the last-resort landing spot for a modal with
            // no form control at all; tabindex -1 keeps it out of the tab order
            tabIndex={-1}
        >
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
