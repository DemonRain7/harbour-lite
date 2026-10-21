import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qqAuthenticatedPlayback.test.ts

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('@yakult-green-tea/qq-music-api/package.json'));
// Load the neutral service directly: the package root starts a real HTTP server on import.
const commonJsRuntime = require(
    path.join(packageRoot, 'dist/src/services/auth/qrLogin.js'),
);
const { createAndroidDevice } = require(path.join(packageRoot, 'dist/src/services/auth/androidDevice.js'));

const SONG_MID = '0016aHoC1IyI1d';
const MEDIA_MID = '000cBhud33Yofp';
const OTHER_MID = '0034QXzv2ptMdw';
const TOKEN = 'fixture-session';
const MUSIC_ID = '1234567890123456';
const MUSIC_KEY = 'fixture-musickey';
const NOW = 1_700_000_000_000;

type RpcBody = {
    comm: Record<string, unknown>;
    req_0: { module: string; method: string; param: Record<string, unknown> };
};
type RpcOptions = { headers?: Record<string, string> };

const blockedEntry = () => ({ songmid: SONG_MID, result: 104003, purl: '', vkey: '' });
const rpcResponse = (midurlinfo: unknown, code = 0, upstreamCode = 0, status = 200) => ({
    status,
    data: { code, req_0: { code: upstreamCode, data: { sip: ['https://example.test/'], midurlinfo } } },
});
const playableResponse = (purl = 'M500fixture.mp3?vkey=fixture') => rpcResponse([
    { songmid: SONG_MID, result: 0, purl, vkey: 'fixture' },
]);

// Keep auth validation and request serialization real, with all persistence and network in memory.
const createRuntimeFixture = (runtime: typeof commonJsRuntime, loginType = 2, expiresAt = NOW + 60_000) => {
    const credential = { musicid: 0, str_musicid: MUSIC_ID, musickey: MUSIC_KEY, loginType };
    const repository = runtime.createMemoryAuthSessionRepository([
        { token: TOKEN, credential, device: createAndroidDevice(), expiresAt },
    ]);
    const post = vi.fn(async (_url: string, _body: RpcBody, _options?: RpcOptions): Promise<ReturnType<typeof rpcResponse>> => {
        throw new Error('Unexpected upstream request');
    });
    const request = vi.fn(async () => { throw new Error('Unexpected transport request'); });
    const streamUrlProbe = vi.fn(async () => null);
    const service = runtime.createQrLoginService({
        http: { post, request }, authSessionRepository: repository, now: () => NOW, streamUrlProbe,
    });
    return { service, post, request, streamUrlProbe, repository };
};

describe.each(['CommonJS', 'ESM'])('QQ authenticated playback compatibility (%s)', format => {
    let runtime = commonJsRuntime;
    beforeAll(async () => {
        if (format === 'ESM') {
            runtime = await import(/* @vite-ignore */ pathToFileURL(
                path.join(packageRoot, 'dist-esm/src/services/auth/qrLogin.js'),
            ).href);
        }
    });
    const createFixture = (loginType = 2, expiresAt = NOW + 60_000) => createRuntimeFixture(runtime, loginType, expiresAt);

    it.each([
        ['128', 'M500', '.mp3'],
        ['320', 'M800', '.mp3'],
        ['flac', 'F000', '.flac'],
        ['ape', 'A000', '.ape'],
        ['m4a', 'C400', '.m4a'],
    ])('preserves the account, exact song and %s quality in one compatibility request', async (quality, prefix, extension) => {
        const { service, post, request, streamUrlProbe } = createFixture();
        const filename = `${prefix}${MEDIA_MID}${extension}`;
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()]))
            .mockResolvedValueOnce(playableResponse(`${filename}?vkey=fixture`));

        expect(await service.getMusicPlay(TOKEN, SONG_MID, quality, MEDIA_MID)).toEqual({
            [SONG_MID]: { url: `https://example.test/${filename}?vkey=fixture`, error: false },
        });
        expect(post).toHaveBeenCalledTimes(2);
        const [primaryUrl, primaryBody, primaryOptions] = post.mock.calls[0];
        const [fallbackUrl, fallbackBody, fallbackOptions] = post.mock.calls[1];
        expect(primaryBody).toMatchObject({
            comm: { ct: 11, qq: MUSIC_ID, authst: MUSIC_KEY, tmeLoginType: 2 },
            req_0: { module: 'music.vkey.GetVkey', method: 'UrlGetVkey', param: { songmid: [SONG_MID] } },
        });
        expect(fallbackUrl).toBe(primaryUrl);
        expect(fallbackUrl).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
        expect(fallbackBody).toMatchObject({
            comm: { uin: MUSIC_ID, authst: MUSIC_KEY, tmeLoginType: 2, ct: 19, cv: 0 },
            req_0: {
                module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
                param: { songmid: [SONG_MID], filename: [filename], songtype: [0], uin: MUSIC_ID, loginflag: 1, platform: '20' },
            },
        });
        expect(fallbackBody.req_0.param.guid).toBe(primaryBody.req_0.param.guid);
        expect(fallbackOptions?.headers?.Cookie).toBe(primaryOptions?.headers?.Cookie);
        expect(fallbackOptions?.headers?.Cookie).toContain(`qm_keyst=${MUSIC_KEY}`);
        expect(fallbackOptions?.headers?.Referer).toBe('https://y.qq.com/');
        expect(request).not.toHaveBeenCalled();
        expect(streamUrlProbe).not.toHaveBeenCalled();
    });

    it('uses doubled song mid only when the requested media mid is unavailable', async () => {
        const { service, post } = createFixture();
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()])).mockResolvedValueOnce(playableResponse());
        await service.getMusicPlay(TOKEN, SONG_MID, 320);
        expect(post.mock.calls[1][1].req_0.param.filename).toEqual([`M800${SONG_MID}${SONG_MID}.mp3`]);
    });

    it('does not replace a primary playable URL, even with an inconsistent restriction field', async () => {
        const { service, post } = createFixture();
        post.mockResolvedValueOnce(rpcResponse([{ ...blockedEntry(), purl: 'primary.mp3?vkey=fixture' }]));
        expect(await service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).toEqual({
            [SONG_MID]: { url: 'https://example.test/primary.mp3?vkey=fixture', error: false },
        });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, 'unknown-session'])('does not make any upstream request without authorization (%s)', async token => {
        const { service, post, request } = createFixture();
        expect(await service.getMusicPlay(token, SONG_MID, 128, MEDIA_MID)).toBeNull();
        expect(post).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('does not make any upstream request with an expired session', async () => {
        const { service, post } = createFixture(2, NOW - 1);
        expect(await service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).toBeNull();
        expect(post).not.toHaveBeenCalled();
    });

    it.each([0, 1, 6])('does not apply the compatibility profile to login type %s', async loginType => {
        const { service, post } = createFixture(loginType);
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()]));
        await service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not retry a batch even when only one blocked entry is returned', async () => {
        const { service, post } = createFixture();
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()]));
        await service.getMusicPlay(TOKEN, `${SONG_MID},${OTHER_MID}`, 128, MEDIA_MID);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['missing entries', undefined],
        ['non-array entries', {}],
        ['empty entries', []],
        ['null entry', [null]],
        ['missing result', [{ songmid: SONG_MID, purl: '' }]],
        ['string result', [{ ...blockedEntry(), result: '104003' }]],
        ['another result', [{ ...blockedEntry(), result: 104004 }]],
        ['missing purl', [{ songmid: SONG_MID, result: 104003 }]],
        ['null purl', [{ ...blockedEntry(), purl: null }]],
        ['mismatched song', [{ ...blockedEntry(), songmid: OTHER_MID }]],
        ['duplicate entries', [blockedEntry(), blockedEntry()]],
    ])('does not interpret %s as permission to try the compatibility profile', async (_label, entries) => {
        const { service, post } = createFixture();
        post.mockResolvedValueOnce(rpcResponse(entries));
        await service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it.each(['primary', 'compatibility'])('propagates a %s network failure without an automatic retry', async phase => {
        const { service, post, repository } = createFixture();
        const failure = new Error('fixture network failure');
        if (phase === 'compatibility') post.mockResolvedValueOnce(rpcResponse([blockedEntry()]));
        post.mockRejectedValueOnce(failure);
        await expect(service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).rejects.toBe(failure);
        expect(post).toHaveBeenCalledTimes(phase === 'primary' ? 1 : 2);
        expect(repository.load()).toHaveLength(1);
    });

    it.each([
        ['primary global', 'primary', 9001, 0],
        ['primary module', 'primary', 0, 9002],
        ['compatibility global', 'compatibility', 9001, 0],
        ['compatibility module', 'compatibility', 0, 9002],
    ])('propagates a %s protocol failure without another profile attempt', async (_label, phase, code, upstreamCode) => {
        const { service, post, repository } = createFixture();
        if (phase === 'compatibility') post.mockResolvedValueOnce(rpcResponse([blockedEntry()]));
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()], Number(code), Number(upstreamCode)));
        await expect(service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).rejects.toMatchObject({
            name: 'QqProtocolError', globalCode: code, upstreamCode,
        });
        expect(post).toHaveBeenCalledTimes(phase === 'primary' ? 1 : 2);
        expect(repository.load()).toHaveLength(1);
    });

    it.each([
        ['missing global code', () => ({
            status: 200, data: { req_0: rpcResponse([blockedEntry()]).data.req_0 },
        })],
        ['missing module code', () => ({
            status: 200, data: { code: 0, req_0: { data: rpcResponse([blockedEntry()]).data.req_0.data } },
        })],
        ['non-success HTTP status', () => rpcResponse([blockedEntry()], 0, 0, 503)],
    ])('rejects a primary response with %s before making a compatibility request', async (_label, response) => {
        const { service, post, repository } = createFixture();
        post.mockResolvedValueOnce(response() as ReturnType<typeof rpcResponse>);
        await expect(service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).rejects.toMatchObject({
            name: 'QqProtocolError', phase: 'get-music-play',
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect(repository.load()).toHaveLength(1);
    });

    it.each([{ statusCode: null }, { statusCode: false }, { statusCode: '' }, { statusCode: [] }])(
        'does not coerce malformed status $statusCode into successful playback authorization', async ({ statusCode }) => {
            for (const phase of ['primary', 'compatibility']) {
                for (const level of ['global', 'module']) {
                    const { service, post } = createFixture();
                    if (phase === 'compatibility') post.mockResolvedValueOnce(rpcResponse([blockedEntry()]));
                    const response = rpcResponse([blockedEntry()]);
                    if (level === 'global') response.data.code = statusCode as unknown as number;
                    else response.data.req_0.code = statusCode as unknown as number;
                    post.mockResolvedValueOnce(response);
                    await expect(service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).rejects.toMatchObject({ name: 'QqProtocolError' });
                    expect(post).toHaveBeenCalledTimes(phase === 'primary' ? 1 : 2);
                }
            }
        },
    );

    it.each([
        ['missing result envelope', { status: 200, data: { code: 0 } }],
        ['missing entries', rpcResponse(undefined)],
        ['different song', rpcResponse([{ songmid: OTHER_MID, purl: 'other.mp3', result: 0 }])],
        ['duplicate song', rpcResponse([blockedEntry(), blockedEntry()])],
        ['non-success HTTP status', rpcResponse([blockedEntry()], 0, 0, 503)],
    ])('rejects a compatibility response with %s instead of returning another track', async (_label, response) => {
        const { service, post } = createFixture();
        post.mockResolvedValueOnce(rpcResponse([blockedEntry()])).mockResolvedValueOnce(response as ReturnType<typeof rpcResponse>);
        await expect(service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).rejects.toMatchObject({ name: 'QqProtocolError' });
        expect(post).toHaveBeenCalledTimes(2);
    });

    it('keeps a second empty response unavailable without logging out or cycling profiles', async () => {
        const { service, post, repository } = createFixture();
        post.mockResolvedValue(rpcResponse([blockedEntry()]));
        expect(await service.getMusicPlay(TOKEN, SONG_MID, 128, MEDIA_MID)).toEqual({
            [SONG_MID]: { url: '', error: '暂无播放链接' },
        });
        expect(post).toHaveBeenCalledTimes(2);
        expect(repository.load()).toHaveLength(1);
    });
});
