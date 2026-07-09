import { useState, useCallback } from 'react';

export function useCopyToClipboard(duration = 1500) {
    const [copied, setCopied] = useState(false);

    const copy = useCallback((text) => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), duration);
        });
    }, [duration]);

    return { copied, copy };
}
