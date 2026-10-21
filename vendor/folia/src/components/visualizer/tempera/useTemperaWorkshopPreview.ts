import { useEffect, useState } from 'react';
import { createTemperaLayerImageThumbnail, getTemperaLayerImage } from '../../../services/temperaLayerImages';

// src/components/visualizer/tempera/useTemperaWorkshopPreview.ts
// Only the selected picture gets a larger preview. Gallery thumbnails and playback originals stay unchanged.
export function useTemperaWorkshopPreview(id: string) {
    const [preview, setPreview] = useState<{ id: string; url?: string }>({ id });
    useEffect(() => {
        let cancelled = false;
        let url: string | undefined;
        void getTemperaLayerImage(id).then(async stored => {
            if (!stored || cancelled) return;
            const blob = await createTemperaLayerImageThumbnail(stored.blob, 1024) ?? stored.blob;
            if (cancelled) return;
            url = URL.createObjectURL(blob);
            setPreview({ id, url });
        }).catch(() => undefined);
        return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
    }, [id]);
    return preview.id === id ? preview.url : undefined;
}
