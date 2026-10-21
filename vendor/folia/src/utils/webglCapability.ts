// src/utils/webglCapability.ts
// Probe once per renderer; reload rechecks after a graphics configuration change.
// Release the probe context so checking support does not consume a shader slot.
let webgl2Available: boolean | undefined;

export function canUseWebGL2(): boolean {
    if (typeof document === 'undefined') return false;
    if (webgl2Available !== undefined) return webgl2Available;
    try {
        const gl = document.createElement('canvas').getContext('webgl2');
        webgl2Available = !!gl;
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
        webgl2Available = false;
    }
    return webgl2Available;
}
