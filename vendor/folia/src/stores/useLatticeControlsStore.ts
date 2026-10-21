import { create } from 'zustand';

// src/stores/useLatticeControlsStore.ts
// The mounted wall publishes its focus action and the visibility of its current-song chrome.
type LatticeControlsState = {
    mountedWalls: number;
    registerWall: () => () => void;
    focusCurrentSong: (() => void) | null;
    isCurrentSongPosterVisible: boolean;
    registerFocus: (action: (() => void) | null) => () => void;
    setCurrentSongPosterVisible: (visible: boolean) => void;
};

export const useLatticeControlsStore = create<LatticeControlsState>((set, get) => ({
    mountedWalls: 0,
    registerWall: () => {
        let registered = true;
        set(state => ({ mountedWalls: state.mountedWalls + 1 }));
        return () => {
            if (!registered) return;
            registered = false;
            set(state => ({ mountedWalls: state.mountedWalls - 1 }));
        };
    },
    focusCurrentSong: null,
    isCurrentSongPosterVisible: true,
    registerFocus: action => {
        set({ focusCurrentSong: action });
        return () => {
            if (get().focusCurrentSong === action) set({ focusCurrentSong: null });
        };
    },
    setCurrentSongPosterVisible: visible => set(state => (
        state.isCurrentSongPosterVisible === visible
            ? state
            : { isCurrentSongPosterVisible: visible }
    )),
}));

export const setLatticeCurrentSongPosterVisible = (visible: boolean) => (
    useLatticeControlsStore.getState().setCurrentSongPosterVisible(visible)
);

export const focusLatticeCurrentSong = () => {
    const action = useLatticeControlsStore.getState().focusCurrentSong;
    if (!action) return false;
    action();
    return true;
};
