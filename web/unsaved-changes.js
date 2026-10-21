/* One leave boundary for document editors. Draft bodies never leave the renderer. */
(function (global) {
  "use strict";
  const normalize = value => String(value ?? "").replace(/\r\n?/g, "\n");
  function create({ ask, notify = () => {}, setSuspended = () => {} }) {
    const entries = new Map();
    let pending = false, prepared = null, suspended = false;
    const suspend = value => { suspended = value; setSuspended(value); };
    const active = ids => [...entries.values()].filter(entry => (!ids || ids.includes(entry.id)) && entry.isActive());
    const changed = ids => active(ids).filter(entry => entry.isDirty());
    const label = entry => typeof entry.label === "function" ? entry.label() : entry.label;
    const version = entry => entry.version?.();
    async function applyDecision(decision, deferDiscard = false) {
      if (changed(decision.ids).some(entry => !decision.entries.some(item => item.entry === entry))) return false;
      for (const { entry, stamp } of decision.entries) {
        if (!entry.isActive() || (stamp !== undefined && version(entry) !== stamp)) return false;
      }
      // Quitting multiple windows is a transaction. Do not erase a draft until
      // every other window has also accepted; closing the window discards it.
      if (deferDiscard && decision.action === "discard") return !active(decision.ids).some(entry => entry.isBusy?.());
      for (const { entry } of decision.entries) {
        if (decision.action === "discard") {
          if (await entry.discard() === false) return false;
        } else if (decision.action === "save" && (!entry.save || await entry.save() !== true)) return false;
      }
      return !changed(decision.ids).length && !active(decision.ids).some(entry => entry.isBusy?.());
    }
    return {
      register(id, entry) {
        const item = { ...entry, id }; entries.set(id, item);
        return () => { if (entries.get(id) === item) entries.delete(id); };
      },
      normalize,
      hasChanges: () => changed().length > 0 || active().some(entry => entry.isBusy?.()),
      list: () => changed().map(label),
      async requestLeave({ reason = "navigate", ids, phase } = {}) {
        // Persistent surfaces survive sidebar navigation; closing/reloading the
        // application must still protect their unsent drafts and active work.
        if (reason === "page") ids = active(ids).filter(entry => !entry.preserveOnPageChange).map(entry => entry.id);
        if (phase === "cancel") { prepared = null; suspend(false); return true; }
        if (suspended && phase !== "commit") return false;
        if (pending) return false;
        pending = true;
        try {
          if (phase === "commit") {
            const decision = prepared; prepared = null;
            return decision ? await applyDecision(decision, reason === "quit") : !changed(ids).length && !active(ids).some(entry => entry.isBusy?.());
          }
          prepared = null;
          if (active(ids).some(entry => entry.isBusy?.())) {
            await notify("正在保存修改，请等待保存结果后再离开。", { title: "修改尚在保存中" });
            return false;
          }
          const dirty = changed(ids);
          if (!dirty.length) { if (reason === "quit" && phase === "check") suspend(true); return true; }
          const decision = { ids, entries: dirty.map(entry => ({ entry, stamp: version(entry) })) };
          decision.action = await ask(dirty.map(label), { reason, canSave: dirty.every(entry => !!entry.save) });
          if (!["save", "discard"].includes(decision.action)) return false;
          if (phase === "check") { prepared = decision; if (reason === "quit") suspend(true); return true; }
          return await applyDecision(decision);
        } catch (error) {
          suspend(false);
          await notify(error?.message || "操作未完成，修改已保留。", { title: "仍留在当前编辑器" });
          return false;
        } finally { pending = false; }
      },
    };
  }
  global.HarbourUnsavedChangesFactory = { create, normalize };
  if (typeof module !== "undefined" && module.exports) module.exports = { create, normalize };
})(globalThis);
