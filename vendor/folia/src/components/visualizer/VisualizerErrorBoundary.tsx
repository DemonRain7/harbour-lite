import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { VisualizerSharedProps } from './definition';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../utils/fontStacks';

// src/components/visualizer/VisualizerErrorBoundary.tsx
// A failed/lazy-rejected visualizer must not unmount App's audio element and IPC bridge.
type Props = VisualizerSharedProps & { mode: string; children: React.ReactNode };
type State = { mode: string; failed: boolean };

function Fallback({ retry, ...props }: Props & { retry: () => void }) {
    const { t } = useTranslation();
    const line = props.lines?.[props.currentLineIndex]?.fullText;
    return <div data-testid="visualizer-fallback" className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8 text-center"
        style={{ color: props.theme.primaryColor, backgroundColor: props.theme.backgroundColor,
            fontFamily: resolveThemeFontStack(props.theme), fontWeight: resolveThemeFontWeight(props.theme, 400) }}>
        <p role="status" className="text-sm opacity-70">{t('visualizerRecovery.message')}</p>
        {props.showText !== false && <p className="text-3xl">{line}</p>}
        <div className="flex flex-wrap justify-center gap-3" onClick={event => event.stopPropagation()}>
            <button type="button" onClick={retry} className="flex items-center gap-2 rounded-full border border-current px-5 py-2">
                <RotateCcw size={16} />{t('visualizerRecovery.retry')}
            </button>
            {props.onBack && <button type="button" onClick={props.onBack} className="flex items-center gap-2 rounded-full border border-current px-5 py-2">
                <ArrowLeft size={16} />{t('ui.backToHome')}
            </button>}
        </div>
    </div>;
}

export default class VisualizerErrorBoundary extends React.Component<Props, State> {
    state: State = { mode: this.props.mode, failed: false };
    static getDerivedStateFromProps(props: Props, state: State): State | null {
        return props.mode === state.mode ? null : { mode: props.mode, failed: false };
    }
    static getDerivedStateFromError(): Partial<State> { return { failed: true }; }
    componentDidCatch(error: Error) {
        console.error(`[Visualizer] ${this.props.mode} failed; audio and controls remain mounted`, error);
        window.harbourFolia?.reportFailure?.('visualizer', this.props.mode);
    }
    render() {
        return this.state.failed
            ? <Fallback {...this.props} retry={() => this.setState({ failed: false })} />
            : this.props.children;
    }
}
