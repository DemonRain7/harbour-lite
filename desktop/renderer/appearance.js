(() => {
  function apply(appearance = {}) {
    document.body.dataset.theme = appearance.theme || "anime-wisteria";
    document.body.dataset.font = appearance.font || "system";
    document.body.dataset.bubbleStyle = appearance.bubbleStyle || "glass";
  }
  window.HarbourAppearance = { apply };
  window.harbourDesktop?.getCompanionState?.().then((state) => apply(state?.appearance)).catch(() => apply());
  window.harbourDesktop?.onCompanionState?.((state) => apply(state?.appearance));
})();
