import { CardErrorSection } from './Card.jsx';
import { SpinnerButton } from './Buttons.jsx';
import styles from './VersionGate.module.css';
import { useVersionQuery } from '../hooks/Queries.jsx';
import LoadingPlaceholder from '../contexts/LoadingPlaceholder.jsx';

export function VersionGate({ children }) {
    const { data, isPending, isError, error, isRefetching } = useVersionQuery();

    if (isPending) {
        return <LoadingPlaceholder description="Checking version..." />;
    }

    if (isError) {
        return (
            <div className={styles.container}>
                <div className={styles.innerContainer}>
                    <h2 className={styles.title}>Version Check Failed</h2>
                    <CardErrorSection
                        errorMessage={error?.message ?? 'Could not reach the server.'}
                        errorMessageDetails={error?.details?.message}
                    />
                    <SpinnerButton
                        text="Reload"
                        isPending={isRefetching}
                        onClick={() => window.location.reload()}
                        buttonClassName={styles.reloadButton}
                    />
                </div>
            </div>
        );
    }

    const isStale = data && data.webapp !== __APP_VERSION__;

    if (isStale) {
        return (
            <div className={styles.container}>
                <div className={styles.innerContainer}>
                    <h2 className={styles.title}>Update Available</h2>
                    <p className={styles.message}>
                        A new version of this app has been deployed. Please reload to get the latest version.
                    </p>
                    <p className={styles.versions}>
                        <span>You are Running: <code>{__APP_VERSION__}</code></span>
                        <span>Server Requires: <code>{data.webapp}</code></span>
                    </p>
                    <SpinnerButton
                        text="Reload"
                        onClick={() => window.location.reload()}
                        buttonClassName={styles.reloadButton}
                    />
                </div>
            </div>
        );
    }

    return children;
}
