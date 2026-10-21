import { useEffect, useState } from 'react';

// src/hooks/useHarbourFoliaPresentation.ts
// Only the host's discrete presentation changes update React; no playback subscription or polling.
type HarbourPresentation = 'embedded' | 'window' | 'background';

export function useHarbourFoliaPresentation(): HarbourPresentation | null {
    const [presentation, setPresentation] = useState<HarbourPresentation | null>(() => {
        const bridge = typeof window === 'undefined' ? undefined : window.harbourFolia;
        // A new hosted renderer must not briefly expose native-window controls before its first reply.
        return bridge?.getPresentation || bridge?.onPresentationChanged ? 'embedded' : null;
    });

    useEffect(() => {
        const bridge = window.harbourFolia;
        if (!bridge) return;

        let cancelled = false;
        let receivedChange = false;
        const update = (next: HarbourPresentation) => {
            if (!cancelled) setPresentation(current => current === next ? current : next);
        };
        // Subscribe first; a reply captured before any later event must not restore stale chrome.
        const unsubscribe = bridge.onPresentationChanged?.(next => {
            receivedChange = true;
            update(next);
        });
        void bridge.getPresentation?.().then(next => {
            if (!receivedChange) update(next);
        }).catch(() => {
            // Keep the conservative initial state if the host is not available yet.
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    return presentation;
}
