import { expect, test } from '../component/fixtures';

// test/ui/latticeFrames.probe.ts
// Opt-in Chrome timeline diagnostic: npm run test:render -- test/ui/latticeFrames.probe.ts.
// Same wall, covers, lyric clock and camera path; frame timings are measurements, not CI limits.
test.use({ baseURL: 'http://127.0.0.1:4173/dev-probe.html', serviceWorkers: 'block' });

test('profile collage composition while the pointer stays over moving covers', async ({ mount, page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 2560, height: 1440 });
    const wall = await mount('harbourLatticePerformance', { queueSize: 1200 });
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1600);
    await page.mouse.move(1560, 770);
    const cdp = await page.context().newCDPSession(page);
    const reports = [];
    for (const [label, css] of [
        ['original', ''],
        ['grain-layer', '.lattice-root::after { will-change: opacity; }'],
        ['no-grain', '.lattice-root::after { display: none; }'],
        ['no-hover-filter', '.lattice-poster { filter: none !important; }'],
        ['original-repeat', ''],
    ]) {
        const style = await page.addStyleTag({ content: css || '/* unchanged baseline */' });
        await page.waitForTimeout(800);
        const completed = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
        const result = await wall.locator('.lattice-field').evaluate(async field => {
            const times: number[] = [];
            for (let i = 0; i < 150; i++) {
                await new Promise<void>(resolve => requestAnimationFrame(time => {
                    times.push(time);
                    const direction = i < 75 ? 1 : -1;
                    field.dispatchEvent(new WheelEvent('wheel', { deltaX: direction * 12, deltaY: direction * 2, bubbles: true, cancelable: true }));
                    resolve();
                }));
            }
            const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
            return { p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)],
                over25ms: gaps.filter(gap => gap > 25).length, elapsed: times.at(-1)! - times[0],
                mounted: field.querySelectorAll('.lattice-poster').length };
        });
        await cdp.send('Tracing.end');
        const { stream } = await completed;
        let raw = '';
        for (;;) {
            const chunk = await cdp.send('IO.read', { handle: stream });
            raw += chunk.data;
            if (chunk.eof) break;
        }
        await cdp.send('IO.close', { handle: stream });
        const trace = JSON.parse(raw);
        const timings: Record<string, { count: number; ms: number }> = {};
        for (const event of trace.traceEvents) {
            if (event.ph !== 'X' || !['Paint', 'RasterTask', 'Layout', 'UpdateLayoutTree', 'Layerize', 'FireAnimationFrame'].includes(event.name)) continue;
            const timing = timings[event.name] ??= { count: 0, ms: 0 };
            timing.count++; timing.ms += event.dur / 1000;
        }
        const report = { label, ...result, timings };
        reports.push(report);
        console.log('LATTICE_FRAMES', JSON.stringify(report));
        await style.evaluate(node => { node.parentNode?.removeChild(node); });
    }
    await testInfo.attach('frame-diagnostics.json', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
    await cdp.detach();
});
