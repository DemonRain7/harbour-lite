import React, { useEffect, useState } from 'react';
import TemperaImageLayerControls from '../../src/components/visualizer/tempera/TemperaImageLayerControls';
import { DEFAULT_TEMPERA_LAYER_IMAGE } from '../../src/types';
import { saveTemperaLayerImage } from '../../src/services/temperaLayerImages';
import { useVisualizerSettingsStore } from '../../src/stores/useVisualizerSettingsStore';
import { useStatusMessage } from '../../src/stores/useStatusMessageStore';
import type { ProbeDefinition } from './definition';

// dev/probes/temperaWorkshop.probe.tsx
// Real IndexedDB and store, with small deterministic artwork and no music/network/AI.
function TemperaWorkshopProbe() {
    const [ready, setReady] = useState(false), [day, setDay] = useState(false), [fail, setFail] = useState(false);
    const [mounted, setMounted] = useState(true);
    const tuning = useVisualizerSettingsStore(state => state.temperaTuning);
    const commit = useVisualizerSettingsStore(state => state.handleSetTemperaTuning);
    const message = useStatusMessage();
    useEffect(() => {
        let cancelled = false;
        void Promise.all(['#a99be8', '#dfad6d', '#87bfad'].map(async (color, i) => {
            const id = `workshop-probe-${i}`, name = ['Moon.svg', 'Sun.svg', 'Leaf.svg'][i];
            const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500"><rect x="40" y="30" width="320" height="440" rx="150" fill="${color}"/><circle cx="200" cy="180" r="94" fill="#f9f2dc"/><path d="M70 425 Q200 165 330 425Z" fill="#39333f"/><circle cx="230" cy="156" r="64" fill="${color}"/></svg>`], { type: 'image/svg+xml' });
            await saveTemperaLayerImage({ id, name, mimeType: blob.type, blob, thumbnail: blob });
            return { ...DEFAULT_TEMPERA_LAYER_IMAGE, id, name, align: 'right' as const, verticalAlign: 'center' as const };
        })).then(layerImages => {
            if (cancelled) return;
            commit({ layerImages, layerImageFrequency: .8, layerImageDepth: 'back' });
            setReady(true);
        });
        const unmount = () => setMounted(false);
        window.addEventListener('workshop-probe-unmount', unmount);
        return () => { cancelled = true; window.removeEventListener('workshop-probe-unmount', unmount); };
    }, [commit]);
    return <div className="min-h-screen p-8" style={{ background: day ? '#f7f6f3' : '#121214', color: day ? '#171717' : '#f4f4f5' }}>
        <button onClick={() => setDay(value => !value)} className="mr-6">Toggle daylight</button>
        <label><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />Simulate save failure</label>
        <div className="mt-6 max-w-xl">{ready && mounted && <TemperaImageLayerControls images={tuning.layerImages}
            depth={tuning.layerImageDepth} frequency={tuning.layerImageFrequency} isDaylight={day}
            rangeInputClass="w-full accent-current" onCommit={next => { if (fail) throw new Error('fixture save rejected'); commit(next); }} />}</div>
        <output data-testid="workshop-status">{message?.text}</output>
        <pre data-testid="workshop-saved" className="mt-4 max-w-xl overflow-auto text-xs">{JSON.stringify(tuning)}</pre>
    </div>;
}
export default { id: 'temperaWorkshop', title: 'Tempera image workshop',
    description: 'Image placement, transactional drafts and responsive layout.', Component: TemperaWorkshopProbe } satisfies ProbeDefinition;
