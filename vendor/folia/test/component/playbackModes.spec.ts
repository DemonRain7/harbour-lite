import { expect, test } from './fixtures';

// Four native modes stay synchronized across controls and survive reload without playing any media.
test('panel and player cycle the same four modes and distinguish queue shuffle', async ({ mount, page }) => {
    await mount('playbackModes');
    const root = page.locator('[data-playback-mode]');
    const panel = page.getByTestId('mode-panel');
    const player = page.getByTestId('mode-player');
    const modes = [
        ['off', 'Sequential playback', 'repeat-off'], ['all', 'Repeat all', 'repeat'],
        ['one', 'Repeat one', 'repeat-1'], ['shuffle', 'Shuffle playback', 'shuffle'],
    ];
    // Fixture storage starts with the production default (sequential playback).
    for (const index of [0, 1, 2, 3]) {
        const [mode, label, icon] = modes[index];
        await expect(root).toHaveAttribute('data-playback-mode', mode);
        await expect(panel.getByRole('button', { name: label, exact: true })).toBeVisible();
        await expect(player.getByRole('button', { name: label, exact: true })).toBeVisible();
        await expect(player.getByRole('button', { name: label, exact: true }).locator(`svg.lucide-${icon}`)).toHaveCount(1);
        await (index % 2 ? panel : player).getByRole('button', { name: label, exact: true }).click();
    }
    await expect(root).toHaveAttribute('data-playback-mode', 'off');
    await player.getByRole('button', { name: 'Shuffle queue', exact: true }).click();
    await expect(root).toHaveAttribute('data-shuffle-hits', '1');
    await expect(root).toHaveAttribute('data-playback-mode', 'off');
});

test('restores an explicitly persisted shuffle mode in both controls', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('player_loop_mode', 'shuffle'));
    await mount('playbackModes');
    await expect(page.locator('[data-playback-mode]')).toHaveAttribute('data-playback-mode', 'shuffle');
    await expect(page.getByRole('button', { name: 'Shuffle playback', exact: true })).toHaveCount(2);
    await page.getByTestId('mode-panel').getByRole('button', { name: 'Shuffle playback', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('player_loop_mode'))).toBe('off');
});

test('Remote cycles the same native modes through its command and snapshot seam', async ({ mount, page }) => {
    await mount('remotePlaybackModes');
    for (const label of ['Sequential playback', 'Repeat all', 'Repeat one', 'Shuffle playback']) {
        const button = page.getByRole('button', { name: label, exact: true });
        await expect(button).toBeEnabled();
        await button.click();
    }
    await expect(page.getByRole('button', { name: 'Sequential playback', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('player_loop_mode'))).toBe('off');
});
