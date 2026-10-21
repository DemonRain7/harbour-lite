import { describe, expect, it, vi } from 'vitest';
import { TemperaPixiRuntime } from '@/components/visualizer/tempera/createTemperaPixiRuntime';
import { SonnetPixiRuntime } from '@/components/visualizer/sonnet/createSonnetPixiRuntime';

// Exercise real teardown methods with a damaged scene, without needing a GPU in unit tests.
for (const Runtime of [TemperaPixiRuntime, SonnetPixiRuntime]) {
    describe(`${Runtime.name} teardown`, () => {
        it('settles the pending handover and destroys the renderer even if a scene throws', async () => {
            let resolved = false;
            let resolveSwap!: () => void;
            const handover = new Promise<void>(resolve => { resolveSwap = resolve; }).then(() => { resolved = true; });
            const order: string[] = [];
            const damaged = vi.fn(() => { order.push('scene'); throw new Error('damaged scene'); });
            const runtime = Object.assign(Object.create(Runtime.prototype), {
                destroyed: false, resizeObserver: { disconnect: vi.fn() }, renderFrame: () => {},
                app: {
                    stop: () => order.push('stop'), ticker: { remove: () => order.push('untick') },
                    destroy: vi.fn(() => order.push('renderer')),
                },
                songSwap: { pending: {}, staged: { scene: {}, credits: null },
                    detachAbort: () => order.push('detach'), settle: resolveSwap },
                discardStaged: damaged, destroyScene: damaged, releaseIconUrls: vi.fn(), iconUrls: [],
                commitSongContext: vi.fn(),
            });
            expect(() => runtime.destroy()).toThrow('damaged scene');
            await handover;
            expect(resolved).toBe(true);
            expect(order).toEqual(['stop', 'untick', 'detach', 'scene', 'renderer']);
            expect(runtime.commitSongContext).not.toHaveBeenCalled();
            expect(runtime.destroyed).toBe(true);
            expect(runtime.songSwap).toBeNull();
            runtime.destroy();
            expect(runtime.app.destroy).toHaveBeenCalledOnce();
        });
    });
}
