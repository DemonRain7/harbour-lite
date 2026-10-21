import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/harbourWindowChrome.spec.ts
// Isolated bridge mocks never open Electron windows, touch playback, or use a live Harbour host.
const dragRegions = '[style*="app-region: drag"]';

async function installPresentationBridge(page: Page, options: { hosted?: boolean; legacy?: boolean; electron?: boolean } = {}) {
    await page.addInitScript(({ hosted = true, legacy = false, electron = true }) => {
        const listeners = new Set<(mode: 'embedded' | 'window' | 'background') => void>();
        const reads: Array<(mode: 'embedded' | 'window' | 'background') => void> = [];
        const clickThroughListeners = new Set<(state: { enabled: boolean }) => void>();
        const clickThroughReads: Array<(enabled: boolean) => void> = [];
        const calls: string[] = [];
        const harness = {
            calls,
            emit: (mode: 'embedded' | 'window' | 'background') => listeners.forEach(listener => listener(mode)),
            resolve: (mode: 'embedded' | 'window' | 'background') => reads.splice(0).forEach(resolve => resolve(mode)),
            listenerCount: () => listeners.size,
            emitClickThrough: (enabled: boolean) => clickThroughListeners.forEach(listener => listener({ enabled })),
            resolveClickThrough: (enabled: boolean) => clickThroughReads.splice(0).forEach(resolve => resolve(enabled)),
        };
        (window as any).__presentationProbe = harness;
        if (electron) window.electron = {
            isWindowMaximized: async () => false,
            minimizeWindow: () => calls.push('minimize'),
            toggleMaximizeWindow: async () => calls.push('maximize'),
            closeWindow: () => calls.push('close'),
            openRemoteControl: () => calls.push('remote'),
            getMainWindowClickThroughEnabled: () => new Promise(resolve => clickThroughReads.push(resolve)),
            onMainWindowClickThroughChanged: (listener: (state: { enabled: boolean }) => void) => {
                clickThroughListeners.add(listener);
                return () => { clickThroughListeners.delete(listener); };
            },
            setMainWindowClickThroughUnlockHover: async () => {},
        } as never;
        if (hosted) window.harbourFolia = {
            ready: async () => undefined,
            publish: () => {},
            onCommand: () => () => {},
            ...(legacy ? {} : {
                getPresentation: () => new Promise(resolve => reads.push(resolve)),
                onPresentationChanged: (handler: (mode: 'embedded' | 'window' | 'background') => void) => {
                    listeners.add(handler);
                    return () => { listeners.delete(handler); };
                },
            }),
        } as never;
    }, options);
}

test('hosted pending read suppresses all chrome before the first reply', async ({ page, mount }) => {
    await installPresentationBridge(page);
    const component = await mount('harbourWindowChrome');
    await expect(component.getByRole('button')).toHaveCount(1);
    await expect(component.locator(dragRegions)).toHaveCount(0);
    await expect(component.locator('audio').locator('..')).toHaveCSS('border-radius', '0px');
    await expect(component.locator('audio').locator('..')).toHaveCSS('box-shadow', 'none');
    expect(await page.evaluate(() => (window as any).__presentationProbe.listenerCount())).toBe(1);
    await page.evaluate(() => (window as any).__presentationProbe.resolve('window'));
    await expect(component.getByRole('button')).toHaveCount(6);
    await expect(component.locator(dragRegions)).toHaveCount(1);
});

test('embedded → window → embedded preserves child state and mounted audio', async ({ page, mount }) => {
    await installPresentationBridge(page);
    const component = await mount('harbourWindowChrome');
    const audio = await component.locator('audio').elementHandle();
    await component.getByRole('button', { name: 'Player state: 0' }).click();
    await page.evaluate(() => (window as any).__presentationProbe.emit('window'));
    await expect(component.getByRole('button')).toHaveCount(6);
    await expect(component.locator(dragRegions)).toHaveCount(1);
    await expect(component.locator('audio').locator('..')).toHaveCSS('border-radius', '18px');
    await component.getByRole('button', { name: 'Player state: 1' }).click();
    await page.evaluate(() => (window as any).__presentationProbe.emit('embedded'));
    await expect(component.getByRole('button')).toHaveCount(1);
    await expect(component.getByRole('button', { name: 'Player state: 2' })).toBeVisible();
    await expect(component.locator(dragRegions)).toHaveCount(0);
    expect(await audio!.evaluate(node => node === document.querySelector('audio'))).toBe(true);
});

test('a stale async initial reply cannot restore chrome after an embedded event', async ({ page, mount }) => {
    await installPresentationBridge(page);
    const component = await mount('harbourWindowChrome');
    await page.evaluate(() => {
        const bridge = (window as any).__presentationProbe;
        bridge.emit('embedded');
        bridge.resolve('window');
    });
    await expect(component.getByRole('button')).toHaveCount(1);
    await expect(component.locator(dragRegions)).toHaveCount(0);
});

test('a stale click-through startup reply cannot re-lock an unlocked document', async ({ page, mount }) => {
    await installPresentationBridge(page);
    const component = await mount('harbourWindowChrome');
    await page.evaluate(() => (window as any).__presentationProbe.emitClickThrough(true));
    await expect(page.locator('html')).toHaveAttribute('data-click-through', 'active');
    await page.evaluate(() => {
        const bridge = (window as any).__presentationProbe;
        bridge.emitClickThrough(false);
        bridge.resolveClickThrough(true);
    });
    await expect(page.locator('html')).not.toHaveAttribute('data-click-through');
    await component.getByRole('button', { name: 'Player state: 0' }).click();
    await expect(component.getByRole('button', { name: 'Player state: 1' })).toBeVisible();
});

for (const variant of ['upstream', 'legacy-host', 'browser'] as const) {
    test(`${variant} retains its existing chrome behavior`, async ({ page, mount }) => {
        const browser = variant === 'browser';
        await installPresentationBridge(page, { hosted: variant === 'legacy-host', legacy: true, electron: !browser });
        const component = await mount('harbourWindowChrome');
        await expect(component.getByRole('button')).toHaveCount(browser ? 1 : 6);
        await expect(component.locator(dragRegions)).toHaveCount(browser ? 0 : 1);
        await expect(component.locator('audio').locator('..')).toHaveCSS('border-radius', browser ? '0px' : '18px');
    });
}
