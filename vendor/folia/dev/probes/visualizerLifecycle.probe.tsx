import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMotionValue } from 'framer-motion';
import VisualizerRenderer from '../../src/components/visualizer/VisualizerRenderer';
import { appendVisualizerEntry, getVisualizerRegistryEntry } from '../../src/components/visualizer/registry';
import { useVisualizerPixiHost } from '../../src/components/visualizer/pixiRuntimeHost';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { Line, VisualizerMode } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/visualizerLifecycle.probe.tsx
// A stable player parent exercises mode teardown against real Pixi scenes, not mocked renderers.
const lines: Line[] = Array.from({ length: 36 }, (_, index) => {
    const text = index % 2 ? 'Music stays with you' : '风潮愈烈 我们已决意抗争到底';
    const words = text.split(' ').map((word, offset) => ({
        text: word, startTime: index * 4 + offset * 0.6, endTime: index * 4 + offset * 0.6 + 0.5,
    }));
    return { id: `lifecycle-${index}`, startTime: index * 4, endTime: index * 4 + 3.8,
        fullText: text, words, isChorus: index % 4 === 0 };
});

const RenderFailure = (): React.JSX.Element => { throw new Error('fixture visualizer render failed'); };
const CommitFailure = () => {
    useEffect(() => {
        let live = false;
        const timer = setTimeout(() => { live = true; }, 50);
        return () => { clearTimeout(timer); if (live) throw new Error('fixture visualizer effect cleanup failed'); };
    }, []);
    return <div>Cleanup failure fixture</div>;
};
const PixiCleanupFailure = () => {
    const hostRef = useRef<HTMLDivElement>(null);
    useVisualizerPixiHost({ hostRef, label: 'fixture', rebuildKey: [], song: 'fixture',
        create: async host => { const canvas = document.createElement('canvas'); host.append(canvas); return { canvas }; },
        swap: () => {}, destroy: () => { throw new Error('fixture Pixi cleanup failed'); } });
    return <div ref={hostRef} data-testid="cleanup-host" />;
};
for (const [id, component] of [['render', <RenderFailure />], ['commit', <CommitFailure />],
    ['pixi', <PixiCleanupFailure />], ['lazy', React.createElement(React.lazy(() => Promise.reject(new Error('fixture lazy import failed'))))]] as const) {
    appendVisualizerEntry({ ...getVisualizerRegistryEntry('classic'), mode: `mod:lifecycle:${id}`, render: () => component });
}

const VisualizerLifecycleProbe = () => {
    const [mode, setMode] = useState<VisualizerMode>('tempera');
    const [seconds, setSeconds] = useState(20);
    const [alive, setAlive] = useState(0);
    const currentTime = useMotionValue(seconds);
    const audioPower = useMotionValue(0.3);
    const audioBands = useMemo(() => ({ bass: audioPower, lowMid: audioPower, mid: audioPower,
        vocal: audioPower, treble: audioPower }), [audioPower]);
    const playerId = useRef(Math.random().toString(36));
    useEffect(() => {
        const timer = setInterval(() => setAlive(value => value + 1), 100);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => { currentTime.set(seconds); }, [seconds, currentTime]);
    return <div className="fixed inset-0" data-player-id={playerId.current}>
        <div className="absolute inset-0" data-visualizer-surface={mode}>
            <VisualizerRenderer mode={mode} currentTime={currentTime} currentLineIndex={Math.floor(seconds / 4)}
                lines={lines} theme={DEFAULT_THEME} audioPower={audioPower} audioBands={audioBands}
                showText paused={false} staticMode={false} seed="lifecycle" songTitle="Lifecycle test" />
        </div>
        <div className="fixed top-0 left-0 z-[100] bg-black text-white p-2">
            <output data-testid="player-alive">{alive}</output>
            {(['tempera', 'classic', 'sonnet', 'still'] as const).map(value =>
                <button key={value} onClick={() => setMode(value)} className="m-2">{value}</button>)}
            {(['render', 'commit', 'pixi', 'lazy'] as const).map(value =>
                <button key={value} onClick={() => setMode(`mod:lifecycle:${value}`)} className="m-2">Fault {value}</button>)}
            <button onClick={() => setSeconds(value => (value + 37) % 140)}>Seek scene</button>
        </div>
    </div>;
};

export default { id: 'visualizerLifecycle', title: 'Visualizer lifecycle',
    description: 'Live mode switching and Pixi cleanup under a persistent player parent.',
    Component: VisualizerLifecycleProbe } satisfies ProbeDefinition;
