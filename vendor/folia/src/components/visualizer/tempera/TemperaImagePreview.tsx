import React, { useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { TemperaLayerImage } from '../../../types';
import { hashTemperaSeed } from './temperaRandom';
import { resolveTemperaImagePlacement } from './temperaImageLayer';
import { temperaAlignmentAt } from './temperaWorkshopModel';
import type { TemperaDialogTokens } from './temperaDialogTokens';
import { useTemperaWorkshopPreview } from './useTemperaWorkshopPreview';

// src/components/visualizer/tempera/TemperaImagePreview.tsx
// Lightweight placement proof, not a second Pixi player. A pointer drag commits one tendency on release.
export default function TemperaImagePreview({ image, thumbnail, depth, sample, tokens, t, onPatch }: {
    image: TemperaLayerImage; thumbnail?: string; depth: 'back' | 'front'; sample: number;
    tokens: TemperaDialogTokens; t: TFunction;
    onPatch: (id: string, next: Partial<TemperaLayerImage>) => void;
}) {
    const stageRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const dragRef = useRef<{ pointer: number; x: number; y: number; moved: boolean } | null>(null);
    const preview = useTemperaWorkshopPreview(image.id) ?? thumbnail;
    const placement = useMemo(() => resolveTemperaImagePlacement(image, hashTemperaSeed(`workshop:${image.id}:${sample}`)), [image, sample]);
    const horizontal = ['left', 'center', 'right'] as const;
    const vertical = ['top', 'center', 'bottom'] as const;
    const restorePosition = () => {
        if (!imageRef.current) return;
        imageRef.current.style.left = `${placement.x * 100}%`;
        imageRef.current.style.top = `${placement.y * 100}%`;
    };
    const coordinates = (event: React.PointerEvent) => {
        const bounds = stageRef.current!.getBoundingClientRect();
        return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
    };
    return <div ref={stageRef} className="tempera-workshop-stage" data-testid="tempera-placement-preview"
        style={{ borderColor: tokens.line, backgroundColor: tokens.surface }}
        onPointerDown={event => {
            if (event.button !== 0) return;
            dragRef.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
            const drag = dragRef.current;
            if (!drag || drag.pointer !== event.pointerId) return;
            drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5;
            if (!drag.moved || !imageRef.current) return;
            const point = coordinates(event);
            imageRef.current.style.left = `${Math.max(0, Math.min(1, point.x)) * 100}%`;
            imageRef.current.style.top = `${Math.max(0, Math.min(1, point.y)) * 100}%`;
        }}
        onPointerUp={event => {
            const drag = dragRef.current;
            if (!drag || drag.pointer !== event.pointerId) return;
            dragRef.current = null;
            const point = coordinates(event);
            restorePosition();
            onPatch(image.id, temperaAlignmentAt(point.x, point.y));
        }}
        onPointerCancel={() => { dragRef.current = null; restorePosition(); }}
        onLostPointerCapture={() => { dragRef.current = null; restorePosition(); }}>
        <div aria-hidden="true" className="pointer-events-none absolute -left-[8%] top-[12%] h-[60%] w-[55%] rotate-[-16deg]"
            style={{ background: tokens.checkerTint }} />
        <div aria-hidden="true" className="pointer-events-none absolute right-[10%] top-[12%] h-[60%] w-[30%] rounded-full border-[18px]"
            style={{ borderColor: tokens.checkerTint }} />
        {preview && <img ref={imageRef} src={preview} alt={image.name} draggable={false} data-testid="tempera-preview-image"
            style={{ height: `${placement.scale * 100}%`, left: `${placement.x * 100}%`, top: `${placement.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${placement.rotation}rad) scaleX(${placement.flip ? -1 : 1})`,
                opacity: placement.opacity, zIndex: depth === 'front' ? 2 : 0 }} />}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] flex flex-col justify-center gap-1 px-[12%]"
            style={{ color: tokens.textPrimary }}>
            <span className="text-[clamp(30px,4vw,56px)] font-semibold leading-none tracking-tight">FOLIA</span>
            <span className="text-xs tracking-[.2em] opacity-70">{t('options.temperaWorkshopSampleLyric')}</span>
        </div>
        <div className="tempera-workshop-grid">
            {vertical.flatMap((verticalAlign, y) => horizontal.map((align, x) => {
                const active = image.align === align && image.verticalAlign === verticalAlign;
                const label = t('options.temperaLayerAlignPosition', {
                    vertical: t(`options.${['temperaLayerAlignTop', 'temperaLayerAlignMiddle', 'temperaLayerAlignBottom'][y]}`),
                    horizontal: t(`options.${['temperaLayerAlignLeft', 'temperaLayerAlignCenter', 'temperaLayerAlignRight'][x]}`),
                });
                return <button key={`${align}-${verticalAlign}`} type="button" aria-label={label} aria-pressed={active}
                    title={label} style={{ borderColor: tokens.gridLine }}
                    onClick={event => { if (event.detail === 0) onPatch(image.id, { align, verticalAlign }); }}>
                    <span style={{ borderColor: tokens.markerBorder, backgroundColor: active ? tokens.accent : tokens.markerFill,
                        boxShadow: active ? tokens.markerHalo : undefined }} />
                </button>;
            }))}
        </div>
    </div>;
}
