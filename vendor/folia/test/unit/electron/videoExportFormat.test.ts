import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSupportedVideoExportFormat } from '../../../src/services/electronVideoExport';

afterEach(() => vi.unstubAllGlobals());

describe('hosted recording format', () => {
    it('prefers WebM even when the runtime advertises MP4', () => {
        vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
        expect(getSupportedVideoExportFormat()).toMatchObject({ extension: 'webm', mimeType: 'video/webm;codecs=vp8,opus' });
    });
    it('retains MP4 for runtimes without WebM', () => {
        vi.stubGlobal('MediaRecorder', { isTypeSupported: (mime: string) => mime.startsWith('video/mp4') });
        expect(getSupportedVideoExportFormat()?.extension).toBe('mp4');
    });
    it('does not promise recording if no encoder is supported', () => {
        vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });
        expect(getSupportedVideoExportFormat()).toBeNull();
    });
});
