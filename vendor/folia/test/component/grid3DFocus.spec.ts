import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/grid3DFocus.spec.ts
// Keep the focus profile visible when embedded hosts height-limit the whole card row.

const readCards = (slider: Locator) => slider.evaluate(container => {
    const viewport = container.getBoundingClientRect();
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-grid3d-index]')).map(card => {
        const box = card.getBoundingClientRect();
        return {
            index: Number(card.dataset.grid3dIndex),
            width: box.width,
            top: box.top,
            bottom: box.bottom,
            center: box.left + box.width / 2,
            offsetLeft: card.offsetLeft,
            scale: new DOMMatrix(getComputedStyle(card).transform).a,
        };
    });
    return {
        cards,
        center: viewport.left + viewport.width / 2,
        top: viewport.top,
        bottom: viewport.bottom,
        scrollLeft: container.scrollLeft,
    };
});

// Native scrolling exercises the production scroll handler; two frames let it and React focus
// bookkeeping settle without introducing a fake transform or waiting for an arbitrary timeout.
const scrollToPosition = (slider: Locator, left: number) => slider.evaluate(async (container, target) => {
    container.scrollLeft = target;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}, left);

const expectCentered = async (slider: Locator, index: number) => {
    await expect(async () => {
        const state = await readCards(slider);
        const focused = state.cards.find(card => card.index === index)!;
        expect(Math.abs(focused.center - state.center)).toBeLessThan(1);
        for (const neighbor of state.cards.filter(card => Math.abs(card.index - index) === 1)) {
            expect(focused.width / neighbor.width).toBeGreaterThan(1.25);
        }
    }).toPass({ timeout: 5000 });
};

test.beforeEach(async ({ page }) => {
    // The existing probe uses local SVG covers and fixture collections, never real music accounts.
    await page.route(/^https?:\/\//, route => {
        const hostname = new URL(route.request().url()).hostname;
        return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
            ? route.continue()
            : route.abort();
    });
});

for (const style of ['Card', 'Image']) {
    for (const width of [1600, 2560]) {
        test(`${style} focus stays larger in a ${width}×620 host, including late metadata`, async ({ mount, page }) => {
            await page.setViewportSize({ width, height: 620 });
            const component = await mount('grid3DToolbar');
            await component.getByRole('button', { name: `${style} style`, exact: true }).click();
            const slider = component.locator('[data-grid3d-slider]');

            for (const metadata of [false, true]) {
                if (metadata) {
                    await component.getByRole('button', { name: 'Toggle metadata', exact: true }).click();
                    await expect(component.locator('[data-grid3d-caption] h3')).toContainText('Library');
                }
                await expectCentered(slider, 2);
                await expect(async () => {
                    const state = await readCards(slider);
                    const focused = state.cards.find(card => card.index === 2)!;
                    const overview = await component.getByRole('button', { name: 'All', exact: true }).boundingBox();
                    const caption = await component.locator('[data-grid3d-caption]').boundingBox();
                    // Prove this is the height-constrained case, not merely the normal desktop profile.
                    expect(focused.scale).toBeLessThan(1);
                    expect(focused.top - overview!.y - overview!.height).toBeGreaterThanOrEqual(12);
                    expect(focused.top).toBeGreaterThanOrEqual(state.top);
                    expect(focused.bottom).toBeLessThanOrEqual(state.bottom);
                    expect(focused.bottom).toBeLessThanOrEqual(caption!.y);
                }).toPass({ timeout: 5000 });
                if (!metadata) {
                    await component.screenshot({ path: `test-results/grid3d-focus-${style.toLowerCase()}-${width}.png` });
                }
            }
        });
    }

    test(`${style} focus transfers smoothly in both directions instead of jumping at half a card`, async ({ mount, page }) => {
        await page.setViewportSize({ width: 1600, height: 620 });
        const component = await mount('grid3DToolbar');
        await component.getByRole('button', { name: `${style} style`, exact: true }).click();
        const slider = component.locator('[data-grid3d-slider]');
        await expectCentered(slider, 2);

        const initial = await readCards(slider);
        const initialCard = initial.cards.find(card => card.index === 2)!;
        const pitch = initial.cards.find(card => card.index === 3)!.offsetLeft - initialCard.offsetLeft;
        const peakWidth = initialCard.width;
        const sideWidth = initial.cards.find(card => card.index === 3)!.width;

        for (const direction of [1, -1]) {
            await scrollToPosition(slider, initial.scrollLeft);
            await expectCentered(slider, 2);
            const nextIndex = 2 + direction;
            const samples: { current: number; next: number }[] = [];
            for (const progress of [0.25, 0.49, 0.51, 0.75]) {
                const target = initial.scrollLeft + direction * pitch * progress;
                await scrollToPosition(slider, target);
                const state = await readCards(slider);
                expect(Math.abs(state.scrollLeft - target)).toBeLessThan(1);
                const current = state.cards.find(card => card.index === 2)!.width;
                const next = state.cards.find(card => card.index === nextIndex)!.width;
                // Every intermediate sample must lie between the two endpoint sizes.
                expect(current).toBeGreaterThan(sideWidth);
                expect(current).toBeLessThan(peakWidth);
                expect(next).toBeGreaterThan(sideWidth);
                expect(next).toBeLessThan(peakWidth);
                samples.push({ current, next });
            }

            for (let index = 1; index < samples.length; index++) {
                expect(samples[index].current).toBeLessThan(samples[index - 1].current);
                expect(samples[index].next).toBeGreaterThan(samples[index - 1].next);
            }
            expect(samples[1].current).toBeGreaterThan(samples[1].next);
            expect(samples[2].current).toBeLessThan(samples[2].next);
            // Crossing the discrete focus boundary by 2% must not swap endpoint sizes instantly.
            expect(Math.abs(samples[2].current - samples[1].current) / peakWidth).toBeLessThan(0.03);
            expect(Math.abs(samples[2].next - samples[1].next) / peakWidth).toBeLessThan(0.03);

            await scrollToPosition(slider, initial.scrollLeft + direction * pitch);
            await expectCentered(slider, nextIndex);
            await expect(component.locator('[data-grid3d-caption] h3')).toHaveText(direction > 0 ? 'Rain' : 'Library');
            // Restoring the original center must restore the original width, not retain a focus latch.
            await scrollToPosition(slider, initial.scrollLeft);
            await expectCentered(slider, 2);
            await expect(component.locator('[data-grid3d-caption] h3')).toHaveText('日语');
        }

        // Real pointer input must use the same continuous profile, without opening a playlist.
        const area = (await slider.boundingBox())!;
        const startX = area.x + area.width / 2;
        const startY = area.y + area.height - 8;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - pitch / 6, startY, { steps: 12 });
        await expect(async () => {
            const state = await readCards(slider);
            const current = state.cards.find(card => card.index === 2)!.width;
            const next = state.cards.find(card => card.index === 3)!.width;
            expect(current).toBeLessThan(peakWidth);
            expect(current).toBeGreaterThan(next);
            expect(next).toBeGreaterThan(sideWidth);
        }).toPass({ timeout: 5000 });
        await page.mouse.up();
        await expect(component.getByTestId('selected-collection')).toHaveText('');
    });
}
