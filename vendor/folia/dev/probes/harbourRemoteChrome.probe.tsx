import RemoteControlApp from '../../src/components/remote/RemoteControlApp';
import type { ProbeDefinition } from './definition';

// dev/probes/harbourRemoteChrome.probe.tsx
// A mocked Electron snapshot exercises the real remote button without a player or audio source.
export default {
    id: 'harbourRemoteChrome',
    title: 'Harbour remote click-through availability',
    description: 'Embedded players disable click-through; older standalone snapshots remain compatible.',
    Component: RemoteControlApp,
} satisfies ProbeDefinition;
