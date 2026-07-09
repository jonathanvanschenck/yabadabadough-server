import styles from './CopiedToast.module.css';

export default function CopiedToast({ visible, message = 'Copied!' }) {
    return (
        <span className={`${styles.toast} ${visible ? styles.visible : ''}`} aria-live="polite">
            {message}
        </span>
    );
}
