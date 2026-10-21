import { useEffect, useRef } from 'react';

// src/components/visualizer/tempera/useTemperaWorkshopKeyboard.ts
// Keep Escape/Tab inside this portal so the settings window and the playing track stay untouched.
export function useTemperaWorkshopKeyboard(isOpen: boolean, onClose: () => void) {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        if (!isOpen) return;
        const previous = document.activeElement as HTMLElement | null;
        const dialog = () => document.querySelector('[data-tempera-workshop-body]')?.closest<HTMLElement>('[role="dialog"]');
        const focusable = () => Array.from(dialog()?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="file"]), [tabindex="0"]') ?? [])
            .filter(element => element.getClientRects().length > 0);
        const timer = window.setTimeout(() => focusable()[0]?.focus(), 0);
        const keydown = (event: KeyboardEvent) => {
            if (!dialog()) return;
            if (event.key === 'Escape') {
                // An open backup menu owns the first Escape; don't close two layers at once.
                if (dialog()?.querySelector('[role="menu"]')) return;
                event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
            } else if (event.key === 'Tab') {
                event.stopPropagation();
                const items = focusable();
                const index = items.indexOf(document.activeElement as HTMLElement);
                if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
                    event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0]?.focus();
                }
            } else {
                // The underlying command palette also consumes Enter/arrows globally. Let the
                // focused button/range keep its native default action, without routing a song or
                // a palette command. Ctrl+K must not open a second palette over an unsaved draft.
                event.stopPropagation();
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') event.preventDefault();
            }
        };
        window.addEventListener('keydown', keydown, true);
        return () => { clearTimeout(timer); window.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
    }, [isOpen]);
}
