import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { motionValue } from 'framer-motion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/types';

// test/unit/visualizer/webglFallback.test.ts
// Unsupported renderers must not instantiate Paper shaders or lose the palette/progress.
vi.mock('@paper-design/shaders-react', () => Object.fromEntries(
    ['Dithering', 'MeshGradient', 'FlutedGlass', 'HalftoneDots', 'ImageDithering', 'LensDistortion', 'PaperTexture', 'ShaderMount']
        .map(name => [name, () => React.createElement('div', { 'data-paper-shader': name })]),
));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function canvasContext(context: unknown) {
    const getContext = vi.fn(() => context);
    const createElement = vi.fn(() => ({ getContext }));
    vi.stubGlobal('document', { createElement });
    return { getContext, createElement };
}

describe('WebGL capability', () => {
    it('caches one successful probe and releases its context', async () => {
        const loseContext = vi.fn();
        const { getContext, createElement } = canvasContext({ getExtension: () => ({ loseContext }) });
        const { canUseWebGL2 } = await import('@/utils/webglCapability');
        expect(canUseWebGL2()).toBe(true);
        expect(canUseWebGL2()).toBe(true);
        expect(createElement).toHaveBeenCalledTimes(1);
        expect(getContext).toHaveBeenCalledWith('webgl2');
        expect(loseContext).toHaveBeenCalledOnce();
    });
    it('caches unsupported contexts without throwing', async () => {
        const { getContext } = canvasContext(null);
        const { canUseWebGL2 } = await import('@/utils/webglCapability');
        expect(canUseWebGL2()).toBe(false);
        expect(canUseWebGL2()).toBe(false);
        expect(getContext).toHaveBeenCalledTimes(1);
    });
    it('handles a disabled/throwing canvas implementation', async () => {
        const { getContext } = canvasContext(null);
        getContext.mockImplementation(() => { throw new Error('disabled'); });
        expect((await import('@/utils/webglCapability')).canUseWebGL2()).toBe(false);
    });
    it('does not cache a server-side no-DOM result', async () => {
        vi.stubGlobal('document', undefined);
        const { canUseWebGL2 } = await import('@/utils/webglCapability');
        expect(canUseWebGL2()).toBe(false);
        canvasContext({ getExtension: () => null });
        expect(canUseWebGL2()).toBe(true);
    });
});

describe.each([false, true])('shader support = %s', supported => {
    it('keeps theme backgrounds and progress, mounting shaders only with WebGL2', async () => {
        canvasContext(supported ? { getExtension: () => null } : null);
        const { default: Latent } = await import('@/components/visualizer/backgrounds/latent/LatentBackground');
        const { default: Nomand } = await import('@/components/visualizer/backgrounds/nomand/NomandBackgroundLayer');
        const { default: Border } = await import('@/components/app/overlays/now-playing-toast/PulsingBorderProgress');
        const theme = { backgroundColor: '#123456', primaryColor: '#abcdef', secondaryColor: '#fedcba', accentColor: '#654321' } as Theme;
        const bands = { bass: motionValue(0), lowMid: motionValue(0), mid: motionValue(0), vocal: motionValue(0), treble: motionValue(0) };
        const latent = renderToStaticMarkup(React.createElement(Latent, { theme, audioBands: bands, audioPower: motionValue(0), staticMode: false, paused: false }));
        const nomand = renderToStaticMarkup(React.createElement(Nomand, { theme, coverUrl: '/cover.png' }));
        const border = renderToStaticMarkup(React.createElement(Border, { progress: motionValue(40), width: 200, height: 80, baseColor: '#abcdef' }));
        for (const markup of [latent, nomand, border]) {
            expect(markup.includes('data-paper-shader')).toBe(supported);
            expect(markup.includes('data-shader-fallback')).toBe(!supported);
        }
        expect(latent).toContain('background-color:#123456');
        if (!supported) {
            expect(latent).toContain('radial-gradient');
            expect(nomand).toContain('src="/cover.png"');
            expect(border).toContain('stroke-dashoffset="0.6"');
            expect(border).toContain('stroke="#abcdef"');
        }
    });
});
