import { useEffect } from 'react';
import { isPrimaryModifierPressed, isSecondaryModifierPressed } from '../../../utils/platform';
import { useStableCallbacks } from '../../../hooks/useStableCallbacks';

// src/components/app/lattice/useLatticeToggleHotkey.ts
// A visible collection owns Ctrl/Cmd+B before the global queue shortcut sees it.
export function useLatticeToggleHotkey(enabled: boolean, onToggle: () => void) {
    const { toggle } = useStableCallbacks({ toggle: onToggle });
    useEffect(() => {
        if (!enabled) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.repeat || event.key.toLowerCase() !== 'b'
                || !isPrimaryModifierPressed(event) || isSecondaryModifierPressed(event)
                || event.altKey || event.shiftKey) return;
            if (event.target instanceof Element
                && event.target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            toggle();
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [enabled, toggle]);
}
