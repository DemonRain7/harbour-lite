import { useEffect, useState } from 'react';
import { useHarbourFoliaPresentation } from './useHarbourFoliaPresentation';

// src/hooks/useHarbourVisualActivity.ts
// Host visibility is authoritative for a reparented native view. This never
// pauses audio, transport, queue preparation or automix; only visual consumers.
export function isHarbourVisualActive(presentation: 'embedded' | 'window' | 'background' | null, hidden: boolean) {
    return presentation === null ? !hidden : presentation !== 'background';
}

export function useHarbourVisualActivity() {
    const presentation = useHarbourFoliaPresentation();
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
    useEffect(() => {
        const update = () => setHidden(document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    return isHarbourVisualActive(presentation, hidden);
}
