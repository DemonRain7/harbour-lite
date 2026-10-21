// desktop/folia/crash-reporting.js
// Reuse Folia's crash log, but the child app cannot own Harbour's global process.
function createFoliaCrashReporting(appEvents) {
  const observed = new Map();
  let options = null;
  let quitting = false;
  let disposed = false;
  const markQuitting = () => { quitting = true; };
  appEvents.on('before-quit', markQuitting);
  appEvents.on('will-quit', markQuitting);

  function observe(contents) {
    // Transparency/embedding can move this exact view between native shells.
    if (disposed || observed.has(contents) || contents.isDestroyed()) return;
    const release = () => {
      contents.off('render-process-gone', report);
      contents.off('destroyed', release);
      observed.delete(contents);
    };
    const report = (_event, details) => {
      if (disposed || !options || details?.reason === 'clean-exit') return;
      let url = null;
      let recovered = false;
      try { url = contents.getURL(); } catch { /* The renderer may already be gone. */ }
      try { recovered = options.isRendererCrashRecovered?.(details, contents) === true; } catch { /* Advisory only. */ }
      // Same upstream report format and recovery policy. Existing renderer-health
      // listeners still own availability/recovery; reporting never reloads or quits.
      try {
        options.crashLog.report('render-process-gone', [
          `Reason     ${details?.reason ?? 'unknown'}`,
          `Exit code  ${details?.exitCode ?? 'unknown'}`,
          `URL        ${url ?? 'unknown'}`,
          `Recovered  ${recovered}`,
        ].join('\n'), { announceToUser: !quitting && !recovered });
      } catch (error) { console.warn('[folia] crash reporting failed:', error?.code || error?.message || String(error)); }
    };
    observed.set(contents, release);
    contents.on('render-process-gone', report);
    contents.once('destroyed', release);
  }

  return {
    install(next) {
      if (disposed) throw new Error('Folia crash reporting is disposed');
      if (typeof next?.crashLog?.report !== 'function') throw new Error('Folia crash logger is missing');
      options = next;
    },
    observe,
    dispose() {
      if (disposed) return;
      disposed = true;
      options = null;
      for (const release of [...observed.values()]) release();
      appEvents.off('before-quit', markQuitting);
      appEvents.off('will-quit', markQuitting);
    },
  };
}

module.exports = { createFoliaCrashReporting };
