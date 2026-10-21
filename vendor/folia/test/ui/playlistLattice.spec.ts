import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installBaseState, mockNeteaseApi, neteaseFixtures, svgDataUrl } from './helpers/appFixtures';

// test/ui/playlistLattice.spec.ts
// Real homepage clicks use the existing provider loader, history and shared collage renderer.
test.use({ serviceWorkers: 'block' });

async function setup(page: Page, count = 120, failFirst = false, longAudio = false) {
    await installBaseState(page, { neteaseMode: 'logged-in' });
    await mockNeteaseApi(page, 'logged-in');
    const tracks = Array.from({ length: count }, (_, i) => ({
        id: 50000 + i, name: `Playlist track ${i + 1}`,
        ar: [{ id: 10, name: 'Fixture artist' }],
        al: { id: 20, name: 'Fixture album', picUrl: svgDataUrl(String(i + 1), i % 2 ? '#426283' : '#736a57') },
        dt: 180000,
    }));
    const otherTracks = tracks.map(track => ({ ...track, id: track.id + 10000, name: `Other ${track.name}` }));
    let requests = 0;
    await page.route('**/__mock_netease__/playlist/track/all?**', async route => {
        requests++;
        if (failFirst && requests === 1) {
            await route.abort('failed');
            return;
        }
        const params = new URL(route.request().url()).searchParams;
        const offset = Number(params.get('offset'));
        const limit = Number(params.get('limit')) || 50;
        const playlistTracks = params.get('id') === '9002' ? otherTracks : tracks;
        await route.fulfill({ json: { code: 200, songs: playlistTracks.slice(offset, offset + limit) } });
    });
    await page.route('**/__mock_netease__/user/playlist?**', route => route.fulfill({ json: {
        playlist: neteaseFixtures.playlists.map(item => ({ ...item, trackCount: count, creator: neteaseFixtures.profile })),
    } }));
    await page.route('**/__mock_netease__/song/url/v1?**', route => route.fulfill({ json: {
        data: [{ url: 'https://playlist-fixture.test/tone.wav' }],
    } }));
    const tone = readFileSync('test/manual/stage-client/fixtures/stage-demo-tone.wav');
    // The original 1.2s clip auto-advances while a human-sized pointer interaction is underway.
    // Extend fixture PCM in memory for explicit-next tests; still muted and entirely offline.
    const audio = longAudio ? Buffer.concat([tone.subarray(0, 44), ...Array.from({ length: 100 }, () => tone.subarray(44))]) : tone;
    if (longAudio) { audio.writeUInt32LE(audio.length - 8, 4); audio.writeUInt32LE(audio.length - 44, 40); }
    await page.route('https://playlist-fixture.test/tone.wav', route => route.fulfill({
        body: audio, contentType: 'audio/wav',
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route('**/__mock_netease__/song/detail?**', route => route.fulfill({ json: {
        songs: [...tracks, ...otherTracks].filter(track => new URL(route.request().url()).searchParams.get('ids')?.split(',').includes(String(track.id))),
    } }));
    await page.route('**/__mock_netease__/lyric/new?**', route => route.fulfill({ json: {
        lrc: { lyric: '[00:00.00]Playlist fixture\n[00:03.00]Playback stays in the playlist\n[00:08.00]Next track' },
    } }));
    await page.route('**/*', route => ['127.0.0.1', 'localhost', 'playlist-fixture.test'].includes(new URL(route.request().url()).hostname)
        ? route.fallback() : route.abort('blockedbyclient'));
    await page.addInitScript(() => { localStorage.setItem('player_volume', '0'); });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
    await expect(page.locator('.lattice-root')).toHaveCount(0);
    return { requests: () => requests };
}

const openPlaylist = async (page: Page) => {
    await page.getByRole('heading', { name: 'Daily Mix' }).first().click();
    await expect(page.locator('[data-playlist-collage="9001"] .lattice-root')).toBeVisible();
};
const playbackState = (page: Page) => page.evaluate(async () => {
    const path = '/src/stores/usePlaybackStore.ts';
    const { usePlaybackStore } = await import(path);
    const state = usePlaybackStore.getState();
    return { current: state.currentSong?.id ?? null, queue: state.playQueue.map((s: { id: unknown }) => s.id), view: history.state?.view };
});

for (const scenario of [
    { surface: 'playlist', mode: 'off', language: 'zh-CN', width: 1280 },
    { surface: 'other-playlist', mode: 'shuffle', language: 'zh-CN', width: 1280 },
    { surface: 'queue', mode: 'shuffle', language: 'en', width: 1280 },
    { surface: 'queue', mode: 'one', language: 'en', width: 540 },
    { surface: 'management-card', mode: 'off', language: 'en', width: 1280 },
    { surface: 'management-list', mode: 'shuffle', language: 'en', width: 1280 },
    { surface: 'management-list', mode: 'one', language: 'en', width: 1280 },
] as const) {
test(`play next from ${scenario.surface} collage keeps A playing (${scenario.mode}, ${scenario.width}px)`, async ({ page }, testInfo) => {
    const management = scenario.surface.startsWith('management-');
    const otherPlaylist = scenario.surface === 'other-playlist' || management;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await setup(page, 24, false, true);
    await page.evaluate(async ({ language, surface }) => {
        const entryPath = '/src/stores/usePlaybackEntryViewStore.ts';
        const i18nPath = '/src/i18n/config.ts';
        const { usePlaybackEntryViewStore } = await import(entryPath);
        usePlaybackEntryViewStore.getState().setPlaybackEntryView(surface === 'queue' ? 'player' : 'lattice');
        await (await import(i18nPath)).default.changeLanguage(language);
    }, scenario);
    await openPlaylist(page);
    await page.waitForTimeout(500);
    const visiblePoster = async (excludeCurrent = false) => {
        let id: string | null | undefined;
        await expect.poll(async () => {
            id = await page.locator('.lattice-poster').evaluateAll((posters, exclude) => posters.find(p => {
                const b = p.getBoundingClientRect();
                const x = b.x + b.width / 2, y = b.y + b.height / 2;
                return (!exclude || !p.classList.contains('is-current')) && x > 10 && y > 110 && x < innerWidth - 10 && y < innerHeight - 20;
            })?.getAttribute('data-instance-id'), excludeCurrent);
            return !!id;
        }).toBe(true);
        expect(id).toBeTruthy();
        return page.locator(`.lattice-poster[data-instance-id=${JSON.stringify(id)}]`);
    };
    const a = await visiblePoster();
    await a.click();
    await a.focus();
    await a.press('Enter');
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(el => !el.paused && el.currentTime > 0.1))).toBe(true);
    if (otherPlaylist) {
        const original = await playbackState(page);
        await page.locator('.lattice-back').click();
        await expect(page.locator('[data-playlist-collage]')).toHaveCount(0);
        // The first click centers another library card; clicking the focused card opens it.
        await page.getByRole('heading', { name: 'Late Night Drive' }).first().click();
        await page.getByRole('heading', { name: 'Late Night Drive' }).first().click();
        await expect(page.locator('[data-playlist-collage="9002"] .lattice-root')).toBeVisible();
        expect((await playbackState(page)).queue).toEqual(original.queue);
        expect((await playbackState(page)).current).toBe(original.current);
    }
    if (scenario.surface === 'queue') await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('.lattice-root')).toBeVisible();
    await page.evaluate(async ({ mode, surface }) => {
        const settingsPath = '/src/stores/useAudioSettingsStore.ts';
        const playbackPath = '/src/stores/usePlaybackStore.ts';
        const settings = (await import(settingsPath)).useAudioSettingsStore.getState();
        settings.setLoopMode(mode);
        if (surface.startsWith('management-')) settings.handleSetQueueAddBehavior('next');
        if (surface === 'playlist') {
            const store = (await import(playbackPath)).usePlaybackStore;
            const state = store.getState();
            // The browsed playlist must NOT become the actual queue when choosing one B.
            state.setPlayQueue([state.currentSong]);
        }
    }, scenario);
    let b;
    if (management) {
        await page.getByRole('button', { name: 'List & manage' }).click();
        await expect(page.locator('.lattice-root')).toHaveCount(0);
        if (scenario.surface === 'management-list') {
            await page.getByRole('button', { name: 'View tracks', exact: true }).click();
            b = page.getByTestId('side-panel-list').locator('div.group').filter({ hasText: 'Other Playlist track 2' }).first();
            await expect(b).toBeVisible();
            await b.hover();
        } else {
            b = page.locator('[data-folia-grid-item-id="online:netease:60001-0"]');
            await expect(b).toBeVisible();
            await b.click();
        }
    } else {
        b = await visiblePoster(true);
        await b.click();
        await expect(b).toHaveClass(/is-expanded/);
    }
    const next = b.getByRole('button', { name: management ? 'Add to Queue' : scenario.language === 'en' ? 'Play next' : '下一首播放', exact: true });
    await expect(next).toBeEnabled();
    const before = await page.evaluate(async () => {
        const path = '/src/stores/usePlaybackStore.ts';
        const s = (await import(path)).usePlaybackStore.getState();
        const audio = [...document.querySelectorAll('audio')].find(el => !el.paused)!;
        return { current: s.currentSong.id, src: audio.currentSrc, time: audio.currentTime, queue: s.playQueue.map((item: {id: unknown}) => item.id) };
    });
    const bTitle = await b.getAttribute('aria-label');
    // Measure before reordering: the canonical-queue collage moves B to its new slot on commit.
    const layout = await next.evaluate(button => {
        const card = button.closest('.lattice-poster, [data-folia-grid-item-id], div.group')!.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { contained: rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom, hit: button.contains(hit) };
    });
    expect(layout).toEqual({ contained: true, hit: true });
    await page.screenshot({ path: testInfo.outputPath('play-next.png') });
    await next.click();
    if (management) await expect(page.getByRole('button', { name: 'Playlist collage', exact: true })).toBeVisible();
    else await expect(page.locator('.lattice-root')).toBeVisible();
    const after = await page.evaluate(async () => {
        const playbackPath = '/src/stores/usePlaybackStore.ts';
        const settingsPath = '/src/stores/useAudioSettingsStore.ts';
        const orderPath = '/src/services/playbackOrder.ts';
        const s = (await import(playbackPath)).usePlaybackStore.getState();
        const mode = (await import(settingsPath)).useAudioSettingsStore.getState().loopMode;
        const order = (await import(orderPath)).getPlaybackOrder(s.playQueue, mode);
        const audio = [...document.querySelectorAll('audio')].find(el => !el.paused)!;
        return { current: s.currentSong.id, src: audio.currentSrc, time: audio.currentTime, mode,
            queue: s.playQueue.map((item: {id: unknown}) => item.id),
            next: order[order.findIndex((song: {id: unknown}) => song.id === s.currentSong.id) + 1] };
    });
    expect(after.current).toBe(before.current);
    expect(after.src).toBe(before.src);
    expect(after.time).toBeGreaterThanOrEqual(before.time);
    if (management) expect(Number(after.next.id)).toBe(60001);
    else expect(`${after.next.name} · ${after.next.artists[0].name}`).toBe(bTitle);
    expect(after.mode).toBe(scenario.mode === 'one' ? 'all' : scenario.mode);
    expect(after.queue.length).toBe(scenario.surface === 'playlist' ? 2 : before.queue.length + (otherPlaylist ? 1 : 0));
    if (otherPlaylist) {
        expect(Number(after.next.id)).toBeGreaterThanOrEqual(60000);
        expect(after.queue.filter((id: number) => id >= 60000)).toEqual([after.next.id]);
        expect(after.queue.filter((id: number) => id < 60000)).toEqual(before.queue);
    }
    await page.evaluate(() => [...document.querySelectorAll('audio')].find(el => !el.paused)!.dispatchEvent(new Event('ended', { bubbles: true })));
    await expect.poll(async () => (await playbackState(page)).current).toBe(after.next.id);
    expect(errors).toEqual([]);
});
}

test('homepage → playlist collage → management → collage → back; browsing does not change playback', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const fixture = await setup(page);
    await page.evaluate(async () => {
        const path = '/src/stores/usePlaybackStore.ts';
        const { usePlaybackStore } = await import(path);
        usePlaybackStore.getState().setPlayQueue([{ id: 99001, name: 'Existing queue, not this playlist',
            artists: [{ id: 1, name: 'Previous artist' }], album: { id: 1, name: 'Previous album' } }]);
    });
    const before = await playbackState(page);
    await openPlaylist(page);
    await expect(page.locator('.playlist-lattice-heading')).toContainText('120');
    await expect(page.locator('.lattice-poster').first()).toBeVisible();
    await expect(page.locator('.lattice-poster[aria-label*="Existing queue"]')).toHaveCount(0);
    await expect(page.locator('[data-folia-visualizer]')).toBeEmpty();
    expect(await playbackState(page)).toEqual(before);
    const loadedRequests = fixture.requests();
    await page.getByRole('button', { name: 'List & manage' }).click();
    await expect(page.locator('.lattice-root')).toHaveCount(0);
    await expect.poll(() => page.locator('[data-folia-visualizer]').evaluate(node => node.children.length)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Playlist collage', exact: true })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('[data-playlist-collage="9001"]')).toBeVisible();
    await expect(page.locator('.lattice-poster').first()).toBeVisible();
    expect(fixture.requests()).toBe(loadedRequests);
    await page.waitForTimeout(1300); // Includes the preserved poster entrance wave, for visual inspection.
    const layout = await page.locator('.lattice-root').evaluate(root => {
        const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON();
        return { root: rect(root), field: rect(root.querySelector('.lattice-field')), heading: rect(root.querySelector('.playlist-lattice-heading')),
            world: (root.querySelector('.lattice-world') as HTMLElement)?.style.transform,
            posters: [...root.querySelectorAll('.lattice-poster')].slice(0, 5).map(rect) };
    });
    await testInfo.attach('layout.json', { body: JSON.stringify(layout), contentType: 'application/json' });
    expect(layout.root.width).toBe(page.viewportSize()!.width);
    expect(layout.root.height).toBe(page.viewportSize()!.height);
    await page.screenshot({ path: testInfo.outputPath('playlist-collage.png') });
    await page.locator('.lattice-back').click();
    await expect(page.locator('[data-playlist-collage]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
    expect(await playbackState(page)).toEqual(before);
    await page.goForward();
    await expect(page.locator('[data-playlist-collage="9001"] .lattice-root')).toBeVisible();
    await page.locator('.lattice-back').click();
    expect(errors).toEqual([]);
});

test('a large playlist stays bounded and responds to dragging and back', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page, 1200);
    await openPlaylist(page);
    await expect(page.locator('.playlist-lattice-heading')).toContainText('1200');
    const mounted = await page.locator('.lattice-poster').count();
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(160);
    await page.waitForTimeout(1300);
    const visible = await page.locator('.lattice-poster').evaluateAll(posters => posters.filter(p => {
        const b = p.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
    }).length);
    expect(visible).toBeGreaterThan(15);
    expect(visible).toBeLessThan(45);
    const started = Date.now();
    await page.mouse.move(750, 700);
    await page.mouse.down();
    await page.mouse.move(240, 440, { steps: 35 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'List & manage' }).click({ timeout: 5000 });
    await expect(page.locator('.lattice-root')).toHaveCount(0);
    await page.getByRole('button', { name: 'Playlist collage', exact: true }).click();
    await page.locator('.lattice-back').click({ timeout: 5000 });
    await expect(page.locator('[data-playlist-collage]')).toHaveCount(0);
    await testInfo.attach('interaction.json', { body: JSON.stringify({ tracks: 1200, mounted, visible, interactionMs: Date.now() - started }), contentType: 'application/json' });
    expect(errors).toEqual([]);
});

for (const entry of ['player', 'lattice'] as const) {
test(`playing a playlist card respects the ${entry} setting; next track keeps that surface`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page, 24);
    // Use the real settings cards, not a store write: both choices must be reachable and save.
    await page.evaluate(async () => {
        const path = '/src/stores/useSettingsModalStore.ts';
        const { useSettingsModalStore } = await import(path);
        useSettingsModalStore.getState().openSettings('options', 'general', null, 'playbackEntryView');
    });
    const section = page.locator('#settings-playbackEntryView');
    await section.getByRole('button', { name: entry === 'player' ? 'Lattice (queue collage)' : 'Visualizer', exact: true }).click();
    const choice = section.getByRole('button', { name: entry === 'player' ? 'Visualizer' : 'Lattice (queue collage)', exact: true });
    const cardLayout = await section.getByRole('button').evaluateAll(cards => cards.map(card => {
        const rect = card.getBoundingClientRect();
        return { label: card.getAttribute('aria-label'), rect: rect.toJSON() };
    }));
    await testInfo.attach('entry-card-layout.json', { body: JSON.stringify(cardLayout), contentType: 'application/json' });
    expect(cardLayout[0].rect.width).toBeGreaterThan(150);
    expect(cardLayout[0].rect.right).toBeLessThanOrEqual(cardLayout[1].rect.left);
    await page.screenshot({ path: testInfo.outputPath('entry-cards.png'), timeout: 5000 });
    await choice.click({ timeout: 5000 });
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(choice).toContainText('Selected');
    expect(await page.evaluate(() => localStorage.getItem('playback_entry_view'))).toBe(entry);
    await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Options', exact: true })).toHaveCount(0);
    await openPlaylist(page);
    await expect(page.locator('.playlist-lattice-heading')).toContainText('24 tracks');
    await page.waitForTimeout(1300);
    // Short playlists repeat: click a measured on-screen copy, not an offscreen preload.
    const instanceId = await page.locator('.lattice-poster[aria-label="Playlist track 2 · Fixture artist"]').evaluateAll(posters => {
        const visible = posters.find(p => { const b = p.getBoundingClientRect(); return b.left >= 0 && b.top > 100 && b.right <= innerWidth && b.bottom <= innerHeight; });
        return visible?.getAttribute('data-instance-id');
    });
    expect(instanceId).toBeTruthy();
    const poster = page.locator(`.lattice-poster[data-instance-id=${JSON.stringify(instanceId)}]`);
    await poster.click({ timeout: 5000 });
    await expect(poster).toHaveClass(/is-expanded/);
    await poster.focus();
    await poster.press('Enter');
    await expect.poll(async () => (await playbackState(page)).current).toBe(50001);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(audio => !audio.paused && audio.currentTime > 0.1))).toBe(true);
    expect((await playbackState(page)).queue).toHaveLength(24);
    const expectChosenSurface = async () => {
        await expect.poll(async () => (await playbackState(page)).view).toBe(entry === 'player' ? 'player' : 'home');
        if (entry === 'lattice') {
            await expect(page.locator('[data-playlist-collage="9001"] .lattice-root')).toBeVisible();
        } else {
            await expect(page.locator('[data-playlist-collage="9001"] .lattice-root')).not.toBeVisible();
        }
    };
    await expectChosenSurface();
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await expect.poll(async () => (await playbackState(page)).current).toBe(50002);
    await expectChosenSurface();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(audio => !audio.paused && audio.currentTime > 0.1))).toBe(true);
    await page.evaluate(() => {
        const active = [...document.querySelectorAll('audio')].find(audio => !audio.paused);
        active!.dispatchEvent(new Event('ended', { bubbles: true }));
    });
    await expect.poll(async () => (await playbackState(page)).current).toBe(50003);
    await expectChosenSurface();
    if (entry === 'player') await page.goBack();
    await page.locator('.lattice-back').click();
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
    expect((await playbackState(page)).queue).toHaveLength(24);
    expect(errors).toEqual([]);
});
}

test('empty and failed playlists remain escapable and failed loading can retry', async ({ page }) => {
    await setup(page, 0, true);
    await openPlaylist(page);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(page.locator('.lattice-empty')).toBeVisible();
    await page.locator('.lattice-back').click();
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
});

for (const failure of [
    { kind: 'not-public', text: 'This playlist is not public, so the current music source cannot read its contents' },
    { kind: 'generic', text: 'Failed to load: Fixture service unavailable' },
] as const) {
    test(`playlist collage preserves the shared ${failure.kind} error and retry clears it`, async ({ page }) => {
        await setup(page, 3);
        // Inject at the shared Omni boundary: this is a presentation/loader integration test,
        // not another copy of QQ's provider rules or a request to a private account.
        await page.evaluate(async kind => {
            const omniPath = '/src/services/onlineMusic/omni.ts';
            const typePath = '/src/types/onlineMusic.ts';
            const { omni } = await import(omniPath);
            const { OmniError } = await import(typePath);
            const original = omni.getCollectionTracks.bind(omni);
            // Keep the outage stable while collection metadata may refresh; the test explicitly
            // restores the provider before clicking Retry rather than relying on request counts.
            Object.assign(window, { __restorePlaylistTracks: () => { omni.getCollectionTracks = original; } });
            omni.getCollectionTracks = async (collection: { id: unknown }, ...args: unknown[]) => {
                if (String(collection.id) === '9001') {
                    throw kind === 'not-public'
                        ? new OmniError('not-public', 'Fixture private playlist', 'qq')
                        : new Error('Fixture service unavailable');
                }
                return original(collection, ...args);
            };
        }, failure.kind);
        const before = await playbackState(page);
        await openPlaylist(page);
        await expect(page.locator('.lattice-empty')).toContainText(failure.text);
        await expect(page.locator('.lattice-empty')).not.toContainText('This playlist is empty');
        await page.evaluate(() => {
            const fixture = window as typeof window & { __restorePlaylistTracks?: () => void };
            fixture.__restorePlaylistTracks?.();
            delete fixture.__restorePlaylistTracks;
        });
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(page.locator('.lattice-poster').first()).toBeVisible();
        await expect(page.locator('.lattice-empty')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
        expect(await playbackState(page)).toEqual(before);
        await page.locator('.lattice-back').click();
        await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
    });
}
