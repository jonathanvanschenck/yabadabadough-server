/* eslint-disable react-refresh/only-export-components */

import { createContext, useEffect, useContext, useState, useRef } from "react";
import { io } from "socket.io-client";
import { useQueryClient } from '@tanstack/react-query'

import { useAuth } from "./AuthContext.jsx";
import LoadingPlaceholder from './LoadingPlaceholder.jsx'
import { useLogger } from "./LogContext.jsx";

export const SocketIOContext = createContext(null);

const MIN_DISPLAY_TIME = 300; // Minimum time to show the loading placeholder (in ms)

export function SocketIOContextProvider({ children }) {

    const auth = useAuth();
    if ( !auth.isAuthed ) {
        // We depend on the AuthContext to handle login, and also attach a valid cookie to our request
        throw new Error("SocketIOContextProvider expects an AuthContext provider up the tree");
    }
    const [ socket, setSocket ] = useState(null);
    const [ isConnected, setIsConnected ] = useState(false);
    const firstRenderTime = useRef(Date.now());
    const delayTimer = useRef(null);
    const log = useLogger("SocketIO");

    const queryClient = useQueryClient();
    useEffect(()=>{
        const newSocket = io({});

        newSocket.on("connect", () => {
            log.info("Socket connected");
            if ( firstRenderTime.current && Date.now() - firstRenderTime.current < MIN_DISPLAY_TIME ) {
                // If we connect within 1 second of the first render, show the loading placeholder for a bit
                delayTimer.current = setTimeout(() => {
                    setIsConnected(true);
                }, MIN_DISPLAY_TIME - ( Date.now() - firstRenderTime.current));
            } else {
                // Otherwise, connect immediately
                setIsConnected(true);
            }
        });

        newSocket.on("disconnect", () => {
            log.warn("Socket disconnected");
            setIsConnected(false);
        });

        newSocket.on("clean_queries", (source, meta, actions) => {
            log.info("Remote clean query request from", source, ":", JSON.stringify(meta));
            log.debug("Cleaning: ", actions);
            for ( const action of actions ) {
                queryClient[action.method](...action.args);
            }
        });

        setSocket(newSocket);
        return () => {
            newSocket.off("clean_queries");
            newSocket.close();
            if ( delayTimer.current ) {
                clearTimeout(delayTimer.current);
            }
        };
    }, [ log, queryClient ]);

    return (
        <SocketIOContext value={ { socket, isConnected } }>
            {
                isConnected
                    ? children
                    : <LoadingPlaceholder description="Connecting to server" animateDelay={MIN_DISPLAY_TIME}/>
            }
        </SocketIOContext>
    );
}


export function useSocket() {
    const context = useContext(SocketIOContext);
    if (!context) {
        throw new Error('useSocket must be used within SocketIOContextProvider');
    }
    return context;
};
