/* eslint-disable react-refresh/only-export-components */

import { createContext, useState, useReducer, useCallback, useEffect, useRef, useContext } from 'react'

import { useLogger } from './LogContext.jsx'

import styles from './AuthContext.module.css'

import LoadingPlaceholder from './LoadingPlaceholder.jsx'

import Spinner from '../components/Spinner.jsx'

import { Card, CardSection, CardActionFooter } from '../components/Card.jsx'

export class APIError extends Error {
    constructor(status) {
        super(`APIError: ${status}`);
        this.status = status;
        this.details = null;
    }

    add_details(details) {
        this.details = details;
        return this;
    }
}

export function getJWTExpirationTimeMs(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('Invalid token: must be a non-empty string');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT: must have 3 parts separated by dots');
    }

    try {
        // Get the payload (second part)
        const payload = parts[1];
        
        // Add padding if needed for base64 decoding
        const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);
        
        // Decode base64url
        const decodedPayload = atob(paddedPayload.replace(/-/g, '+').replace(/_/g, '/'));
        
        // Parse JSON
        const payloadObj = JSON.parse(decodedPayload);
        
        // Extract exp claim and convert to milliseconds
        if (typeof payloadObj.exp !== 'number') {
            throw new Error('JWT payload missing or invalid exp claim');
        }
        
        return payloadObj.exp * 1000; // Convert from seconds to milliseconds
    } catch (error) {
        throw new Error('Failed to parse JWT expiration: ' + error.message);
    }
}

export function parseURL(obj) {
    if ( obj instanceof URL ) {
        return obj;
    }

    if ( typeof(obj) == "string" ) {
        return new URL(obj, window.location.origin);
    }

    const pathname = obj.pathname || obj.path || "";
    let search = obj.search || obj.query || "";
    if ( search instanceof URLSearchParams ) {
        search = search.toString();
    } else if ( typeof(search) == "object" ) {
        // Remove undefined values
        search = new URLSearchParams(Object.entries(search).filter(([_, v]) => v !== undefined)).toString();
    } else {
        search = new URLSearchParams(search).toString();
    }
    if ( search && !search.startsWith("?") ) {
        search =   "?" + search;
    }

    let hash = obj.hash || "";
    if ( hash && !hash.startsWith("#") ) {
        hash = "#" + hash;
    }

    return new URL(pathname + search + hash, window.location.origin);
}

export const AuthContext = createContext(null);
export const AuthLogoutContext = createContext(null);
export const AuthEscalationContext = createContext(null);
export const AuthRolesContext = createContext(null);
export const AuthedFetchContext = createContext(null);

export function useAuthedFetch() {
    const context = useContext(AuthedFetchContext);
    if (!context?.authedFetch) {
        throw new Error('useAuthedFetch must be used within AuthedFetchContextProvider');
    }
    return context.authedFetch;
};

export function useAuthedFetchJSON() {
    const context = useContext(AuthedFetchContext);
    if (!context?.authedFetchJSON) {
        throw new Error('useAuthedFetchJSON must be used within AuthedFetchContextProvider');
    }
    return context.authedFetchJSON;
};

export function useAuthedFetchAllJSON() {
    const context = useContext(AuthedFetchContext);
    if (!context?.authedFetchAllJSON) {
        throw new Error('useAuthedFetchAllJSON must be used within AuthedFetchContextProvider');
    }
    return context.authedFetchAllJSON;
};

export function useAuth() {
    const auth = useContext(AuthContext);
    if ( auth === null ) {
        throw new Error("useAuth must be used within an AuthContextProvider");
    }
    return auth;
}
export function useAuthRoles() {
    const auth = useContext(AuthContext);
    if ( auth === null ) {
        throw new Error("useAuth must be used within an AuthContextProvider");
    }
    return auth.roles;
}
export function useEscalation() {
    const auth = useContext(AuthContext);
    const { escalateCallback, deescalateCallback } = useContext(AuthEscalationContext) || {};
    if ( auth === null || escalateCallback === undefined || deescalateCallback === undefined ) {
        throw new Error("useEscalation must be used within an AuthContextProvider");
    }
    return { isAdminable: auth.roles?.adminable, isAdmin: auth.roles?.admin || false, escalate: escalateCallback, deescalate: deescalateCallback };
}
export function useLogout() {
    const logoutCallback = useContext(AuthLogoutContext);
    if ( logoutCallback === null ) {
        throw new Error("useLogout must be used within an AuthContextProvider");
    }
    return logoutCallback;
}


const MIN_DISPLAY_TIME = 300; // Minimum time to show the loading placeholder (in ms)

const InitialAuthState = {
    neverQueried: true,
    isAuthed: false,
    disableAuth: false,
    identifier: null,
    userId: null,
    roles: {
        admin: false,
        adminable: false,
        editor: false,
        reader: false
    },
    expiration: null
};
const Unauthed = {
    neverQueried: false,
    isAuthed: false,
    disableAuth: false,
    identifier: null,
    userId: null,
    roles: {
        admin: false,
        adminable: false,
        editor: false,
        reader: false
    },
    expiration: null
};

/**
 * Map a server auth response ({ user, session, tokens } -- from login,
 * refresh, or authenticate) onto the fields our auth actions carry.
 *
 * `user.roles` is the server's EFFECTIVE role set (admin implies all); its
 * `admin` maps to our `adminable`, since actual admin mode is a client-side,
 * per-request sudo escalation (the x-sudo-mode header).
 */
function extractAuthFields(data) {
    return {
        identifier: data.user.email,
        userId: data.user.id,
        server_roles: {
            adminable: data.user.roles.admin,
            editor: data.user.roles.editor,
            reader: data.user.roles.reader,
        },
        expiration: getJWTExpirationTimeMs(data.tokens.access),
    };
}

function useAuthReducer() {
    const log = useLogger("AuthReducer");
    const [ auth, dispatch ] = useReducer(authReducer, InitialAuthState);
    const authRef = useRef(auth);

    const wrappedDispatch = useCallback((action) => {
        if (action.msg) log[action.msgLevel??"debug"](action.msg);
        dispatch({ action, authRef, log });
    }, [log]);
    return [ auth, wrappedDispatch, authRef ];
}


function authReducer(auth, { action, authRef, log }) {
    switch ( action.type ) {
        case "escalate_to_admin": {
            if ( !auth.roles?.adminable ) {
                log.warn(`User ${auth.identifier} attempted to escalate to admin mode, but not adminable`);
                return auth; // Can't escalate if not adminable
            }

            const newAuth = { ...auth, roles: { ...auth.roles, admin: true } };
            authRef.current = newAuth;
            return newAuth;
        }
        case "deescalate_from_admin": {
            if ( !auth.roles?.admin ) {
                log.warn(`User ${auth.identifier} attempted to deescalate from admin mode, but not currently in admin mode`);
                return auth; // Can't deescalate if not currently admin
            }

            const newAuth = { ...auth, roles: { ...auth.roles, admin: false } };
            authRef.current = newAuth;
            return newAuth;
        }
        case "authenticate":
        case "login":
        case "refresh": {
            const newAuth = {
                neverQueried: false,
                isAuthed: true,
                disableAuth: false,
                identifier: action.identifier,
                userId: action.userId,
                roles: {
                    adminable: !!action.server_roles.adminable,
                    editor: !!action.server_roles.editor,
                    reader: !!action.server_roles.reader,
                },
                expiration: action.expiration
            };
            // Keep admin if sync with adminable, but mask it out if we weren't previously in admin mode)
            newAuth.roles.admin = newAuth.roles.adminable && (authRef.current?.roles?.admin || false);
            authRef.current = newAuth;
            return newAuth;
        }
        case "auth_disabled": {
            // The server runs with auth disabled (YDD_DISABLE_AUTH): every
            // gate is bypassed server-side, so grant every role locally and
            // skip the token machinery entirely (expiration null disables
            // the refresh timers). admin still starts masked -- sudo mode
            // stays an explicit escalation, same as a real login.
            const newAuth = {
                neverQueried: false,
                isAuthed: true,
                disableAuth: true,
                identifier: "auth-disabled",
                userId: null,
                roles: {
                    adminable: true,
                    admin: false,
                    editor: true,
                    reader: true
                },
                expiration: null
            };
            authRef.current = newAuth;
            return newAuth;
        }
        case "logout":
        case "expired":
        case "first_login_failed":
        case "refresh_failed": {
            // Return current auth if already matches Unauthed state
            if (auth.neverQueried === Unauthed.neverQueried &&
                auth.isAuthed === Unauthed.isAuthed && 
                auth.identifier === Unauthed.identifier && 
                auth.expiration === Unauthed.expiration ) {
                return auth;
            }
            const newAuth = { ...Unauthed };
            authRef.current = newAuth;
            return newAuth;
        }
        default: {
            throw new Error("Unsupported auth action: "+action.type);
        }
    }
}

export function AuthContextProvider({ children }) {

    const dialogRef = useRef(null);
    const refreshTimerRef = useRef(null);
    const [ auth, dispatch, authRef ] = useAuthReducer();

    const firstRenderTime = useRef(Date.now());
    const delayTimer = useRef(null);

    const logoutCallback = useCallback(async ()=>{
        // Nothing to log out of when the server runs with auth disabled --
        // and dropping our authed state would just dead-end at a login
        // modal that cannot succeed
        if ( authRef.current?.disableAuth ) return;

        const resp = await fetch(
            "/api/auth/logout",
            { 
                method: "POST",
                credentials: "include" // Include cookies for authentication
            }
        );

        if ( !resp.ok ) {
            const data = await resp.json();
            const err = Error(`APIError (${resp.status}): ${data.message}`)
            err.status = resp.status;
            throw err;
        }

        return dispatch({ type: "logout", msg: "User called logoutCallback" });
    }, [
        dispatch,
        authRef,
    ]);

    const escalateCallback = useCallback(() => dispatch({ type: "escalate_to_admin", msg: `User requested to escalated to admin mode` }), [dispatch]);
    const deescalateCallback = useCallback(() => dispatch({ type: "deescalate_from_admin", msg: `User requested to deescalated from admin mode` }), [dispatch]);

    // Create a memoized promise for refresh calls
    const refreshPromiseRef = useRef(null);
    const resolveOnRefresh = useCallback(async ({
        failedMsg = "Token auto refresh failed during authedFetch request",
        failedType = "expired",
        refreshMsg = "Token auto refreshed during authedFetch request"
    } = {}) => {
        // Auth disabled server-side: nothing to refresh, nothing can expire
        if ( authRef.current?.disableAuth ) return true;

        if (refreshPromiseRef.current) {
            return refreshPromiseRef.current;
        }

        // Save a ref to the promise. The auth_token cookie is rotated by
        // every successful refresh (single-use), but that's invisible to us:
        // the cookies are httpOnly and ride along via credentials: "include"
        refreshPromiseRef.current = fetch("/api/auth/refresh", {
            method: "POST",
            credentials: "include"
        }).then(resp => {
            if ( !resp.ok ) return null;
            return resp.json();
        }).then((info) => {
            if ( !info ) {
                dispatch({ type: failedType, msg: failedMsg, msgLevel: "warn" });
                return false;
            }

            dispatch({
                type: "refresh",
                ...extractAuthFields(info),
                msg: refreshMsg
            });
            return true;

        }).finally(() => {
            // Once the promise resolves, clear the ref
            refreshPromiseRef.current = null;
        });

        // Return the promise
        return refreshPromiseRef.current;
    }, [ dispatch, authRef ]);

    const authedFetch = useCallback(async (url, opts)=>{

        if ( !authRef.current?.isAuthed ) throw new Error("Cannot authedFetch without authentication");

        const fetchOptions = {
            method: opts.method || "GET",
            headers: opts.headers || {},
            body: opts.body || null,
            credentials: 'include',
        };


        // Set sudo-mode based on if we have set admin role
        fetchOptions.headers['x-sudo-mode'] = authRef.current?.roles?.admin ? "true" : "false";

        // Auto serialize JSON bodies
        if ( fetchOptions.body && !fetchOptions.headers['Content-Type'] ) {
            fetchOptions.headers['Content-Type'] = 'application/json';
            if ( typeof(fetchOptions.body) != "string" ) {
                fetchOptions.body = JSON.stringify(fetchOptions.body);
            }
        }

        const resp = await fetch(url, fetchOptions);

        if ( resp.status != 401 ) return resp;

        // Try to refresh the token
        const refreshSucceeded = await resolveOnRefresh();
        if ( !refreshSucceeded ) return resp; // Returns the original 401 response

        // Once refreshed, retry the original request
        return fetch(url, fetchOptions);
    }, [
        resolveOnRefresh,
        authRef
    ]);

    const authedFetchJSON = useCallback(async (_url, options={})=>{
        const url = parseURL(_url);

        const response = await authedFetch(url.toString(), options);
        if (!response.ok) {
            const error = new APIError(response.status);
            try {
                const errorData = await response.json();
                error.add_details(errorData);
            } catch (_) {
                // Ignore JSON parsing errors
            }
            throw error;
        }
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return response.json();
        } else {
            return response.text();
        }
    }, [
        authedFetch,
    ])

    const authedFetchAllJSON = useCallback(async (_url, options={})=>{

        // Assume if you are giving me a body, you want to page via body
        const queryLocation = options.queryLocation || ( options.body ? "body" : "search" );

        const url = parseURL(_url);

        const batchSize = (queryLocation == "search" ? url.searchParams.get("limit") : options.body?.limit)
            || options.batchSize
            || 100;
        let allResults = [];

        let offset = 0;
        let total = null;

        while (total === null || offset < total) {
            const batchUrl = new URL(url);
            const batchOptions = JSON.parse(JSON.stringify(options)); // Deep copy

            if ( queryLocation == "search" ) {
                batchUrl.searchParams.set("limit", batchSize);
                batchUrl.searchParams.set("offset", offset);
            } else if ( queryLocation == "body" ) {
                if ( batchOptions.body ) {
                    batchOptions.body.limit = batchSize;
                    batchOptions.body.offset = offset;
                }
            } else {
                throw new Error("Invalid queryLocation: "+queryLocation);
            }

            const response = await authedFetch(batchUrl, batchOptions);
            if (!response.ok) {
                const error = new APIError(response.status);
                try {
                    const errorData = await response.json();
                    error.add_details(errorData);
                } catch (_) {
                    // Ignore JSON parsing errors
                }
                throw error;
            }

            total = parseInt(response.headers.get("X-Total-Count") || 0);
            if (isNaN(total)) {
                const error = new APIError(0);
                error.add_details({ message: "Invalid total count in response headers" });
                throw error;
            }

            const data = await response.json();

            if ( !Array.isArray(data) ) {
                const error = new APIError(0);
                error.add_details({ message: "Expected an array of results" });
                throw error;
            }

            offset += data.length;
            allResults = allResults.concat(data);

            // Catch case where API returns fewer results than requested, indicating no more data
            if (data.length === 0) {
                break;
            }
        }

        return allResults;
    }, [
        authedFetch,
    ]);

    // Attempt to authenticate on the first mount
    useEffect(() => {
        let ignore = false;

        // Anti-flicker: hold the loading placeholder for MIN_DISPLAY_TIME
        // before dispatching a success that arrived faster than that
        function delayedDispatch(action) {
            const elapsed = Date.now() - firstRenderTime.current;
            if ( firstRenderTime.current && elapsed < MIN_DISPLAY_TIME ) {
                delayTimer.current = setTimeout(() => dispatch(action), MIN_DISPLAY_TIME - elapsed);
            } else {
                dispatch(action);
            }
        }

        !async function(){
            // The server may run with auth disabled (YDD_DISABLE_AUTH, dev
            // only) -- when it does, short-circuit the login workflow
            // entirely. Any failure here just falls through to the normal
            // authenticate flow.
            try {
                const modeResp = await fetch("/api/auth/mode");
                if ( ignore ) return;
                if ( modeResp.ok ) {
                    const { disable_auth } = await modeResp.json();
                    if ( ignore ) return;
                    if ( disable_auth ) {
                        return delayedDispatch({
                            type: "auth_disabled",
                            msg: "Server reports auth is disabled; skipping the login workflow",
                            msgLevel: "warn"
                        });
                    }
                }
            } catch (_) {
                // Fall through to the normal authenticate flow
            }

            const resp = await fetch(
                "/api/auth/authenticate",
                {
                    body: JSON.stringify({ auto_refresh: true }),
                    headers: {
                        "Content-Type": "application/json"
                    },
                    method: "POST",
                    credentials: "include" // Include cookies for authentication
                }
            );
            if ( ignore ) return;

            if ( !resp.ok ) return dispatch({ type: "first_login_failed", msg: "Initial authentication attempt failed", msgLevel: "info" });

            const data = await resp.json();

            if ( ignore ) return;

            delayedDispatch({
                type: "authenticate",
                ...extractAuthFields(data),
                msg: "Initial authentication attempt succeeded"
            });
        }();

        return () => {
            ignore = true;
            if ( delayTimer.current ) {
                clearTimeout(delayTimer.current);
            }
        };
    }, [
        dispatch,
    ]);

    // Schedule a refresh whenever a new token comes in (check expiration changes).
    // No expiration means nothing to refresh (auth disabled server-side).
    useEffect(() => {
        clearTimeout(refreshTimerRef.current);
        if ( auth.isAuthed && auth.expiration ) {
            // 20 seconds before the access token expires (floored, in case we
            // mounted with a token already near expiry), so this runs before
            // the on-focus refresh threshold kicks in
            const delay = Math.max(auth.expiration - Date.now() - 20e3, 5e3);

            refreshTimerRef.current = setTimeout(() => {
                resolveOnRefresh({
                    failedMsg: "Token refresh timer failed",
                    failedType: "refresh_failed",
                    refreshMsg: "Token refresh timer succeeded"
                });
            }, delay);
        }
        return () => clearTimeout(refreshTimerRef.current);
    }, [
        resolveOnRefresh,
        auth, // We get a new auth object on every change (including refreshes/logouts)
    ]);

    // Handle page visibility and focus changes to refresh tokens when needed
    useEffect(() => {
        function handleVisibilityOrFocus() {
            if (!authRef.current?.expiration) return;

            const now = Date.now();
            const timeUntilExpiry = (authRef.current?.expiration??0) - now;

            // If token expires within 10 seconds or has already expired, refresh it
            const refreshThreshold = 10 * 1000;
            
            if (timeUntilExpiry <= refreshThreshold) {
                resolveOnRefresh({
                    failedMsg: "Token refresh failed on page focus/visibility change",
                    failedType: "expired",
                    refreshMsg: "Token refreshed on page focus/visibility change due to expiration"
                });
            }
        }
        
        document.addEventListener('visibilitychange', handleVisibilityOrFocus);
        window.addEventListener('focus', handleVisibilityOrFocus);
        window.addEventListener('blur', handleVisibilityOrFocus);
        
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
            window.removeEventListener('focus', handleVisibilityOrFocus);
            window.removeEventListener('blur', handleVisibilityOrFocus);
        };
    }, [
        resolveOnRefresh,
        authRef
    ]);

    // Pop open the dialog when needed
    useEffect(() => {
        if ( !dialogRef.current ) return;
        if ( auth.neverQueried ) return;
        if ( auth.isAuthed ) return;

        // Save a reference
        const el = dialogRef.current;
        el.showModal();
        return () => el.close();
    }, [
        auth
    ]);

    const isReader = auth.roles?.reader || false;
    return (
        <AuthContext value={ auth }>
            <AuthEscalationContext value={ { escalateCallback, deescalateCallback } }>
                <AuthLogoutContext value={ logoutCallback }>
                    <AuthedFetchContext value={ { authedFetch, authedFetchJSON, authedFetchAllJSON } }>
                        { auth.neverQueried
                            ? <LoadingPlaceholder description="Verifying user" animateDelay={MIN_DISPLAY_TIME}/>
                            : !auth.isAuthed
                                ? <LoginModal ref={ dialogRef } dispatchAuthUpdate={dispatch} /> 
                                : !isReader
                                    ? <NotReaderFallback logout={logoutCallback} auth={auth}/>
                                    : children
                        }
                    </AuthedFetchContext>
                </AuthLogoutContext>
            </AuthEscalationContext>
        </AuthContext>
    );
}

function NotReaderFallback({ logout, auth }) {
    const identifier = auth?.identifier || "???";
    return (
        <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection:"column", justifyContent: "center", alignItems: "center", padding: "1rem", fontSize: "1.5rem" }}>
            <Card>
                <div style={{ maxWidth: "40rem" }}>
                    <CardSection title="Access Denied">
                        <p style={{ textAlign: 'center' }}>
                            Your account '<span style={{ color: 'var(--font-secondary-color)' }}>{identifier}</span>' does not have sufficient permissions to view this content.
                            Please contact your administrator to resolve this issue.
                        </p>
                        <p style={{ textAlign: 'center' }}>(Note, you will need to logout and log-in again once your permissions have been updated)</p>
                    </CardSection>
                    <CardActionFooter>
                        <button onClick={logout} style={{ padding: '0.75rem 1.5rem' }}>Logout</button>
                    </CardActionFooter>
                </div>
            </Card>
        </div>
    );
}



import logoBadge from '/svg/logo-badge.svg'

function LoginModal({ ref, dispatchAuthUpdate }) {

    const [ email, setEmail ] = useState(null);
    const [ password, setPassword ] = useState(null);
    const [ isPending, setIsPending ] = useState(false);
    const [ errorMsg, setErrorMsg ] = useState(null);

    async function onLoginAttempt(e) {
        e.preventDefault();

        if ( isPending ) return;
        setIsPending(true);
        setErrorMsg(null);

        try {
            const resp = await fetch("/api/auth/login", {
                body: JSON.stringify({ email, password }),
                headers: {
                    "Content-Type": "application/json"
                },
                method: "POST"
            });

            if ( resp.ok ) {
                const data = await resp.json();
                return dispatchAuthUpdate({
                    type: "login",
                    ...extractAuthFields(data),
                    msg: "User logged in successfully"
                });
            };

            const { message } = await resp.json();
            setErrorMsg(message);
        } finally {
            setIsPending(false);
        }
    };

    return (
        <dialog ref={ ref } className={styles.loginModal}>
            <div className={styles.loginContainer}>
                <div className={styles.iconContainer}>
                    <img src={ logoBadge }/>
                </div>
                <div className={styles.spacer}></div>
                <div className={ styles.formContainer }>
                    <form className={ styles.loginForm } onSubmit={ onLoginAttempt }>
                        <h3>Yabadaba Dough Login</h3>
                        <p>Please sign in with your account email</p>
                        <div className={styles.row }>
                            <label for="email-input">Email:</label>
                            <input type="email" name="email" autocomplete="username" id="email-input" placeholder="Email" onChange={ (e) => setEmail(e.target.value) } value={ email } required/>
                        </div>
                        <div className={ styles.row }>
                            <label for="password-input">Password:</label>
                            <input type="password" name="password" autocomplete="current-password" id="password-input" placeholder="Password" onChange={ (e) => setPassword(e.target.value) } value={ password } required/>
                        </div>
                        <div>
                            <button className={styles.loginButton + " flex-center"} disabled={ isPending }>
                                <span>Submit</span>
                                { isPending && <Spinner marginLeft="0.5rem"/> }
                            </button>
                        </div>
                        { errorMsg && 
                            <div>
                                <p className={ styles.loginErrorMsg }>{ errorMsg }</p>
                            </div>
                        }
                    </form>
                </div>
            </div>
        </dialog>
    );
}

export default LoginModal
