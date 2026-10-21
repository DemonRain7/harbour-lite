import { expect, test } from './fixtures';

// Diagnostic numbers are attached, not used as hardware-dependent FPS pass/fail thresholds.
test('measure a playing 120-song wall and panning through its cull boundary', async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 850 });
    const wall = await mount('harbourLatticePerformance');
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    let layers = 0;
    cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers?.length ?? layers; });
    await cdp.send('LayerTree.enable');
    const before = await cdp.send('Performance.getMetrics');
    const sample = await wall.locator('.lattice-field').evaluate(async field => {
        const win = window as Window & { __renderCounts?: Record<string, number> };
        win.__renderCounts = {};
        const seen = new WeakSet<Element>(field.querySelectorAll('.lattice-poster'));
        let newPosters = 0;
        const recordMounts = (records: MutationRecord[]) => {
            for (const record of records) for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                const posters = node.matches('.lattice-poster') ? [node] : node.querySelectorAll('.lattice-poster');
                for (const poster of posters) if (!seen.has(poster)) {
                    seen.add(poster);
                    newPosters++;
                }
            }
        };
        const observer = new MutationObserver(recordMounts);
        observer.observe(field, { childList: true, subtree: true });
        let previous = performance.now();
        const gaps: number[] = [];
        for (let i = 0; i < 120; i++) {
            await new Promise<void>(resolve => requestAnimationFrame(now => {
                gaps.push(now - previous); previous = now;
                field.dispatchEvent(new WheelEvent('wheel', { deltaX: 12, bubbles: true, cancelable: true }));
                resolve();
            }));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        recordMounts(observer.takeRecords());
        observer.disconnect();
        const sorted = gaps.slice(1).sort((a, b) => a - b);
        return { frames: gaps.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
            renders: { ...win.__renderCounts }, newPosters, posters: field.querySelectorAll('.lattice-poster').length };
    });
    const after = await cdp.send('Performance.getMetrics');
    const metrics = Object.fromEntries(after.metrics.filter(item => /Duration$|Count$/.test(item.name)).map(item =>
        [item.name, item.value - (before.metrics.find(old => old.name === item.name)?.value ?? 0)]));
    const report = { ...sample, layers, metrics };
    console.log('LATTICE_PERF', JSON.stringify(report));
    await testInfo.attach('lattice-performance.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    await wall.screenshot({ path: testInfo.outputPath('lattice.png') });
    expect(sample.posters).toBeLessThan(400);
    // Upstream intentionally animates newly revealed posters and updates exit-wave delays at a
    // cull. Measure those costs above; enforce the invariant that camera ticks do not enter React.
    expect(sample.renders.PosterWall ?? 0).toBeLessThan(sample.frames);
    await cdp.detach();
});

test('parent updates and playback clock do not redraw poster bodies', async ({ mount, page }) => {
    const wall = await mount('harbourLatticePerformance');
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { (window as any).__renderCounts = {}; });
    for (let i = 0; i < 6; i++) await wall.getByRole('button', { name: 'Rerender parent' }).click();
    await page.waitForTimeout(600);
    const counts = await page.evaluate(() => (window as any).__renderCounts);
    // The upstream wall is not memo-wrapped; six discrete parent changes may visit it.
    expect(counts.PosterWall ?? 0).toBeLessThanOrEqual(12);
    expect(counts.LatticePoster ?? 0).toBe(0);
    await wall.getByRole('button', { name: 'Toggle clock' }).click();
    const paused = await page.evaluate(() => (window as any).__renderCounts);
    expect(paused.LatticePoster ?? 0).toBeLessThanOrEqual(6);
    await expect(wall.locator('.lattice-transport-button')).toHaveAttribute('aria-label', /play$/);
    await wall.getByRole('button', { name: 'Toggle clock' }).click();
    await expect(wall.locator('.lattice-transport-button')).toHaveAttribute('aria-label', /pause$/);
});

test('crossing the preload boundary preserves upstream reveal transitions and bounded culling', async ({ mount, page }) => {
    const wall = await mount('harbourLatticePerformance', { queueSize: 1200, bitmapCovers: true });
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1500);
    const result = await wall.locator('.lattice-field').evaluate(async field => {
        const world = field.querySelector('.lattice-world')!;
        const seen = new WeakSet(world.children);
        let mounted = 0, animating = 0;
        const observer = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (!(node instanceof HTMLElement) || !node.matches('.lattice-poster') || seen.has(node)) continue;
                seen.add(node); mounted++;
                if (node.style.opacity !== '1' || /scale\(0\./.test(node.style.transform)) animating++;
            }
        });
        observer.observe(world, { childList: true });
        for (let i = 0; i < 40; i++) await new Promise<void>(resolve => requestAnimationFrame(() => {
            field.dispatchEvent(new WheelEvent('wheel', { deltaX: 50, deltaY: 8, bubbles: true, cancelable: true })); resolve();
        }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        observer.disconnect();
        return { mounted, animating, retained: world.children.length };
    });
    expect(result.mounted).toBeGreaterThan(0);
    // Upstream uses a short fade/scale reveal; record it instead of forbidding its animation.
    console.log('LATTICE_BOUNDARY_REVEAL', JSON.stringify(result));
    expect(result.animating).toBeLessThanOrEqual(result.mounted);
    await page.waitForTimeout(650);
    await expect.poll(() => wall.locator('.lattice-poster').evaluateAll(nodes =>
        nodes.every(node => Number(getComputedStyle(node).opacity) > .99))).toBe(true);
    expect(result.retained).toBeLessThan(160);
});

test('1200 songs remain culled, stop drawing while hidden, and resume the same lyric canvas', async ({ mount, page }) => {
    // Count the fixture's real WebGL draw calls, not audio time or a mocked visibility flag.
    await page.addInitScript(() => {
        (window as any).__lyricDraws = 0;
        for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
            for (const key of ['drawElements', 'drawArrays'] as const) {
                const original = type.prototype[key];
                (type.prototype as any)[key] = function (...args: any[]) {
                    (window as any).__lyricDraws++;
                    return (original as any).apply(this, args);
                };
            }
        }
    });
    const wall = await mount('harbourLatticePerformance', { queueSize: 1200 });
    const canvas = wall.locator('.lattice-lyrics.is-ready canvas');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(1500);
    // Includes an offscreen buffer in addition to the requested ~30 visible posters.
    expect(await wall.locator('.lattice-poster').count()).toBeGreaterThan(30);
    expect(await wall.locator('.lattice-poster').count()).toBeLessThan(400);
    await canvas.evaluate(node => node.setAttribute('data-original', 'true'));
    await wall.getByRole('button', { name: 'Toggle visibility' }).click();
    await page.waitForTimeout(250);
    const hidden = await page.evaluate(() => (window as any).__lyricDraws);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__lyricDraws)).toBe(hidden);
    await wall.getByRole('button', { name: 'Toggle visibility' }).click();
    await expect(canvas).toHaveAttribute('data-original', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).__lyricDraws)).toBeGreaterThan(hidden);
    await wall.locator('.lattice-field').dispatchEvent('wheel', { deltaX: 2000, deltaY: 1200 });
    await page.waitForTimeout(1500);
    expect(await wall.locator('.lattice-poster').count()).toBeGreaterThan(30);
    expect(await wall.locator('.lattice-poster').count()).toBeLessThan(400);
    const offscreen = await page.evaluate(() => (window as any).__lyricDraws);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__lyricDraws)).toBe(offscreen);
    await wall.locator('.lattice-field').dispatchEvent('wheel', { deltaX: -2000, deltaY: -1200 });
    await expect(canvas).toHaveAttribute('data-original', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).__lyricDraws)).toBeGreaterThan(offscreen);
    // Explicit focus may choose a different repeated instance of the song; that is a new card,
    // unlike returning to the original viewport, and is allowed its own renderer.
    await wall.getByRole('button', { name: 'Lattice tools', exact: true }).click();
    await wall.getByRole('menuitem', { name: 'Focus current song', exact: true }).click();
    await expect(canvas).toBeVisible();
    await expect(wall.locator('.lattice-poster.is-expanded')).toHaveAttribute('aria-label', /城市 13 ·/);
});

test('leaving after a pan retains the exit wave and releases the lyric canvas', async ({ mount, page }) => {
    const wall = await mount('harbourLatticePerformance');
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1500);
    await wall.locator('.lattice-field').dispatchEvent('wheel', { deltaX: 180 });
    await wall.getByRole('button', { name: 'Toggle wall', exact: true }).click();
    await expect.poll(() => wall.locator('.lattice-poster').evaluateAll(nodes =>
        nodes.some(node => Number(getComputedStyle(node).opacity) < .95))).toBe(true);
    await expect(wall.locator('.lattice-root')).toHaveCount(0);
    await expect(wall.locator('canvas')).toHaveCount(0);
    await wall.getByRole('button', { name: 'Toggle wall', exact: true }).click();
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
});

test('high-frequency input preserves upstream immediate response without routing camera ticks through React', async ({ mount, page }) => {
    const wall = await mount('harbourLatticePerformance', { queueSize: 1200 });
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1600);
    const sample = await wall.locator('.lattice-field').evaluate(async field => {
        const world = field.querySelector('.lattice-world')!;
        const before = new DOMMatrix(getComputedStyle(world).transform);
        let writes = 0;
        (window as any).__renderCounts = {};
        const observer = new MutationObserver(records => { writes += records.length; });
        observer.observe(world, { attributes: true, attributeFilter: ['style'] });
        // A high-polling device can deliver several deltas before the browser paints once.
        for (let frame = 0; frame < 80; frame++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => {
                for (let event = 0; event < 12; event++) field.dispatchEvent(new WheelEvent('wheel', {
                    deltaX: .75, deltaY: -.25, bubbles: true, cancelable: true,
                }));
                resolve();
            }));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        writes += observer.takeRecords().length;
        observer.disconnect();
        const after = new DOMMatrix(getComputedStyle(world).transform);
        return { writes, deltaX: after.m41 - before.m41, deltaY: after.m42 - before.m42,
            wallRenders: (window as any).__renderCounts.PosterWall ?? 0 };
    });
    console.log('LATTICE_INPUT_BURST', JSON.stringify(sample));
    expect(sample.deltaX).toBeCloseTo(-720, 2);
    expect(sample.deltaY).toBeCloseTo(240, 2);
    // The upstream handler writes each delta directly, so there can be twelve DOM writes per
    // display frame. Only discrete culling may re-render the React wall.
    expect(sample.writes).toBeLessThanOrEqual(960);
    expect(sample.wallRenders).toBeLessThan(80);
});

test('queued wheel input cannot reset a subsequent keyboard focus animation', async ({ mount, page }) => {
    const wall = await mount('harbourLatticePerformance');
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1600);
    await wall.locator('.lattice-field').focus();
    await wall.locator('.lattice-field').evaluate(field => {
        field.dispatchEvent(new WheelEvent('wheel', { deltaX: 137, bubbles: true, cancelable: true }));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    const fieldBox = (await wall.locator('.lattice-field').boundingBox())!;
    const focused = wall.locator('.lattice-poster.is-focused');
    const posterBox = (await focused.boundingBox())!;
    expect(posterBox.x + posterBox.width / 2).toBeCloseTo(fieldBox.x + fieldBox.width / 2, 0);
    expect(posterBox.y + posterBox.height / 2).toBeCloseTo(fieldBox.y + fieldBox.height / 2, 0);
    const position = await wall.locator('.lattice-world').getAttribute('style');
    await page.waitForTimeout(150);
    expect(await wall.locator('.lattice-world').getAttribute('style')).toBe(position);
});
