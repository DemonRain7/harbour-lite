import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TemperaLayerImage } from '../../../types';
import { DEFAULT_TEMPERA_LAYER_IMAGE, TEMPERA_MAX_LAYER_IMAGES } from '../../../types';
import {
    clearTemperaLayerImage,
    isSupportedTemperaLayerImageFile,
    prepareTemperaLayerImage,
    saveTemperaLayerImage,
    type StoredTemperaLayerImage,
} from '../../../services/temperaLayerImages';
import {
    createTemperaImageArchive,
    readTemperaImageArchiveFile,
    TemperaArchiveTooLargeError,
} from '../../../services/temperaImageArchive';
import { createSafeObjectUrl } from '../../../utils/blobGuards';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { formatLocalDateStamp, sanitizeDownloadFileName } from '../../../utils/downloadFileName';
import TemperaImageLayerDialog from './TemperaImageLayerDialog';
import { useTemperaLayerImageThumbnails } from './useTemperaLayerImageThumbnails';
import TemperaImagePoolCard from './TemperaImagePoolCard';
import { useTemperaPoolDraft } from './useTemperaPoolDraft';
import type { TemperaImageLayerCommit } from './temperaWorkshopModel';
import './temperaWorkshop.css';

// src/components/visualizer/tempera/TemperaImageLayerControls.tsx
// Summary row for the user's own canvas images (character art, logos, textures): a strip of
// previews and the way into the dialog where they are actually managed. The files go straight
// to IndexedDB; only ids and placement are written back to the tuning.
//
// Everything the dialog edits is held here as a draft and written to the tuning only when the
// user saves. Editing the live tuning instead meant a synchronous localStorage write and a
// global store update on every pointermove of a slider, which pinned a core; the card preview
// is what gives feedback during the edit, so nothing is lost by holding the commit back.
export type { TemperaImageLayerCommit } from './temperaWorkshopModel';

interface TemperaImageLayerControlsProps {
    images: TemperaLayerImage[];
    depth: 'back' | 'front';
    frequency: number;
    rangeInputClass: string;
    isDaylight: boolean;
    /** One patch for the whole layer, so a session of edits costs a single store write. */
    onCommit: (next: TemperaImageLayerCommit) => void;
    initiallyOpen?: boolean;
    onClosed?: () => void;
}

/**
 * The two ways the pool is refilled, and the wording each gets in the result toast. They are the
 * same two numbers either way - what landed and what did not - but sharing one line across a
 * drag-and-drop and a backup restore misdescribes one of them.
 */
const POOL_RESULT_WORDS = {
    add: {
        addedKey: 'options.temperaLayerImagesAdded',
        addedDefault: '已添加 {{count}} 张图片',
        notAddedKey: 'options.temperaLayerImagesNotAdded',
        notAddedDefault: '未添加 {{count}} 张图片',
    },
    import: {
        addedKey: 'options.temperaPoolImported',
        addedDefault: '已导入 {{count}} 张图片',
        notAddedKey: 'options.temperaPoolImportNotAdded',
        notAddedDefault: '未导入 {{count}} 张图片',
    },
} as const;

type PoolResultVerb = keyof typeof POOL_RESULT_WORDS;

const TemperaImageLayerControls: React.FC<TemperaImageLayerControlsProps> = ({
    images,
    depth,
    frequency,
    rangeInputClass,
    isDaylight,
    onCommit,
    initiallyOpen,
    onClosed,
}) => {
    const { t } = useTranslation();
    const { draft, setDraft, isDialogOpen, dirty, error, busy, busyRef, setBusy, open, cancel, requestClose, commit,
        createdIdsRef, activeWriteAbortRef, isMountedRef } = useTemperaPoolDraft({
        layerImages: images, layerImageDepth: depth, layerImageFrequency: frequency,
    }, onCommit, t, initiallyOpen, onClosed);

    const previewImages = isDialogOpen ? draft.layerImages : images;
    const thumbnails = useTemperaLayerImageThumbnails(previewImages);

    // Files the pool cannot take are invisible otherwise: the strip looks exactly as it did, so
    // "three of your five files went in" has to be said rather than inferred. The toast carries
    // only the two counts - a mixed drop can be part unsupported, part over the cap, part
    // unreadable, and a one-line reason that is wrong misdirects - so the breakdown goes to the
    // console. `verb` only picks the wording: "imported" for a drop misdescribes what happened.
    const reportPoolResult = useCallback((
        verb: PoolResultVerb,
        added: number,
        notAdded: number,
        detail: Record<string, unknown>,
    ) => {
        // A run cancelled by unmount has been rolled back, so it has no result to report.
        if (!isMountedRef.current) return;
        const words = POOL_RESULT_WORDS[verb];
        const notes: string[] = [];
        // A batch where nothing landed has no plus side to state, and a leading "0 张" only
        // buries the one count that does matter.
        if (added > 0) {
            notes.push(t(words.addedKey, { defaultValue: words.addedDefault, count: added }));
        }
        if (notAdded > 0) {
            notes.push(t(words.notAddedKey, { defaultValue: words.notAddedDefault, count: notAdded }));
            console.info('[Tempera] canvas image pool left files out', detail);
        }
        setStatusMessage({ type: added === 0 ? 'error' : 'success', text: notes.join(' · ') });
    }, [t]);

    // Every way artwork reaches the pool - the footer button, its file input, a drop - ends up
    // here, which is what makes this the only place that can refuse a second run. Two overlapping
    // is not just a wasted pass: each reads the same free-slot count before either writes, so both
    // prepare files for slots the other is about to take, and the loser's tail stays in IndexedDB
    // as blobs no placement points at.
    const handleFiles = useCallback(async (files: File[]) => {
        if (files.length === 0 || busyRef.current !== 'idle') return;
        const abortController = new AbortController();
        activeWriteAbortRef.current = abortController;
        setBusy('adding');
        let saved: StoredTemperaLayerImage[] = [];
        try {
            const room = Math.max(0, TEMPERA_MAX_LAYER_IMAGES - draft.layerImages.length);
            const supported = files.filter(isSupportedTemperaLayerImageFile);
            const accepted = supported.slice(0, room);
            // `accepted` is what fit the free slots, so the supported tail behind it is the cap's
            // doing. Counting what was taken in and then lost instead always reads zero: preparing
            // a record only fails on a thumbnail it can live without.
            const overCap = supported.length - accepted.length;
            const unsupported = files.length - supported.length;
            if (accepted.length === 0) {
                reportPoolResult('add', 0, files.length, { total: files.length, unsupported, overCap });
                return;
            }
            const stored = await Promise.all(accepted.map(file => (
                prepareTemperaLayerImage(file).catch(error => {
                    console.error('[Tempera] canvas image could not be stored:', error);
                    return null;
                })
            )));
            const prepared = stored.filter((image): image is StoredTemperaLayerImage => image !== null);
            // Only what IndexedDB accepted may enter the pool. A refused write used to reach no
            // further than the console while the id still landed in the draft, so the pool showed
            // a picture it cannot resolve - an id with nothing behind it.
            if (abortController.signal.aborted) return;
            saved = (await Promise.all(prepared.map(image => (
                saveTemperaLayerImage(image)
                    .then(() => image)
                    .catch(error => {
                        console.error('[Tempera] canvas image could not be saved:', error);
                        return null;
                    })
            )))).filter((image): image is StoredTemperaLayerImage => image !== null);
            if (abortController.signal.aborted || !isMountedRef.current) {
                await Promise.all(saved.map(image => clearTemperaLayerImage(image.id).catch(() => undefined)));
                return;
            }
            saved.forEach(image => createdIdsRef.current.add(image.id));
            setDraft(current => ({
                ...current,
                layerImages: [
                    ...current.layerImages,
                    ...saved.map(image => ({
                        ...DEFAULT_TEMPERA_LAYER_IMAGE,
                        id: image.id,
                        name: image.name,
                    })),
                ].slice(0, TEMPERA_MAX_LAYER_IMAGES),
            }));
            reportPoolResult(
                'add',
                saved.length,
                unsupported + overCap + (accepted.length - saved.length),
                {
                    total: files.length,
                    unsupported,
                    overCap,
                    // Taken in and then lost before a record existed: the file could not be read.
                    unreadable: accepted.length - prepared.length,
                    // A record was built but IndexedDB refused it, and nothing can resolve this id.
                    unsaved: prepared.length - saved.length,
                },
            );
        } finally {
            if (activeWriteAbortRef.current === abortController) activeWriteAbortRef.current = null;
            if (isMountedRef.current) setBusy('idle');
        }
    }, [draft.layerImages.length, reportPoolResult, busyRef, setBusy, activeWriteAbortRef, isMountedRef, createdIdsRef, setDraft]);

    const patch = useCallback((id: string, next: Partial<TemperaLayerImage>) => {
        setDraft(current => ({
            ...current,
            layerImages: current.layerImages.map(image => (image.id === id ? { ...image, ...next } : image)),
        }));
    }, []);

    const remove = useCallback((id: string) => {
        setDraft(current => ({
            ...current,
            layerImages: current.layerImages.filter(image => image.id !== id),
        }));
    }, []);

    const clearAll = useCallback(() => {
        setDraft(current => ({ ...current, layerImages: [] }));
    }, [setDraft]);

    const exportPool = useCallback(async () => {
        // Not a live path - the button's `disabled` already blocks this - but all three write
        // `busy`, and an asymmetry here is a second run waiting to be found.
        if (busyRef.current !== 'idle') return;
        setBusy('exporting');
        try {
            const archive = await createTemperaImageArchive({ layerImages: draft.layerImages });
            if (archive.exported === 0) throw new Error('Tempera pool export held no image');
            const url = createSafeObjectUrl(archive.blob);
            if (!url) throw new TypeError('Tempera pool export must produce a Blob');
            const link = document.createElement('a');
            link.href = url;
            link.download = `${sanitizeDownloadFileName(
                // Falls back to the shipped Chinese name: the key is new and a stale locale
                // file would otherwise name the file after the raw key.
                t('options.temperaExportBaseName') || '凝彩参数-画布图片备份',
            )}-${formatLocalDateStamp()}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);

            // A picture whose file has gone missing is left out of the zip, so the count the
            // pool shows and the one the backup holds can differ; say so instead of letting the
            // user discover it on a restore.
            const notes = [t('options.temperaPoolExported', {
                defaultValue: '已导出 {{count}} 张图片',
                count: archive.exported,
            })];
            if (archive.skipped > 0) {
                notes.push(t('options.temperaPoolExportSkipped', {
                    defaultValue: '{{count}} 张的原文件已丢失，未写入备份',
                    count: archive.skipped,
                }));
            }
            setStatusMessage({ type: 'success', text: notes.join(' · ') });
        } catch (error) {
            console.error('[Tempera] canvas image pool export failed:', error);
            setStatusMessage({ type: 'error', text: t('options.temperaPoolExportFailed') || '导出失败' });
        } finally {
            setBusy('idle');
        }
    }, [busyRef, setBusy, draft.layerImages, t]);

    // Same single-gate shape as `handleFiles`, and the native picker is why the guard cannot live
    // in the dialog: it stays open after the click that opened it, so a drop can start an import
    // while a picker is still waiting, and both resolve into the same draft.
    const importPool = useCallback(async (file: File, mode: 'replace' | 'append') => {
        if (busyRef.current !== 'idle') return;
        // Replacement is destructive once the resulting draft is committed, so confirm the mode
        // before reading or writing the selected archive.
        if (mode === 'replace' && draft.layerImages.length > 0
            && !window.confirm(t('options.temperaImportConfirmReplace', {
                defaultValue: '替换导入会先清空当前 {{count}} 张图片，确定继续？',
                count: draft.layerImages.length,
            }))) {
            return;
        }

        const abortController = new AbortController();
        activeWriteAbortRef.current = abortController;
        setBusy('importing');
        try {
            const result = await readTemperaImageArchiveFile(file, {
                existing: mode === 'append' ? draft.layerImages : [],
                signal: abortController.signal,
            });
            if (abortController.signal.aborted || !isMountedRef.current) {
                await Promise.all(result.layerImages.map(image => (
                    clearTemperaLayerImage(image.id).catch(() => undefined)
                )));
                return;
            }
            // A backup that yields nothing is a failure the user has to hear about, but there are
            // two very different reasons for it: a pool that was already full when the zip landed
            // (every entry was counted as left out) and a zip that simply held no picture worth
            // restoring. Saying "no usable image" for the first would send the user looking for a
            // better backup when the fix is to make room.
            if (result.layerImages.length === 0) {
                console.warn('[Tempera] canvas image pool import added nothing', {
                    file: file.name,
                    skipped: result.skipped,
                    truncated: result.truncated,
                });
                // `truncated > 0` picks the wording - the cap is a "make room" problem, missing
                // bytes a "bad backup" one - but the count is every row that failed to land.
                const notAdded = result.skipped + result.truncated;
                setStatusMessage({
                    type: 'error',
                    text: result.truncated > 0
                        ? t('options.temperaPoolImportNotAdded', {
                            defaultValue: '未导入 {{count}} 张图片',
                            count: notAdded,
                        })
                        : (t('options.temperaPoolImportEmpty') || '这份备份里没有可用的图片'),
                });
                return;
            }

            // Original records remain intact until Save; only these new IDs belong to the draft.
            result.layerImages.forEach(image => createdIdsRef.current.add(image.id));

            // Only the pool travels in the zip: depth and frequency are pool-wide tuning the user
            // is looking at, and restoring a backup must not move them.
            setDraft(current => ({
                ...current,
                layerImages: (mode === 'append' ? current.layerImages : []).concat(result.layerImages),
            }));

            // `skipped` is manifest rows whose bytes are missing and `truncated` entries the cap
            // refused - disjoint, so together they are every backup row that did not land.
            reportPoolResult(
                'import',
                result.layerImages.length,
                result.skipped + result.truncated,
                {
                    file: file.name,
                    mode,
                    skipped: result.skipped,
                    truncated: result.truncated,
                },
            );
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') return;
            console.error('[Tempera] canvas image pool import failed:', error);
            setStatusMessage({
                type: 'error',
                text: error instanceof TemperaArchiveTooLargeError
                    ? (t('options.temperaPoolImportTooLarge') || '已取消导入：备份解压后预计超过 512 MB，疑似损坏或压缩炸弹')
                    : (t('options.temperaPoolImportFailed') || '导入失败'),
            });
        } finally {
            if (activeWriteAbortRef.current === abortController) activeWriteAbortRef.current = null;
            if (isMountedRef.current) setBusy('idle');
        }
    }, [draft.layerImages, reportPoolResult, t, busyRef, setBusy, activeWriteAbortRef, isMountedRef, createdIdsRef, setDraft]);

    return (
        <div className="space-y-3">
            {!initiallyOpen && <TemperaImagePoolCard images={images} thumbnails={thumbnails}
                frequency={frequency} isDaylight={isDaylight} onOpen={open} />}

            <TemperaImageLayerDialog
                isOpen={isDialogOpen}
                onClose={requestClose}
                onSave={commit}
                onCancel={cancel}
                dirty={dirty}
                error={error}
                isDaylight={isDaylight}
                t={t}
                images={draft.layerImages}
                thumbnails={thumbnails}
                depth={draft.layerImageDepth}
                frequency={draft.layerImageFrequency}
                maxImages={TEMPERA_MAX_LAYER_IMAGES}
                rangeInputClass={rangeInputClass}
                onAddFiles={files => void handleFiles(files)}
                onPatch={patch}
                onRemove={remove}
                onClearAll={clearAll}
                onDepthChange={layerImageDepth => setDraft(current => ({ ...current, layerImageDepth }))}
                onFrequencyChange={layerImageFrequency => setDraft(current => ({ ...current, layerImageFrequency }))}
                onImportPool={(file, mode) => void importPool(file, mode)}
                onExportPool={() => void exportPool()}
                busy={busy}
            />
        </div>
    );
};

export default TemperaImageLayerControls;
