
import { useCallback, useEffect } from 'react'
import { Outlet, useNavigate, NavLink, useLocation } from 'react-router'

import './Icons.jsx'

import logo from '/svg/logo.svg'
import styles from './AppLayout.module.css'

import { AuthContextProvider, useAuth, useLogout, useEscalation } from './contexts/AuthContext.jsx'
import { VersionGate } from './components/VersionGate.jsx'
import { LogContextProvider, useLogger } from './contexts/LogContext.jsx'
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import {
    SocketIOContextProvider,
    useSocket,
} from './contexts/SocketIOContext.jsx'

const queryClient = new QueryClient()

function AppLayout() {
    return (
        <LogContextProvider>
            <QueryClientProvider client={queryClient}>
                <AuthContextProvider>
                    <SocketIOContextProvider>
                        <VersionGate>
                            <App />
                        </VersionGate>
                    </SocketIOContextProvider>
                </AuthContextProvider>
            </QueryClientProvider>
        </LogContextProvider>
    );
}


function EscalationModeToggler() {
    const { isAdmin, isAdminable, escalate, deescalate } = useEscalation();

    if ( !isAdminable ) return null;

    const handleToggle = () => {
        if (isAdmin) {
            deescalate();
        } else {
            escalate();
        }
    };

    return (
        <button
            className={`${styles.escalationToggle} ${isAdmin ? styles.sudoMode : styles.plebMode}`}
            onClick={handleToggle}
            title={isAdmin ? "Click to exit sudo mode" : "Click to enter sudo mode"}
        >
            {isAdmin ? "Sudo Mode" : "Pleb Mode"}
        </button>
    );
}

function App() {
    const auth = useAuth();
    const logout = useLogout();
    const navigate = useNavigate();
    const location = useLocation();
    const { socket } = useSocket();

    const log = useLogger("App");

    const attemptLogout = useCallback(() => {
        logout();
        navigate("/");
    }, [ logout, navigate ]);

    useEffect(() => {
        const url = location.pathname + location.search + location.hash;
        log.info("Navigated to:", url);
        socket.emit("page_view", {
            url,
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
        });
    }, [ location, socket, log ]);

    const email = auth.identifier ?? "Unknown";
    const full_identifier = email.split("@")[0];
    const identifier = full_identifier.length < 13 ? full_identifier : full_identifier.slice(0,10)+"...";

    return (<>
        <div className={ styles.container }>
            <div className={ styles.navBar }>
                <div className={ styles.iconContainer }>
                    <img src={ logo }/>
                </div>
                <div className={ styles.navBarLinks }>
                    <NavLink to="/">Home</NavLink>
                    <NavLink to="/funds">Funds</NavLink>
                </div>
                <EscalationModeToggler />
                <div style={{ "text-align": "center" }}>
                    { identifier }
                </div>
                <button
                    className={ styles.logoutButton }
                    onClick={ attemptLogout }
                    disabled={!auth.isAuthed || auth.disableAuth}
                >
                    logout
                </button>
                <div className={ styles.versionLabel }>v{ __APP_VERSION__ }</div>
            </div>
            <div className={ styles.mainContents }>
                <Outlet />
            </div>
        </div>
        <div className={ styles.sudoOverlay } data-admin={auth.roles.admin}></div>
    </>);
}

export default AppLayout;
