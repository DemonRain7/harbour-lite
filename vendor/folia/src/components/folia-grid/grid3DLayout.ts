// src/components/folia-grid/grid3DLayout.ts

/** Scale the spacing and falloff with the cards, not just their pixels. This
 * preserves the desktop focus profile when an embedded host is height-limited. */
export const resolveGrid3DLayout = (
    coverSize: number,
    viewportHeight: number,
    rowExtraHeight: number,
    preferredPeakScale: number,
) => {
    const availableHeight = Math.max(0, viewportHeight - 32);
    const rowHeight = Math.max(1, coverSize + rowExtraHeight);
    const peakScale = Math.min(preferredPeakScale, availableHeight / rowHeight);
    const fit = peakScale / preferredPeakScale;
    return {
        peakScale,
        minScale: peakScale * (0.5 / preferredPeakScale),
        // Native scroll offsets / offsetLeft are pixel-snapped. Whole-pixel
        // slots avoid accumulating centering errors when moving both ways.
        cardPitch: Math.max(1, Math.round((coverSize + 48) * fit)),
        focusDistance: Math.max(1, 600 * fit),
    };
};
