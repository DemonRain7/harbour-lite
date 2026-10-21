import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { clearTemperaLayerImage } from '../../../services/temperaLayerImages';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { isTemperaPoolWriteLocked, type TemperaPoolBusyAction } from './TemperaImageLayerDialog';
import { sameTemperaPool, unusedTemperaDraftIds, type TemperaImageLayerCommit } from './temperaWorkshopModel';

// src/components/visualizer/tempera/useTemperaPoolDraft.ts
// Blob writes belong to a draft until Save. Cancel never deletes the original pool.
export function useTemperaPoolDraft(
    live: TemperaImageLayerCommit,
    onCommit: (next: TemperaImageLayerCommit) => void,
    t: TFunction,
    initiallyOpen = false,
    onClosed?: () => void,
) {
    const [isDialogOpen, setDialogOpen] = useState(initiallyOpen);
    const [draft, setDraft] = useState(live);
    const [error, setError] = useState('');
    const [busy, updateBusy] = useState<TemperaPoolBusyAction>('idle');
    const busyRef = useRef<TemperaPoolBusyAction>('idle');
    const baseRef = useRef(live);
    const liveRef = useRef(live);
    liveRef.current = live;
    const createdIdsRef = useRef(new Set<string>());
    const activeWriteAbortRef = useRef<AbortController | null>(null);
    const isMountedRef = useRef(true);
    const dirty = !sameTemperaPool(draft, baseRef.current);

    const setBusy = useCallback((action: TemperaPoolBusyAction) => {
        // The ref closes the gap between two events in the same React batch.
        busyRef.current = action;
        if (isMountedRef.current) updateBusy(action);
    }, []);
    const discardCreated = useCallback(() => {
        const unused = unusedTemperaDraftIds(createdIdsRef.current, liveRef.current.layerImages);
        createdIdsRef.current.clear();
        void Promise.all(unused.map(id => clearTemperaLayerImage(id).catch(() => undefined)));
    }, []);
    const open = useCallback(() => {
        if (busyRef.current !== 'idle') return;
        baseRef.current = liveRef.current;
        setError('');
        setDraft(liveRef.current);
        setDialogOpen(true);
    }, []);
    const cancel = useCallback(() => {
        if (isTemperaPoolWriteLocked(busyRef.current)) return;
        discardCreated();
        setDialogOpen(false);
        onClosed?.();
    }, [discardCreated, onClosed]);
    const requestClose = useCallback(() => {
        if (isTemperaPoolWriteLocked(busyRef.current)) return;
        if (dirty && !window.confirm(t('options.temperaWorkshopDiscardConfirm'))) return;
        cancel();
    }, [cancel, dirty, t]);
    const commit = useCallback(() => {
        if (isTemperaPoolWriteLocked(busyRef.current)) return;
        if (dirty && !sameTemperaPool(baseRef.current, liveRef.current)) {
            setError(t('options.temperaWorkshopConflict'));
            setStatusMessage({ type: 'error', text: t('options.temperaWorkshopConflict') });
            return;
        }
        try {
            setError('');
            if (dirty) onCommit(draft);
        } catch (error) {
            console.error('[Tempera] image workshop commit failed:', error);
            setError(t('options.temperaWorkshopSaveFailed'));
            setStatusMessage({ type: 'error', text: t('options.temperaWorkshopSaveFailed') });
            return;
        }
        const unused = unusedTemperaDraftIds([
            ...createdIdsRef.current, ...(dirty ? baseRef.current.layerImages.map(image => image.id) : []),
        ], draft.layerImages);
        createdIdsRef.current.clear();
        // Persist the new references before reclaiming anything from the original pool.
        void Promise.all(unused.map(id => clearTemperaLayerImage(id).catch(() => undefined)));
        setDialogOpen(false);
        if (dirty) setStatusMessage({ type: 'success', text: t('options.temperaWorkshopSaved') });
        onClosed?.();
    }, [dirty, draft, onCommit, onClosed, t]);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            activeWriteAbortRef.current?.abort();
            // An outer host disappearing is not an implicit Save. Pending I/O also checks abort
            // after storage resolves, so its late records cannot escape this cleanup.
            discardCreated();
        };
    }, [discardCreated]);
    return { draft, setDraft, isDialogOpen, dirty, error, busy, busyRef, setBusy, open, cancel, requestClose, commit,
        createdIdsRef, activeWriteAbortRef, isMountedRef };
}
