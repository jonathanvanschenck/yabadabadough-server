/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useCallback, useMemo, useRef } from 'react';



export const LogContext = createContext(null);

export function useLogger(namespace) {
    const context = useContext(LogContext);
    if ( !context.log ) {
        throw new Error("useLogger must be used within a LogContextProvider");
    }
    const context_log = context.log;

    const _log = useCallback((level, ...args) => {
        context_log({namespace, level}, ...args);
    }, [context_log, namespace]);

    const log = useMemo(() => {
        return {
            debug: (...args) => _log("debug", ...args),
            info: (...args) => _log("info", ...args),
            warn: (...args) => _log("warn", ...args),
            error: (...args) => _log("error", ...args),
        };
    }, [_log]);

    return log;
}

export function LogContextProvider({ children }) {
    const start = useRef(Date.now());

    const card = "padding: 0.2rem 0.5rem; border-radius: 0.25rem; margin-right: 0.5rem; border: 1px solid";

    const log = useCallback(({namespace,level,timeColor="darkgreen"},...args) => {
        let level_str = "";
        let level_style = "";
        let console_func = null;
        switch(level) {
            case "debug":
                level_str = "DEBUG";
                level_style = "color: gray; font-weight: bold;"+ card;
                console_func = console.debug;
                break;
            case "info":
                level_str = "INFO";
                level_style = "color: darkslateblue; font-weight: bold;"+ card;
                console_func = console.info;
                break;
            case "warn":
                level_str = "WARN";
                level_style = "color: darkorange; font-weight: bold;" + card;
                console_func = console.info; // Use console.info for warnings, to prevent devtools from adding obtrusive warning icons
                break;
            case "error":
                level_str = "ERROR";
                level_style = "color: darkred; font-weight: bold; " + card;
                console_func = console.error;
                break;
            default:
                level_str = "????";
                level_style = "color: darkred; font-weight: bold; " + card;
                console_func = console.error;
        }

        const elapsed = Date.now() - start.current;
        const miliseconds = (elapsed % 1000).toString().padStart(3, '0');
        const seconds = Math.floor((elapsed / 1000) % 60).toString().padStart(2, '0');
        const minutes = Math.floor((elapsed / (1000 * 60)) % 60).toString().padStart(2, '0');
        const hours = Math.floor((elapsed / (1000 * 60 * 60))).toString().padStart(2, '0');
        const elapsed_str = `+${hours}:${minutes}:${seconds}.${miliseconds}`;

        console_func(
            "%c%s%c%s%c%s",
            `color: ${timeColor}; font-weight: bold; `+card, elapsed_str,
            level_style, level_str,
            "color: blueviolet; font-weight: bold; margin-right: 0.5rem", `${namespace}`,
            ...args
        );
    }, []);


    log({namespace:"LogContext", level:"info", timeColor:"darkorange" }, "Logger initialized");

    return (
        <LogContext.Provider value={{ log }}>
            {children}
        </LogContext.Provider>
    );
}
