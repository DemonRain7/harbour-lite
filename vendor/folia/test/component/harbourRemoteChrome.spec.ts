import { expect, test } from './fixtures';

// test/component/harbourRemoteChrome.spec.ts
// The optional capability preserves older standalone hosts and tracks embedding transitions.
test('remote click-through follows host availability without changing standalone defaults', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const listeners = new Set<(snapshot: unknown) => void>();
        const commands: unknown[] = [];
        (window as any).__remoteChromeProbe = {
            commands,
            emit: (snapshot: unknown) => listeners.forEach(listener => listener(snapshot)),
        };
        window.electron = {
            getRemoteControlSnapshot: async () => null,
            getRemoteControlAlwaysOnTop: async () => false,
            onRemoteControlSnapshot: (listener: (snapshot: unknown) => void) => {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            sendRemoteControlCommand: (command: unknown) => commands.push(command),
        } as never;
    });
    const component = await mount('harbourRemoteChrome');
    await component.getByTitle('Transparent controls').click();
    const clickThrough = component.getByRole('button', { name: 'Through', exact: true });
    await expect(clickThrough).toBeDisabled();
    // Older host: missing capability still permits the existing transparent-window action.
    await page.evaluate(() => (window as any).__remoteChromeProbe.emit({ transparentModeEnabled: true }));
    await expect(clickThrough).toBeEnabled();
    await clickThrough.click();
    expect(await page.evaluate(() => (window as any).__remoteChromeProbe.commands)).toEqual([
        { type: 'set-main-window-click-through', enabled: true },
    ]);
    await page.evaluate(() => (window as any).__remoteChromeProbe.emit({ mainWindowClickThroughAvailable: false }));
    await expect(clickThrough).toBeDisabled();
    await expect(clickThrough).toHaveAttribute('title', 'Click-through is unavailable while Folia is embedded. Open it in a separate window to use click-through.');
    await clickThrough.evaluate(button => (button as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).__remoteChromeProbe.commands.length)).toBe(1);
    await page.evaluate(() => (window as any).__remoteChromeProbe.emit({ mainWindowClickThroughAvailable: true }));
    await expect(clickThrough).toBeEnabled();
    await expect(clickThrough).toHaveAttribute('title', 'Click-Through');
});
