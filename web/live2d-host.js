(() => {
  /**
   * Stable renderer seam for locally installed Cubism 4/5 assets.
   * Harbour intentionally does not ship Cubism Core or character models. The desktop client
   * installs those proprietary assets into the local character directory; until they are present
   * this host reports a reason and leaves the pixel pet on.
   */
  async function createHost({ canvas, manifest, assetBase }) {
    const config = manifest?.visual?.live2d || {};
    let adapter = null;
    let ready = false;
    let manuallyPaused = false;
    let drawing = null;
    let reason = "Live2D 未启用；正在使用像素桌宠";
    const syncVisibility = () => {
      if (!ready) return;
      const next = !manuallyPaused && !document.hidden && window.HarbourVisualActivity?.isActive() !== false;
      if (drawing === next) return;
      drawing = next;
      if (next) adapter?.resume?.(); else adapter?.pause?.();
    };

    const removeVisualListener = window.HarbourVisualActivity?.subscribe(syncVisibility);
    if (config.enabled === true) {
      const runtimeUrl = new URL(config.runtime || "live2d/live2dcubismcore.min.js", assetBase).toString();
      try {
        await loadScript(runtimeUrl);
        if (!window.Live2DCubismCore) throw new Error("缺少官方 Cubism Core");
        if (config.adapter && typeof window.HarbourCubismAdapter?.create !== "function") {
          const adapterUrl = new URL(config.adapter, assetBase);
          adapterUrl.searchParams.set("v", String(config.behaviorVersion || 1));
          await loadScript(adapterUrl.toString());
        }
        if (typeof window.HarbourCubismAdapter?.create !== "function") {
          throw new Error("缺少 Harbour Cubism renderer adapter");
        }
        adapter = await window.HarbourCubismAdapter.create({
          canvas,
          modelUrl: new URL(config.model, assetBase).toString(),
          parameters: config.parameters || {},
          actions: config.actions || {},
          interactions: config.interactions || {},
          fit: config.fit || {},
        });
        ready = true;
        reason = "Live2D 已就绪";
        canvas.hidden = false;
        document.addEventListener("visibilitychange", syncVisibility);
        syncVisibility();
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        canvas.hidden = true;
      }
    } else {
      canvas.hidden = true;
    }

    return {
      ready,
      reason,
      setMouthOpen(value) {
        if (!ready) return;
        adapter?.setMouthOpen?.(Math.max(0, Math.min(1, Number(value) || 0)));
      },
      setState(state, detail) { if (ready) adapter?.setState?.(state, detail); },
      lookAt(point) { if (ready) adapter?.lookAt?.(point); },
      interact(point) { return ready ? adapter?.interact?.(point) : Promise.resolve(false); },
      resetPose() { return ready ? adapter?.resetPose?.() : Promise.resolve(); },
      pause() { manuallyPaused = true; syncVisibility(); },
      resume() { manuallyPaused = false; syncVisibility(); },
      diagnostics() { return adapter?.diagnostics?.(); },
      resize() { if (ready) adapter?.resize?.(); },
      destroy() {
        removeVisualListener?.();
        document.removeEventListener("visibilitychange", syncVisibility);
        adapter?.destroy?.(); adapter = null; ready = false;
      },
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((script) => script.src === src);
      if (existing?.dataset.loaded === "true") return resolve();
      const script = existing || document.createElement("script");
      script.src = src;
      script.async = true;
      script.addEventListener("load", () => { script.dataset.loaded = "true"; resolve(); }, { once: true });
      script.addEventListener("error", () => reject(new Error(`无法加载 Live2D runtime: ${src}`)), { once: true });
      if (!existing) document.head.appendChild(script);
    });
  }

  window.HarbourLive2D = { createHost };
})();
