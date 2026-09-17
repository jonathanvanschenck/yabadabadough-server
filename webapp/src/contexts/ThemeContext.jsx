/* eslint-disable react-refresh/only-export-components */

/**
 * Color theme preference: "light" | "dark" | "system".
 *
 * The PREFERENCE is what the user picked and is persisted per-browser in
 * localStorage (like the other UI prefs -- hidden columns, the auto-fund
 * toggle). The RESOLVED theme is always a concrete "light" | "dark" (system
 * follows the OS via prefers-color-scheme, live) and is what gets written to
 * `<html data-theme>`, which is the ONLY switch public/styles.css looks at.
 *
 * index.html carries a tiny inline script that performs the same read +
 * resolution before the stylesheet loads, so the first paint is already
 * correct; STORAGE_KEY / the value set / the resolution rule there must
 * match this file.
 *
 * Sits OUTSIDE AuthContext in the provider stack so the login/setup modals
 * and the loading placeholder are themed too.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const STORAGE_KEY = 'ydd:theme';
export const THEME_PREFERENCES = Object.freeze(['light', 'dark', 'system']);
const DEFAULT_PREFERENCE = 'system';

const ThemeContext = createContext(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredPreference() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return THEME_PREFERENCES.includes(stored) ? stored : DEFAULT_PREFERENCE;
    } catch {
        return DEFAULT_PREFERENCE; // storage blocked (private mode, etc.)
    }
}

function systemTheme() {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolve(preference) {
    return preference === 'system' ? systemTheme() : preference;
}

export function ThemeContextProvider({ children }) {
    const [ preference, setPreferenceState ] = useState(readStoredPreference);
    // Tracked in state (not derived) so an OS-level switch re-renders consumers
    // like the logo swap, not just the stylesheet.
    const [ resolved, setResolved ] = useState(() => resolve(preference));

    // Apply the resolved theme to <html>, and follow the OS while on "system".
    useEffect(() => {
        const apply = () => {
            const next = resolve(preference);
            setResolved(next);
            document.documentElement.dataset.theme = next;
        };
        apply();
        if ( preference !== 'system' ) return undefined;
        const mql = window.matchMedia(DARK_QUERY);
        mql.addEventListener('change', apply);
        return () => mql.removeEventListener('change', apply);
    }, [ preference ]);

    const setPreference = useCallback((next) => {
        if ( !THEME_PREFERENCES.includes(next) ) {
            throw new Error(`Unknown theme preference: ${next}`);
        }
        setPreferenceState(next);
        try {
            if ( next === DEFAULT_PREFERENCE ) {
                localStorage.removeItem(STORAGE_KEY);
            } else {
                localStorage.setItem(STORAGE_KEY, next);
            }
        } catch {
            // Storage blocked: the choice still applies for this page load.
        }
    }, []);

    const value = useMemo(() => ({ preference, resolved, setPreference }), [ preference, resolved, setPreference ]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

/**
 * @returns {{ preference: 'light'|'dark'|'system', resolved: 'light'|'dark', setPreference: (p: string) => void }}
 */
export function useTheme() {
    const context = useContext(ThemeContext);
    if ( !context ) {
        throw new Error("useTheme must be used within a ThemeContextProvider");
    }
    return context;
}
