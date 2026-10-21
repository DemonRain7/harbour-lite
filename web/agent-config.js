/* Structured Agent metadata editor. Drafts/proposals only; no LLM and no second config store. */
(function (global) {
  "use strict";
  const fields = [
    ["reasoningEffort", "思考强度", "effort", "Agent 的默认强度；会话和模型设置优先。", "basic"],
    ["contextBudget", "上下文容量", "context", "自动跟随模型；手动值限制输入，不是累计用量。", "basic"],
    ["maxSteps", "工具调用步数", "integer", "每轮最多执行多少步；留空使用默认 20 步。", "basic"],
    ["readsGlobalMemory", "共享记忆", "boolean", "只加载共享索引，不读取其他角色的私人档案。", "basic"],
    ["model", "默认模型", "model", "未设置快捷覆盖时使用；留空按任务类型路由。", "defaults"],
    ["permissionMode", "默认权限模式", "mode", "未设置快捷覆盖时使用，不改变工具和目录白名单。", "defaults"],
    ["description", "能力简介", "description", "展示在 Agent 列表与能力目录中。", "identity"],
    ["taskType", "任务类型", "text", "用于自动选择模型；留空为 research。", "identity"],
    ["governance.maxTokensPerRun", "累计 Token 预算", "integer", "单次运行累计用量；留空不设这一项。与上下文窗口不同。", "budget"],
    ["governance.tokenBudgetMode", "累计预算处理方式", "budgetMode", "hard 达线停止；converge 达软线后收尾。未设预算时不新增限额。", "budget"],
    ["governance.hardMaxTokensPerRun", "收敛模式的最终硬线", "integer", "可选；必须高于收敛软线。", "budget"],
    ["governance.temperature", "采样温度", "number", "可选；只有支持此参数的后端使用，不支持时忽略。", "budget"],
    ["fallbacks", "专属备用模型", "list", "每行一个 modelRef，顺序保留；不填写则沿用全局容灾。", "routing"],
    ["routerOverrides", "路由覆盖", "object", "JSON 对象：任务类型 → modelRef；不包含密钥。", "routing"],
    ["governance.allowedModels", "模型允许列表", "list", "每行一个 modelRef；关闭此项沿用现有默认行为。", "routing"],
    ["governance.permissions.readOnly", "只读模式", "boolean", "开启时，仅挂载可证明只读的工具。", "permissions"],
    ["governance.permissions.readPaths", "允许读取的目录", "list", "每行一个路径。关闭此项＝不限制；开启但留空＝全部拒绝。", "permissions"],
    ["governance.permissions.writePaths", "允许写入的目录", "list", "每行一个路径。关闭此项＝不限制；开启但留空＝全部拒绝。", "permissions"],
    ["governance.permissions.tools", "工具权限范围", "list", "与已挂载工具取交集；未配置或空列表不额外收窄，不会增加工具。", "permissions"],
    ["governance.permissions.mcp", "MCP 权限范围", "list", "每行一个已挂载 server；未配置或空列表不额外收窄。", "permissions"],
  ];
  const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const get = (object, key) => key.split(".").reduce((node, part) => node?.[part], object);
  const toRaw = (value, type) => type === "list" ? (value || []).join("\n") : type === "object" ? JSON.stringify(value || {}, null, 2) : String(value ?? "");
  // Prefer the catalogue's display label, not its combined connection + model string.
  const modelLabel = (model) => model?.modelLabel || model?.modelName || model?.model || model?.modelRef || "自动路由";
  const modeLabels = { dontAsk: "不弹询问", plan: "只规划 · 不执行", default: "按需询问", acceptEdits: "自动批准文件编辑", auto: "自动判断", bypassPermissions: "跳过权限确认" };
  const modeLabel = (mode) => modeLabels[mode] || mode || modeLabels.dontAsk;
  const effortLabels = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高", ultra: "极高" };
  const sameValue = (left, right) => {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  };

  function mount(root, options) {
    let source = "", config = {}, edit = {}, version = 0, loading = false, loaded = false, saving = false, submitted = false, request = 0, error = "", message = "";
    const alive = () => root.isConnected && options.isCurrent();
    const key = options.name;
    const busy = () => loading || saving;
    function changed(path, value) {
      // Invalid input is still a real draft; validation errors belong to Save.
      if (!loaded) return true;
      try {
        const type = fields.find((field) => field[0] === path)[2], original = get(config, path);
        if (type !== "context" && value.raw === toRaw(original, type)
          && (!["list", "object"].includes(type) || value.enabled === (original !== undefined))) return false;
        const next = fieldValue(path, value);
        return !sameValue(next === null ? undefined : next, original);
      } catch { return true; }
    }
    const dirty = () => Object.entries(edit).some(([path, value]) => changed(path, value));
    const retain = () => {
      if (!alive()) return;
      for (const [path, value] of Object.entries(edit)) if (!changed(path, value)) delete edit[path];
      if (dirty()) options.drafts.set(key, { source, edit: structuredClone(edit) });
      else options.drafts.delete(key);
    };
    function status() {
      if (!alive()) return;
      root.querySelector("[data-ac-save]").disabled = busy() || !loaded || !dirty();
      root.querySelector("[data-ac-save]").textContent = saving ? "提交中…" : "提交修改";
      root.querySelector("[data-ac-reset]").disabled = busy();
      root.querySelector("[data-ac-reset]").textContent = dirty() ? "放弃修改" : "重新读取";
      root.querySelector("[data-ac-governance]").hidden = !submitted;
      const line = root.querySelector("[data-ac-status]");
      line.textContent = error || message || (loading ? "正在读取配置…" : dirty() ? `${Object.keys(edit).length} 项修改未提交` : "");
      line.hidden = !line.textContent;
      line.classList.toggle("is-error", !!error);
      options.onDirty?.(dirty());
    }
    function rawField(field) {
      const [path, , type] = field, value = get(config, path);
      return edit[path] || { enabled: value !== undefined, raw: toRaw(value, type), manual: typeof value === "number" };
    }
    function effortItems(current) {
      const draftModel = rawField(fields.find((field) => field[0] === "model")).raw;
      const modelRef = options.effectiveModelRef?.(draftModel) || draftModel;
      const supported = options.models?.find((model) => model.modelRef === modelRef)?.supportedEfforts || ["off", "low", "medium", "high", "max"];
      const fallback = key.startsWith("main-") || key === "main" ? "high" : "medium";
      return [["", `跟随默认 · ${effortLabels[fallback]} (${fallback})`], ...supported.map((value) => [value, `${effortLabels[value] || value} · ${value}`]),
        ...(current.raw && !supported.includes(current.raw) ? [[current.raw, `${current.raw} · 当前配置，模型可能不支持`]] : [])];
    }
    function refreshModel() {
      const field = fields.find((field) => field[0] === "reasoningEffort"), current = rawField(field);
      const select = root.querySelector('[data-ac-field="reasoningEffort"] select');
      if (select) {
        select.innerHTML = effortItems(current).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
        select.value = current.raw;
      }
    }
    function fieldHtml(field) {
      const [path, label, type, help] = field, current = rawField(field), id = "ac-" + path.replace(/\./g, "-");
      let control;
      const option = (value, text) => `<option value="${esc(value)}"${String(current.raw) === String(value) ? " selected" : ""}>${esc(text)}</option>`;
      const choices = (items) => `<select class="inp" id="${id}" aria-describedby="${id}-help" data-ac-value>${items.map(([value, text]) => option(value, text)).join("")}</select>`;
      if (type === "context") control = `<div class="ac-context-input"><select class="inp" id="${id}" aria-describedby="${id}-help" data-ac-context><option value="auto"${current.manual ? "" : " selected"}>自动 · 跟随模型</option><option value="manual"${current.manual ? " selected" : ""}>手动 · 指定容量</option></select><input class="inp" data-ac-value type="number" min="1" step="1" aria-label="手动上下文容量" value="${current.manual ? esc(current.raw) : ""}"${current.manual ? "" : " disabled hidden"} placeholder="Token 数"></div>`;
      else if (type === "boolean") control = choices([["", "未设置 · 沿用默认"], ["true", "开启"], ["false", "关闭"]]);
      else if (type === "mode") control = choices([["", "跟随默认 · 不弹询问"], ...Object.entries(modeLabels).map(([value, text]) => [value, `${text} · ${value}`])]);
      else if (type === "effort") control = choices(effortItems(current));
      else if (type === "budgetMode") control = choices([["", "未设置 · hard"], ["hard", "hard · 达线停止"], ["converge", "converge · 达线收尾"]]);
      else if (type === "model") {
        const models = options.models || [];
        control = choices([["", "按任务类型自动路由"], ...(!current.raw || models.some((m) => m.modelRef === current.raw) ? [] : [[current.raw, "当前 · " + current.raw]]), ...models.map((m) => [m.modelRef, modelLabel(m)])]);
      } else if (type === "description") control = `<textarea class="inp" id="${id}" aria-describedby="${id}-help" data-ac-value rows="2">${esc(current.raw)}</textarea>`;
      else if (type === "list" || type === "object") control = `<label class="ac-optional"><input type="checkbox" data-ac-enabled${current.enabled ? " checked" : ""}> 配置此项</label><textarea class="inp" id="${id}" data-ac-value rows="3" spellcheck="false"${current.enabled ? "" : " disabled"}>${esc(current.raw)}</textarea>`;
      else control = `<input class="inp" id="${id}" data-ac-value type="${type === "text" ? "text" : "number"}"${type === "integer" ? ' min="1" step="1"' : type === "number" ? ' step="any"' : ""} value="${esc(current.raw)}" placeholder="${type === "text" ? "未设置" : "未设置 · 沿用默认"}">`;
      return `<div class="ac-field${["description", "object", "list"].includes(type) ? " ac-wide" : ""}" data-ac-field="${path}"><label for="${id}">${label}</label>${control}<small id="${id}-help">${help}</small></div>`;
    }
    function render() {
      const expanded = new Set([...root.querySelectorAll("details[data-ac-group][open]")].map((el) => el.dataset?.acGroup).filter(Boolean));
      root.innerHTML = `<div class="ac-toolbar"><div><b>基础配置 <span class="ac-policy">需审批</span></b><p>保存到角色文件，批准后生效。</p></div><div class="ac-actions"><a class="btn ghost" data-ac-governance href="#governance" hidden>前往审批 →</a><button type="button" class="btn ghost" data-ac-reset>重新读取</button><button type="button" class="btn primary" data-ac-save>提交修改</button></div></div><p class="ac-status" data-ac-status role="status" aria-live="polite"></p><div class="ac-scroll"><section class="ac-section ac-common" aria-label="常用配置"><div class="ac-grid">${fields.filter((f) => f[4] === "basic").map(fieldHtml).join("")}</div></section><div class="ac-advanced-label">更多设置</div>${[
        ["defaults", "默认模型与权限", "未使用上方快捷覆盖时的基础值"],
        ["identity", "简介与任务类型", "能力说明、自动模型路由的任务类型"],
        ["budget", "预算与采样", "累计用量、停止策略与温度"],
        ["routing", "备用模型与路由", "模型顺序、路由覆盖与允许列表"],
        ["permissions", "工具与文件权限", "只读模式、目录及工具范围"],
      ].map(([group, title, description]) => `<details class="ac-section" data-ac-group="${group}"${expanded.has(group) ? " open" : ""}><summary><div><h4>${title}</h4><p>${description}</p></div></summary><div class="ac-grid">${fields.filter((f) => f[4] === group).map(fieldHtml).join("")}</div></details>`).join("")}<p class="ac-footnote">角色正文、能力挂载和定时任务 →「人设与能力」</p></div>`;
      root.querySelector("[data-ac-save]").onclick = save;
      root.querySelector("[data-ac-reset]").onclick = async () => {
        if (busy()) return;
        if (dirty() && !await options.confirm("放弃尚未保存的表单配置？文件编辑草稿不会被取消。")) return;
        if (discard()) await load();
      };
      root.querySelectorAll("[data-ac-field]").forEach((row) => {
        const field = fields.find((f) => f[0] === row.dataset.acField), type = field[2];
        const update = () => {
          if (!alive() || loading || !loaded) return;
          const input = row.querySelector("[data-ac-value]"), enabled = row.querySelector("[data-ac-enabled]"), context = row.querySelector("[data-ac-context]");
          if (enabled) input.disabled = !enabled.checked;
          if (context) { input.disabled = context.value === "auto"; input.hidden = input.disabled; }
          edit[field[0]] = { raw: input.value, enabled: enabled ? enabled.checked : true, manual: context?.value === "manual" };
          version++; error = ""; message = ""; retain(); status();
          if (field[0] === "model") refreshModel();
        };
        row.querySelectorAll("input,textarea,select").forEach((input) => input.addEventListener(input.tagName === "SELECT" || input.type === "checkbox" ? "change" : "input", update));
      });
      status();
    }
    async function load(initialPreview) {
      if (!alive() || saving) return false;
      const ticket = ++request;
      const cached = options.drafts.get(key);
      loading = true; loaded = false; error = ""; message = "";
      // A retained draft must be compared against its own source, never a newer
      // file draft whose metadata may happen to match the pending changes.
      source = cached ? cached.source : options.readSource();
      edit = cached ? structuredClone(cached.edit) : {};
      config = {};
      render();
      // Disable unloaded controls; no placeholder values may accidentally become a proposal.
      root.querySelectorAll(".ac-scroll input,.ac-scroll select,.ac-scroll textarea").forEach((el) => { el.disabled = true; });
      try {
        const prepared = initialPreview?.source === source ? initialPreview : null;
        if (prepared?.error) throw prepared.error;
        const result = prepared ? prepared.result : await options.api(`/api/agent-config/${encodeURIComponent(key)}/preview`, { method: "POST", body: JSON.stringify({ source, patch: {} }) });
        if (!alive() || ticket !== request) return false;
        if (!result.config || typeof result.config !== "object" || Array.isArray(result.config)) throw new Error("后端未返回有效配置，请重新读取。");
        config = result.config; loaded = true;
        if (source !== options.readSource()) error = "文件草稿已改变；请先取消 / 重新读取配置，避免覆盖另一处编辑。";
        retain();
        return !error;
      } catch (e) {
        if (!alive() || ticket !== request) return false;
        error = e.status === 404 ? "运行中的后端尚未加载配置编辑接口，请重启 Harbour 后端后重新读取。" : e.message;
        return false;
      } finally {
        if (alive() && ticket === request) {
          loading = false; render();
          if (!loaded) root.querySelectorAll(".ac-scroll input,.ac-scroll select,.ac-scroll textarea").forEach((el) => { el.disabled = true; });
        }
      }
    }
    function fieldValue(path, value) {
      const type = fields.find((field) => field[0] === path)[2], raw = value.raw.trim();
      if (type === "context") {
        // An absent contextBudget is displayed as auto. Returning to that same
        // control value must not introduce an explicit frontmatter property.
        if (!value.manual) return get(config, path) === undefined ? null : "auto";
        const number = Number(raw);
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error("手动上下文容量必须为正整数");
        return number;
      }
      if (type === "list") return value.enabled ? raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : null;
      if (type === "object") {
        if (!value.enabled) return null;
        const object = JSON.parse(raw || "{}");
        if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error(`${path} 必须为 JSON 对象`);
        return object;
      }
      if (type === "boolean") return raw === "" ? null : raw === "true";
      if (type === "integer" || type === "number") {
        const number = raw === "" ? null : Number(raw);
        if (number !== null && (!Number.isFinite(number) || (type === "integer" && (!Number.isSafeInteger(number) || number <= 0)))) throw new Error(`${path} 必须为${type === "integer" ? "正整数" : "有效数字"}`);
        return number;
      }
      return raw || null;
    }
    function patch() {
      const result = {};
      for (const [path, value] of Object.entries(edit)) if (changed(path, value)) result[path] = fieldValue(path, value);
      return result;
    }
    function discard() {
      if (!alive() || busy()) return false;
      version++; request++; edit = {}; retain();
      // Keep the parsed baseline and its matching source together. If the file
      // editor changed independently, only an explicit reload may replace them.
      error = source !== options.readSource() ? "文件草稿已改变；请重新读取配置后再编辑。" : "";
      message = "";
      render();
      if (!loaded) root.querySelectorAll(".ac-scroll input,.ac-scroll select,.ac-scroll textarea").forEach((el) => { el.disabled = true; });
      return true;
    }
    async function save() {
      if (!alive() || busy() || !loaded) return false;
      if (!dirty()) { retain(); status(); return true; }
      saving = true; error = ""; message = ""; status();
      const savedVersion = version, original = source;
      try {
        if (options.readSource() !== original) throw new Error("文件草稿已改变，请重新读取配置后再保存；未覆盖你的修改。");
        const changes = patch();
        if (!Object.keys(changes).length) {
          edit = {}; retain(); message = "配置没有实际变化，无需创建提案。"; render(); return true;
        }
        const result = await options.api(`/api/agent-config/${encodeURIComponent(key)}/preview`, { method: "POST", body: JSON.stringify({ source: original, patch: changes }) });
        if (!alive()) return false;
        if (typeof result.content !== "string" || !result.config || typeof result.config !== "object" || Array.isArray(result.config)) throw new Error("后端未返回有效配置草稿，原修改已保留。");
        if (options.readSource() !== original) throw new Error("生成配置期间文件已改变，已保留两边草稿，请重新读取后再保存。");
        await options.saveContent(result.content, original);
        // A reopened editor owns its own newer draft. This older acknowledgement
        // may confirm a proposal, but must not delete or replace that shared draft.
        if (!alive()) return false;
        const latest = Object.fromEntries([...new Set([...Object.keys(changes), ...Object.keys(edit)])]
          .map((path) => [path, rawField(fields.find((field) => field[0] === path))]));
        config = result.config; source = result.content;
        submitted = true;
        // A user can keep typing while the proposal is persisted, including
        // reverting a submitted field to its old value. Rebase that desired
        // state against the acknowledged proposal instead of losing the revert.
        edit = version === savedVersion ? {} : latest;
        retain();
        message = "已保存为待审批提案；批准应用后生效。";
        if (alive() && version === savedVersion) render();
        return version === savedVersion && !dirty();
      } catch (e) { error = e.message || "保存失败；草稿已保留"; return false; }
      finally { saving = false; if (alive()) status(); }
    }
    void load(options.initialPreview);
    return { isDirty: dirty, isBusy: busy, save, discard, reload: load, refreshModel };
  }
  global.HarbourAgentConfig = { mount, fields, modelLabel, modeLabel };
})(globalThis);
