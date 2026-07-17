
import { Link, useRouteError, isRouteErrorResponse } from 'react-router';

import styles from './RouteError.module.css';

/**
 * Root-route ErrorBoundary. React Router renders this in place of the whole
 * route subtree when a route component throws during render (or a loader
 * rejects), instead of falling back to the framework's raw dev error screen.
 * Kept self-contained: it renders OUTSIDE the AppLayout chrome, so it links
 * home rather than assuming any surrounding navigation.
 */
function RouteError() {
    const error = useRouteError();

    let message;
    if (isRouteErrorResponse(error)) {
        message = `${error.status} ${error.statusText}`;
    } else if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    } else {
        message = 'An unexpected error occurred.';
    }

    return (
        <div className={styles.container}>
            <div className={styles.card}>
                <h2 className={styles.title}>Something broke</h2>
                <p className={styles.lede}>
                    The page hit an unexpected error and couldn&apos;t finish loading.
                </p>
                { message && (
                    <pre className={styles.detail}>{message}</pre>
                ) }
                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={() => window.location.reload()}
                    >
                        Reload
                    </button>
                    <Link to="/" className={styles.link}>Go Home</Link>
                </div>
            </div>
        </div>
    );
}

export default RouteError;
