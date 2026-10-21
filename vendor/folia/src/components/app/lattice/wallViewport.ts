import { BLOCK_COLS, BLOCK_ROWS, SLOTS_PER_BLOCK } from './blockTemplates';
import type { WallMetrics } from './layout';

// src/components/app/lattice/wallViewport.ts
// Overview density is independent of the queue length and the offscreen render ceiling.
export const TARGET_VISIBLE_POSTERS = 30;

/** Keep the next row ready outside the screen, independently of overview zoom/DPI. */
export function getLatticeRenderOverscan(width: number, height: number, scale: number): number {
    const screenPadding = Math.min(480, Math.max(320, Math.min(width, height) * 0.55));
    return screenPadding / Math.max(0.1, scale);
}

/** Fit about 30 mixed-size posters, including the partially visible edge cards. */
export function getLatticeViewportScale(width: number, height: number, metrics: WallMetrics): number {
    // Preserve the existing touch-sized cards on phones.
    if (width < 640 || height <= 0) return 0.52;
    const meanSide = Math.sqrt(BLOCK_COLS * BLOCK_ROWS / SLOTS_PER_BLOCK)
        * (metrics.cellSize + metrics.gap);
    // (width / side + 1) * (height / side + 1) ~= target. The +1 terms account for
    // edge cards; an area-only estimate would noticeably overshoot the requested density.
    const interior = TARGET_VISIBLE_POSTERS - 1;
    const perimeter = width + height;
    const side = (perimeter + Math.sqrt(perimeter * perimeter + 4 * interior * width * height))
        / (2 * interior);
    return side / meanSide;
}
