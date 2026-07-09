
import { useEffect, useState, useCallback } from 'react';

import { useStackedEscapeKey } from '../hooks/StackedEscapeKey.jsx';

import { Card, CardActionHeader, CardActionFooter, CardSection, CardErrorSection } from './Card.jsx';

import { CloseButton, SpinnerButton } from './Buttons.jsx';

import styles from './Modal.module.css';


export function CardModal({ isOpen, setIsOpen, title, level, children, cardClassName='' }) {

    const closeModal = useCallback(() => setIsOpen(false), [setIsOpen]);
    useStackedEscapeKey(closeModal, isOpen);

    return (
        isOpen
        ? <div className={styles.modalContainer}>
            <Card className={`${cardClassName} ${styles.cardBaseStyles}`}>
                <CardActionHeader title={title} level={level}>
                    <CloseButton onClick={() => setIsOpen(false)} />
                </CardActionHeader>
                <div className={styles.modalFormContainer}>
                    { children }
                </div>
            </Card>
        </div>
        : null
    );
}

export function ConfirmationModal({ isOpen, setIsOpen, title, message, content, onConfirm, confirmText='Confirm', confirmButtonClassName='', buttonIsDisabled=false }) {

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
        <CardModal isOpen={isOpen} setIsOpen={setIsOpen} title={title} level={2} cardClassName={styles.confirmationModalCard}>
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
