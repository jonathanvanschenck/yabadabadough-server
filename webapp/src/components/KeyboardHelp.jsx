import { Fragment } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { CardModal } from './Modal.jsx';
import { CardSection } from './Card.jsx';

import styles from './KeyboardHelp.module.css';

/**
 * Floating keyboard-shortcuts affordance: a small fixed button in the
 * bottom-right corner of the screen that opens a modal documenting the
 * page's keyboard shortcuts. Rendered by pages that HAVE shortcuts (it
 * documents page-specific keys, so it doesn't belong in the app chrome).
 *
 * `isOpen`/`setIsOpen` are controlled by the caller so the page's own "?"
 * shortcut can open the same modal. `groups` is
 * `[{ title, shortcuts: [{ keys: ["J", "↓"], description }] }]` -- multiple
 * keys in one entry render as alternatives ("J or ↓").
 */
export function FloatingKeyboardHelp({ isOpen, setIsOpen, title = 'Keyboard shortcuts', intro = null, groups = [] }) {
    return (<>
        <button
            type="button"
            className={styles.floatingButton}
            aria-label="Show keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setIsOpen(true)}
        >
            <FontAwesomeIcon icon="fa-keyboard" />
        </button>
        <CardModal title={title} isOpen={isOpen} setIsOpen={setIsOpen} size="md">
            { intro &&
                <CardSection>
                    <p className={styles.intro}>{intro}</p>
                </CardSection>
            }
            { groups.map(group => (
                <CardSection key={group.title} title={group.title}>
                    <div className={styles.shortcutList}>
                        { group.shortcuts.map((shortcut, i) => (
                            <div key={i} className={styles.shortcutRow}>
                                <span className={styles.keys}>
                                    { shortcut.keys.map((key, j) => (
                                        <Fragment key={j}>
                                            { j > 0 && <span className={styles.keySep}>or</span> }
                                            <kbd className={styles.kbd}>{key}</kbd>
                                        </Fragment>
                                    ))}
                                </span>
                                <span className={styles.shortcutDescription}>{shortcut.description}</span>
                            </div>
                        ))}
                    </div>
                </CardSection>
            ))}
        </CardModal>
    </>);
}
