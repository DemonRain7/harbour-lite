/* ───────────────────────────────────────────────────────────────────
   Harbour 管理 dashboard —— 纯 vanilla，无打包器。
   - REST：fetch /api/*
   - 实时：WebSocket /ws 推每行 JSON 日志（loop 事件就是从这流出来的）
   - 主题：data-theme 切换，localStorage 记忆
   加面板 = 往 PANELS 加一项 + 往 NAV 加一项。
   ─────────────────────────────────────────────────────────────────── */

/* 两层主题：大类(category=整套视觉语言) → 变体(variant=配色)。
   ★ 加变体：themes.css 加 [data-theme="id"] 颜色块 + 在对应大类的 variants 登记。
   ★ 加大类：themes.css 加 body[data-theme-cat="id"]{...} + 在顶层加一项。 */
/* 主题是【三层】：大类（视觉语言）→ 角色（谁的皮肤）→ 变体（配色）。
   对应 body 上的 data-theme-cat / data-theme-persona / data-theme。
   ★ 加角色皮肤 = 这里加一项 persona + themes.css 加配色块 +（可选）styles.css 加
     body[data-theme-persona="id"] 结构段；`agent` 字段填对应 agent 名，切角色时主题自动跟随。 */
const THEME_CATEGORIES = [
  {
    id: "premium", label: "PREMIUM · 放映室",
    personas: [
      {
        id: "neutral", label: "通用 · 无角色", agent: null,
        variants: [
          { id: "premium-champagne", label: "香槟 Champagne" },
          { id: "premium-tungsten",  label: "钨丝 Tungsten" },
        ],
      },
    ],
  },
  {
    id: "anime", label: "ANIME · 二次元",
    personas: [
      {
        id: "elaina", label: "手账 · Wisteria", agent: "main-assistant",
        variants: [
          { id: "anime-wisteria", label: "薰衣草 Wisteria" },
          { id: "anime-sky",      label: "晴空 Sky" },
        ],
      },
      {
        // AEMEATH ·「众光航标」—— 三个变体 = 现在的她的三个时刻（立绘各配一张）：
        //   雪绒 = 舞台上（暖白 + 粉 + 青蓝羽，默认 →「星星本身」）
        //   星尘 = 日常里（汽水蓝白 + 琥珀橙瞳色点睛 / 游戏手柄那张）
        //   霓虹 = 街头（Y2K 粉 + 电紫 / 爱心墨镜那张）
        id: "aemeath", label: "星光 · Stardust", agent: "main-assistant",
        variants: [
          { id: "anime-snowfleece", label: "雪绒 Snowfleece" },
          { id: "anime-stardust",   label: "星尘 Stardust" },
          { id: "anime-neon",       label: "霓虹 Neon" },
        ],
      },
    ],
  },
];

const _fav = (svg) => "data:image/svg+xml," + encodeURIComponent(svg);
const FAVICONS = {
  premium: _fav(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#12141d"/><path d="M8 3.2 L11.6 8 L8 12.8 L4.4 8 Z" fill="#818cf8"/></svg>`),
  anime: _fav(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 1 L11.5 9 L4.5 9 Z" fill="#33304e"/><rect x="2.3" y="8.6" width="11.4" height="2.4" rx="1.2" fill="#33304e"/><path d="M8 3.4 l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2Z" fill="#ffe39a"/></svg>`),
};

/* ── 角色（persona）注册表 ─────────────────────────────────────────────
   Harbour 是中台的【品牌名】；persona 是住在里面的【角色】，可多个、可切换。
   加一个角色 = 丢一个 agents/<name>/ 文件夹 + 在这里登记展示资源。
   立绘 / 头像缺失时自动回退占位剪影，不会报错。 */
const PERSONAS = {
  "main-assistant": {
    label: "ASSISTANT",
    avatar: "/assets/elaina-avatar.png",
    hero: {
      "anime-wisteria": "/assets/elaina-hero-wisteria.png",
      "anime-sky": "/assets/elaina-hero-sky.png",
      "anime-stardust": "/assets/aemeath-hero-stardust.jpg",
      "anime-neon": "/assets/aemeath-hero-neon.jpg",
      "anime-snowfleece": "/assets/aemeath-hero-snowfleece.jpg",
    },
  },
  "main-elaina": {
    label: "ELAINA",
    avatar: "/assets/elaina-avatar.png",
    hero: {
      "anime-wisteria": "/assets/elaina-hero-wisteria.png", // 薰衣草·紫藤（净白底）
      "anime-sky": "/assets/elaina-hero-sky.png",           // 晴空·蓝裙天空
    },
  },
  "main-aemeath": {
    label: "AEMEATH",
    avatar: "/assets/aemeath-avatar.jpg",
    hero: {
      "anime-stardust": "/assets/aemeath-hero-stardust.jpg",     // 游戏手柄 / 冰咖啡 / 像素幽灵挂饰
      "anime-neon": "/assets/aemeath-hero-neon.jpg",             // 爱心墨镜 / Y2K 街头
      "anime-snowfleece": "/assets/aemeath-hero-snowfleece.jpg", // 麦克风 / 偶像「飞行雪绒」
    },
  },
};
const DEFAULT_PERSONA = "main-assistant";
const HERO_FALLBACK = "/assets/elaina-portrait.svg";

/** 当前选中的 agent 是不是一个 persona？是则返回其资源，否则 null（专精子 agent 无立绘）。 */
function personaOf(agent) { return PERSONAS[agent] || null; }
/** 聊天气泡上显示的说话人名。persona 用其展示名；专精 agent 用大写 agent 名。 */
function personaLabel(agent) {
  const value = String(agent || "AGENT");
  return PERSONAS[value]?.label || (value.startsWith("main-") ? value.slice(5) : value).replace(/[-_]+/g, " ").toUpperCase();
}

/** main-* 与桌宠 id 一一对应；未知角色也能走同一约定，无需再写 Elaina 特例。 */
function companionIdForAgent(agent) {
  const value = String(agent || "").trim().toLowerCase();
  if (!value.startsWith("main-")) return "";
  const id = value.slice(5).replace(/[^a-z0-9_-]/g, "");
  return id || "";
}

function currentCompanionAgent() {
  const cat = document.body.dataset.themeCat || "premium";
  const themeAgent = personaOfCat(cat, document.body.dataset.themePersona)?.agent;
  return state.chat.agent || themeAgent || DEFAULT_PERSONA;
}

function companionTargetForAgent(agent) {
  if (window.harbourDesktop?.isElectron && window.harbourDesktop.petsEnabled === false) return null;
  const agentName = String(agent || "").trim().toLowerCase();
  const configured = Array.isArray(window.harbourDesktop?.petCatalog)
    ? window.harbourDesktop.petCatalog.find((pet) => String(pet?.agentName || "").toLowerCase() === agentName)
    : null;
  const petId = String(configured?.id || companionIdForAgent(agentName)).replace(/[^a-z0-9_-]/g, "");
  const label = String(configured?.displayName || personaLabel(agentName));
  return petId ? { petId, agent: agentName, label } : null;
}

/* ── 对话头像 ────────────────────────────────────────────────
   用户 的头像先留空（等他上传），占位显示首字母；存 localStorage，
   换机器不同步是有意的——头像是本地观感，不值得进 governance / 走服务端。
   agent 侧：两位 persona 用各自 avatar；专精 agent（trajectory-checker 等）没有图，
   用首字母圆牌兜底，颜色由名字散列出来，保证同一 agent 每次同色、彼此可区分。 */
const USER_AVATAR_KEY = "harbour-user-avatar";
function userAvatarSrc() { try { return localStorage.getItem(USER_AVATAR_KEY) || ""; } catch { return ""; } }
function setUserAvatar(dataUrl) {
  try { dataUrl ? localStorage.setItem(USER_AVATAR_KEY, dataUrl) : localStorage.removeItem(USER_AVATAR_KEY); } catch { /* 隐私模式忽略 */ }
  renderChatMessages();
}
/** 由名字散出一个稳定色相，给没有头像的专精 agent 上色。 */
function hueOf(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
/**
 * 一个头像块。img 加载失败就自我移除，露出底下的首字母 —— 不留裂图。
 * @param {"user"|"assistant"} role
 * @param {string} agent 这条消息实际的 agent（不是当前选择器）
 */
function avatarHtml(role, agent) {
  if (role === "user") {
    const src = userAvatarSrc();
    return `<div class="chat-avatar is-user" data-ini="R" title="你的头像（点击上传）">${
      src ? `<img src="${esc(src)}" alt="" onerror="this.remove()">` : ""
    }</div>`;
  }
  const p = PERSONAS[agent];
  const label = personaLabel(agent);
  const style = p?.avatar ? "" : ` style="--av-h:${hueOf(agent)}"`;
  return `<div class="chat-avatar${p?.avatar ? "" : " is-initial"}" data-ini="${esc(label.slice(0, 1))}" title="${esc(label)}"${style}>${
    p?.avatar ? `<img src="${esc(p.avatar)}" alt="" onerror="this.remove()">` : ""
  }</div>`;
}
/**
 * 立绘 / 头像看的是【主题的角色层】而不是聊天选的 agent——这样整套皮肤（配色 + 结构 +
 * 立绘）永远自洽。聊天换角色时会自动把主题角色层也切过去（见 applyPersonaVisuals），
 * 所以正常使用下两者一致；用户手动只换主题角色时，也能单独预览另一个角色的皮肤。
 */
function activePersona() {
  const cat = document.body.dataset.themeCat || "premium";
  const perId = document.body.dataset.themePersona;
  const agent = catOf(cat).personas.find((p) => p.id === perId)?.agent;
  return PERSONAS[agent] || PERSONAS[DEFAULT_PERSONA];
}
function setHero(variantId) {
  if (window.HarbourChatHero) {
    const skin = personaOfCat(document.body.dataset.themeCat || "premium", document.body.dataset.themePersona);
    const persona = activePersona();
    void window.HarbourChatHero.update({
      id: skin.id, category: document.body.dataset.themeCat, label: persona.label,
      defaultSrc: persona.hero?.[variantId] || Object.values(persona.hero || {})[0] || HERO_FALLBACK,
      fallback: HERO_FALLBACK,
      variants: skin.variants.filter(item => persona.hero?.[item.id]).map(item => ({ ...item, src: persona.hero[item.id] })),
    });
    return;
  }
  const img = document.querySelector(".harbour-hero");
  if (!img) return;
  const persona = activePersona();
  // 取不到该变体的图就退到该角色的任意一张，再退到通用剪影——缺图绝不留裂图。
  const src = persona?.hero?.[variantId] || Object.values(persona?.hero || {})[0];
  if (!src) return; // premium：CSS 已隐藏，无需设
  if (img.getAttribute("src") === src) return;
  img.onerror = () => { img.onerror = null; img.src = HERO_FALLBACK; };
  img.src = src;
}
function initAvatar() {
  const img = document.querySelector(".brand-avatar");
  if (!img) return;
  img.style.display = "";
  img.onerror = () => { img.style.display = "none"; };
  img.src = activePersona()?.avatar || "";
}

/**
 * 会话来源 key —— **必须带上角色名**。
 * 会话是按 key 存的（后端 SessionStore），若两个角色共用一个 key，切角色时上一个角色的
 * 全部对话会被原样灌进新角色的 context：既串人设，也会让角色之间独立的内容边界这类
 * per-persona 边界被伊蕾娜那边的历史架空。所以每个角色各自一条会话线。
 */
function sessionKeyFor(agent, mode = "main") {
  return `web:${mode === "cowork" ? "cowork" : "default"}:${agent || DEFAULT_PERSONA}`;
}

/** 模式只隔离会话，不复制 persona、模型配置或聊天执行器。 */
function chatSessionsForMode(sessions, mode, agent) {
  return (sessions || []).filter((session) => mode === "cowork"
    ? session.channel === "web" && session.key === sessionKeyFor(agent, "cowork")
    : !String(session.key || "").startsWith("web:cowork:"));
}

function coworkBindingForSession(session) {
  if (session && (session.channel !== "web" || session.readOnlyMirror)) return null;
  const saved = session?.cowork;
  return { deviceId: String(saved?.deviceId || "server"), ...(saved?.cwd ? { cwd: String(saved.cwd) } : {}) };
}

function coworkControlsLocked(chat) {
  return !!(chat.running || chat.intakeRunning || chat.readOnlyMirror || chat.modelSaving || chat.coworkSaving || chat.switchingMode || chat.switchingSession);
}

/** 离线、未知和已移除的目标始终保留；设备列表刷新绝不能改变执行位置。 */
function coworkDeviceOptions(devices, selectedId) {
  const list = (devices || []).filter((device) => device && typeof device.id === "string").map((device) => ({ ...device }));
  if (selectedId && !list.some((device) => device.id === selectedId)) {
    list.push({ id: selectedId, label: selectedId === "server" ? "Harbour 服务端" : selectedId, online: false, missing: true });
  }
  return list;
}

function coworkDeviceOptionsHtml(devices, selectedId) {
  return coworkDeviceOptions(devices, selectedId).map((device) =>
    `<option value="${esc(device.id)}"${device.id === selectedId ? " selected" : ""}>${esc(device.label || device.hostname || device.id)} · ${device.online ? "在线" : "离线"}${device.id === "server" ? " · 服务端" : ""}</option>`
  ).join("");
}

/** 提交时复制 session id/key 与目标，不能让另一客户端的 active 指针改变本轮归属。 */
function chatRunContext(chat, originDeviceId = "") {
  if (chat.readOnlyMirror) throw new Error("外部渠道会话只读");
  if (chat.sessionsEnabled === false) {
    if (chat.mode === "cowork") throw new Error("Cowork 需要开启会话记忆，以保存执行目标");
    return {}; // 保留 SESSIONS_ENABLED=false 的显式无状态 Main；绝不依赖 active 指针。
  }
  const session = { key: chat.selectedSessionKey || chat.sessionKey || sessionKeyFor(chat.agent, chat.mode), channel: "web", id: chat.sessionId };
  if (!session.id) throw new Error("请先创建明确的会话，再发送消息");
  if (chat.mode !== "cowork") return { session };
  if (!chat.cowork?.deviceId) throw new Error("请选择 Cowork 执行设备");
  const cwd = String(chat.cowork.cwd || "").trim();
  return { session, cowork: { deviceId: chat.cowork.deviceId, ...(cwd ? { cwd } : {}), ...(originDeviceId ? { originDeviceId } : {}) } };
}

/**
 * 当前会话线的 key，任何面板都能安全调用。
 *
 * state.chat.sessionKey 只在 PANELS.chat.render / switchChatAgent 里被赋值，初值是空串。
 * 而 route() 是按 location.hash 走的——刷新时若停在 #history（或直接开 /#history），
 * chat 从没渲染过，key 还是空串，/api/conversations?key= 直接 400「缺少 key 查询参数」。
 * 这里按与 PANELS.chat.render 相同的优先级兜底：本次已选 > 主题角色层 > 常量。
 * （服务端 DEFAULT_AGENT 那一档要 await，此处只做同步兜底，不值得为它把调用方改异步。）
 */
function currentSessionKey() {
  if (state.chat.sessionKey) return state.chat.sessionKey;
  const themeAgent = personaOfCat(
    document.body.dataset.themeCat || "premium",
    document.body.dataset.themePersona
  ).agent;
  return sessionKeyFor(state.chat.agent || themeAgent, state.chat.mode);
}

/** Only navigation identity belongs in a window URL; never prompts, keys or settings. */
function chatWindowTarget(hash = location.hash) {
  if (!hash.startsWith('#chat?')) return null;
  const params = new URLSearchParams(hash.slice(6));
  const sessionId = params.get('session'), agent = params.get('agent'), fresh = params.get('new');
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if ((sessionId && !validId(sessionId)) || (agent && !validId(agent)) ||
      (fresh !== null && fresh !== '1') || (!!sessionId === (fresh === '1')) ||
      (params.has('mode') && !['main', 'cowork'].includes(params.get('mode'))) ||
      [...params.keys()].some(key => !['session', 'agent', 'new', 'mode'].includes(key) || params.getAll(key).length !== 1)) {
    throw new Error('会话窗口地址无效；未切换到其它会话');
  }
  return { sessionId, agent, fresh: fresh === '1', mode: params.get('mode') || 'main' };
}

function chatWindowUrl(session = null) {
  const url = new URL(location.href);
  url.search = ''; // Authentication stays in same-origin storage / native preload.
  const params = new URLSearchParams(session ? { session: session.id, agent: session.agentName }
    : { new: '1', agent: state.chat.agent || DEFAULT_PERSONA, mode: state.chat.mode || 'main' });
  url.hash = `chat?${params}`;
  return url.href;
}

function openChatWindow(id = null) {
  const session = id ? state.chat.sessions.find(item => item.id === id) || state.chat.inspection?.session : null;
  if (id && session?.id !== id) return toast('会话已不存在，请刷新列表', true);
  // Synchronous user gesture: browser opens a new tab; Electron opens a separate
  // guarded Dashboard window. No new session/model call until that window sends.
  window.open(chatWindowUrl(session), '_blank', 'noopener');
}

/** Reload must restore this window's exact conversation, not another window's active pointer. */
function pinChatWindow() {
  if (typeof location === 'undefined' || !/^#chat(?:\?|$)/.test(location.hash)) return;
  const chat = state.chat;
  if (!chat.sessionId && !chat.landing) return;
  const url = chatWindowUrl(chat.sessionId ? { id: chat.sessionId, agentName: chat.agent } : null);
  history.replaceState(history.state, '', url);
  if (typeof activePanelHash !== 'undefined') activePanelHash = location.hash.slice(1);
  if (typeof activePanelEntryKey !== 'undefined') activePanelEntryKey = window.navigation?.currentEntry?.key || null;
}

async function prepareChatWindow() {
  const target = chatWindowTarget();
  if (!target) return;
  if (state.chat.running || state.chat.inspection) { pinChatWindow(); return; }
  if (target.agent && !state.chat.agents.some(agent => agent.name === target.agent)) throw new Error('窗口指定的 Agent 不存在');
  if (target.sessionId && target.sessionId === state.chat.sessionId) return;
  if (chatDraftBusy()) throw new Error('当前窗口仍在处理附件，请完成后再切换');
  if (target.fresh) {
    if (state.chat.landing && !state.chat.sessionId && state.chat.agent === target.agent && state.chat.mode === target.mode) return;
    saveChatDraft();
    Object.assign(state.chat, { agent: target.agent || state.chat.agent, mode: target.mode, landing: true,
      sessionId: null, selectedSessionKey: '', readOnlyMirror: false, skill: '', messages: [], attachments: [], trace: [], plan: null, checkpoint: null,
      goal: null, goalArmed: false, model: '', reasoningEffort: '', permissionMode: '', cowork: coworkBindingForSession(null) });
    applyPersonaVisuals();
    return;
  }
  const { session } = await api(`/api/conversations/${encodeURIComponent(target.sessionId)}`);
  if (session?.id !== target.sessionId || (target.agent && session.agentName !== target.agent)) throw new Error('会话归属不匹配，未打开其它会话');
  saveChatDraft();
  Object.assign(state.chat, { agent: session.agentName, sessionId: session.id, selectedSessionKey: session.key,
    mode: String(session.key || '').startsWith('web:cowork:') ? 'cowork' : 'main', landing: false });
  applyPersonaVisuals();
  // The normal session loader restores permissions, model, Cowork and read-only
  // mirror state. Opening a window never switches the backend's active pointer.
}

/** 切换角色后把「随角色走」的视觉一次性刷新：说话人名 / 输入框提示 / 立绘 / 头像。
 *  只改视觉，不动会话内容——历史消息仍属于它们各自被说出时的角色。 */
/* 主题的「角色层」与聊天的「当前 agent」是同一个概念的两面，双向联动：
   在任一处换角色，另一处跟着走。用这个标志位打断回环（applyPersonaVisuals 会调
   applyTheme，applyTheme 又会想去同步 chat agent）。 */
let _personaSyncing = false;

/**
 * 切换聊天角色：换会话线（key 带角色名，避免历史串味）→ 清当前视图 → 刷新皮肤 → 载入该角色历史。
 * 主题角色下拉与 agent 下拉都走这里，保证两条路径行为完全一致。
 */
async function switchChatAgent(agent) {
  if (state.chat.running || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession) {
    const select = document.querySelector("#chatAgent");
    if (select) select.value = state.chat.agent;
    // 角色皮肤下拉也是一条 Agent 切换路径；把视觉恢复到本轮锁定的角色。
    applyPersonaVisuals();
    toast("本轮运行中 Agent 已锁定；请先停止再切换。", true);
    return;
  }
  if (!agent || state.chat.agent === agent) return;
  if (state.chat.inspection) closeChatInspection();
  // 让上一角色尚未返回的会话列表/详情请求立即失效，避免旧正文盖到新角色标题下。
  const requestSeq = ++state.chat.detailRequestSeq;
  ++state.chat.sessionListRequestSeq;
  state.chat.agent = agent;
  chatVoicePicker?.sync();
  state.chat.skill = "";
  // 先清掉上一条 Agent 会话的覆盖；loadChatSessions 随后会恢复目标 Agent 活跃会话自己的值。
  state.chat.model = "";
  state.chat.permissionMode = "";
  state.chat.reasoningEffort = "";
  state.chat.agentDefaultReasoningEffort = agent === "main" || agent.startsWith("main-") ? "high" : "medium";
  const sel = document.querySelector("#chatAgent");
  if (sel && sel.value !== agent) sel.value = agent;
  const modelSel = document.querySelector("#chatModel");
  if (modelSel) modelSel.value = "";
  const modeSel = document.querySelector("#chatPermMode");
  if (modeSel) modeSel.value = "";
  const effortSel = document.querySelector("#chatEffort");
  if (effortSel) effortSel.value = "";
  syncChatPermissionDefault(agent);
  await fillChatSkills(agent);
  if (requestSeq !== state.chat.detailRequestSeq || state.chat.agent !== agent) return;
  // “跟随 Agent”选项需要显示新 Agent 当前真正生效的 API + 模型。
  await fillChatModels();
  if (requestSeq !== state.chat.detailRequestSeq || state.chat.agent !== agent) return;
  // 换角色 = 换一条会话线，上一个角色的历史不会进新角色的 context。
  state.chat.sessionKey = sessionKeyFor(agent, state.chat.mode);
  state.chat.sessionId = null;
  state.chat.selectedSessionKey = "";
  state.chat.messages = [];
  state.chat.trace = [];
  state.chat.cowork = coworkBindingForSession(null);
  applyPersonaVisuals();     // 说话人名 / placeholder / 立绘 / 头像 / 主题皮肤
  await loadChatSessions();  // 载入该角色自己的历史与会话列表
}

function applyPersonaVisuals() {
  renderChatMessages();                       // 欢迎标识 + 气泡上的说话人名
  const inp = document.querySelector("#chatInput");
  if (inp) inp.placeholder = "";
  // 换聊天角色 → 主题的角色层跟着换（配色 + 结构 + 立绘整套皮肤一起走）。
  // 仅当当前大类里存在该 agent 的皮肤时才切；premium（无角色）和专精子 agent 保持原样。
  const cat = document.body.dataset.themeCat || "premium";
  const skin = themePersonaForAgent(cat, state.chat.agent);
  if (skin && skin.id !== document.body.dataset.themePersona) {
    _personaSyncing = true;                        // 别让 applyTheme 反过来又切 agent
    try { applyTheme(cat, skin.id, skin.variants[0].id); } finally { _personaSyncing = false; }
    initAvatar();
    syncDesktopPetQuick();
    return;
  }
  setHero(document.body.dataset.theme);       // 立绘按「当前皮肤 + 当前变体」取图
  initAvatar();
  syncDesktopPetQuick();
}

const NAV = [
  { id: "chat", primary: true, path: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z M7 9h10 M7 13h6", label: "Main Chat" },
  { id: "spaces", primary: true, path: "M3 7h7l2 3h9v10H3z M6 7V3h13v7", label: "空间" },
  { id: "town", primary: true, path: "m2 11 6-7 6 7 M4 9v11h8V9 M8 20v-6 M14 6h5v14h-5 M17 10h.01 M17 14h.01", label: "Town" },
  { id: "calendar", primary: true, path: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M7 3v4 M17 3v4 M3 11h18 M8 15h2 M14 15h2", label: "Calendar" },
  { id: "music", primary: true, path: "M9 18V5l11-2v13 M9 8l11-2 M9 18a3 2 0 1 1-3-2c1.66 0 3 .9 3 2 M20 16a3 2 0 1 1-3-2c1.66 0 3 .9 3 2", label: "Folia" },
  { id: "history", ico: "◷", label: "History" },
  { id: "dashboard", ico: "▰", label: "Dashboard" },
  { id: "agents", ico: "✦", label: "Agents" },
  { id: "capabilities", ico: "⌘", label: "能力中心" },
  { id: "memory", ico: "❖", label: "Memory" },
  { id: "governance", ico: "◇", label: "Governance" },
  { id: "heartbeat", ico: "♥", label: "Heartbeat" },
  { id: "cron", ico: "◷", label: "Cron Jobs" },
  { id: "channels", ico: "◈", label: "Channels" },
  { id: "settings", ico: "⚙", label: "Settings" },
];

const state = {
  ws: null,
  runningAgent: null,
  runningSurface: null,
  // 跨轮会话：web 主聊天绑定到 web:default 这个 session key（与 Discord 频道对等）。
  // chat.trace 是持久 trace 缓冲：即便切走别的页面，loop 事件也累积在这，回到 chat 时重放。
  // agent 初始留空：首屏由主题角色层/服务端 DEFAULT_AGENT 决定（见 PANELS.chat.render 的优先级），
  // 若在此预置常量会被误判成「本次会话已选」而压过那两者。
  chat: { messages: [], agent: "", agents: [], skill: "", model: "", models: [], modelRows: [], effectiveModelRef: "", permissionMode: "", reasoningEffort: "", agentDefaultReasoningEffort: "medium", attachments: [], pendingUploads: 0, sttControllers: new Map(), sessionKey: "", sessionId: null, selectedSessionKey: "", sessions: [], sourceFilter: "all", readOnlyMirror: false, trace: [], subagents: {}, activeRunId: "", channelRuns: {}, running: false, stopping: false, durationTicker: null, missingRunTimer: null, plan: null, planDone: {}, checkpoint: null, goal: null, goalArmed: false, abort: null, detailRequestSeq: 0, sessionListRequestSeq: 0 },
  cowork: { devices: [], origin: null, timer: null, loading: null, error: "", lastLoadedAt: 0 },
  connection: { everOpened: false, disconnectedAt: 0, reconnectAttempt: 0, reconnectTimer: null, awaitingReconnectSnapshot: false, serverEpoch: "", seenLogs: new Set(), seenLogOrder: [] },
  governance: { proposals: [], filter: "pending", scrollByFilter: {}, openDiffs: {}, busyId: "" },
  rec: null, // 录音 MediaRecorder 状态
};
state.chat.mode = "main";
try { if (localStorage.getItem("harbour-chat-mode") === "cowork") state.chat.mode = "cowork"; } catch { /* 私密模式保留默认。 */ }
// A native cold launch opens an unselected canvas, NOT a new/cleared session.
// Explicit selection, a deep link or the first submitted message leaves it.
state.chat.landing = window.harbourDesktop?.startup === true;
if (state.chat.landing) state.chat.mode = "main";
state.chat.cowork = coworkBindingForSession(null);

/* ── helpers ──────────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadCoworkOrigin() {
  try {
    const desktop = window.harbourDesktop;
    const info = typeof desktop?.getCoworkDeviceInfo === "function"
      ? await desktop.getCoworkDeviceInfo()
      : typeof desktop?.getCoworkDevice === "function" ? await desktop.getCoworkDevice()
      : desktop?.coworkDeviceInfo || desktop?.deviceInfo;
    const id = info?.id || info?.deviceId || desktop?.coworkDeviceId;
    state.cowork.origin = id ? { id: String(id), label: String(info?.label || ""), hostname: String(info?.hostname || "") } : null;
  } catch { state.cowork.origin = null; }
  renderCoworkBar();
}

function renderCoworkBar() {
  const bar = $("#coworkBar");
  const active = state.chat.mode === "cowork";
  document.querySelectorAll("[data-chat-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.chatMode === state.chat.mode);
    button.setAttribute("aria-selected", String(button.dataset.chatMode === state.chat.mode));
    button.disabled = !!(state.chat.running || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession);
  });
  const disclosure = $("#coworkDisclosure");
  if (disclosure) disclosure.hidden = !active;
  const currentDevice = state.cowork.devices.find(device => device.id === (active ? state.chat.cowork?.deviceId || "server" : "server"));
  const summary = $("#coworkEnvironmentSummary");
  if (summary) summary.textContent = executionDeviceSummary(currentDevice, state.chat.cowork?.deviceId);
  const shortcut = $("#chatExecutionEnvironment");
  if (shortcut) {
    const label = active ? "环境设置" : `执行环境 · ${executionPlatformLabel(currentDevice?.platform)}`;
    shortcut.querySelector(".chat-tool-label").textContent = label;
    shortcut.setAttribute("aria-label", `${label}；${executionDeviceSummary(currentDevice, active ? state.chat.cowork?.deviceId : "server")}`);
  }
  if (!bar) { renderCoworkDeviceList(); return; }
  bar.hidden = !active;
  if (!active) return;
  const binding = state.chat.cowork || coworkBindingForSession(null);
  const origin = $("#coworkOrigin");
  const registeredOrigin = state.cowork.devices.find((device) => device.id === state.cowork.origin?.id);
  if (origin) origin.textContent = registeredOrigin?.label || state.cowork.origin?.label || state.cowork.origin?.hostname || "此客户端";
  const target = $("#coworkTarget");
  if (target) {
    const options = coworkDeviceOptionsHtml(state.cowork.devices, binding.deviceId);
    if (target._coworkOptions !== options) { target.innerHTML = options; target._coworkOptions = options; }
    target.value = binding.deviceId;
  }
  const cwd = $("#coworkCwd");
  if (cwd && document.activeElement !== cwd) cwd.value = binding.cwd || "";
  const device = state.cowork.devices.find((item) => item.id === binding.deviceId);
  const status = $("#coworkStatus");
  if (status) {
    status.classList.toggle("is-offline", !device?.online || !!state.cowork.error);
    status.textContent = state.chat.readOnlyMirror ? "外部渠道镜像只读"
      : state.cowork.error ? `设备列表暂不可用：${state.cowork.error}。目标保持不变。`
      : state.chat.coworkSaving ? "正在保存会话目标…"
      : device?.online ? `${executionPlatformLabel(device.platform)} / ${device.arch || "架构未上报"} · ${executionShellLabel(device)} · @设备 仅切换本轮`
      : "目标离线或尚未连接；不会自动切换设备。可等待恢复，或明确选择另一台设备。";
  }
  const locked = coworkControlsLocked(state.chat);
  [target, cwd, $("#coworkRename")].forEach((control) => { if (control) control.disabled = locked; });
  const rename = $("#coworkRename");
  if (rename) {
    rename.disabled = locked || binding.deviceId === "server";
    rename.title = binding.deviceId === "server" ? "Harbour 服务端使用固定名称" : "重命名当前执行设备";
  }
}

async function loadCoworkDevices() {
  if (state.cowork.loading) return state.cowork.loading;
  state.cowork.loading = (async () => {
    try {
      const data = await api("/api/cowork/devices");
      state.cowork.devices = Array.isArray(data.devices) ? data.devices : [];
      state.cowork.error = "";
      state.cowork.lastLoadedAt = Date.now();
    } catch (error) { state.cowork.error = error.message || "连接失败"; }
    finally { state.cowork.loading = null; renderCoworkBar(); renderCoworkDeviceList(); }
  })();
  return state.cowork.loading;
}

function stopCoworkPolling() {
  if (state.cowork.timer) clearTimeout(state.cowork.timer);
  state.cowork.timer = null;
}

function coworkIsVisible() {
  return !document.hidden && window.HarbourVisualActivity?.isActive() !== false && document.body.dataset.panel === "chat" && state.chat.mode === "cowork" && !!$("#coworkBar");
}

function syncCoworkPolling() {
  stopCoworkPolling();
  if (!coworkIsVisible()) return;
  const tick = async () => {
    if (!coworkIsVisible()) return;
    await loadCoworkDevices();
    if (coworkIsVisible() && !state.cowork.timer) state.cowork.timer = setTimeout(() => { state.cowork.timer = null; void tick(); }, 15000);
  };
  void tick();
}
if (window.HarbourVisualActivity) window.HarbourVisualActivity.subscribe(syncCoworkPolling);
else document.addEventListener("visibilitychange", syncCoworkPolling);
window.addEventListener("pagehide", stopCoworkPolling);

async function switchChatMode(mode) {
  if (!["main", "cowork"].includes(mode) || mode === state.chat.mode) return;
  if (state.chat.running || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession) return toast("当前配置已锁定；请等待本轮完成。", true);
  if (state.chat.inspection) closeChatInspection();
  ++state.chat.detailRequestSeq;
  ++state.chat.sessionListRequestSeq;
  state.chat.switchingMode = true;
  state.chat.landing = false;
  state.chat.mode = mode;
  try { localStorage.setItem("harbour-chat-mode", mode); } catch { /* 私密模式只保留当前页。 */ }
  state.chat.sessionKey = sessionKeyFor(state.chat.agent, mode);
  state.chat.sessionId = null;
  state.chat.selectedSessionKey = "";
  state.chat.sessions = [];
  state.chat.sourceFilter = mode === "cowork" ? "cowork" : "all";
  state.chat.messages = [];
  state.chat.trace = [];
  state.chat.plan = null;
  state.chat.checkpoint = null;
  state.chat.goal = null;
  state.chat.goalArmed = false;
  state.chat.model = "";
  state.chat.reasoningEffort = "";
  state.chat.permissionMode = "";
  state.chat.cowork = coworkBindingForSession(null);
  if ($("#chatModel")) $("#chatModel").value = "";
  if ($("#chatPermMode")) $("#chatPermMode").value = "";
  fillChatEfforts();
  syncChatSourceMode(null);
  renderChatMessages(); renderChatGoal(); renderChatPlan(); renderChatCheckpoint();
  renderCoworkBar(); syncCoworkPolling();
  try { await loadChatSessions(); }
  finally { state.chat.switchingMode = false; syncChatControlLocks(); }
}

async function saveCoworkBinding(binding) {
  if (state.chat.mode !== "cowork" || coworkControlsLocked(state.chat)) { renderCoworkBar(); return; }
  const id = state.chat.sessionId;
  const previous = state.chat.cowork;
  const next = { deviceId: String(binding.deviceId || "server"), ...(String(binding.cwd || "").trim() ? { cwd: String(binding.cwd).trim() } : {}) };
  state.chat.cowork = next;
  if (!id) { renderCoworkBar(); return; }
  state.chat.coworkSaving = true;
  syncChatControlLocks();
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ cowork: next }) });
    if (state.chat.sessionId === id) state.chat.cowork = coworkBindingForSession(session);
  } catch (error) {
    if (state.chat.sessionId === id) state.chat.cowork = previous;
    toast(error.message, true);
  } finally { state.chat.coworkSaving = false; syncChatControlLocks(); }
}

async function renameCoworkDevice(id) {
  if (id === "server" || coworkControlsLocked(state.chat)) return;
  const device = state.cowork.devices.find((item) => item.id === id);
  if (!device) return toast("设备尚未注册，请先刷新设备列表。", true);
  const label = await harbourPrompt("重命名会同步到所有客户端；设备 ID 和会话目标不变。", device.label || device.hostname || id, { title: "重命名设备", inputLabel: "设备名称" });
  if (label == null || !label.trim()) return;
  try {
    await api(`/api/cowork/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ label: label.trim() }) });
    await loadCoworkDevices();
  } catch (error) { toast(error.message, true); }
}

function renderCoworkDeviceList() {
  const list = $("#coworkDeviceList");
  if (!list) return;
  const binding = state.chat.mode === "cowork" ? state.chat.cowork || { deviceId: "server" } : { deviceId: "server" };
  const devices = coworkDeviceOptions(state.cowork.devices, binding.deviceId);
  list.innerHTML = devices.map(device => executionDeviceCard(device, binding.deviceId)).join("");
  list.querySelectorAll("[data-cowork-rename]").forEach((button) => button.addEventListener("click", () => renameCoworkDevice(button.dataset.coworkRename)));
  const status = $("#executionSettingsStatus");
  if (status) {
    status.textContent = state.cowork.error ? `刷新失败：${state.cowork.error}。以下保留上次上报信息，不改变执行目标。`
      : state.cowork.loading ? "正在读取执行环境…" : "自动识别实际设备；此页不会安装或切换操作系统。";
    status.classList.toggle("is-error", !!state.cowork.error);
  }
  const select = $("#settingsCoworkTarget");
  const cwd = $("#settingsCoworkCwd");
  const editable = state.chat.mode === "cowork" && !coworkControlsLocked(state.chat);
  if (select) {
    const options = coworkDeviceOptionsHtml(state.cowork.devices, binding.deviceId);
    if (select._coworkOptions !== options) { select.innerHTML = options; select._coworkOptions = options; }
    select.value = binding.deviceId;
    select.disabled = !editable;
  }
  if (cwd) {
    if (document.activeElement !== cwd) cwd.value = binding.cwd || "";
    cwd.disabled = !editable;
  }
  const note = $("#executionSessionNote");
  if (note) note.textContent = state.chat.readOnlyMirror ? "外部渠道会话只读，不能在这里改变执行目标。"
    : state.chat.mode !== "cowork" ? "普通聊天在 Harbour 后端执行。请先在聊天页切换到 Cowork，再选择其他设备。"
    : state.chat.coworkSaving ? "正在保存当前会话的执行位置…"
    : coworkControlsLocked(state.chat) ? "本轮配置已锁定，完成或停止后才能修改。"
    : "只修改当前 Cowork 会话，与聊天页同步；换设备会清空旧目录，离线不会自动改派。";
}

function executionPlatformLabel(platform) {
  const labels = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  return Object.hasOwn(labels, platform) ? labels[platform] : platform || "系统未上报";
}

function executionShellLabel(device) {
  const shell = device?.environment?.shell;
  if (!shell) return "Shell 未上报";
  return `${shell.name}${shell.version ? ` · ${shell.version}` : " · 版本未上报"}${shell.available === false ? "（未找到）" : ""}`;
}

function executionDeviceSummary(device, fallbackId) {
  if (!device) return `${fallbackId === "server" ? "Harbour 服务端" : fallbackId || "执行设备"} · 环境待刷新`;
  return `${device.label || device.hostname || device.id} · ${executionPlatformLabel(device.platform)} · ${device.environment?.shell?.name || "Shell 未上报"}${device.online ? "" : " · 离线"}`;
}

function executionDeviceCard(device, selectedId) {
  const env = device.environment;
  const tools = new Set(device.tools || []);
  const row = (name, value) => `<div><dt>${name}</dt><dd>${esc(value || "未上报")}</dd></div>`;
  const capability = (label, available) => `<span class="execution-capability${available ? " is-available" : ""}">${label} · ${available ? "已注册" : "未配置"}</span>`;
  return `<article class="execution-device${device.id === selectedId ? " is-selected" : ""}" data-execution-device="${esc(device.id)}">
    <header><div><span class="execution-device-kind">${device.id === "server" ? "HARBOUR 后端" : "COWORK 执行端"}</span><h4>${esc(device.label || device.hostname || device.id)}</h4></div>
      <span class="pill ${device.online ? "on" : "warn"}">${device.online ? "在线" : device.lastSeenAt ? "离线 · 上次信息" : "尚未连接"}</span></header>
    <div class="execution-system">${esc(executionPlatformLabel(device.platform))}<span>${esc(device.arch || "架构未上报")}</span>${device.id === selectedId ? '<span class="execution-selected">当前会话</span>' : ""}</div>
    <dl>${row("Shell", executionShellLabel(device))}${row("Shell 路径", env?.shell?.executable)}${row("系统版本", env?.osRelease)}${row("Node.js", env?.nodeVersion)}${row("主机", device.hostname)}${row("默认目录", device.cwd)}</dl>
    <div class="execution-capabilities">${capability("文件", tools.has("read_file"))}${capability("命令", tools.has("bash") && env?.shell?.available !== false)}${capability("浏览器", tools.has("opencli_browser"))}</div>
    <footer><span>${device.id === "server" ? "管理 Main、会话、Memory 与 Workflow" : !env ? "执行端未上报完整环境；连接并更新客户端后可显示。" : "只承接已注册的工具，不运行另一套 Main"}</span>
      ${device.id !== "server" ? `<button class="btn ghost" data-cowork-rename="${esc(device.id)}"${coworkControlsLocked(state.chat) ? " disabled" : ""}>重命名</button>` : ""}</footer>
  </article>`;
}

function renderSettingsDevices(pane) {
  pane.innerHTML = `<section class="settings-section execution-settings">
    ${settingsHeadingHtml("设备与执行环境", "⌘", "分清 Harbour 后端和工具执行位置。系统自动识别，无需手动填写 Windows、Linux 或 macOS。")}
    <div class="settings-section-body"><div class="execution-settings-toolbar"><p id="executionSettingsStatus" role="status" aria-live="polite"></p><button class="btn ghost" id="coworkDevicesRefresh" type="button">刷新环境</button></div>
    <section class="execution-session"><h4>当前会话的执行位置</h4><div class="execution-session-fields">
      <label>执行设备<select class="inp" id="settingsCoworkTarget" aria-label="当前 Cowork 会话执行设备"></select></label>
      <label>工作目录<input class="inp" id="settingsCoworkCwd" placeholder="留空使用目标设备默认目录" autocomplete="off"></label></div>
      <p id="executionSessionNote"></p><a href="#chat">返回聊天页 →</a></section>
    <div class="execution-device-grid" id="coworkDeviceList"></div>
    <p class="execution-footnote">工具状态表示执行端已注册该能力，不代表浏览器已登录或任务已验证成功。Shell 版本仅做缓存的轻量检测；切换设备不会迁移后端、账号或文件，也不会改变权限。</p>
    </div></section>`;
  $("#coworkDevicesRefresh").addEventListener("click", loadCoworkDevices);
  $("#settingsCoworkTarget").addEventListener("change", async (event) => {
    await saveCoworkBinding({ deviceId: event.target.value });
    renderCoworkDeviceList();
  });
  $("#settingsCoworkCwd").addEventListener("change", async (event) => {
    await saveCoworkBinding({ deviceId: state.chat.cowork?.deviceId, cwd: event.target.value });
    renderCoworkDeviceList();
  });
  renderCoworkDeviceList();
  void loadCoworkDevices();
}

/* ── Harbour Select ─────────────────────────────────────────────────
   全站统一下拉：原生 select 留作数据/表单/事件层，外面套自绘 trigger + menu。
   这样老代码继续放心读写 .value / 监听 change，同时获得 optgroup、键盘操作和主题化弹层。
   MutationObserver 覆盖 SPA 动态面板；value setter 桥接程序化赋值，避免 UI 与真实值不同步。 */
const harbourSelectStates = new WeakMap();
const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
let openHarbourSelect = null;

function closeHarbourSelect(state = openHarbourSelect) {
  if (!state) return;
  const external = state.external;
  state.external = null;
  external?.adapter.close();
  state.wrap.classList.remove("open");
  state.trigger.setAttribute("aria-expanded", "false");
  state.menu.style.removeProperty("visibility");
  state.menu.style.removeProperty("display");
  if (openHarbourSelect === state) openHarbourSelect = null;
}

function harbourMenuBounds(wrap, pad) {
  const bounds = { left: pad, top: pad, right: window.innerWidth - pad, bottom: window.innerHeight - pad };
  // absolute 菜单无法穿透 overflow 祖先；把每层真实裁切框求交集，定位时就待在可见区内。
  for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left + pad);
      bounds.right = Math.min(bounds.right, rect.right - pad);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top + pad);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom - pad);
    }
  }
  return bounds;
}

function positionHarbourMenu(state) {
  if (state.external) return closeHarbourSelect(state); // Native popup anchors must not drift on scroll/resize.
  if (!state.wrap.classList.contains("open")) return;
  const { trigger, menu, wrap } = state;
  const r = trigger.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const pad = 8;
  const bounds = harbourMenuBounds(wrap, pad);
  const chatMenuWidths = { chatAgent: 300, chatSkill: 260, chatModel: 300, chatEffort: 190, chatPermMode: 190 };
  const minWide = state.select.classList.contains("chat-tool")
    ? (chatMenuWidths[state.select.id] || 280)
    : state.select.classList.contains("theme-select") || /^setTheme/.test(state.select.id)
      ? 240
      : r.width;
  const requestedWidth = Number(state.select.dataset.hsMenuWidth) || 0;
  const width = Math.min(Math.max(r.width, minWide, requestedWidth), Math.max(0, bounds.right - bounds.left));
  menu.style.width = `${width}px`;
  // 弹层是 wrapper 内的 absolute 子元素：缩放/响应式移动时天然跟着 trigger。
  // 这里只把局部 left 向视口内钳制，不再记录任何 viewport fixed 坐标。
  const viewportLeft = Math.max(bounds.left, Math.min(r.left, bounds.right - width));
  menu.style.left = `${viewportLeft - wr.left}px`;
  // scrollHeight excludes borders; omitting them manufactures a scrollbar even
  // when a menu contains only one option and has plenty of space below it.
  const style = getComputedStyle(menu);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const wanted = Math.min(menu.scrollHeight + borders, 340);
  const below = bounds.bottom - r.bottom;
  const above = r.top - bounds.top;
  // Main Chat 的工具栏固定在输入区顶部：统一向消息区（上方）展开，避免短菜单落进 textarea 后像“消失”。
  const preferUp = state.select.classList.contains("chat-tool") && above >= Math.min(wanted, 120);
  const openUp = preferUp || (below < wanted && above > below);
  const available = Math.max(48, (openUp ? above : below) - 7);
  const shownHeight = Math.min(wanted, available, 340);
  menu.style.maxHeight = `${shownHeight}px`;
  menu.classList.toggle("open-up", openUp);
  menu.style.top = openUp ? "auto" : "calc(100% + 7px)";
  menu.style.bottom = openUp ? "calc(100% + 7px)" : "auto";
  menu.style.visibility = "visible";
}

function enhanceHarbourSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.hasAttribute("data-run-picker-native") || harbourSelectStates.has(select)) return;
  select.dataset.hsEnhanced = "";
  const wrap = document.createElement("div");
  wrap.className = `harbour-select${select.classList.contains("chat-tool") ? " hs-chat" : ""}${select.classList.contains("theme-select") ? " hs-theme" : ""}${select.classList.contains("inp") ? " hs-inp" : ""}${select.classList.contains("chat-tool-mode") ? " hs-mode" : ""}`;
  if (select.id) wrap.dataset.hsFor = select.id;
  // 动态面板有少量 select 用 inline width/min-width 做栅格约束；把它们搬到可见外壳。
  if (select.style.width) wrap.style.width = select.style.width;
  if (select.style.minWidth) wrap.style.minWidth = select.style.minWidth;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "hs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (select.getAttribute("aria-label")) trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
  trigger.title = select.title || "选择";
  const prefix = document.createElement("span");
  prefix.className = "hs-prefix";
  const inferredLabel = {
    themeCat: "风格", themePersona: "角色", themeVariant: "配色",
    setThemeCat: "风格", setThemePersona: "角色", setThemeVariant: "配色",
  }[select.id];
  prefix.textContent = select.dataset.hsLabel || inferredLabel || "";
  const value = document.createElement("span");
  value.className = "hs-value";
  const caret = document.createElement("span");
  caret.className = "hs-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "⌄";
  trigger.append(prefix, value, caret);
  if (select.dataset.hsIcon) {
    wrap.classList.add("hs-chat-icon");
    trigger.insertAdjacentHTML("afterbegin", chatComposerIcon(select.dataset.hsIcon));
  }
  const menu = document.createElement("div");
  menu.className = "hs-menu";
  menu.setAttribute("role", "listbox");
  if (select.id) { menu.id = `${select.id}-menu`; trigger.setAttribute("aria-controls", menu.id); }
  if (select.getAttribute("aria-label")) menu.setAttribute("aria-label", select.getAttribute("aria-label"));
  select.parentNode.insertBefore(wrap, select);
  wrap.append(trigger, select, menu);
  select.classList.add("hs-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const state = { select, wrap, trigger, value, menu, sync: null, external: null };
  harbourSelectStates.set(select, state);
  const optionSignature = () => JSON.stringify([select.disabled, select.hidden, select.value,
    [...select.options].map(o => [o.value, o.textContent, o.disabled, o.hidden, o.dataset.hsOptionLabel, o.dataset.hsDescription])]);
  // Opt-in native menu presentation. The original select still owns values and
  // change events; other selects retain their existing DOM implementation.
  select.addEventListener("harbour-menu-close", () => closeHarbourSelect(state));

  const rebuild = () => {
    menu.innerHTML = "";
    const frag = document.createDocumentFragment();
    if (select.dataset.hsMenuTitle) {
      const heading = document.createElement("div"); heading.className = "hs-menu-heading"; heading.setAttribute("role", "presentation");
      const title = document.createElement("strong"); title.textContent = select.dataset.hsMenuTitle; heading.append(title);
      if (select.dataset.hsMenuHint) {
        const hint = document.createElement("small"); hint.textContent = select.dataset.hsMenuHint; heading.append(hint);
      }
      frag.append(heading);
    }
    const addOption = (opt) => {
      if (opt.hidden) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hs-option";
      b.dataset.hsIndex = String(opt.index);
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", opt.selected ? "true" : "false");
      b.title = opt.title || opt.textContent || opt.value;
      b.disabled = opt.disabled;
      const check = document.createElement("span"); check.className = "hs-check"; check.textContent = opt.selected ? "◆" : "";
      const txt = document.createElement("span"); txt.className = "hs-option-text"; txt.textContent = opt.dataset.hsOptionLabel || opt.textContent || opt.value;
      if (opt.dataset.hsDescription) {
        const copy = document.createElement("span"); copy.className = "hs-option-copy";
        const description = document.createElement("small"); description.className = "hs-option-description"; description.textContent = opt.dataset.hsDescription;
        copy.append(txt, description); b.append(check, copy);
      } else b.append(check, txt);
      frag.appendChild(b);
    };
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const head = document.createElement("div");
        head.className = "hs-group";
        head.textContent = child.label;
        frag.appendChild(head);
        for (const opt of child.children) if (opt instanceof HTMLOptionElement) addOption(opt);
      } else if (child instanceof HTMLOptionElement) addOption(child);
    }
    menu.appendChild(frag);
  };
  state.sync = () => {
    if (state.external && state.external.signature !== optionSignature()) closeHarbourSelect(state);
    rebuild();
    const selected = select.selectedOptions[0] || select.options[0];
    value.textContent = selected ? selected.textContent : "—";
    // 可见宽度不足时文字会省略；title 始终跟当前选项走，悬停仍能看到完整含义。
    trigger.title = selected?.title || selected?.textContent || select.title || "选择";
    if (select.dataset.hsIcon) {
      const label = `${select.getAttribute("aria-label") || prefix.textContent} · ${value.textContent}`;
      trigger.title = label;
      trigger.setAttribute("aria-label", label);
    }
    trigger.disabled = select.disabled;
    wrap.hidden = select.hidden || select.style.display === "none";
    wrap.classList.toggle("hs-empty", !selected || !selected.value);
    wrap.dataset.hsValue = selected?.value || "";
    if (wrap.classList.contains("open") && !state.external) requestAnimationFrame(() => positionHarbourMenu(state));
  };

  // 代理实例 value：所有现有 `select.value = x` 会同步刷新自绘 trigger/menu。
  if (nativeSelectValue?.get && nativeSelectValue?.set) {
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return nativeSelectValue.get.call(select); },
      set(v) { nativeSelectValue.set.call(select, v); state.sync(); },
    });
  }
  select.addEventListener("change", state.sync);
  new MutationObserver(state.sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });

  trigger.addEventListener("click", () => {
    if (openHarbourSelect && openHarbourSelect !== state) closeHarbourSelect();
    if (wrap.classList.contains("open")) return closeHarbourSelect(state);
    state.sync();
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    openHarbourSelect = state;
    menu.style.visibility = "hidden";
    const adapter = select.harbourMenu?.();
    if (adapter) {
      menu.style.display = "none";
      const pending = state.external = { adapter, signature: optionSignature() };
      Promise.resolve().then(() => state.external === pending ? adapter.open(trigger.getBoundingClientRect()) : null).then(reply => {
        if (state.external !== pending) return;
        closeHarbourSelect(state);
        if (!select.isConnected || select.disabled || !reply) return;
        const option = [...select.options].find(o => o.value === reply.value && !o.hidden && !o.disabled);
        if (option) {
          if (select.value !== option.value) {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          trigger.focus();
        } else if (reply.dismiss === 'escape') trigger.focus();
        else if (reply.dismiss === 'tab' || reply.dismiss === 'shift-tab') {
          const focusable = [...document.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
            .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
          const at = focusable.indexOf(trigger), step = reply.dismiss === 'tab' ? 1 : -1;
          (focusable[at + step] || trigger).focus();
        }
      }).catch(error => {
        if (state.external !== pending) return;
        closeHarbourSelect(state); adapter.onError?.(error);
      });
      return;
    }
    requestAnimationFrame(() => positionHarbourMenu(state));
  });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hs-index]");
    if (!b || b.disabled) return;
    const opt = select.options[Number(b.dataset.hsIndex)];
    if (!opt) return;
    if (select.value !== opt.value) {
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    closeHarbourSelect(state);
    trigger.focus();
  });
  const keyboard = (e) => {
    if (e.key === "Tab") { closeHarbourSelect(state); return; }
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key) && !wrap.classList.contains("open")) {
      e.preventDefault(); trigger.click();
      if (state.external) return; // Native menu owns its option focus and keys.
      const selected = menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector(".hs-option:not(:disabled)");
      requestAnimationFrame(() => selected?.focus());
      return;
    }
    if (e.key === "Escape" && wrap.classList.contains("open")) { e.preventDefault(); closeHarbourSelect(state); trigger.focus(); return; }
    if (!wrap.classList.contains("open")) return;
    if (state.external) return; // While its renderer loads, never focus hidden DOM options.
    const opts = [...menu.querySelectorAll(".hs-option:not(:disabled)")];
    const at = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      opts[(at + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault(); opts[e.key === "Home" ? 0 : opts.length - 1]?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && document.activeElement?.matches(".hs-option")) {
      e.preventDefault(); document.activeElement.click();
    }
  };
  trigger.addEventListener("keydown", keyboard);
  menu.addEventListener("keydown", keyboard);
  wrap.addEventListener("focusout", () => {
    // Tab 离开整套控件时收口；从 trigger 移到菜单 option 仍属于 wrap 内，不会误关。
    requestAnimationFrame(() => {
      if (!state.external && wrap.classList.contains("open") && !wrap.contains(document.activeElement)) closeHarbourSelect(state);
    });
  });
  state.sync();
}

function enhanceHarbourSelects(root = document) {
  if (root instanceof HTMLSelectElement) enhanceHarbourSelect(root);
  root.querySelectorAll?.("select").forEach(enhanceHarbourSelect);
}

function initHarbourSelects() {
  enhanceHarbourSelects();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) {
      if (node instanceof Element) enhanceHarbourSelects(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", (e) => {
    if (openHarbourSelect && !openHarbourSelect.wrap.contains(e.target)) closeHarbourSelect();
  }, true);
  window.addEventListener("resize", () => openHarbourSelect && positionHarbourMenu(openHarbourSelect));
  document.addEventListener("scroll", (e) => {
    if (!openHarbourSelect || (e.target instanceof Node && openHarbourSelect.menu.contains(e.target))) return;
    // absolute 菜单会随所属控件移动；外层滚动只需重算朝向/边界，不再把菜单强制关闭。
    requestAnimationFrame(() => openHarbourSelect && positionHarbourMenu(openHarbourSelect));
  }, true);
}

function authToken() { return localStorage.getItem("harbour-token") || ""; }

// 给同源 URL（/uploads、/assets 等）附上 ?token=，让 <img>/<audio> 在鉴权开启时也能加载（它们没法带请求头）。
function withToken(url) {
  const t = authToken();
  if (!t || /^https?:\/\//i.test(url)) return url; // 无 token 或外链：原样
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

async function api(path, opts = {}) {
  const t = authToken();
  const headers = { "Content-Type": "application/json", ...(t ? { "x-harbour-token": t } : {}), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { error: text.slice(0, 500) }; }
  }
  if (res.status === 401) { window.HarbourStartupGate?.failed("auth"); promptLogin(); throw Object.assign(new Error(data.error || "未授权：请输入访问令牌"), { status: 401 }); }
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }
  return data;
}

// 取原始文本响应（非 JSON）：用于把记忆图谱 HTML 塞进 iframe.srcdoc（带 token、免跨域）。
async function rawFetch(path, opts = {}) {
  const t = authToken();
  const headers = { ...(t ? { "x-harbour-token": t } : {}), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { promptLogin(); throw new Error("未授权"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 鉴权开启时，任意 API 返回 401 → 弹出令牌输入框（存 localStorage 后刷新）。只弹一次。
function promptLogin() {
  if (document.getElementById("loginOverlay")) return;
  const ov = h(`<div id="loginOverlay" class="login-overlay">
    <div class="login-card">
      <h2>HARBOUR · 访问令牌</h2>
      <p class="muted">服务端已开启鉴权（WEB_AUTH_TOKEN）。输入令牌以继续。</p>
      <input class="inp" id="loginToken" type="password" placeholder="访问令牌" autocomplete="current-password">
      <button class="btn primary" id="loginSave">进入</button>
    </div></div>`);
  document.body.appendChild(ov);
  const save = () => {
    const v = ov.querySelector("#loginToken").value.trim();
    if (!v) return;
    localStorage.setItem("harbour-token", v);
    location.reload();
  };
  ov.querySelector("#loginSave").addEventListener("click", save);
  ov.querySelector("#loginToken").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  ov.querySelector("#loginToken").focus();
}

function toast(msg, bad) {
  // 竖直堆叠容器：多个 toast 不再重叠在同一角；每个滑入淡出。
  let stack = document.getElementById("toastStack");
  if (!stack) { stack = h(`<div class="toast-stack" id="toastStack"></div>`); document.body.appendChild(stack); }
  const t = h(`<div class="toast ${bad ? "bad" : ""}">${esc(msg)}</div>`);
  stack.appendChild(t);
  void t.offsetWidth;              // 强制回流，让隐藏初始态先落定，进场过渡才会触发（不依赖 rAF，后台标签页也稳）
  t.classList.add("in");
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 280); }, 3000);
}

/* ── Harbour Dialog ─────────────────────────────────────────────────
   Electron 里的 window.confirm / alert / prompt 会退回 Windows 原生窗口，既脱离
   当前主题，也会打断 Dashboard 的空间关系。这里提供同一套异步、可排队的主题弹层：
   · confirm → boolean   · alert → void   · prompt → string | null
   所有文字先 esc；Esc/遮罩取消，Enter 确认，Tab 焦点不会跑到弹层后面。 */
let harbourDialogTail = Promise.resolve();
let harbourDialogSequence = 0;

function showHarbourDialog(options = {}) {
  return new Promise((resolve) => {
    const kind = ["confirm", "alert", "prompt", "leave"].includes(options.kind) ? options.kind : "confirm";
    const tone = ["accent", "warning", "danger"].includes(options.tone) ? options.tone : "accent";
    const canCancel = kind !== "alert";
    const id = `harbourDialog${++harbourDialogSequence}`;
    const symbol = tone === "danger" ? "!" : tone === "warning" ? "◇" : "✦";
    const kicker = kind === "prompt" ? "INPUT" : kind === "alert" ? "NOTICE" : "CONFIRM";
    const title = options.title || (kind === "prompt" ? "请输入" : kind === "alert" ? "提示" : "请确认");
    const message = String(options.message || "");
    const detail = String(options.detail || "");
    const confirmLabel = options.confirmLabel || (kind === "alert" ? "知道了" : "确定");
    const cancelLabel = options.cancelLabel || "取消";
    const input = kind === "prompt"
      ? `<label class="harbour-dialog-field"><span>${esc(options.inputLabel || "内容")}</span><input class="inp harbour-dialog-input" type="text" value="${esc(options.value || "")}" placeholder="${esc(options.placeholder || "")}" autocomplete="off"></label>`
      : "";
    const overlay = h(`<div class="md-modal harbour-dialog-layer" data-dialog-kind="${kind}">
      <section class="md-card harbour-dialog tone-${tone}" role="${tone === "danger" ? "alertdialog" : "dialog"}" aria-modal="true" aria-labelledby="${id}Title" aria-describedby="${id}Message">
        <header class="harbour-dialog-head">
          <span class="harbour-dialog-symbol" aria-hidden="true">${symbol}</span>
          <span class="harbour-dialog-heading"><small>${kicker}</small><h2 id="${id}Title">${esc(title)}</h2></span>
        </header>
        <div class="harbour-dialog-body">
          ${message ? `<p id="${id}Message" class="harbour-dialog-message">${esc(message)}</p>` : ""}
          ${detail ? `<p class="harbour-dialog-detail">${esc(detail)}</p>` : ""}
          ${input}
        </div>
        <footer class="harbour-dialog-actions">
          ${canCancel ? `<button class="btn ghost harbour-dialog-cancel" type="button">${esc(cancelLabel)}</button>` : ""}
          ${kind === "leave" ? `<button class="btn ghost harbour-dialog-discard" type="button">放弃修改并离开</button>` : ""}
          <button class="btn primary harbour-dialog-confirm" type="button" ${kind === "leave" && options.canSave === false ? "hidden" : ""}>${esc(confirmLabel)}</button>
        </footer>
      </section>
    </div>`);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      const value = kind === "leave" ? (accepted === "discard" ? "discard" : accepted ? "save" : "stay") : kind === "prompt"
        ? (accepted ? overlay.querySelector(".harbour-dialog-input")?.value ?? "" : null)
        : !!accepted;
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const focusables = () => [...overlay.querySelectorAll("button:not([disabled]), input:not([disabled])")].filter(node => !node.hidden);
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(canCancel ? false : true);
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        if (kind === "leave") { event.target.closest?.("button")?.click(); return; }
        finish(!event.target.closest?.(".harbour-dialog-cancel"));
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    overlay.querySelector(".harbour-dialog-confirm").addEventListener("click", () => finish(true));
    overlay.querySelector(".harbour-dialog-cancel")?.addEventListener("click", () => finish(false));
    overlay.querySelector(".harbour-dialog-discard")?.addEventListener("click", () => finish("discard"));
    overlay.addEventListener("mousedown", (event) => { if (canCancel && event.target === overlay) finish(false); });
    document.addEventListener("keydown", onKeyDown, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => (overlay.querySelector(kind === "leave" || options.initialFocus === "cancel" ? ".harbour-dialog-cancel" : ".harbour-dialog-input") || overlay.querySelector(".harbour-dialog-confirm"))?.focus());
  });
}

function harbourDialog(options) {
  const current = harbourDialogTail.then(() => showHarbourDialog(options));
  harbourDialogTail = current.then(() => undefined, () => undefined);
  return current;
}

function harbourConfirm(message, options = {}) {
  return harbourDialog({ ...options, kind: "confirm", message });
}

async function harbourAlert(message, options = {}) {
  await harbourDialog({ ...options, kind: "alert", message });
}

function harbourPrompt(message, value = "", options = {}) {
  return harbourDialog({ ...options, kind: "prompt", message, value });
}

const editorText = value => String(value ?? "").replace(/\r\n?/g, "\n");
let editorSuspended = false, editorWasInert = false;
const editorLeave = window.HarbourUnsavedChangesFactory.create({
  ask: (labels, { canSave }) => harbourDialog({ kind: "leave", title: "有尚未保存的修改", tone: "warning",
    message: labels.join("\n"), detail: "继续编辑会留在原处。保存沿用各编辑器的规则；文件修改先保存为待审批提案，不会自动应用。",
    cancelLabel: "继续编辑", confirmLabel: "保存后离开", canSave }),
  notify: harbourAlert,
  setSuspended: suspended => {
    if (suspended && !editorSuspended) { editorWasInert = document.body.inert; document.body.inert = true; }
    else if (!suspended && editorSuspended) document.body.inert = editorWasInert;
    editorSuspended = suspended;
  },
});
window.HarbourUnsavedChanges = editorLeave;
window.harbourDesktop?.onBeforeClose?.(options => editorLeave.requestLeave(options));
window.addEventListener("beforeunload", event => {
  if (!editorLeave.hasChanges()) return;
  event.preventDefault(); event.returnValue = "";
});
function leaveEditors(reason = "navigate", ids) { return editorLeave.requestLeave({ reason, ids }); }

const LOCAL_UPLOAD_IMAGE_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#].*)?$/i;

/**
 * 只放行 Harbour 自己托管的 /uploads/ 路径。
 *
 * renderMarkdownLite 会先 esc 整段 Markdown，所以这里仅还原 URL 查询串里的
 * `&amp;`；其它 HTML entity 保持原样。解码后的 `..`、反斜杠与控制字符会被
 * 拒绝，避免普通 Markdown 链接借这个媒体兜底绕过链接白名单。
 */
function safeLocalUploadUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim().replace(/&amp;/g, "&");
  if (!/^\/uploads\/(?!\/)/i.test(url) || /[\\\u0000-\u001f\u007f]/.test(url)) return "";
  const encodedPath = url.split(/[?#]/, 1)[0];
  let decodedPath = "";
  try { decodedPath = decodeURIComponent(encodedPath); } catch { return ""; }
  if (!/^\/uploads\/(?!\/)/i.test(decodedPath)
    || /[\\\u0000-\u001f\u007f]/.test(decodedPath)
    || decodedPath.split("/").some((segment) => segment === "..")) return "";
  return url;
}

function renderLocalUploadLink(label, rawUrl) {
  const url = safeLocalUploadUrl(rawUrl);
  if (!url) return null;
  const href = esc(withToken(url));
  if (LOCAL_UPLOAD_IMAGE_RE.test(url)) {
    return `<a class="att-img-link" href="${href}" data-media-kind="image" data-media-title="${label}" aria-label="在 Harbour 中查看图片：${label}"><img class="md-img-real" src="${href}" alt="${label}" loading="lazy" onerror="this.closest('.att-img-link').style.display='none'"></a>`;
  }
  return `<a href="${href}" data-file-name="${label}" aria-label="在 Harbour 中查看文件：${label}">${label}</a>`;
}

// 轻量 markdown 渲染（先 esc 再套标签，防 XSS）：够看日报即可，不追求完整。
function renderMarkdownLite(md) {
  const lines = esc(md).split(/\r?\n/);
  let html = "", codeFence = "", codeLanguage = "", codeLines = [], inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const closeCode = () => {
    html += `<div class="md-code-block"><div class="md-code-toolbar"><span class="md-code-language">${codeLanguage || "文本"}</span><button type="button" class="md-code-copy" data-code-copy title="复制完整内容" aria-label="复制完整内容"><svg class="md-copy-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2"/><path d="M5 13H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"/></svg><svg class="md-copy-check" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg><span data-code-copy-label aria-live="polite">复制</span></button></div><pre class="md-code"><code>${codeLines.join("\n")}</code></pre></div>`;
    codeFence = ""; codeLanguage = ""; codeLines = [];
  };
  for (const raw of lines) {
    const fence = raw.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
    if (codeFence) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) closeCode();
      else codeLines.push(raw);
      continue;
    }
    if (fence) {
      closeList(); codeFence = fence[1];
      const language = fence[2].trim();
      codeLanguage = /^[a-zA-Z0-9_+#.-]{1,32}$/.test(language) ? language : "";
      continue;
    }
    let line = raw
      // 图片：http(s) 或 /uploads/ → 真 <img>（lazy + no-referrer + onerror 兜底隐藏）；
      // 其余 scheme（data:/javascript: 等）降级为 🖼 占位（与下面链接白名单同口径，防 XSS）。
      // 注：raw 已过 esc()，url/alt 拼进属性天然安全，不要反转义。
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, u) => {
        const url = u.trim();
        // 外链图走后端 /api/img-proxy 绕防盗链/referrer（前端直连常被 403）；点击进入 Harbour 查看器。
        // url 已被 esc()（&→&amp;），编码前先还原 &。
        if (/^https?:\/\//i.test(url)) {
          const src = withToken(`/api/img-proxy?url=${encodeURIComponent(url.replace(/&amp;/g, "&"))}`);
          return `<a class="att-img-link" href="${url}" data-media-kind="image" data-media-title="${alt}" aria-label="在 Harbour 中查看图片：${alt}"><img class="md-img-real" src="${src}" alt="${alt}" loading="lazy" onerror="this.closest('.att-img-link').style.display='none'"></a>`;
        }
        const localImage = renderLocalUploadLink(alt, url);
        if (localImage && LOCAL_UPLOAD_IMAGE_RE.test(safeLocalUploadUrl(url))) return localImage;
        return `<span class="md-img">🖼 ${alt}</span>`;
      })
      // 普通链接若指向 Harbour 本地图片，也渲染成可点击预览。这是 Agent 偶尔漏写
      // Markdown 图片前缀 `!` 时的确定性兜底；其它本地附件仍保持普通文件链接。
      // 仅放行 /uploads/ 与 http/https/mailto，其余（javascript:/data: 等）降级为纯文本。
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => {
        const local = renderLocalUploadLink(t, u);
        if (local) return local;
        return /^(?:https?:|mailto:)/i.test(u.trim())
          ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>`
          : t;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    if (/^###\s+/.test(line)) { closeList(); html += "<h4>" + line.replace(/^###\s+/, "") + "</h4>"; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += "<h3>" + line.replace(/^##\s+/, "") + "</h3>"; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += "<h2>" + line.replace(/^#\s+/, "") + "</h2>"; continue; }
    if (/^>\s?/.test(line)) { closeList(); html += "<blockquote>" + line.replace(/^>\s?/, "") + "</blockquote>"; continue; }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "") + "</li>"; continue; }
    if (line.trim() === "") { closeList(); continue; }
    closeList(); html += "<p>" + line + "</p>";
  }
  if (codeFence) closeCode();
  closeList();
  return html;
}

// 全屏 modal 查看长文（如日报 lastResult）。复用 login-overlay 的遮罩风格。
function showMarkdownModal(title, md) {
  const ov = h(`<div class="md-modal"><div class="md-card">
    <div class="md-head"><b>${esc(title)}</b><button class="btn-mini md-x">✕ 关闭</button></div>
    <div class="md-body">${md ? renderMarkdownLite(md) : '<p class="muted">（暂无内容）</p>'}</div>
  </div></div>`);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector(".md-x").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
}

/* ── askUser：agent 执行到一半停下来问人 ─────────────────────────
   两种来源：
     · ask_user 工具（kind=question）：agent 主动请教。像 CC 那样【内联在输入框上方】
       弹出选项，就在对话流里答，不打断视线。
     · bash 危险命令确认（kind=confirm）：用居中遮罩弹窗，阻塞感更强、更醒目。
   聊天面板不在场时，question 也退回居中弹窗（否则没地方放）。
   没答复 = 不同意：后端 3 分钟超时，这里只负责显示倒计时。 */
const askUIs = new Map(); // id → { el, close, setBusy }
let activeInlineAskId = "";

/** 该 ask 是否还有活的 DOM（面板重挂载后旧节点会脱离文档，需重建）。 */
function askAlive(id) {
  const m = askUIs.get(id);
  return !!(m && m.el && m.el.isConnected);
}

/** 多个 ask_user 可在同一 assistant 回合并行发出；输入区一次只展示一张，用左右键切换。 */
function syncInlineAskDeck(preferredId = "") {
  const host = document.getElementById("chatAsks");
  if (!host) { activeInlineAskId = ""; return; }
  const cards = [...host.querySelectorAll(".ask-inline[data-ask]")];
  host.closest(".chat-workbench")?.classList.toggle("ask-layer-open", cards.length > 0 && !state.chat.inspection);
  renderChatInspectionBar();
  if (!cards.length) { activeInlineAskId = ""; return; }
  const ids = cards.map((c) => c.dataset.ask);
  if (preferredId && ids.includes(preferredId)) activeInlineAskId = preferredId;
  if (!activeInlineAskId || !ids.includes(activeInlineAskId)) activeInlineAskId = ids[0];
  const activeAt = Math.max(0, ids.indexOf(activeInlineAskId));
  cards.forEach((card, i) => {
    const active = i === activeAt;
    card.hidden = !active;
    card.classList.toggle("is-active", active);
    const nav = card.querySelector(".ask-inline-nav");
    if (nav) nav.hidden = cards.length < 2;
    const count = card.querySelector(".ask-inline-count");
    if (count) count.textContent = `${i + 1} / ${cards.length}`;
  });
}

function moveInlineAsk(fromId, delta) {
  const host = document.getElementById("chatAsks");
  const ids = [...(host?.querySelectorAll(".ask-inline[data-ask]") || [])].map((c) => c.dataset.ask);
  if (ids.length < 2) return;
  const at = Math.max(0, ids.indexOf(fromId));
  syncInlineAskDeck(ids[(at + delta + ids.length) % ids.length]);
  const active = host.querySelector(`.ask-inline[data-ask="${CSS.escape(activeInlineAskId)}"]`);
  active?.querySelector(".ask-opt, .ask-other-input")?.focus();
}

async function answerAsk(id, answer) {
  const m = askUIs.get(id);
  if (m) m.setBusy(true);
  try {
    await api(`/api/asks/${encodeURIComponent(id)}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
  } catch (e) {
    // 常见于「来晚了」：提问已超时或已在别处答过。告知并关掉，别让人对着死框点。
    await harbourAlert(e.message || "答复失败", { title: "答复没有送达", tone: "warning" });
  } finally {
    closeAsk(id);
  }
}

function closeAsk(id) {
  const m = askUIs.get(id);
  if (!m) return;
  askUIs.delete(id);
  m.close();
}

/** 选项按钮 + 「其它」自由输入 —— 弹窗与内联气泡共用同一套结构。 */
function askBodyHtml(ask) {
  const opts = (ask.options || [])
    .map((o) => `<button type="button" class="ask-opt" data-val="${esc(o.value)}">
      <span class="ask-opt-label">${esc(o.label)}</span>
      ${o.hint ? `<span class="ask-opt-hint">${esc(o.hint)}</span>` : ""}
    </button>`)
    .join("");
  return `
    <p class="ask-q">${esc(ask.question)}</p>
    ${ask.detail ? `<pre class="md-code ask-detail">${esc(ask.detail)}</pre>` : ""}
    <div class="ask-opts">${opts}</div>
    <div class="ask-other">
      <input type="text" class="ask-other-input" placeholder="其它：直接写你的回复…" />
      <button type="button" class="btn-mini ask-other-send">发送</button>
    </div>
    <p class="ask-timer muted"></p>`;
}

/** 给已插入 DOM 的 ask 根节点接线（选项点击 / 自由文本 / 倒计时），返回 { setBusy, teardown }。 */
function wireAsk(root, ask, isConfirm) {
  const timerEl = root.querySelector(".ask-timer");
  const tick = () => {
    const left = Math.max(0, Math.round((new Date(ask.expiresAt).getTime() - Date.now()) / 1000));
    timerEl.textContent = left > 0
      ? (isConfirm ? `${left} 秒内未答复将按【拒绝】处理` : `${left} 秒内未回答，我就先跳过这个问题`)
      : (isConfirm ? "已超时，按拒绝处理" : "已超时，未收到你的回答");
    if (left <= 0) closeAsk(ask.id);
  };
  tick();
  const iv = setInterval(tick, 1000);
  root.querySelectorAll(".ask-opt").forEach((b) => b.addEventListener("click", () => answerAsk(ask.id, b.dataset.val)));
  const input = root.querySelector(".ask-other-input");
  const sendOther = () => { const v = input.value.trim(); if (v) answerAsk(ask.id, v); };
  root.querySelector(".ask-other-send").addEventListener("click", sendOther);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendOther(); } });
  const setBusy = (b) => root.querySelectorAll("button, input").forEach((el) => { el.disabled = b; });
  return { setBusy, teardown: () => clearInterval(iv) };
}

/** 顶层提问卡：悬浮在聊天工作区最上方。聊天面板不在场则返回 false，让调用方退回弹窗。 */
function showAskInline(ask) {
  const host = document.getElementById("chatAsks");
  if (!host) return false;
  if (askAlive(ask.id)) return true; // 已在显示，幂等
  const card = h(`<div class="ask-inline" data-ask="${esc(ask.id)}">
    <div class="ask-inline-head">
      ${avatarHtml("assistant", ask.agent)}<span class="ask-inline-dot"></span><b>${esc(ask.agent ? personaLabel(ask.agent) : "有个问题")}</b> 想请你定一下
      <span class="ask-inline-nav" aria-label="切换待回答问题" hidden>
        <button type="button" class="ask-inline-prev" title="上一个问题" aria-label="上一个问题">‹</button>
        <span class="ask-inline-count" aria-live="polite"></span>
        <button type="button" class="ask-inline-next" title="下一个问题" aria-label="下一个问题">›</button>
      </span>
    </div>
    <div class="ask-inline-body">${askBodyHtml(ask)}</div>
  </div>`);
  host.appendChild(card);
  const { setBusy, teardown } = wireAsk(card, ask, false);
  card.querySelector(".ask-inline-prev")?.addEventListener("click", () => moveInlineAsk(ask.id, -1));
  card.querySelector(".ask-inline-next")?.addEventListener("click", () => moveInlineAsk(ask.id, 1));
  askUIs.set(ask.id, { el: card, setBusy, close: () => { teardown(); card.remove(); syncInlineAskDeck(); } });
  // 新问题进入队尾，不抢走正在回答的卡；第一张则立即获得焦点。
  syncInlineAskDeck(activeInlineAskId || ask.id);
  if (activeInlineAskId === ask.id) {
    card.querySelector(".ask-opt")?.focus();
  }
  return true;
}

/** 居中遮罩弹窗：confirm 类（危险确认）或聊天面板不在场时用。 */
function showAskModal(ask) {
  if (askAlive(ask.id)) return;
  askUIs.delete(ask.id); // 清掉可能残留的脱离节点条目
  const isConfirm = ask.kind !== "question";
  const ov = h(`<div class="md-modal ask-modal${isConfirm ? " ask-confirm" : ""}"><div class="md-card form-card">
    <div class="md-head"><b>${isConfirm ? "◆ 需要你确认" : "◆ 有个问题"}</b><span class="ask-meta">${esc(ask.agent || "")}${ask.channel ? " · " + esc(ask.channel) : ""}</span></div>
    <div class="md-body">${askBodyHtml(ask)}</div>
  </div></div>`);
  const { setBusy, teardown } = wireAsk(ov, ask, isConfirm);
  // Esc 不等于拒绝也不等于同意——只是关掉弹窗，让后端自然超时（超时=拒绝）。
  const close = () => { teardown(); ov.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") closeAsk(ask.id); }
  document.addEventListener("keydown", onKey);
  askUIs.set(ask.id, { el: ov, setBusy, close });
  document.body.appendChild(ov);
  ov.querySelector(".ask-opt")?.focus();
}

/** WS 推来的 ask 事件（新提问 → 展示；已结算 → 收起，处理「在别处答了、这边还开着」）。 */
function handleAskEvent(msg) {
  if (msg.kind === "resolved") { closeAsk(msg.ask.id); return; }
  // question（ask_user 主动提问）优先悬浮在聊天区最上层；confirm（危险确认）或聊天不在场用弹窗。
  if (msg.ask.kind === "question" && showAskInline(msg.ask)) return;
  showAskModal(msg.ask);
}

/** 拉一次当前待答提问。ask 不进日志 ring，刷新/重连/切回聊天后靠这个补齐。 */
async function syncAsks() {
  try {
    const { asks } = await api("/api/asks");
    for (const a of asks || []) if (!askAlive(a.id)) handleAskEvent({ kind: "new", ask: a });
  } catch { /* 未登录或后端没起来：忽略 */ }
}

/* ── 文档双模式（渲染 / 原文）—— MEMORY 查看器与 AGENTS 编辑器共用 ──
   这些文件都是 markdown，默认给渲染后的样子（好读），一键切回原文（好改/好核对）。
   偏好存 localStorage，跨面板与刷新都保持。渲染走已有的 renderMarkdownLite。 */
const DOC_VIEW_KEY = "harbour-doc-view";
const docViewMode = () => (localStorage.getItem(DOC_VIEW_KEY) === "raw" ? "raw" : "render");

/** 生成一组切换胶囊（默认按当前偏好高亮）。id 供 wireDocToggle 定位。 */
function docToggleHtml(id, labels = {}) {
  const m = docViewMode();
  return `<div class="doc-toggle" id="${id}">
    <button type="button" class="chip${m === "render" ? " active" : ""}" data-doc-view="render">${esc(labels.render || "渲染")}</button>
    <button type="button" class="chip${m === "raw" ? " active" : ""}" data-doc-view="raw">${esc(labels.raw || "原文")}</button>
  </div>`;
}

/** 接线：点胶囊 → 存偏好 + 更新高亮 → 调 apply(mode) 做实际显隐。挂完立刻按当前偏好应用一次。 */
function wireDocToggle(id, apply) {
  const box = document.getElementById(id);
  if (!box) return;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-doc-view]");
    if (!btn) return;
    const mode = btn.dataset.docView;
    localStorage.setItem(DOC_VIEW_KEY, mode);
    box.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.docView === mode));
    apply(mode);
  });
  apply(docViewMode());
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), hh = Math.floor(m / 60);
  if (hh) return `${hh}h${m % 60}m`;
  if (m) return `${m}m${s % 60}s`;
  return `${s}s`;
}

/** Trace 汇总条专用的紧凑时长：00:08 / 02:15 / 1:02:15，等宽且切主题不跳布局。 */
function formatRunDuration(ms, running = false) {
  const raw = Number(ms);
  if (!Number.isFinite(raw) || raw < 0) return "";
  const total = Math.max(0, running ? Math.floor(raw / 1000) : Math.round(raw / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/* ── 主题（两层）─────────────────────────────────────────────────── */
const catOf = (catId) => THEME_CATEGORIES.find((c) => c.id === catId) || THEME_CATEGORIES[0];

const personaOfCat = (catId, personaId) => {
  const cat = catOf(catId);
  return cat.personas.find((p) => p.id === personaId) || cat.personas[0];
};
/** 某 agent 对应的主题角色皮肤（没有就返回 null）。用于「换老婆时整套皮肤跟着换」。 */
function themePersonaForAgent(catId, agentName) {
  return catOf(catId).personas.find((p) => p.agent && p.agent === agentName) || null;
}

function applyTheme(catId, personaId, variantId) {
  const cat = catOf(catId);
  const persona = personaOfCat(cat.id, personaId);
  const variant = persona.variants.find((v) => v.id === variantId) || persona.variants[0];
  document.body.dataset.themeCat = cat.id;          // 大类 → 结构/字体/背景
  document.body.dataset.themePersona = persona.id;  // 角色 → 该角色专属的结构点缀
  document.body.dataset.theme = variant.id;         // 变体 → 配色
  localStorage.setItem("harbour-theme-cat", cat.id);
  localStorage.setItem("harbour-theme-persona", persona.id);
  localStorage.setItem("harbour-theme", variant.id);
  window.harbourDesktop?.setCompanionAppearance?.({
    category: cat.id,
    persona: persona.id,
    theme: variant.id,
  }).catch(() => {});
  const fav = document.querySelector("link[rel=icon]");
  if (fav && FAVICONS[cat.id]) fav.href = FAVICONS[cat.id];
  setHero(variant.id);
  syncThemeSelectors();
  applyChatBg(); // 立绘水印随变体换图；premium 下 picker 由 CSS 隐藏
}

function applyDesktopAppearance(appearance) {
  if (!appearance || typeof appearance !== "object") return;
  document.body.dataset.chatStyle = ["flowing", "compact", "cards"].includes(appearance.chatStyle)
    ? appearance.chatStyle
    : "flowing";
  const font = appearance.font;
  document.body.dataset.desktopFont = ["system", "rounded", "serif", "mono"].includes(font) ? font : "system";
}

function fillPersonaSelect(sel, catId, currentPersona) {
  const cat = catOf(catId);
  sel.innerHTML = cat.personas.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  sel.value = cat.personas.some((p) => p.id === currentPersona) ? currentPersona : cat.personas[0].id;
  // 只有一个角色可选时（如 premium）没必要占位。
  sel.style.display = cat.personas.length > 1 ? "" : "none";
}

function fillVariantSelect(sel, catId, personaId, currentVariant) {
  const persona = personaOfCat(catId, personaId);
  sel.innerHTML = persona.variants.map((v) => `<option value="${v.id}">${v.label}</option>`).join("");
  sel.value = persona.variants.some((v) => v.id === currentVariant) ? currentVariant : persona.variants[0].id;
}

// 让页面上所有「大类/角色/变体」下拉(顶栏 + 设置页)都反映当前主题。
function syncThemeSelectors() {
  const catId = document.body.dataset.themeCat;
  const perId = document.body.dataset.themePersona;
  const varId = document.body.dataset.theme;
  document.querySelectorAll("[data-theme-cat-select]").forEach((sel) => { sel.value = catId; });
  document.querySelectorAll("[data-theme-persona-select]").forEach((sel) => fillPersonaSelect(sel, catId, perId));
  document.querySelectorAll("[data-theme-var-select]").forEach((sel) => fillVariantSelect(sel, catId, perId, varId));
}

// 绑定一组「大类 + 角色 + 变体」下拉。
function wireThemeTriple(catSel, perSel, varSel) {
  catSel.setAttribute("data-theme-cat-select", "");
  perSel.setAttribute("data-theme-persona-select", "");
  varSel.setAttribute("data-theme-var-select", "");
  catSel.innerHTML = THEME_CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
  catSel.addEventListener("change", () => {
    // 换大类：上一大类的角色/变体 id 在新大类里无效，需重挑。
    // 优先挑「与当前聊天角色对应」的皮肤，否则会出现「在跟 A 说话、界面却是 B 的皮肤」。
    const keep = themePersonaForAgent(catSel.value, state.chat.agent)?.id;
    fillPersonaSelect(perSel, catSel.value, keep);
    fillVariantSelect(varSel, catSel.value, perSel.value);
    applyTheme(catSel.value, perSel.value, varSel.value);
  });
  perSel.addEventListener("change", () => {
    fillVariantSelect(varSel, catSel.value, perSel.value);
    applyTheme(catSel.value, perSel.value, varSel.value);
    // 「角色」层不只是配色，是「现在这是谁的地盘」——聊天对象跟着一起换。
    const agent = personaOfCat(catSel.value, perSel.value).agent;
    if (agent && !_personaSyncing) void switchChatAgent(agent);
  });
  varSel.addEventListener("change", () => applyTheme(catSel.value, perSel.value, varSel.value));
}

const LEGACY_THEME = { "premium-linear": "premium-champagne", "premium-soft": "premium-tungsten", "premium-indigo": "premium-champagne" };
function initTheme() {
  wireThemeTriple($("#themeCat"), $("#themePersona"), $("#themeVariant"));
  let savedVar = localStorage.getItem("harbour-theme") || "anime-wisteria";
  savedVar = LEGACY_THEME[savedVar] || savedVar; // 旧变体 id 迁移到放映室新档
  const catId = localStorage.getItem("harbour-theme-cat") || "anime";
  // 角色层是后加的：老用户没存过这个键，按变体 id 反查归属，归不到就用该大类第一个角色。
  const savedPersona =
    localStorage.getItem("harbour-theme-persona") ||
    catOf(catId).personas.find((p) => p.variants.some((v) => v.id === savedVar))?.id ||
    catOf(catId).personas[0].id;
  applyTheme(catId, savedPersona, savedVar);
  window.harbourDesktop?.getCompanionState?.().then((value) => applyDesktopAppearance(value?.appearance)).catch(() => {});
  window.harbourDesktop?.onCompanionState?.((value) => applyDesktopAppearance(value?.appearance));
}

/* ── 导航 ─────────────────────────────────────────────────────────── */
function initNav() {
  const item = n => `<a class="nav-item" href="#${n.id}" data-route="${n.id}"><span class="ico" aria-hidden="true">${n.path ? `<svg viewBox="0 0 24 24"><path d="${n.path}"/></svg>` : n.ico}</span><span>${n.label}</span></a>`;
  $("#navPrimary").innerHTML = NAV.filter(n => n.primary).map(item).join("");
  $("#navSecondary").innerHTML = NAV.filter(n => !n.primary).map(item).join("");
  const more = $("#navMore");
  // Disclosure is local to this page visit, never a sticky startup preference.
  more.open = false;
  try { localStorage.removeItem("harbour-nav-more"); } catch { /* legacy preference only */ }
  $("#navBack").addEventListener("click", () => void navigatePageHistory(-1));
  $("#navForward").addEventListener("click", () => void navigatePageHistory(1));
  window.navigation?.addEventListener("currententrychange", syncPageHistory);
  window.addEventListener("keydown", event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) void navigatePageHistory(event.key === "ArrowLeft" ? -1 : 1);
  });
  window.addEventListener("hashchange", route);
}

let pageHistoryBusy = false, activePanelEntryKey = null, restoringPanelEntryKey = null;
function pageHistoryTarget(direction) {
  const navigation = window.navigation;
  if (!navigation?.currentEntry || typeof navigation.entries !== "function") return null;
  const entries = navigation.entries();
  const index = entries.findIndex(entry => entry.key === navigation.currentEntry.key);
  const entry = entries[index + direction];
  if (!entry?.url) return null;
  try {
    const url = new URL(entry.url), current = new URL(location.href);
    const hash = url.hash.slice(1) || "chat";
    const panel = hash.startsWith("calendar?") ? "calendar" : hash.startsWith("chat?") ? "chat" : hash;
    // Never send these in-app controls to an external site, another app path,
    // or a URL with a different auth/query context. Browser history stays native.
    return url.origin === current.origin && url.pathname === current.pathname && url.search === current.search && Object.hasOwn(PANELS, panel)
      ? entry : null;
  } catch { return null; }
}
function syncPageHistory() {
  for (const [id, direction] of [["#navBack", -1], ["#navForward", 1]]) {
    const button = $(id);
    if (button) button.disabled = pageHistoryBusy || routePending || !pageHistoryTarget(direction);
  }
}
async function navigatePageHistory(direction) {
  if (pageHistoryBusy || routePending) return;
  const target = pageHistoryTarget(direction), origin = window.navigation?.currentEntry?.key;
  if (!target) return;
  pageHistoryBusy = true; syncPageHistory();
  try {
    if (!await leaveEditors("page")) return;
    // A decision may take time; don't navigate from a different page on a late reply.
    if (routePending || window.navigation.currentEntry?.key !== origin) return;
    await window.navigation.traverseTo(target.key).finished;
  } catch (error) {
    if (error?.name !== "AbortError") toast("暂时无法切换页面，请重试", true);
  } finally { pageHistoryBusy = false; syncPageHistory(); }
}
async function restoreActivePanelHistory() {
  const navigation = window.navigation;
  // Native browser back/forward happens before the hash router asks to leave.
  // Restore the accepted entry rather than overwriting the rejected destination.
  if (activePanelEntryKey && navigation?.currentEntry?.key !== activePanelEntryKey &&
      navigation?.entries().some(entry => entry.key === activePanelEntryKey)) {
    restoringPanelEntryKey = activePanelEntryKey;
    try { await navigation.traverseTo(activePanelEntryKey).finished; return; }
    catch { restoringPanelEntryKey = null; /* entry may have been disposed */ }
  }
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${activePanelHash}`);
}
function setActiveNav(id) {
  document.querySelectorAll("#sidebar .nav-item").forEach(el => {
    const active = el.dataset.route === id;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
  const secondary = NAV.some(n => n.id === id && !n.primary), more = $("#navMore");
  more.classList.toggle("has-current", secondary);
}
// 全局导航做成悬浮抽屉：默认隐藏，hover 最左缘或点顶栏 ☰ 唤出；鼠标移开即自动收起，选完一项也收起。
function initNavDrawer() {
  const apply = wireDrawer({ shell: document.querySelector(".shell"), aside: $("#sidebar"), edge: $("#navEdge"), toggle: $("#navToggle"), state: navDrawer, openClass: "nav-open" });
  $("#sidebar").addEventListener("click", (e) => {
    if (e.target.closest(".nav-item")) { navDrawer.hover = false; navDrawer.pinned = false; apply(); }
  });
}

let activePanelHash = "", routePending = false, routeRendering = false, queuedPanelHash = null;
async function route() {
  // A rejected native traversal is being rolled back, not a second request to
  // leave the same dirty editor. hashchange can arrive after .finished settles.
  if (restoringPanelEntryKey && window.navigation?.currentEntry?.key === restoringPanelEntryKey &&
      (location.hash.slice(1) || "chat") === activePanelHash) {
    restoringPanelEntryKey = null; syncPageHistory(); return;
  }
  if (routePending) {
    if (routeRendering) queuedPanelHash = location.hash;
    return;
  }
  routePending = true;
  syncPageHistory();
  try {
    if (activePanelHash && !await leaveEditors("page")) {
      await restoreActivePanelHistory();
      routePending = false;
      syncPageHistory();
      return;
    }
  } catch (error) { routePending = false; syncPageHistory(); throw error; }
  const requested = location.hash.replace("#", "") || "chat";
  routeRendering = true;
  // 离开上一个面板：清掉它可能起的轮询计时器（dashboard 的实时刷新等）。
  if (state.panelTimer) { stopVisualTimer(state.panelTimer); state.panelTimer = null; }
  stopCoworkPolling();
  disposeMusicPanel?.(); disposeMusicPanel = null;
  disposeCalendarPanel?.(); disposeCalendarPanel = null;
  disposeSpacesPanel?.(); disposeSpacesPanel = null;
  disposeTownPanel?.(); disposeTownPanel = null;
  disposeCronPanel?.(); disposeCronPanel = null;
  disposeGoogleSettings?.(); disposeGoogleSettings = null;
  disposeChatMusic?.(); disposeChatMusic = null;
  window.HarbourChatHero?.unmount();
  disposeChatUnread?.(); disposeChatUnread = null;
  disposeChatIntake?.(); disposeChatIntake = null;
  disposeChatDrop?.(); disposeChatDrop = null;
  chatRunPicker?.destroy(); chatRunPicker = null;
  chatVoicePicker?.destroy(); chatVoicePicker = null;
  window.HarbourVoiceLibrary?.destroy();
  disposeChatComposerResize();
  disposeChatScrollBottom();
  closeChatSessionMenu();
  closeFilePreview(false);
  const id = requested.startsWith("calendar?") ? "calendar" : requested.startsWith("chat?") ? "chat" : requested;
  const panel = PANELS[id] || PANELS.chat;
  activePanelHash = panel.id === "calendar" || (panel.id === "chat" && requested.startsWith("chat?")) ? requested : panel.id;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${activePanelHash}`);
  activePanelEntryKey = window.navigation?.currentEntry?.key || null;
  setActiveNav(panel.id);
  document.body.dataset.panel = panel.id; // 供 CSS 按面板微调（如 anime 下密集面板收起立绘让出宽度）
  const content = $("#content");
  content.classList.remove("flush"); // 按新设计：全部面板走「有框卡片」布局，不再全出血
  content.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    await panel.render(content);
  } catch (e) {
    content.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`;
    window.HarbourStartupGate?.failed("data");
  } finally {
    routePending = false; routeRendering = false;
    syncPageHistory();
    const queued = queuedPanelHash; queuedPanelHash = null;
    if (queued && queued !== `#${activePanelHash}`) { history.replaceState(history.state, "", `${location.pathname}${location.search}${queued}`); void route(); }
    void flushDesktopConversation();
  }
}

let desktopConversationPending = null, desktopConversationOpening = false, desktopConversationRevision = 0;
function initDesktopConversationLinks() {
  window.harbourDesktop?.onOpenConversation?.(target => {
    if (!target || ![target.sessionId, target.agentName].every(value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) return;
    desktopConversationPending = { ...target, revision: ++desktopConversationRevision };
    void flushDesktopConversation();
  });
}

async function flushDesktopConversation() {
  if (!desktopConversationPending || desktopConversationOpening || routePending) return;
  const target = desktopConversationPending;
  const originPanel = activePanelHash, originNavigation = state.chat.detailRequestSeq;
  desktopConversationPending = null;
  desktopConversationOpening = true;
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(target.sessionId)}`);
    if (target.revision !== desktopConversationRevision) return;
    if (originPanel !== activePanelHash || originNavigation !== state.chat.detailRequestSeq) return;
    if (routePending) { desktopConversationPending = target; return; }
    if (session?.id !== target.sessionId || session.agentName !== target.agentName) throw new Error("通知的会话归属不匹配，未跳转");
    if (!/^chat(?:\?|$)/.test(activePanelHash)) {
      history.pushState(history.state, "", `${location.pathname}${location.search}#chat`);
      await route(); // Same save/discard/cancel guard as manual page navigation.
      if (!/^chat(?:\?|$)/.test(activePanelHash)) return;
    }
    if (target.revision !== desktopConversationRevision) return;
    // Both windows share Web history. Adopt the exact original session through
    // normal guards; never turn a channel mirror or Cowork target into Web chat.
    const editableWeb = session.channel === "web" && !session.readOnlyMirror && !String(session.key || "").startsWith("web:cowork:")
      && (!session.cowork || session.cowork.deviceId === "server");
    if (editableWeb && state.chat.mode !== "cowork" && !state.chat.running && !chatDraftBusy() && !state.chat.modelSaving && !state.chat.coworkSaving
      && !state.chat.switchingMode && !state.chat.switchingSession) {
      saveChatDraft();
      await switchChatAgent(session.agentName);
      if (target.revision !== desktopConversationRevision || state.chat.agent !== session.agentName) return;
      if (!state.chat.sessions.some(s => s.id === session.id)) state.chat.sessions.push({
        id: session.id, key: session.key, channel: session.channel, agentName: session.agentName, title: session.title,
      });
      await switchChatSession(session.id, true);
      if (state.chat.sessionId === session.id) applyPersonaVisuals();
    }
    else if (session.id === state.chat.sessionId) {
      closeChatInspection();
      if (!state.chat.running) { state.chat.messages = sessionChatMessages(session); renderChatMessages(); }
    }
    else await inspectChatSession(session.id, true, session);
    if (target.revision === desktopConversationRevision) {
      const stream = $("#chatStream");
      if (stream) stream.scrollTop = stream.scrollHeight;
    }
  } catch (error) {
    if (target.revision === desktopConversationRevision) toast(`无法打开通知会话：${error.message || "请重试"}`, true);
  } finally {
    desktopConversationOpening = false;
    if (desktopConversationPending) void flushDesktopConversation();
  }
}

/* ── 数字/图表小工具（纯 vanilla，无外部图表库）───────────────────── */
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function fmtCost(v) {
  if (v == null) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return "$" + v.toFixed(2);
}
function fmtPct(r) { return r == null ? "—" : Math.round(r * 100) + "%"; }
/* —— 成本「按量估算」——
   单价【不再写死在这里】：来自 GET /api/pricing（data/modelPricing.json），
   cron 每天 8:00 自动从 OpenRouter 刷新，手工钉住的条目不被覆盖。
   原来这张表硬编码在本文件里，而且只有 kimi 两条 + 一个 __default 兜底，
   任何没列出的模型都会【静默套用 kimi 单价】——接 Claude Opus 会差十倍还看不出来。

   查不到单价 = 未知，绝不套用任何默认值：宁可显示"未配单价"，
   也不给一个看起来像真的的错数字（用户 的选择，2026-07-22）。 */
const CUR_SYMBOL = { USD: "$", CNY: "¥", EUR: "€" };
const curSym = (c) => CUR_SYMBOL[c] || (c ? c + " " : "$");

/** 按 modelRef 找单价。用【干净的原始模型名】查，不能用带「（主后端）」后缀的显示名。 */
function priceForRef(modelRef) {
  const t = dashView.pricing;
  if (!t) return null;
  const name = dashView.modelRawNames[modelRef] || String(modelRef).replace(/\/default$/, "");
  const bare = name.replace(/^[^/]+\//, "").replace(/\[[^\]]+\]$/, "");
  return t.models[name] || t.models[bare] || null;
}

/** 把某币种金额换算成显示币种；汇率缺失返回 null（不猜）。 */
function toDisplayCur(amount, cur) {
  const t = dashView.pricing;
  if (!t) return cur === "USD" ? amount : null;
  if (cur === t.displayCurrency) return amount;
  const rate = t && t.fx ? t.fx[cur] : undefined;
  return typeof rate === "number" ? amount * rate : null;
}

/**
 * 一组按天桶里已经冻结的历史账本成本 → 当前显示币种。
 * 这里绝不再读取模型单价；计价表更新只能影响之后写入的新桶。
 */
function bookedCost(buckets, ledgerCurrency = "USD") {
  const raw = buckets.reduce((total, bucket) => total + (Number(bucket.cost) || 0), 0);
  return toDisplayCur(raw, ledgerCurrency);
}
function bookedUnpricedTokens(buckets) {
  return buckets.reduce((total, bucket) => total + (Number(bucket.unpricedTokens) || 0), 0);
}
function fmtMoney(v, cur) {
  cur = cur || "¥";
  if (v == null) return "—";
  if (v === 0) return cur + "0";
  if (v < 0.01) return "<" + cur + "0.01";
  if (v < 1000) return cur + v.toFixed(2);
  return cur + Math.round(v).toLocaleString();
}

// 水平堆叠条：segments = [{value, cls, label}]，按总量占满宽度。
function stackBar(segments, max) {
  const total = max || segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
  return `<div class="bar-track">${segments.map((s) =>
    `<span class="bar-seg ${s.cls || ""}" style="width:${((s.value || 0) / total * 100).toFixed(2)}%" title="${esc(s.label || "")}: ${fmtNum(s.value)}"></span>`
  ).join("")}</div>`;
}

// SVG 环形进度（缓存命中率等）：ratio 0..1，null → 空环。
function donut(ratio, label, sub) {
  const R = 46, C = 2 * Math.PI * R;
  const frac = ratio == null ? 0 : Math.max(0, Math.min(1, ratio));
  const dash = (frac * C).toFixed(1);
  return `<div class="donut">
    <svg viewBox="0 0 120 120" width="120" height="120">
      <circle cx="60" cy="60" r="${R}" class="donut-bg"/>
      <circle cx="60" cy="60" r="${R}" class="donut-fg" stroke-dasharray="${dash} ${(C - dash).toFixed(1)}" transform="rotate(-90 60 60)"/>
    </svg>
    <div class="donut-center"><div class="donut-v">${esc(label)}</div><div class="donut-s">${esc(sub || "")}</div></div>
  </div>`;
}

/* ── 面板们 ───────────────────────────────────────────────────────── */
const PANELS = {};
let disposeMusicPanel = null;
let disposeCalendarPanel = null;
let disposeSpacesPanel = null;
PANELS.spaces = { id: "spaces", async render(root) {
  disposeSpacesPanel = window.HarbourSpaces.mount(root, { api, esc, withToken, renderMarkdown: renderMarkdownLite, toast, openMediaViewer, closeMediaViewer });
  await disposeSpacesPanel.ready;
} };
let disposeTownPanel = null;
let disposeCronPanel = null;
let disposeChatMusic = null;
let disposeChatUnread = null;
let disposeChatIntake = null;
let disposeChatDrop = null;
let chatRunPicker = null;
let chatVoicePicker = null;
async function requestVoiceChoice(action, payload, signal) {
  if (action === "list") return api("/api/tts/voices");
  if (action === "select") return api("/api/tts/selection", { method: "POST", body: JSON.stringify(payload) });
  const token = authToken();
  const response = await fetch("/api/tts/test", { method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(token ? { "x-harbour-token": token } : {}) },
    body: JSON.stringify({ ...payload, text: "今天也一起出发吧。" }) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `HTTP ${response.status}`); }
  return response.blob();
}

function syncChatRunPicker() {
  if (!chatRunPicker) return;
  const chat = state.chat;
  chatRunPicker.update({ identity: `${chat.agent}:${chat.sessionId || 'new'}`,
    config: { modelRef: chat.model || '', reasoningEffort: chat.reasoningEffort || '', permissionMode: chat.permissionMode || '' },
    defaults: { modelRef: chat.effectiveModelRef || '', reasoningEffort: chat.agentDefaultReasoningEffort,
      permissionMode: chat.agentDefaultPermissionMode || chat.agents.find(a => a.name === chat.agent)?.permissionMode || 'dontAsk' },
    models: (chat.modelRows || []).map(m => ({ value: m.modelRef, label: m.modelLabel || m.modelName || m.model || m.modelRef,
      detail: m.connectionLabel || m.providerLabel || m.providerId || '', group: modelMaker(m.modelName),
      efforts: m.effortOptions || [], defaultEffort: effectiveChatDefaultEffort(m) })),
    locked: !!(chat.running || chat.intakeRunning || chat.modelSaving || chat.coworkSaving || chat.switchingMode || chat.switchingSession),
    readOnly: !!(chat.readOnlyMirror || chat.inspection),
  });
}
PANELS.music = { id: "music", render(root) { disposeMusicPanel = window.HarbourMusicUI.mount(root, { api, esc }); } };
PANELS.town = { id: "town", render(root) { disposeTownPanel = window.HarbourTownUI.mount(root); } };
PANELS.calendar = { id: "calendar", render(root) {
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  disposeCalendarPanel = window.HarbourCalendar.mount(root, { api, esc, timeZone: HarbourTime.getTimeZone(),
    initialDate: query.get("date"), initialEventId: query.get("event"), initialCalendarId: query.get("calendar"),
  });
} };

function agentGroupOf(agent) {
  if (agent.name.startsWith("main-")) return ["角色 / PERSONA", 0];
  const groups = {
    classify: ["编排 / ORCHESTRATION", 1],
    research: ["研究与工具 / RESEARCH", 2],
    writing: ["内容 / WRITING", 3],
    critical: ["执行与检查 / CRITICAL", 4],
    heartbeat: ["心跳 / HEARTBEAT", 5],
  };
  return groups[agent.taskType] || [`其它 / ${String(agent.taskType || "OTHER").toUpperCase()}`, 9];
}
function agentOptionsHtml(agents) {
  const grouped = new Map();
  for (const agent of agents) {
    const [label, order] = agentGroupOf(agent);
    if (!grouped.has(label)) grouped.set(label, { order, agents: [] });
    grouped.get(label).agents.push(agent);
  }
  return [...grouped.entries()].sort((a, b) => a[1].order - b[1].order).map(([label, group]) =>
    `<optgroup label="${esc(label)}">${group.agents.sort((a, b) => a.name.localeCompare(b.name)).map((a) =>
      `<option value="${esc(a.name)}">${esc(a.name)} · ${esc(a.taskType)}</option>`).join("")}</optgroup>`
  ).join("");
}

const PERMISSION_MODE_LABELS = {
  default: "DEFAULT",
  acceptEdits: "ACCEPT EDITS",
  bypassPermissions: "BYPASS ALL",
  plan: "PLAN",
  dontAsk: "DON'T ASK",
  auto: "AUTO",
};

function permissionModeOptionsHtml(agent) {
  const fallback = agent?.permissionMode || "dontAsk";
  return `
    <option value="" title="跟随当前 Agent；当前默认：${esc(PERMISSION_MODE_LABELS[fallback] || fallback)}">↳ ${esc(PERMISSION_MODE_LABELS[fallback] || fallback)}</option>
    <optgroup label="本会话覆盖 · SESSION OVERRIDE">
      <option value="dontAsk" title="不弹权限询问；未预先允许的操作直接拒绝">◇ DON'T ASK</option>
      <option value="plan" title="只规划；SDK 阻止产生副作用的工具执行">◎ PLAN</option>
      <option value="default" title="SDK 标准权限行为；危险操作请求确认">◆ DEFAULT</option>
      <option value="acceptEdits" title="自动接受文件编辑，其它危险操作仍按标准权限处理">✎ ACCEPT EDITS</option>
      <option value="auto" title="由 SDK 的模型分类器自动批准或拒绝权限请求">◉ AUTO</option>
      <option value="bypassPermissions" title="危险：绕过 SDK 权限检查；Harbour governance 护栏仍然生效">⚠ BYPASS ALL</option>
    </optgroup>`;
}

function syncChatPermissionDefault(agentName, effectiveMode = "") {
  const sel = $("#chatPermMode");
  if (!sel) return;
  const agent = state.chat.agents.find((a) => a.name === agentName);
  const follow = [...sel.options].find((o) => o.value === "");
  if (follow) {
    const mode = effectiveMode || agent?.permissionMode || "dontAsk";
    state.chat.agentDefaultPermissionMode = mode;
    follow.textContent = `↳ ${PERMISSION_MODE_LABELS[mode] || mode}`;
    follow.title = `跟随 ${agentName || "当前 Agent"}；当前默认：${PERMISSION_MODE_LABELS[mode] || mode}`;
  }
}

function permissionModeOverrideOptionsHtml(manifestMode) {
  const base = manifestMode || "dontAsk";
  return `
    <option value="">CLAUDE.md · ${esc(PERMISSION_MODE_LABELS[base] || base)}</option>
    <option value="dontAsk">◇ DON'T ASK</option>
    <option value="plan">◎ PLAN</option>
    <option value="default">◆ DEFAULT</option>
    <option value="acceptEdits">✎ ACCEPT EDITS</option>
    <option value="auto">◉ AUTO</option>
    <option value="bypassPermissions">⚠ BYPASS ALL</option>`;
}

function permissionModeManifestOptionsHtml(selected) {
  return Object.entries(PERMISSION_MODE_LABELS).map(([value, label]) =>
    `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`
  ).join("");
}

function groupedModelOptionsHtml(models, concise = false) {
  const grouped = new Map();
  for (const m of (models || [])) {
    const key = m.providerLabel || m.providerId || "其它连接";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(m);
  }
  return [...grouped.entries()].map(([provider, rows]) => {
    rows.sort((a, b) => modelFreshness(a.modelName, b.modelName));
    const labelOf = (m) => m.modelLabel || m.modelName || m.model || m.modelRef;
    const counts = new Map();
    for (const m of rows) counts.set(labelOf(m), (counts.get(labelOf(m)) || 0) + 1);
    return `<optgroup label="${esc(provider)}">${rows.map((m) => {
      const label = labelOf(m);
      const connection = m.connectionLabel && m.connectionLabel !== provider && (!concise || counts.get(label) > 1)
        ? ` · ${esc(m.connectionLabel)}` : "";
      return `<option value="${esc(m.modelRef)}">${!concise && m.capabilities?.includes("vision") ? "◉ " : ""}${esc(label)}${connection}</option>`;
    }).join("")}</optgroup>`;
  }).join("");
}

function agentRuntimeDefaultsHtml(agentDefault, models) {
  if (!agentDefault) return "";
  const manifestModel = models.find((m) => m.modelRef === agentDefault.manifestModelRef);
  const manifestLabel = HarbourAgentConfig.modelLabel(manifestModel || { modelRef: agentDefault.manifestModelRef });
  const currentRef = agentDefault.overrideModelRef;
  const missingModel = currentRef && !models.some(m => m.modelRef === currentRef);
  return `<section class="agent-runtime-defaults">
    <div class="ard-copy"><b>当前使用 <span class="ard-policy">自动保存</span></b><span>新任务使用这里的选择；单个会话的设置优先。</span></div>
    <label class="mc-field"><span>模型</span>
      <select class="inp" aria-label="当前使用的模型" data-agent-default-model="${esc(agentDefault.name)}">
        <option value="">跟随基础配置 · ${esc(manifestLabel)}</option>${missingModel ? `<option value="${esc(currentRef)}">当前配置 · ${esc(currentRef)}（不可用）</option>` : ""}${groupedModelOptionsHtml(models, true)}
      </select>
      <small data-agent-model-source>${agentDefault.overrideModelRef ? "已单独指定此 Agent 的模型" : "跟随基础配置与自动路由"}</small>
    </label>
    <label class="mc-field"><span>权限模式</span>
      <select class="inp" aria-label="当前使用的权限模式" data-agent-default-mode="${esc(agentDefault.name)}">
        <option value="">跟随基础配置 · ${esc(HarbourAgentConfig.modeLabel(agentDefault.manifestPermissionMode))}</option>
        ${["dontAsk", "plan", "default", "acceptEdits", "auto", "bypassPermissions"].map(value => `<option value="${value}">${esc(HarbourAgentConfig.modeLabel(value))} · ${value}</option>`).join("")}
      </select>
      <small data-agent-mode-source>${agentDefault.overridePermissionMode ? "已单独指定；仍遵守工具与目录权限" : "跟随基础配置；仍遵守工具与目录权限"}</small>
    </label>
    ${agentDefault.delegationConfigurable ? `<div class="agent-delegation-control">
      <div class="adc-copy"><b>允许其它 Agent 委派 <span data-agent-delegation-status></span></b>
        <span>暂停后隐藏能力目录并阻止新委派，保留原挂载。</span>
        <small>不影响已有任务、直接对话、定时任务与 Workflow 内部调用。</small>
      </div>
      <button type="button" class="agent-delegation-switch" role="switch" aria-label="允许其它 Agent 委派" aria-checked="true" data-agent-delegation="${esc(agentDefault.name)}"><span></span></button>
    </div>` : ""}
  </section>`;
}

function syncAgentDelegationControl(root, enabled) {
  const button = root.querySelector("[data-agent-delegation]");
  if (!button) return;
  button.setAttribute("aria-checked", String(enabled));
  button.title = enabled ? "点击暂停新委派" : "点击恢复原挂载的委派能力";
  const status = root.querySelector("[data-agent-delegation-status]");
  status.textContent = enabled ? "已启用" : "已暂停";
  status.dataset.paused = String(!enabled);
}

function wireAgentRuntimeDefaults(root, agentDefault, onSaved) {
  if (!agentDefault) return;
  syncAgentDelegationControl(root, agentDefault.delegationEnabled !== false);
  const delegationButton = root.querySelector("[data-agent-delegation]");
  delegationButton?.addEventListener("click", async () => {
    if (delegationButton.disabled) return;
    const enabled = delegationButton.getAttribute("aria-checked") !== "true";
    delegationButton.disabled = true;
    delegationButton.setAttribute("aria-busy", "true");
    try {
      const saved = await api(`/api/agents/${encodeURIComponent(agentDefault.name)}/delegation`, {
        method: "POST", body: JSON.stringify({ enabled }),
      });
      if (delegationButton.isConnected) syncAgentDelegationControl(root, saved.delegationEnabled);
      toast(`${agentDefault.name} ${saved.delegationEnabled ? "已恢复接受委派" : "已暂停新委派，已有任务不受影响"}`);
    } catch (error) {
      toast(error.message, true);
      // A lost reply does not prove the save failed. Query, never resend the toggle.
      try {
        const current = (await api("/api/agent-defaults")).agents?.find(entry => entry.name === agentDefault.name);
        if (current && delegationButton.isConnected) syncAgentDelegationControl(root, current.delegationEnabled !== false);
      } catch { /* Keep last confirmed state; allow an explicit user retry. */ }
    } finally {
      delegationButton.disabled = false;
      delegationButton.removeAttribute("aria-busy");
    }
  });
  const modelSel = root.querySelector("[data-agent-default-model]");
  const modeSel = root.querySelector("[data-agent-default-mode]");
  if (modelSel) {
    modelSel.value = agentDefault.overrideModelRef || "";
    modelSel.addEventListener("change", () => saveAgentRuntimeDefault(
      agentDefault.name,
      { modelRef: modelSel.value || null },
      onSaved
    ));
  }
  if (modeSel) {
    modeSel.value = agentDefault.overridePermissionMode || "";
    modeSel.addEventListener("change", () => saveAgentRuntimeDefault(
      agentDefault.name,
      { permissionMode: modeSel.value || null },
      onSaved
    ));
  }
}

async function saveAgentRuntimeDefault(agent, patch, onSaved) {
  try {
    await api("/api/agent-defaults", { method: "POST", body: JSON.stringify({ agent, ...patch }) });
    toast("Agent 运行默认已更新");
    if (onSaved) await onSaved();
  } catch (e) {
    toast(e.message, true);
    if (onSaved) await onSaved();
  }
}

// Local line icons; labels remain on their controls for keyboard/screen-reader use.
function chatComposerIcon(name) {
  const paths = {
    add: '<path d="M12 5v14M5 12h14"/>',
    agent: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
    skill: '<path d="m5 19 10-10m-8 8-2-2M15 3v4m-2-2h4m2 8v4m-2-2h4M5 5v4M3 7h4"/>',
    mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/>',
    send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.skill}</svg>`;
}

PANELS.chat = {
  id: "chat",
  async render(root) {
    const { agents } = await api("/api/agents");
    state.chat.agents = agents;
    await prepareChatWindow();
    // 首屏角色的优先级：
    //   ① 本次会话里已选的（面板间来回切时不该被重置）
    //   ② 主题角色层记住的（= 上次用的角色，存在 localStorage，跨刷新保持）
    //   ③ 服务端 .env 的 DEFAULT_AGENT（改了 .env 后 web 端也要跟着走）
    //   ④ 前端常量兜底
    let serverDefault = "";
    try { serverDefault = (await api("/api/state"))?.defaultAgent || ""; } catch { /* 用兜底 */ }
    const themeAgent = personaOfCat(
      document.body.dataset.themeCat || "premium",
      document.body.dataset.themePersona
    ).agent;
    const preferred =
      [state.chat.agent, themeAgent, serverDefault, DEFAULT_PERSONA]
        .find((n) => n && agents.some((a) => a.name === n)) || agents[0]?.name || "";
    state.chat.agent = preferred;
    state.chat.sessionKey = sessionKeyFor(preferred, state.chat.mode);
    syncDesktopPetQuick();
    root.innerHTML = `
      <div class="chat-layout chat-layout-2">
        <aside class="chat-sessions">
          <div class="chat-mode-tabs" role="tablist" aria-label="聊天工作模式">
            <button type="button" role="tab" data-chat-mode="main">MAIN CHAT</button>
            <button type="button" role="tab" data-chat-mode="cowork">COWORK</button>
          </div>
          <div class="chat-sessions-head">
            <span class="chat-sessions-title">会话</span>
            <div class="chat-session-create-actions">
              <button class="btn ghost icon" id="chatNewWindow" type="button" title="在新窗口开始对话 · 可同时运行独立任务" aria-label="在新窗口开始对话"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7-10 10M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg></button>
              <button class="btn ghost icon" id="chatNewSession" title="新建会话" aria-label="在当前页面新建会话">＋</button>
            </div>
          </div>
          <div class="source-filter-host" id="chatSourceTabs" aria-label="会话来源筛选"></div>
          <div class="chat-session-list" id="chatSessionList"><div class="empty">加载中…</div></div>
          <div class="chat-tools" role="group" aria-label="聊天辅助工具">
            <div id="chatMusic"></div>
            <a class="chat-tool-button chat-calendar-link" href="#calendar" aria-label="打开日历"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/></svg><span class="chat-tool-label">日历</span></a>
            <button class="chat-tool-button execution-shortcut" id="chatExecutionEnvironment" type="button" aria-label="执行环境"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4m-4-8 2 2-2 2m5 0h3"/></svg><span class="chat-tool-label">执行环境</span></button>
            <div id="chatHeroControls" hidden></div>
          </div>
        </aside>
        <section class="chat-workbench">
          <details class="cowork-disclosure" id="coworkDisclosure" hidden><summary><span class="execution-summary-label">执行环境</span><span id="coworkEnvironmentSummary">读取设备信息…</span><span class="execution-summary-action">展开</span></summary>
          <div class="cowork-bar" id="coworkBar" hidden>
            <div class="cowork-source"><span>来源</span><b id="coworkOrigin">此客户端</b><span aria-hidden="true">→</span></div>
            <label class="cowork-target"><span>执行设备</span><select class="inp" id="coworkTarget" data-hs-label="DEVICE" aria-label="Cowork 执行设备"></select></label>
            <label class="cowork-directory"><span>工作目录（可选）</span><input class="inp" id="coworkCwd" type="text" autocomplete="off" placeholder="留空使用目标设备默认目录"></label>
            <button class="btn ghost icon" id="coworkRefresh" type="button" title="刷新设备列表" aria-label="刷新设备列表">↻</button>
            <button class="btn ghost" id="coworkRename" type="button">重命名</button>
            <p class="cowork-status" id="coworkStatus" role="status"></p>
          </div></details>
          <div class="chat-stream-wrap">
            <div class="chat-rail" id="chatRail" aria-label="本会话提问导航 · 悬停预览 · 点击跳转"></div>
            <div class="chat-stream" id="chatStream"></div>
            <button type="button" class="chat-scroll-bottom" id="chatScrollBottom" aria-label="回到聊天底部" title="回到聊天底部" aria-controls="chatStream" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v15m-6-6 6 6 6-6"/></svg></button>
          </div>
          <div class="chat-compose">
            <div class="chat-drop-hint" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg><span>松开以添加图片或文件</span></div>
            <div class="chat-inspection-bar" id="chatInspectionBar" hidden role="status" aria-live="polite"></div>
            <div class="chat-input-status" id="chatInputStatus" aria-live="polite" hidden></div>
            <div class="chat-resize-handle" id="chatResizeHandle" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="chatInput" aria-label="调整消息输入框高度" title="上下拖动调整高度；双击恢复默认（↑↓调整，Home恢复）"><span aria-hidden="true"></span></div>
            <div class="chat-source-banner" id="chatSourceBanner" hidden></div>
            <div class="chat-asks" id="chatAsks"></div>
            <div class="chat-attachments" id="chatAttachments" style="display:none"></div>
            <div class="chat-speech-status" id="chatSpeechStatus" hidden></div>
            <div class="chat-goal-bar" id="chatGoalBar"></div>
            <div class="chat-plan-bar" id="chatPlan"></div>
            <div class="chat-checkpoint-bar" id="chatCheckpoint"></div>
            <div class="chat-compose-row">
              <textarea class="inp" id="chatInput" aria-label="消息" placeholder=""></textarea>
            </div>
            <div class="chat-toolbar">
              <button class="btn ghost icon chat-compose-icon" id="chatAttach" type="button" aria-label="添加附件" title="添加图片 / 视频 / 语音 / 文件（支持拖入或 Ctrl+V 粘贴）">${chatComposerIcon("add")}</button>
              <select class="chat-tool" id="chatAgent" data-hs-icon="agent" data-hs-label="AGENT" data-hs-menu-title="选择 Agent" aria-label="选择 Agent" title="选择 Agent">${agentOptionsHtml(agents)}</select>
              <select class="chat-tool" id="chatSkill" data-hs-icon="skill" data-hs-label="SKILL" data-hs-menu-title="选择 Skill" aria-label="选择 Skill" title="选择 Skill"><option value="">自动选择技能</option></select>
              <select id="chatModel" data-run-picker-native hidden aria-hidden="true" tabindex="-1"><option value="">自动模型</option></select>
              <select id="chatEffort" data-run-picker-native hidden aria-hidden="true" tabindex="-1"><option value="">模型默认</option></select>
              <select id="chatPermMode" data-run-picker-native hidden aria-hidden="true" tabindex="-1">${permissionModeOptionsHtml(agents.find((a) => a.name === preferred))}</select>
              <div id="chatRunPicker" aria-label="当前对话运行配置"></div>
              <span class="chat-run-lock" id="chatRunLock" hidden title="本轮运行期间 Agent、Skill、Model、Effort 与 Mode 保持不变">🔒 本轮配置已锁定</span>
              <span class="ctx-wrap" id="chatCtx" title="本会话上下文占用"></span>
              <div class="chat-compose-actions">
                <div id="chatInputMode"></div>
                <div id="chatVoicePicker"></div>
                <button class="btn ghost icon chat-compose-icon" id="chatMic" type="button" aria-label="录音" aria-pressed="false" title="录音（再点一次停止）">${chatComposerIcon("mic")}</button>
                <button class="btn primary chat-compose-icon" id="chatSend" type="button" aria-label="发送消息">${chatComposerIcon("send")}</button>
                <button class="btn ghost chat-stop-control chat-compose-icon" id="chatStop" type="button" title="停止当前任务，保留未处理消息" aria-label="停止当前任务" hidden>${chatComposerIcon("stop")}</button>
              </div>
            </div>
            <input type="file" id="chatFile" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.md,.json,.csv,.log,.zip" hidden>
          </div>
        </section>
        <aside class="file-preview" id="filePreview" hidden aria-label="修改文件 · 只读预览"></aside>
      </div>`;
    $("#chatAgent").value = preferred;
    // 兼容旧前端状态：旧 BYPASS 实际一直映射为 SDK dontAsk。
    if (state.chat.permissionMode === "bypass") state.chat.permissionMode = "dontAsk";
    $("#chatPermMode").value = state.chat.permissionMode || "";
    chatRunPicker?.destroy();
    chatRunPicker = new window.HarbourRunPicker({ host: $("#chatRunPicker"), anchorRegion: document.querySelector(".chat-toolbar"), onOpen: () => closeHarbourSelect(),
      onChange: (key, value) => ({ modelRef: setChatModel, reasoningEffort: setChatReasoningEffort, permissionMode: setChatPermissionMode })[key](value) });
    syncChatRunPicker();
    chatVoicePicker?.destroy();
    chatVoicePicker = new window.HarbourVoicePicker({ host: $("#chatVoicePicker"),
      getCompanionId: () => companionIdForAgent(state.chat.agent), request: requestVoiceChoice,
      onOpen: () => { closeHarbourSelect(); chatRunPicker?.close(); },
      onManage: () => { settingsSection = "voice"; voiceSettingsTab = "tts"; location.hash = "settings"; } });
    renderChatMessages();
    syncAsks(); // 切回聊天时把未答完的 ask_user 提问补回输入框上方
    renderChatPlan();
    renderChatCheckpoint();
    renderChatGoal();
    await fillChatSkills(preferred);
    await fillChatModels();
    // 载入本会话（web:default）的历史与会话列表，让对话有「记性」且可切换。
    await loadChatSessions();
    root.querySelectorAll("[data-chat-mode]").forEach((button) => button.addEventListener("click", () => switchChatMode(button.dataset.chatMode)));
    $("#coworkTarget").addEventListener("change", () => saveCoworkBinding({ deviceId: $("#coworkTarget").value }));
    $("#coworkCwd").addEventListener("change", () => saveCoworkBinding({ deviceId: state.chat.cowork?.deviceId, cwd: $("#coworkCwd").value }));
    $("#coworkRefresh").addEventListener("click", loadCoworkDevices);
    $("#coworkRename").addEventListener("click", () => renameCoworkDevice(state.chat.cowork?.deviceId));
    $("#chatExecutionEnvironment").addEventListener("click", () => { settingsSection = "devices"; location.hash = "settings"; });
    // Main gets a one-time snapshot, not another background polling loop.
    if (state.chat.mode !== "cowork") void loadCoworkDevices();
    void loadCoworkOrigin();
    syncCoworkPolling();
    $("#chatNewSession").addEventListener("click", newChatSession);
    $("#chatNewWindow").addEventListener("click", () => openChatWindow());
    $("#chatAgent").addEventListener("change", () => switchChatAgent($("#chatAgent").value));
    $("#chatSkill").addEventListener("change", () => {
      if (state.chat.running) {
        $("#chatSkill").value = state.chat.skill || "";
        return toast("本轮运行中 Skill 已锁定；请先停止再切换。", true);
      }
      state.chat.skill = $("#chatSkill").value;
    });
    $("#chatModel").addEventListener("change", () => setChatModel($("#chatModel").value));
    $("#chatEffort").addEventListener("change", () => setChatReasoningEffort($("#chatEffort").value));
    $("#chatPermMode").addEventListener("change", () => setChatPermissionMode($("#chatPermMode").value));
    $("#chatSend").addEventListener("click", () => executeChat());
    $("#chatSend").title = "点击按所选模式发送 · Enter 排队 · Ctrl / ⌘ + Enter 补充当前任务 · Shift + Enter 换行";
    $("#chatStop").addEventListener("click", requestChatStop);
    disposeChatIntake = window.HarbourChatIntake?.mount({ api, session: () => state.chat.inspection ? null : state.chat.sessionId,
      localRunning: () => state.chat.running, reload: id => loadConversationMessages(id), toast,
      mediaUrl: withToken, canEdit: canEditQueuedMessage, restoreDraft: restoreQueuedMessage,
      changed: busy => { state.chat.intakeRunning = busy || Object.values(state.chat.channelRuns || {}).some(run => run.sessionId === state.chat.sessionId); setChatSendMode(state.chat.running); syncChatControlLocks(); } });
    let chatComposing = false;
    $("#chatInput").addEventListener("compositionstart", () => { chatComposing = true; });
    $("#chatInput").addEventListener("compositionend", () => { chatComposing = false; });
    $("#chatInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.altKey || chatComposing || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!e.repeat) void executeChat(e.ctrlKey || e.metaKey ? "steer" : "queue");
    });
    // 多模态：附件选择 + 录音
    $("#chatAttach").addEventListener("click", () => $("#chatFile").click());
    $("#chatFile").addEventListener("change", (e) => handleFilesPicked([...e.target.files]).then(() => { e.target.value = ""; }));
    document.querySelector(".chat-compose")?.addEventListener("paste", handleChatPaste);
    disposeChatDrop = window.HarbourChatDrop?.mount({
      composer: document.querySelector(".chat-compose"), input: $("#chatInput"), filesFromTransfer: chatClipboardFiles,
      imageFromElement: target => {
        const image = copyableChatImage(target);
        return image ? { src: chatImageOriginalUrl(image), name: image.alt || "" } : null;
      },
      blockedReason: chatAttachmentBlockedReason, onFiles: handleFilesPicked, onImage: handleChatImageDrop, toast,
    });
    $("#chatMic").addEventListener("click", toggleRecording);
    renderChatAttachments();
    syncChatControlLocks();
    installChatComposerResize();
    installChatScrollBottom();
    disposeChatUnread = window.HarbourChatUnread?.mount($('#chatStream'), {
      api, onChange: updateSessionUnreadIndicators,
      current: () => {
        const inspection = state.chat.inspection;
        if (inspection) return !inspection.loading && !inspection.error ? inspection.session : null;
        return state.chat.displayedReply?.id === state.chat.sessionId ? state.chat.displayedReply : null;
      },
    });
    disposeChatMusic = window.HarbourChatMusic?.mount($('#chatMusic'), { api, discuss: text => {
      const input = $('#chatInput');
      if (!input || input.disabled || state.chat.readOnlyMirror) return false;
      input.value = [input.value, text].filter(Boolean).join('\n\n');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
      return true;
    } });
    window.HarbourChatHero?.mount();
    // 聊天背景切换（纸/方格/星屑/立绘 + 上传自定义）—— anime 大类可见，localStorage 记忆
    document.querySelectorAll("#chatBgPicker .bgp-btn[data-bg]").forEach((b) =>
      b.addEventListener("click", () => { localStorage.setItem(CHAT_BG_KEY, b.dataset.bg); applyChatBg(); }));
    const bgUp = $("#chatBgUpload"); if (bgUp) bgUp.addEventListener("change", (e) => { if (e.target.files[0]) processChatBgImage(e.target.files[0]); e.target.value = ""; });
    const bgReset = $("#chatBgReset"); if (bgReset) bgReset.addEventListener("click", () => { localStorage.removeItem(CHAT_BG_IMG_KEY); localStorage.setItem(CHAT_BG_KEY, "paper"); applyChatBg(); toast("已清除自定义背景"); });
    applyChatBg();
    window.HarbourStartupGate?.mark("ui");
  },
};

// Purely local presentation state: survives panel switches, never enters a session/API/storage.
let chatComposerHeight = null;
let disposeChatComposerResize = () => {};
let disposeChatScrollBottom = () => {};

// Local navigation only: observing the stream never scrolls it or enters a run.
// Observe layout/content changes too, because media can load after the last render.
function installChatScrollBottom() {
  disposeChatScrollBottom();
  const stream = document.getElementById("chatStream");
  const button = document.getElementById("chatScrollBottom");
  if (!stream || !button) return;
  const listeners = new AbortController();
  let frame = 0, disposed = false;
  const update = () => {
    frame = 0;
    if (disposed || !stream.isConnected || !button.isConnected) return;
    const distance = stream.scrollHeight - stream.clientHeight - Math.max(0, stream.scrollTop);
    button.hidden = stream.clientHeight <= 0 || !stream.querySelector(".chat-msg") || distance <= 8;
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  };
  stream.addEventListener("scroll", schedule, { passive: true, signal: listeners.signal });
  for (const type of ["load", "error", "loadedmetadata", "toggle"]) {
    stream.addEventListener(type, schedule, { capture: true, signal: listeners.signal });
  }
  window.addEventListener("resize", schedule, { passive: true, signal: listeners.signal });
  button.addEventListener("click", () => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    stream.scrollTo({ top: stream.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
    schedule();
  }, { signal: listeners.signal });
  const resizeObserver = window.ResizeObserver ? new ResizeObserver(schedule) : null;
  const observed = new Set();
  const observeMessages = () => {
    if (!resizeObserver) return;
    for (const element of observed) {
      if (element.parentElement !== stream) { resizeObserver.unobserve(element); observed.delete(element); }
    }
    for (const element of stream.children) {
      if (!observed.has(element)) { resizeObserver.observe(element); observed.add(element); }
    }
  };
  resizeObserver?.observe(stream);
  observeMessages();
  const mutationObserver = window.MutationObserver ? new MutationObserver((records) => {
    if (records.some(record => record.type === "childList" && record.target === stream)) observeMessages();
    schedule();
  }) : null;
  mutationObserver?.observe(stream, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
  update();
  disposeChatScrollBottom = () => {
    disposed = true;
    listeners.abort();
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    observed.clear();
    if (frame) cancelAnimationFrame(frame);
    button.hidden = true;
    disposeChatScrollBottom = () => {};
  };
}

function installChatComposerResize() {
  disposeChatComposerResize();
  const input = document.getElementById("chatInput");
  const handle = document.getElementById("chatResizeHandle");
  const composer = input?.closest(".chat-compose");
  const workbench = composer?.closest(".chat-workbench");
  if (!input || !handle || !workbench) return;
  const layout = workbench.closest?.(".chat-layout");
  input.style.removeProperty("height");
  input.style.removeProperty("max-height");
  const minHeight = 52;
  const defaultHeight = Math.max(minHeight, input.getBoundingClientRect().height);
  const viewport = window.visualViewport;
  const listeners = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal: listeners.signal });
  let drag = null, frame = 0, disposed = false, minimumWorkbench = 0;
  const marginHeight = (element) => {
    const style = getComputedStyle(element);
    return (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  };
  const maxHeight = () => {
    // Account for wrapped toolbars, attachments, GOAL/checkpoint and Cowork controls.
    let occupied = composer.getBoundingClientRect().height - input.getBoundingClientRect().height + marginHeight(composer);
    for (const child of workbench.children) {
      if (child !== composer && !child.classList.contains("chat-stream-wrap")) {
        occupied += child.getBoundingClientRect().height + marginHeight(child);
      }
    }
    // Stacked narrow layouts already scroll the page. Grow their bounded row
    // only for fixed controls, never for the full conversation's content.
    const minimum = Math.ceil(occupied + minHeight + 120 + Math.max(0, workbench.getBoundingClientRect().height - workbench.clientHeight));
    if (layout && minimum !== minimumWorkbench) {
      minimumWorkbench = minimum;
      layout.style.setProperty("--chat-workbench-min-height", `${minimum}px`);
    }
    return Math.max(minHeight, Math.floor(Math.min(560, (viewport?.height || window.innerHeight) * .6, workbench.clientHeight - occupied - 120)));
  };
  const apply = () => {
    if (disposed || !input.isConnected) return;
    const max = maxHeight();
    const height = Math.round(Math.max(minHeight, Math.min(max, chatComposerHeight ?? defaultHeight)));
    input.style.maxHeight = `${max}px`;
    input.style.height = `${height}px`;
    handle.setAttribute("aria-valuemin", String(minHeight));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(height));
    handle.setAttribute("aria-valuetext", `${height} 像素`);
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
  };
  const setHeight = (height) => {
    chatComposerHeight = Math.max(minHeight, Math.min(maxHeight(), height));
    apply();
  };
  const finish = (event) => {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
    const pointerId = drag.pointerId;
    drag = null;
    composer.classList.remove("is-resizing");
    document.body.classList.remove("chat-composer-resizing");
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  };
  const reset = () => { finish(); chatComposerHeight = null; apply(); };
  on(handle, "pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, y: event.clientY, height: input.getBoundingClientRect().height };
    composer.classList.add("is-resizing");
    document.body.classList.add("chat-composer-resizing");
    // Window listeners still finish the gesture if capture is unavailable.
    try { handle.setPointerCapture(event.pointerId); } catch { /* detached or synthetic pointer */ }
  });
  on(window, "pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) return finish(event);
    event.preventDefault();
    setHeight(drag.height + drag.y - event.clientY);
  });
  on(window, "pointerup", finish);
  on(window, "pointercancel", finish);
  on(handle, "lostpointercapture", finish);
  on(window, "blur", () => finish());
  on(handle, "dblclick", reset);
  on(handle, "keydown", (event) => {
    if (event.key === "Home" || event.key === "Enter") { event.preventDefault(); reset(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setHeight(input.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24));
    } else if (event.key === "Escape" && drag) { event.preventDefault(); finish(); }
  });
  on(window, "resize", schedule);
  if (viewport) on(viewport, "resize", schedule);
  const observer = window.ResizeObserver ? new ResizeObserver(schedule) : null;
  observer?.observe(workbench);
  observer?.observe(composer);
  // Dynamic siblings (e.g. the activity banner) can shrink only the message
  // stream while the workbench and composer boxes stay unchanged.
  const stream = [...workbench.children].find(child => child.classList.contains("chat-stream-wrap"));
  if (stream) observer?.observe(stream);
  apply();
  disposeChatComposerResize = () => {
    disposed = true;
    finish();
    listeners.abort();
    observer?.disconnect();
    layout?.style.removeProperty("--chat-workbench-min-height");
    if (frame) cancelAnimationFrame(frame);
    disposeChatComposerResize = () => {};
  };
}

/* ── 跨轮会话（session）：列表 / 新开 / 切换 / 载入历史 ──────────────── */

const SESSION_SOURCE_FILTERS = ["web", "town", "cowork", "discord", "qq", "wecom", "cron"];
const SESSION_SOURCE_LABELS = {
  all: "全部来源",
  web: "Web · Main Chat",
  town: "小镇",
  cowork: "Cowork",
  discord: "Discord",
  qq: "QQ",
  wecom: "微信",
  cron: "定时任务",
  unknown: "其他来源",
};

function sessionApp(s) { return s?.source?.app || s?.channel || "unknown"; }
// 仅用于展示/筛选。Town 与 Cowork 仍是 Web 会话；不改变 channel、身份或执行目标。
function sessionSourceKind(s) {
  const app = sessionApp(s);
  if (app !== "web") return app;
  const key = String(s?.key || "");
  if (key.startsWith("web:town:")) return "town";
  if (key.startsWith("web:cowork:")) return "cowork";
  return app;
}
function sessionsInFilter(list, filter) {
  return filter === "all" ? list : list.filter((s) => sessionSourceKind(s) === filter);
}
function sourceBadgeText(s) {
  const kind = sessionSourceKind(s);
  return ({ discord: "DC", qq: "QQ", wecom: "微信", web: "Web", town: "小镇", cowork: "协作", cron: "定时", unknown: "其他" })[kind] || kind.toUpperCase();
}
function sourceWhere(s) {
  const kind = sessionSourceKind(s);
  const location = kind === "town" ? "Harbour 小镇" : kind === "cowork" ? "Cowork" : s?.source?.locationLabel || (kind === "web" ? "Main Chat" : "未知来源");
  return s?.source?.actorRole === "other" && s?.source?.authorName
    ? `${location} · ${s.source.authorName}`
    : location;
}
function sourceAccount(s) { return s?.source?.accountLabel || ""; }
function userRoleLabel(message, session) {
  const actor = message?.actor;
  if (actor?.role === "owner") return "用户";
  if (actor?.role === "other") return actor.displayName || "外部用户";
  if (session?.source?.actorRole === "other") return session.source.authorName || "外部用户";
  return "用户"; // 旧会话没有 actor；只做兼容显示，不参与后端权限判断。
}
function sourceFilterOptions(list, active) {
  const counts = new Map();
  for (const session of list || []) {
    const app = sessionSourceKind(session);
    counts.set(app, (counts.get(app) || 0) + 1);
  }
  const discovered = [...counts.keys()].filter((id) => !SESSION_SOURCE_FILTERS.includes(id)).sort();
  const ids = [...SESSION_SOURCE_FILTERS, ...discovered].filter((id) => counts.has(id) || id === active);
  return [
    { id: "all", label: SESSION_SOURCE_LABELS.all, count: (list || []).length },
    ...ids.map((id) => ({ id, label: SESSION_SOURCE_LABELS[id] || id.toUpperCase(), count: counts.get(id) || 0 })),
  ];
}
function sourceFilterMark(id) {
  if (id === "all") return `<span class="source-filter-all">◈</span>`;
  return `<span class="source-badge source-${esc(id)}">${esc(sourceBadgeText({ source: { app: id } }))}</span>`;
}
function sourceFilterHtml(list, active) {
  const options = sourceFilterOptions(list, active);
  const selected = options.find((f) => f.id === active) || options[0];
  return `<div class="source-filter">
    <button type="button" class="source-filter-trigger" aria-haspopup="listbox" aria-expanded="false">
      ${sourceFilterMark(selected.id)}<span class="source-filter-current">${esc(selected.label)}</span>
      <span class="source-filter-total">${selected.count}</span><span class="source-filter-chevron">⌄</span>
    </button>
    <div class="source-filter-menu" role="listbox" hidden>
      ${options.map((f) => `<button type="button" class="source-filter-option${f.id === selected.id ? " selected" : ""}" role="option" aria-selected="${f.id === selected.id}" data-source-filter="${esc(f.id)}">
        ${sourceFilterMark(f.id)}<span>${esc(f.label)}</span><small>${f.count}</small><i>✓</i>
      </button>`).join("")}
    </div>
  </div>`;
}
function wireSourceFilter(host, list, active, onSelect) {
  if (!host) return;
  host.innerHTML = sourceFilterHtml(list, active);
  const trigger = host.querySelector(".source-filter-trigger");
  const menu = host.querySelector(".source-filter-menu");
  const close = () => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  trigger.addEventListener("click", () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) menu.querySelector(".selected")?.focus();
  });
  host.addEventListener("focusout", () => window.setTimeout(() => {
    if (!host.contains(document.activeElement)) close();
  }, 0));
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { close(); trigger.focus(); }
  });
  menu.querySelectorAll("[data-source-filter]").forEach((option) => option.addEventListener("click", () => {
    close();
    onSelect(option.dataset.sourceFilter);
  }));
}
function renderChatSourceTabs() {
  const host = $("#chatSourceTabs");
  if (!host) return;
  host.hidden = state.chat.mode === "cowork";
  wireSourceFilter(host, state.chat.sessions || [], state.chat.sourceFilter, (filter) => {
    state.chat.sourceFilter = filter;
    renderChatSourceTabs();
    renderSessionList();
  });
}

/** 外部渠道只做实时镜像：能看完整上下文，但不会制造“Web 回了、Discord 没收到”的隐形分叉。 */
function syncChatSourceMode(session) {
  const mirror = !!session && (session.readOnlyMirror || session.channel !== "web");
  state.chat.readOnlyMirror = mirror;
  state.chat.selectedSessionKey = session?.key || "";
  const banner = $("#chatSourceBanner");
  if (banner) {
    banner.hidden = !mirror;
    banner.innerHTML = mirror
      ? `<span class="source-badge source-${esc(sessionSourceKind(session))}">${esc(sourceBadgeText(session))}</span><b>${esc(sourceAccount(session) || sourceBadgeText(session))}</b><span>${esc(sourceWhere(session))}</span><em>实时镜像 · Web 端只读</em>`
      : "";
  }
  ["#chatInput", "#chatAttach", "#chatMic", "#chatGoal"].forEach((sel) => {
    const el = $(sel); if (el) el.disabled = mirror;
  });
  syncChatControlLocks();
  const inp = $("#chatInput");
  if (inp) {
    inp.placeholder = "";
    if (mirror) inp.setAttribute("aria-describedby", "chatSourceBanner");
    else inp.removeAttribute("aria-describedby");
  }
}

const CHAT_RUN_LOCK_CONTROLS = ["chatAgent", "chatSkill", "chatModel", "chatEffort", "chatPermMode", "coworkTarget", "coworkCwd", "coworkRename"];

/**
 * 一次 run 的执行配置必须是原子的：开始后锁定，正常完成、失败或停止收尾后解锁。
 * readOnlyMirror 仍允许换 Agent 离开镜像，但禁止在镜像会话里改 Skill/Model/Effort/Mode。
 */
function syncChatControlLocks() {
  const running = !!(state.chat.running || state.chat.intakeRunning);
  const changing = !!(state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession);
  for (const id of CHAT_RUN_LOCK_CONTROLS) {
    const control = document.getElementById(id);
    if (!control) continue;
    const mirrorLocked = state.chat.readOnlyMirror && id !== "chatAgent";
    control.disabled = running || changing || mirrorLocked;
  }
  // 顶栏/设置中的角色皮肤也会触发 switchChatAgent，运行中一并禁用这条旁路。
  document.querySelectorAll("[data-theme-persona-select]").forEach((control) => {
    control.disabled = running || changing;
  });
  const hint = $("#chatRunLock");
  if (hint) hint.hidden = !running;
  const composer = document.querySelector(".chat-compose");
  composer?.classList.toggle("is-run-locked", running);
  const goal = $("#chatGoal");
  if (goal) goal.disabled = running || changing || state.chat.readOnlyMirror;
  const send = $("#chatSend");
  if (send && !running) send.disabled = changing || state.chat.readOnlyMirror;
  if (running && openHarbourSelect && CHAT_RUN_LOCK_CONTROLS.includes(openHarbourSelect.select?.id)) {
    closeHarbourSelect(openHarbourSelect);
  }
  renderCoworkBar();
  renderChatInspectionBar();
  syncChatRunPicker();
}

// 通知的只读浏览游标与执行会话分开；普通侧栏切换另走独立运行状态的交接。
function viewedChatSessionId() {
  return state.chat.inspection?.id || state.chat.sessionId;
}

function viewedChatMessages() {
  const inspection = state.chat.inspection;
  if (!inspection) return state.chat.messages;
  return [...(inspection.messages || []), ...channelRunMessages(inspection.id)];
}

function renderChatInspectionBar() {
  const inspection = state.chat.inspection;
  const host = $("#chatInspectionBar");
  const composer = document.querySelector(".chat-compose");
  composer?.classList.toggle("is-inspecting", !!inspection);
  document.querySelector(".chat-workbench")?.classList.toggle("is-inspecting", !!inspection);
  // CSS 隐藏之外也锁住键盘/程序触发的原会话输入，避免误发到后台会话。
  if (composer) {
    for (const child of composer.children) {
      if (child !== host) child.inert = !!inspection;
    }
  }
  if (!host) return;
  host.hidden = !inspection;
  if (!inspection) { host.innerHTML = ""; return; }
  const original = state.chat.sessions.find((session) => session.id === state.chat.sessionId);
  const title = inspection.session?.title || inspection.title || "会话";
  const waiting = !!document.querySelector("#chatAsks [data-ask]");
  const progress = state.chat.running
    ? (state.chat.stopping ? "正在停止并保存" : waiting ? "等待你回答" : "后台运行中")
    : "本轮已结束";
  const mayEnter = !state.chat.running && !state.chat.switchingSession && !!inspection.session;
  host.innerHTML = `<div class="chat-inspection-copy"><span class="chat-inspection-label">只读浏览</span><b>${esc(title)}</b><span>${esc(original?.title || "原会话")} · ${progress}。切换查看不会中断任务。</span></div>
    <div class="chat-inspection-actions">
      <button type="button" class="btn ghost" data-inspection-return>${state.chat.running ? "返回任务" : "返回结果"}</button>
      <button type="button" class="btn ghost" data-inspection-refresh ${inspection.loading ? "disabled" : ""}>刷新</button>
      <button type="button" class="btn ghost" data-inspection-window ${inspection.session ? '' : 'disabled'}>在新窗口打开 ↗</button>
      <button type="button" class="btn primary" data-inspection-enter ${mayEnter ? "" : "disabled"}>${inspection.session?.channel === "web" ? "在此对话" : "进入镜像"}</button>
    </div>`;
  host.querySelector("[data-inspection-return]").onclick = closeChatInspection;
  host.querySelector("[data-inspection-refresh]").onclick = () => inspectChatSession(inspection.id, true);
  host.querySelector("[data-inspection-window]").onclick = () => openChatWindow(inspection.id);
  host.querySelector("[data-inspection-enter]").onclick = async () => {
    const target = inspection.session;
    if (!target || state.chat.running) return;
    if (target.agentName !== state.chat.agent) {
      saveChatDraft();
      await switchChatAgent(target.agentName);
      if (state.chat.agent !== target.agentName) return;
    }
    if (!state.chat.sessions.some(session => session.id === target.id)) state.chat.sessions.push(target);
    await switchChatSession(target.id, true);
  };
}

function closeChatInspection() {
  if (!state.chat.inspection) return;
  ++state.chat.detailRequestSeq; // 也取消尚未返回的“在此对话”请求的 UI 提交。
  state.chat.switchingSession = false;
  const scrollTop = state.chat.inspection.originScrollTop;
  state.chat.inspection = null;
  syncChatControlLocks();
  setChatSendMode(state.chat.running);
  renderSessionList();
  renderChatMessages();
  const stream = $("#chatStream");
  if (stream && Number.isFinite(scrollTop)) stream.scrollTop = scrollTop;
  syncInlineAskDeck();
}

async function inspectChatSession(id, refresh = false, notificationSession = null) {
  const previous = state.chat.inspection;
  const summary = notificationSession || (previous?.id === id ? previous.summary : null)
    || state.chat.sessions.find((session) => session.id === id);
  if (!summary) return toast("会话已不存在，请刷新列表", true);
  if (!refresh && previous?.id === id) return;
  ++state.chat.detailRequestSeq; // 旧的普通切换请求也不能盖过用户最新的浏览意图。
  state.chat.switchingSession = false;
  const inspection = {
    id, summary, title: summary.title, loading: true, error: "", session: previous?.id === id ? previous.session : null,
    messages: previous?.id === id ? previous.messages : [],
    originScrollTop: previous?.originScrollTop ?? $("#chatStream")?.scrollTop ?? 0,
  };
  state.chat.inspection = inspection;
  syncChatControlLocks();
  renderSessionList();
  renderChatMessages();
  try {
    const { session } = notificationSession ? { session: notificationSession } : await api(`/api/conversations/${encodeURIComponent(id)}`);
    // 对象身份也是请求序号：B→C→B、关闭后重开、刷新并发，都只接纳最新一次。
    if (state.chat.inspection !== inspection) return;
    if (session.id !== id || session.agentName !== (summary.agentName || state.chat.agent) || session.key !== summary.key) {
      throw new Error("会话归属不匹配，已阻止显示");
    }
    inspection.session = session;
    inspection.messages = sessionChatMessages(session);
    window.HarbourChatUnread?.observe(session);
  } catch (error) {
    if (state.chat.inspection !== inspection) return;
    inspection.error = error.message || "读取失败，请重试";
  } finally {
    if (state.chat.inspection === inspection) {
      inspection.loading = false;
      renderChatInspectionBar();
      renderChatMessages();
      updateSessionUnreadIndicators();
    }
  }
}

function chatDraftKey() {
  return state.chat.sessionId || currentSessionKey();
}

function saveChatDraft() {
  const drafts = state.chat.drafts ||= new Map();
  drafts.set(chatDraftKey(), { text: $("#chatInput")?.value || "", attachments: (state.chat.attachments || []).slice(), skill: state.chat.skill, goalArmed: state.chat.goalArmed, inputRequest: state.chat.inputRequest || null });
}

function restoreChatDraft() {
  const draft = state.chat.drafts?.get(chatDraftKey());
  const input = $("#chatInput");
  if (input) input.value = draft?.text || "";
  state.chat.attachments = draft?.attachments || [];
  state.chat.skill = draft?.skill || "";
  if ($("#chatSkill")) $("#chatSkill").value = state.chat.skill;
  state.chat.goalArmed = !!draft?.goalArmed && !isOpenChatGoal();
  state.chat.inputRequest = draft?.inputRequest || null;
  renderChatAttachments();
  renderChatGoal();
}

function chatDraftBusy() {
  return !!(state.chat.pendingUploads || state.rec || (state.chat.attachments || []).some((attachment) => attachment._sttStatus === "transcribing"));
}

function canEditQueuedMessage(sessionId) {
  if (sessionId !== state.chat.sessionId || state.chat.inspection || state.chat.readOnlyMirror) return false;
  if (state.chat.inputSending || state.chat.inputRequest || chatDraftBusy()) {
    toast("请先完成当前发送或附件处理，再撤回编辑。", true); return false;
  }
  if ($("#chatInput")?.value.trim() || state.chat.attachments.length) {
    toast("输入框已有草稿，请先发送或清空，再撤回编辑；排队消息未改变。", true); return false;
  }
  return true;
}

function restoreQueuedMessage(draft, sessionId) {
  const input = $("#chatInput"), visible = state.chat.sessionId === sessionId && input && !state.chat.inspection && !state.chat.readOnlyMirror;
  const oldDraft = state.chat.drafts?.get(sessionId);
  if (visible ? input.value.trim() || state.chat.attachments.length || state.chat.inputSending || state.chat.inputRequest || chatDraftBusy()
    : oldDraft?.text?.trim() || oldDraft?.attachments?.length) return false;
  const restored = { ...draft, skill: "", goalArmed: false };
  (state.chat.drafts ||= new Map()).set(sessionId, restored);
  if (visible) {
    input.value = draft.text; state.chat.attachments = draft.attachments.slice(); state.chat.goalArmed = false;
    renderChatAttachments(); renderChatGoal();
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
  }
  return true;
}

// 拉取当前 persona 的全部渠道会话；默认打开它的 Web 活跃会话，外部会话可按来源筛选查看。
async function loadChatSessions() {
  const box = $("#chatSessionList");
  if (!box) return;
  const requestSeq = ++state.chat.sessionListRequestSeq;
  const requestedAgent = state.chat.agent || DEFAULT_PERSONA;
  try {
    const data = await api(`/api/conversations/explorer?agentName=${encodeURIComponent(requestedAgent)}`);
    // 换 Agent / 重进面板时旧请求可能更晚返回；旧快照绝不能覆盖新角色的会话列。
    if (requestSeq !== state.chat.sessionListRequestSeq || requestedAgent !== (state.chat.agent || DEFAULT_PERSONA)) return;
    if (data.enabled === false) {
      window.HarbourStartupGate?.mark("sessions");
      state.chat.sessionsEnabled = false;
      state.chat.sessionId = null;
      state.chat.selectedSessionKey = "";
      box.innerHTML = `<div class="empty">（服务端未开启会话记忆）</div>`;
      const nb = $("#chatNewSession"); if (nb) nb.disabled = true;
      return;
    }
    state.chat.sessionsEnabled = true;
    state.chat.sessions = chatSessionsForMode(data.sessions, state.chat.mode, requestedAgent);
    window.HarbourStartupGate?.mark("sessions");
    if (state.chat.landing && !state.chat.sessionId && !state.chat.inspection) {
      renderChatSourceTabs(); renderSessionList(); renderChatMessages();
      return; // Do not follow another client's active pointer, or mark it read.
    }
    // 不用其它客户端的 active 指针覆盖本页已提交的 session、GOAL 和执行目标。
    if (state.chat.running || state.chat.inspection) { renderChatSourceTabs(); renderSessionList(); return; }
    const webActive = state.chat.sessions.find((s) => s.key === currentSessionKey() && s.active);
    // A partial/stale explorer snapshot cannot move this window to another
    // client's active conversation. Deletion has its own explicit event path.
    state.chat.sessionId = state.chat.sessionId || webActive?.id || state.chat.sessions[0]?.id || null;
    const activeSummary = state.chat.sessions.find((s) => s.id === state.chat.sessionId);
    state.chat.checkpoint = activeSummary?.checkpoint || null;
    state.chat.goal = activeSummary?.goal || null;
    state.chat.goalArmed = false;
    renderChatSourceTabs();
    renderSessionList();
    renderChatCheckpoint();
    renderChatGoal();
    if (state.chat.sessionId) await loadConversationMessages(state.chat.sessionId);
    else { state.chat.messages = []; state.chat.goal = null; state.chat.cowork = coworkBindingForSession(null); syncChatSourceMode(null); renderChatMessages(); renderChatGoal(); }
  } catch {
    box.innerHTML = `<div class="empty">（加载失败）</div>`;
    window.HarbourStartupGate?.failed("data");
  }
}

// —— context 环：用量/Harbour 有效预算；模型最大窗口另列，避免混淆。——
function fmtK(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) { const k = n / 1000; return (k >= 100 ? Math.round(k) : Number(k.toFixed(1))) + "K"; }
  return String(n);
}
function ctxRingHtml(ratio, curK, winK, pct, label = `${pct}% context`, detail = "") {
  const R = 15, C = 2 * Math.PI * R;
  const dash = (Math.max(0, Math.min(1, ratio)) * C).toFixed(1);
  const hot = pct >= 80 ? " hot" : pct >= 50 ? " warm" : "";
  return `<svg class="ctx-svg${hot}" viewBox="0 0 40 40" width="30" height="30">
      <circle cx="20" cy="20" r="${R}" class="ctx-bg"/>
      <circle cx="20" cy="20" r="${R}" class="ctx-fg" stroke-dasharray="${dash} ${(C - dash).toFixed(1)}" transform="rotate(-90 20 20)"/>
    </svg><span class="ctx-txt"><b>${curK} / ${winK}</b><span>${esc(label)}</span>${detail ? `<small>${esc(detail)}</small>` : ""}</span>`;
}
function updateChatContextRing() {
  const el = $("#chatCtx");
  if (!el) return;
  if (state.chat.modelSaving?.sessionId === viewedChatSessionId()) {
    el.innerHTML = '<span class="ctx-txt"><b>模型切换中…</b></span>';
    el.title = "正在保存模型并重新计算上下文预算；尚未压缩或调用模型。";
    return;
  }
  const list = state.chat.sessions || [];
  const s = list.find((x) => x.id === viewedChatSessionId());
  const tok = s && Number.isFinite(s.contextTokens) ? s.contextTokens : null;
  const win = s && s.contextWindow ? s.contextWindow : 0;
  if (tok == null || !win) { el.innerHTML = ""; el.title = "本会话上下文占用"; return; }
  const limit = s.contextLimit > 0 ? s.contextLimit : win;
  const pct = Math.round((tok / limit) * 100);
  const compactAt = s.compactAtTokens > 0 ? s.compactAtTokens : 0;
  const needsCompact = compactAt > 0 && tok >= compactAt;
  const mode = s.contextBudgetMode;
  const modeLabel = mode === "auto" ? "自动限额" : mode === "manual" ? "手动限额" : "输入上限";
  const sourceLabel = ({ model: "模型覆盖", environment: "环境覆盖", "window-ratio": mode === "manual" ? "预算 80%" : "窗口 80%" })[s.compactSource] || "后端策略";
  el.innerHTML = ctxRingHtml(tok / limit, `≈${fmtK(tok)}`, fmtK(limit), pct,
    needsCompact ? `下次发送先压缩 · 模型 ${fmtK(win)}` : `${modeLabel} · 模型 ${fmtK(win)}`,
    compactAt ? `${needsCompact ? modeLabel + " · " : ""}压缩 ${fmtK(compactAt)} · ${sourceLabel}${s.compactClamped ? "（已限幅）" : ""}` : "");
  // 拆成「人格 system + 本轮对话」写清楚：新建会话时对话=0 但 system 仍占一两千 token，
  // 只给一个总数会让人以为「新会话没清空」。
  const sysT = Number.isFinite(s.systemTokens) ? s.systemTokens : null;
  const bodyT = Number.isFinite(s.bodyTokens) ? s.bodyTokens : null;
  const goalT = Number.isFinite(s.goalTokens) ? s.goalTokens : 0;
  const toolT = Number.isFinite(s.toolTokens) ? s.toolTokens : null;
  const split = sysT != null && bodyT != null
    ? `\n  · 人格 system：${sysT.toLocaleString()} tok（每轮固定装载，新建会话也在）` +
      `\n  · 本会话对话：${bodyT.toLocaleString()} tok（新建会话时为 0）` +
      (toolT != null ? `\n  · 工具 schema 估算：${toolT.toLocaleString()} tok` : "") +
      (goalT ? `\n  · 当前 GOAL：${goalT.toLocaleString()} tok（完成/退出后移除）` : "")
    : "";
  const checkpointModel = s.checkpoint?.modelRef;
  const configuredBudget = Number.isFinite(s.configuredContextBudget) ? s.configuredContextBudget : null;
  const policy = mode === "auto" ? "自动 · 跟随本轮所选模型窗口，不钉固定 token 值"
    : mode === "manual" ? `手动 · Agent 指定 ${configuredBudget != null ? configuredBudget.toLocaleString() + " tok" : "数值限额"}（切换模型不会清除此设置）`
      : "后端未提供自动/手动标记，以下显示已计算的有效数值";
  const reserve = Number.isFinite(s.reservedOutputTokens) ? `\n输出预留：${s.reservedOutputTokens.toLocaleString()} tok（模型窗口的 5%，不计为已用量）` : "";
  const nativeObserved = s.contextTokenSource === "native-observed";
  el.title = `${nativeObserved ? "原生会话最近观测" : "会话上下文估算"}：${tok.toLocaleString()} / ${limit.toLocaleString()} tok（${pct}% Harbour 预算）` +
    `\n当前模型：${s.contextModelRef || s.modelRef || "跟随 Agent"}` +
    `\n模型最大窗口：${win.toLocaleString()} tok（${s.contextWindowSource === "fallback" ? "缺少目录数值，使用内置参考值" : "连接模型目录"}）` +
    `\nAgent 上下文策略：${policy}` + reserve +
    `\nHarbour 有效输入上限：${limit.toLocaleString()} tok（${mode === "auto" ? "模型窗口减去输出预留" : "模型减去输出预留后，再取手动 Agent 限额的较小值"}）` +
    (compactAt ? `\nHarbour 压缩触发线：${compactAt.toLocaleString()} tok · 来源：${sourceLabel}` +
      (s.compactSource === "window-ratio" && mode === "manual" ? "（Agent 预算与模型窗口较小值的 80%）" : "") +
      (s.compactClamped && Number.isFinite(s.compactRequestedTokens) ? `；请求值 ${s.compactRequestedTokens.toLocaleString()} tok 已限制到有效输入安全线。` : "。") +
      "下次发送还会计入新消息与附件。" : "") + (nativeObserved ? "" : split) +
    (nativeObserved ? `\n来自原生后端最近一次用量回执，包含已保存的原生对话/工具上下文；不是累计账单或缓存命中量。观测时间：${s.contextObservedAt ? formatDate(s.contextObservedAt) : "未知"}。切换到不兼容配置时会重新装配。`
      : `\n这是已保存会话的估算，不是本轮工具循环的实时精确计数。切换模型不删历史、不调用模型；发送前按所选模型预检并按需压缩。模型 SDK 的单轮内部保护仍独立生效。`) +
    (checkpointModel && checkpointModel !== s.contextModelRef ? `\n断点仍绑定 ${checkpointModel}：发送“继续”沿用断点模型，新的任务才使用当前选择。` : "");
}

function chatSessionRowHtml(s, selected, live, unread = false) {
  const kind = sessionSourceKind(s);
  const title = s.title || "未命名会话";
  // 旧自动标题已自带末尾省略号：只换展示方式，悬停、编辑与持久化仍用原值。
  const displayTitle = title.replace(/(?:…+|\.{3,})$/u, "");
  const goalOpen = ["active", "blocked", "paused"].includes(s.goal?.status);
  const interrupted = s.checkpoint?.status === "interrupted";
  const activityAt = s.lastMessageAt || s.createdAt;
  const status = live ? "运行中" : interrupted ? "有待恢复的断点" : goalOpen ? "有未完成目标" : "";
  // 次要信息只留在悬停说明与无障碍标签里；不再占四行，也不取 updatedAt 冒充消息时间。
  const details = [
    s.title || "未命名会话",
    [kind === "web" ? "Web" : SESSION_SOURCE_LABELS[kind] || kind.toUpperCase(), sourceAccount(s), sourceWhere(s)].filter(Boolean).join(" · "),
    `${s.messageCount || 0} 条消息${s.compactions ? ` · ${s.compactions} 次压缩` : ""}`,
    activityAt ? `最近消息：${formatDate(activityAt)} · ${timeAgo(activityAt)}` : "",
    status,
    s.readOnlyMirror || s.channel !== "web" ? "外部渠道镜像 · Web 端只读" : "",
  ].filter(Boolean).join("\n");
  const indicator = live ? "running" : interrupted ? "interrupted" : goalOpen ? "goal" : "";
  const accessibleDetails = details + (unread ? "\n有新回复未读" : "");
  return `<div class="chat-session${selected ? " active" : ""}${indicator ? ` has-${indicator}` : ""}${unread ? " has-unread" : ""}" data-session-id="${esc(s.id)}" data-source="${esc(kind)}">
    <button type="button" class="cs-main" data-session-switch="${esc(s.id)}" title="${esc(accessibleDetails)}" aria-label="${esc(accessibleDetails)}"${selected ? ' aria-current="true"' : ""}>
      <span class="source-badge cs-channel source-${esc(kind)}" aria-hidden="true">${esc(sourceBadgeText(s))}</span>
      <span class="cs-title${displayTitle !== title ? " is-shortened" : ""}"><span>${esc(displayTitle)}</span></span>
      ${indicator ? `<span class="cs-state cs-state-${indicator}" aria-hidden="true"></span>` : ""}
      ${unread ? '<span class="cs-unread" aria-hidden="true"></span>' : ""}
    </button>
    <button type="button" class="cs-actions" data-session-actions="${esc(s.id)}" title="会话操作" aria-label="会话操作：${esc(title)}" aria-haspopup="menu" aria-expanded="false">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>
    </button>
    <form class="cs-rename-form" data-session-rename-form="${esc(s.id)}">
      <input class="cs-rename-input" name="title" value="${esc(s.title)}" maxlength="120" aria-label="会话标题" autocomplete="off">
      <button type="submit" class="cs-rename-commit" title="保存标题" aria-label="保存标题">✓</button>
      <button type="button" class="cs-rename-cancel" title="取消编辑" aria-label="取消编辑">×</button>
    </form>
  </div>`;
}

// 一行一段会话：完整标题保留，视觉渐隐交给 CSS；切换/只读浏览仍复用原来的执行边界。
function renderSessionList() {
  const box = $("#chatSessionList");
  if (!box) return;
  const scrollTop = box.scrollTop;
  const list = sessionsInFilter(state.chat.sessions || [], state.chat.sourceFilter);
  if (!list.length) { closeChatSessionMenu(); box.innerHTML = `<div class="empty">（暂无，发消息即新建）</div>`; updateChatContextRing(); return; }
  box.innerHTML = list.map((s) => {
    const live = (state.chat.running && s.id === state.chat.sessionId)
      || Object.values(state.chat.channelRuns || {}).some((run) => run.sessionId === s.id);
    return chatSessionRowHtml(s, s.id === viewedChatSessionId(), live, window.HarbourChatUnread?.hasUnread(s) || false);
  }).join("");
  box.scrollTop = scrollTop;
  box.querySelectorAll("[data-session-switch]").forEach((b) => {
    b.addEventListener("click", event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) { event.preventDefault(); openChatWindow(b.dataset.sessionSwitch); }
      else switchChatSession(b.dataset.sessionSwitch);
    });
    b.addEventListener("auxclick", event => { if (event.button === 1) { event.preventDefault(); openChatWindow(b.dataset.sessionSwitch); } });
  });
  box.querySelectorAll("[data-session-actions]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleChatSessionMenu(b.dataset.sessionActions); });
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); toggleChatSessionMenu(b.dataset.sessionActions); }
    });
  });
  box.querySelectorAll("[data-session-rename-form]").forEach((form) => {
    form.addEventListener("click", (e) => e.stopPropagation());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveChatSessionRename(form.dataset.sessionRenameForm, form);
    });
    form.querySelector(".cs-rename-cancel")?.addEventListener("click", () => closeChatSessionRename(form));
    form.querySelector(".cs-rename-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeChatSessionRename(form); }
    });
  });
  syncChatSessionMenu();
  updateChatContextRing();
}

let chatSessionMenu = null;
function chatSessionActionButton(id) {
  return document.querySelector(`[data-session-actions="${CSS.escape(id)}"]`);
}
function closeChatSessionMenu(restoreFocus = false) {
  const opened = chatSessionMenu;
  if (!opened) return;
  chatSessionMenu = null;
  opened.events.abort();
  opened.menu.remove();
  const trigger = chatSessionActionButton(opened.id);
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}
function chatSessionDeleteBlocked(id) {
  const session = state.chat.sessions.find(s => s.id === id);
  if (session?.checkpoint?.status === "running" || (id === state.chat.sessionId && (state.chat.running || state.chat.intakeRunning))
    || Object.values(state.chat.channelRuns || {}).some(run => run.sessionId === id)) return "任务仍在运行或收尾，请先停止并等待保存完成。";
  if (state.chat.switchingSession || state.chat.switchingMode || state.chat.modelSaving || state.chat.coworkSaving
    || (id === state.chat.sessionId && (chatDraftBusy() || state.chat.inputSending || state.chat.inputRequest))) return "会话正在切换、保存或处理消息，请稍后再删除。";
  if (state.chat.deletingSessionId) return "正在删除会话，请稍候。";
  return "";
}
function syncChatSessionMenu() {
  if (!chatSessionMenu) return;
  const { id, menu } = chatSessionMenu;
  const trigger = chatSessionActionButton(id);
  if (!trigger || !trigger.getClientRects().length) { closeChatSessionMenu(); return; }
  trigger.setAttribute("aria-expanded", "true");
  const reason = chatSessionDeleteBlocked(id);
  const remove = menu.querySelector("[data-session-delete]");
  remove.setAttribute("aria-disabled", String(!!reason));
  remove.title = reason || "删除会话";
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight + 12 <= innerHeight ? rect.bottom + 5 : rect.top - menu.offsetHeight - 5)}px`;
}
function toggleChatSessionMenu(id) {
  if (chatSessionMenu?.id === id) { closeChatSessionMenu(true); return; }
  closeChatSessionMenu();
  const session = state.chat.sessions.find(s => s.id === id);
  if (!session) return;
  const menu = h(`<div class="cs-menu" role="menu" aria-label="会话操作">
    <button type="button" role="menuitem" data-session-window="${esc(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7m0-7-10 10M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>在新窗口打开</button>
    <button type="button" role="menuitem" data-session-rename="${esc(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg>重命名</button>
    <button type="button" role="menuitem" class="cs-menu-delete" data-session-delete="${esc(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>删除会话</button>
  </div>`);
  const events = new AbortController(), options = { signal: events.signal };
  chatSessionMenu = { id, menu, events };
  document.body.appendChild(menu);
  syncChatSessionMenu();
  menu.querySelector("[data-session-window]").onclick = () => { closeChatSessionMenu(); openChatWindow(id); };
  menu.querySelector("[data-session-rename]").onclick = () => { closeChatSessionMenu(); renameChatSession(id); };
  menu.querySelector("[data-session-delete]").onclick = () => { closeChatSessionMenu(true); void deleteChatSession(id); };
  menu.addEventListener("keydown", event => {
    const items = Array.from(menu.querySelectorAll("button"));
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (items.indexOf(document.activeElement) + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[index].focus();
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeChatSessionMenu(true); }
    if (event.key === "Tab") closeChatSessionMenu(true);
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.contains(event.target) && !chatSessionActionButton(id)?.contains(event.target)) closeChatSessionMenu();
  }, options);
  document.addEventListener("focusin", event => {
    if (!menu.contains(event.target) && !chatSessionActionButton(id)?.contains(event.target)) closeChatSessionMenu();
  }, options);
  window.addEventListener("resize", () => closeChatSessionMenu(), options);
  window.addEventListener("hashchange", () => closeChatSessionMenu(), options);
  document.addEventListener("scroll", event => { if (!menu.contains(event.target)) closeChatSessionMenu(); }, { ...options, capture: true });
  menu.querySelector("button").focus({ preventScroll: true });
}

async function deleteChatSession(id) {
  const session = state.chat.sessions.find(s => s.id === id);
  if (!session) return;
  const blocked = chatSessionDeleteBlocked(id);
  if (blocked) return toast(blocked, true);
  const mirror = session.channel !== "web" || session.readOnlyMirror;
  if (!await harbourConfirm(`删除「${session.title || "未命名会话"}」？`, {
    title: "删除会话", tone: "danger", confirmLabel: "删除", initialFocus: "cancel",
    detail: "聊天记录与断点将永久删除，不能撤销。已生成的文件和当前输入框里的草稿会保留。"
      + (isOpenChatGoal(session.goal || null) ? " 此会话的未完成目标也会删除。" : "")
      + (mirror ? " 只删除 Harbour 中的会话记忆，不会撤回原渠道的消息。" : ""),
  })) return;
  // A task/configuration can change while the confirmation is open. The server
  // checks again authoritatively; never delete optimistically or abort a run.
  const recheck = chatSessionDeleteBlocked(id);
  if (recheck) return toast(recheck, true);
  state.chat.deletingSessionId = id;
  const current = state.chat.sessionId === id;
  if (current) { state.chat.switchingSession = true; ++state.chat.detailRequestSeq; syncChatControlLocks(); }
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (result.removed !== id) throw new Error("未收到删除确认，会话列表保持不变。请刷新后核对。");
    applyDeletedChatSession(id);
    if (current && !state.chat.inspection) $("#chatInput")?.focus();
    else $("#chatSessionList [data-session-actions]")?.focus({ preventScroll: true });
    toast("会话已删除");
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.chat.deletingSessionId = null;
    if (current) { state.chat.switchingSession = false; syncChatControlLocks(); setChatSendMode(state.chat.running); }
    syncChatSessionMenu();
  }
}

function applyDeletedChatSession(id) {
  (state.chat.deletedSessionIds ||= new Set()).add(id);
  ++state.chat.sessionListRequestSeq; // An older explorer response cannot resurrect this row.
  state.chat.sessions = state.chat.sessions.filter(s => s.id !== id);
  state.chat.drafts?.delete(id);
  state.chat.goalSnapshots?.delete(id);
  state.chat.goalDrafts?.delete(id);
  if (chatSessionMenu?.id === id) closeChatSessionMenu();
  if (state.chat.inspection?.id === id) closeChatInspection();
  if (state.chat.sessionId === id && !state.chat.running) {
    ++state.chat.detailRequestSeq;
    state.chat.switchingSession = false;
    state.chat.sessionId = null;
    state.chat.landing = true;
    pinChatWindow();
    state.chat.displayedReply = null;
    state.chat.messages = [];
    state.chat.trace = [];
    state.chat.subagents = {};
    state.chat.plan = null;
    state.chat.planDone = {};
    state.chat.checkpoint = null;
    state.chat.goal = null;
    state.chat.goalArmed = false;
    state.chat.goalEditor = null;
    state.chat.cowork = coworkBindingForSession(null);
    state.chat.model = state.chat.reasoningEffort = state.chat.permissionMode = "";
    if ($("#chatModel")) $("#chatModel").value = "";
    if ($("#chatPermMode")) $("#chatPermMode").value = "";
    fillChatEfforts();
    syncChatSourceMode(null);
    closeFilePreview(false);
    // Keep unsent input/attachments in the composer; do not POST /new or switch
    // the backend's active pointer just to display the empty welcome state.
    renderChatMessages(); renderChatPlan(); renderChatCheckpoint(); renderChatGoal();
  }
  renderChatSourceTabs(); renderSessionList();
}

// Read acknowledgements update the dot in place: do not steal focus or discard a title edit.
function updateSessionUnreadIndicators() {
  document.querySelectorAll('#chatSessionList .chat-session').forEach(row => {
    const session = state.chat.sessions.find(s => s.id === row.dataset.sessionId);
    const unread = window.HarbourChatUnread?.hasUnread(session) || false;
    const previous = row.classList.contains('has-unread');
    if (unread === previous) return;
    const button = row.querySelector('.cs-main');
    row.classList.toggle('has-unread', unread);
    if (unread) button.insertAdjacentHTML('beforeend', '<span class="cs-unread" aria-hidden="true"></span>');
    else button.querySelector('.cs-unread')?.remove();
    const label = button.getAttribute('aria-label') || '';
    const base = previous ? label.replace(/\n有新回复未读$/, '') : label;
    button.title = base + (unread ? '\n有新回复未读' : '');
    button.setAttribute('aria-label', button.title);
  });
}

// 打开行内标题编辑器。原生 window.prompt 在 Electron 中可能完全不出现，不能作为编辑入口。
function renameChatSession(id) {
  const card = document.querySelector(`.chat-session[data-session-id="${CSS.escape(id)}"]`);
  const form = card?.querySelector(".cs-rename-form");
  const input = form?.querySelector(".cs-rename-input");
  if (!card || !form || !input) return toast("没有找到这条会话", true);
  document.querySelectorAll(".chat-session.renaming").forEach((other) => {
    if (other !== card) closeChatSessionRename(other.querySelector(".cs-rename-form"));
  });
  card.classList.add("renaming");
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeChatSessionRename(form) {
  if (!form) return;
  const card = form.closest(".chat-session");
  const id = form.dataset.sessionRenameForm;
  const current = state.chat.sessions.find((s) => s.id === id)?.title || "";
  const input = form.querySelector(".cs-rename-input");
  if (input) { input.value = current; input.setCustomValidity(""); }
  card?.classList.remove("renaming");
  card?.querySelector(".cs-actions")?.focus({ preventScroll: true });
}

// 保存标题（PATCH /api/conversations/:id → sessionStore.rename），成功后原位刷新。
async function saveChatSessionRename(id, form) {
  const input = form.querySelector(".cs-rename-input");
  const t = input?.value.trim() || "";
  if (!t) {
    input?.setCustomValidity("标题不能为空");
    input?.reportValidity();
    return;
  }
  input.setCustomValidity("");
  form.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: t }) });
    const local = state.chat.sessions.find((s) => s.id === id);
    if (local) local.title = session?.title || t;
    toast("已重命名");
    renderSessionList();
    chatSessionActionButton(id)?.focus({ preventScroll: true });
  } catch (e) {
    form.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
    toast(e.message, true);
    input?.focus();
  }
}

// 仅刷新会话列的计数/活跃（不动对话流，避免覆盖本地刚插入的提示）。
async function refreshSessionList() {
  const requestSeq = ++state.chat.sessionListRequestSeq;
  const requestedAgent = state.chat.agent || DEFAULT_PERSONA;
  try {
    const data = await api(`/api/conversations/explorer?agentName=${encodeURIComponent(requestedAgent)}`);
    if (requestSeq !== state.chat.sessionListRequestSeq || requestedAgent !== (state.chat.agent || DEFAULT_PERSONA)) return;
    if (data.enabled === false) { window.HarbourStartupGate?.mark("sessions"); return; }
    state.chat.sessions = chatSessionsForMode(data.sessions, state.chat.mode, requestedAgent);
    window.HarbourStartupGate?.mark("sessions");
    if (!state.chat.sessionId && !state.chat.landing && !state.chat.running && !state.chat.inspection) {
      state.chat.sessionId = state.chat.sessions.find((s) => s.key === currentSessionKey() && s.active)?.id || state.chat.sessions[0]?.id || null;
    }
    const current = state.chat.sessions.find((s) => s.id === state.chat.sessionId);
    if (current && !state.chat.running) state.chat.goal = current.goal || null;
    renderChatSourceTabs();
    renderSessionList();
    renderChatGoal();
    const viewed = state.chat.sessions.find(s => s.id === viewedChatSessionId());
    const displayed = state.chat.inspection?.session || state.chat.displayedReply;
    if (viewed?.replyRevision > (displayed?.id === viewed.id ? displayed.replyRevision || 0 : 0)) {
      if (state.chat.inspection && !state.chat.inspection.loading) void inspectChatSession(viewed.id, true);
      else if (!state.chat.inspection && !state.chat.running) void loadConversationMessages(viewed.id);
    }
  } catch { /* ignore */ }
}

/** 纯展示转换：正式会话与只读浏览共用，不写回执行会话。 */
function sessionChatMessages(session) {
  const traces = Array.isArray(session.traces) ? session.traces : null;
  const times = Array.isArray(session.times) ? session.times : null;
  const durations = Array.isArray(session.durations) ? session.durations : null;
  const messages = (session.messages || []).map((m, i) => ({
    role: m.role,
    content: m.content,
    agent: m.agent || session.agentName,
    ...(m.actor ? { actor: m.actor } : {}),
    ...(m.runRecord ? { runRecord: m.runRecord } : {}),
    ...(Array.isArray(m.attachments) && m.attachments.length ? { attachments: m.attachments } : {}),
    ...(Array.isArray(m.fileChanges) && m.fileChanges.length ? { fileChanges: m.fileChanges } : {}),
    ...(Array.isArray(m.calendarCards) && m.calendarCards.length ? { calendarCards: m.calendarCards } : {}),
    // traces[i] / times[i] 与 messages[i] 严格对齐（后端保证）。老会话没 times 就不显示时间。
    ...(traces && Array.isArray(traces[i]) && traces[i].length
      ? { trace: normalizeStoredTrace(traces[i], session.agentName) }
      : {}),
    ...(times && times[i] ? { at: times[i] } : {}),
    ...(durations && Number.isFinite(durations[i]) ? { durationMs: durations[i] } : {}),
  }));
  // 兼容旧版只存 checkpoint、还没有 durable interrupted turn 的会话。新版中断轮已经
  // 直接进入 session.messages + traces；只有确实找不到原输入时才用这段展示态兜底。
  const cp = session.checkpoint;
  if (cp?.status === "interrupted" && cp.originalInput) {
    const alreadyShown = messages.some((message) =>
      message.role === "user" && String(message.content || "").trim() === String(cp.originalInput).trim());
    if (!alreadyShown) {
      messages.push({
        role: "user",
        content: cp.originalInput,
        ...(cp.actor ? { actor: cp.actor } : {}),
        attachments: Array.isArray(cp.attachments) ? cp.attachments : [],
        at: cp.createdAt || null,
        checkpointOnly: true,
      });
      const checkpointTrace = (cp.tools || []).map((call) => {
        const failed = call.status === "failed" || call.status === "interrupted";
        const detail = call.error || call.resultPreview || "";
        return {
          cls: failed ? "fallback" : "result",
          tag: `#${call.sequence} ${call.tool}`,
          text: `${call.status === "completed" ? "已完成" : call.status === "failed" ? "失败" : "已停止"}${detail ? ` · ${String(detail).replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
          agent: call.agent,
          depth: 0,
        };
      });
      messages.push({
        role: "assistant",
        agent: cp.agentName || session.agentName,
        content: "⏹ 这轮在完成前被停止，因此没有写入对话记忆；原问题与工具进度已从 checkpoint 恢复展示。发送「继续」可从首个未完成步骤接着处理。",
        ...(checkpointTrace.length ? { trace: checkpointTrace } : {}),
        at: cp.interruptedAt || cp.updatedAt || null,
        checkpointOnly: true,
      });
    }
  }
  return messages;
}

/** 正式切换只在无本地运行时发生；只读浏览绝不能调用此函数。 */
function applySessionDetail(session) {
  state.chat.landing = false;
  pinChatWindow();
  state.chat.displayedReply = { id: session.id, key: session.key, replyRevision: session.replyRevision, readReplyRevision: session.readReplyRevision };
  window.HarbourChatUnread?.observe(session);
  const local = state.chat.sessions?.find((row) => row.id === session.id);
  if (local) {
    const { messages, traces, times, durations, plan, ...summary } = session;
    Object.assign(local, summary); // Keep the sidebar cache thin; prose/trace stay in the active view.
  }
  state.chat.messages = sessionChatMessages(session);
  state.chat.plan = session.plan || null;
  state.chat.checkpoint = session.checkpoint || null;
  state.chat.goal = session.goal || null;
  state.chat.goalArmed = false;
  state.chat.goalEditor = null;
  state.chat.cowork = coworkBindingForSession(session);
  state.chat.intakeRunning = Object.values(state.chat.channelRuns || {}).some(run => run.sessionId === session.id);
  // Read-only channel mirrors still display their own configuration. Only
  // editing is locked; retaining the previous Web selection mislabels QQ/DC.
  // An unavailable/late catalog cannot turn a saved choice into "follow Agent".
  state.chat.model = session.modelRef || "";
  const modelSel = $("#chatModel");
  if (modelSel) {
    if (state.chat.model && !Array.from(modelSel.options).some((option) => option.value === state.chat.model)) {
      modelSel.insertAdjacentHTML("beforeend", `<option value="${esc(state.chat.model)}">当前选择 · ${esc(state.chat.model)}（目录暂不可用）</option>`);
    }
    modelSel.value = state.chat.model;
  }
  state.chat.reasoningEffort = session.reasoningEffort || "";
  state.chat.permissionMode = session.permissionMode || "";
  const modeSel = $("#chatPermMode");
  if (modeSel) modeSel.value = state.chat.permissionMode;
  fillChatEfforts({ preserveSelection: true });
  syncChatSourceMode(session);
  overlaySelectedChannelRuns(session.id);
  state.chat.planDone = {};
  renderChatMessages();
  renderChatPlan();
  renderChatCheckpoint();
  renderChatGoal();
  enrichNewsReports();
  updateChatContextRing();
  updateSessionUnreadIndicators();
}

async function loadConversationMessages(id) {
  if (state.chat.sessionId !== id || state.chat.running || state.chat.modelSaving || state.chat.switchingSession) return;
  const requestSeq = ++state.chat.detailRequestSeq;
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (requestSeq !== state.chat.detailRequestSeq || session.id !== id || state.chat.sessionId !== id) return;
    state.chat.sessionId = session.id;
    applySessionDetail(session);
  } catch { /* ignore */ }
}

/** Leave only the view. The original executeChat closure keeps its own state and
 * observation signal; channelRuns projects that same run when it is revisited. */
function detachChatExecutionView() {
  const chat = state.chat;
  stopVisualTimer(chat.durationTicker);
  if (chat.missingRunTimer) clearTimeout(chat.missingRunTimer);
  chat.durationTicker = null;
  chat.missingRunTimer = null;
  if (chat.running && chat.activeRunId) {
    const pending = chat.messages.findLast(message => message.pending && !message.externalEphemeral);
    const run = {
      id: chat.activeRunId, agent: chat.agent, sessionId: chat.sessionId,
      sessionKey: chat.selectedSessionKey || chat.sessionKey, source: { platform: 'web' },
      phase: chat.stopping ? 'stopping' : 'running', canStop: true, stopping: chat.stopping,
      input: chat.messages.at(-2)?.content || '', attachments: chat.messages.at(-2)?.attachments || [],
      trace: chat.trace, subagents: chat.subagents, startedAt: pending?.runStartedAt || Date.now(),
      activity: pending?.activity || '任务正在后台执行…',
    };
    Object.defineProperty(run, 'localChat', { value: chat });
    chat.backgroundRun = run;
    (chat.channelRuns ||= {})[run.id] = run;
  }
  // A new object is the ownership boundary for all outstanding local callbacks.
  // Shared catalogs, drafts and the run registry remain shared; execution and
  // composer state do not. Never abort a task as a navigation side effect.
  state.chat = { ...chat, running: false, stopping: false, intakeRunning: false,
    activeRunId: '', abort: null, durationTicker: null, missingRunTimer: null, backgroundRun: null,
    messages: [], trace: [], subagents: {}, plan: null, planDone: {}, checkpoint: null,
    displayedReply: null, goal: null, goalArmed: false, goalEditor: null, goalActionPending: null,
    goalReloadSessionId: null, inputSending: false, inputRequest: null, inspection: null };
  if (state.runningSurface === 'chat') { state.runningAgent = null; state.runningSurface = null; }
}

async function newChatSession() {
  if (state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession) return toast("当前配置已锁定；请先等待完成再新开会话。", true);
  if (state.chat.inputSending) return toast("消息正在送达，请稍后新开会话；不会打开新窗口。", true);
  if (chatDraftBusy()) return toast("请等待附件上传或语音处理结束后再新开会话。", true);
  if (state.chat.inspection) closeChatInspection();
  const requestSeq = ++state.chat.detailRequestSeq;
  const requestedKey = currentSessionKey();
  const requestedAgent = state.chat.agent;
  state.chat.switchingSession = true;
  saveChatDraft();
  syncChatControlLocks();
  try {
    const { session } = await api("/api/conversations/new", {
      method: "POST",
      body: JSON.stringify({ key: requestedKey, channel: "web", agentName: requestedAgent }),
    });
    if (requestSeq !== state.chat.detailRequestSeq || currentSessionKey() !== requestedKey || state.chat.agent !== requestedAgent) return;
    if (!session?.id || session.key !== requestedKey || session.agentName !== requestedAgent) throw new Error("新会话归属不匹配，未切换原会话");
    detachChatExecutionView();
    state.chat.sessionId = session.id;
    state.chat.sessions = [session, ...state.chat.sessions.filter(row => row.id !== session.id)];
    state.chat.sourceFilter = state.chat.mode === "cowork" ? "cowork" : "web";
    state.chat.landing = false;
    pinChatWindow();
    state.chat.model = session.modelRef || "";
    if ($("#chatModel")) $("#chatModel").value = state.chat.model;
    state.chat.reasoningEffort = session.reasoningEffort || "";
    fillChatEfforts();
    state.chat.permissionMode = session.permissionMode || "";
    if ($("#chatPermMode")) $("#chatPermMode").value = state.chat.permissionMode;
    state.chat.messages = [];
    state.chat.plan = null;          // 新会话：没有计划
    state.chat.planDone = {};
    state.chat.checkpoint = null;
    state.chat.goal = session.goal || null;
    state.chat.goalArmed = false;
    state.chat.cowork = coworkBindingForSession(session);
    syncChatSourceMode(session);
    restoreChatDraft();
    renderChatMessages();
    renderChatPlan();
    renderChatCheckpoint();
    renderChatGoal();
    setChatSendMode(false);
    renderSessionList();
    window.HarbourChatIntake?.refresh?.();
    // 详情提交后原子释放切换锁；列表刷新不参与锁的生命周期。
    void refreshSessionList();
    toast("已开启新会话");
  } catch (e) {
    if (requestSeq === state.chat.detailRequestSeq) toast(e.message, true);
  } finally {
    if (requestSeq === state.chat.detailRequestSeq) {
      state.chat.switchingSession = false;
      syncChatControlLocks();
    }
  }
}

async function switchChatSession(id, enter = false) {
  if (state.chat.deletingSessionId === id || state.chat.deletedSessionIds?.has(id)) return;
  if (state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.inputSending) return toast("配置或消息正在保存，请稍后切换会话。", true);
  if (!id) return;
  if (id === state.chat.sessionId) {
    if (state.chat.inspection) closeChatInspection();
    else if (state.chat.switchingSession) {
      // A→B 还没返回时再点 A，也是明确的最新选择，不是无操作。
      ++state.chat.detailRequestSeq;
      state.chat.switchingSession = false;
      syncChatControlLocks();
      setChatSendMode(state.chat.running);
    }
    else if (window.HarbourChatUnread?.hasUnread(state.chat.sessions.find(s => s.id === id))) void loadConversationMessages(id);
    return;
  }
  if (state.chat.inspection && !enter) return inspectChatSession(id);
  if (chatDraftBusy()) return toast("附件上传或语音处理尚未结束，请稍后切换；运行中仍可只读查看其它会话。", true);
  const requestSeq = ++state.chat.detailRequestSeq;
  state.chat.switchingSession = true;
  saveChatDraft();
  syncChatControlLocks();
  try {
    const summary = state.chat.sessions.find((s) => s.id === id);
    if (!summary) throw new Error("会话已不存在，请刷新列表");
    const { session } = summary.channel === "web"
      ? await api("/api/conversations/switch", {
          method: "POST",
          body: JSON.stringify({ key: summary.key, id }),
        })
      : await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (requestSeq !== state.chat.detailRequestSeq || session.id !== id || state.chat.deletedSessionIds?.has(id)) return;
    if (session.agentName !== state.chat.agent || session.key !== summary.key) throw new Error("会话归属不匹配，已阻止切换");
    detachChatExecutionView();
    state.chat.sessionId = session.id;
    applySessionDetail(session);
    restoreChatDraft();
    state.chat.intakeRunning = Object.values(state.chat.channelRuns || {}).some(run => run.sessionId === session.id);
    window.HarbourChatIntake?.refresh?.();
    void refreshSessionList();
    toast(summary.channel === "web" ? `已切到「${session.title}」` : `正在查看 ${sourceWhere(summary)} 的实时镜像`);
  } catch (e) {
    if (requestSeq === state.chat.detailRequestSeq) toast(e.message, true);
  } finally {
    if (requestSeq === state.chat.detailRequestSeq) {
      state.chat.switchingSession = false;
      syncChatControlLocks();
      setChatSendMode(state.chat.running);
    }
  }
}

/* ── HISTORY 面板：历史会话浏览（角色独立 · 左 session 列表 · 右只读全文）── */
const histView = { sessions: [], sel: null, filter: "all", agent: "", agents: [], requestSeq: 0 };

// 全局导航抽屉：默认隐藏，hover 屏幕最左缘或点顶栏 ☰ 唤出 —— 让每个页面都是全宽、不被侧栏挤占。
const navDrawer = { pinned: false, hover: false };
// 通用抽屉接线：shell 上加/去 openClass；hover 边缘唤出、离开面板收起、点按钮固定。返回 apply() 供外部主动收起。
function wireDrawer({ shell, aside, edge, toggle, state, openClass = "drawer-open" }) {
  if (!shell) return () => {};
  const apply = () => {
    const open = !!(state.pinned || state.hover);
    shell.classList.toggle(openClass, open);
    toggle?.classList.toggle("active", open); // 按钮高亮跟着开合走，不再表示"已钉住"
    toggle?.setAttribute("aria-expanded", String(open));
  };

  /* 点开之后【鼠标移开就自动收起】，不用再点一次图标（用户 要求，2026-07-22）。
     所以点击不再"钉住"，只是把它临时唤出来。

     这里有个必须处理的坑：点完按钮时指针在【顶栏的按钮上】，压根没进过侧栏，
     于是 aside 的 mouseleave 永远不会触发 —— 只靠 mouseleave 的话，
     点开后把鼠标移到别处它会一直开着。所以改成盯全局指针位置：
     指针既不在侧栏、也不在按钮/唤出边缘上，就收起。 */
  let closeTimer = null;
  const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
  const closeNow = () => { cancelClose(); state.hover = false; state.pinned = false; apply(); };
  // 延迟再收：按钮和侧栏之间有间隙，指针路过时会瞬间"哪边都不在"，
  // 立刻收会让人根本移不进去。260ms 足够跨过间隙，又不至于黏手。
  const scheduleClose = () => { if (!closeTimer) closeTimer = setTimeout(closeNow, 260); };

  const isOver = (el, e) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  document.addEventListener("mousemove", (e) => {
    if (!shell.classList.contains(openClass)) return;
    if (isOver(aside, e) || isOver(toggle, e) || isOver(edge, e)) cancelClose();
    else scheduleClose();
  });
  // 指针整个移出窗口也算移开。
  document.addEventListener("mouseleave", () => { if (shell.classList.contains(openClass)) scheduleClose(); });

  if (edge) edge.addEventListener("mouseenter", () => { cancelClose(); state.hover = true; apply(); });
  if (aside) {
    aside.addEventListener("mouseenter", cancelClose);
    aside.addEventListener("mouseleave", () => { state.hover = false; scheduleClose(); });
  }
  if (toggle) {
    toggle.addEventListener("click", () => {
      if (shell.classList.contains(openClass)) { closeNow(); return; } // 开着时点一下 = 收起
      cancelClose();
      state.hover = true; // 用 hover 而非 pinned —— 这样移开鼠标就会自动收
      apply();
    });
  }
  apply();
  return apply;
}
PANELS.history = {
  id: "history",
  async render(root) {
    const agentData = state.chat.agents.length ? { agents: state.chat.agents } : await api("/api/agents");
    histView.agents = (agentData.agents || []).filter((agent) => PERSONAS[agent.name] || agent.name.startsWith("main-"));
    const themeAgent = personaOfCat(
      document.body.dataset.themeCat || "premium",
      document.body.dataset.themePersona
    ).agent;
    const available = new Set(histView.agents.map((agent) => agent.name));
    // 每次进入 History 优先跟随 Main Chat 当前角色；直接打开 #history 时则跟随已保存的主题角色。
    // 页面内再用 PERSONA 下拉可独立查看另一位，不会反向改动主聊天。
    histView.agent = [state.chat.agent, themeAgent, histView.agent, DEFAULT_PERSONA]
      .find((agent) => agent && available.has(agent)) || histView.agents[0]?.name || DEFAULT_PERSONA;
    const data = await api(`/api/conversations/explorer?agentName=${encodeURIComponent(histView.agent)}`);
    if (data.enabled === false) {
      root.innerHTML = `<div class="panel-head"><h2>HISTORY</h2><span class="sub">// 会话历史</span></div><div class="empty">服务端未开启会话记忆（SESSIONS_ENABLED=false）。</div>`;
      return;
    }
    histView.sessions = (data.sessions || []).filter((session) => session.agentName === histView.agent);
    if (!histView.sel || !histView.sessions.some((s) => s.id === histView.sel)) histView.sel = histView.sessions[0]?.id || null;
    root.innerHTML = `
      <div class="panel-head"><h2>HISTORY</h2><span class="sub">// 每个角色独立归档 · 左选会话 · 右看全文</span>
        <span class="spacer"></span>
        <select class="chat-tool history-agent-select" id="histAgent" data-hs-label="PERSONA" title="选择要查看的角色历史">
          ${histView.agents.map((agent) => `<option value="${esc(agent.name)}">${esc(personaLabel(agent.name))} · ${esc(agent.name)}</option>`).join("")}
        </select>
        <button class="btn ghost icon" id="histRefresh" title="刷新">⟳</button></div>
      <div class="agents-layout history-layout">
        <aside class="agents-list-col"><div class="source-filter-host history-source-filter" id="histSourceTabs"></div><div class="agents-list" id="histList"></div></aside>
        <aside class="agents-detail" id="histDetail"><div class="empty">← 选一段会话查看</div></aside>
        <aside class="file-preview" id="filePreview" hidden aria-label="修改文件 · 只读预览"></aside>
      </div>`;
    $("#histAgent").value = histView.agent;
    $("#histAgent").addEventListener("change", async (event) => {
      histView.agent = event.target.value;
      histView.sel = null;
      histView.filter = "all";
      await loadHistoryAgentSessions();
    });
    $("#histRefresh").addEventListener("click", () => loadHistoryAgentSessions());
    renderHistList();
    if (histView.sel) renderHistDetail(histView.sel, histView.agent);
  },
};

async function loadHistoryAgentSessions() {
  if (!$("#histList")) return;
  closeFilePreview(false);
  histView.messages = [];
  const requestedAgent = histView.agent;
  const requestSeq = ++histView.requestSeq;
  const list = $("#histList");
  const detail = $("#histDetail");
  list.innerHTML = `<div class="empty">读取 ${esc(personaLabel(requestedAgent))} 的会话…</div>`;
  detail.innerHTML = `<div class="empty">读取中…</div>`;
  try {
    const data = await api(`/api/conversations/explorer?agentName=${encodeURIComponent(requestedAgent)}`);
    if (requestSeq !== histView.requestSeq || requestedAgent !== histView.agent) return;
    histView.sessions = (data.sessions || []).filter((session) => session.agentName === requestedAgent);
    if (!histView.sessions.some((session) => session.id === histView.sel)) histView.sel = histView.sessions[0]?.id || null;
    renderHistList();
    if (histView.sel) await renderHistDetail(histView.sel, requestedAgent);
    else detail.innerHTML = `<div class="empty">${esc(personaLabel(requestedAgent))} 暂无会话。</div>`;
  } catch (error) {
    if (requestSeq !== histView.requestSeq || requestedAgent !== histView.agent) return;
    list.innerHTML = `<div class="empty">会话读取失败</div>`;
    detail.innerHTML = `<div class="empty">⚠ ${esc(error.message)}</div>`;
  }
}
function renderHistList() {
  const box = $("#histList");
  if (!box) return;
  renderFilePreview();
  const tabs = $("#histSourceTabs");
  if (tabs) {
    wireSourceFilter(tabs, histView.sessions, histView.filter, (filter) => {
      histView.filter = filter;
      const filtered = sessionsInFilter(histView.sessions, histView.filter);
      if (!filtered.some((s) => s.id === histView.sel)) histView.sel = filtered[0]?.id || null;
      renderHistList();
      if (histView.sel) renderHistDetail(histView.sel, histView.agent);
      else $("#histDetail").innerHTML = `<div class="empty">该来源暂无会话。</div>`;
    });
  }
  const list = sessionsInFilter(histView.sessions, histView.filter);
  if (!list.length) { box.innerHTML = `<div class="empty">暂无会话。</div>`; return; }
  box.innerHTML = list.map((s) => {
    const activityAt = s.lastMessageAt || s.createdAt;
    const meta = `${s.messageCount}条${s.compactions ? " ·🗜" + s.compactions : ""}`;
    return `<button class="agent-row${s.id === histView.sel ? " active" : ""}" data-hist="${esc(s.id)}" title="${esc(s.title)}">
      <div class="ar-top"><span class="source-badge source-${esc(sessionSourceKind(s))}">${esc(sourceBadgeText(s))}</span><span class="ar-name">${esc(s.title)}</span>${s.active ? '<span class="badge">当前</span>' : ""}</div>
      <div class="ar-desc">${esc(sourceAccount(s))}${sourceAccount(s) ? " · " : ""}${esc(sourceWhere(s))}</div>
      <div class="ar-desc">${esc(meta)}${activityAt ? " · " + timeHtml(activityAt, "short") : ""}</div>
    </button>`;
  }).join("");
  box.querySelectorAll("[data-hist]").forEach((b) =>
    b.addEventListener("click", () => { histView.sel = b.dataset.hist; renderHistList(); renderHistDetail(b.dataset.hist, histView.agent); }));
}
async function refreshHistorySessions() {
  if (!$("#histList")) return;
  await loadHistoryAgentSessions();
}
async function renderHistDetail(id, requestedAgent = histView.agent) {
  const box = $("#histDetail");
  if (!box) return;
  closeFilePreview(false);
  histView.messages = [];
  box.innerHTML = `<div class="empty">读取中…</div>`;
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}`);
    // 角色切换/快速点选时，旧请求可能比新请求更晚返回；绝不能让上一角色详情覆盖当前页面。
    if (requestedAgent !== histView.agent || id !== histView.sel) return;
    if (session.agentName !== requestedAgent) {
      box.innerHTML = `<div class="empty">⚠ 会话归属不匹配，已阻止跨角色显示。</div>`;
      return;
    }
    const msgs = session.messages || [];
    histView.messages = msgs;
    const head = `<div class="hist-head"><div class="hist-persona">${esc(personaLabel(session.agentName))}<span>${esc(session.agentName)}</span></div><div class="hist-source"><span class="source-badge source-${esc(sessionSourceKind(session))}">${esc(sourceBadgeText(session))}</span><b>${esc(sourceAccount(session) || sourceBadgeText(session))}</b><span>${esc(sourceWhere(session))}</span></div><h3>${esc(session.title)}</h3><div class="muted" style="font-size:12.5px">${msgs.length} 条 · 压缩 ${session.compactions || 0} 次${session.readOnlyMirror ? " · 外部渠道镜像" : ""}</div></div>`;
    if (!msgs.length) { box.innerHTML = head + `<div class="empty">（空会话）</div>`; return; }
    box.innerHTML = head + `<div class="hist-msgs">` + msgs.map((m) => `
      <div class="chat-msg ${esc(m.role)}">
        <div class="chat-role">${m.role === "user" ? esc(userRoleLabel(m, session)) : personaLabel(session.agentName)}</div>
        <div class="chat-bubble">${m.role === "assistant" ? renderAssistantBubble(m.content) + messageFileChangesHtml(m, id) + (window.HarbourCalendar?.cardsHtml(m.calendarCards) || "") : esc(m.content)}</div>
      </div>`).join("") + `</div>`;
  } catch (e) {
    if (requestedAgent !== histView.agent || id !== histView.sel) return;
    box.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`;
  }
}

async function fillChatSkills(agentName) {
  const select = $("#chatSkill");
  if (!select) return;
  let skills = [];
  try {
    const data = await api(`/api/skills?agent=${encodeURIComponent(agentName)}`);
    skills = data.skills || [];
  } catch {
    skills = [];
  }
  select.innerHTML = `<option value="">自动选择技能</option>` + skills.map((s) =>
    `<option value="${esc(s.name)}">${esc(s.name)}${s.description ? " · " + esc(s.description.replace(/^`?[^`]+`?\s*[—-]\s*/, "")) : ""}</option>`
  ).join("");
  select.value = skills.some((s) => s.name === state.chat.skill) ? state.chat.skill : "";
}

// news 富渲染（修 reportId 瘦身回归）：assistant 短状态里带「报告存档ID：<id>」时，
// 后端把图/链接/摘要全文暂存在服务端、只回短状态；这里异步按 id 取回全文并挂到消息上，
// 让 chat 里也能富渲染出完整早报（不改后端瘦身，agent 上下文仍精简，仅展示层拉全文）。
const NEWS_ID_RE = /报告存档ID[:：]\s*(\S+)/;
async function enrichNewsReports() {
  for (const m of state.chat.messages) {
    if (m.role !== "assistant" || m.pending) continue;
    if (m.newsReport !== undefined) continue;   // 已处理（成功=全文；失败=null 占位，不再重试）
    const mm = NEWS_ID_RE.exec(m.content || "");
    if (!mm) continue;
    m.newsReport = null;                          // 先占位，避免并发重复请求
    try {
      const r = await api(`/api/news/report?id=${encodeURIComponent(mm[1])}`);
      if (r && r.markdown) { m.newsReport = r.markdown; renderChatMessages(); }
    } catch { /* 取不到（进程重启/已过期）：保留短状态 */ }
  }
}

/* ── 会话级 GOAL：跨轮持续、与普通聊天完全正交 ─────────────────── */
function isOpenChatGoal(goal = state.chat.goal) {
  return ["active", "blocked", "paused"].includes(goal?.status);
}

function chatGoalDraft() {
  const drafts = state.chat.goalDrafts ||= new Map();
  const edit = state.chat.goalEditor;
  const editing = edit?.sessionId === state.chat.sessionId && edit.goalId === state.chat.goal?.id && edit.detailSeq === state.chat.detailRequestSeq;
  const goal = editing ? state.chat.goal : null;
  const key = editing ? `edit:${edit.sessionId}:${edit.goalId}:${edit.revision}:${edit.detailSeq}` : chatDraftKey();
  if (!drafts.has(key)) drafts.set(key, {
    objective: goal?.objective || $("#chatInput")?.value.trim() || "", acceptanceText: goal?.acceptance?.join("\n") || "", autoContinue: goal ? goal.autoContinue === true : true,
    maxRounds: String(goal?.budget?.maxRounds || 20), maxTokens: goal?.budget?.maxTokens == null ? "" : String(goal.budget.maxTokens), verificationRequirement: goal?.verificationRequirement || "delivery",
  });
  return drafts.get(key);
}

function readChatGoalConfig(draft = chatGoalDraft()) {
  const objective = String(draft.objective || "").trim();
  if (!objective || objective.length > 4000) throw new Error("请填写明确目标（不超过 4000 字符）");
  const positiveInteger = (value, label) => {
    if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label}需要填写正整数`);
    return Number(value);
  };
  const acceptance = String(draft.acceptanceText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (acceptance.length > 24 || acceptance.some((line) => line.length > 1000)) throw new Error("验收条件最多 24 条，每条不超过 1000 字符");
  const maxRounds = positiveInteger(draft.maxRounds, "总轮数");
  if (maxRounds > 1000) throw new Error("总轮数最多 1000 轮（含首次）");
  const verificationRequirement = String(draft.verificationRequirement || "delivery");
  if (!["delivery", "recorded", "file_change", "user_acceptance"].includes(verificationRequirement)) throw new Error("请选择有效的验收方式");
  return { objective, acceptance, autoContinue: draft.autoContinue === true,
    budget: { maxRounds, maxTokens: String(draft.maxTokens || "").trim() ? positiveInteger(String(draft.maxTokens).trim(), "Token 上限") : null },
    verificationRequirement };
}

/** Cache only server-owned goal snapshots. A late REST reply cannot roll back a newer WS revision. */
function acceptChatGoalSnapshot(sessionId, incoming) {
  if (!sessionId || incoming?.id === "pending") return incoming || null;
  const snapshots = state.chat.goalSnapshots ||= new Map();
  const retired = state.chat.retiredGoalIds ||= new Map();
  const previous = snapshots.get(sessionId);
  let accepted = incoming || previous || null;
  if (previous && incoming) {
    const olderRevision = previous.id === incoming.id && Number(previous.revision || 0) > Number(incoming.revision || 0);
    const retiredId = retired.get(sessionId)?.has(incoming.id);
    const olderGoal = previous.id !== incoming.id && previous.createdAt && incoming.createdAt && incoming.createdAt < previous.createdAt;
    if (olderRevision || retiredId || olderGoal) accepted = previous;
    else if (previous.id !== incoming.id) {
      const ids = retired.get(sessionId) || new Set(); ids.add(previous.id); retired.set(sessionId, ids);
    }
  }
  if (accepted?.id) snapshots.set(sessionId, accepted);
  const local = state.chat.sessions?.find((row) => row.id === sessionId);
  if (local) local.goal = accepted;
  if (state.chat.sessionId === sessionId) state.chat.goal = accepted;
  if (state.chat.inspection?.id === sessionId && state.chat.inspection.session) state.chat.inspection.session.goal = accepted;
  return accepted;
}

function chatGoalVerificationLabel(goal) {
  const requirement = goal.verificationRequirement || (typeof goal.verification === "string" ? goal.verification : goal.verification?.requirement) || "delivery";
  return ({ delivery: "交付检查", recorded: "工具 / 文件证据", file_change: "确认文件修改", user_acceptance: "由你验收" })[requirement] || "交付检查";
}

function chatGoalDetailText(goal) {
  if (goal.waiting?.reason) return `等待：${goal.waiting.reason}`;
  if (goal.status === "paused") return "已暂停 · 本轮停止，断点与目标保留";
  if (goal.status === "blocked") return goal.progress || "等待补充条件后继续";
  if (goal.status === "completed") return goal.progress || "目标已完成";
  if (goal.status === "cancelled") return "已退出目标 · 普通聊天记录保留";
  const next = goal.nextStep;
  const action = ({ continue: "继续推进", execute: "继续执行", verify: "检查交付", wait: "等待条件", ask_user: "等待你的答复", complete: "检查是否完成" })[next?.action] || next?.action;
  return next?.reason ? `下一步：${next.reason}` : action ? `下一步：${action}` : goal.autoContinue !== true ? "自动续轮已关闭 · 等待你的下一条消息" : "按目标与验收条件持续推进";
}

function renderChatGoalConfig(host) {
  const draft = chatGoalDraft();
  const editing = state.chat.goalEditor?.sessionId === state.chat.sessionId && state.chat.goalEditor.goalId === state.chat.goal?.id && state.chat.goalEditor.detailSeq === state.chat.detailRequestSeq;
  const disabled = !!(state.chat.running || state.chat.readOnlyMirror || state.chat.inspection || state.chat.switchingSession || state.chat.goalActionPending);
  host.innerHTML = `<form class="goal-config" aria-label="设置持续目标">
    <div class="goal-config-head"><b><span aria-hidden="true">◎</span> ${editing ? "调整 GOAL 预算" : "设置 GOAL"}</b><button type="button" class="goal-config-close" aria-label="关闭目标设置">×</button></div>
    <label class="goal-field"><span>目标</span><textarea name="objective" rows="2" maxlength="4000" placeholder="最终要交付什么？" ${editing ? "readonly" : "required"}>${esc(draft.objective)}</textarea></label>
    <label class="goal-field"><span>验收条件 <small>${editing ? "保持既定要求" : "选填，每行一条"}</small></span><textarea name="acceptanceText" rows="2" ${editing ? "readonly" : ""} placeholder="哪些结果出现才算完成？">${esc(draft.acceptanceText)}</textarea></label>
    <div class="goal-config-options">
      <label class="goal-auto"><input name="autoContinue" type="checkbox" ${draft.autoContinue ? "checked" : ""}><span>自动续轮<small>未完成时由后台继续</small></span></label>
      <label class="goal-field"><span>总轮数 <small>含首次</small></span><input name="maxRounds" type="number" inputmode="numeric" min="1" max="1000" step="1" required value="${esc(draft.maxRounds)}"></label>
      <label class="goal-field"><span>Token 上限 <small>选填</small></span><input name="maxTokens" type="number" inputmode="numeric" min="1" step="1" placeholder="不另设上限" value="${esc(draft.maxTokens)}"></label>
    </div>
    <details class="goal-config-advanced"><summary>验收方式</summary><label class="goal-field"><select name="verificationRequirement" aria-label="验收方式" ${editing ? "disabled" : ""}>${[["delivery", "交付检查"], ["recorded", "工具 / 文件证据"], ["file_change", "确认文件修改"], ["user_acceptance", "由我验收"]].map(([value, label]) => `<option value="${value}" ${draft.verificationRequirement === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><small>工具记录不等于测试通过；文件修改也不代表已通过验收。</small></details>
    <div class="goal-config-footer"><small>${editing ? "只调整预算与自动续轮，目标和验收要求不变。保存不会自动恢复执行。" : "开启后沿用当前会话、模型与权限；首轮使用下方消息，留空则使用目标。"}</small><button class="btn primary" type="submit" ${disabled ? "disabled" : ""}>${editing ? "保存预算" : "开始 GOAL"}</button></div>
  </form>`;
  const form = host.querySelector("form");
  const save = (event) => {
    const control = event.target;
    if (Object.hasOwn(draft, control.name)) draft[control.name] = control.type === "checkbox" ? control.checked : control.value;
  };
  form.addEventListener("input", save); form.addEventListener("change", save);
  form.addEventListener("submit", (event) => { event.preventDefault(); void startChatGoal(); });
  form.querySelector(".goal-config-close").onclick = toggleChatGoal;
  form.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); toggleChatGoal(); $("#chatGoal")?.focus(); } });
}

async function startChatGoal() {
  if (!state.chat.goalArmed || state.chat.running || state.chat.readOnlyMirror || state.chat.inspection) return;
  let config;
  try { config = readChatGoalConfig(); } catch (error) { return toast(error.message, true); }
  const edit = state.chat.goalEditor;
  if (edit) {
    if (edit.sessionId !== state.chat.sessionId || edit.goalId !== state.chat.goal?.id || edit.detailSeq !== state.chat.detailRequestSeq || edit.revision !== state.chat.goal.revision) return toast("目标状态已更新，请关闭设置后重新调整预算。", true);
    return changeChatGoal("configure", { budget: config.budget, autoContinue: config.autoContinue });
  }
  await executeChat();
}

function editChatGoalBudget() {
  if (!["paused", "blocked"].includes(state.chat.goal?.status) || state.chat.running || state.chat.readOnlyMirror || state.chat.inspection || state.chat.goalActionPending || state.chat.switchingSession) return;
  state.chat.goalEditor = { sessionId: state.chat.sessionId, goalId: state.chat.goal.id, revision: state.chat.goal.revision, detailSeq: state.chat.detailRequestSeq };
  state.chat.goalArmed = true;
  renderChatGoal();
}

function renderChatGoal() {
  const host = document.getElementById("chatGoalBar");
  const button = document.getElementById("chatGoal");
  const goal = acceptChatGoalSnapshot(state.chat.sessionId, state.chat.goal);
  const open = isOpenChatGoal(goal);
  const editing = state.chat.goalEditor?.sessionId === state.chat.sessionId && state.chat.goalEditor.goalId === goal?.id && state.chat.goalEditor.detailSeq === state.chat.detailRequestSeq;
  if (button) {
    button.classList.toggle("is-armed", !!state.chat.goalArmed && !open);
    button.classList.toggle("is-active", open);
    button.setAttribute("aria-pressed", String(open || !!state.chat.goalArmed));
    button.title = open
      ? "当前会话已有持续目标"
      : state.chat.goalArmed ? "关闭目标设置（草稿保留）" : "设置目标、验收条件与自动续轮预算";
    button.setAttribute("aria-expanded", String(editing || (!!state.chat.goalArmed && !open)));
  }
  if (!host) return;
  if (!goal && !state.chat.goalArmed) { host.innerHTML = ""; return; }

  if (editing || (state.chat.goalArmed && !open)) {
    renderChatGoalConfig(host);
    return;
  }

  const status = ({ active: "GOAL 进行中", blocked: "GOAL 等待条件", paused: "GOAL 已暂停", completed: "GOAL 已完成", cancelled: "GOAL 已退出" })[goal.status] || "GOAL";
  const waiting = goal.status === "blocked" || goal.status === "paused" || !!goal.waiting;
  const usage = goal.usage || {}, budget = goal.budget || {};
  const tokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens.toLocaleString() : "—";
  const rounds = Number.isFinite(usage.roundsStarted) ? usage.roundsStarted : 0;
  const metrics = `${rounds}${Number.isFinite(budget.maxRounds) ? ` / ${budget.maxRounds}` : ""} 轮 · 累计 ${tokens}${Number.isFinite(budget.maxTokens) ? ` / ${budget.maxTokens.toLocaleString()}` : ""} tok`;
  const readonly = state.chat.readOnlyMirror || !!state.chat.inspection;
  const busy = !!state.chat.goalActionPending || state.chat.switchingSession || goal.id === "pending";
  const acceptance = Array.isArray(goal.acceptance) ? goal.acceptance : [];
  const detailsOpen = host.querySelector(".goal-evidence")?.open === true;
  host.innerHTML = `<div class="goal-chip ${waiting ? "is-blocked" : open ? "is-active" : "is-terminal"}">
    <span class="goal-mark" aria-hidden="true">${waiting ? "◇" : goal.status === "completed" ? "✓" : "◎"}</span>
    <div class="goal-copy"><b>${status}</b><span class="goal-objective" title="${esc(goal.objective)}">${esc(goal.objective)}</span>
      <span class="goal-next" title="${esc(chatGoalDetailText(goal))}">${esc(chatGoalDetailText(goal))}</span>
      <small class="goal-budget" title="跨轮累计包含缓存 token，以服务端统计为准；不是当前上下文占用。">${esc(metrics)} · ${goal.autoContinue === true ? "自动续轮" : "手动续轮"}${readonly ? " · 只读" : ""}</small>
      <details class="goal-evidence" ${detailsOpen ? "open" : ""}><summary>验收与预算</summary><div><p>${esc(chatGoalDetailText(goal))}</p>${acceptance.length ? `<ul>${acceptance.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p>未单列验收条件，以目标交付要求为准。</p>`}<p>${esc(chatGoalVerificationLabel(goal))} · 已完成 ${Number.isFinite(usage.roundsCompleted) ? usage.roundsCompleted : 0} 轮${Number.isFinite(budget.maxTokens) ? "" : " · 未另设 token 上限"}</p><p class="goal-evidence-note">工具记录不等于测试通过；累计 token 包含缓存。暂停会停止本轮并保留断点。</p></div></details>
    </div>
    ${open && !readonly ? `<div class="goal-actions">
      ${goal.status === "paused" || goal.status === "blocked" ? `<button type="button" class="goal-resume" data-goal-action="resume" ${busy || state.chat.running ? "disabled" : ""}>恢复</button>` : `<button type="button" class="goal-pause" data-goal-action="pause" ${busy ? "disabled" : ""} title="停止本轮并保留断点">暂停</button>`}
      ${goal.status === "paused" || goal.status === "blocked" ? `<button type="button" class="goal-settings" ${busy || state.chat.running ? "disabled" : ""}>调整预算</button>` : ""}
      <button type="button" class="goal-complete" data-goal-action="complete" ${busy || state.chat.running ? "disabled" : ""}>标记完成</button>
      <button type="button" class="goal-cancel" data-goal-action="cancel" ${busy ? "disabled" : ""}>退出</button>
    </div>` : ""}
  </div>`;
  host.querySelectorAll("[data-goal-action]").forEach((action) => action.addEventListener("click", () => changeChatGoal(action.dataset.goalAction)));
  host.querySelector(".goal-settings")?.addEventListener("click", editChatGoalBudget);
}

function toggleChatGoal() {
  if (state.chat.running || state.chat.readOnlyMirror || state.chat.inspection || state.chat.switchingSession || state.chat.goalActionPending) return;
  if (state.chat.goalEditor?.sessionId === state.chat.sessionId && state.chat.goalEditor.goalId === state.chat.goal?.id && state.chat.goalEditor.detailSeq === state.chat.detailRequestSeq) {
    state.chat.goalEditor = null; state.chat.goalArmed = false; renderChatGoal(); return;
  }
  state.chat.goalEditor = null;
  if (isOpenChatGoal()) {
    document.getElementById("chatInput")?.focus();
    return toast("当前会话已有 GOAL；可在目标卡里暂停、恢复或退出。", false);
  }
  state.chat.goalArmed = !state.chat.goalArmed;
  renderChatGoal();
  if (state.chat.goalArmed) document.querySelector('#chatGoalBar [name="objective"]')?.focus();
}

async function changeChatGoal(action, patch = {}) {
  if (!["pause", "resume", "cancel", "complete", "configure"].includes(action) || !state.chat.sessionId || !isOpenChatGoal()
    || state.chat.readOnlyMirror || state.chat.inspection || state.chat.switchingSession || state.chat.goalActionPending
    || state.chat.goal.id === "pending" || (state.chat.running && (action === "resume" || action === "complete" || action === "configure"))
    || (action === "configure" && !["paused", "blocked"].includes(state.chat.goal.status))) return;
  const binding = { sessionId: state.chat.sessionId, goalId: state.chat.goal.id, revision: Number(state.chat.goal.revision || 0),
    agent: state.chat.agent, detailSeq: state.chat.detailRequestSeq };
  const current = () => state.chat.sessionId === binding.sessionId && state.chat.agent === binding.agent
    && state.chat.goal?.id === binding.goalId && state.chat.detailRequestSeq === binding.detailSeq && !state.chat.inspection && !state.chat.readOnlyMirror;
  const labels = { pause: "暂停 GOAL", resume: "恢复 GOAL", complete: "标记完成", cancel: "退出 GOAL" };
  state.chat.goalActionPending = binding;
  renderChatGoal();
  try {
    if (action !== "resume" && action !== "configure") {
      const message = action === "pause" ? "暂停会立即停止本轮，保留目标和断点。之后可恢复后台执行。"
        : action === "complete" ? "确认目标与验收条件已经满足？这会停止后续自动续轮。" : "退出当前 GOAL 并停止后续推进？普通聊天记录会保留。";
      if (!await harbourConfirm(message, { title: labels[action], confirmLabel: labels[action], tone: action === "complete" ? "accent" : "warning" })) return;
    }
    if (!current() || Number(state.chat.goal.revision || 0) !== binding.revision) return;
    const { session } = await api(`/api/conversations/${encodeURIComponent(binding.sessionId)}/goal`, {
      method: "POST",
      body: JSON.stringify({ action, goalId: binding.goalId, expectedRevision: binding.revision,
        ...(action === "configure" ? { budget: patch.budget, autoContinue: patch.autoContinue } : {}) }),
    });
    if (!current() || session?.id !== binding.sessionId || session.goal?.id !== binding.goalId) return;
    acceptChatGoalSnapshot(binding.sessionId, session.goal);
    state.chat.goalEditor = null;
    state.chat.goalArmed = false;
    renderSessionList();
    toast({ pause: "GOAL 已暂停，正在保留断点", resume: "GOAL 已恢复，后台继续执行", complete: "GOAL 已完成", cancel: "已退出 GOAL", configure: "预算已保存；需要继续时请点恢复" }[action]);
  } catch (error) {
    if (current()) toast(error.message, true);
  } finally {
    if (state.chat.goalActionPending === binding) state.chat.goalActionPending = null;
    renderChatGoal();
  }
}

function handleChatGoalEvent(event) {
  const sessionId = String(event.sessionId || "");
  if (!sessionId) return;
  if (event.type === "goal:updated") {
    acceptChatGoalSnapshot(sessionId, event.goal);
    if (state.chat.sessionId === sessionId) renderChatGoal();
    renderSessionList();
  } else if (event.type === "goal:turn" || event.type === "goal:error") {
    // Reuse the bound detail loader, never switch the backend's active session.
    if (state.chat.inspection?.id === sessionId) void inspectChatSession(sessionId, true);
    else if (state.chat.sessionId === sessionId) {
      if (state.chat.running) state.chat.goalReloadSessionId = sessionId;
      else void loadConversationMessages(sessionId);
    }
  }
}

/* Legacy session-plan fallback. New run plans live beside their execution rings. */
function renderChatPlan() {
  const host = document.getElementById("chatPlan");
  const p = state.chat.plan;
  if (!host) return;
  if (!p) { host.innerHTML = ""; return; }
  const traces = [...(state.chat.trace || []), ...(state.chat.messages || []).flatMap(m => m.trace || [])];
  if (window.HarbourTrace && traces.some(e => e.plan && (!p.id || e.plan.id === p.id) || p.id && e.progress?.id === p.id)) {
    host.innerHTML = ""; return;
  }
  const done = state.chat.planDone || {};
  const total = (p.steps || []).length;
  const doneN = (p.steps || []).filter((s) => done[s.n]).length;

  const steps = (p.steps || []).map((s) => `<li class="plan-step${done[s.n] ? " is-done" : ""}">
      <span class="plan-mark"></span>
      <span class="plan-title">${esc(s.title)}</span>
      ${s.agent ? `<span class="plan-agent">${esc(s.agent)}</span>` : ""}
      ${s.capabilities?.length ? `<span class="plan-capabilities">能力建议：${s.capabilities.map(esc).join(" · ")}</span>` : ""}
      ${s.detail ? `<span class="plan-detail">${esc(s.detail)}</span>` : ""}
    </li>`).join("");
  const extra = (title, arr, cls) => (arr && arr.length)
    ? `<div class="plan-extra ${cls}"><b>${title}</b><ul>${arr.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";

  // 仅兼容没有结构化进度事件的旧会话；显示确认完成项数，不推测当前步骤。
  host.innerHTML = `<span class="plan-chip" tabindex="0" title="执行计划（悬停查看）" aria-label="执行计划">
      <span class="plan-dot"></span><span class="plan-count">${doneN} / ${total} 项完成</span>
      <span class="plan-pop">
        <span class="plan-pop-head"><b>执行计划</b><span class="plan-by">${esc(p.by || "orchestrator")}</span>
          <span class="spacer"></span><button type="button" class="plan-x" title="收起">✕</button></span>
        <span class="plan-goal">${esc(p.goal || "")}</span>
        <ol class="plan-steps">${steps}</ol>
        ${extra("风险 / 不可逆", p.risks, "is-risk")}
        ${extra("待澄清", p.clarifications, "is-ask")}
      </span>
    </span>`;
  host.querySelector(".plan-x")?.addEventListener("click", (e) => {
    e.stopPropagation();
    state.chat.plan = null; renderChatPlan();
    // 收起也落盘（显式把后端 plan 清成 null，否则刷新又冒出来）。
    if (state.chat.sessionId) {
      api(`/api/conversations/annotate`, { method: "POST", body: JSON.stringify({ key: state.chat.sessionKey, id: state.chat.sessionId, plan: null }) }).catch(() => {});
    }
  });
}

/** 停止后的 durable checkpoint：常驻一条紧凑恢复条，不把执行账本塞满聊天区。 */
function renderChatCheckpoint() {
  const host = document.getElementById("chatCheckpoint");
  const cp = state.chat.checkpoint;
  if (!host) return;
  if (!cp || cp.status !== "interrupted") { host.innerHTML = ""; return; }
  const completed = Number(cp.completed || 0);
  const replayable = Number(cp.replayable || 0);
  const pending = Number(cp.pending || 0);
  const next = cp.nextStep
    ? `下一步：#${cp.nextStep.sequence} ${cp.nextStep.agent} → ${cp.nextStep.tool}`
    : "下一步：从停止位置继续收尾";
  host.innerHTML = `<div class="checkpoint-chip" title="${esc(next)}">
      <span class="checkpoint-mark">↻</span>
      <span class="checkpoint-copy"><b>任务已停在断点</b><span>${completed} 步已保存${replayable ? ` · ${replayable} 步可直接回放` : ""}${pending ? ` · ${pending} 步未完成` : ""}</span></span>
      <span class="checkpoint-actions">
        <button type="button" class="checkpoint-discard" title="放弃此任务并删除已保存的断点" ${state.chat.running ? "disabled" : ""}>放弃</button>
        <button type="button" class="checkpoint-resume" ${state.chat.running ? "disabled" : ""}>继续 <kbd>↵</kbd></button>
      </span>
    </div>`;
  host.querySelector(".checkpoint-discard")?.addEventListener("click", discardChatCheckpoint);
  host.querySelector(".checkpoint-resume")?.addEventListener("click", () => {
    if (state.chat.running) return;
    const input = document.getElementById("chatInput");
    if (input) input.value = "继续";
    executeChat();
  });
}

/** 放弃已经停止的任务：删除 durable checkpoint + 这轮计划，并移除 UI 的恢复态消息。 */
async function discardChatCheckpoint() {
  const id = state.chat.sessionId;
  const checkpointId = state.chat.checkpoint?.id;
  if (!id || !checkpointId || state.chat.running) return;
  if (!await harbourConfirm("已保存的工具进度和断点会被删除，之后无法再点“继续”恢复。", {
    title: "放弃这个未完成任务？",
    detail: "此操作只删除该任务的恢复断点，不会删除已经显示在会话中的消息与 Trace。",
    confirmLabel: "放弃任务",
    tone: "danger",
  })) return;
  document.querySelectorAll("#chatCheckpoint button").forEach((button) => { button.disabled = true; });
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}/checkpoint`, { method: "DELETE" });
    // 请求期间若用户已经切到别的会话，不拿旧详情覆盖当前聊天区。
    if (state.chat.sessionId === id) applySessionDetail(session);
    await refreshSessionList();
    toast("已放弃任务并删除断点");
  } catch (error) {
    if (state.chat.sessionId === id && state.chat.checkpoint?.id === checkpointId) renderChatCheckpoint();
    toast(error.message, true);
  }
}

/** abort fetch 会先于服务端落盘返回；稍后只同步 checkpoint，不覆盖本地的停止气泡。 */
async function syncActiveCheckpoint(attempt = 0, id = state.chat.sessionId) {
  if (!id || state.chat.sessionId !== id || state.chat.running) return;
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (state.chat.sessionId !== id || session.id !== id || state.chat.running) return;
    // 客户端 AbortError 往往比 SDK 子进程完全退出早几十到几百毫秒。服务端若暂时仍报 running，
    // 保留本地 interrupted 提示并短暂重试，不能反过来把恢复条冲没。
    if (session.checkpoint?.status === "interrupted") state.chat.checkpoint = session.checkpoint;
    else if (!session.checkpoint && state.chat.checkpoint?.status !== "interrupted") state.chat.checkpoint = null;
    if (session.plan) state.chat.plan = session.plan;
    renderChatCheckpoint();
    renderChatPlan();
    await refreshSessionList();
    if (session.checkpoint?.status === "running" && attempt < 5) {
      setTimeout(() => syncActiveCheckpoint(attempt + 1, id), 260 + attempt * 120);
    }
  } catch { /* 停止反馈不依赖这次只读同步 */ }
}

/* 点自己的头像 → 选图 → 存 localStorage（不上服务器：头像是本地观感）。
   事件委托挂在 stream 上，因为消息是整体重渲染的，逐个绑会随重渲染丢失。 */
function wireUserAvatarUpload(stream) {
  if (!stream || stream.dataset.avWired) return;
  stream.dataset.avWired = "1";
  stream.addEventListener("click", (e) => {
    if (!e.target.closest(".chat-avatar.is-user")) return;
    const f = document.createElement("input");
    f.type = "file"; f.accept = "image/*";
    f.addEventListener("change", () => {
      const file = f.files?.[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = () => { setUserAvatar(String(r.result)); toast("头像已更新（存在本机）"); };
      r.readAsDataURL(file);
    });
    f.click();
  });
}

/* 已确认文件变更是消息元数据，不从正文/Trace 猜路径，也不直接打开任意本地 URL。 */
function normalizedFileChanges(message) {
  if (message?.role !== "assistant" || message.pending || !Array.isArray(message.fileChanges)) return [];
  const seen = new Set();
  return message.fileChanges.filter((file) => {
    if (!file || typeof file.id !== "string" || !file.id || typeof file.path !== "string" || !file.path
      || !["created", "modified", "deleted", "renamed"].includes(file.kind) || seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
}

function fileChangeKindLabel(kind) {
  return ({ created: "新增", modified: "修改", deleted: "删除", renamed: "重命名" })[kind] || "修改";
}

function messageFileChangesHtml(message, sessionId) {
  const changes = normalizedFileChanges(message);
  if (!changes.length || !sessionId) return "";
  return `<div class="message-file-changes"><div class="file-changes-label">修改了 <b>${changes.length}</b> 个文件</div><div class="file-changes-chips">${changes.map((file) => {
    const basename = file.path.replace(/\\/g, "/").split("/").pop() || file.path;
    const remote = file.location === "remote" || (file.deviceId && file.deviceId !== "server");
    const device = file.deviceLabel || (remote ? "远端" : "");
    return `<button type="button" class="file-change-chip" data-file-change="${esc(file.id)}" data-file-session="${esc(sessionId)}" title="${esc(file.path)}${device ? ` · ${esc(device)}` : ""}" aria-label="${esc(fileChangeKindLabel(file.kind))}：${esc(file.path)}，打开只读预览" aria-controls="filePreview"><span class="file-change-kind" data-kind="${esc(file.kind)}">${fileChangeKindLabel(file.kind)}</span><span class="file-change-name">${esc(basename)}</span>${device ? `<span class="file-change-device">${esc(device)}</span>` : ""}</button>`;
  }).join("")}</div></div>`;
}

function filePreviewContext() {
  const panel = document.body.dataset.panel;
  return panel === "history"
    ? { panel, sessionId: histView.sel, agent: histView.agent, navigationSeq: histView.requestSeq }
    : { panel, sessionId: viewedChatSessionId(), agent: state.chat.agent, navigationSeq: state.chat.detailRequestSeq };
}

function isCurrentFilePreview(selection) {
  if (!selection || state.filePreview !== selection || selection.requestSeq !== state.filePreviewRequestSeq) return false;
  const context = filePreviewContext();
  return ["panel", "sessionId", "agent", "navigationSeq"].every((key) => context[key] === selection[key]);
}

function closeFilePreview(restoreFocus = true) {
  const previous = state.filePreview;
  state.filePreview = null;
  state.filePreviewRequestSeq = (state.filePreviewRequestSeq || 0) + 1;
  const host = $("#filePreview");
  if (host) { host.hidden = true; host.innerHTML = ""; host._previewResult = null; }
  document.querySelectorAll(".has-file-preview").forEach((layout) => layout.classList.remove("has-file-preview"));
  if (!restoreFocus || !previous) return;
  const opener = previous.opener?.isConnected ? previous.opener : Array.from(document.querySelectorAll("[data-file-change]")).find((button) =>
    button.dataset.fileChange === previous.file.id && button.dataset.fileSession === previous.sessionId);
  opener?.focus({ preventScroll: true });
}

function filePreviewBodyHtml(result) {
  const status = result?.status || "unavailable";
  if (status === "text" && typeof result.content === "string") {
    // 服务端已有大小限制；展示层再限制 DOM 行数，错误端点也不能卡死聊天。
    const lines = result.content.replace(/\r\n?/g, "\n").split("\n");
    if (result.content.length > 1024 * 1024 || lines.length > 20000) return filePreviewBodyHtml({ status: "too_large" });
    return `${result.content ? "" : '<div class="file-preview-empty">空文件</div>'}<pre class="file-preview-code" tabindex="0" aria-label="当前文件内容，只读，带行号"><code>${lines.map((line, index) => `<span class="file-preview-line"><span class="file-preview-line-number" aria-hidden="true">${index + 1}</span><span class="file-preview-line-text">${esc(line) || "\u200b"}</span></span>`).join("")}</code></pre>`;
  }
  const messages = {
    loading: ["正在读取文件…", "只读取所选会话记录中已确认的文件。"],
    deleted: ["文件已不存在", "保留本轮变更记录；当前磁盘上没有可预览的文件。"],
    binary: ["二进制文件", "此面板只预览文本，不执行或打开文件。"],
    too_large: ["文件过大", "为保持聊天流畅，暂不载入此文件。"],
    remote_unavailable: ["远端文件暂不可预览", "文件位于执行设备上；不会用服务端的同名路径代替读取。"],
    unavailable: ["文件暂不可预览", "文件位置不可用、已移动，或超出允许读取的范围。"],
    error: ["读取失败", "请稍后重试；没有修改任何文件。"],
  };
  const [title, description] = messages[status] || messages.unavailable;
  return `<div class="file-preview-state" role="status"><span class="file-preview-state-icon" aria-hidden="true">${status === "loading" ? "◌" : "◇"}</span><b>${title}</b><p>${description}</p>${result?.reason ? `<p class="file-preview-reason">${esc(String(result.reason).slice(0, 500))}</p>` : ""}${status === "error" || status === "unavailable" || status === "remote_unavailable" ? '<button type="button" class="btn ghost" data-file-preview-retry>重新读取</button>' : ""}</div>`;
}

function renderFilePreview() {
  const host = $("#filePreview");
  if (!host) return;
  const selection = state.filePreview;
  if (!isCurrentFilePreview(selection)) { if (selection || !host.hidden) closeFilePreview(false); return; }
  host.hidden = false;
  host.closest(".chat-layout, .history-layout")?.classList.add("has-file-preview");
  if (host._previewResult === selection.result) return;
  const focusId = host.contains(document.activeElement) ? document.activeElement.id : "";
  host._previewResult = selection.result;
  const file = selection.file;
  const remote = file.location === "remote" || (file.deviceId && file.deviceId !== "server");
  const device = file.deviceLabel || (remote ? "远端" : "");
  host.innerHTML = `<header class="file-preview-head"><div class="file-preview-eyebrow">FILE <span>只读预览</span></div><button type="button" class="btn ghost icon" id="filePreviewClose" data-file-preview-close title="关闭预览（Esc）" aria-label="关闭文件预览">×</button><div class="file-preview-path">${esc(file.path)}</div><div class="file-preview-meta"><span class="file-change-kind" data-kind="${esc(file.kind)}">${fileChangeKindLabel(file.kind)}</span>${device ? `<span>${esc(device)}</span>` : ""}<span>当前文件 · 非历史快照</span></div>${file.oldPath ? `<div class="file-preview-old-path">原路径：${esc(file.oldPath)}</div>` : ""}</header><div class="file-preview-body" aria-busy="${selection.result.status === "loading"}">${filePreviewBodyHtml(selection.result)}</div><footer class="file-preview-footer">仅收录已确认的文件修改；Shell 间接改动可能未收录。</footer>`;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

async function openFilePreview(sessionId, file, opener = null) {
  const context = filePreviewContext();
  if (!$("#filePreview") || !sessionId || sessionId !== context.sessionId || !normalizedFileChanges({ role: "assistant", fileChanges: [file] }).length) return;
  const selection = { ...context, file, opener, requestSeq: (state.filePreviewRequestSeq || 0) + 1, result: { status: "loading" } };
  state.filePreviewRequestSeq = selection.requestSeq;
  state.filePreview = selection;
  renderFilePreview();
  $("#filePreviewClose")?.focus({ preventScroll: true });
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`);
    if (!isCurrentFilePreview(selection)) return;
    if (!result?.file || result.file.id !== file.id || result.file.path !== file.path || result.view !== "current") throw new Error("文件归属不匹配，已阻止显示");
    selection.result = result;
  } catch (error) {
    if (!isCurrentFilePreview(selection)) return;
    selection.result = { status: "error", reason: error.message || "请求失败" };
  }
  if (isCurrentFilePreview(selection)) renderFilePreview();
}

function initFilePreview() {
  document.addEventListener("click", (event) => {
    const close = event.target.closest?.("[data-file-preview-close]");
    if (close) { closeFilePreview(); return; }
    const retry = event.target.closest?.("[data-file-preview-retry]");
    if (retry && state.filePreview) { const s = state.filePreview; void openFilePreview(s.sessionId, s.file, s.opener); return; }
    const button = event.target.closest?.("[data-file-change]");
    if (!button) return;
    event.preventDefault();
    const messages = document.body.dataset.panel === "history" ? histView.messages : viewedChatMessages();
    const file = (messages || []).flatMap(normalizedFileChanges).find((entry) => entry.id === button.dataset.fileChange);
    if (file) void openFilePreview(button.dataset.fileSession, file, button);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !state.filePreview || $("#filePreview")?.hidden !== false) return;
    event.preventDefault();
    closeFilePreview();
  });
}

function renderChatMessages() {
  const stream = $("#chatStream");
  if (!stream) return;
  document.body.dataset.chatLanding = String(!!state.chat.landing && !state.chat.inspection);
  renderFilePreview();
  wireUserAvatarUpload(stream);
  const inspection = state.chat.inspection;
  stream.classList.remove("is-empty");
  if (inspection && (inspection.error || (inspection.loading && !inspection.session))) {
    stream.innerHTML = `<div class="empty" role="status">${inspection.error ? `⚠ ${esc(inspection.error)} · 可点下方刷新重试` : "正在读取会话…"}</div>`;
    if ($("#chatRail")) $("#chatRail").innerHTML = "";
    return;
  }
  const messages = viewedChatMessages();
  if (!messages.length) {
    stream.classList.add("is-empty");
    const welcomeTitle = inspection || state.chat.readOnlyMirror ? "这里还没有对话" : "今天，想一起做点什么？";
    // Background state updates must not replay the welcome's entrance animation.
    if (stream.querySelector(".chat-welcome h1")?.textContent !== welcomeTitle) stream.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 37 19-21 15 21H12l9 11h22l9-11H31V16m-12 8 12 13 15-12M16 54c6-3 10 3 16 0s10 3 16 0M49 10v8m-4-4h8"/></svg></div>
        <h1>${welcomeTitle}</h1>
      </div>`;
    if ($("#chatRail")) $("#chatRail").innerHTML = "";
    return;
  }
  // 智能滚动：只在用户本来就贴着底部时才自动跟到最新（上翻查看历史时不打断）。
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  stream.innerHTML = messages.map((m, i) => {
    // 系统提示（如压缩通知）：居中、低调的一行，不算对话气泡。
    if (m.role === "notice") return `<div class="chat-notice" data-mi="${i}">${esc(m.content)}</div>`;
    const atts = (m.attachments || []).map(attachmentHtml).join("");
    const fileChanges = messageFileChangesHtml(m, viewedChatSessionId());
    const calendarCards = m.role === "assistant" && !m.pending ? window.HarbourCalendar?.cardsHtml(m.calendarCards) || "" : "";
    // 会话恢复、异常收尾或旧客户端数据若留下一个完全没有正文/Trace/附件的 assistant 槽，
    // 展示层直接忽略；空白气泡既没有信息，也很容易被误认成装饰分隔条。
    const hasAssistantPayload = !!String(m.content || "").trim()
      || !!String(m.newsReport || "").trim()
      || !!(Array.isArray(m.trace) && m.trace.length)
      || !!atts || !!fileChanges || !!calendarCards;
    if (m.role === "assistant" && !m.pending && !hasAssistantPayload) return "";
    // pending 气泡：运行轨迹实时嵌在回复里（像 CC）——上方展开的 trace + 打字指示。
    if (m.pending) {
      const who = m.agent || state.chat.agent;
      const elapsed = m.runStartedAt ? (m.runEndedAt || Date.now()) - m.runStartedAt : 0;
      const liveTrace = Array.isArray(m.trace) ? m.trace : state.chat.trace;
      const activity = String(m.activity || "").trim() || "思考中…";
      const runAttr = m.externalRunId ? ` data-channel-run="${esc(m.externalRunId)}"` : "";
      const traceAttr = m.externalRunId ? ` data-channel-trace="${esc(m.externalRunId)}"` : ` id="pendingTrace"`;
      const activityAttr = m.externalRunId ? ` data-channel-activity="${esc(m.externalRunId)}"` : ` id="pendingActivity"`;
      const durationAttr = m.externalRunId ? ` data-channel-duration="${esc(m.externalRunId)}"` : ` id="pendingDuration"`;
      return `<div class="chat-msg assistant pending" data-mi="${i}">
        ${avatarHtml("assistant", who)}
        <div class="chat-role">${personaLabel(who)}</div>
        <div class="chat-bubble"${runAttr}>
          <div class="pending-activity-row" role="status" aria-live="polite">
            <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="pending-activity"${activityAttr}>${esc(activity)}</span>
            <span class="pending-duration"${durationAttr} title="本次回答已运行时间"><span class="pending-duration-icon" aria-hidden="true">◷</span><span>${esc(formatRunDuration(elapsed, true))}</span></span>
            ${m.externalRunId ? channelStopButtonHtml(m.externalRunId) : ""}
          </div>
          <div class="chat-trace-live"${traceAttr} data-progress-message="${i}" data-trace-agent="${esc(who)}" role="region" aria-label="实时执行进度与细节">${window.HarbourTrace ? "" : traceRowsHtml(liveTrace)}</div>
        </div>
      </div>`;
    }
    // 用户消息纯转义；Harbour 回答里若引用了图片/视频/语音/文件链接，渲染成可视媒体（出站多模态）。
    let body;
    if (m.role === "assistant" && m.newsReport) {
      // news 富渲染（修 reportId 瘦身回归）：短状态去掉「报告存档ID」行做引子，下方折叠展开富渲染全文（图/链接/摘要）。
      const lead = renderAssistantBubble((m.content || "").replace(NEWS_ID_RE, "").trim());
      const full = renderAssistantBubble(m.newsReport);
      body = `${lead}<details class="news-full" open><summary>📄 完整早报（图 / 链接 / 摘要）</summary>${full}</details>`;
    } else {
      body = m.content ? (m.role === "assistant" ? renderAssistantBubble(m.content) : esc(m.content)) : "";
    }
    // 跑完的 assistant 回复：把本轮运行轨迹收进一个默认折叠的 details，放在答案上方（可展开回看）。
    const runDuration = Number.isFinite(m.durationMs)
      ? `<span class="ct-duration" title="本次回答总运行时间：${esc(formatRunDuration(m.durationMs))}"><span class="ct-duration-icon" aria-hidden="true">◷</span><span>${esc(formatRunDuration(m.durationMs))}</span></span>`
      : "";
    const traceEl = (m.role === "assistant" && m.trace && m.trace.length)
      ? `<details class="chat-trace"><summary><span class="ct-sum-tag">过程</span><span class="ct-sum-copy">查看执行回顾</span>${runDuration}</summary><div class="chat-trace-body" data-progress-message="${i}" data-trace-agent="${esc(m.agent || state.chat.agent)}" role="region" aria-label="本次执行回顾">${window.HarbourTrace ? "" : traceRowsHtml(m.trace)}</div></details>`
      : "";
    // 说话人取【这条消息自己的 agent】，中途换角色也不会把旧回复重新贴标签。
    const who = m.role === "user" ? null : (m.agent || state.chat.agent);
    const runStateClass = m.runRecord?.status === "interrupted" ? " is-interrupted" : "";
    return `<div class="chat-msg ${m.role}${runStateClass}" data-mi="${i}">
      ${avatarHtml(m.role, who)}
      <div class="chat-role">${m.role === "user" ? esc(userRoleLabel(m, inspection?.session)) : personaLabel(who)}${m.at ? timeHtml(m.at, "short", "msg-time") : ""}</div>
      <div class="chat-bubble">${traceEl}${body}${atts ? `<div class="msg-atts">${atts}</div>` : ""}${fileChanges}${calendarCards}</div>
    </div>`;
  }).join("");
  stream.querySelectorAll("[data-channel-stop]").forEach((button) => {
    button.addEventListener("click", () => { void stopChannelRun(button.dataset.channelStop, button.dataset.stopSession); });
  });
  if (window.HarbourTrace) stream.querySelectorAll("[data-progress-message]").forEach(host => {
    const message = messages[Number(host.dataset.progressMessage)];
    const mount = () => window.HarbourTrace.mount(host, message.trace || (message.pending ? state.chat.trace : []), {
      agent: host.dataset.traceAgent, live: !!message.pending, rowsHtml: traceRowsHtml,
    });
    // A long conversation may contain hundreds of closed reviews. Keep their
    // evidence in memory, but build lanes/log DOM only when the user opens one.
    const review = host.closest("details.chat-trace");
    if (!review || review.open) mount();
    else review.addEventListener("toggle", () => { if (review.open && !host.hasChildNodes()) mount(); });
  });
  if (nearBottom) stream.scrollTop = stream.scrollHeight;
  renderChatRail();
}

// 提问导航轨：只渲染当前附近的一小段刻度，滚轮移动窗口；
// 悬停时在左侧浮出该轮问答预览，点击平滑跳转。
function renderChatRail() {
  const rail = $("#chatRail");
  if (!rail) return;
  const messages = viewedChatMessages();
  const prompts = messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user");
  if (prompts.length < 2) {
    rail.innerHTML = "";
    rail.classList.remove("has", "preview-open");
    return; // 少于两条没必要
  }
  rail.classList.add("has");
  const items = prompts.map((x, n) => {
    const txt = (x.m.content || "").replace(/\s+/g, " ").trim();
    let reply = "";
    for (let i = x.i + 1; i < messages.length; i++) {
      const next = messages[i];
      if (next.role === "user") break;
      if (next.role === "assistant" && !next.pending && next.content) {
        reply = String(next.content).replace(/\s+/g, " ").trim();
        break;
      }
    }
    return { ...x, n, txt, reply };
  });
  rail.innerHTML = `<div class="chat-rail-track" role="navigation" tabindex="0" aria-label="对话提问导航；滚动查看更多"></div><aside class="rail-preview" role="tooltip" aria-hidden="true"></aside>`;
  const track = rail.querySelector(".chat-rail-track");
  const preview = rail.querySelector(".rail-preview");
  const session = (state.chat.sessions || []).find((s) => s.id === viewedChatSessionId());
  const showPreview = (button, item) => {
    const source = session ? `${sourceBadgeText(session)} · ${sourceWhere(session) || "Main Chat"}` : "WEB · Main Chat";
    preview.innerHTML = `
      <div class="rp-question"><span>${item.n + 1}</span><b>${esc(item.txt || "（空白消息）")}</b></div>
      <div class="rp-answer">${item.reply ? esc(item.reply.slice(0, 180)) : "这轮尚无完整回复"}</div>
      <div class="rp-meta"><span class="rp-globe">◎</span>${esc(source)}${item.m.at ? timeHtml(item.m.at, "short") : ""}</div>`;
    const railRect = rail.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    preview.style.top = `${buttonRect.top - railRect.top + buttonRect.height / 2}px`;
    preview.setAttribute("aria-hidden", "false");
    rail.classList.add("preview-open");
  };
  const hidePreview = () => {
    preview.setAttribute("aria-hidden", "true");
    rail.classList.remove("preview-open");
  };

  const visibleLimit = 9;
  const maxStart = Math.max(0, items.length - visibleLimit);
  let activeIndex = 0;
  let windowStart = 0;
  const clampStart = (value) => Math.max(0, Math.min(maxStart, value));
  const centeredStart = (index) => clampStart(index - Math.floor(visibleLimit / 2));

  const bindTick = (button, item) => {
    button.addEventListener("mouseenter", () => showPreview(button, item));
    button.addEventListener("mouseleave", hidePreview);
    button.addEventListener("focus", () => showPreview(button, item));
    button.addEventListener("blur", hidePreview);
    button.addEventListener("click", () => {
      const el = document.querySelector(`.chat-msg[data-mi="${button.dataset.goto}"]`);
      if (!el) return;
      activeIndex = item.n;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      renderWindow();
    });
  };

  const renderWindow = () => {
    hidePreview();
    const visible = items.slice(windowStart, windowStart + visibleLimit);
    track.classList.toggle("has-before", windowStart > 0);
    track.classList.toggle("has-after", windowStart + visible.length < items.length);
    track.setAttribute("aria-label", `对话提问导航，显示第 ${windowStart + 1} 至 ${windowStart + visible.length} 条，共 ${items.length} 条；滚动查看更多`);
    track.innerHTML = visible.map((item) =>
      `<button type="button" class="rail-tick${item.n === activeIndex ? " active" : ""}" data-goto="${item.i}" data-rail-index="${item.n}" aria-label="跳到第 ${item.n + 1} 次提问：${esc(item.txt)}"><span class="rt-idx">${item.n + 1}</span><span class="rt-dot"></span></button>`
    ).join("");
    track.querySelectorAll("[data-goto]").forEach((button) => {
      bindTick(button, items[Number(button.dataset.railIndex)]);
    });
  };

  const stream = $("#chatStream");
  const syncActive = () => {
    if (!stream) return;
    const marker = stream.scrollTop + Math.min(140, stream.clientHeight * .3);
    let nextActive = 0;
    items.forEach((item, index) => {
      const message = stream.querySelector(`.chat-msg[data-mi="${item.i}"]`);
      if (message && message.offsetTop <= marker) nextActive = index;
    });
    if (nextActive === activeIndex && track.children.length) return;
    activeIndex = nextActive;
    windowStart = centeredStart(activeIndex);
    renderWindow();
  };

  track.addEventListener("wheel", (event) => {
    if (!event.deltaY) return;
    const nextStart = clampStart(windowStart + (event.deltaY > 0 ? 1 : -1));
    if (nextStart === windowStart) return;
    event.preventDefault();
    windowStart = nextStart;
    renderWindow();
  }, { passive: false });
  track.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    const nextStart = clampStart(windowStart + delta);
    if (nextStart === windowStart) return;
    event.preventDefault();
    windowStart = nextStart;
    renderWindow();
  });
  let railFrame = 0;
  if (stream?._chatRailScrollHandler) stream.removeEventListener("scroll", stream._chatRailScrollHandler);
  const onRailScroll = () => {
    cancelAnimationFrame(railFrame);
    railFrame = requestAnimationFrame(syncActive);
  };
  if (stream) {
    stream._chatRailScrollHandler = onRailScroll;
    stream.addEventListener("scroll", onRailScroll, { passive: true });
  }
  windowStart = centeredStart(activeIndex);
  renderWindow();
  syncActive();
}

// MAIN CHAT 聊天背景切换（纸 / 方格 / 星屑 / 立绘）——样式挂在 anime 大类，premium 下 picker 由 CSS 隐藏。
const CHAT_BG_KEY = "harbour-chat-bg";
const CHAT_BG_IMG_KEY = "harbour-chat-bg-img"; // 自定义上传背景（data URL，localStorage 持久化）
function applyChatBg() {
  const wrap = document.querySelector(".chat-stream-wrap");
  if (!wrap) return;
  const bg = localStorage.getItem(CHAT_BG_KEY) || "paper";
  const isAnime = document.body.dataset.themeCat === "anime";
  const custom = localStorage.getItem(CHAT_BG_IMG_KEY);
  wrap.classList.remove("csw-grid", "csw-stars");
  wrap.style.backgroundImage = ""; wrap.style.backgroundSize = ""; wrap.style.backgroundPosition = ""; wrap.style.backgroundRepeat = "";
  if (bg === "grid") wrap.classList.add("csw-grid");
  else if (bg === "stars") wrap.classList.add("csw-stars");
  else if (bg === "custom" && isAnime && custom) {
    // 自定义上传背景：整背景 cover（按比例裁切铺满、不拉伸）+ 一层淡遮罩保证气泡外文字可读。
    wrap.style.backgroundImage = `linear-gradient(rgba(255,255,255,.32), rgba(255,255,255,.32)), url(${custom})`;
    wrap.style.backgroundSize = "cover, cover";
    wrap.style.backgroundPosition = "center, center";
    wrap.style.backgroundRepeat = "no-repeat, no-repeat";
  }
  document.querySelectorAll("#chatBgPicker .bgp-btn[data-bg]").forEach((b) => {
    b.classList.toggle("active", b.dataset.bg === bg);
    b.setAttribute("aria-pressed", String(b.dataset.bg === bg));
  });
  const reset = document.querySelector("#chatBgReset");
  if (reset) reset.style.display = custom ? "" : "none";
}
// 上传自定义背景：等比缩小到 ≤1600px 存成 data URL（localStorage），显示走 cover 自动按比例裁切铺满。
function processChatBgImage(file) {
  if (!file || !/^image\//.test(file.type)) return toast("请选图片文件", true);
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const scale = Math.min(1, max / img.width, max / img.height);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      let url;
      try { url = cv.toDataURL("image/jpeg", 0.85); } catch (e) { url = reader.result; }
      try {
        localStorage.setItem(CHAT_BG_IMG_KEY, url);
        localStorage.setItem(CHAT_BG_KEY, "custom");
        applyChatBg();
        toast("背景已更新（按比例铺满）");
      } catch (e) { toast("图片太大存不下，换张小一点的", true); }
    };
    img.onerror = () => toast("图片读取失败", true);
    img.src = reader.result;
  };
  reader.onerror = () => toast("读取失败", true);
  reader.readAsDataURL(file);
}

/* ── 多模态附件：上传 / 录音 / 渲染 ──────────────────────────────── */

// 把已选附件渲染成 composer 上方的可删 chip 条。
function renderChatAttachments() {
  const box = $("#chatAttachments");
  if (!box) return;
  const atts = state.chat.attachments;
  const pending = Math.max(0, Number(state.chat.pendingUploads) || 0);
  box.style.display = atts.length || pending ? "flex" : "none";
  const pendingChip = pending
    ? `<span class="att-chip att-uploading" role="status"><span class="att-upload-spinner" aria-hidden="true"></span>正在添加 ${pending} 个附件…</span>`
    : "";
  box.innerHTML = pendingChip + atts.map((a, i) => {
    const stt = a.kind === "audio" && a._sttStatus
      ? `<span class="att-stt att-stt-${esc(a._sttStatus)}">${a._sttStatus === "transcribing" ? "转写中" : a._sttStatus === "done" ? "已转写" : "转写失败"}</span>`
      : "";
    const retry = a.kind === "audio" && a._sttStatus === "failed"
      ? `<button class="att-retry" data-att-retry="${i}" title="重新转写">↻</button>`
      : "";
    return `<span class="att-chip">${attIcon(a.kind)} <span class="att-name">${esc(a.name)}</span>${stt}${retry}<button class="att-rm" data-att-rm="${i}" title="移除">✕</button></span>`;
  }).join("");
  const send = $("#chatSend");
  if (send && !state.chat.running) send.disabled = state.chat.readOnlyMirror || pending > 0;
  box.querySelectorAll("[data-att-rm]").forEach((b) => b.addEventListener("click", () => {
    const attachment = state.chat.attachments[Number(b.dataset.attRm)];
    state.chat.sttControllers.get(attachment?.url)?.abort();
    if (attachment?.url) state.chat.sttControllers.delete(attachment.url);
    state.chat.attachments.splice(Number(b.dataset.attRm), 1);
    renderChatAttachments();
  }));
  box.querySelectorAll("[data-att-retry]").forEach((b) => b.addEventListener("click", () => {
    const attachment = state.chat.attachments[Number(b.dataset.attRetry)];
    if (attachment) queueWebTranscription(attachment);
  }));
  renderChatSpeechStatus();
}

function renderChatSpeechStatus() {
  const box = $("#chatSpeechStatus");
  if (!box) return;
  const transcribing = state.chat.attachments.filter((a) => a.kind === "audio" && a._sttStatus === "transcribing").length;
  const failed = state.chat.attachments.filter((a) => a.kind === "audio" && a._sttStatus === "failed").length;
  const recording = !!state.rec;
  box.hidden = !recording && !transcribing && !failed;
  box.className = `chat-speech-status${failed ? " has-error" : ""}`;
  box.textContent = recording
    ? "● 正在录音 · 再点麦克风停止"
    : transcribing
      ? `◌ 正在转写 ${transcribing} 条语音 · 完成后可先修改文字再发送`
      : failed
        ? `⚠ ${failed} 条语音转写失败 · 可重试，或补充文字后发送`
        : "";
}

function attIcon(kind) {
  return kind === "image" ? "🖼" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "📄";
}

function mediaDisplayName(rawUrl, preferredName, kind) {
  const preferred = String(preferredName ?? "").trim();
  if (preferred) return preferred;
  try {
    const pathname = new URL(String(rawUrl ?? ""), location.href).pathname;
    const filename = decodeURIComponent(pathname.split("/").pop() || "").trim();
    if (filename) return filename;
  } catch { /* 使用下面的稳定兜底名 */ }
  return kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
}

function renderPlayableMedia(kind, rawUrl, title = "") {
  if (kind !== "video" && kind !== "audio") return "";
  const source = esc(withToken(rawUrl));
  const displayName = esc(mediaDisplayName(rawUrl, title, kind));
  const player = kind === "video"
    ? `<video class="att-video" controls preload="metadata" playsinline src="${source}" title="${displayName}"></video>`
    : `<audio class="att-audio" controls preload="metadata" src="${source}" title="${displayName}"></audio>`;
  return `<span class="att-media-shell att-media-shell-${kind}">
    ${player}
    <button class="att-media-open" type="button" data-media-kind="${kind}" data-media-url="${source}" data-media-title="${displayName}" aria-label="在 Harbour 中展开${kind === "video" ? "视频" : "音频"}：${displayName}" title="在 Harbour 中展开">
      <span aria-hidden="true">⤢</span><span class="att-media-open-label">展开</span>
    </button>
  </span>${window.harbourDesktop?.openAttachment && window.HarbourFiles?.localUrl(rawUrl) ? `<button type="button" class="att-media-external" data-file-external="${esc(rawUrl)}" data-file-name="${displayName}">用默认${kind === "video" ? "播放器" : "应用"}打开 ↗</button>` : ""}`;
}

// Harbour 回答的富渲染：先把裸媒体链接转成 markdown，交 renderMarkdownLite 统一渲染（真 <img> / 链接 /
// 标题 / 列表 / 代码块），再包进 .md-body。这样日报这类 markdown 在 CHAT/RUN 都真渲染（不再是裸文本）。
function renderAssistantBubble(text) {
  let md = String(text ?? "");
  // 音视频没有 markdown 语法：先抽成占位 token，渲染后再换成播放器（src 需带 token）。
  const videos = [];
  const audios = [];
  const bare = "(^|[\\s])((?:/uploads/|https?://)[^\\s<)]+";
  md = md.replace(new RegExp(bare + "\\.(?:video\\.webm|mp4|m4v|mov|mkv|avi))", "gi"), (_m, pre, url) => {
    const i = videos.push(url) - 1;
    return `${pre}@@VIDEO${i}@@`;
  });
  md = md.replace(new RegExp(bare + "\\.(?:webm|ogg|mp3|wav|m4a))", "gi"), (_m, pre, url) => {
    const i = audios.push(url) - 1;
    return `${pre}@@AUDIO${i}@@`;
  });
  // 裸图片链接 → ![](url)（markdown-lite 渲染成真 <img>）。已在 md 语法内的（前缀是 `(`）不动。
  md = md.replace(new RegExp(bare + "\\.(?:png|jpe?g|webp|gif))", "gi"), (_m, pre, url) => `${pre}![](${url})`);
  // 裸其它文件链接 → [文件名](url)。
  md = md.replace(new RegExp(bare + "\\.(?:pdf|txt|md|json|csv|log|zip|py|js|ts|tsx|jsx|yaml|yml|toml|sql|docx?|xlsx?|pptx?))", "gi"), (_m, pre, url) => `${pre}[${url.split("/").pop()}](${url})`);
  let html = renderMarkdownLite(md);
  html = html.replace(/@@VIDEO(\d+)@@/g, (_m, i) => renderPlayableMedia("video", videos[Number(i)]));
  html = html.replace(/@@AUDIO(\d+)@@/g, (_m, i) => renderPlayableMedia("audio", audios[Number(i)]));
  return `<div class="md-body">${html}</div>`;
}

// 消息气泡内的附件渲染：图片缩略、视频/音频播放器、其它文件链接。
function attachmentHtml(a) {
  if (a.expired) return `<span class="att-file att-expired" aria-label="附件已过期">📄 ${esc(a.name || "附件")} · 已过期</span>`;
  const url = esc(withToken(a.url));
  if (a.kind === "image") return `<a class="att-img-link" href="${url}" data-media-kind="image" data-media-title="${esc(a.name)}" aria-label="在 Harbour 中查看图片：${esc(a.name)}"><img class="att-img" src="${url}" alt="${esc(a.name)}"></a>`;
  if (a.kind === "video") return renderPlayableMedia("video", a.url, a.name);
  if (a.kind === "audio") return renderPlayableMedia("audio", a.url, a.name);
  return `<a class="att-file" href="${url}" data-file-name="${esc(a.name)}" ${safeLocalUploadUrl(a.url) ? "" : 'target="_blank"'} rel="noopener">📄 ${esc(a.name)}</a>`;
}

/* ── 对话媒体查看器 ──────────────────────────────────────────────────
   图片、视频和音频都留在 Harbour 当前窗口内。Electron 只继续把真正的
   普通网页链接交给系统浏览器；媒体缩略图不再借 target=_blank 绕出去。 */
let activeMediaViewer = null;
let activeMediaViewerKeyHandler = null;
let mediaViewerReturnFocus = null;
let mediaViewerRestoreHost = null;

function safeMediaViewerUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""), location.href);
    return /^(?:https?|blob):$/i.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function releaseMediaViewerPlayback(root) {
  root.querySelectorAll("video, audio").forEach((media) => {
    try { media.pause(); } catch { /* 已卸载的媒体无需处理 */ }
    media.removeAttribute("src");
    media.load?.();
  });
}

function closeMediaViewer() {
  if (!activeMediaViewer) return;
  releaseMediaViewerPlayback(activeMediaViewer);
  activeMediaViewer.remove();
  activeMediaViewer = null;
  mediaViewerRestoreHost?.();
  mediaViewerRestoreHost = null;
  document.body.classList.remove("media-viewer-open");
  if (activeMediaViewerKeyHandler) document.removeEventListener("keydown", activeMediaViewerKeyHandler, true);
  activeMediaViewerKeyHandler = null;
  mediaViewerReturnFocus?.focus?.({ preventScroll: true });
  mediaViewerReturnFocus = null;
}

function mountMediaViewer(viewer, origin) {
  // A modal reader is in the browser top layer. A body-level z-index cannot cover it.
  const host = origin?.closest?.("dialog[open]") || document.body;
  const siblings = host === document.body ? [] : [...host.children].map(node => ({ node, inert: node.inert }));
  siblings.forEach(({ node }) => { node.inert = true; });
  host.appendChild(viewer);
  return () => siblings.forEach(({ node, inert }) => { node.inert = inert; });
}

function collectSpaceMediaGallery(origin, fallback) {
  const reader = origin?.closest?.(".space-reader");
  if (!reader || fallback.kind !== "image") return null;
  const items = [];
  let index = -1;
  reader.querySelectorAll("[data-space-zoom]").forEach((button) => {
    const image = button.querySelector("img");
    // Lazy pages retain their original src even before decoding; never use catalog thumbnails.
    const source = image?.getAttribute("src");
    const url = source?.trim() ? safeMediaViewerUrl(source) : "";
    if (!url) return;
    if (button === origin || button.contains(origin)) index = items.length;
    items.push({ kind: "image", url, title: image.alt || "图片" });
  });
  // Preserve page occurrences/order, including intentionally repeated images in one comic.
  return index >= 0 ? { items, index } : { items: [fallback], index: 0 };
}

function collectMediaViewerGallery(origin, fallback) {
  const spaceGallery = collectSpaceMediaGallery(origin, fallback);
  if (spaceGallery) return spaceGallery;
  // 只读取点击所在的已渲染对话，绝不从全局 state 混入另一会话或 History。
  const scope = origin?.closest?.("#chatStream, .hist-msgs");
  if (!scope || fallback.kind === "audio") return { items: [fallback], index: 0 };
  const items = [];
  const seenByMessage = new Map();
  let index = -1;
  scope.querySelectorAll('img.att-img, img.md-img-real, [data-media-kind="video"][data-media-url]').forEach((source) => {
    const message = source.closest(".chat-msg");
    // 折叠内容/隐藏媒体不是当前可浏览内容；滚动区域外的消息仍有布局矩形。
    if (!message || !source.getClientRects().length || source.closest(".chat-trace, .chat-trace-live")) return;
    const kind = source.tagName === "IMG" ? "image" : "video";
    const url = safeMediaViewerUrl(kind === "image" ? chatImageSource(source) : source.dataset.mediaUrl);
    if (!url) return;
    const canonical = new URL(url);
    if (canonical.origin === location.origin && canonical.pathname.startsWith("/uploads/")) canonical.searchParams.delete("token");
    const key = `${kind}:${canonical.href}`;
    let seen = seenByMessage.get(message);
    if (!seen) seenByMessage.set(message, seen = new Map());
    let itemIndex = seen.get(key);
    if (itemIndex === undefined) {
      itemIndex = items.length;
      seen.set(key, itemIndex);
      items.push({ kind, url, title: source.dataset.mediaTitle || source.alt || "" });
    }
    if (source === origin) index = itemIndex;
  });
  return index >= 0 ? { items, index } : { items: [fallback], index: 0 };
}

function mediaViewerOwnsArrowKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return false;
  // 原生播放器（包括 shadow 控件）的方向键继续用于 seek/volume。
  const path = event.composedPath?.() || [event.target];
  return !path.some((node) => node?.matches?.('video, audio, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]'));
}

function mediaViewerFocusControls(viewer) {
  return [...viewer.querySelectorAll("button:not([disabled]), video[controls], audio[controls]")]
    .filter((control) => !control.hidden && control.getClientRects().length);
}

function focusMediaViewerBoundary(viewer, atEnd) {
  const controls = mediaViewerFocusControls(viewer);
  controls[atEnd ? controls.length - 1 : 0]?.focus({ preventScroll: true });
}

function containMediaViewerFocus(viewer, event) {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return false;
  // 原生媒体各 shadow 控件的 activeElement 都投射为 video/audio；不能把它误判为已到边界。
  // 保留浏览器内部 Tab 顺序，真正离开控件时由对话框首尾 focus guard 收回焦点。
  if ((event.composedPath?.() || [event.target]).some((node) => node?.matches?.("video, audio"))) return false;
  const controls = mediaViewerFocusControls(viewer);
  if (!controls.length) return false;
  const index = controls.indexOf(document.activeElement);
  if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
    event.preventDefault();
    controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
  }
  return true;
}

function openMediaViewer({ kind, url: rawUrl, title = "", origin = null }) {
  if (!["image", "video", "audio"].includes(kind)) return;
  const url = safeMediaViewerUrl(rawUrl);
  if (!url) { toast("媒体地址不可用", true); return; }
  closeMediaViewer();

  mediaViewerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const gallery = collectMediaViewerGallery(origin, { kind, url, title });
  let displayName = mediaDisplayName(url, title, kind);
  const kindLabel = kind === "image" ? "IMAGE" : kind === "video" ? "VIDEO" : "AUDIO";
  const viewer = h(`<div class="media-viewer" role="presentation">
    <span class="media-viewer-focus-guard" data-media-focus-boundary="start" tabindex="0" aria-hidden="true"></span>
    <section class="media-viewer-card" role="dialog" aria-modal="true" aria-label="媒体预览：${esc(displayName)}">
      <header class="media-viewer-head">
        <div class="media-viewer-identity">
          <span class="media-viewer-kind">${kindLabel}</span>
          <strong class="media-viewer-title" title="${esc(displayName)}">${esc(displayName)}</strong>
          <span class="media-viewer-counter" role="status" aria-live="polite" aria-atomic="true" ${kind === "audio" ? "hidden" : ""}></span>
        </div>
        <div class="media-viewer-actions">
          <button type="button" class="media-viewer-native" data-media-viewer-action="native" ${window.harbourDesktop?.openAttachment ? "" : "hidden"}>默认应用 ↗</button>
          <button type="button" data-media-viewer-action="zoom-out" aria-label="缩小图片" title="缩小" ${kind === "image" ? "" : "hidden"}>−</button>
          <button type="button" class="media-viewer-zoom" data-media-viewer-action="fit" aria-label="适应窗口" title="适应窗口" ${kind === "image" ? "" : "hidden"}>100%</button>
          <button type="button" data-media-viewer-action="zoom-in" aria-label="放大图片" title="放大" ${kind === "image" ? "" : "hidden"}>＋</button>
          <button type="button" class="media-viewer-close" data-media-viewer-action="close" aria-label="关闭媒体预览" title="关闭">×</button>
        </div>
      </header>
      <div class="media-viewer-content${gallery.items.length > 1 ? " has-gallery" : ""}">
        <div class="media-viewer-stage" data-media-kind="${kind}"></div>
        <button type="button" class="media-viewer-nav media-viewer-prev" data-media-viewer-action="previous" aria-label="上一个图片或视频" title="上一个（←）" ${gallery.items.length > 1 ? "" : "hidden"}>‹</button>
        <button type="button" class="media-viewer-nav media-viewer-next" data-media-viewer-action="next" aria-label="下一个图片或视频" title="下一个（→）" ${gallery.items.length > 1 ? "" : "hidden"}>›</button>
      </div>
    </section>
    <span class="media-viewer-focus-guard" data-media-focus-boundary="end" tabindex="0" aria-hidden="true"></span>
  </div>`);
  const stage = viewer.querySelector(".media-viewer-stage");
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let image = null;
  let dragging = false;
  let pointerId = null;
  let dragX = 0;
  let dragY = 0;

  const applyImageTransform = () => {
    if (!image) return;
    image.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${zoom})`;
    stage.classList.toggle("is-zoomed", zoom > 1.001);
    const label = viewer.querySelector(".media-viewer-zoom");
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  };
  const setZoom = (nextZoom) => {
    zoom = Math.max(1, Math.min(5, nextZoom));
    if (zoom === 1) { offsetX = 0; offsetY = 0; }
    applyImageTransform();
  };

  const showCurrentMedia = () => {
    releaseMediaViewerPlayback(stage);
    if (pointerId !== null && stage.hasPointerCapture?.(pointerId)) stage.releasePointerCapture(pointerId);
    dragging = false;
    pointerId = null;
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    image = null;
    stage.replaceChildren();
    stage.classList.remove("is-zoomed", "is-dragging", "has-error");
    stage.classList.add("is-loading");
    const item = gallery.items[gallery.index];
    viewer.querySelector('[data-media-viewer-action="native"]').hidden = !window.harbourDesktop?.openAttachment || !window.HarbourFiles?.localUrl(item.url);
    kind = item.kind;
    displayName = mediaDisplayName(item.url, item.title, kind);
    stage.dataset.mediaKind = kind;
    viewer.querySelector(".media-viewer-card").setAttribute("aria-label", `媒体预览：${displayName}`);
    viewer.querySelector(".media-viewer-kind").textContent = kind === "image" ? "IMAGE" : kind === "video" ? "VIDEO" : "AUDIO";
    const name = viewer.querySelector(".media-viewer-title");
    name.textContent = displayName;
    name.title = displayName;
    const counter = viewer.querySelector(".media-viewer-counter");
    counter.textContent = `${gallery.index + 1} / ${gallery.items.length}`;
    counter.setAttribute("aria-label", `第 ${gallery.index + 1} 项，共 ${gallery.items.length} 项`);
    viewer.querySelector('[data-media-viewer-action="previous"]').disabled = gallery.index === 0;
    viewer.querySelector('[data-media-viewer-action="next"]').disabled = gallery.index === gallery.items.length - 1;
    ["zoom-out", "fit", "zoom-in"].forEach((action) => {
      viewer.querySelector(`[data-media-viewer-action="${action}"]`).hidden = kind !== "image";
    });
    const media = document.createElement(kind === "image" ? "img" : kind);
    media.className = `media-viewer-${kind}`;
    const loaded = () => { if (stage.contains(media)) stage.classList.remove("is-loading"); };
    media.addEventListener(kind === "image" ? "load" : "loadedmetadata", loaded, { once: true });
    media.addEventListener("error", () => {
      if (!stage.contains(media)) return;
      stage.classList.remove("is-loading");
      stage.classList.add("has-error");
      if (kind === "image") media.alt = `图片加载失败：${displayName}`;
      // Only the expanded player (opened by a click) may fall back automatically.
      // Network/authentication failures and inline players never launch applications.
      if ((kind === "video" || kind === "audio") && [3, 4].includes(media.error?.code)
        && window.harbourDesktop?.openAttachment && window.HarbourFiles?.localUrl(item.url)) {
        void window.HarbourFiles.external(item.url, displayName);
      }
    }, { once: true });
    if (kind === "image") {
      image = media;
      image.alt = displayName;
      image.draggable = false;
      stage.appendChild(image);
      applyImageTransform();
    } else {
      media.controls = true;
      media.preload = "metadata";
      if (kind === "video") {
        media.playsInline = true;
        stage.appendChild(media);
      } else {
        const audioCard = document.createElement("div");
        audioCard.className = "media-viewer-audio-card";
        audioCard.innerHTML = `<span class="media-viewer-audio-icon" aria-hidden="true">♪</span><strong>${esc(displayName)}</strong>`;
        audioCard.appendChild(media);
        stage.appendChild(audioCard);
      }
    }
    media.src = item.url;
  };
  const navigateMedia = (delta) => {
    const next = gallery.index + delta;
    if (next < 0 || next >= gallery.items.length) return;
    gallery.index = next;
    showCurrentMedia();
    // 到达边界后，已禁用的箭头不继续持有焦点。
    if (document.activeElement?.disabled) viewer.querySelector(".media-viewer-close")?.focus({ preventScroll: true });
  };

  stage.addEventListener("wheel", (event) => {
    if (!image) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  stage.addEventListener("dblclick", () => { if (image) setZoom(zoom > 1 ? 1 : 2); });
  stage.addEventListener("pointerdown", (event) => {
    if (!image || zoom <= 1 || event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    dragX = event.clientX;
    dragY = event.clientY;
    stage.setPointerCapture?.(pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    offsetX += event.clientX - dragX;
    offsetY += event.clientY - dragY;
    dragX = event.clientX;
    dragY = event.clientY;
    applyImageTransform();
  });
  const stopDragging = (event) => {
    if (!dragging || (event.pointerId != null && event.pointerId !== pointerId)) return;
    dragging = false;
    stage.releasePointerCapture?.(pointerId);
    pointerId = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", stopDragging);
  stage.addEventListener("pointercancel", stopDragging);
  showCurrentMedia();

  viewer.addEventListener("focusin", (event) => {
    const boundary = event.target.dataset?.mediaFocusBoundary;
    if (boundary) focusMediaViewerBoundary(viewer, boundary === "start");
  });
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) { closeMediaViewer(); return; }
    const action = event.target.closest?.("[data-media-viewer-action]")?.dataset.mediaViewerAction;
    if (action === "close") closeMediaViewer();
    else if (action === "native") void window.HarbourFiles?.external(gallery.items[gallery.index].url, displayName);
    else if (action === "previous") navigateMedia(-1);
    else if (action === "next") navigateMedia(1);
    else if (action === "zoom-in") setZoom(zoom * 1.25);
    else if (action === "zoom-out") setZoom(zoom / 1.25);
    else if (action === "fit") setZoom(1);
  });
  activeMediaViewerKeyHandler = (event) => {
    if (containMediaViewerFocus(viewer, event)) return;
    if (event.key === "Escape") { event.preventDefault(); closeMediaViewer(); }
    else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && kind !== "audio" && mediaViewerOwnsArrowKey(event)) {
      event.preventDefault();
      navigateMedia(event.key === "ArrowLeft" ? -1 : 1);
    }
    else if (kind === "image" && (event.key === "+" || event.key === "=")) { event.preventDefault(); setZoom(zoom * 1.25); }
    else if (kind === "image" && event.key === "-") { event.preventDefault(); setZoom(zoom / 1.25); }
    else if (kind === "image" && event.key === "0") { event.preventDefault(); setZoom(1); }
  };
  document.addEventListener("keydown", activeMediaViewerKeyHandler, true);
  mediaViewerRestoreHost = mountMediaViewer(viewer, origin);
  document.body.classList.add("media-viewer-open");
  activeMediaViewer = viewer;
  viewer.querySelector(".media-viewer-close")?.focus({ preventScroll: true });
}

function openChatImageViewer(image) {
  openMediaViewer({
    kind: "image",
    url: chatImageSource(image),
    title: image?.alt || image?.closest?.(".att-img-link")?.dataset.mediaTitle || "图片",
    origin: image,
  });
}

function initMediaViewer() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.("[data-media-url][data-media-kind]");
    if (trigger) {
      event.preventDefault();
      openMediaViewer({ kind: trigger.dataset.mediaKind, url: trigger.dataset.mediaUrl, title: trigger.dataset.mediaTitle, origin: trigger });
      return;
    }
    const imageLink = event.target.closest?.("a.att-img-link");
    if (!imageLink) return;
    event.preventDefault();
    const image = imageLink.querySelector("img.att-img, img.md-img-real");
    if (image) openChatImageViewer(image);
  });
  // 中键点击也不能绕过内置查看器把媒体误交给 Electron 外链处理。
  document.addEventListener("auxclick", (event) => {
    if (event.target.closest?.("a.att-img-link")) event.preventDefault();
  });
}

/* ── 对话图片右键菜单 ────────────────────────────────────────────────
   Electron 不会自动给 BrowserWindow 注入浏览器的图片菜单；普通浏览器在
   localhost/HTTPS 下则可用 Async Clipboard。两端统一在这里复制真实图片，
   而不是只复制 URL。远端 HTTP 没有安全剪贴板能力时不拦截原生右键菜单。 */
let activeImageContextMenu = null;

function copyableChatImage(target) {
  const image = target?.closest?.("img.att-img, img.md-img-real");
  return image instanceof HTMLImageElement ? image : null;
}

function canCopyChatImageDirectly() {
  return typeof window.harbourDesktop?.copyImage === "function"
    || (!!window.isSecureContext && typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined");
}

function closeImageContextMenu() {
  if (!activeImageContextMenu) return;
  activeImageContextMenu.remove();
  activeImageContextMenu = null;
}

function chatImageSource(image) {
  return String(image?.currentSrc || image?.src || "");
}

function chatImageOriginalUrl(image) {
  const linked = image?.closest?.("a.att-img-link")?.href;
  return String(linked || chatImageSource(image));
}

async function fetchChatImageBlob(image) {
  const src = chatImageSource(image);
  if (!src) throw new Error("图片地址不可用");
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (!/^image\//i.test(blob.type)) throw new Error("返回内容不是图片");
  return blob;
}

async function imageBlobAsPng(blob) {
  if (blob.type.toLowerCase() === "image/png") return blob;
  if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法转换该图片格式");
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("图片转换失败")),
      "image/png"
    ));
    return png;
  } finally {
    bitmap.close?.();
  }
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片编码失败"));
    reader.readAsDataURL(blob);
  });
}

async function copyChatImage(image) {
  if (typeof window.harbourDesktop?.copyImage === "function") {
    const png = await imageBlobAsPng(await fetchChatImageBlob(image));
    const copied = await window.harbourDesktop.copyImage(await blobAsDataUrl(png));
    if (copied) return;
  }
  if (!window.isSecureContext || typeof navigator.clipboard?.write !== "function" || typeof ClipboardItem === "undefined") {
    throw new Error("当前地址没有图片剪贴板权限，请使用浏览器原生“复制图片”或通过 HTTPS/localhost 打开");
  }
  // 在菜单 click 的用户手势还有效时立即调用 clipboard.write；图片下载与格式转换
  // 作为 ClipboardItem 的 Promise 延后完成，避免慢图片让 transient activation 过期。
  const png = fetchChatImageBlob(image).then(imageBlobAsPng);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function safeImageDownloadName(image) {
  const alt = String(image?.alt || "").trim();
  const fromUrl = (() => {
    try { return decodeURIComponent(new URL(chatImageOriginalUrl(image), location.href).pathname.split("/").pop() || ""); }
    catch { return ""; }
  })();
  const raw = alt || fromUrl || "harbour-image";
  const stem = raw.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "harbour-image";
  return `${stem}.png`;
}

async function downloadChatImage(image) {
  const png = await imageBlobAsPng(await fetchChatImageBlob(image));
  const url = URL.createObjectURL(png);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeImageDownloadName(image);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function positionImageContextMenu(menu, clientX, clientY) {
  const gap = 8;
  const left = Math.max(gap, Math.min(clientX, window.innerWidth - menu.offsetWidth - gap));
  const top = Math.max(gap, Math.min(clientY, window.innerHeight - menu.offsetHeight - gap));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showImageContextMenu(event, image) {
  closeImageContextMenu();
  const menu = h(`<div class="image-context-menu" role="menu" aria-label="图片操作">
    <button type="button" role="menuitem" data-image-action="copy"><span aria-hidden="true">◇</span><b>复制图片</b></button>
    <button type="button" role="menuitem" data-image-action="open"><span aria-hidden="true">⤢</span><span>查看大图</span></button>
    <button type="button" role="menuitem" data-image-action="save"><span aria-hidden="true">↓</span><span>保存图片</span></button>
  </div>`);
  activeImageContextMenu = menu;
  document.body.appendChild(menu);
  positionImageContextMenu(menu, event.clientX, event.clientY);
  menu.addEventListener("click", async (clickEvent) => {
    const action = clickEvent.target.closest?.("[data-image-action]")?.dataset.imageAction;
    if (!action) return;
    closeImageContextMenu();
    try {
      if (action === "copy") {
        await copyChatImage(image);
        toast("图片已复制到剪贴板");
      } else if (action === "open") {
        openChatImageViewer(image);
      } else if (action === "save") {
        await downloadChatImage(image);
        toast("图片已开始保存");
      }
    } catch (error) {
      toast(error?.message || "图片操作失败", true);
    }
  });
  menu.addEventListener("keydown", (keyEvent) => {
    const items = [...menu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (keyEvent.key === "Escape") { keyEvent.preventDefault(); closeImageContextMenu(); return; }
    if (keyEvent.key !== "ArrowDown" && keyEvent.key !== "ArrowUp") return;
    keyEvent.preventDefault();
    const delta = keyEvent.key === "ArrowDown" ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  });
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function initImageContextMenu() {
  document.addEventListener("contextmenu", (event) => {
    const image = copyableChatImage(event.target);
    if (!image) { closeImageContextMenu(); return; }
    // 普通远端 HTTP 页面没有 Async Clipboard；保留浏览器原生菜单作为降级。
    if (!canCopyChatImageDirectly()) return;
    event.preventDefault();
    showImageContextMenu(event, image);
  });
  document.addEventListener("pointerdown", (event) => {
    if (activeImageContextMenu && !activeImageContextMenu.contains(event.target)) closeImageContextMenu();
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeImageContextMenu(); }, true);
  window.addEventListener("blur", closeImageContextMenu);
  window.addEventListener("resize", closeImageContextMenu);
  document.addEventListener("scroll", closeImageContextMenu, true);
}

// 文件 → data URL（后端 /api/upload 接受 data URL，会自动剥掉前缀）。
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

const CLIPBOARD_GENERIC_FILE = /^(?:image|blob|clipboard)(?:\.[a-z0-9+_-]+)?$/i;

function clipboardFileExtension(file) {
  const fromName = String(file?.name || "").match(/\.([a-z0-9]+)$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const mime = String(file?.type || "").toLowerCase();
  const known = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  return known[mime] || mime.split("/")[1]?.replace(/\+.*/, "") || "bin";
}

function normalizeClipboardFile(file, index, stamp) {
  if (!file) return null;
  const originalName = String(file.name || "").trim();
  if (originalName && !CLIPBOARD_GENERIC_FILE.test(originalName)) return file;
  const suffix = index ? `-${index + 1}` : "";
  const name = `clipboard-${stamp}${suffix}.${clipboardFileExtension(file)}`;
  try {
    return new File([file], name, {
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    // 极旧 WebView 没有 File 构造器时仍可上传，只是保留浏览器给出的通用文件名。
    return file;
  }
}

/** 从粘贴或拖拽的 DataTransfer 提取文件；纯文字仍走浏览器原生行为。 */
function chatClipboardFiles(clipboardData, now = new Date()) {
  if (!clipboardData) return [];
  let files = [...(clipboardData.files || [])];
  // Chromium 通常同时暴露 files 与 items；只有 files 为空时才读 items，避免同一张图上传两遍。
  if (!files.length) {
    files = [...(clipboardData.items || [])]
      .filter((item) => item?.kind === "file")
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
  }
  if (!files.length) return [];
  const stamp = HarbourTime.format(now, "filename");
  return files.map((file, index) => normalizeClipboardFile(file, index, stamp)).filter(Boolean);
}

async function handleChatPaste(event) {
  const files = chatClipboardFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  const blocked = chatAttachmentBlockedReason();
  if (blocked) return toast(blocked, true);
  const composer = event.currentTarget;
  composer?.classList.add("is-paste-uploading");
  toast(`正在从剪贴板添加 ${files.length} 个附件…`);
  try {
    const { added } = await handleFilesPicked(files);
    if (added) toast(`已从剪贴板添加 ${added} 个附件`);
  } finally {
    composer?.classList.remove("is-paste-uploading");
    $("#chatInput")?.focus();
  }
}

function chatAttachmentBlockedReason() {
  if (state.chat.readOnlyMirror) return "这是外部渠道的只读镜像；请切回 WEB 会话后添加附件。";
  if (state.chat.inspection) return "正在只读浏览其它会话；请返回当前对话后添加附件。";
  if (state.chat.switchingSession || state.chat.switchingMode || state.chat.inputSending || state.chat.inputRequest) return "会话正在切换或发送，请稍后添加附件。";
  return "";
}

/** Browser image drags can contain only a URL, not File bytes. Fetch in the client
 * (subject to CORS), then use the same upload/validation path as paste and pick. */
async function handleChatImageDrop(image) {
  const blocked = chatAttachmentBlockedReason();
  if (blocked) return toast(blocked, true);
  const source = new URL(image.src, location.href);
  if (!/^https?:$/.test(source.protocol) && !/^data:image\//i.test(source.href)
      && !(source.protocol === "blob:" && source.origin === location.origin)) throw new Error("此图片来源不支持拖入，请拖入图片文件。");
  const local = source.origin === location.origin;
  if (local && /^https?:$/.test(source.protocol) && !source.pathname.startsWith("/uploads/")) throw new Error("请拖入图片本身，而不是网页链接。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const maxBytes = 25 * 1024 * 1024;
  let readingImage = true;
  state.chat.pendingUploads++;
  renderChatAttachments();
  try {
    const response = await fetch(local && source.pathname.startsWith("/uploads/") ? withToken(source.pathname + source.search) : source.href,
      { credentials: local ? "same-origin" : "omit", signal: controller.signal, referrerPolicy: "no-referrer", redirect: local ? "error" : "follow" });
    if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
    const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\//i.test(mime)) throw new Error("拖入的内容不是图片，请拖入原始图片文件。");
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("图片超过 25MB，请缩小后再拖入。");
    if (!response.body) throw new Error("图片内容为空，请拖入原始图片文件。");
    const chunks = [], reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { controller.abort(); throw new Error("图片超过 25MB，请缩小后再拖入。"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new Error("图片内容为空，请拖入原始图片文件。");
    clearTimeout(timeout);
    const extension = clipboardFileExtension({ type: mime });
    let basename = "";
    if (/^https?:$/.test(source.protocol)) {
      try { basename = decodeURIComponent(source.pathname.split("/").pop() || ""); } catch { /* use a neutral name */ }
    }
    const name = (basename || image.name || "dragged-image").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 160);
    const file = new File(chunks, /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extension}`, { type: mime });
    // Transfer the pending slot to the shared uploader without an async gap or double count.
    state.chat.pendingUploads = Math.max(0, state.chat.pendingUploads - 1);
    readingImage = false;
    const result = await handleFilesPicked([file]);
    if (result.added) toast("图片已添加到输入框");
  } catch (error) {
    if (error.name === "AbortError") throw new Error("图片读取超时，请重试或拖入已下载的图片文件。");
    if (error instanceof TypeError) throw new Error("无法直接读取此图片（网络或跨域限制），请先保存图片后拖入。");
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (readingImage) state.chat.pendingUploads = Math.max(0, state.chat.pendingUploads - 1);
    renderChatAttachments();
  }
}

async function uploadOne(file, kindHint, durationMs) {
  const dataBase64 = await fileToDataUrl(file);
  const { attachment } = await api("/api/upload", {
    method: "POST",
    body: JSON.stringify({ name: file.name || "upload", mime: file.type || "application/octet-stream", kind: kindHint, dataBase64, ...(durationMs ? { durationMs } : {}) }),
  });
  return attachment;
}

async function queueWebTranscription(attachment) {
  if (!attachment || attachment.kind !== "audio" || attachment._sttStatus === "transcribing") return;
  const controller = new AbortController();
  state.chat.sttControllers.get(attachment.url)?.abort();
  state.chat.sttControllers.set(attachment.url, controller);
  attachment._sttStatus = "transcribing";
  attachment._sttError = "";
  renderChatAttachments();
  try {
    const result = await api("/api/stt/transcribe", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ attachment }),
    });
    // 用户可能在等待时移除了附件；这时不应把已失去来源的文字突然塞进输入框。
    if (!state.chat.attachments.includes(attachment)) return;
    attachment._sttStatus = "done";
    attachment._sttText = result.text || "";
    attachment._sttProvider = result.provider || "STT";
    const input = $("#chatInput");
    if (input && attachment._sttText) {
      input.value = [input.value.trim(), attachment._sttText].filter(Boolean).join("\n");
      input.focus();
    }
    toast(`语音已转写 · ${attachment._sttProvider}`);
  } catch (e) {
    if (e?.name === "AbortError") return;
    if (!state.chat.attachments.includes(attachment)) return;
    attachment._sttStatus = "failed";
    attachment._sttError = e.message || "转写失败";
    toast(`语音转写失败：${attachment._sttError}`, true);
  } finally {
    if (state.chat.sttControllers.get(attachment.url) === controller) state.chat.sttControllers.delete(attachment.url);
    renderChatAttachments();
  }
}

async function handleFilesPicked(files) {
  if (!files.length) return { added: 0, failed: 0 };
  const blocked = chatAttachmentBlockedReason();
  if (blocked) { toast(blocked, true); return { added: 0, failed: files.length }; }
  let added = 0;
  let failed = 0;
  state.chat.pendingUploads += files.length;
  renderChatAttachments();
  for (const f of files) {
    let att = null;
    try {
      att = await uploadOne(f);
      state.chat.attachments.push(att);
      added += 1;
    } catch (e) {
      failed += 1;
      toast(`上传失败：${e.message}`, true);
    } finally {
      state.chat.pendingUploads = Math.max(0, state.chat.pendingUploads - 1);
      renderChatAttachments();
    }
    if (att?.kind === "audio") await queueWebTranscription(att);
  }
  return { added, failed };
}

// 录音：再点一次停止；停止后上传为 audio 附件。
async function toggleRecording() {
  const btn = $("#chatMic");
  if (state.rec) {
    state.rec.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return toast("当前环境不支持录音", true);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const durationMs = Math.max(1, Date.now() - (state.rec?.startedAt || Date.now()));
      state.rec = null;
      if (btn) { btn.classList.remove("recording"); btn.setAttribute("aria-pressed", "false"); btn.setAttribute("aria-label", "录音"); }
      renderChatSpeechStatus();
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const mediaType = recorder.mimeType || "audio/webm";
      const ext = mediaType.includes("ogg") ? "ogg" : mediaType.includes("mp4") ? "m4a" : "webm";
      try {
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
        const att = await uploadOne(file, "audio", durationMs);
        state.chat.attachments.push(att);
        renderChatAttachments();
        await queueWebTranscription(att);
      } catch (e) { toast(`录音上传失败：${e.message}`, true); }
    };
    recorder.start();
    state.rec = { recorder, stream, startedAt: Date.now() };
    if (btn) { btn.classList.add("recording"); btn.setAttribute("aria-pressed", "true"); btn.setAttribute("aria-label", "停止录音"); }
    renderChatSpeechStatus();
    toast("录音中…再点麦克风停止");
  } catch (e) {
    toast(`无法录音：${e.message}`, true);
  }
}

function createClientRunId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `web-${uuid.replace(/-/g, "").slice(0, 16)}` : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function executeChat(inputMode) {
  const chat = state.chat;
  const current = () => state.chat === chat;
  const requestedMode = inputMode === 'queue' || inputMode === 'steer' ? inputMode : undefined;
  if (window.HarbourChatIntake?.get()?.modeSaving) return toast("消息处理方式正在保存，请稍后发送。", true);
  if (chat.inspection) return toast("正在只读浏览其它会话；请返回任务，或待本轮结束后点“在此对话”。", true);
  if (chat.modelSaving || chat.coworkSaving || chat.switchingMode || chat.switchingSession) return toast("会话配置正在保存，请稍后发送。", true);
  if (chat.mode === "cowork" && chat.sessionsEnabled === false) return toast("Cowork 需要开启会话记忆，以保存执行目标。", true);
  if (chat.readOnlyMirror) return toast("这是外部渠道的只读镜像；请回到原应用回复，或新开 WEB 会话。", true);
  if (chat.pendingUploads > 0) return toast("附件还在上传，请等它加入输入框后再发送。", true);
  const agent = $("#chatAgent")?.value || DEFAULT_PERSONA;
  const skill = $("#chatSkill")?.value || "";
  const model = chat.model || "";
  const reasoningEffort = chat.reasoningEffort || "";
  const permissionMode = chat.permissionMode || "";
  const submittedChat = { mode: chat.mode, agent, sessionsEnabled: chat.sessionsEnabled, sessionId: chat.sessionId, sessionKey: currentSessionKey(), selectedSessionKey: chat.selectedSessionKey, cowork: chat.cowork ? { ...chat.cowork } : null };
  const originDeviceId = state.cowork.origin?.id || "";
  const inputEl = $("#chatInput");
  let startingGoal = null;
  if (chat.goalArmed && !isOpenChatGoal()) {
    try { startingGoal = readChatGoalConfig(); } catch (error) { return toast(error.message, true); }
  }
  const raw = inputEl.value.trim() || startingGoal?.objective || "";
  const attachments = chat.attachments.slice();
  const transcribing = attachments.filter((a) => a.kind === "audio" && a._sttStatus === "transcribing");
  if (transcribing.length) return toast("语音还在转写；完成后可先检查或修改文字再发送", true);
  const failedSpeech = attachments.filter((a) => a.kind === "audio" && a._sttStatus === "failed");
  if (failedSpeech.length && !raw) return toast("语音转写失败；请重试或补充文字后再发送", true);
  if (!raw && !attachments.length) return toast("请先输入消息或添加附件", true);
  if (chat.running && !chat.sessionId) return toast("当前任务正在启动，请稍后补充。", true);
  const goalCommand = globalThis.HarbourChatIntake?.goalCommand(raw);
  if (goalCommand) {
    if (goalCommand.action === 'show') { inputEl.value = ''; toggleChatGoal(); return; }
    if (goalCommand.action !== 'start') { inputEl.value = ''; await changeChatGoal(goalCommand.action); return; }
    if (chat.running || chat.intakeRunning) return toast('请先停止当前运行，再创建新目标；补充任务直接发送即可。', true);
    if (isOpenChatGoal()) return toast('当前已有目标，请先完成或取消它。', true);
    startingGoal = { objective: goalCommand.objective, autoContinue: true };
  }
  if ((chat.running || chat.intakeRunning || Object.values(chat.channelRuns || {}).some(run => run.sessionId === chat.sessionId) || chat.inputRequest?.sessionId === chat.sessionId || /^\/(收集|发完|collect|send|steer|queue|pending|收件箱|stop|停止)(\s|$)/i.test(raw)) && chat.sessionId) {
    const id = chat.sessionId;
    if (chat.inputSending) return;
    const attachmentKey = JSON.stringify(attachments);
    const request = chat.inputRequest?.text === raw && chat.inputRequest.sessionId === id && chat.inputRequest.attachmentKey === attachmentKey
      ? chat.inputRequest : { id: createClientRunId(), text: raw, sessionId: id, attachmentKey, mode: requestedMode || globalThis.HarbourChatIntake?.get()?.mode || 'steer' };
    chat.inputRequest = request;
    chat.inputSending = true;
    try {
      const receipt = await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'POST', body: JSON.stringify({
        input: raw, attachments, mode: request.mode, clientMessageId: request.id }) });
      if (!current() || chat.sessionId !== id) return;
      chat.inputRequest = null; if (inputEl.value.trim() === raw) inputEl.value = '';
      chat.attachments = chat.attachments.filter(a => !attachments.includes(a)); renderChatAttachments();
      chat.goalReloadSessionId = id;
      toast(receipt.reply || (receipt.state === 'withdrawn' ? '这条消息已撤回，未再次发送。' : receipt.isolated ? `仅这条${receipt.mode === 'queue' ? '排队' : '引导当前'}；会话默认不变` : receipt.mode === 'queue' ? '已加入待处理队列' : '已提交引导，等待当前任务接收'));
    } catch (error) { toast(`未确认投递：${error.message}。原文已保留，再次发送会使用同一编号核对。`, true); }
    finally { chat.inputSending = false; }
    return;
  }
  const plainInput = goalCommand?.action === 'start' ? goalCommand.objective
    : globalThis.HarbourChatIntake?.oneShotText(raw, attachments.length > 0) ?? raw;
  const input = skill ? `[skill:${skill}]\n${plainInput}` : plainInput;
  chat.landing = false;
  ++chat.detailRequestSeq; // 开始执行后，先前的详情快照不能再覆盖本地 pending。
  chat.agent = agent;
  chat.skill = skill;
  const checkpointWasInHistory = !!(chat.checkpoint?.id && chat.messages.some((message) =>
    message.runRecord?.checkpointId === chat.checkpoint.id
  ));
  const userMessage = { role: "user", content: raw, attachments, at: new Date().toISOString() };
  chat.messages.push(userMessage);
  const checkpointBeforeRun = chat.checkpoint;
  const clientRunId = createClientRunId();
  // 把「这条回复是谁说的」钉在消息上：气泡名字/头像都用它，而不是用当前选择器 ——
  // 否则中途换 agent，之前所有旧回复会被重新贴上新角色的名字和头像。
  const pending = { role: "assistant", content: "", pending: true, activity: "思考中…", agent, at: new Date().toISOString(), runStartedAt: Date.now() };
  chat.messages.push(pending);
  inputEl.value = "";
  chat.attachments = [];
  // 新一轮：清空 trace 缓冲 + 子 agent 深度表，置运行态。
  chat.trace = [];
  chat.subagents = {};
  chat.activeRunId = clientRunId;
  chat.stopping = false;
  // 【不清 plan】计划是本会话已持久化的产物：跟着会话走，直到出现新计划或用户手动收起。
  // 若本轮又派了 orchestrator，plan:submitted 会自然覆盖它——不预先清空，避免「当场消失、
  // 刷新又冒出来」的不一致（对抗复查 L3）。
  chat.running = true;
  chat.goalArmed = false;
  if (startingGoal) {
    // 先给本地即时反馈；后端返回后会替换为真正 goal id/status，失败则重新载入会话快照。
    chat.goal = { ...startingGoal, id: "pending", revision: 0, status: "active", usage: { roundsStarted: 0, roundsCompleted: 0, totalTokens: 0 } };
  }
  syncChatControlLocks();
  renderChatCheckpoint();
  renderChatGoal();
  renderChatAttachments();
  renderChatMessages();
  state.runningAgent = agent;
  state.runningSurface = "chat";
  // Session-backed runs acknowledge immediately, then read the same run's status.
  // The control-plane STOP is separate from this local observation signal.
  const abort = new AbortController();
  chat.abort = abort;
  setChatSendMode(true);
  chat.durationTicker = visualPoll(() => updatePendingDuration(pending), 500);
  let aborted = false;
  let completed = false;
  let reloadPersisted = false;
  let doneMsgCount = null; // 本轮结束时后端的消息数——annotate trace 时带上，防挂错轮次（M3）
  let serverDurationMs = null;
  try {
    if (submittedChat.sessionsEnabled !== false && !submittedChat.sessionId) {
      const { session } = await api("/api/conversations/new", {
        method: "POST", body: JSON.stringify({ key: submittedChat.sessionKey, channel: "web", agentName: agent }),
      });
      submittedChat.sessionId = session.id;
      submittedChat.selectedSessionKey = session.key;
      chat.sessionId = session.id;
      chat.selectedSessionKey = session.key;
      if (current()) pinChatWindow();
      if (chat.backgroundRun) {
        chat.backgroundRun.sessionId = session.id;
        chat.backgroundRun.sessionKey = session.key;
        void refreshSessionList();
      }
      if (submittedChat.mode === "cowork") {
        await api(`/api/conversations/${encodeURIComponent(session.id)}`, { method: "PATCH", body: JSON.stringify({ cowork: submittedChat.cowork }) });
      }
    }
    const runContext = chatRunContext(submittedChat, originDeviceId);
    if (chat.stopping) throw Object.assign(new Error("已停止"), { name: "AbortError" });
    const sttPrepared = attachments
      .filter((a) => a.kind === "audio" && a._sttStatus === "done" && a._sttText)
      .map((a) => a.url);
    const res = await submitRecoverableChatRun({ runId: clientRunId, agent, input, ...runContext, ...(startingGoal ? { goal: startingGoal } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(permissionMode ? { permissionMode } : {}), ...(attachments.length ? { attachments } : {}), ...(sttPrepared.length ? { sttPrepared } : {}) }, abort.signal, activity => {
      pending.activity = activity;
      if (current()) updatePendingActivity();
      else if (chat.backgroundRun) { chat.backgroundRun.activity = activity; updateChannelRunDom(chat.backgroundRun); }
    }, async (runId, sessionId) => {
      // STOP can race POST admission. A previous 404 is not proof of cancellation;
      // once the exact original run appears, deliver the still-pending stop intent.
      if (chat.stopping && chat.activeRunId === runId) {
        try { await api(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST', body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(15_000) }); }
        catch (error) { if (error.status !== 404) throw error; } // settled between lookup and STOP
      }
    });
    completed = !res.incomplete;
    reloadPersisted = !!(res.recovered || res.incomplete);
    pending.content = res.answer || "(empty)";
    pending.pending = false;
    if (Array.isArray(res.fileChanges) && res.fileChanges.length) pending.fileChanges = res.fileChanges;
    if (Array.isArray(res.calendarCards) && res.calendarCards.length) pending.calendarCards = res.calendarCards;
    if (Number.isFinite(res.durationMs)) serverDurationMs = res.durationMs;
    doneMsgCount = res.session?.messageCount ?? null;
    // 会话压缩提示：本轮触发了 compaction 就在流里插一条提示，并刷新下拉计数。
    if (res.session) {
      chat.displayedReply = { id: submittedChat.sessionId, key: submittedChat.sessionKey,
        replyRevision: res.session.replyRevision, readReplyRevision: res.session.readReplyRevision };
      window.HarbourChatUnread?.observe(chat.displayedReply);
      if (res.session.resumedFromCheckpoint) {
        // 后端历史会把原任务 + 本次续跑指令合并保存；本地也对齐，避免刷新前后气泡文字不同。
        if (checkpointBeforeRun?.originalInput && !checkpointWasInHistory) {
          userMessage.content = `${checkpointBeforeRun.originalInput}\n\n[中断后续跑指令] ${raw || "继续"}`;
        }
        if (current()) toast("已从 checkpoint 的首个未完成步骤恢复");
      }
      chat.checkpoint = res.session.checkpoint || null;
      chat.goal = res.session.goal || null;
      if (res.session.cowork && submittedChat.mode === "cowork") chat.cowork = coworkBindingForSession({ channel: "web", cowork: res.session.cowork });
      if (current()) { renderChatCheckpoint(); renderChatGoal(); }
      if (res.session.compactedThisRun) {
        chat.messages.push({
          role: "notice",
          content: `🗜 上下文已压缩：早前对话被收拢成摘要以节省 token（本会话累计压缩 ${res.session.compactions} 次）。Harbour 仍记得要点。`,
        });
      }
      refreshSessionList();
    }
  } catch (e) {
    // Stop intent alone is not a cancellation receipt (e.g. auth can expire while
    // reconciling an early STOP). Only an actual abort may claim the run stopped.
    const stopped = e?.name === "AbortError" || e?.status === 499 || e?.code === "RUN_ABORTED";
    if (stopped) {
      aborted = true;
      reloadPersisted = true;
      pending.content = e?.data?.reason
        ? `⏹ ${e.data.reason}。本轮输入、Trace 与 checkpoint 已保存。`
        : "⏹ 已停止 · 本轮输入、Trace 与 checkpoint 已保存。发送「继续」会从最后一个已完成工具步骤之后恢复。";
      pending.pending = false;
      const resumingSameTask = checkpointBeforeRun?.status === "interrupted" && /^(?:请)?(?:继续|接着|恢复|从断点继续|resume(?:\s|$)|continue(?:\s|$))/i.test(raw.trim());
      chat.checkpoint = e?.data?.session?.checkpoint || {
        ...(checkpointBeforeRun || {}),
        status: "interrupted",
        originalInput: resumingSameTask ? checkpointBeforeRun.originalInput : input,
        completed: checkpointBeforeRun?.completed || 0,
        replayable: checkpointBeforeRun?.replayable || 0,
        pending: checkpointBeforeRun?.pending || 0,
      };
      if (e?.data?.session?.goal) chat.goal = e.data.session.goal;
      if (current()) { renderChatCheckpoint(); renderChatGoal(); }
      setTimeout(() => syncActiveCheckpoint(0, submittedChat.sessionId), 220);
    } else {
      reloadPersisted = true;
      pending.content = `⚠ ${e.message}`;
      pending.pending = false;
      toast(current() ? e.message : `会话 ${submittedChat.sessionId || agent}：${e.message}`, true);
    }
  } finally {
    stopVisualTimer(chat.durationTicker);
    chat.durationTicker = null;
    const endedAt = pending.runEndedAt || Date.now();
    pending.durationMs = Number.isFinite(serverDurationMs) ? serverDurationMs : Math.max(0, endedAt - pending.runStartedAt);
    delete pending.runStartedAt;
    delete pending.runEndedAt;
    chat.abort = null;
    chat.activeRunId = "";
    chat.stopping = false;
    if (current()) { state.runningAgent = null; state.runningSurface = null; }
    chat.running = false;
    // Finish only the original run. Navigation must never clear another task's
    // STOP handle, trace, draft, GOAL, or selected session.
    pending.trace = chat.trace.slice();
    if (chat.backgroundRun && chat.channelRuns[clientRunId] === chat.backgroundRun) {
      delete chat.channelRuns[clientRunId];
    }
    if (current()) {
      if (chat.deletedSessionIds?.has(chat.sessionId)) applyDeletedChatSession(chat.sessionId);
      syncChatControlLocks();
      setChatSendMode(false);
      renderChatCheckpoint();
      renderChatGoal();
      renderChatMessages();
      enrichNewsReports();
    } else {
      renderSessionList();
    }
    // 成功轮由前端补展示态；停止/失败轮已由后端按 runId 原子落 input + trace + 耗时，
    // 不能再用“最后一条 assistant”去 annotate，否则多 tab 时可能挂错轮。
    if (completed && !aborted && !reloadPersisted) persistChatAnnotations(pending.trace, doneMsgCount, { ...submittedChat, plan: chat.plan });
    if ((reloadPersisted || !current() || chat.goalReloadSessionId === submittedChat.sessionId) && submittedChat.sessionId) {
      chat.goalReloadSessionId = null;
      await loadConversationMessages(submittedChat.sessionId);
    }
  }
}

// Submit once. Subsequent traffic is read-only and bound to the original run +
// session, including when the POST acknowledgement itself was lost.
async function submitRecoverableChatRun(body, signal, onWaiting, onRunning) {
  const sessionId = body.session?.id;
  const pause = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  let receipt;
  try {
    receipt = await api('/api/run', { method: 'POST', signal, headers: { Prefer: 'respond-async' }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted || !sessionId || (error.status && error.status < 500)) throw error;
    // No retry of this POST. A lost acknowledgement does not prove non-execution.
    onWaiting?.('连接暂时断开 · 正在核对原任务，不会重新提交…');
    receipt = { accepted: true };
  }
  if (!receipt.accepted) return receipt; // old backend / stateless compatibility
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
      const result = await api(`/api/runs/${encodeURIComponent(body.runId)}?sessionId=${encodeURIComponent(sessionId)}`, { signal: requestSignal });
      if (result.runId !== body.runId || (result.sessionId ?? result.session?.id) !== sessionId)
        throw Object.assign(new Error('运行回执不匹配，已停止查询；未重新提交'), { status: 409 });
      if (result.status === 'settled') return { ...result, recovered: true };
      if (result.status === 'failed') throw Object.assign(new Error(result.error || '原任务执行失败，请查看已保存记录'), { status: 422 });
      if (!['running', 'stopping'].includes(result.status)) throw Object.assign(new Error('运行状态无法核实，未重新提交'), { status: 409 });
      if (result.status === 'running') await onRunning?.(body.runId, sessionId);
      if (failures) onWaiting?.('已重新连接 · 原任务仍在执行…');
      failures = 0;
    } catch (error) {
      if (signal?.aborted || (error.status && error.status < 500)) throw error;
      failures++;
      onWaiting?.('连接暂时断开 · 原任务由后端继续，正在重新连接…');
    }
    await pause(Math.min(15_000, failures ? 2000 * failures : 3000));
  }
}

async function requestChatStop() {
  if (state.chat.inspection) return toast("请先返回原任务，再停止；不会停止当前浏览的其它会话。", true);
  if (state.chat.running) return stopLocalChatRun(state.chat);
  const run = Object.values(state.chat.channelRuns || {}).find(run => run.sessionId === state.chat.sessionId && run.canStop);
  if (run) return stopChannelRun(run.id, run.sessionId);
  if (!state.chat.intakeRunning || !state.chat.sessionId) return;
  const id = state.chat.sessionId;
  try { await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'PATCH', body: '{"action":"stop"}' }); toast('已请求停止，待处理消息保留。'); }
  catch (error) { toast(error.message, true); }
}

/** Exact captured run, including STOP before POST admission and navigation while
 * the STOP request is in flight. A failed acknowledgement is never cancellation. */
async function stopLocalChatRun(chat) {
  if (!chat.running || chat.stopping) return;
  const current = () => state.chat === chat;
  const runId = chat.activeRunId;
  const pending = chat.messages.findLast(message => message.pending && !message.externalEphemeral);
  const show = () => {
    if (chat.backgroundRun) {
      chat.backgroundRun.stopping = chat.stopping;
      chat.backgroundRun.activity = pending?.activity || '';
      if (chat.backgroundRun.sessionId === viewedChatSessionId()) renderSelectedChannelRuns();
    }
    if (!current()) return;
    updatePendingActivity(); updatePendingDuration(pending); updatePendingTrace();
    const btn = $('#chatStop');
    if (btn) { btn.textContent = chat.stopping ? '正在停止…' : '停止'; btn.disabled = chat.stopping; }
    setChatSendMode(chat.running);
  };
  chat.stopping = true;
  if (pending?.runStartedAt) {
    pending.runEndedAt = Date.now();
    pending.activity = "正在停止并保存 Trace…";
  }
  stopVisualTimer(chat.durationTicker);
  chat.durationTicker = null;
  chat.trace.push({ cls: "fallback", tag: "STOP", text: "已请求停止；正在取消模型、子 Agent 与工具，并持久化中断轮次。", agent: chat.agent, depth: 0 });
  show();
  if (!runId) { chat.abort?.abort(new Error("user stop")); return; }
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: "POST", body: JSON.stringify({ sessionId: chat.sessionId }), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (!chat.running) return; // HTTP completion won the race.
    if (error?.status === 404) {
      if (chat.sessionId) {
        if (pending?.pending) pending.activity = '正在核对原任务并停止…';
        show();
      } else window.setTimeout(() => {
        if (chat.running && chat.activeRunId === runId) chat.abort?.abort(new Error("user stop"));
      }, 800);
    } else {
      chat.stopping = false;
      if (pending?.pending) {
        delete pending.runEndedAt;
        pending.activity = '停止尚未确认 · 请重试停止';
        if (current()) chat.durationTicker = visualPoll(() => updatePendingDuration(pending), 500);
      }
      show();
      toast('停止请求未送达，任务可能仍在后端执行，请重试停止。', true);
    }
  }
}

/** Sending and stopping are separate actions; an active run must not steal the send button. */
function setChatSendMode(running) {
  const btn = $("#chatSend");
  if (!btn) return;
  btn.innerHTML = chatComposerIcon('send');
  btn.setAttribute('aria-label', '发送消息');
  btn.classList.remove('is-stop'); btn.onclick = null;
  btn.disabled = !!(state.chat.readOnlyMirror || state.chat.inspection || state.chat.stopping || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession || state.chat.pendingUploads);
  const stop = $('#chatStop');
  if (stop) {
    stop.hidden = !(running || state.chat.intakeRunning) || !!state.chat.readOnlyMirror;
    stop.disabled = !!(state.chat.stopping || state.chat.inspection);
    stop.setAttribute('aria-label', state.chat.stopping ? '停止中' : '停止当前任务');
    stop.setAttribute('aria-busy', String(!!state.chat.stopping));
  }
}

/** 把本轮展示态（trace + 当前 plan）落到后端会话，供切会话/刷新后还原。纯展示、失败无所谓。 */
function persistChatAnnotations(trace, expectMsgCount, submitted = state.chat) {
  const id = submitted.sessionId;
  if (!id) return;
  const payload = {};
  if (Array.isArray(trace) && trace.length) payload.trace = trace;
  if (submitted.plan) payload.plan = submitted.plan;
  if (typeof expectMsgCount === "number") payload.expectMsgCount = expectMsgCount; // 防 trace 挂错轮次
  if (!("trace" in payload) && !("plan" in payload)) return;
  api(`/api/conversations/annotate`, { method: "POST", body: JSON.stringify({ key: submitted.selectedSessionKey || submitted.sessionKey, id, ...payload }) }).catch(() => {});
}

/* ── 图表（Apache ECharts，本地 vendor）：主题取色 + 交互（tooltip / 图例开关 / 时间轴缩放）──── */
const mmdd = (d) => (d ? d.slice(5) : ""); // YYYY-MM-DD → MM-DD
const dashFont = () => getComputedStyle(document.body).getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";

// 把任意 CSS 颜色（var 解析后的 hex/hsl 等）解析成 rgb(...)，供 ECharts + 透明度换算用。
function resolveColor(v, fb) {
  v = (v || "").toString().trim();
  if (!v) return fb;
  const el = resolveColor._el || (resolveColor._el = document.createElement("span"));
  el.style.color = ""; el.style.color = v;
  if (!el.style.color) return fb;
  el.style.cssText += ";position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color; el.remove();
  return rgb || fb;
}
const withAlpha = (rgb, a) => {
  const m = /rgba?\(([^)]+)\)/.exec(rgb || "");
  if (!m) return rgb;
  const p = m[1].split(",").map((s) => s.trim());
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${a})`;
};
// 从当前主题的 CSS 变量取一套图表配色（换主题即变）。
function dashPalette() {
  const cs = getComputedStyle(document.body);
  const g = (name, fb) => resolveColor(cs.getPropertyValue(name), fb);
  return {
    fg: g("--fg", "rgb(232,234,240)"), dim: g("--fg-dim", "rgb(154,160,176)"), faint: g("--fg-faint", "rgb(107,113,128)"),
    grid: g("--border", "rgb(42,46,58)"), accent: g("--accent", "rgb(129,140,248)"), accent2: g("--accent-2", "rgb(79,214,232)"),
    ok: g("--ok", "rgb(52,211,153)"), danger: g("--danger", "rgb(251,113,133)"), panel: g("--elev", "rgb(26,29,40)"),
  };
}
// 时间轴缩放滑块（折线/堆叠柱共用），主题着色。
function ecSlider(pal) {
  return {
    type: "slider", height: 15, bottom: 6, borderColor: "transparent",
    backgroundColor: withAlpha(pal.grid, 0.2), fillerColor: withAlpha(pal.accent, 0.15),
    handleStyle: { color: pal.accent, borderColor: pal.accent }, moveHandleStyle: { color: pal.accent },
    dataBackground: { lineStyle: { color: pal.faint }, areaStyle: { color: withAlpha(pal.faint, 0.15) } },
    selectedDataBackground: { lineStyle: { color: pal.accent }, areaStyle: { color: withAlpha(pal.accent, 0.2) } },
    textStyle: { color: pal.faint, fontSize: 10 },
  };
}
const ecTooltip = (pal, extra = {}) => ({
  trigger: "axis", confine: true, backgroundColor: pal.panel, borderColor: pal.grid, borderWidth: 1,
  padding: [8, 11], textStyle: { color: pal.fg, fontSize: 12 },
  extraCssText: "border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.4)", ...extra,
});
const ecLegend = (names, pal) => ({
  data: names, top: 2, right: 4, textStyle: { color: pal.dim, fontSize: 11 },
  icon: "roundRect", itemWidth: 11, itemHeight: 7, itemGap: 13, inactiveColor: withAlpha(pal.faint, 0.45),
});
const ecCatAxis = (dates, pal) => ({
  type: "category", data: dates.map(mmdd), boundaryGap: false,
  axisLine: { lineStyle: { color: pal.grid } }, axisTick: { show: false }, axisLabel: { color: pal.faint, fontSize: 11 },
});
const ecValAxis = (pal, yFmt) => ({
  type: "value", splitLine: { lineStyle: { color: pal.grid, type: "dashed", opacity: 0.55 } },
  axisLabel: { color: pal.faint, fontSize: 11, formatter: (v) => yFmt(v) },
});

// 多序列折线图 option。series=[{name,color,values[],area?}]。
function ecLine(dates, series, opts = {}) {
  const pal = dashPalette();
  const yFmt = opts.yFmt || fmtNum;
  const cols = series.map((s) => resolveColor(s.color, pal.accent));
  return {
    backgroundColor: "transparent", color: cols, textStyle: { fontFamily: dashFont() }, animationDuration: 500,
    tooltip: ecTooltip(pal, { valueFormatter: (v) => yFmt(v), axisPointer: { type: "line", lineStyle: { color: withAlpha(pal.faint, 0.7) } } }),
    legend: ecLegend(series.map((s) => s.name), pal),
    grid: { left: 6, right: 16, top: 34, bottom: 40, containLabel: true },
    xAxis: ecCatAxis(dates, pal), yAxis: ecValAxis(pal, yFmt),
    dataZoom: opts.zoom === false ? undefined : [{ type: "inside", throttle: 50 }, ecSlider(pal)],
    series: series.map((s, i) => ({
      name: s.name, type: "line", smooth: 0.35, showSymbol: false, symbol: "circle", symbolSize: 6,
      lineStyle: { width: 2 }, emphasis: { focus: "series" },
      areaStyle: s.area ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: withAlpha(cols[i], 0.28) }, { offset: 1, color: withAlpha(cols[i], 0.01) }]) } : undefined,
      data: s.values,
    })),
  };
}

// 横向条形图 option：items=[{label,value,color?}]（按 value 降序传入）。
function ecBarH(items, opts = {}) {
  const pal = dashPalette();
  const fmt = opts.fmt || fmtNum;
  const data = items.map((i) => ({ value: i.value, itemStyle: { color: resolveColor(i.color, pal.accent), borderRadius: [0, 4, 4, 0] } }));
  return {
    backgroundColor: "transparent", textStyle: { fontFamily: dashFont() }, animationDuration: 500,
    tooltip: { ...ecTooltip(pal, { valueFormatter: (v) => fmt(v) }), axisPointer: { type: "shadow", shadowStyle: { color: withAlpha(pal.accent, 0.08) } } },
    grid: { left: 6, right: 62, top: 8, bottom: 6, containLabel: true },
    xAxis: ecValAxis(pal, fmt),
    yAxis: { type: "category", data: items.map((i) => i.label).reverse(), axisLine: { lineStyle: { color: pal.grid } }, axisTick: { show: false }, axisLabel: { color: pal.dim, fontSize: 11 } },
    series: [{ type: "bar", data: data.reverse(), barMaxWidth: 20, label: { show: true, position: "right", color: pal.dim, fontSize: 11, formatter: (p) => fmt(p.value) } }],
  };
}
const emptyChart = () => `<div class="empty chart-empty">跑一次 agent 后这里按天累积（持久化，重启不丢）。</div>`;

// agent 配色（堆叠图/条形/表格共用，按序分配）。
const AGENT_COLORS = ["#818cf8", "#4fd6e8", "#34d399", "#fbbf24", "#fb7185", "#a78bfa", "#f472b6", "#22d3ee", "#a3e635", "#fb923c", "#e879f9", "#60a5fa"];
const agentColor = (i) => AGENT_COLORS[i % AGENT_COLORS.length];

// 堆叠柱状图 option：X=日期，每天一根柱、按 category（agent）堆叠。categories=[{name,color,values[]}]。
function ecStack(dates, categories) {
  const pal = dashPalette();
  return {
    backgroundColor: "transparent", color: categories.map((c) => resolveColor(c.color, pal.accent)),
    textStyle: { fontFamily: dashFont() }, animationDuration: 500,
    tooltip: { ...ecTooltip(pal, { valueFormatter: (v) => fmtNum(v), order: "valueDesc" }), axisPointer: { type: "shadow", shadowStyle: { color: withAlpha(pal.accent, 0.08) } } },
    legend: { ...ecLegend(categories.map((c) => c.name), pal), type: "scroll" },
    grid: { left: 6, right: 16, top: 34, bottom: 40, containLabel: true },
    xAxis: { ...ecCatAxis(dates, pal), boundaryGap: true },
    yAxis: ecValAxis(pal, fmtNum),
    dataZoom: [{ type: "inside", throttle: 50 }, ecSlider(pal)],
    series: categories.map((c) => ({ name: c.name, type: "bar", stack: "tok", barMaxWidth: 26, emphasis: { focus: "series" }, data: c.values })),
  };
}

/* ── ECharts 实例生命周期：主区每 4s 会重建 DOM，但仅在 scope/range/agent 集变化时重建骨架，
      稳态只 setOption（平滑动画、保留缩放/hover、不闪）。切走 dashboard 时 dispose 释放。 ── */
const dashCharts = new Map(); // hostId -> echarts 实例
function ecEnsure(id) {
  const el = document.getElementById(id);
  if (!el || !window.echarts) return null;
  let inst = dashCharts.get(id);
  if (inst && !inst.isDisposed() && inst.getDom() === el) return inst;
  if (inst && !inst.isDisposed()) { if (inst.__ro) inst.__ro.disconnect(); inst.dispose(); }
  inst = echarts.init(el, null, { renderer: "svg" });
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!inst.isDisposed()) inst.resize(); }); ro.observe(el); inst.__ro = ro; }
  dashCharts.set(id, inst);
  return inst;
}
function ecSet(id, option) {
  const inst = ecEnsure(id);
  if (!inst) return;
  // 数据没变就别重复 setOption：否则每 4s 刷新都重放入场动画、还会重置用户的缩放/hover。
  const sig = JSON.stringify([option.series, option.xAxis, option.yAxis && option.yAxis.type]);
  if (inst.__sig === sig) return;
  inst.__sig = sig;
  inst.setOption(option, { notMerge: true });
}
function disposeDashCharts() {
  for (const inst of dashCharts.values()) { try { if (inst.__ro) inst.__ro.disconnect(); inst.dispose(); } catch (e) { /* noop */ } }
  dashCharts.clear();
}

// 一组 agent 的累计拆解行（表 + 图共用）。agentSeriesMap={agent: 已切片按天桶[]}，与 dates 对齐。
function agentRowsOf(agentSeriesMap) {
  return Object.keys(agentSeriesMap).map((a, idx) => {
    const ser = agentSeriesMap[a] || [];
    const s = (f) => ser.reduce((x, r) => x + f(r), 0);
    const miss = s((r) => r.input), output = s((r) => r.output), cached = s((r) => r.cached), cacheCreation = s((r) => r.cacheCreation || 0), runs = s((r) => r.runs), errors = s((r) => r.errors);
    const input = miss + cached + cacheCreation;
    return { agent: a, color: agentColor(idx), input, output, total: input + output, cacheRatio: input > 0 ? cached / input : null, runs, ok: runs - errors, series: ser };
  }).filter((r) => r.total > 0 || r.runs > 0).sort((a, b) => b.total - a.total);
}
function agentTableHtml(rows) {
  return `<div class="tbl-wrap"><table class="tbl tbl-compact">
    <thead><tr><th>AGENT</th><th>输入</th><th>输出</th><th>总 token</th><th>cache率</th><th>请求</th><th>成功</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="cell-ell" title="${esc(r.agent)}"><span class="agent-dot" style="background:${r.color}"></span>${esc(r.agent)}</td>
      <td class="mono">${fmtNum(r.input)}</td><td class="mono">${fmtNum(r.output)}</td>
      <td class="mono"><b>${fmtNum(r.total)}</b></td><td class="mono">${fmtPct(r.cacheRatio)}</td>
      <td class="mono">${fmtNum(r.runs)}</td><td class="mono">${fmtNum(r.ok)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* ── DASHBOARD：抽屉式 scope 侧栏（总体 / 按模型）+ 日期范围筛选 + 每 scope 一套 tab & 图表 ── */
const DASH_RANGES = [{ k: 7, label: "7天" }, { k: 14, label: "14天" }, { k: 30, label: "30天" }, { k: null, label: "全部" }];
// scope 栏默认展开（用户：dashboard 侧栏要常驻可见，不做隐藏抽屉；☰ 仍可手动收起）。
const dashView = { scopeKind: "overall", scopeKey: null, rangeDays: null, pinned: true, scopeHover: false, ts: null, snap: null, modelNames: {}, modelRawNames: {}, pricing: null };

let dashboardChartsLoading;
function loadDashboardCharts() {
  if (window.echarts) return Promise.resolve();
  if (!dashboardChartsLoading) dashboardChartsLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = "/vendor/echarts.min.js";
    const timeout = setTimeout(() => fail(), 15_000);
    script.onload = () => { if (window.echarts) { clearTimeout(timeout); resolve(); } else fail(); };
    const fail = () => { clearTimeout(timeout); script.remove(); dashboardChartsLoading = null; reject(new Error("图表库加载失败，请重新打开统计页")); };
    script.onerror = fail; document.head.appendChild(script);
  });
  return dashboardChartsLoading;
}

PANELS.dashboard = {
  id: "dashboard",
  async render(root) {
    await loadDashboardCharts();
    root.innerHTML = `
      <div class="panel-head"><h2>DASHBOARD</h2><span class="sub">// 运行指标 · 持久累计（重启不丢）· 实时</span>
        <button class="btn ghost icon dash-scope-toggle${dashView.pinned ? " active" : ""}" id="dashScopeToggle" title="展开/固定左侧 scope 栏（也可鼠标移到左边缘唤出）">☰</button>
        <span class="spacer"></span>
        <div class="seg" id="dashRange">${DASH_RANGES.map((r) => `<button class="seg-btn${dashView.rangeDays === r.k ? " active" : ""}" data-range="${r.k == null ? "" : r.k}">${r.label}</button>`).join("")}</div>
        <span class="pill" id="dashLive">● LIVE</span></div>
      <div class="dash-shell${dashView.pinned ? " open" : ""}" id="dashShell">
        <div class="dash-scope-edge" title="移到这里唤出 scope 栏"></div>
        <aside class="dash-scope" id="dashScope"><div class="empty">加载…</div></aside>
        <section class="dash-main" id="dashMain"><div class="empty">加载指标…</div></section>
      </div>`;
    disposeDashCharts(); dashView.mainSig = null; // DOM 刚重建，清掉上次的图表实例，强制重建骨架
    const shell = $("#dashShell");
    const applyOpen = () => shell.classList.toggle("open", dashView.pinned || dashView.scopeHover);
    $("#dashScopeToggle").addEventListener("click", () => {
      dashView.pinned = !dashView.pinned;
      $("#dashScopeToggle").classList.toggle("active", dashView.pinned);
      applyOpen();
    });
    // hover 左边缘唤出、离开抽屉收起（除非已固定）。
    shell.querySelector(".dash-scope-edge").addEventListener("mouseenter", () => { dashView.scopeHover = true; applyOpen(); });
    $("#dashScope").addEventListener("mouseleave", () => { dashView.scopeHover = false; applyOpen(); });
    $("#dashRange").querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      dashView.rangeDays = b.dataset.range ? Number(b.dataset.range) : null;
      $("#dashRange").querySelectorAll("[data-range]").forEach((x) => x.classList.toggle("active", x === b));
      renderDashMain();
    }));
    const host = $("#dashMain");
    let metadataAt = 0;
    const refresh = async () => {
      if ($("#dashMain") !== host) { stopVisualTimer(timer); if (state.panelTimer === timer) state.panelTimer = null; return; }
      try {
        const refreshMetadata = !metadataAt || Date.now() - metadataAt >= 60_000;
        const [ts, snap, models, pricing] = await Promise.all([
          api("/api/metrics/timeseries?days=60"), api("/api/metrics"),
          refreshMetadata ? api("/api/models").catch(() => null) : null,
          refreshMetadata ? api("/api/pricing").catch(() => null) : null,
        ]);
        if ($("#dashMain") !== host) return; // Late results cannot update a different mount.
        // Dashboard 按实际 model id 分类，不按连接槽分类：两个 API 槽若都调用 foo，统一汇总到 foo。
        if (models) {
          const configured = [...new Set((models.models || []).map((m) => m.modelName).filter(Boolean))];
          dashView.modelNames = Object.fromEntries((models.models || []).map((m) => [m.modelName, m.modelLabel || m.modelName]));
          dashView.modelRawNames = Object.fromEntries(configured.map((m) => [m, m]));
        }
        if (pricing) dashView.pricing = pricing.pricing;
        if (refreshMetadata) metadataAt = Date.now();
        dashView.ts = ts; dashView.snap = snap;
        if (!document.hidden && window.HarbourVisualActivity?.isActive() !== false) { renderDashScope(); renderDashMain(); }
      } catch (e) { if ($("#dashMain") === host) host.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; }
    };
    const timer = visualPoll(refresh, 4000, { immediate: false });
    state.panelTimer = timer;
    await timer.refresh?.();
  },
};

// modelRef（claude-agent/default 这种内部前缀）→ 真实模型名（kimi-for-coding）。取不到就退回去掉 /default 的前缀。
function dashModelLabel(ref) {
  return (dashView.modelNames && dashView.modelNames[ref]) || ref.replace(/\/default$/, "");
}
function modelMaker(modelId) {
  const m = String(modelId || "").toLowerCase();
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("kimi") || m.includes("moonshot")) return "Moonshot AI";
  if (m.includes("claude") || m.startsWith("anthropic/")) return "Anthropic";
  if (m.includes("gemini") || m.startsWith("google/")) return "Google";
  if (/^(gpt|o\d|chatgpt)/.test(m) || m.startsWith("openai/")) return "OpenAI";
  if (m.includes("minimax")) return "MiniMax";
  if (m.includes("qwen") || m.includes("tongyi")) return "Alibaba";
  return "Other";
}
function modelFreshness(a, b) {
  // 先比世代，再比同世代档位：K3 必须排在 K2.7 Highspeed 前，不能让“高速档”越代。
  // kimi-for-coding 是官方滚动虚拟模型（永远映射当前 coding 档），视为 current。
  const generation = (s) => {
    const id = String(s || "").toLowerCase();
    if (id.includes("kimi-for-coding")) return [Number.MAX_SAFE_INTEGER, 0];
    const hits = [...id.matchAll(/(?:kimi-k|deepseek-v|moonshot-v|claude-|gpt-|gemini-)(\d+)(?:[.-](\d+))?/g)];
    if (!hits.length) return [0, 0];
    return hits.reduce((best, hit) => {
      const next = [Number(hit[1]) || 0, Number(hit[2]) || 0];
      return next[0] > best[0] || (next[0] === best[0] && next[1] > best[1]) ? next : best;
    }, [0, 0]);
  };
  const ag = generation(a), bg = generation(b);
  if (ag[0] !== bg[0]) return bg[0] - ag[0];
  if (ag[1] !== bg[1]) return bg[1] - ag[1];
  // 同代产品档位按 Pro / Flash / Highspeed / Auto 排，之后按 id 倒序稳定收口。
  const tier = (s) => /pro/i.test(s) ? 4 : /flash/i.test(s) ? 3 : /highspeed/i.test(s) ? 2 : /auto/i.test(s) ? 1 : 0;
  const av = tier(a), bv = tier(b);
  if (av !== bv) return bv - av;
  return String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: "base" });
}
function groupModelsByMaker(modelIds) {
  const groups = new Map();
  for (const id of modelIds) {
    const maker = modelMaker(id);
    if (!groups.has(maker)) groups.set(maker, []);
    groups.get(maker).push(id);
  }
  const makerOrder = ["OpenAI", "Anthropic", "Google", "DeepSeek", "Moonshot AI", "Alibaba", "MiniMax", "Other"];
  return [...groups].sort((a, b) => makerOrder.indexOf(a[0]) - makerOrder.indexOf(b[0]))
    .map(([maker, ids]) => [maker, ids.sort(modelFreshness)]);
}
function renderDashScope() {
  const box = $("#dashScope"); const ts = dashView.ts;
  if (!box || !ts) return;
  const item = (kind, key, label) => `<button class="dash-scope-item dash-scope-${kind}${dashView.scopeKind === kind && dashView.scopeKey === key ? " active" : ""}" data-sk="${kind}" data-skey="${key == null ? "" : esc(key)}" title="${esc(label)}">${esc(label)}</button>`;
  // 只列真正产生过用量的模型；按厂家分 subsection，避免目录里十几个零用量型号把侧栏挤满。
  const modelGroups = groupModelsByMaker(ts.models || []);
  box.innerHTML = `
    <div class="dash-scope-title">
      <span class="dash-scope-title-mark" aria-hidden="true">✦</span>
      <span class="dash-scope-title-copy"><small>USAGE VIEW</small><strong>浏览范围</strong></span>
    </div>
    ${item("overall", null, "总体")}
    <div class="dash-scope-h"><span>按模型</span></div>
    ${modelGroups.length ? modelGroups.map(([maker, ids]) => `
      <div class="dash-scope-maker">
        <span class="dash-maker-mark" aria-hidden="true">◆</span>
        <span class="dash-maker-name">${esc(maker)}</span>
        <span class="dash-maker-rule" aria-hidden="true"></span>
        <span class="dash-maker-count" aria-label="${ids.length} 个模型">${ids.length}</span>
      </div>
      ${ids.map((m) => item("model", m, dashModelLabel(m))).join("")}`).join("") : `<div class="dash-scope-empty">暂无用量</div>`}
    <div class="dash-scope-note">各 agent 消耗 / 对比在「总体」和每个模型视图里展开看。</div>`;
  box.querySelectorAll("[data-sk]").forEach((b) => b.addEventListener("click", () => {
    dashView.scopeKind = b.dataset.sk; dashView.scopeKey = b.dataset.skey || null;
    renderDashScope(); renderDashMain();
  }));
}

function renderDashMain() {
  const box = $("#dashMain"); const ts = dashView.ts; const snap = dashView.snap || {};
  if (!box || !ts) return;
  const N = dashView.rangeDays;
  const sl = (arr) => (N && arr.length > N ? arr.slice(-N) : arr); // 按日期范围切片（客户端）
  const dates = sl(ts.days || []);
  const baseRows = dashView.scopeKind === "model" ? (ts.byModel[dashView.scopeKey] || []) : (ts.overall || []);
  const rows = sl(baseRows);
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const sIn = sum((r) => r.input), sOut = sum((r) => r.output), sCached = sum((r) => r.cached), sCacheCreation = sum((r) => r.cacheCreation || 0), sRuns = sum((r) => r.runs), sErr = sum((r) => r.errors);
  const sInputTotal = sIn + sCached + sCacheCreation;
  const sTotal = sInputTotal + sOut;
  const cacheRatio = sInputTotal > 0 ? sCached / sInputTotal : null;
  const scopeLabel = dashView.scopeKind === "overall" ? "总体" : dashModelLabel(dashView.scopeKey);
  const rangeLabel = N ? `近 ${N} 天` : "全部";
  const hasData = dates.length && sTotal + sRuns > 0;

  // agent 拆解数据（总体用 byAgent；某模型用 byModelAgent[model]）——切片后与 dates 对齐。
  const agentSrc = dashView.scopeKind === "model" ? (ts.byModelAgent[dashView.scopeKey] || {}) : ts.byAgent;
  const agentMap = {};
  for (const a of Object.keys(agentSrc)) agentMap[a] = sl(agentSrc[a]);
  const agRows = agentRowsOf(agentMap);
  const cap = dashView.scopeKind === "model" ? ` · ${esc(scopeLabel)}` : "";

  // 历史成本直接汇总 usage 发生时已冻结的账本金额。计价表刷新只供之后的新 usage 入账，
  // 绝不能拿当前价格乘历史 token；当时无价的 usage 单独标为未知并永久保留这个事实。
  const pricing = dashView.pricing;
  const dispCur = (pricing && pricing.displayCurrency) || "USD";
  const sym = curSym(dispCur);
  const ledgerCurrency = ts.costCurrency || "USD";
  const costModels = dashView.scopeKind === "model" ? [dashView.scopeKey] : Object.keys(ts.byModel || {});
  const estCost = bookedCost(rows, ledgerCurrency);
  const unpricedTokenCount = bookedUnpricedTokens(rows);
  const unpriced = [];
  for (const m of costModels) {
    const modelRows = dashView.scopeKind === "model" ? rows : sl(ts.byModel[m] || []);
    if (bookedUnpricedTokens(modelRows) > 0) unpriced.push(dashModelLabel(m));
  }
  const allUnpriced = sTotal > 0 && unpricedTokenCount >= sTotal;

  const modelRateLine = dashView.scopeKind === "model" ? costModels.map((m) => {
    const label = dashModelLabel(m), p = priceForRef(m);
    if (!p) return `<span class="ct-m">${esc(label)}</span>：<span class="ct-unknown">当前新账未配单价</span>`;
    const c = curSym(p.cur), rate = p.activeRates || p;
    const tag = p.source === "manual" ? "手工锁定" : p.source === "official" ? "官方直连" : "自动";
    const tier = p.activeRateTier === "peak" ? "当前峰时" : p.activeRateTier === "offPeak" ? "当前谷时" : "固定价";
    const rateNote = p.rateNote ? `<br><span class="ct-f">${esc(p.rateNote)}${p.rateSchedule?.peakHours ? ` 峰时：${esc(p.rateSchedule.peakHours)}` : ""}</span>` : "";
    return `<span class="ct-m">${esc(label)}</span> 当前新账：输入 ${c}${rate.in} · 缓存读 ${c}${rate.cacheRead} · 缓存写 ${c}${rate.cacheWrite} · 输出 ${c}${rate.out} <span class="ct-u">/1M tok · ${tag} · ${tier}</span>${rateNote}`;
  }).join("<br>") : "";

  const fxLine = pricing && pricing.fx
    ? `<span class="ct-f">汇率（→${esc(dispCur)}）：` +
      Object.entries(pricing.fx).filter(([k]) => k !== dispCur).map(([k, v]) => `${esc(k)}×${v}`).join("、") +
      `　汇率会漂，觉得不对直接改 data/modelPricing.json</span>`
    : "";
  const freshLine = pricing && pricing.updatedAt
        ? `<span class="ct-f">当前新账单价更新于 ${timeHtml(pricing.updatedAt)}` +
      (pricing.lastRefresh && !pricing.lastRefresh.ok ? `　⚠ 上次自动刷新失败：${esc(pricing.lastRefresh.error || "")}` : "") +
      (pricing.lastRefresh?.warnings?.length ? `　⚠ 部分来源沿用旧价：${esc(pricing.lastRefresh.warnings.join("；"))}` : "") +
      `　（每天 8:00 自动刷新）</span>`
    : "";
  const unpricedLine = unpriced.length
    ? `<br><span class="ct-warn">⚠ 用量发生时有 ${unpriced.length} 个模型无法计价，未计入：${esc(unpriced.join("、"))}　总数偏低。</span>`
    : "";
  const costTip = `<b>按用量发生时入账的估算成本</b>，非实付 —— 会员额度端点实付≈${sym}0。<br>` +
    `<span class="ct-f">每次 usage 都按当时单价与汇率冻结为 USD 账本；更新计价表只影响新用量，不追溯重算旧账。</span><br>` +
    `${modelRateLine ? `${modelRateLine}<br>` : ""}${unpricedLine}${fxLine ? `<br>${fxLine}` : ""}${freshLine ? `<br>${freshLine}` : ""}`;

  const tilesHtml = [
    { k: "成本", v: allUnpriced || estCost == null ? "—" : fmtMoney(estCost, sym) + (unpriced.length ? " +?" : ""), tip: costTip, tcls: "cost-tile" },
    { k: "输入 TOKEN", v: fmtNum(sInputTotal) }, { k: "输出 TOKEN", v: fmtNum(sOut) },
    { k: "总 TOKEN", v: fmtNum(sTotal) }, { k: "CACHE 率", v: fmtPct(cacheRatio) }, { k: "请求数", v: fmtNum(sRuns) },
    { k: "成功请求", v: fmtNum(sRuns - sErr), vcls: sRuns - sErr ? "okv" : "" },
  ].map((x) => `<div class="tile ${x.tcls || ""}"><div class="k">${esc(x.k)}${x.tip ? ` <span class="tile-info">ⓘ</span>` : ""}</div><div class="v small ${x.vcls || ""}">${esc(x.v)}</div>${x.tip ? `<div class="cost-tip">${x.tip}</div>` : ""}</div>`).join("");

  const active = snap.activeRuns || [], recent = snap.recentRuns || [];
  const activeRows = active.length
    ? active.map((r) => `<div class="active-run"><span class="run-dot"></span><span class="run-agent">${esc(r.agent)}</span><span class="badge tt-${esc(r.taskType || "")}">${esc(r.taskType || "—")}</span><span class="mono muted run-model" title="${esc(r.modelRef)}">${esc((r.surface || "") + (r.surface ? " · " : "") + r.modelRef)}</span><span class="mono run-elapsed">${(r.elapsedMs / 1000).toFixed(1)}s</span></div>`).join("")
    : `<div class="empty">当前没有正在跑的 agent。</div>`;
  const recentRows = recent.length
    ? recent.slice(0, 12).map((r) => `<div class="recent-run"><span class="run-status ${r.status === "ok" ? "ok" : "bad"}"></span><span class="run-agent">${esc(r.agent)}</span><span class="mono muted">${esc(r.modelRef)}</span><span class="mono run-dur">${(r.durationMs / 1000).toFixed(1)}s</span>${timeHtml(r.finishedAt, "time", "muted recent-time")}</div>`).join("")
    : `<div class="empty">暂无历史 run。</div>`;

  // 骨架签名：scope / range / 有无数据 / agent 集 变化时才重建 DOM（否则只更新数据 + 图表 setOption，平滑不闪）。
  const agentKeys = agRows.map((r) => r.agent).join(",");
  const barH = Math.max(120, agRows.length * 34 + 30);
  const sig = `${dashView.scopeKind}|${dashView.scopeKey}|${N}|${hasData ? 1 : 0}|${agentKeys}`;

  if (dashView.mainSig !== sig || !$("#dashTiles")) {
    dashView.mainSig = sig;
    disposeDashCharts(); // 旧实例 DOM 即将被替换，先释放，避免堆积
    const agentSection = agRows.length ? `
      <div class="dash-card"><h3>各 Agent 用量对比${cap}<span class="muted card-note"> · 该范围累计</span></h3><div id="dashAgentTable"></div></div>
      <div class="dash-card"><h3>各 Agent 总 token${cap}</h3><div class="ec-host" id="ecAgentTotal" style="height:${barH}px"></div></div>
      <div class="dash-card"><h3>每日 token 消耗对比${cap}<span class="muted card-note"> · 按 agent 堆叠</span></h3><div class="ec-host" id="ecAgentStack" style="height:300px"></div></div>`
      : `<div class="dash-card"><div class="empty">${dashView.scopeKind === "model" ? esc(scopeLabel) + " " : ""}该范围暂无 agent 用量。</div></div>`;
    box.innerHTML = `
      <div class="grid tiles metric-tiles dash-tiles" id="dashTiles"></div>
      <p class="dash-accounting-note" id="dashAccountingNote"></p>
      <div class="dash-card"><h3>总使用情况 · ${esc(scopeLabel)}<span class="muted card-note"> · ${esc(rangeLabel)} · 输入/输出/总/缓存 token（按天）</span></h3>
        ${hasData ? `<div class="ec-host" id="ecUsage" style="height:280px"></div>` : emptyChart()}</div>
      <div class="dash-card"><h3>请求数趋势<span class="muted card-note"> · ${esc(rangeLabel)} · 成功/失败（按天）</span></h3>
        ${hasData ? `<div class="ec-host" id="ecReq" style="height:240px"></div>` : emptyChart()}</div>
      ${agentSection}
      <div class="dash-2col">
        <div class="dash-card"><h3>活跃 AGENT</h3><div class="active-list" id="dashActive"></div></div>
        <div class="dash-card"><h3>最近 RUN</h3><div class="recent-list" id="dashRecent"></div></div>
      </div>`;
  }

  // —— 数据更新（每 tick 都跑）：文本区直接改 innerHTML，图表走 setOption（不销毁 DOM，动画平滑）——
  $("#dashTiles").innerHTML = tilesHtml;
  // Daily keys are immutable accounting-day labels, not UTC instants to convert.
  const accountingZone = dashView.ts?.accountingTimeZone || timeSettingsState.current?.legacyScheduleTimeZone || HarbourTime.defaultTimeZone;
  if ($("#dashAccountingNote")) $("#dashAccountingNote").textContent = `日账按 ${accountingZone} 分日；明细时刻按当前显示时区。`;
  if ($("#dashActive")) $("#dashActive").innerHTML = activeRows;
  if ($("#dashRecent")) $("#dashRecent").innerHTML = recentRows;
  if ($("#dashAgentTable")) $("#dashAgentTable").innerHTML = agentTableHtml(agRows);
  if (hasData && $("#ecUsage")) ecSet("ecUsage", ecLine(dates, [
    { name: "输入（含缓存）", color: "var(--accent)", values: rows.map((r) => r.input + (r.cached || 0) + (r.cacheCreation || 0)), area: true },
    { name: "输出", color: "var(--accent-2)", values: rows.map((r) => r.output) },
    { name: "总", color: "#a78bfa", values: rows.map((r) => r.input + (r.cached || 0) + (r.cacheCreation || 0) + r.output) },
    { name: "缓存命中", color: "var(--ok)", values: rows.map((r) => r.cached) },
  ]));
  if (hasData && $("#ecReq")) ecSet("ecReq", ecLine(dates, [
    { name: "成功", color: "var(--ok)", values: rows.map((r) => r.runs - r.errors), area: true },
    { name: "失败", color: "var(--danger)", values: rows.map((r) => r.errors) },
  ], { yFmt: (v) => String(Math.round(v)) }));
  if (agRows.length && $("#ecAgentTotal")) ecSet("ecAgentTotal", ecBarH(agRows.map((r) => ({ label: r.agent, value: r.total, color: r.color }))));
  if (agRows.length && $("#ecAgentStack")) ecSet("ecAgentStack", ecStack(dates, agRows.map((r) => ({ name: r.agent, color: r.color, values: dates.map((_, i) => (r.series[i] ? r.series[i].input + (r.series[i].cached || 0) + (r.series[i].cacheCreation || 0) + r.series[i].output : 0)) }))));
}

function shortTime(iso) {
  return HarbourTime.format(iso, "time");
}

// Small code-native symbols shared by the Memory / Agents catalogs.
function collectionIcon(name) {
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
    document: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
    index: '<path d="M4 5h6l2 3h8v12H4zM8 11v5h7M8 13h5"/>',
    folder: '<path d="M3 5h6l2 3h10v12H3z"/>',
    graph: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="m11 8-4.5 7.5M13 8l4.5 7.5M8 18h8"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.document}</svg>`;
}

// AGENTS 面板视图态：全量 + 选中 + 搜索 + taskType 分面（跨渲染保持）。
const agentsView = { all: [], sel: null, q: "", tt: "", fileDrafts: new Map(), configDrafts: new Map(), editorTabs: new Map() };
// Editor leave guards own dirty state; merely opening a file never creates a draft.

PANELS.agents = {
  id: "agents",
  async render(root) {
    const { agents } = await api("/api/agents");
    agentsView.all = agents;
    if (agentsView.sel !== "__new__" && !agents.some((a) => a.name === agentsView.sel)) agentsView.sel = null;
    const taskTypes = [...new Set(agents.map((a) => a.taskType))];
    root.innerHTML = `
      <div class="collection-studio agent-studio">
        <section class="collection-catalog" id="agentCatalog" aria-label="Agent 卡片目录">
          <header class="collection-heading">
            <div><span class="studio-kicker">YOUR COMPANIONS & SPECIALISTS</span><h1>Agents <span>${agents.length}</span></h1><p>熟悉的伙伴，各有所长。点开卡片查看配置与能力。</p></div>
            <div class="collection-tools">
              <label class="studio-search">${collectionIcon("search")}<input id="agentFilter" aria-label="搜索 Agent" placeholder="搜索 Agent…" value="${esc(agentsView.q)}"></label>
              <button class="studio-icon-button" id="agentRefresh" title="刷新 Agent 列表" aria-label="刷新 Agent 列表">${collectionIcon("refresh")}</button>
              <button class="studio-primary" id="newAgent">${collectionIcon("plus")}新建 Agent</button>
            </div>
          </header>
          <nav class="collection-tabs" id="agentChips" aria-label="Agent 任务类型">
            <button class="chip${agentsView.tt === "" ? " active" : ""}" data-tt="" aria-pressed="${agentsView.tt === ""}">全部 <small>${agents.length}</small></button>
            ${taskTypes.map((tt) => `<button class="chip${agentsView.tt === tt ? " active" : ""}" data-tt="${esc(tt)}" aria-pressed="${agentsView.tt === tt}">${esc(tt)} <small>${agents.filter((a) => a.taskType === tt).length}</small></button>`).join("")}
          </nav>
          <div class="collection-caption"><span id="agentsCount" role="status" aria-live="polite"></span><span>配置、文件与能力，集中在详情里</span></div>
          <div class="collection-grid" id="agentsList"></div>
        </section>
        <section class="collection-detail agents-layout" id="agentDetailView" hidden aria-label="Agent 详情">
          <nav class="collection-breadcrumb" aria-label="Agent 导航"><button id="agentBack">${collectionIcon("back")}所有 Agents</button><span aria-hidden="true">/</span><span id="agentCurrentName"></span></nav>
          <div class="agents-detail-shell">
            <section class="agents-detail" id="agentsDetail"></section>
            <div class="agent-detail-status" id="agentDetailStatus" role="status" aria-live="polite" hidden></div>
          </div>
        </section>
      </div>`;
    renderAgentsList();
    if (agentsView.sel) renderAgentDetail();
    $("#agentRefresh").addEventListener("click", route);
    $("#agentBack").addEventListener("click", async (event) => {
      const back = event.currentTarget;
      if (!await leaveEditors("agent") || !back.isConnected) return;
      const previous = agentsView.sel;
      agentsView.sel = null;
      root.querySelector("#agentDetailView").classList.remove("editor-focus");
      updateAgentSelection();
      void renderAgentDetail(); // Invalidate pending reads and editor identities before returning.
      (root.querySelector(`[data-agent="${CSS.escape(previous || "")}"]`) || root.querySelector("#newAgent"))?.focus({ preventScroll: true });
    });
    $("#newAgent").addEventListener("click", async () => { if (agentsView.sel === "__new__" || !await leaveEditors("agent")) return; agentsView.sel = "__new__"; updateAgentSelection(); renderAgentDetail(); });
    $("#agentFilter").addEventListener("input", (e) => { agentsView.q = e.target.value; renderAgentsList(); });
    root.querySelectorAll("#agentChips .chip").forEach((c) =>
      c.addEventListener("click", () => { agentsView.tt = c.dataset.tt; root.querySelectorAll("#agentChips .chip").forEach(item => { item.classList.toggle("active", item === c); item.setAttribute("aria-pressed", String(item === c)); }); renderAgentsList(); })
    );
  },
};

// 卡片目录只读取摘要；完整配置与文件在打开详情时加载。
function renderAgentsList() {
  const box = $("#agentsList");
  if (!box) return;
  const q = agentsView.q.trim().toLowerCase();
  const filtered = agentsView.all.filter((a) =>
    (!agentsView.tt || a.taskType === agentsView.tt) &&
    (!q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q))
  );
  $("#agentsCount").textContent = `${filtered.length} 位 Agent${agentsView.q || agentsView.tt ? " · 筛选结果" : ""}`;
  if (!filtered.length) { box.innerHTML = `<div class="collection-empty">没有找到匹配的 Agent<small>试试其他名称，或切换顶部分类。</small></div>`; return; }
  box.innerHTML = filtered.map((a) => `
    <button class="collection-card agent-card" data-agent="${esc(a.name)}" title="${esc(a.description || a.name)}">
      <span class="collection-card-top"><span class="collection-symbol">${collectionIcon("person")}</span><span class="collection-tag">${esc(a.taskType)}</span></span>
      <span class="collection-card-title">${esc(a.name)}</span>
      <span class="collection-card-description">${esc(a.description || "查看角色设定、运行配置与挂载能力。")}</span>
      <span class="collection-card-footer"><span>${a.folder ? "配置 · 文件 · 能力" : "配置 · 提示词"}</span>${collectionIcon("arrow")}</span>
    </button>`).join("");
  box.querySelectorAll("[data-agent]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.agent === agentsView.sel || !await leaveEditors("agent")) return;
      if (!b.isConnected) return;
      agentsView.sel = b.dataset.agent; updateAgentSelection(); renderAgentDetail();
    }));
  updateAgentSelection();
}

function updateAgentSelection() {
  const detail = !!agentsView.sel;
  if ($("#agentCatalog")) $("#agentCatalog").hidden = detail;
  if ($("#agentDetailView")) $("#agentDetailView").hidden = !detail;
  if ($("#agentCurrentName")) $("#agentCurrentName").textContent = agentsView.sel === "__new__" ? "新建 Agent" : agentsView.sel || "";
  document.querySelectorAll('#agentsList [data-agent]').forEach(row => {
    const selected = row.dataset.agent === agentsView.sel;
    row.classList.toggle('active', selected);
    row.setAttribute('aria-current', String(selected));
  });
}

// 右列：直接内联渲染编辑器（仿 V2-DEMO）——扁平型 = 表单直写 .md；文件夹型 = 改文件走 proposal。
async function renderAgentDetail() {
  const box = $("#agentsDetail");
  if (!box) return;
  updateAgentSelection();
  box._agentDetailAbort?.abort();
  const controller = new AbortController();
  box._agentDetailAbort = controller;
  const request = {};
  box._agentDetailRequest = request;
  box._folderEditor = null;
  box.onkeydown = null;
  const sel = agentsView.sel;
  const status = $("#agentDetailStatus");
  const isCurrent = () => box.isConnected && box._agentDetailRequest === request;
  const read = path => api(path, { signal: controller.signal });
  if (!sel) {
    box.innerHTML = "";
    box.inert = false; box.removeAttribute('aria-busy'); if (status) status.hidden = true;
    return;
  }
  // Keep the current workbench (and :has layout) painted until the next one is
  // ready. It is inert while stale, so no edit/save can target the wrong Agent.
  box.inert = true; box.setAttribute('aria-busy', 'true');
  if (!box.firstElementChild) box.innerHTML = `<div class="empty">正在读取 Agent…</div>`;
  if (status) { status.hidden = true; status.classList.remove('is-error'); status.textContent = `正在读取 ${sel === '__new__' ? '新 Agent 编辑器' : sel}…`; }
  const loadingTimer = setTimeout(() => { if (isCurrent() && status) status.hidden = false; }, 180);
  let loaded = false;
  try {
    const known = agentsView.all.find(item => item.name === sel);
    const [defaults, detail, prepared] = await Promise.all([
      read('/api/agent-defaults'),
      sel === '__new__' ? null : read(`/api/agents/${encodeURIComponent(sel)}`),
      known?.folder ? read(`/api/agent-files/${encodeURIComponent(sel)}`) : read('/api/tools'),
    ]);
    if (!isCurrent()) return;
    if (sel === "__new__") {
      await renderFlatAgentForm(box, null, { agentDefault: null, models: defaults.models || [] }, prepared);
      loaded = true;
      return;
    }
    const { agent } = detail;
    const runtimeDefaults = {
      agentDefault: (defaults.agents || []).find((a) => a.name === agent.name) || null,
      models: defaults.models || [],
    };
    if (agent.folder) {
      const payload = prepared.files ? prepared : await read(`/api/agent-files/${encodeURIComponent(sel)}`);
      if (!isCurrent()) return;
      // The settings preview is read-only and was already requested on mount.
      // Prepare it before committing the new DOM, avoiding placeholder → values
      // repaint. Files-tab visits remain lazy; no extra preview is requested.
      if ((agentsView.editorTabs.get(sel) || 'settings') === 'settings') {
        const source = agentsView.configDrafts.get(sel)?.source
          ?? agentsView.fileDrafts.get(sel)?.get('CLAUDE.md')
          ?? editorText(payload.files.find(file => file.file === 'CLAUDE.md')?.content || '');
        payload.initialPreview = await api(`/api/agent-config/${encodeURIComponent(sel)}/preview`, {
          method: 'POST', body: JSON.stringify({ source, patch: {} }), signal: controller.signal,
        }).then(result => ({ source, result }), error => ({ source, error }));
      }
      if (!isCurrent()) return;
      await renderFolderAgentForm(box, agent, runtimeDefaults, payload);
    } else {
      const payload = prepared.tools ? prepared : await read('/api/tools');
      if (!isCurrent()) return;
      await renderFlatAgentForm(box, agent, runtimeDefaults, payload);
    }
    loaded = true;
  } catch (e) {
    if (isCurrent() && !controller.signal.aborted && status) {
      status.classList.add('is-error'); status.hidden = false;
      status.innerHTML = `<span>⚠ 无法读取 ${esc(sel)}：${esc(e.message)}</span><button type="button" class="btn-mini">重新读取</button>`;
      status.querySelector('button').onclick = () => { if (isCurrent()) void renderAgentDetail(); };
    }
  } finally {
    clearTimeout(loadingTimer);
    if (isCurrent()) {
      box.removeAttribute('aria-busy');
      if (loaded) { box.inert = false; if (status) status.hidden = true; }
    }
  }
}

// 扁平型 agent 内联编辑器（直写 agents/<name>.md + 热重载）。
function agentContextBudgetHtml(agent, editable = false) {
  const automatic = agent.contextBudget === "auto" || agent.contextBudget == null;
  const budget = Number.isFinite(agent.contextBudget) ? agent.contextBudget : 8000;
  const description = automatic
    ? "自动跟随所选模型窗口，默认在窗口 80% 压缩；另外预留 5% 输出空间。"
    : `手动限额 ${budget.toLocaleString()} tok；默认按此限额与模型窗口较小值的 80% 压缩。`;
  if (!editable) return `<div class="agent-context-policy"><b>上下文 · ${automatic ? "自动" : "手动 " + fmtK(budget)}</b><span>${esc(description)} 可在“运行配置”表单中直接修改。</span></div>`;
  return `<div class="field agent-context-field" style="flex:1"><label for="f-budget-mode">AGENT 上下文限额</label><div class="row" style="gap:8px"><select class="inp" id="f-budget-mode" aria-describedby="f-budget-help"><option value="auto"${automatic ? " selected" : ""}>自动 · 跟随模型</option><option value="manual"${automatic ? "" : " selected"}>手动 · 指定 token</option></select><input class="inp" id="f-budget" type="number" min="1" step="1" value="${automatic ? "" : budget}"${automatic ? " disabled" : ""} placeholder="例如 8000" aria-label="手动上下文限额（token）" aria-describedby="f-budget-help"></div><small id="f-budget-help">自动：随模型窗口；手动：保留指定限额。默认在两者较小值的 80% 压缩，并预留模型窗口的 5% 给输出。这里不是本轮费用/token 总预算。</small></div>`;
}

function readAgentContextBudget(mode, value) {
  if (mode === "auto") return "auto";
  const budget = Number(String(value || "").trim());
  if (mode !== "manual" || !Number.isSafeInteger(budget) || budget <= 0) throw new Error("手动上下文限额必须是正整数；不设固定值时请选择自动。");
  return budget;
}

async function renderFlatAgentForm(box, agent, runtimeDefaults = { agentDefault: null, models: [] }, prepared = {}) {
  const request = box._agentDetailRequest;
  const { tools } = prepared.tools ? prepared : await api("/api/tools");
  const isCurrent = () => box.isConnected && box._agentDetailRequest === request;
  if (!isCurrent()) return;
  const isEdit = !!agent;
  const a = agent || { name: "", description: "", model: "", permissionMode: "dontAsk", taskType: "research", tools: [], contextBudget: "auto", maxSteps: 8, systemPrompt: "你是……" };
  const taskTypes = ["heartbeat", "classify", "research", "writing", "critical"];
  const models = runtimeDefaults.models || [];
  const manifestModelKnown = !a.model || models.some((m) => m.modelRef === a.model);
  box.innerHTML = `
    <div class="editor-head">
      <div><h3>${isEdit ? esc(a.name) : "新建 agent"}</h3>
        <div class="editor-sub">${isEdit ? `agents/${esc(a.name)}.md · 保存即热重载` : "kebab-case 文件名 → agents/&lt;name&gt;.md"}</div></div>
      <div class="row" style="gap:8px">
        ${isEdit ? `<button class="btn ghost" data-act="run" data-name="${esc(a.name)}">▶ 对话</button>` : ""}
        ${isEdit ? `<button class="btn danger ghost" data-act="del" data-name="${esc(a.name)}">删除</button>` : ""}
      </div>
    </div>
    ${isEdit ? agentRuntimeDefaultsHtml(runtimeDefaults.agentDefault, models) : ""}
    <label class="field"><span>NAME（kebab-case，文件名）</span>
      <input class="inp" id="f-name" value="${esc(a.name)}" ${isEdit ? "readonly" : ""} placeholder="my-agent"></label>
    <label class="field"><span>DESCRIPTION</span><input class="inp" id="f-desc" value="${esc(a.description || "")}"></label>
    <div class="row" style="gap:14px">
      <label class="field" style="flex:1"><span>CLAUDE.md MODEL（可空 → 按 taskType）</span>
        <select class="inp" id="f-model"><option value="">按 taskType 自动选择</option>${manifestModelKnown ? "" : `<option value="${esc(a.model)}">当前 · ${esc(a.model)}</option>`}${groupedModelOptionsHtml(models)}</select></label>
      <label class="field" style="width:180px"><span>TASK TYPE</span>
        <select class="inp" id="f-tt">${taskTypes.map((t) => `<option ${t === a.taskType ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="field" style="width:190px"><span>CLAUDE.md MODE</span>
        <select class="inp" id="f-mode">${permissionModeManifestOptionsHtml(a.manifestPermissionMode || a.permissionMode || "dontAsk")}</select></label>
    </div>
    <div class="row" style="gap:14px">
      ${agentContextBudgetHtml(a, true)}
      <label class="field" style="width:140px"><span>MAX STEPS</span><input class="inp" id="f-steps" type="number" value="${a.maxSteps || 8}"></label>
    </div>
    <label class="field"><span>TOOLS</span>
      <div class="checks" id="f-tools">${tools.map((t) => `<label class="check"><input type="checkbox" value="${esc(t.name)}" ${a.tools.includes(t.name) ? "checked" : ""}>${esc(t.name)}</label>`).join("")}</div></label>
    <label class="field"><span>SYSTEM PROMPT</span><textarea class="inp" id="f-prompt" style="min-height:160px">${esc(a.systemPrompt)}</textarea></label>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="saveAgent">${isEdit ? "SAVE" : "CREATE"}</button></div>`;
  $("#f-model").value = a.model || "";
  $("#f-budget-mode").addEventListener("change", (event) => { $("#f-budget").disabled = event.target.value === "auto"; });
  if (isEdit) wireAgentRuntimeDefaults(box, runtimeDefaults.agentDefault, async () => { if (await leaveEditors("refresh")) renderAgentDetail(); });
  box.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => agentAction(btn.dataset.act, btn.dataset.name)));
  const fields = [...box.querySelectorAll('[id^="f-"]')].filter(node => /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
  const checks = [...box.querySelectorAll("#f-tools input")];
  const snapshot = () => JSON.stringify([fields.map(node => editorText(node.value)), checks.map(node => node.checked)]);
  let baseline = snapshot(), saving = false;
  async function saveFlat(navigate = false) {
    if (saving || !isCurrent()) return false;
    let contextBudget;
    try { contextBudget = readAgentContextBudget($("#f-budget-mode").value, $("#f-budget").value); }
    catch (error) { toast(error.message, true); return false; }
    const body = {
      name: $("#f-name").value.trim(),
      description: $("#f-desc").value.trim(),
      model: $("#f-model").value.trim(),
      permissionMode: $("#f-mode").value,
      taskType: $("#f-tt").value,
      contextBudget,
      maxSteps: Number($("#f-steps").value),
      tools: [...box.querySelectorAll("#f-tools input:checked")].map((c) => c.value),
      systemPrompt: $("#f-prompt").value,
    };
    if (!body.name) { toast("请填 name", true); return false; }
    const submitted = snapshot();
    saving = true; box.querySelector("#saveAgent").disabled = true;
    try {
      await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
      toast(`已保存 ${body.name}`);
      baseline = submitted;
      if (!isCurrent() || snapshot() !== baseline) return false;
      if (navigate) { agentsView.sel = body.name; saving = false; await route(); }
      return true;
    } catch (e) { toast(e.message, true); return false; }
    finally { saving = false; if (isCurrent() && box.querySelector("#saveAgent")) box.querySelector("#saveAgent").disabled = false; }
  }
  $("#saveAgent").addEventListener("click", () => saveFlat(true));
  editorLeave.register("agent-flat", {
    isActive: isCurrent, isDirty: () => snapshot() !== baseline, isBusy: () => saving,
    label: () => isEdit ? `agents/${a.name}.md` : "新建 Agent · 尚未保存",
    version: snapshot, save: () => saveFlat(false),
    discard: () => {
      if (saving) return false;
      const [values, checked] = JSON.parse(baseline);
      fields.forEach((node, index) => { node.value = values[index]; });
      checks.forEach((node, index) => { node.checked = checked[index]; });
      box.querySelector("#f-budget").disabled = box.querySelector("#f-budget-mode").value === "auto";
      return true;
    },
  });
}

/* ── AGENTS 编辑器的左侧文件树 ────────────────────────────────────────
   Agent 页只编辑 Agent 自身文件与挂载索引；Skill/Workflow/MCP 真身统一去独立工作区编辑。 */
const FA_GROUP_LABEL = { persona: "人格", schedule: "调度", index: "能力索引" };

function fileTreeHtml(files, current) {
  const groups = new Map();          // 保持后端返回顺序
  for (const f of files) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  const fileItem = (f) =>
    `<button type="button" class="fa-file${f.file === current ? " active" : ""}" data-sel="${esc(f.file)}" title="${esc(f.file)}">${esc(f.file)}</button>`;
  let html = "";
  for (const [g, list] of groups) {
    html += `<div class="fa-group"><div class="fa-group-head">${esc(FA_GROUP_LABEL[g] || g)} · ${list.length}</div>${list.map(fileItem).join("")}</div>`;
  }
  return html;
}

// 文件夹型 agent 内联编辑器（改文件 = 生成 governance proposal，审批 apply 后落盘热重载）。
async function renderFolderAgentForm(box, agent, runtimeDefaults = { agentDefault: null, models: [] }, prepared = {}) {
  const editor = {};
  box._folderEditor = editor;
  const isCurrent = () => box.isConnected && box._folderEditor === editor;
  const { files } = prepared.files ? prepared : await api(`/api/agent-files/${encodeURIComponent(agent.name)}`);
  if (!isCurrent()) return;
  const fileMap = Object.fromEntries((files || []).map((f) => [f.file, editorText(f.content)]));
  const retained = agentsView.fileDrafts.get(agent.name) || new Map();
  agentsView.fileDrafts.set(agent.name, retained);
  const drafts = Object.fromEntries((files || []).map((f) => [f.file, editorText(retained.get(f.file) ?? f.content)]));
  const fileNames = (files || []).map((f) => f.file);
  const revisions = Object.fromEntries(fileNames.map((f) => [f, 0]));
  const aiRequests = new Map();
  const aiInstructions = new Map();
  let submitting = false;
  let submittedCount = 0;
  let sel = fileNames[0] || "";
  const editorFocused = box.closest(".agents-layout")?.classList.contains("editor-focus");
  box.innerHTML = `
    <div class="editor-head fa-editor-head">
      <div class="fa-agent-identity"><span class="fa-agent-mark" aria-hidden="true">${collectionIcon("person")}</span><div><h3>${esc(agent.name)}</h3>
        <div class="editor-sub">${esc(agent.description || agent.taskType)}</div></div></div>
      <div class="fa-editor-actions">
        <button class="btn ghost" id="faFocus" type="button" aria-pressed="${!!editorFocused}">${editorFocused ? "↙ 退出专注" : "⛶ 专注编辑"}</button>
        <button class="btn primary" data-act="run" data-name="${esc(agent.name)}">${chatComposerIcon("agent")} 开始对话</button>
      </div>
    </div>
    <nav class="fa-workspace-tabs" aria-label="Agent 工作区"><button type="button" class="btn" data-fa-tab="settings" aria-controls="faSettings">运行设置<span id="faConfigDirty" hidden> ●</span></button><button type="button" class="btn" data-fa-tab="files" aria-controls="faFiles">人设与能力</button></nav>
    <div class="fa-settings" id="faSettings">
      ${agentRuntimeDefaultsHtml(runtimeDefaults.agentDefault, runtimeDefaults.models || [])}
      <div id="faConfigEditor" class="ac-editor"></div>
    </div>
    <div class="fa-layout" id="faFiles" hidden>
      <aside class="fa-tree" id="faTree" aria-label="Agent 文件">${fileTreeHtml(files, sel)}<button class="btn-mini" id="faReindex" type="button" title="直接重建能力 index.md 的生成正文，不修改挂载名单">⟳ 重建索引</button></aside>
      <div class="fa-main">
        <div class="fa-filebar">
          <div class="fa-current-file"><span class="field-label" id="faSelLabel">CONTENT</span><span class="fa-current-path" id="faSelPath"></span></div>
          <span class="fa-draft-status" id="faDraftStatus" role="status" aria-live="polite"></span>
        </div>
        <div class="doc-toolbar fa-docs-head">
          ${docToggleHtml("faDocToggle", { render: "预览", raw: "手动编辑" })}
          <button class="btn ghost fa-ai-toggle" id="faAiToggle" type="button" aria-expanded="false" aria-controls="faAiPanel">✦ AI 辅助改写</button>
          <div class="fa-save-actions">
            <button class="btn ghost" id="faCancel" type="button" title="取消当前文件的未提交修改，保留其它文件的草稿">取消修改</button>
            <button class="btn primary" id="faSubmit" type="button" title="将所有已修改文件保存为待审批提案">保存修改</button>
          </div>
        </div>
        <div class="fa-ai-panel" id="faAiPanel" hidden>
          <label for="faAiInput">你想怎样修改 <b id="faAiFile"></b>？</label>
          <div class="fa-ai"><input class="inp fa-ai-input" id="faAiInput" placeholder="例如：让说明更简洁，保留现有规则">
            <button class="btn-mini fa-ai-go" id="faAiGo" type="button">生成改写草稿</button></div>
          <small>AI 只改写当前文件的草稿；检查后由你保存，不会自动应用。</small>
        </div>
        <div class="fa-edit-help" id="faEditHelp"></div>
        <div class="fa-docs" id="faDocs"></div>
        <div class="fa-foot">
          <label class="fa-reason-label" for="faReason">修改说明</label>
          <input class="inp fa-reason-inline" id="faReason" placeholder="可选，例如：补充工作规则">
          <span class="fa-save-policy">保存为提案，批准应用后生效</span>
        </div>
        <div class="fa-save-result" id="faSaveResult" role="status" aria-live="polite" hidden></div>
      </div>
    </div>`;
  let configEditor;
  function showWorkspace(tab) {
    captureDraft();
    agentsView.editorTabs.set(agent.name, tab);
    box.querySelector("#faSettings").hidden = tab !== "settings";
    box.querySelector("#faFiles").hidden = tab !== "files";
    box.querySelectorAll("[data-fa-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.faTab === tab);
      button.setAttribute("aria-pressed", String(button.dataset.faTab === tab));
    });
    if (tab === "settings" && !configEditor) configEditor = HarbourAgentConfig.mount(box.querySelector("#faConfigEditor"), {
      name: agent.name, models: runtimeDefaults.models || [], drafts: agentsView.configDrafts, api, isCurrent,
      initialPreview: prepared.initialPreview,
      effectiveModelRef: (draftModel) => runtimeDefaults.agentDefault?.overrideModelRef || draftModel || runtimeDefaults.agentDefault?.effectiveModelRef,
      readSource: () => { captureDraft(); return drafts["CLAUDE.md"] || ""; },
      confirm: (message) => harbourConfirm(message, { title: "取消配置修改？", confirmLabel: "重新读取", cancelLabel: "保留草稿" }),
      onDirty: (dirty) => { if (isCurrent()) box.querySelector("#faConfigDirty").hidden = !dirty; },
      saveContent: async (content, original) => {
        captureDraft();
        if (submitting || aiRequests.size) throw new Error("文件保存或 AI 改写正在进行，请完成后再保存配置。");
        if (!isCurrent() || drafts["CLAUDE.md"] !== original) throw new Error("文件已改变，配置未覆盖，请重新读取。");
        submitting = true; updateDraftStatus();
        try {
          await api(`/api/agent-files/${encodeURIComponent(agent.name)}`, { method: "POST", body: JSON.stringify({ file: "CLAUDE.md", content, reason: `configure ${agent.name}` }) });
          if (!isCurrent()) return; // The user may have reopened this Agent with a newer file draft.
          fileMap["CLAUDE.md"] = content; submittedCount++;
          if (drafts["CLAUDE.md"] === original) {
            drafts["CLAUDE.md"] = content; revisions["CLAUDE.md"]++;
            retainDraft("CLAUDE.md");
            if (isCurrent() && sel === "CLAUDE.md") renderDocs();
          }
        } finally { submitting = false; updateDraftStatus(); }
      },
    });
  }
  box.querySelectorAll("[data-fa-tab]").forEach((button) => button.addEventListener("click", async () => {
    if (agentsView.editorTabs.get(agent.name) === button.dataset.faTab || !await leaveEditors("workspace")) return;
    if (isCurrent()) showWorkspace(button.dataset.faTab);
  }));
  let defaultsRefresh = 0;
  wireAgentRuntimeDefaults(box, runtimeDefaults.agentDefault, async () => {
    // Refresh the two runtime controls, never replace the file workbench/drafts.
    const request = ++defaultsRefresh;
    const { agents = [] } = await api("/api/agent-defaults");
    if (!isCurrent() || request !== defaultsRefresh) return;
    const updated = agents.find((entry) => entry.name === agent.name);
    if (!updated) return;
    runtimeDefaults.agentDefault = updated;
    box.querySelector("[data-agent-default-model]").value = updated.overrideModelRef || "";
    box.querySelector("[data-agent-default-mode]").value = updated.overridePermissionMode || "";
    box.querySelector("[data-agent-model-source]").textContent = updated.overrideModelRef ? "已单独指定此 Agent 的模型" : "跟随基础配置与自动路由";
    box.querySelector("[data-agent-mode-source]").textContent = `${updated.overridePermissionMode ? "已单独指定" : "跟随基础配置"}；仍遵守工具与目录权限`;
    configEditor?.refreshModel();
  });
  box.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => agentAction(btn.dataset.act, btn.dataset.name)));

  /** 当前只打开一个 Agent 文件；全局 Skill/Workflow/MCP 真身由独立工作区负责。 */
  function renderDocs() {
    const list = [sel].filter(Boolean);
    $("#faSelLabel").textContent = sel ? sel.split("/").pop() : "CONTENT";
    $("#faSelPath").textContent = sel ? `agents/${agent.name}/${sel}` : "";
    $("#faAiFile").textContent = sel;
    $("#faAiInput").value = aiInstructions.get(sel) || "";
    $("#faDocs").innerHTML = list
      .map(
        (f) => `<section class="fa-doc" data-file="${esc(f)}">
        <textarea class="inp gov-content fa-ta" aria-label="手动编辑 ${esc(f)}" aria-describedby="faEditHelp" spellcheck="false">${esc(drafts[f] ?? "")}</textarea>
        <div class="md-body doc-render fa-rend" hidden></div>
        <details class="fa-hist" data-path="agents/${esc(agent.name)}/${esc(f)}">
          <summary>⎇ 版本历史 · diff / 回滚</summary>
          <div class="fa-hist-box"><span class="muted">展开加载该文件的提交历史。</span></div>
        </details>
      </section>`
      )
      .join("");
    applyAgentDocView(docViewMode());
    updateDraftStatus();
  }

  function captureDraft() {
    if (!isCurrent()) return;
    const doc = box.querySelector(".fa-doc");
    if (doc) {
      const file = doc.dataset.file, content = editorText(doc.querySelector(".fa-ta").value);
      if (drafts[file] !== content) revisions[file]++;
      drafts[file] = content;
      retainDraft(file);
    }
  }

  function retainDraft(file) {
    if (drafts[file] !== fileMap[file]) { agentsView.fileDrafts.set(agent.name, retained); retained.set(file, drafts[file]); }
    else retained.delete(file);
  }

  function updateDraftStatus() {
    if (!isCurrent()) return;
    const dirtyFiles = fileNames.filter((f) => drafts[f] !== fileMap[f]);
    const status = box.querySelector("#faDraftStatus");
    if (!status) return;
    status.textContent = dirtyFiles.length ? `${dirtyFiles.length} 个文件待提交` : submittedCount ? "提案待审批" : "无未提交修改";
    status.classList.toggle("dirty", !!dirtyFiles.length);
    const save = box.querySelector("#faSubmit");
    save.disabled = submitting || aiRequests.size > 0 || !dirtyFiles.length;
    save.textContent = submitting ? "提交中…" : "保存修改";
    box.querySelector("#faCancel").disabled = submitting || (!dirtyFiles.includes(sel) && !aiRequests.has(sel) && docViewMode() !== "raw");
    box.querySelector("#faAiGo").disabled = submitting || aiRequests.has(sel) || !sel;
    box.querySelector("#faAiGo").textContent = aiRequests.has(sel) ? "改写中…" : "生成改写草稿";
    box.querySelectorAll(".fa-file").forEach((btn) => {
      const dirty = dirtyFiles.includes(btn.dataset.sel);
      btn.classList.toggle("dirty", dirty);
      btn.title = btn.dataset.sel + (dirty ? " · 未提交修改" : "");
    });
  }

  /** 预览始终从 textarea 的【实时值】渲染——切到预览再切回来，未提交的编辑不会丢。 */
  function applyAgentDocView(mode) {
    if (!isCurrent()) return;
    const isRender = mode === "render";
    $("#faEditHelp").textContent = isRender
      ? "预览当前草稿 · 点击“手动编辑”修改原文；保存、取消和 AI 改写均在上方。"
      : "直接编辑 Markdown · Ctrl / ⌘ + S 保存提案；切换文件、Agent 或页面前会确认未保存修改。";
    $("#faDocs").querySelectorAll(".fa-doc").forEach((doc) => {
      const ta = doc.querySelector(".fa-ta"), rend = doc.querySelector(".fa-rend");
      ta.hidden = isRender;
      rend.hidden = !isRender;
      if (isRender) rend.innerHTML = ta.value.trim() ? renderCapabilityMarkdown(ta.value) : `<span class="muted">（空文件）</span>`;
    });
    updateDraftStatus();
  }
  wireDocToggle("faDocToggle", applyAgentDocView);
  renderDocs();
  showWorkspace(agentsView.editorTabs.get(agent.name) || "settings");
  $("#faDocs").addEventListener("input", (e) => {
    if (!e.target.matches(".fa-ta")) return;
    captureDraft();
    updateDraftStatus();
  });
  $("#faDocToggle").addEventListener("click", (e) => {
    if (e.target.closest('[data-doc-view="raw"]')) box.querySelector(".fa-ta")?.focus();
  });

  $("#faTree").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-sel]");
    if (!btn || btn.dataset.sel === sel || !await leaveEditors("file")) return;
    if (!isCurrent()) return;
    captureDraft();
    aiInstructions.set(sel, $("#faAiInput").value);
    sel = btn.dataset.sel;
    $("#faTree").querySelectorAll(".fa-file").forEach((c) => c.classList.toggle("active", c === btn));
    renderDocs();
  });

  $("#faFocus").addEventListener("click", (event) => {
    const focused = box.closest(".agents-layout").classList.toggle("editor-focus");
    event.currentTarget.setAttribute("aria-pressed", String(focused));
    event.currentTarget.textContent = focused ? "↙ 退出专注" : "⛶ 专注编辑";
  });
  $("#faAiToggle").addEventListener("click", (event) => {
    const panel = box.querySelector("#faAiPanel");
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) box.querySelector("#faAiInput").focus();
  });
  $("#faCancel").addEventListener("click", async () => {
    if (submitting) return;
    captureDraft();
    const file = sel;
    if ((drafts[file] !== fileMap[file] || aiRequests.has(file)) && !await harbourConfirm(
      `丢弃 ${file} 的未提交修改，恢复本次载入或已提交的版本。其它文件草稿不变；已提交的提案不会撤销。`,
      { title: "取消当前文件的修改？", confirmLabel: "丢弃修改", cancelLabel: "保留草稿", tone: "warning" }
    )) return;
    if (!isCurrent() || submitting) return;
    revisions[file]++;
    aiRequests.delete(file); // Invalidates an in-flight rewrite even if the text is unchanged.
    drafts[file] = fileMap[file];
    retainDraft(file);
    if (sel === file) {
      renderDocs();
      box.querySelector('[data-doc-view="render"]').click();
    }
    updateDraftStatus();
  });
  box.onkeydown = (event) => {
    if (event.key === "Escape") {
      box.querySelector('[data-fa-tab].active')?.focus();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    box.querySelector(agentsView.editorTabs.get(agent.name) === "settings" ? "[data-ac-save]" : "#faSubmit")?.click();
  };

  // 版本历史：展开某文件的折叠区时按需加载 git 历史（懒加载，避免每个文件都先拉一遍）。
  // 回滚后重渲整个编辑器，让 textarea 显示回滚后的内容。
  $("#faDocs").addEventListener("toggle", (e) => {
    const det = e.target.closest?.(".fa-hist");
    if (!det || !det.open || det.dataset.loaded) return;
    det.dataset.loaded = "1";
    loadFileGit(det.dataset.path, det.querySelector(".fa-hist-box"), () => renderFolderAgentForm(box, agent, runtimeDefaults));
  }, true);

  // AI 修改：把「当前编辑器里的内容 + 一句要求」发给模型，改写结果塞回同一个 textarea。
  // 不落盘、不自动提交——你过目后照常点提交走 governance。
  $("#faAiGo").addEventListener("click", async () => {
    if (submitting || aiRequests.has(sel) || !sel) return;
    captureDraft();
    const input = box.querySelector("#faAiInput");
    const instruction = input.value.trim();
    if (!instruction) { toast("先写一句你想怎么改", true); return; }
    const file = sel, original = drafts[file], revision = revisions[file], request = {};
    aiRequests.set(file, request);
    updateDraftStatus();
    try {
      const r = await api("/api/ai-edit", {
        method: "POST",
        body: JSON.stringify({ file, content: original, instruction }),
      });
      if (!isCurrent()) return;
      captureDraft();
      if (aiRequests.get(file) !== request) return;
      if (revisions[file] !== revision || drafts[file] !== original) {
        toast("改写期间已有手动修改，已保留你的草稿，未覆盖为 AI 结果", true);
        return;
      }
      if (typeof r.content !== "string") throw new Error("AI 未返回有效草稿，原文已保留");
      drafts[file] = editorText(r.content);
      revisions[file]++;
      retainDraft(file);
      if ((aiInstructions.get(file) || "").trim() === instruction) aiInstructions.delete(file);
      if (sel === file) {
        box.querySelector(".fa-ta").value = drafts[file];
        if (input.value.trim() === instruction) input.value = "";
      }
      applyAgentDocView(docViewMode());
      updateDraftStatus();
      toast("AI 已改写，请过目后再提交");
    } catch (err) { if (isCurrent()) toast(err.message, true); }
    finally {
      if (aiRequests.get(file) === request) aiRequests.delete(file);
      updateDraftStatus();
    }
  });

  // 重建索引：能力 index.md 的正文是机器回填的，直接写盘不走审批。
  const reBtn = $("#faReindex");
  if (reBtn) reBtn.addEventListener("click", async () => {
    captureDraft();
    if (submitting || aiRequests.size || fileNames.some((f) => drafts[f] !== fileMap[f])) {
      toast("请先提交草稿，再重建索引，避免覆盖未提交的修改", true); return;
    }
    reBtn.disabled = true;
    const old = reBtn.textContent;
    reBtn.textContent = "重建中…";
    try {
      const r = await api(`/api/agent-files/${encodeURIComponent(agent.name)}/reindex`, { method: "POST" });
      if (!isCurrent()) return;
      toast(r.changed?.length ? `已重建：${r.changed.join(" / ")}` : "索引已是最新，无需改动");
      await renderFolderAgentForm(box, agent, runtimeDefaults);   // 用新内容重渲编辑器
    } catch (e) { toast(e.message, true); }
    finally { reBtn.disabled = false; reBtn.textContent = old; }
  });

  // 提交本页各文件的草稿；切换文件不丢草稿，也不调用 AI。
  async function saveFiles() {
    if (submitting || aiRequests.size) return false;
    captureDraft();
    const dirty = fileNames.filter((f) => drafts[f] !== fileMap[f]).map((file) => ({ file, content: drafts[file] }));
    if (!dirty.length) return true;
    const reason = $("#faReason").value.trim() || `edit ${agent.name}`;
    const result = box.querySelector("#faSaveResult");
    result.hidden = false;
    result.classList.remove("error");
    result.textContent = "正在保存修改提案…";
    submitting = true;
    updateDraftStatus();
    try {
      for (const d of dirty) {
        await api(`/api/agent-files/${encodeURIComponent(agent.name)}`, {
          method: "POST",
          body: JSON.stringify({ file: d.file, content: d.content, reason }),
        });
        // 已确认建提案的内容不重复提交；后续失败仍保留其余草稿。
        fileMap[d.file] = d.content;
        submittedCount++;
        if (retained.get(d.file) === d.content) retained.delete(d.file);
      }
      captureDraft();
      if (isCurrent()) result.innerHTML = `<span>已提交 ${dirty.length} 个文件，批准并应用后生效。</span><a class="btn-mini" href="#governance">前往审批 →</a>`;
    } catch (e) {
      if (isCurrent()) { result.classList.add("error"); result.textContent = `提交未全部完成：${e.message}。未提交草稿已保留，可重试。`; }
    }
    finally { submitting = false; if (box.isConnected) updateDraftStatus(); }
    return fileNames.every(file => drafts[file] === fileMap[file]);
  }
  $("#faSubmit").addEventListener("click", saveFiles);
  editorLeave.register("agent-files", {
    isActive: isCurrent,
    isDirty: () => { captureDraft(); return fileNames.some(file => drafts[file] !== fileMap[file]) || aiRequests.size > 0; },
    isBusy: () => submitting,
    label: () => fileNames.filter(file => drafts[file] !== fileMap[file] || aiRequests.has(file)).map(file => `agents/${agent.name}/${file}`).join("\n"),
    version: () => JSON.stringify([drafts, [...aiRequests.keys()]]),
    save: saveFiles,
    discard: () => {
      if (submitting) return false;
      for (const file of fileNames) { revisions[file]++; drafts[file] = fileMap[file]; }
      aiRequests.clear(); retained.clear(); agentsView.fileDrafts.delete(agent.name);
      renderDocs(); updateDraftStatus(); return true;
    },
  });
  editorLeave.register("agent-config", {
    isActive: isCurrent, isDirty: () => !!configEditor?.isDirty(), isBusy: () => !!configEditor?.isBusy(),
    label: `agents/${agent.name}/CLAUDE.md · 运行配置`,
    version: () => JSON.stringify(agentsView.configDrafts.get(agent.name)),
    save: () => configEditor?.save() ?? true, discard: () => configEditor?.discard() ?? true,
  });
}

async function agentAction(act, name) {
  if (!await leaveEditors("agent-action")) return;
  // ▶ 对话 = 跳 MAIN CHAT 并预选该 agent；删除 = 删 .md 后重渲 AGENTS。
  if (act === "run") { state.chat.agent = name; state.chat.skill = ""; location.hash = "chat"; return; }
  if (act === "del") {
    if (!await harbourConfirm(`Agent「${name}」的定义文件将被删除。`, {
      title: "删除 Agent？", confirmLabel: "删除", tone: "danger",
    })) return;
    try { await api(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" }); toast(`已删除 ${name}`); agentsView.sel = null; PANELS.agents.render($("#content")); }
    catch (e) { toast(e.message, true); }
  }
}

/* ── SKILL / WORKFLOW / MCP：全局能力真身浏览 + 单文件编辑 ───────── */
const capView = { packages: [], sel: null, file: null, raw: "", q: "", kind: "", mounted: "", editing: false, loading: false, saving: false, workflowTab: "graph" };
const CAP_KIND_META = {
  skill: { mark: "S", label: "Skill" },
  workflow: { mark: "W", label: "Workflow" },
  mcp: { mark: "M", label: "MCP" },
};

PANELS.capabilities = {
  id: "capabilities",
  async render(root) {
    const data = await api("/api/capabilities");
    capView.packages = data.packages || [];
    if (!capView.packages.some((item) => capabilityKey(item) === capView.sel)) {
      capView.sel = null;
      capView.file = null;
    }
    root.innerHTML = `
      <section class="studio-shell cap-studio">
        <aside class="studio-sidebar">
          <div class="studio-sidebar-heading"><span class="studio-kicker">MAKE IT YOURS</span><h2>能力中心</h2></div>
          <nav class="studio-nav" id="capKindTabs" aria-label="能力分类">
            ${[["", "全部能力", "all"], ["skill", "技能", "document"], ["workflow", "工作流", "comic"], ["mcp", "插件 · MCP", "file"]].map(([kind, label, glyph]) => `<button type="button" data-cap-kind="${kind}" aria-current="${capView.kind === kind}">${window.HarbourSpaces.icon(glyph)}<span>${label}</span><small>${kind ? data.counts?.[kind] || 0 : capView.packages.length}</small></button>`).join("")}
          </nav>
          <p class="studio-sidebar-note">为 Harbour 添加专长。<br>能力定义统一维护，<br>Agent 按需挂载。</p>
        </aside>
        <div class="studio-main">
          <header class="studio-page-heading" id="capPageHeading"><div><span class="studio-kicker">A LITTLE MORE CAPABLE</span><h1 id="capHeading">全部能力</h1><p id="capSubtitle">让熟悉的她们，拥有更多擅长的事。</p></div>
            <div class="studio-toolbar"><label class="studio-search">${window.HarbourSpaces.icon("search")}<input type="search" id="capFilter" aria-label="搜索能力" placeholder="搜索能力…" value="${esc(capView.q)}"></label><button class="studio-icon-button" type="button" id="capRefresh" aria-label="刷新能力" title="刷新能力">${window.HarbourSpaces.icon("refresh")}</button></div>
          </header>
          <div id="capCatalog"><div class="space-section-label"><span id="capResultCount"></span><select class="cap-catalog-filter" id="capMountFilter" aria-label="按挂载状态筛选"><option value="">所有能力</option><option value="yes">已挂载</option><option value="no">未挂载</option></select></div><div class="cap-package-list" id="capPackageList"></div></div>
          <div class="cap-detail-view" id="capDetailView" hidden><nav class="cap-breadcrumb" aria-label="能力详情导航"><button type="button" class="cap-back" id="capBack">${window.HarbourSpaces.icon("back")}返回能力列表</button><span id="capDetailKind"></span><button type="button" class="studio-icon-button" id="capDetailRefresh" aria-label="刷新当前能力" title="刷新当前能力">${window.HarbourSpaces.icon("refresh")}</button></nav><div class="cap-layout"><section class="cap-detail" id="capDetail"></section></div></div>
        </div>
      </section>`;
    $("#capRefresh").addEventListener("click", route);
    $("#capDetailRefresh").addEventListener("click", route);
    $("#capFilter").addEventListener("input", async (e) => { if (capView.sel && !await leaveEditors("capability")) { e.target.value = capView.q; return; } capView.q = e.target.value; capView.sel = null; capView.file = null; $("#capDetail").innerHTML = ""; renderCapabilityList(); });
    $("#capMountFilter").value = capView.mounted;
    $("#capMountFilter").onchange = e => { capView.mounted = e.target.value; renderCapabilityList(); };
    $("#capBack").onclick = async () => { if (!await leaveEditors("capability")) return; capView.sel = null; capView.file = null; $("#capDetail").innerHTML = ""; renderCapabilityList(); $("#capFilter").focus(); };
    $("#capKindTabs").querySelectorAll("[data-cap-kind]").forEach((button) => button.addEventListener("click", async () => {
      if (!await leaveEditors("capability")) return;
      capView.kind = button.dataset.capKind;
      capView.sel = null; capView.file = null; $("#capDetail").innerHTML = "";
      renderCapabilityList();
    }));
    renderCapabilityList();
    if (capView.sel) await renderCapabilityDetail();
  },
};

const capabilityKey = (item) => `${item.kind}:${item.name}`;

function renderCapabilityList() {
  const box = $("#capPackageList");
  if (!box) return;
  const q = capView.q.trim().toLowerCase();
  const category = { "": ["全部能力", "让熟悉的她们，拥有更多擅长的事。"], skill: ["技能", "任务专长与可复用的知识，按需装载。"], workflow: ["工作流", "把多步任务组织成可恢复、可验证的流程。"], mcp: ["插件 · MCP", "连接外部服务与工具；沿用现有 MCP 配置。"] }[capView.kind];
  $("#capHeading").textContent = category[0]; $("#capSubtitle").textContent = category[1];
  $("#capKindTabs").querySelectorAll("[data-cap-kind]").forEach(b => b.setAttribute("aria-current", String(b.dataset.capKind === capView.kind)));
  $("#capCatalog").hidden = !!capView.sel; $("#capDetailView").hidden = !capView.sel;
  $("#capPageHeading").hidden = !!capView.sel;
  box.closest(".cap-studio").classList.toggle("is-detail", !!capView.sel);
  const filtered = capView.packages.filter((item) =>
    (!capView.kind || item.kind === capView.kind) &&
    (!capView.mounted || (item.mountedBy.length > 0) === (capView.mounted === "yes")) &&
    (!q || item.name.toLowerCase().includes(q) || (item.description || "").toLowerCase().includes(q))
  );
  $("#capResultCount").textContent = `${filtered.length} 项能力 · 编辑仍经 Governance 审批`;
  if (!filtered.length) { box.innerHTML = `<div class="studio-empty"><h3>暂时没有匹配的能力</h3><p>试试其他关键词或分类。这里展示 Harbour 已登记的本地能力。</p></div>`; return; }
  box.innerHTML = filtered.map((item) => `
    <button class="cap-package${capabilityKey(item) === capView.sel ? " active" : ""}" data-capability="${esc(capabilityKey(item))}" title="${esc(item.description || item.name)}">
      <span class="cap-package-mark ${esc(item.kind)}">${CAP_KIND_META[item.kind]?.mark || "?"}</span>
      <span class="cap-package-copy"><b>${esc(item.name)}</b><small>${esc(item.description || `${item.files.length} files`)}</small><em>${CAP_KIND_META[item.kind]?.label || item.kind} · ${item.mountedBy.length ? `${item.mountedBy.length} 个 Agent 已挂载` : "未挂载"}${item.valid ? "" : " · 定义待修复"}</em></span>
      <span class="cap-package-count" aria-label="${item.mountedBy.length ? "已挂载" : "查看详情"}">${item.mountedBy.length ? "✓" : "↗"}</span>
    </button>`).join("");
  box.querySelectorAll("[data-capability]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.capability === capView.sel || !await leaveEditors("capability")) return;
    capView.sel = button.dataset.capability;
    capView.file = null;
    capView.editing = false;
    capView.workflowTab = "graph";
    renderCapabilityList();
    await renderCapabilityDetail();
  }));
}

function selectedCapability() {
  return capView.packages.find((item) => capabilityKey(item) === capView.sel) || null;
}

async function renderCapabilityDetail() {
  const box = $("#capDetail");
  if (!box) return;
  // Expansion belongs to the current visible canvas, not the shared capability layout.
  box.closest(".cap-layout")?.classList.remove("wf-expanded");
  const item = selectedCapability();
  if (!item) { box.innerHTML = `<div class="empty">← 选择一个 Skill、Workflow 或 MCP 查看内容</div>`; return; }
  if (!capView.file || !item.files.some((file) => file.path === capView.file)) capView.file = item.files[0]?.path || null;
  $("#capDetailKind").textContent = { skill: "技能", workflow: "工作流", mcp: "插件 · MCP" }[item.kind] || item.kind;
  const longDescription = (item.description || "").length > 160;
  const fileGroups = new Map();
  for (const file of item.files) {
    const folder = file.relativePath.includes("/") ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/")) : "入口文件";
    if (!fileGroups.has(folder)) fileGroups.set(folder, []);
    fileGroups.get(folder).push(file);
  }
  box.innerHTML = `
    <header class="cap-detail-head">
      <div class="cap-title-line"><span class="cap-package-mark ${esc(item.kind)}" aria-hidden="true">${CAP_KIND_META[item.kind]?.mark || "?"}</span><div class="cap-title-copy"><span class="cap-type-label">${CAP_KIND_META[item.kind]?.label || esc(item.kind)}</span><h3>${esc(item.name)}</h3></div>${item.valid ? "" : `<span class="cap-invalid">定义待修复</span>`}</div>
      <div class="cap-overview"><p id="capDescription" class="cap-description${longDescription ? " is-collapsed" : ""}">${esc(item.description || "这个能力还没有简介。")}</p>${longDescription ? '<button type="button" class="cap-description-toggle" id="capDescriptionToggle" aria-expanded="false" aria-controls="capDescription">展开说明 <span aria-hidden="true">⌄</span></button>' : ""}
      <div class="cap-mounted">${item.mountedBy.length ? `<span class="cap-mounted-label">已挂载</span>${item.mountedBy.map(name => `<span class="cap-agent-name">${esc(name)}</span>`).join("")}` : "尚未挂载到任何 Agent"}</div></div>
    </header>
    ${item.kind === "workflow" ? `<div class="cap-workflow-tabs" role="group" aria-label="Workflow 查看方式"><button type="button" data-workflow-tab="graph">流程画布</button><button type="button" data-workflow-tab="files">文件与契约</button></div><section class="cap-workflow-canvas" id="capWorkflowCanvas"></section>` : ""}
    <div class="cap-workbench">
      <aside class="cap-files" id="capFiles">
        <div class="cap-files-label"><span>文件</span><span>${item.files.length}</span></div>
        <button class="cap-mobile-files" id="capFilesToggle" type="button" aria-expanded="false" aria-controls="capFileList">${window.HarbourSpaces.icon("document")}<span>选择文件</span><small>${item.files.length} 个</small><span aria-hidden="true">⌄</span></button>
        <nav class="cap-file-list" id="capFileList" aria-label="能力文件">${item.files.length ? [...fileGroups].map(([folder, files]) => `<div class="cap-file-group"><div class="cap-folder-label">${esc(folder)}</div>${files.map(file => `<button type="button" class="cap-file${file.path === capView.file ? " active" : ""}" data-cap-file="${esc(file.path)}" aria-current="${file.path === capView.file ? "page" : "false"}" title="${esc(file.relativePath)}">${window.HarbourSpaces.icon("document")}<span>${esc(file.relativePath.split("/").pop())}</span></button>`).join("")}</div>`).join("") : '<div class="empty">无可编辑文本文件</div>'}</nav>
      </aside>
      <section class="cap-document">
        <div class="doc-toolbar cap-doc-toolbar">
          <div class="cap-current-file"><span id="capFileName">文件</span><span id="capFilePath"></span></div>
          <div class="doc-actions"><span class="cap-editing-label" id="capEditingLabel" hidden>正在编辑</span><div id="capDocToggleWrap">${docToggleHtml("capDocToggle", { render: "预览" })}</div><button class="cap-action cap-edit-action" id="capEdit" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>编辑文件</button></div>
        </div>
        <pre class="cap-content cap-source" id="capViewerBody"><span class="muted">—</span></pre>
        <div class="md-body cap-content" id="capViewerRender" hidden></div>
        <section class="governed-editor" id="capEditor" hidden>
          <p class="cap-editor-note">修改先提交审批，通过后才会生效。</p>
          <textarea class="inp governed-editor-text" id="capEditorText" aria-label="文件内容" spellcheck="false"></textarea>
          <div class="governed-editor-foot">
            <label class="cap-reason"><span>修改理由</span><input class="inp" id="capEditReason" placeholder="简单说明这次修改"></label>
            <button class="cap-action" id="capEditCancel" type="button">取消</button>
            <button class="cap-action cap-submit-action" id="capEditSubmit" type="button">提交审批</button>
          </div>
        </section>
        <details class="mem-file-git" id="capFileGit" hidden>
          <summary>版本历史 <span>查看差异与回滚</span></summary>
          <div class="cap-hist-list"><div class="empty">展开加载版本历史。</div></div>
        </details>
      </section>
    </div>`;
  $("#capDescriptionToggle")?.addEventListener("click", e => {
    const button = e.currentTarget, expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    $("#capDescription").classList.toggle("is-collapsed", !expanded);
    button.innerHTML = `${expanded ? "收起说明" : "展开说明"} <span aria-hidden="true">${expanded ? "⌃" : "⌄"}</span>`;
  });
  $("#capFilesToggle").addEventListener("click", e => {
    const expanded = e.currentTarget.getAttribute("aria-expanded") !== "true";
    e.currentTarget.setAttribute("aria-expanded", String(expanded));
    $("#capFiles").classList.toggle("is-open", expanded);
  });
  if (item.kind === "workflow") {
    const canvas = box.querySelector("#capWorkflowCanvas"), documents = box.querySelector(".cap-workbench");
    let mounted = false;
    const showTab = () => {
      canvas.hidden = capView.workflowTab !== "graph";
      documents.hidden = !canvas.hidden;
      if (canvas.hidden) {
        box.closest(".cap-layout")?.classList.remove("wf-expanded");
        const focusButton = canvas.querySelector('[data-wf="focus"]');
        if (focusButton) focusButton.textContent = "展开画布";
      }
      box.querySelectorAll("[data-workflow-tab]").forEach(button => {
        button.classList.toggle("active", button.dataset.workflowTab === capView.workflowTab);
        button.setAttribute("aria-pressed", String(button.dataset.workflowTab === capView.workflowTab));
      });
      if (!canvas.hidden && !mounted) {
        mounted = true;
        window.HarbourWorkflowCanvas?.mount(canvas, item.name, { api, toast, confirm: harbourConfirm });
      }
    };
    box.querySelectorAll("[data-workflow-tab]").forEach(button => button.addEventListener("click", async () => {
      if (button.dataset.workflowTab === capView.workflowTab || !await leaveEditors("workspace")) return;
      capView.workflowTab = button.dataset.workflowTab; showTab();
    }));
    showTab();
  }
  wireDocToggle("capDocToggle", applyCapabilityDocView);
  $("#capFiles").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-cap-file]");
    if (!button || button.dataset.capFile === capView.file) return;
    if (!await leaveEditors("file")) return;
    capView.file = button.dataset.capFile;
    capView.editing = false;
    $("#capFiles").querySelectorAll("[data-cap-file]").forEach(entry => { entry.classList.toggle("active", entry === button); entry.setAttribute("aria-current", entry === button ? "page" : "false"); });
    $("#capFiles").classList.remove("is-open"); $("#capFilesToggle").setAttribute("aria-expanded", "false");
    await loadCapabilityFile();
  });
  $("#capEdit").addEventListener("click", () => setCapabilityEditing(true));
  $("#capEditCancel").addEventListener("click", async () => {
    if (capView.saving) return;
    if (capView.editing && editorText($("#capEditorText").value) !== capView.raw
      && !await harbourConfirm("放弃当前文件尚未提交的修改？", { title: "取消编辑", confirmLabel: "放弃修改", tone: "warning" })) return;
    setCapabilityEditing(false);
  });
  $("#capEditSubmit").addEventListener("click", () => submitCapabilityEdit());
  const capEditor = box.querySelector("#capEditorText");
  editorLeave.register("capability-file", {
    isActive: () => capEditor.isConnected,
    isDirty: () => capView.editing && editorText(capEditor.value) !== capView.raw,
    isBusy: () => capView.saving,
    label: () => capView.file,
    version: () => JSON.stringify([capView.file, capEditor.value]),
    save: () => submitCapabilityEdit({ navigate: false }),
    discard: () => { if (capView.saving) return false; setCapabilityEditing(false); return true; },
  });
  $("#capFileGit").addEventListener("toggle", () => {
    const git = $("#capFileGit");
    if (git.open && capView.file && git.dataset.loaded !== capView.file) {
      git.dataset.loaded = capView.file;
      loadFileGit(capView.file, git.querySelector(".cap-hist-list"), () => PANELS.capabilities.render($("#content")));
    }
  });
  await loadCapabilityFile();
}

async function loadCapabilityFile() {
  const body = $("#capViewerBody"), title = $("#capFileName"), pathLabel = $("#capFilePath");
  const requestedFile = capView.file;
  const request = {}; capView.request = request;
  const isCurrentFile = () => body?.isConnected && capView.request === request && capView.file === requestedFile;
  capView.editing = false;
  capView.loading = true;
  capView.raw = "";
  setCapabilityEditing(false);
  if (!capView.file) {
    capView.raw = "";
    if (body) body.textContent = "—";
    if (title) title.textContent = "NO FILE";
    if ($("#capEdit")) $("#capEdit").disabled = true;
    return;
  }
  if (title) title.textContent = capView.file.split("/").pop();
  if (pathLabel) pathLabel.textContent = capView.file;
  if (pathLabel) pathLabel.title = capView.file;
  if (body) body.innerHTML = `<span class="muted">读取中…</span>`;
  if ($("#capViewerRender")) $("#capViewerRender").innerHTML = `<span class="muted">读取中…</span>`;
  try {
    const data = await api(`/api/capabilities/file?path=${encodeURIComponent(requestedFile)}`);
    if (!isCurrentFile()) return;
    capView.raw = editorText(data.content);
    capView.loading = false;
    if (body) body.textContent = capView.raw || "(空文件)";
    const markdown = /\.md$/i.test(capView.file);
    $("#capDocToggleWrap").hidden = !markdown;
    applyCapabilityDocView(markdown ? docViewMode() : "raw");
    setCapabilityEditing(false);
    const git = $("#capFileGit");
    git.hidden = false; git.open = false; git.dataset.loaded = "";
    git.querySelector(".cap-hist-list").innerHTML = `<div class="empty">展开查看「${esc(capView.file.split("/").pop())}」的版本历史。</div>`;
  } catch (e) {
    if (!isCurrentFile()) return;
    capView.raw = "";
    if (body) body.innerHTML = `<span class="muted">⚠ ${esc(e.message)}</span>`;
    if ($("#capViewerRender")) $("#capViewerRender").innerHTML = `<span class="muted">⚠ ${esc(e.message)}</span>`;
  }
}

function applyCapabilityDocView(mode) {
  const raw = $("#capViewerBody"), rendered = $("#capViewerRender");
  if (!raw || !rendered) return;
  if (capView.editing) { raw.hidden = true; rendered.hidden = true; return; }
  const useRender = mode === "render" && /\.md$/i.test(capView.file || "");
  raw.hidden = useRender;
  rendered.hidden = !useRender;
  $("#capDocToggle")?.querySelectorAll("[data-doc-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.docView === (useRender ? "render" : "raw"))));
  if (useRender) rendered.innerHTML = capView.raw ? renderCapabilityMarkdown(capView.raw) : `<span class="muted">—</span>`;
}

// Presentation only: metadata remains accessible; raw/edit/proposal content is unchanged.
function renderCapabilityMarkdown(source) {
  const frontmatter = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (!frontmatter || !/^[a-zA-Z_][\w-]*\s*:/m.test(frontmatter[1])) return renderMarkdownLite(source);
  return `<details class="cap-frontmatter"><summary>文件元信息 <span>名称、描述与配置</span></summary><pre>${esc(frontmatter[1])}</pre></details>${renderMarkdownLite(source.slice(frontmatter[0].length))}`;
}

function setCapabilityEditing(editing) {
  capView.editing = !!editing && !!capView.file && !capView.loading;
  const editor = $("#capEditor"), editBtn = $("#capEdit"), toggle = $("#capDocToggleWrap"), git = $("#capFileGit");
  if (!editor) return;
  editor.hidden = !capView.editing;
  $("#capEditingLabel").hidden = !capView.editing;
  if (editBtn) { editBtn.hidden = capView.editing; editBtn.disabled = !capView.file || capView.loading; }
  if (toggle) toggle.hidden = capView.editing || capView.loading || !/\.md$/i.test(capView.file || "");
  if (git) git.hidden = capView.editing || capView.loading || !capView.file;
  if (capView.editing) {
    $("#capEditorText").value = capView.raw;
    $("#capEditReason").value = `edit ${capView.file}`;
    $("#capEditorText").focus();
    $("#capEditorText").setSelectionRange(0, 0);
    $("#capEditorText").scrollTop = 0;
    editor.scrollTop = 0;
  } else { $("#capEditorText").value = capView.raw; $("#capEditReason").value = ""; }
  applyCapabilityDocView(/\.md$/i.test(capView.file || "") ? docViewMode() : "raw");
}

async function submitCapabilityEdit({ navigate = true } = {}) {
  const item = selectedCapability();
  if (!item || !capView.file || capView.saving || capView.loading) return false;
  const editor = $("#capEditorText"), path = capView.file;
  const content = editorText(editor.value);
  if (content === capView.raw) { setCapabilityEditing(false); return true; }
  const btn = $("#capEditSubmit");
  capView.saving = true;
  btn.disabled = true;
  try {
    await api("/api/governance/proposals", {
      method: "POST",
      body: JSON.stringify({
        targetType: item.kind,
        targetPath: path,
        operation: "write",
        content,
        reason: $("#capEditReason").value.trim() || `edit ${capView.file}`,
        sourceAgent: "web",
      }),
    });
    toast(`${CAP_KIND_META[item.kind]?.label || item.kind} 修改已提交审批`);
    if (!editor.isConnected || capView.file !== path) return false;
    capView.raw = content;
    if (editorText(editor.value) !== content) return false;
    $("#capViewerBody").textContent = content;
    setCapabilityEditing(false);
    if (navigate) location.hash = "governance";
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  } finally {
    capView.saving = false;
    btn.disabled = false;
  }
}

/* ── MEMORY：全局记忆库浏览 + 内联编辑 + git 版本治理 ──────────────
   编辑器提交 Governance proposal；审批 apply 后才落盘，保持 memory-keeper 的治理边界。 */
const MEM_TYPE_COLORS = { Concept: "#b9a7ff", Entity: "#8fe3c8", Source: "#f3c969", Journal: "#7fb3ff", Output: "#f08a8a", Treasure: "#d3a957", Page: "#9aa6b2" };
const MEM_TYPE_LABELS = { Treasure: "宝库" };
// MEMORY 面板视图态：全量 + 选中 + 搜索 + type 分面 + 当前文件路径（跨渲染保持，仿 AGENTS）。
const memView = { pages: [], sel: null, q: "", type: "", dir: "", kind: "", filePath: null, raw: "", editing: false, loading: false, saving: false };

// Display hierarchy comes from the real relative path, not the title or inferred entity type.
function memoryLocation(page) {
  const parts = String(page.path || page.name || "").replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
  const filename = parts.pop() || "";
  const depth = parts.length;
  return { parts, filename, directory: parts.join("/"), depth, isIndex: filename.toLowerCase() === "index.md", level: depth ? `${depth} 级目录` : "根目录" };
}

function memoryPathHtml(page) {
  const location = memoryLocation(page);
  return `<span class="memory-path" title="${esc(page.path || "")}"><span class="memory-path-root">Memory</span>${location.parts.map(part => `<span class="memory-path-separator" aria-hidden="true">/</span><span>${esc(part)}</span>`).join("")}</span>`;
}

function memoryDisplayTitle(page) {
  const location = memoryLocation(page);
  // Generated indexes often have no title: avoid an indistinguishable wall of “index”.
  if (location.isIndex && (!page.title || /^index(?:\.md)?$/i.test(page.title))) return location.parts.at(-1) || "记忆库导航";
  return page.title || location.filename;
}

function updateMemorySelection() {
  const detail = !!memView.sel;
  if ($("#memCatalog")) $("#memCatalog").hidden = detail;
  if ($("#memDetailView")) $("#memDetailView").hidden = !detail;
}

// 从现有页面和子目录索引推导，不维护第二份目录树；包含只有 index.md 的空分类。
function memoryDirectoryOptions(pages) {
  const titles = new Map(pages.filter(p => p.name === "index.md" && p.dir && p.title && p.title !== "index").map(p => [p.dir, p.title]));
  const dirs = new Set();
  for (const page of pages) {
    const parts = (page.dir || "").split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort().map(dir => ({ path: dir, label: dir.split("/").map((part, i, parts) => titles.get(parts.slice(0, i + 1).join("/")) || part).join(" / ") }));
}

function memoryPageMatches(page, query, type, dir) {
  const q = query.trim().toLowerCase();
  return (!type || page.type === type) && (!dir || page.dir === dir || (page.dir || "").startsWith(dir + "/")) &&
    (!q || [page.title, page.description, page.name, page.path, MEM_TYPE_LABELS[page.type]].some(value => (value || "").toLowerCase().includes(q)));
}

function memoryDocumentBody(raw) {
  return String(raw || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

PANELS.memory = {
  id: "memory",
  async render(root) {
    const data = await api("/api/memory");
    memView.pages = data.pages || [];
    if (!memView.pages.some((p) => p.path === memView.sel)) memView.sel = null;
    const types = Object.keys(data.byType || {}).sort((a, b) => (data.byType[b] - data.byType[a]));
    const directories = memoryDirectoryOptions(memView.pages);
    if (memView.dir && !directories.some(dir => dir.path === memView.dir)) memView.dir = "";

    root.innerHTML = `
      <div class="collection-studio memory-studio">
        <section class="collection-catalog" id="memCatalog" aria-label="记忆卡片目录">
          <header class="collection-heading">
            <div><span class="studio-kicker">A PLACE FOR WHAT MATTERS</span><h1>记忆库 <span>${memView.pages.length}</span></h1><p>把值得记住的事，安放在清晰的位置。</p></div>
            <div class="collection-tools">
              <label class="studio-search">${collectionIcon("search")}<input id="memFilter" aria-label="搜索记忆" placeholder="搜索标题、描述或路径…" value="${esc(memView.q)}"></label>
              <a class="studio-secondary" id="memGraphOpen" target="_blank" rel="noopener" title="在新标签页打开知识图谱">${collectionIcon("graph")}知识图谱</a>
              <button class="studio-icon-button" id="memRefresh" title="刷新记忆库" aria-label="刷新记忆库">${collectionIcon("refresh")}</button>
            </div>
          </header>
          <nav class="collection-tabs" id="memChips" aria-label="记忆类型">
            <button class="chip${memView.type === "" ? " active" : ""}" data-mtype="" aria-pressed="${memView.type === ""}">全部 <small>${memView.pages.length}</small></button>
            ${types.map((t) => `<button class="chip${memView.type === t ? " active" : ""}" data-mtype="${esc(t)}" aria-pressed="${memView.type === t}"><span class="mem-dot" style="background:${MEM_TYPE_COLORS[t] || MEM_TYPE_COLORS.Page}"></span>${esc(MEM_TYPE_LABELS[t] || t)} <small>${data.byType[t]}</small></button>`).join("")}
          </nav>
          <div class="memory-filterbar">
            <label class="memory-directory-filter">${collectionIcon("folder")}<select class="inp" id="memDirectory" aria-label="记忆目录" data-hs-menu-width="460" data-hs-menu-title="选择目录" data-hs-menu-hint="筛选所选目录及其子目录中的文件">
              <option value="" data-hs-description="浏览整座记忆库">全部目录</option>
              ${directories.map(dir => `<option value="${esc(dir.path)}" data-hs-description="${esc('Memory / ' + dir.path.split('/').join(' / '))}"${memView.dir === dir.path ? " selected" : ""}>${esc(dir.label)}</option>`).join("")}
            </select></label>
            <div class="memory-kind-filter" role="group" aria-label="记忆文件种类">
              ${[["", "全部文件"], ["page", "内容页"], ["index", "目录索引"]].map(([kind, label]) => `<button type="button" data-mkind="${kind}" aria-pressed="${memView.kind === kind}">${kind === "index" ? collectionIcon("index") : ""}${label}</button>`).join("")}
            </div>
          </div>
          <div class="collection-caption"><span id="memCount" role="status" aria-live="polite"></span><span class="memory-legend">${collectionIcon("index")}金色为目录索引 · 路径显示真实层级</span></div>
          <div class="collection-grid" id="memList"></div>
        </section>
        <section class="collection-detail" id="memDetailView" hidden aria-label="记忆详情">
          <nav class="collection-breadcrumb" aria-label="记忆导航"><button id="memBack">${collectionIcon("back")}记忆库</button><span aria-hidden="true">/</span><span id="memDetailPath"></span></nav>
          <header class="memory-detail-heading"><div id="memViewerMeta"></div><h1 id="memViewerTitle">记忆详情</h1></header>
          <section class="memory-workbench" id="memViewerPane">
            <div class="doc-toolbar memory-doc-toolbar">
              <div id="memFileLabel" class="memory-file-label"></div>
              <div class="doc-actions">${docToggleHtml("memDocToggle")}<button class="cap-action cap-edit-action" id="memEdit" type="button">${collectionIcon("edit")}编辑</button></div>
            </div>
            <pre class="mem-content memory-document" id="memViewerBody"></pre>
            <div class="md-body doc-render memory-document" id="memViewerRender" hidden></div>
            <section class="governed-editor" id="memEditor" hidden>
              <p class="collection-editor-note">修改原文，提交后经 Governance 审批生效。</p>
              <textarea class="inp governed-editor-text" id="memEditorText" aria-label="记忆文件原文" spellcheck="false"></textarea>
              <div class="governed-editor-foot">
                <label class="cap-reason">修改理由<input class="inp" id="memEditReason" placeholder="说明这次修改" value="edit memory"></label>
                <button class="cap-action" id="memEditCancel" type="button">取消</button>
                <button class="cap-action cap-submit-action" id="memEditSubmit" type="button">提交审批</button>
              </div>
            </section>
            <details class="mem-file-git" id="memFileGit" hidden>
              <summary>版本历史 <span>查看差异与恢复版本</span></summary>
              <div id="memHistList"><div class="empty">展开加载该文件的 git 历史。</div></div>
            </details>
          </section>
        </section>
      </div>`;

    const openA = $("#memGraphOpen");
    if (openA) openA.href = withToken("/api/memory/graph");
    wireDocToggle("memDocToggle", applyMemDocView);   // 渲染/原文切换
    $("#memEdit").addEventListener("click", () => setMemEditing(true));
    $("#memEditCancel").addEventListener("click", async () => {
      if (memView.saving) return;
      if (memView.editing && editorText($("#memEditorText").value) !== memView.raw
        && !await harbourConfirm("放弃当前记忆文件尚未提交的修改？", { title: "取消编辑", confirmLabel: "放弃修改", tone: "warning" })) return;
      setMemEditing(false);
    });
    $("#memEditSubmit").addEventListener("click", () => submitMemEdit());
    const memEditor = root.querySelector("#memEditorText");
    editorLeave.register("memory-file", {
      isActive: () => memEditor.isConnected,
      isDirty: () => memView.editing && editorText(memEditor.value) !== memView.raw,
      isBusy: () => memView.saving,
      label: () => `assets/Memory/${memView.filePath}`,
      version: () => JSON.stringify([memView.filePath, memEditor.value]),
      save: () => submitMemEdit({ navigate: false }),
      discard: () => { if (memView.saving) return false; setMemEditing(false); return true; },
    });
    $("#memRefresh").addEventListener("click", route);
    $("#memBack").addEventListener("click", async () => {
      if (!await leaveEditors("file") || !memEditor.isConnected) return;
      const previous = memView.sel;
      memView.sel = null; memView.filePath = null; memView.request = null;
      memView.raw = ""; memView.loading = false; memView.error = null;
      setMemEditing(false);
      updateMemorySelection();
      root.querySelector(`[data-mem-file="${CSS.escape(previous || "")}"]`)?.focus({ preventScroll: true });
    });
    root.querySelectorAll("[data-mkind]").forEach(button => button.addEventListener("click", () => {
      memView.kind = button.dataset.mkind;
      root.querySelectorAll("[data-mkind]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      renderMemList();
    }));
    $("#memFilter").addEventListener("input", (e) => { memView.q = e.target.value; renderMemList(); });
    $("#memDirectory").addEventListener("change", (e) => {
      memView.dir = e.target.value;
      memView.type = "";
      root.querySelectorAll("#memChips .chip").forEach(item => { item.classList.toggle("active", item.dataset.mtype === ""); item.setAttribute("aria-pressed", String(item.dataset.mtype === "")); });
      renderMemList();
    });
    root.querySelectorAll("#memChips .chip").forEach((c) =>
      c.addEventListener("click", () => {
        memView.type = c.dataset.mtype;
        memView.dir = "";
        $("#memDirectory").value = "";
        root.querySelectorAll("#memChips .chip").forEach(item => { item.classList.toggle("active", item === c); item.setAttribute("aria-pressed", String(item === c)); });
        renderMemList();
      }));
    // 每文件 git 历史：展开时按当前选中文件加载（跟着 file 走）。
    const git = $("#memFileGit");
    if (git) git.addEventListener("toggle", () => {
      if (git.open && memView.filePath && git.dataset.loaded !== memView.filePath) {
        git.dataset.loaded = memView.filePath;
        loadMemFileGit(memView.filePath);
      }
    });
    renderMemList();
    updateMemorySelection();
    if (memView.sel) viewMemFile(memView.sel, null);
  },
};

// Catalog cards expose physical hierarchy separately from semantic type and routing role.
function renderMemList() {
  const box = $("#memList");
  if (!box) return;
  const filtered = memView.pages.filter(p => memoryPageMatches(p, memView.q, memView.type, memView.dir) &&
    (!memView.kind || memoryLocation(p).isIndex === (memView.kind === "index")));
  $("#memCount").textContent = `${filtered.length} 个文件${memView.q || memView.type || memView.dir || memView.kind ? " · 筛选结果" : ""}`;
  if (!filtered.length) { box.innerHTML = `<div class="collection-empty">没有找到匹配的记忆<small>试试其他关键词、目录或文件种类。</small></div>`; return; }
  box.innerHTML = filtered.map((p) => {
    const location = memoryLocation(p);
    return `<button class="collection-card memory-card${location.isIndex ? " is-index" : ""}" data-mem-file="${esc(p.path)}" title="${esc(p.path)}">
      <span class="collection-card-top"><span class="collection-symbol">${collectionIcon(location.isIndex ? "index" : "document")}</span><span class="collection-tag"><span class="mem-dot" style="background:${MEM_TYPE_COLORS[p.type] || MEM_TYPE_COLORS.Page}"></span>${esc(MEM_TYPE_LABELS[p.type] || p.type || "Page")}</span></span>
      <span class="collection-card-title">${esc(memoryDisplayTitle(p))}</span>
      <span class="collection-card-description">${esc(p.description || (location.isIndex ? "这个目录的导航与资源入口。" : "打开查看记忆原文与版本历史。"))}</span>
      <span class="memory-card-location"><span class="memory-location-label"><span class="memory-role">${location.isIndex ? "目录索引" : "内容页"}</span><span>${location.level}</span></span>${memoryPathHtml(p)}</span>
      <span class="collection-card-footer"><span class="memory-filename">${esc(location.filename)}</span>${collectionIcon("arrow")}</span>
    </button>`;
  }).join("");
  box.querySelectorAll("[data-mem-file]").forEach((el) =>
    el.addEventListener("click", async () => {
      if (el.dataset.memFile === memView.sel || !await leaveEditors("file") || !el.isConnected) return;
      memView.sel = el.dataset.memFile;
      updateMemorySelection();
      await viewMemFile(el.dataset.memFile, null);
      if (memView.sel === el.dataset.memFile) $("#memBack")?.focus({ preventScroll: true });
    }));
}

/** 按当前模式显隐「原文 <pre> / 渲染 <div>」。渲染内容从 memView.raw 现算，不重新请求。 */
function applyMemDocView(mode) {
  const raw = $("#memViewerBody"), rend = $("#memViewerRender");
  if (!raw || !rend) return;
  if (memView.editing) { raw.hidden = true; rend.hidden = true; return; }
  const isRender = mode === "render";
  raw.hidden = isRender;
  rend.hidden = !isRender;
  if (isRender) {
    rend.innerHTML = memView.loading ? `<span class="muted">读取中…</span>` : memView.error ? `<span class="muted">⚠ ${esc(memView.error)}</span>` : memView.raw ? renderMarkdownLite(memoryDocumentBody(memView.raw)) : `<span class="muted">(空文件)</span>`;
  }
}

function setMemEditing(editing) {
  memView.editing = !!editing && !!memView.filePath && !memView.loading && !memView.error;
  const editor = $("#memEditor"), editBtn = $("#memEdit"), toggle = $("#memDocToggle"), git = $("#memFileGit");
  if (!editor) return;
  editor.hidden = !memView.editing;
  if (editBtn) { editBtn.hidden = memView.editing; editBtn.disabled = !memView.filePath || memView.loading || !!memView.error; }
  if (toggle) toggle.hidden = memView.editing;
  if (git) git.hidden = memView.editing || !memView.filePath;
  if (memView.editing) {
    $("#memEditorText").value = memView.raw;
    $("#memEditReason").value = `edit memory/${memView.filePath}`;
    $("#memEditorText").focus();
  } else { $("#memEditorText").value = memView.raw; $("#memEditReason").value = ""; }
  applyMemDocView(docViewMode());
}

async function submitMemEdit({ navigate = true } = {}) {
  if (!memView.filePath || memView.saving || memView.loading) return false;
  const editor = $("#memEditorText"), path = memView.filePath;
  const content = editorText(editor.value);
  if (content === memView.raw) { setMemEditing(false); return true; }
  const btn = $("#memEditSubmit");
  memView.saving = true;
  btn.disabled = true;
  try {
    await api("/api/governance/proposals", {
      method: "POST",
      body: JSON.stringify({
        targetType: "memory",
        targetPath: `assets/Memory/${path}`,
        operation: "write",
        content,
        reason: $("#memEditReason").value.trim() || `edit memory/${memView.filePath}`,
        sourceAgent: "web",
      }),
    });
    toast("Memory 修改已提交审批");
    if (!editor.isConnected || memView.filePath !== path) return false;
    memView.raw = content;
    if (editorText(editor.value) !== content) return false;
    $("#memViewerBody").textContent = content;
    setMemEditing(false);
    if (navigate) location.hash = "governance";
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  } finally {
    memView.saving = false;
    btn.disabled = false;
  }
}

async function viewMemFile(pathRel, _el, opts) {
  // 选中高亮由 renderMemList 统一处理（memView.sel）；这里只负责把内容读进查看器 + 复位该文件的 git 区。
  // opts.keepGit=true：只重载内容、不动版本历史区（恢复版本后刷新内容时用——
  // 否则刚看的历史会被收起来，还得重新展开找回位置）。
  const keepGit = !!opts?.keepGit;
  memView.filePath = pathRel;
  memView.editing = false;
  memView.loading = true;
  memView.error = null;
  memView.raw = "";
  const request = {}; memView.request = request;
  setMemEditing(false);
  const body = $("#memViewerBody");
  const isCurrentFile = () => body?.isConnected && memView.request === request && memView.filePath === pathRel;
  const title = $("#memViewerTitle");
  const meta = $("#memViewerMeta");
  const page = memView.pages?.find(page => page.path === pathRel) || { path: pathRel };
  const location = memoryLocation(page);
  if (title) title.textContent = memoryDisplayTitle(page);
  if (meta) meta.innerHTML = `<span class="collection-tag"><span class="mem-dot" style="background:${MEM_TYPE_COLORS[page.type] || MEM_TYPE_COLORS.Page}"></span>${esc(MEM_TYPE_LABELS[page.type] || page.type || "Page")}</span><span class="memory-role${location.isIndex ? " is-index" : ""}">${collectionIcon(location.isIndex ? "index" : "document")}${location.isIndex ? "目录索引" : "内容页"}</span><span>${location.level}</span>`;
  if ($("#memDetailPath")) $("#memDetailPath").innerHTML = memoryPathHtml(page);
  if ($("#memFileLabel")) $("#memFileLabel").innerHTML = `${collectionIcon(location.isIndex ? "index" : "document")}<span>${esc(location.filename)}</span>`;
  // 复位每文件 git 区（收起、清缓存，展开时按新文件重新加载）。
  const git = $("#memFileGit");
  if (git && !keepGit) { git.hidden = false; git.open = false; git.dataset.loaded = ""; const hl = $("#memHistList"); if (hl) hl.innerHTML = `<div class="empty">展开查看「${esc(pathRel.split("/").pop())}」的版本历史。</div>`; }
  if (body) body.innerHTML = `<span class="muted">读取中…</span>`;
  try {
    const { content } = await api(`/api/memory/file?path=${encodeURIComponent(pathRel)}`);
    if (!isCurrentFile()) return;
    memView.raw = editorText(content);
    memView.loading = false;
    if (body) body.textContent = memView.raw || "(空文件)";
    applyMemDocView(docViewMode());   // 原文/渲染两边都填好，按当前偏好显隐
    setMemEditing(false);
  } catch (e) {
    if (!isCurrentFile()) return;
    memView.raw = "";
    memView.loading = false;
    memView.error = e.message;
    if (body) body.innerHTML = `<span class="muted">⚠ ${esc(e.message)}</span>`;
    setMemEditing(false);
    applyMemDocView("raw");           // 出错就显示原文区里的错误提示
  }
}

/* 版本历史表 HTML（MEMORY / AGENTS 共用）。attr = "mem" | "fg"，决定按钮的 data-* 前缀。
   顶部一条醒目的「当前版本」行（哪个版本、什么时候、什么改动）；每行给友好时间 + 相对时间。 */
function versionHistoryHtml(commits, attr) {
  // 后端已折叠掉「恢复」产生的记录：列表里【只有真实的内容版本】，
  // 在 v1↔v2 之间来回切也永远只有那两条；哪条生效由 c.current 标记（不再假设第一条就是当前）。
  const curIdx = Math.max(0, commits.findIndex((c) => c.current));
  const cur = commits[curIdx] || {};
  return `
    <div class="hist-current">
      <span class="hist-cur-tag">当前</span>
      <span class="hist-cur-time">${timeHtml(cur.date, "short")} · ${esc(timeAgo(cur.date))}</span>
      <span class="hist-cur-msg" title="${esc(cur.message || "")}">${esc(cur.message || "—")}</span>
      <span class="mono hist-cur-hash">${esc(cur.hash || "—")}</span>
    </div>
    <table class="tbl tbl-compact hist-tbl"><tbody>${
      commits.map((c) => `<tr class="${c.current ? "hist-row-cur" : ""}">
        <td class="hist-when" ${timeTitleAttrs(c.date)}>${esc(timeAgo(c.date))}<span class="hist-abs">${timeHtml(c.date, "short")}</span></td>
        <td class="hist-what cell-ell" title="${esc(c.message)}">${esc(c.message || "—")}</td>
        <td class="mono hist-hash">${esc(c.hash)}${c.current ? ' <span class="badge">当前</span>' : ""}</td>
        <td class="cron-ops"><button class="btn-mini" data-${attr}-diff="${esc(c.hash)}">对比</button>${
          c.current ? "" : `<button class="btn-mini" data-${attr}-rollback="${esc(c.hash)}">切到此版本</button>`
        }</td>
      </tr>`).join("")
    }</tbody></table>`;
}

/* 通用单文件版本历史（渲进任意 box）：MEMORY 与 AGENTS 面板共用同一套 /api/governance 端点。
   onRollback：回滚成功后的回调（AGENTS 面板用它重渲编辑器；缺省则只刷新历史表）。 */
async function loadFileGit(path, box, onRollback) {
  if (!box || !path) return;
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const data = await api(`/api/governance/history?path=${encodeURIComponent(path)}`);
    if (!data.hasRepo) { box.innerHTML = `<div class="empty">主仓没有 .git（版本治理不可用）。</div>`; return; }
    if (!data.commits.length) { box.innerHTML = `<div class="empty">该文件暂无提交记录。</div>`; return; }
    const name = path.split("/").pop();
    box.innerHTML = versionHistoryHtml(data.commits, "fg") + `<div class="fg-diff-box"></div>`;
    const diffBox = box.querySelector(".fg-diff-box");
    box.querySelectorAll("[data-fg-diff]").forEach((b) => b.addEventListener("click", () => fileGitDiff(path, b.dataset.fgDiff, diffBox)));
    box.querySelectorAll("[data-fg-rollback]").forEach((b) => b.addEventListener("click", async () => {
      if (!await leaveEditors("rollback")) return;
      const commit = b.dataset.fgRollback;
      if (!await harbourConfirm(`「${name}」将切换到 ${commit} 这一版。`, {
        title: "切换 Agent 版本？", detail: "应用后会热重载该 Agent；之后仍可从版本历史切回。", confirmLabel: "切换版本", tone: "warning",
      })) return;
      try {
        const r = await api("/api/governance/rollback", { method: "POST", body: JSON.stringify({ path, commit }) });
        if (!r.commit) { toast(`「${name}」已经是 ${commit} 这一版`); return; }
        toast(`已切换「${name}」到 ${commit} 这一版`);
        if (onRollback) onRollback(); else loadFileGit(path, box, onRollback);
      } catch (e) { toast(`恢复失败：${e.message}`, true); }
    }));
  } catch (e) {
    box.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`;
  }
}

async function fileGitDiff(path, commit, box) {
  if (!box) return;
  box.innerHTML = `<div class="empty">读取 ${esc(commit)}…</div>`;
  try {
    const d = await api(`/api/governance/diff?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`);
    box.innerHTML = `<div class="diff-grid" style="margin-top:12px">
      <div><span class="diff-title">@${esc(commit)}</span><pre>${esc(d.atCommit || "(空)")}</pre></div>
      <div><span class="diff-title">CURRENT (HEAD)</span><pre>${esc(d.current || "(空)")}</pre></div>
    </div>`;
  } catch (e) { toast(e.message, true); }
}

/* 单文件 git 历史/diff/回滚（git 跟着每个 file 走）：复用 /api/governance 记忆端点，渲进查看器里的折叠区。 */
async function loadMemFileGit(path) {
  const box = $("#memHistList");
  if (!box || !path) return;
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const data = await api(`/api/governance/history?path=${encodeURIComponent(path)}`);
    if (!data.hasRepo) { box.innerHTML = `<div class="empty">主仓没有 .git（版本治理不可用）。</div>`; return; }
    if (!data.commits.length) { box.innerHTML = `<div class="empty">该文件暂无提交记录。</div>`; return; }
    box.innerHTML = versionHistoryHtml(data.commits, "mem") + `<div id="memDiffBox"></div>`;
    box.querySelectorAll("[data-mem-diff]").forEach((b) => b.addEventListener("click", () => memDiff(path, b.dataset.memDiff)));
    box.querySelectorAll("[data-mem-rollback]").forEach((b) => b.addEventListener("click", () => memRollback(path, b.dataset.memRollback)));
  } catch (e) {
    box.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`;
  }
}

async function memDiff(path, commit) {
  const box = $("#memDiffBox");
  if (!box) return;
  box.innerHTML = `<div class="empty">读取 ${esc(commit)}…</div>`;
  try {
    const d = await api(`/api/governance/diff?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`);
    box.innerHTML = `<div class="diff-grid" style="margin-top:12px">
      <div><span class="diff-title">@${esc(commit)}</span><pre>${esc(d.atCommit || "(空)")}</pre></div>
      <div><span class="diff-title">CURRENT (HEAD)</span><pre>${esc(d.current || "(空)")}</pre></div>
    </div>`;
  } catch (e) { toast(e.message, true); }
}

async function memRollback(path, commit) {
  if (!await leaveEditors("rollback")) return;
  const name = path.split("/").pop();
  if (!await harbourConfirm(`「${name}」将切换到 ${commit} 这一版。`, {
    title: "切换记忆版本？", detail: "本次切换也会形成新的治理记录，之后仍可切回。", confirmLabel: "切换版本", tone: "warning",
  })) return;
  try {
    const r = await api("/api/governance/rollback", { method: "POST", body: JSON.stringify({ path, commit }) });
    // commit=null = 内容和目标版本一致、没东西可提交（无变化）。如实告诉用户，别谎报「已恢复」。
    if (!r.commit) { toast(`「${name}」已经是 ${commit} 这一版`); return; }
    toast(`已切换「${name}」到 ${commit} 这一版`);
    await viewMemFile(path, null, { keepGit: true }); // 刷新内容，但保持历史区展开（别把人踢回收起状态）
    loadMemFileGit(path);      // 刷新历史表（新的「当前」上移）
  } catch (e) { toast(`恢复失败：${e.message}`, true); }
}

PANELS.governance = {
  id: "governance",
  async render(root) {
    const [{ proposals }, { agents }] = await Promise.all([api("/api/governance"), api("/api/agents")]);
    state.governance.proposals = proposals;
    root.innerHTML = `
      <div class="panel-head"><h2>GOVERNANCE</h2><span class="sub">// Memory / Agent / Skill / Workflow / MCP 写入审批守门</span>
        <span class="spacer"></span><button class="btn ghost" id="govRefresh">REFRESH</button></div>
      <nav class="gov-status-tabs" id="govStatusTabs" aria-label="Proposal 状态筛选"></nav>
      <div class="governance-layout">
        <section class="governance-queue">
          <div class="gov-queue-head">
            <div><h3 id="govQueueTitle"></h3><p id="govQueueSub"></p></div>
            <span class="gov-queue-total" id="govQueueTotal"></span>
          </div>
          <div class="governance-list" id="govList" aria-live="polite"></div>
        </section>
        <aside class="governance-editor" id="govAside">
          <div class="side-section">
            <h3>NEW PROPOSAL</h3>
            <label class="field"><span>TYPE</span>
              <select class="inp" id="govType"><option value="memory">Memory</option><option value="agent">Agent file</option></select></label>
            <div id="govMemoryFields">
              <label class="field"><span>MEMORY PATH</span><input class="inp" id="govMemoryPath" value="journals/${HarbourTime.format(Date.now(), "date")}.md"></label>
              <p class="field-hint">根 <code>index.md</code> 固定只读；页面应用后自动重建各级子目录索引。</p>
              <label class="field"><span>OPERATION</span><select class="inp" id="govOperation"><option value="append">append</option><option value="write">write</option></select></label>
            </div>
            <div id="govAgentFields" hidden>
              <label class="field"><span>AGENT</span><select class="inp" id="govAgent">${agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></label>
              <label class="field"><span>FILE</span><select class="inp" id="govAgentFile">
                ${["CLAUDE.md", "SOUL.md", "MEMORY.md", "HEARTBEAT.md", "tools/index.md", "skills/index.md", "workflows/index.md", "subagents/index.md", "mcp/index.md"].map((f) => `<option value="${f}">${f}</option>`).join("")}
              </select></label>
              <button class="btn ghost" id="govLoadAgentFile">LOAD CURRENT FILE</button>
            </div>
            <label class="field"><span>REASON</span><input class="inp" id="govReason" value="web governance proposal"></label>
            <label class="field"><span>CONTENT</span><textarea class="inp gov-content" id="govContent" placeholder="写入或追加的内容；提交后只生成 proposal。"></textarea></label>
            <button class="btn primary" id="govCreate">CREATE PROPOSAL</button>
          </div>
        </aside>
      </div>

      <details class="gov-extra">
        <summary>⎇ GIT 版本治理 · assets/Memory 走主仓 git · apply=commit · 回滚走 git</summary>
        <div class="card" style="margin-top:10px">
          <div class="row" style="gap:10px">
            <label class="field" style="flex:1;margin:0"><span>路径（空=整库 log）</span><input class="inp" id="govHistPath" placeholder="journals/dream-2026-06-27.md"></label>
            <button class="btn ghost" id="govHistLoad" style="align-self:flex-end">LOAD HISTORY</button>
          </div>
          <div id="govHistList" style="margin-top:12px"><div class="empty">点 LOAD HISTORY 看 Memory 仓 git log；填路径可查单文件历史并回滚。</div></div>
        </div>
      </details>`;
    bindGovernance(root);
    renderGovernanceQueue();
    $("#govHistLoad", root).addEventListener("click", loadGovHistory);
  },
};

async function loadGovHistory() {
  const box = $("#govHistList");
  const p = $("#govHistPath").value.trim();
  if (!box) return;
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const data = await api(`/api/governance/history${p ? "?path=" + encodeURIComponent(p) : ""}`);
    if (!data.hasRepo) { box.innerHTML = `<div class="empty">主仓没有 .git（版本治理不可用）。</div>`; return; }
    if (!data.commits.length) { box.innerHTML = `<div class="empty">无提交记录${p ? "（该路径）" : ""}。</div>`; return; }
    box.innerHTML = `<table class="tbl"><thead><tr><th>COMMIT</th><th>DATE</th><th>MESSAGE</th>${p ? "<th></th>" : ""}</tr></thead><tbody>${
      data.commits.map((c) => `<tr>
        <td class="mono">${esc(c.hash)}</td>
        <td class="mono muted">${timeHtml(c.date)}</td>
        <td>${esc(c.message)}</td>
        ${p ? `<td class="row" style="gap:6px"><button class="btn-mini" data-gov-diff="${esc(c.hash)}">DIFF</button><button class="btn-mini" data-gov-rollback="${esc(c.hash)}">ROLLBACK</button></td>` : ""}
      </tr>`).join("")
    }</tbody></table><div id="govDiffBox"></div>`;
    box.querySelectorAll("[data-gov-diff]").forEach((b) => b.addEventListener("click", () => govDiff(p, b.dataset.govDiff)));
    box.querySelectorAll("[data-gov-rollback]").forEach((b) => b.addEventListener("click", () => govRollback(p, b.dataset.govRollback)));
  } catch (e) {
    box.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`;
  }
}

async function govDiff(path, commit) {
  const box = $("#govDiffBox");
  if (!box) return;
  box.innerHTML = `<div class="empty">读取 ${esc(commit)}…</div>`;
  try {
    const d = await api(`/api/governance/diff?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`);
    box.innerHTML = `<div class="diff-grid" style="margin-top:12px">
      <div><span class="diff-title">@${esc(commit)}</span><pre>${esc(d.atCommit || "(空)")}</pre></div>
      <div><span class="diff-title">CURRENT (HEAD)</span><pre>${esc(d.current || "(空)")}</pre></div>
    </div>`;
  } catch (e) { toast(e.message, true); }
}

async function govRollback(path, commit) {
  if (!await harbourConfirm(`${path} 将回滚到 ${commit}。`, {
    title: "回滚治理文件？", detail: "应用后会在主仓提交一条独立的回滚记录。", confirmLabel: "确认回滚", tone: "warning",
  })) return;
  try {
    await api("/api/governance/rollback", { method: "POST", body: JSON.stringify({ path, commit }) });
    toast(`已回滚 ${path} → ${commit}`);
    loadGovHistory();
  } catch (e) { toast(e.message, true); }
}

const GOVERNANCE_FILTERS = [
  { id: "pending", label: "待审批", hint: "先看差异；“批准并应用”可一步完成写入。" },
  { id: "approved", label: "待应用", hint: "已经批准、尚未写入磁盘的 proposal。" },
  { id: "applied", label: "已应用", hint: "已写入并留下治理与 Git 记录。" },
  { id: "rejected", label: "已拒绝", hint: "保留审计记录，但不会写入。" },
  { id: "all", label: "全部", hint: "按创建时间查看全部 proposal。" },
];

function governanceFilterMeta(id) {
  return GOVERNANCE_FILTERS.find((item) => item.id === id) || GOVERNANCE_FILTERS[0];
}

function captureGovernanceQueueState() {
  const list = $("#govList");
  if (!list) return;
  const filter = list.dataset.filter;
  if (filter) state.governance.scrollByFilter[filter] = list.scrollTop;
  list.querySelectorAll("details[data-proposal-id]").forEach((details) => {
    state.governance.openDiffs[details.dataset.proposalId] = details.open;
  });
}

function renderGovernanceQueue({ resetScroll = false, focusId = "" } = {}) {
  const tabs = $("#govStatusTabs");
  const list = $("#govList");
  const title = $("#govQueueTitle");
  const sub = $("#govQueueSub");
  const total = $("#govQueueTotal");
  if (!tabs || !list || !title || !sub || !total) return;

  captureGovernanceQueueState();
  const proposals = state.governance.proposals || [];
  const counts = proposals.reduce((acc, proposal) => {
    acc[proposal.status] = (acc[proposal.status] || 0) + 1;
    return acc;
  }, {});
  const filter = GOVERNANCE_FILTERS.some((item) => item.id === state.governance.filter)
    ? state.governance.filter
    : "pending";
  state.governance.filter = filter;
  const visible = filter === "all" ? proposals : proposals.filter((proposal) => proposal.status === filter);
  const meta = governanceFilterMeta(filter);

  tabs.innerHTML = GOVERNANCE_FILTERS.map((item) => {
    const count = item.id === "all" ? proposals.length : (counts[item.id] || 0);
    const active = item.id === filter;
    return `<button class="gov-status-tab status-${item.id}${active ? " active" : ""}" type="button"
      role="tab" aria-selected="${active}" data-gov-filter="${item.id}">
      <span>${item.label}</span><strong>${count}</strong>
    </button>`;
  }).join("");
  title.textContent = meta.label;
  sub.textContent = meta.hint;
  total.textContent = `${visible.length} 条`;
  list.dataset.filter = filter;
  list.innerHTML = visible.length
    ? visible.map((proposal) => proposalCard(proposal, !!state.governance.openDiffs[proposal.id])).join("")
    : `<div class="empty gov-empty">${filter === "pending"
      ? "没有待审批 proposal。新改动会先进入这里。"
      : filter === "approved"
        ? "没有待应用 proposal。你可以在“待审批”中直接批准并应用。"
        : `“${meta.label}”里暂时没有 proposal。`}</div>`;

  tabs.querySelectorAll("[data-gov-filter]").forEach((button) => {
    button.onclick = () => {
      if (button.dataset.govFilter === state.governance.filter) return;
      captureGovernanceQueueState();
      state.governance.filter = button.dataset.govFilter;
      renderGovernanceQueue();
    };
  });
  list.querySelectorAll("[data-gov-action]").forEach((button) => {
    button.onclick = () => governanceAction(button.dataset.id, button.dataset.govAction, button);
  });
  list.querySelectorAll("details[data-proposal-id]").forEach((details) => {
    details.ontoggle = () => {
      state.governance.openDiffs[details.dataset.proposalId] = details.open;
    };
  });
  list.onscroll = () => {
    state.governance.scrollByFilter[filter] = list.scrollTop;
  };

  requestAnimationFrame(() => {
    list.scrollTop = resetScroll ? 0 : (state.governance.scrollByFilter[filter] || 0);
    if (focusId) list.querySelector(`[data-proposal-card="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "nearest" });
  });
}

function proposalCard(p, diffOpen = false) {
  const beforeLen = p.beforeContent?.length || 0;
  const afterLen = p.afterContent?.length || 0;
  const statusLabel = governanceFilterMeta(p.status).label;
  const actions =
    p.status === "pending"
      ? `<button class="btn primary" data-gov-action="approve-apply" data-id="${esc(p.id)}">批准并应用</button>
         <button class="btn ghost" data-gov-action="approve" data-id="${esc(p.id)}">仅批准</button>
         <button class="btn danger ghost" data-gov-action="reject" data-id="${esc(p.id)}">拒绝</button>`
      : p.status === "approved"
        ? `<button class="btn primary" data-gov-action="apply" data-id="${esc(p.id)}">应用</button>
           <button class="btn danger ghost" data-gov-action="reject" data-id="${esc(p.id)}">拒绝</button>`
        : "";
  return `<article class="proposal" data-proposal-card="${esc(p.id)}">
    <div class="proposal-head">
      <div>
        <div class="row"><span class="badge status-${esc(p.status)}">${statusLabel}</span><span class="badge">${esc(p.targetType)} · ${esc(p.operation)}</span></div>
        <h3>${esc(p.targetPath)}</h3>
      </div>
      <div class="proposal-actions">${actions}</div>
    </div>
    <div class="muted proposal-meta">${esc(p.id)} · from ${esc(p.sourceAgent || "web")} · ${timeHtml(p.createdAt)}</div>
    <p>${esc(p.reason || "—")}</p>
    <details class="proposal-diff" data-proposal-id="${esc(p.id)}"${diffOpen ? " open" : ""}>
      <summary>DIFF PREVIEW · ${beforeLen} → ${afterLen} chars</summary>
      <div class="diff-grid">
        <div><span class="diff-title">BEFORE</span><pre>${esc(p.beforeContent || "")}</pre></div>
        <div><span class="diff-title">AFTER</span><pre>${esc(p.afterContent || "")}</pre></div>
      </div>
    </details>
  </article>`;
}

function formatDate(value) {
  return HarbourTime.format(value, "full");
}

// 表格用短日期：MM/DD HH:mm（避免 toLocaleString 的长串撑破单元格）。
function formatDateShort(value) {
  return HarbourTime.format(value, "short");
}

/** Timestamp-only DOM markers let a shared timezone update without reloading forms or chat. */
function timeHtml(value, style = "full", className = "") {
  return `<time class="${esc(className)}" data-harbour-time="${esc(value ?? "")}" data-time-style="${esc(style)}" title="${esc(formatDate(value))}">${esc(HarbourTime.format(value, style))}</time>`;
}

function timeTitleAttrs(value) {
  return `data-harbour-time-title="${esc(value ?? "")}" title="${esc(formatDate(value))}"`;
}

function refreshDisplayedTimes() {
  document.querySelectorAll("[data-harbour-time]").forEach((node) => {
    node.textContent = HarbourTime.format(node.dataset.harbourTime, node.dataset.timeStyle || "full");
    node.title = formatDate(node.dataset.harbourTime);
  });
  document.querySelectorAll("[data-harbour-time-title]").forEach((node) => { node.title = formatDate(node.dataset.harbourTimeTitle); });
  if (document.getElementById("chatCtx")) updateChatContextRing();
}

function initTimeDisplayObserver() {
  // Cached rich tooltips can be mounted after a timezone change. Refresh only timestamp
  // nodes in newly inserted subtrees, never rebuild their surrounding editor/chat DOM.
  const update = (node) => {
    if (node.nodeType !== 1) return;
    const targets = [...node.querySelectorAll("[data-harbour-time], [data-harbour-time-title]")];
    if (node.matches("[data-harbour-time], [data-harbour-time-title]")) targets.unshift(node);
    for (const target of targets) {
      const value = target.dataset.harbourTime ?? target.dataset.harbourTimeTitle;
      if (target.dataset.harbourTime !== undefined) {
        const text = HarbourTime.format(value, target.dataset.timeStyle || "full");
        if (target.textContent !== text) target.textContent = text;
      }
      const title = formatDate(value);
      if (target.title !== title) target.title = title;
    }
  };
  const observer = new MutationObserver((changes) => {
    for (const change of changes) for (const node of change.addedNodes) update(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function scheduleTimeZone(editing) {
  return editing ? editing.timeZone || timeSettingsState.current?.legacyScheduleTimeZone || HarbourTime.defaultTimeZone : HarbourTime.getTimeZone();
}

function scheduleTimeZoneOptions(selected) {
  const options = timeSettingsState.current?.options?.length ? timeSettingsState.current.options : HarbourTime.defaultOptions;
  const listed = options.some((option) => option.value === selected) ? options : [...options, { value: selected, label: selected }];
  return listed.map((option) => `<option value="${esc(option.value)}"${option.value === selected ? " selected" : ""}>${esc(option.label)}</option>`).join("");
}

const timeSettingsState = { current: null, revision: -1, loading: null, request: 0, saving: false, draft: null, error: "" };

function isTimeSettingsPayload(payload) {
  return !!payload && HarbourTime.validTimeZone(payload.timeZone) && Number.isSafeInteger(payload.revision) && payload.revision >= 0;
}

function applyTimeSettingsPayload(payload) {
  if (!isTimeSettingsPayload(payload)) return false;
  if (payload.revision < timeSettingsState.revision) return false;
  if (payload.revision === timeSettingsState.revision && timeSettingsState.current?.timeZone !== payload.timeZone) return false;
  const previous = timeSettingsState.current?.timeZone;
  timeSettingsState.current = { ...payload, options: Array.isArray(payload.options)
    ? payload.options.filter((option) => option && HarbourTime.validTimeZone(option.value) && typeof option.label === "string") : HarbourTime.defaultOptions };
  timeSettingsState.revision = payload.revision;
  timeSettingsState.error = "";
  if (timeSettingsState.draft === null || timeSettingsState.draft === previous) timeSettingsState.draft = payload.timeZone;
  HarbourTime.setTimeZone(payload.timeZone);
  refreshDisplayedTimes();
  syncTimeSettingsForm();
  return true;
}

function loadTimeSettings() {
  if (timeSettingsState.loading) return timeSettingsState.loading;
  const request = ++timeSettingsState.request;
  const pending = (async () => {
    try {
      const payload = await api("/api/time-settings");
      if (request === timeSettingsState.request) {
        if (!isTimeSettingsPayload(payload)) throw new Error("服务端未返回有效时区配置");
        applyTimeSettingsPayload(payload);
      }
    } catch (error) {
      // Static UI updates can reach an older backend. Never pretend a local fallback was saved.
      if (request === timeSettingsState.request) {
        const fallback = timeSettingsState.current ? "继续显示最近同步的时区" : "暂按纽约时间显示";
        timeSettingsState.error = error.status === 404
          ? `当前后端尚未提供时区设置接口。请重启或更新 Harbour 后端后，点击“重试连接”；仅刷新页面或重开 Electron 无法加载后端更新。${fallback}。`
          : `读取时区设置失败：${error.message || "连接不可用"}。${fallback}，可重试连接。`;
      }
    } finally {
      if (timeSettingsState.loading === pending) timeSettingsState.loading = null;
      syncTimeSettingsForm();
    }
  })();
  timeSettingsState.loading = pending;
  syncTimeSettingsForm();
  return pending;
}

async function saveTimeSettings() {
  if (timeSettingsState.saving || !timeSettingsState.current || !HarbourTime.validTimeZone(timeSettingsState.draft)) return;
  const selected = timeSettingsState.draft;
  if (selected === timeSettingsState.current.timeZone) return;
  timeSettingsState.saving = true;
  ++timeSettingsState.request; // A read begun before this save cannot overwrite its result.
  timeSettingsState.error = "";
  syncTimeSettingsForm();
  try {
    const payload = await api("/api/time-settings", { method: "PUT", body: JSON.stringify({ timeZone: selected }) });
    if (!isTimeSettingsPayload(payload)) throw new Error("服务端未返回有效时区配置");
    applyTimeSettingsPayload(payload);
    if (timeSettingsState.draft === selected) timeSettingsState.draft = timeSettingsState.current.timeZone;
    toast("统一时区已保存 · 已打开的客户端会同步；既有调度不变");
  } catch (error) {
    timeSettingsState.error = `保存失败：${error.message || "连接不可用"}。选择已保留，可重试。`;
  } finally {
    timeSettingsState.saving = false;
    syncTimeSettingsForm();
  }
}

function syncTimeSettingsForm() {
  const pane = document.getElementById("timeSettingsForm");
  if (!pane) return;
  const current = timeSettingsState.current;
  const zone = current?.timeZone || HarbourTime.defaultTimeZone;
  const options = current?.options?.length ? current.options : HarbourTime.defaultOptions;
  const select = pane.querySelector("#timeSettingsZone");
  const draft = timeSettingsState.draft || zone;
  const listed = options.some((option) => option.value === draft) ? options : [...options, { value: draft, label: draft }];
  const optionHtml = listed.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("");
  if (select._timeOptions !== optionHtml) { select.innerHTML = optionHtml; select._timeOptions = optionHtml; }
  select.value = draft;
  select.disabled = timeSettingsState.saving || !current;
  pane.querySelector("#timeSettingsSave").disabled = timeSettingsState.saving || !current || draft === zone;
  pane.querySelector("#timeSettingsSave").textContent = timeSettingsState.saving ? "保存中…" : "保存并同步";
  const retry = pane.querySelector("#timeSettingsRetry");
  if (retry) {
    retry.hidden = !!current && !timeSettingsState.error && !timeSettingsState.loading;
    retry.disabled = !!timeSettingsState.loading || timeSettingsState.saving;
    retry.textContent = timeSettingsState.loading ? "连接中…" : "重试连接";
  }
  pane.querySelector("#timeSettingsCurrent").textContent = zone;
  pane.querySelector("#timeSettingsLabel").textContent = options.find((option) => option.value === zone)?.label || zone;
  const legacy = pane.querySelector("#timeSettingsLegacy");
  if (legacy) legacy.textContent = current?.legacyScheduleTimeZone ? `旧 Heartbeat 默认执行时区：${current.legacyScheduleTimeZone}` : "旧调度沿用原执行时区";
  const status = pane.querySelector("#timeSettingsStatus");
  status.textContent = timeSettingsState.error || (draft !== zone ? "尚未保存 · 当前显示与调度均未改变" : current ? "已与 Harbour 同步 · 所有客户端共用此设置" : "正在读取服务端设置…");
  status.classList.toggle("is-error", !!timeSettingsState.error);
  syncTimeSettingsClock();
}

function syncTimeSettingsClock() {
  const clock = document.getElementById("timeSettingsNow");
  if (clock) { clock.textContent = formatDate(Date.now()); clock.title = HarbourTime.getTimeZone(); }
}
/** 相对时间：「刚刚 / N 分钟前 / N 小时前 / N 天前 / MM/DD」。版本历史里让人一眼知道「多久之前的版本」。 */
function timeAgo(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} 个月前`;
  return `${Math.floor(s / 86400 / 365)} 年前`;
}

// cron 串 → 人话（如 "0 9 * * *" → "每天 09:00"）。非标准/复杂表达式原样返回，交给下方小字附注。
const CRON_WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function humanizeCron(cron, every) {
  if (!cron) return every ? `每 ${every}` : "—";
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [mi, ho, dom, mo, dow] = parts;
  const isNum = (s) => /^\d+$/.test(s);
  const p2 = (n) => String(n).padStart(2, "0");
  const star = (s) => s === "*";
  // 每 N 分钟
  if (/^\*\/\d+$/.test(mi) && star(ho) && star(dom) && star(mo) && star(dow)) return `每 ${mi.slice(2)} 分钟`;
  // 每 N 小时（整点）
  if ((mi === "0" || mi === "*") && /^\*\/\d+$/.test(ho) && star(dom) && star(mo) && star(dow)) return `每 ${ho.slice(2)} 小时`;
  // 每小时的固定分
  if (isNum(mi) && star(ho) && star(dom) && star(mo) && star(dow)) return `每小时 ${p2(mi)} 分`;
  // 固定时刻
  if (isNum(mi) && isNum(ho)) {
    const t = `${p2(ho)}:${p2(mi)}`;
    if (star(dom) && star(mo) && star(dow)) return `每天 ${t}`;
    if (star(dom) && star(mo) && isNum(dow)) return `每${CRON_WD[Number(dow) % 7]} ${t}`;
    if (isNum(dom) && star(mo) && star(dow)) return `每月 ${dom} 号 ${t}`;
  }
  return cron;
}

function bindGovernance(root) {
  $("#govRefresh", root).addEventListener("click", refreshGovernanceQueue);
  $("#govType", root).addEventListener("change", updateGovTargetMode);
  $("#govLoadAgentFile", root).addEventListener("click", loadAgentFileForProposal);
  $("#govCreate", root).addEventListener("click", createGovernanceProposal);
  updateGovTargetMode();
}

async function refreshGovernanceQueue() {
  const button = $("#govRefresh");
  if (!button || button.disabled) return;
  captureGovernanceQueueState();
  button.disabled = true;
  button.textContent = "REFRESHING…";
  try {
    const { proposals } = await api("/api/governance");
    state.governance.proposals = proposals;
    renderGovernanceQueue();
    toast("Governance 队列已刷新");
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "REFRESH";
  }
}

function updateGovTargetMode() {
  const isAgent = $("#govType")?.value === "agent";
  $("#govMemoryFields").hidden = isAgent;
  $("#govAgentFields").hidden = !isAgent;
}

async function loadAgentFileForProposal() {
  const agent = $("#govAgent").value;
  const file = $("#govAgentFile").value;
  try {
    const { files } = await api(`/api/agent-files/${encodeURIComponent(agent)}`);
    $("#govContent").value = (files || []).find((f) => f.file === file)?.content || "";
    $("#govReason").value = `edit ${agent}/${file}`;
    toast(`已加载 ${agent}/${file}`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function createGovernanceProposal() {
  const type = $("#govType").value;
  const content = $("#govContent").value;
  const reason = $("#govReason").value.trim() || "web governance proposal";
  try {
    let result;
    if (type === "agent") {
      const agent = $("#govAgent").value;
      const file = $("#govAgentFile").value;
      result = await api(`/api/agent-files/${encodeURIComponent(agent)}`, {
        method: "POST",
        body: JSON.stringify({ file, content, reason }),
      });
    } else {
      const targetPath = $("#govMemoryPath").value.trim();
      const normalizedPath = targetPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/?assets\/Memory\/?/i, "");
      if (normalizedPath.toLowerCase() === "index.md") {
        $("#govMemoryPath").focus();
        throw new Error("根 index.md 是固定全局入口；请提交具体知识页，子目录索引会在应用后自动更新");
      }
      result = await api("/api/governance/proposals", {
        method: "POST",
        body: JSON.stringify({
          targetType: "memory",
          targetPath,
          operation: $("#govOperation").value,
          content,
          reason,
          sourceAgent: "web",
        }),
      });
    }
    if (result?.proposal) {
      state.governance.proposals = [
        result.proposal,
        ...state.governance.proposals.filter((proposal) => proposal.id !== result.proposal.id),
      ];
      state.governance.filter = "pending";
      state.governance.scrollByFilter.pending = 0;
      renderGovernanceQueue({ resetScroll: true, focusId: result.proposal.id });
    }
    toast("proposal 已创建，等待审批");
  } catch (e) {
    toast(e.message, true);
  }
}

async function governanceAction(id, action, trigger) {
  if (!id || !action || state.governance.busyId) return;
  captureGovernanceQueueState();
  state.governance.busyId = id;
  const card = trigger?.closest("[data-proposal-card]");
  if (card) {
    card.classList.add("is-busy");
    card.setAttribute("aria-busy", "true");
    card.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  }
  if (trigger) trigger.textContent = "处理中…";

  const post = (nextAction) => api(
    `/api/governance/proposals/${encodeURIComponent(id)}/${nextAction}`,
    { method: "POST", body: "{}" }
  );
  let response;
  try {
    if (action === "approve-apply") {
      const approved = await post("approve");
      state.governance.proposals = approved.proposals || state.governance.proposals;
      try {
        response = await post("apply");
      } catch (e) {
        toast(`已批准，但应用失败：${e.message}`, true);
        return;
      }
    } else {
      response = await post(action);
    }
    state.governance.proposals = response.proposals || state.governance.proposals;
    const indexNote = response.memoryIndexRebuild === "failed"
      ? "；Memory 子目录索引重建失败，请运行 npm run index"
      : response.memoryIndexesChanged?.length
        ? `；已更新 ${response.memoryIndexesChanged.length} 个子目录索引`
        : "";
    const message = action === "approve-apply"
      ? `已批准并应用${indexNote}`
      : action === "approve"
        ? "已批准，已移入“待应用”"
        : action === "apply"
          ? `已应用${indexNote}`
          : "已拒绝";
    toast(message, response.memoryIndexRebuild === "failed");
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.governance.busyId = "";
    renderGovernanceQueue();
  }
}

// 把一条 WS loop 日志归一成 trace 视图事件 {cls, tag, text}；非 loop 事件返回 null。
function isCoworkTraceEvent(obj) {
  return /^cowork:(?:tool:(?:start|progress|complete|failed|reconnecting)|reconnecting)$/.test(String(obj?.msg || ""));
}

function normalizeTraceEvent(obj) {
  const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
  if (obj.msg === "progress:updated" && obj.progress) return { cls: "call", tag: "TODO", text: clip(obj.progress.title, 160), progress: obj.progress };
  if (obj.msg === "plan:submitted" && obj.plan) return { cls: "call", tag: "PLAN", text: clip(obj.plan.goal, 160), plan: obj.plan };
  if (obj.msg === "loop:end") return { cls: obj.status === "failed" ? "fallback" : "final", tag: "END", text: ({ completed: "本轮已结束", failed: "运行失败", interrupted: "已中止", incomplete: "本轮结束，任务未完成" })[obj.status] || "本轮结束" };
  if (obj.msg === "loop:step-continuation") return { cls: "turn", tag: "CONTINUE", text: `原网页任务继续 · 第 ${obj.segments}/${obj.maxSegments} 段；保留页面、进度与累计用量` };
  if (/^workflow:(loaded|start|result|progress|error)$/.test(obj.msg || "")) {
    const phase = ({ loaded: "读取", start: "执行", result: "回执", progress: "进度", error: "失败" })[obj.msg.split(":")[1]];
    return { cls: obj.msg === "workflow:error" ? "fallback" : "call", tag: "WORKFLOW",
      text: `${obj.workflow} · ${phase}${obj.action ? ` ${obj.action}` : ""}${obj.status ? ` · ${obj.status}` : ""}${Number.isFinite(obj.completed) && Number.isFinite(obj.total) ? ` · ${obj.completed}/${obj.total}` : ""}` };
  }
  if (isCoworkTraceEvent(obj)) {
    const phase = obj.msg.split(":").pop();
    const labels = { start: "开始", progress: "执行中", complete: "完成", failed: "失败", reconnecting: "等待设备重连" };
    const detail = obj.error || obj.err || obj.message || obj.preview || obj.detail || "";
    return {
      cls: phase === "failed" || phase === "reconnecting" ? "fallback" : phase === "complete" ? "result" : "call",
      tag: "COWORK", deviceId: obj.deviceId, deviceLabel: obj.deviceLabel, runId: obj.runId, op: obj.op,
      text: `${clip(obj.deviceLabel || obj.deviceId || "目标设备", 60)} · ${clip(obj.op || "工具", 45)} · ${labels[phase]}${detail ? ` · ${clip(detail, 130)}` : ""}`,
    };
  }
  if (obj.msg === "stt:native") return {
    cls: "stt", tag: "STT",
    text: `复用平台转写 · ${obj.provider || "native"}${obj.preview ? ` · ${clip(obj.preview, 120)}` : ""}`,
  };
  if (obj.msg === "stt:complete") return {
    cls: "stt", tag: "STT",
    text: `${obj.provider || "remote"} · ${formatRunDuration(Number(obj.processingMs) || 0)}${obj.preview ? ` · ${clip(obj.preview, 120)}` : ""}`,
  };
  if (obj.msg === "stt:failed") return {
    cls: "fallback", tag: "STT",
    text: `转写失败${obj.attachment ? ` · ${clip(obj.attachment, 36)}` : ""}${obj.err ? `：${clip(obj.err, 120)}` : ""}`,
  };
  if (obj.msg === "loop:reconnecting") {
    const endpoint = obj.transport === "websocket" ? "Codex WebSocket" : "模型接口";
    const status = obj.errorStatus == null ? `${endpoint} 超时/断开` : `${endpoint} · HTTP ${obj.errorStatus}`;
    const delay = Number(obj.retryDelayMs) > 0 ? ` · ${Math.ceil(Number(obj.retryDelayMs) / 1000)}s 后重试` : "";
    return {
      cls: "fallback", tag: "RECONNECT",
      text: `${status} · 第 ${obj.attempt || "?"}/${obj.maxRetries || "?"} 次${delay}`,
    };
  }
  if (obj.msg === "loop:transport-fallback") return {
    cls: "fallback", tag: "HTTPS",
    text: "Codex WebSocket 多次失败，已自动切换 HTTPS；本轮仍在继续。",
  };
  if (obj.msg === "loop:reconnected") {
    const via = obj.transport === "https" ? "（HTTPS）" : "";
    return { cls: "final", tag: "ONLINE", text: `模型接口连接已恢复${via}，继续执行。` };
  }
  if (obj.msg === "loop:interrupted") return {
    cls: obj.aborted ? "fallback" : "fallback",
    tag: obj.aborted ? "STOP" : "ERROR",
    text: clip(obj.reason || "运行在完成前中断，进度已保存。", 180),
  };
  if (obj.msg === "loop:turn") return { cls: "turn", tag: `TURN ${obj.step}`, text: `${obj.native ? "本轮新增上下文" : "注入"} ${obj.injectedTokens} tok / 裁 ${obj.trimmedTokens}` };
  if (obj.msg === "loop:native-session") return { cls: "turn", tag: "RESUME", text: ({ resumed: "已续接原生会话 · 保留已保存的对话与工具记录", created: "已建立原生会话", rebuilt: "原生记录不可用或配置变化 · 从 Harbour 记录重建" })[obj.mode] || "正在核对原生会话" };
  if (obj.msg === "loop:native-session-wait") return { cls: "turn", tag: obj.state === "waiting" ? "WAIT" : obj.state === "cancelled" ? "STOP" : "READY", text: ({ waiting: "等待同一原生会话的上一轮释放 · 尚未向模型发送本次请求", acquired: "会话等待结束 · 正在继续本轮", cancelled: "已取消会话等待 · 本次请求未发送" })[obj.state] || "正在核对会话执行位置" };
  if (obj.msg === "loop:native-session-reset" || obj.msg === "sdk:native-session-missing-rebuild") return { cls: "compact", tag: "REBUILD", text: "原生会话记录不可用 · 使用 Harbour 历史与执行记录重建" };
  if (obj.msg === "loop:native-compact") return { cls: "compact", tag: "COMPACT", text: obj.stage === "started" ? "正在压缩原生会话…" : "原生会话已压缩" };
  if (obj.msg === "loop:tool-calls") {
    // read_skill 有更清楚的 skill:loaded 语义事件；别再画一条“调用 read_skill”制造重复加载错觉。
    const calls = (obj.calls || []).filter((name) => !["read_skill", "update_progress", "submit_plan"].includes(name));
    return calls.length ? { cls: "call", tag: `STEP ${obj.step}`, text: `→ 调用 ${calls.join(", ")}` } : null;
  }
  if (obj.msg === "loop:tool-result") {
    // 成功结果已由 skill:loaded 展示；错误仍保留，避免把加载失败静默吞掉。
    if (obj.tool === "read_skill" && !/error|失败|无法读取/i.test(String(obj.resultPreview || ""))) return null;
    if (["update_progress", "submit_plan"].includes(obj.tool) && !/error|失败/i.test(String(obj.resultPreview || ""))) return null;
    return { cls: "result", tag: clip(obj.tool || "tool", 28), tool: String(obj.tool || "tool"), text: `← ${clip(obj.resultPreview, 160)}` };
  }
  if (obj.msg === "skill:loaded") return {
    cls: "call",
    tag: "SKILL",
    text: obj.resource && obj.resource !== "SKILL.md"
      ? `读取 ${obj.skill} · ${obj.resource.replace(/^references\//, "参考/")}`
      : `载入 ${obj.skill} · 主流程`,
  };
  // 思考过程（K2.7 等带 thinking 的模型）：实时把每段思考画进 trace。
  if (obj.msg === "loop:thinking") return { cls: "thinking", tag: "THINK", text: clip(obj.preview, 160) };
  // 跨端点 fallback：主端点失败 → 切到哪个后端/模型（isLast=全部失败）。
  if (obj.msg === "loop:fallback") {
    // 只显示「A ↳ B」等于让人猜为什么切了。把原因浓缩成一句挂上去 ——
    // 额度耗尽 / 限流 / 鉴权失败 是完全不同的处置，必须一眼可辨（用户 2026-07-22）。
    const raw = String(obj.err || "");
    const why = /usage limit|quota/i.test(raw) ? "额度已用尽"
      : /rate.?limit|429/i.test(raw) ? "被限流"
      : /authenticate|401|403/i.test(raw) ? "鉴权失败"
      : /timeout|ETIMEDOUT/i.test(raw) ? "超时"
      : raw ? raw.slice(0, 40) : "";
    return {
      cls: "fallback", tag: "FALLBACK",
      text: obj.isLast ? `✖ 全部端点失败（${obj.from}）${why ? "：" + why : ""}`
                       : `${obj.from} ↳ ${obj.to}${why ? "（因：" + why + "）" : ""}`,
    };
  }
  // 会话压缩：早前对话被摘要收拢（before→after token，丢 N 留 M）。
  if (obj.msg === "loop:sdk-compact") return { cls: "compact", tag: "COMPACT", text: obj.stage === "started" ? "🗜 SDK 正在压缩本轮工具上下文…" : `🗜 SDK 本轮上下文已压缩${Number.isFinite(obj.before) ? ` · ${obj.before}${Number.isFinite(obj.after) ? `→${obj.after}` : ""} tok` : ""}` };
  if (obj.msg === "loop:compact") return { cls: "compact", tag: "COMPACT", text: `🗜 ${obj.before}→${obj.after} tok（丢 ${obj.dropped} 留 ${obj.kept}）` };
  if (obj.msg === "loop:start") return { cls: "turn", tag: "START", text: `${obj.modelRef || ""} · 已挂载 ${(obj.tools || []).length} 工具` };
  if (obj.msg === "loop:final") return { cls: "final", tag: "FINAL", text: clip(obj.answerPreview || "(收尾)", 160) };
  return null;
}

/**
 * 后端为 QQ/DC/Web 统一保存的是带 agent/run 关联的原始 loop 事件；旧 Web 会话保存的则已经
 * 是 {cls,tag,text}。这里同时兼容两种格式，并按 spawn 顺序重建子 agent 缩进。
 */
function appendRoutedTrace(target, subagents, obj, mainAgent) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.cls && obj.tag) {
    const ready = { ...obj, ...(obj.at != null || obj.time != null || obj.t != null ? { at: obj.at ?? obj.time ?? obj.t } : {}) };
    if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.append(target, ready); else target.push(ready);
    return ready;
  }
  if (obj.msg === "spawn_subagent" && obj.to) {
    // 长 trace 持久化时会保留尾部，最早的父级 spawn 事件可能已被容量上限裁掉。
    // 同一 runId 已经是强关联边界，未知 from 仍必然属于这棵运行树：把它恢复为一级
    // 子 Agent，再让当前 to 落到下一层，不能因此吞掉后续整段 trace。
    const fromDepth = obj.from === mainAgent ? 0 : (subagents[obj.from] ?? 1);
    if (obj.from && obj.from !== mainAgent && subagents[obj.from] == null) subagents[obj.from] = fromDepth;
    subagents[obj.to] = fromDepth + 1;
    const spawned = { cls: "call", tag: "SPAWN", text: `派子 agent：${obj.to}`, agent: obj.from, depth: fromDepth,
      msg: obj.msg, to: obj.to, traceId: obj.traceId, parentTraceId: obj.parentTraceId,
      ...(obj.at != null || obj.time != null || obj.t != null ? { at: obj.at ?? obj.time ?? obj.t } : {}) };
    if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.append(target, spawned); else target.push(spawned);
    return spawned;
  }
  const agent = obj.agent || (isCoworkTraceEvent(obj) ? mainAgent : "");
  const isMain = agent === mainAgent;
  let subDepth = subagents[agent];
  // 同上：若父级 spawn 已从持久 trace 的头部被裁掉，按一级子 Agent 恢复。
  // runId 相关性已经排除了其它并发任务，不能沿用旧逻辑把这些事件静默丢弃。
  if (!isMain && subDepth == null && agent) {
    subDepth = 1;
    subagents[agent] = subDepth;
  }
  if (!isMain && subDepth == null) return null;
  const ev = normalizeTraceEvent(obj);
  if (!ev) return null;
  ev.agent = agent;
  ev.depth = isMain ? 0 : subDepth;
  for (const key of ["msg", "traceId", "parentTraceId", "status", "workflow", "skill", "jobId", "action", "completed", "total", "aborted"]) if (obj[key] !== undefined) ev[key] = obj[key];
  if (obj.at != null || obj.time != null || obj.t != null) ev.at = obj.at ?? obj.time ?? obj.t;
  if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.append(target, ev); else target.push(ev);
  return ev;
}

function normalizeStoredTrace(events, mainAgent) {
  const out = [];
  const subagents = {};
  for (const event of events || []) appendRoutedTrace(out, subagents, event, mainAgent);
  return out;
}

// trace 事件 → 行 HTML（内联在对话里）：按 depth 缩进，子 agent 事件前标 ↳agent。
function traceRowsHtml(events) {
  return (events || []).map((e) => {
    const indent = (e.depth || 0) * 14;
    const sub = (e.depth || 0) > 0 ? `<span class="ct-sub">↳${esc(e.agent || "")}</span>` : "";
    return `<div class="ct-ev ct-${e.cls}" style="padding-left:${indent}px">${e.at != null ? timeHtml(e.at, "time", "ct-time") : ""}${sub}<span class="ct-tag">${esc(e.tag)}</span><span class="ct-txt">${esc(e.text)}</span></div>`;
  }).join("");
}

/**
 * 增量刷新实时 trace，并保住用户的阅读位置：
 * - 原本贴底时继续跟随最新事件；
 * - 用户已经上翻时保持 scrollTop，不抢回底部；
 * - 只有内容真的变化才重建 DOM，500ms 的运行计时刷新不再破坏滚动。
 */
function syncLiveTraceRows(el, events) {
  if (!el) return false;
  if (window.HarbourTrace) return window.HarbourTrace.mount(el, events || [], { agent: el.dataset.traceAgent, live: true, rowsHtml: traceRowsHtml });
  const list = events || [];
  const first = list[0] || {};
  const last = list[list.length - 1] || {};
  const signature = `${list.length}|${first.tag || ""}|${first.text || ""}|${last.tag || ""}|${last.text || ""}`;
  if (el._traceSignature === signature) return false;
  const firstPaint = el._traceSignature == null;
  const followLatest = firstPaint || el.scrollHeight - el.scrollTop - el.clientHeight < 36;
  const previousTop = el.scrollTop;
  el.innerHTML = traceRowsHtml(list);
  el._traceSignature = signature;
  el.scrollTop = followLatest ? el.scrollHeight : previousTop;
  return true;
}

// 实时把 trace 刷进 pending 气泡里的内联轨迹区（不整段重绘，避免打断输入/滚动）。
function updatePendingTrace() {
  if (document.hidden || window.HarbourVisualActivity?.isActive() === false || state.chat.inspection) return;
  const el = $("#pendingTrace");
  if (!el) return;
  const stream = $("#chatStream");
  const followStream = !!stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  const changed = syncLiveTraceRows(el, state.chat.trace);
  if (changed && followStream) stream.scrollTop = stream.scrollHeight;
}

function channelStopButtonHtml(runId) {
  const run = state.chat.channelRuns[runId];
  if (!run?.sessionId || (!run.canStop && !run.stopping)) return "";
  const stopping = run.stopping || run.stopPending;
  return `<button type="button" class="channel-stop-btn" data-channel-stop="${esc(run.id)}" data-stop-session="${esc(run.sessionId)}"
    ${stopping ? "disabled" : ""} title="中止这条任务及其子任务，保留断点；若有 GOAL 则暂停自动续轮"
    aria-label="${stopping ? "正在中止渠道任务" : "中止这条渠道任务"}"><span aria-hidden="true">■</span> ${stopping ? "正在中止…" : "中止"}</button>`;
}

async function stopChannelRun(runId, sessionId) {
  const run = state.chat.channelRuns[runId];
  // Never borrow the local Web abort handle or fall back to the selected agent/session.
  if (!run?.canStop || run.sessionId !== sessionId || run.sessionId !== viewedChatSessionId() || run.stopPending || run.stopping) return;
  if (run.localChat?.running) return stopLocalChatRun(run.localChat);
  run.stopPending = true;
  renderSelectedChannelRuns();
  try {
    const endpoint = run.source?.platform === 'web' ? 'runs' : 'channel-runs';
    const receipt = await api(`/api/${endpoint}/${encodeURIComponent(runId)}/abort`, {
      method: "POST", body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(15_000),
    });
    if (receipt.status !== "stopping" || receipt.runId !== runId || receipt.sessionId !== sessionId) throw new Error("中止回执不匹配，请刷新连接后重试");
    // The terminal WS event can arrive before this HTTP acknowledgement.
    if (state.chat.channelRuns[runId] !== run) return;
    run.stopping = true;
    run.activity = "正在中止并保存断点…";
  } catch (error) {
    if (state.chat.channelRuns[runId] !== run) return;
    if (error.status === 404 && error.code === "RUN_NOT_ACTIVE") {
      handleChannelActivity({ runId, phase: "complete" });
      if (sessionId === viewedChatSessionId()) toast("该任务已结束，正在刷新会话记录。", "info");
      return;
    }
    // A lost response is not proof of failure. Keep the exact handle for a safe retry.
    if (!run.stopping) run.activity = "中止尚未确认，可重试中止；不会重新执行任务。";
    toast(`渠道任务中止${run.stopping ? "已由服务端确认" : "尚未确认"}：${error.message}`, "warn");
  } finally {
    if (state.chat.channelRuns[runId] === run) {
      run.stopPending = false;
      if (run.sessionId === viewedChatSessionId()) renderSelectedChannelRuns();
    }
  }
}

function channelRunMessages(sessionId) {
  const messages = [];
  if (!sessionId) return messages;
  const runs = Object.values(state.chat.channelRuns || {})
    .filter((run) => run.sessionId === sessionId && ["incoming", "running", "stopping"].includes(run.phase))
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const run of runs) {
    const source = run.source || {};
    messages.push({
      role: "user",
      content: run.input || run.task || "（渠道消息）",
      ...(Array.isArray(run.attachments) && run.attachments.length ? { attachments: run.attachments } : {}),
      at: new Date(run.startedAt).toISOString(),
      actor: {
        role: source.actorRole || "owner",
        platform: source.platform || "external",
        id: source.authorId || "external",
        ...(source.authorName ? { displayName: source.authorName } : {}),
      },
      externalEphemeral: true,
      externalRunId: run.id,
    });
    messages.push({
      role: "assistant",
      content: "",
      pending: true,
      activity: run.activity || (run.phase === "incoming" ? "已收到，等待执行…" : "思考中…"),
      agent: run.agent,
      trace: run.trace,
      runStartedAt: run.startedAt,
      externalEphemeral: true,
      externalRunId: run.id,
    });
  }
  return messages;
}

function overlaySelectedChannelRuns(sessionId = state.chat.sessionId) {
  // 本页正在收尾的 pending 由 fetch 独占；同会话其它客户端的排队气泡不能抢走 last-message。
  if (state.chat.running && sessionId === state.chat.sessionId) return;
  state.chat.messages = [...state.chat.messages.filter((message) => !message.externalEphemeral), ...channelRunMessages(sessionId)];
}

function renderSelectedChannelRuns() {
  if (!state.chat.inspection) overlaySelectedChannelRuns();
  renderChatMessages();
}

function updateChannelRunDom(run, { clockOnly = false } = {}) {
  if (document.hidden || window.HarbourVisualActivity?.isActive() === false || !run || run.sessionId !== viewedChatSessionId()) return;
  const id = CSS.escape(run.id);
  const stream = $("#chatStream");
  const followStream = !clockOnly && !!stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  const traceEl = document.querySelector(`[data-channel-trace="${id}"]`);
  const traceChanged = !clockOnly && syncLiveTraceRows(traceEl, run.trace);
  const activityEl = document.querySelector(`[data-channel-activity="${id}"]`);
  const activity = run.activity || "思考中…";
  if (activityEl && activityEl.textContent !== activity) activityEl.textContent = activity;
  const durationEl = document.querySelector(`[data-channel-duration="${id}"]`);
  const duration = formatRunDuration(Date.now() - run.startedAt, true);
  if (durationEl?.lastChild && durationEl.lastChild.textContent !== duration) durationEl.lastChild.textContent = duration;
  // interval 每 500ms 仍可更新计时，但只有新增 trace 且用户原本贴底时才移动外层消息流。
  if (traceChanged && followStream) stream.scrollTop = stream.scrollHeight;
}

function handleChannelActivity(obj) {
  const runId = String(obj.runId || "");
  if (!runId) return;
  const platform = String(obj.source?.platform || "");
  // 同会话也可能被另一客户端使用。只认本页提交的 runId，绝不能按 sessionId 抢占停止句柄。
  if (state.chat.running && runId === state.chat.activeRunId) {
    if (obj.phase === "incoming" || obj.phase === "running") {
      // 权威 activity 证明本轮仍在后端执行：取消重连快照建立的“缺失 run”观察期。
      if (state.chat.missingRunTimer) {
        clearTimeout(state.chat.missingRunTimer);
        state.chat.missingRunTimer = null;
      }
    }
    // 保留关联直到 HTTP 收尾，避免 complete 与最终 trace 之间出现无 runId 的窗口。
    return;
  }
  if (!platform && !state.chat.channelRuns[runId]) return;

  if (obj.phase === "incoming" || obj.phase === "running" || obj.phase === "stopping") {
    const run = state.chat.channelRuns[runId] || {
      id: runId,
      agent: obj.agent,
      sessionId: obj.sessionId,
      sessionKey: obj.sessionKey,
      source: obj.source || {},
      task: obj.task || "",
      input: obj.input || obj.task || "",
      attachments: Array.isArray(obj.attachments) ? obj.attachments : [],
      trace: [],
      subagents: {},
      startedAt: Number.isFinite(Number(obj.startedAt)) ? Number(obj.startedAt) : Date.now(),
      activity: "",
    };
    run.phase = obj.phase;
    run.canStop = obj.canStop === true;
    if (obj.phase === "stopping") run.stopping = true;
    if (run.stopping) run.activity = "正在中止并保存断点…";
    else if (obj.detail) run.activity = String(obj.detail);
    run.agent = obj.agent || run.agent;
    run.sessionId = obj.sessionId || run.sessionId;
    run.sessionKey = obj.sessionKey || run.sessionKey;
    run.source = obj.source || run.source;
    run.input = obj.input || run.input || obj.task || "";
    if (Number.isFinite(Number(obj.startedAt))) run.startedAt = Number(obj.startedAt);
    if (Array.isArray(obj.attachments)) run.attachments = obj.attachments;
    run.task = obj.task || run.task;
    state.chat.channelRuns[runId] = run;
    if (run.sessionId === state.chat.sessionId) {
      state.chat.intakeRunning = true;
      syncChatControlLocks(); setChatSendMode(state.chat.running);
    }
    if (run.sessionId === viewedChatSessionId()) renderSelectedChannelRuns();
    return;
  }

  const run = state.chat.channelRuns[runId];
  // A detached local observer still owns the final receipt. Keep its correlation
  // through terminal WS / final trace ordering, just like the foreground run.
  if (run?.localChat?.running) {
    run.activity = '正在同步已保存结果…';
    updateChannelRunDom(run);
    return;
  }
  const selected = !!run && run.sessionId === viewedChatSessionId();
  delete state.chat.channelRuns[runId];
  if (selected && run?.sessionId) {
    if (run.sessionId === state.chat.sessionId && !state.chat.running) {
      state.chat.intakeRunning = Object.values(state.chat.channelRuns || {}).some(item => item.sessionId === run.sessionId);
      syncChatControlLocks(); setChatSendMode(false);
      window.HarbourChatIntake?.refresh?.();
    }
    if (state.chat.inspection) void inspectChatSession(run.sessionId, true);
    else if (!state.chat.running) void loadConversationMessages(run.sessionId);
    else renderSelectedChannelRuns();
  }
}

// 由 WS 调用：把当前运行(含其派出的子 agent)的 loop 事件画进本轮 trace 缓冲。
function pushTraceEvent(obj) {
  // 设备工具可能不带 agent；唯一可靠关联是 runId，绝不把其它设备任务挂到当前气泡。
  if (isCoworkTraceEvent(obj) && (!obj.runId || (!state.chat.channelRuns[String(obj.runId)] && String(obj.runId) !== state.chat.activeRunId))) return;
  const channelRun = obj.runId ? state.chat.channelRuns[String(obj.runId)] : null;
  if (channelRun) {
    if (obj.msg === "plan:submitted" && obj.plan) {
      if (channelRun.localChat) channelRun.localChat.plan = obj.plan;
      if (channelRun.sessionId === state.chat.sessionId && !state.chat.running) {
        state.chat.plan = obj.plan;
        state.chat.planDone = {};
        renderChatPlan();
      }
      if (channelRun.sessionId) {
        api(`/api/conversations/annotate`, {
          method: "POST",
          body: JSON.stringify({ key: channelRun.sessionKey, id: channelRun.sessionId, plan: obj.plan }),
        }).catch(() => {});
      }
      obj = { ...obj, agent: obj.agent || channelRun.agent };
    }
    const ev = appendRoutedTrace(channelRun.trace, channelRun.subagents, obj, channelRun.agent);
    if (!ev) return;
    if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.trim(channelRun.trace);
    else if (channelRun.trace.length > 400) channelRun.trace.shift();
    if (!channelRun.stopping && !channelRun.stopPending) channelRun.activity = `${ev.tag} · ${ev.text}`.slice(0, 90);
    updateChannelRunDom(channelRun);
    if (obj.plan || obj.progress) renderChatPlan();
    return;
  }
  // 同一个 Main 可同时服务 Web、QQ、DC。带 runId 的日志只准进入对应那一轮，不能再靠 agent 名猜。
  if (!state.chat.running || !state.chat.activeRunId || String(obj.runId || "") !== state.chat.activeRunId) return;
  /* orchestrator 交回的结构化执行计划 → 渲染成可视 todo（悬停看细节）。走既有 trace 日志管道。
     ⚠️ 必须放在 running 守卫【之前】：计划是本轮的持久产物、不是瞬时 trace 事件。
     子 agent 提交计划的时刻主 loop 未必还标着 running（实测就漏在这儿——浏览器确实收到了
     事件，却被守卫挡掉），漏掉就整张卡片都不出现。 */
  if (obj.msg === "plan:submitted" && obj.plan) {
    state.chat.plan = obj.plan;
    state.chat.planDone = state.chat.planDone || {};
    renderChatPlan();
    // 立刻落盘 plan（切会话/刷新后仍在）。plan 不挂在某条消息上，随到随存即可。
    if (state.chat.sessionId) {
      api(`/api/conversations/annotate`, { method: "POST", body: JSON.stringify({ key: state.chat.sessionKey, id: state.chat.sessionId, plan: obj.plan }) }).catch(() => {});
    }
    obj = { ...obj, agent: obj.agent || state.runningAgent };
  }
  if (!state.chat.running) return;
  // 派发只建立执行线，不根据 agent 名猜测待办完成状态。
  // spawn_subagent：记录 from→to 的深度并画一条 SPAWN 行（子 agent 后续事件据此缩进嵌套）。
  if (obj.msg === "spawn_subagent" && obj.to) {
    const fromDepth = obj.from === state.runningAgent ? 0 : (state.chat.subagents[obj.from] ?? 0);
    state.chat.subagents[obj.to] = fromDepth + 1;
    const spawned = { cls: "call", tag: "SPAWN", text: `派子 agent：${obj.to}`, agent: obj.from, depth: fromDepth,
      msg: obj.msg, to: obj.to, traceId: obj.traceId, parentTraceId: obj.parentTraceId,
      ...(obj.at != null || obj.time != null || obj.t != null ? { at: obj.at ?? obj.time ?? obj.t } : {}) };
    if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.append(state.chat.trace, spawned);
    else state.chat.trace.push(spawned);
    updatePendingTrace();
    return;
  }
  const agent = obj.agent || (isCoworkTraceEvent(obj) ? state.runningAgent : "");
  const isMain = agent === state.runningAgent;
  // runId already isolates this task; reconnect replay may have lost the original spawn.
  const subDepth = state.chat.subagents[agent] ?? (agent ? 1 : undefined);
  if (!isMain && subDepth == null) return;
  const ev = normalizeTraceEvent(obj);
  if (!ev) return;
  ev.agent = agent;
  ev.depth = isMain ? 0 : subDepth;
  for (const key of ["msg", "traceId", "parentTraceId", "status", "workflow", "skill", "jobId", "action", "completed", "total", "aborted"]) if (obj[key] !== undefined) ev[key] = obj[key];
  if (obj.at != null || obj.time != null || obj.t != null) ev.at = obj.at ?? obj.time ?? obj.t;
  if (typeof window !== "undefined" && window.HarbourTrace) window.HarbourTrace.append(state.chat.trace, ev);
  else { state.chat.trace.push(ev); if (state.chat.trace.length > 400) state.chat.trace.shift(); }
  const last = state.chat.messages[state.chat.messages.length - 1];
  if (last && last.pending) { last.activity = `${ev.tag} · ${ev.text}`.slice(0, 90); updatePendingActivity(); }
  updatePendingTrace();
  if (obj.plan || obj.progress) renderChatPlan();
}

// 只更新 pending 气泡里的活动指示，不整段重绘（避免打断输入/滚动）。
function updatePendingActivity() {
  if (document.hidden || window.HarbourVisualActivity?.isActive() === false || state.chat.inspection) return;
  const el = $("#pendingActivity");
  const last = state.chat.messages[state.chat.messages.length - 1];
  const activity = last?.activity || "思考中…";
  if (el && last && last.pending && el.textContent !== activity) el.textContent = activity;
}

function updatePendingDuration(message) {
  if (document.hidden || window.HarbourVisualActivity?.isActive() === false || state.chat.inspection) return;
  const el = $("#pendingDuration");
  if (!el || !Number.isFinite(message?.runStartedAt)) return;
  const endedAt = Number.isFinite(message.runEndedAt) ? message.runEndedAt : Date.now();
  const duration = formatRunDuration(Math.max(0, endedAt - message.runStartedAt), !message.runEndedAt);
  if (el.lastChild.textContent !== duration) el.lastChild.textContent = duration;
}

// router / queue / backends 面板已移除（router/backends 折叠进 Settings；queue 仅作后台机制 + Dashboard 数字）。

/* ── HEARTBEAT（独立 tab）：各 agent HEARTBEAT.md 驱动的低上下文自检 ── */
PANELS.heartbeat = {
  id: "heartbeat",
  async render(root) {
    const hb = await api("/api/heartbeat");
    const tasks = hb.tasks || [];
    const rows = tasks.length
      ? tasks.map((t) => `<tr>
          <td>${esc(t.agent)}</td>
          <td><span class="badge tt-${esc(t.taskType)}">${esc(t.taskType)}</span></td>
          <td class="sched-cell"><span class="sched-h">${esc(humanizeCron(t.cron, t.every))}</span>${t.cron ? `<span class="sched-raw mono">${esc(t.cron)}</span><span class="sched-zone">执行 · ${esc(scheduleTimeZone(t))}</span>` : ""}</td>
          <td class="mono muted">${esc(t.dailyEstimate != null ? "≈" + t.dailyEstimate + "/d" : "—")}</td>
          <td class="mono muted">${t.nextTick ? timeHtml(t.nextTick, "short") : "—"}</td>
          <td class="mono muted">${t.lastTick ? timeHtml(t.lastTick, "short") : "—"}</td>
          <td class="cell-ell muted" title="${esc(t.lastResult || t.lastError || "")}">${esc(t.lastResult || t.lastError || "—")}</td>
          <td><button class="btn-mini" data-heartbeat-once="${esc(t.id)}">RUN ONCE</button></td>
        </tr>`).join("")
      : `<tr><td colspan="8" class="muted">暂无定时任务（在各 agent 的 HEARTBEAT.md 的 frontmatter.tasks 里配）</td></tr>`;
    root.innerHTML = `
      <div class="panel-head"><h2>HEARTBEAT</h2><span class="sub">// 各 agent HEARTBEAT.md 驱动的低上下文自检 · 默认暂停</span></div>
      <div class="scheduler-control">
        <div>
          <div class="row"><span class="pill ${hb.enabled ? "on" : "warn"}">${hb.enabled ? "RUNNING" : "PAUSED"}</span>
            <span class="pill">${esc(hb.count)} 个任务</span>
            <span class="pill">今日估算 ≈ ${esc(hb.dailyEstimate)}</span>
            <span class="pill">last ${hb.lastTick ? timeHtml(hb.lastTick) : "—"}</span></div>
          <div class="muted" style="font-size:14px;margin-top:10px">默认 paused；只有这里或 API 显式开启后才会启动 timer。探活强制走<b>高速/低上下文路由</b>、不带全量 context——意义是按配置触发轻量检查/调度，不是定期把 agent 全量唤醒闲聊。</div>
        </div>
        <div class="row">
          <div class="switch ${hb.enabled ? "on" : ""}" id="heartbeatSwitch" title="toggle heartbeat"><span class="track"><span class="knob"></span></span></div>
          <button class="btn ghost" id="heartbeatRunOnce">RUN FIRST ONCE</button>
        </div>
      </div>
      <div class="card"><div class="tbl-wrap"><table class="tbl tbl-compact">
        <thead><tr><th>AGENT</th><th>TYPE</th><th>调度</th><th>今日估算</th><th>NEXT</th><th>LAST TICK</th><th>LAST RESULT</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
    $("#heartbeatSwitch").addEventListener("click", async () => {
      try {
        await api("/api/heartbeat/toggle", { method: "POST", body: JSON.stringify({ enabled: !hb.enabled }) });
        toast(`heartbeat ${hb.enabled ? "paused" : "running"}`);
        route();
      } catch (e) { toast(e.message, true); }
    });
    $("#heartbeatRunOnce").addEventListener("click", () => runHeartbeatOnce());
    root.querySelectorAll("[data-heartbeat-once]").forEach((btn) =>
      btn.addEventListener("click", () => runHeartbeatOnce(btn.dataset.heartbeatOnce))
    );
  },
};

async function runHeartbeatOnce(taskId) {
  try {
    await api("/api/heartbeat/run-once", { method: "POST", body: JSON.stringify(taskId ? { taskId } : {}) });
    toast("heartbeat task 已入队");
    route();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ── CRON（独立 tab）：用户建的持久化定时作业 ── */
// 新建 / 编辑 cron 作业弹层（＋ 按钮或行内 EDIT 触发）：表单在 modal 里占满宽度。
function openCronModal(editing, agents, onSaved) {
  const isBuiltin = Boolean(editing?.builtin);
  const agentOpts = (sel) => agents.map((a) => `<option ${a.name === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const modeOpts = (sel) => [["fresh", "每次独立会话"], ["continue", "沿用任务会话"]].map(([m, label]) => `<option value="${m}" ${m === sel ? "selected" : ""}>${label}</option>`).join("");
  const originalTimeZone = scheduleTimeZone(editing);
  const returnFocus = document.activeElement;
  const overlay = h(`
    <div class="md-modal" id="cronModal">
      <div class="md-card form-card" role="dialog" aria-modal="true" aria-label="${editing ? "编辑定时任务" : "新建定时任务"}">
        <div class="md-head"><b>${editing ? "编辑定时任务" : "新建定时任务"}</b><button class="btn-mini" id="cronModalClose" aria-label="关闭编辑">✕</button></div>
        <div class="md-body">
          <div class="row" style="gap:14px">
            <label class="field" style="flex:2;margin-top:0"><span>任务名称</span><input class="inp" id="cronName" value="${esc(editing?.name || "")}" placeholder="例如：每日早报（留空自动命名）"></label>
            <label class="field" style="flex:1;margin-top:0"><span>执行者</span><select class="inp" id="cronAgent" ${isBuiltin ? "disabled" : ""}>${isBuiltin ? `<option value="${esc(editing.agent || "-")}">系统代码任务</option>` : agentOpts(editing?.agent)}</select></label>
          </div>
          <div class="row" style="gap:14px">
            <label class="field" style="flex:1"><span>CRON 表达式</span><input class="inp" id="cronSchedule" value="${esc(editing?.schedule || "")}" placeholder="0 9 * * *"></label>
            <label class="field" style="width:170px"><span>会话方式</span><select class="inp" id="cronMode" ${isBuiltin ? "disabled" : ""}>${modeOpts(editing?.sessionMode)}</select></label>
          </div>
          <label class="field"><span>执行时区（决定上方表达式的实际触发时间）</span><select class="inp" id="cronTimeZone">${scheduleTimeZoneOptions(originalTimeZone)}</select></label>
          <p class="field-hint">${editing ? "保留此作业原有时区；只有在这里明确修改并保存，才会移动执行时间。" : "新作业默认使用当前统一时区；创建后独立固定，不随显示时区自动移动。"}</p>
          <label class="field"><span>执行身份</span><select class="inp" id="cronIdentity" ${isBuiltin ? "disabled" : ""} aria-describedby="cronIdentityHint"><option value="system">系统任务（不授予主人身份）</option><option value="owner" ${editing?.executionIdentity === "owner" ? "selected" : ""}>主人授权执行</option></select></label>
          <p class="field-hint" id="cronIdentityHint">${editing?.authorizationStatus === "required" ? "此任务需要在当前后端重新授权；" : ""}选择「主人授权执行」并保存，即授权此任务使用 Agent 已有的主人能力，仍受权限与预算约束；不开放交互专用 shell，也不能自行管理定时任务。授权仅在本机有效，与发送到哪个渠道无关。</p>
          <label class="field"><span>结果发送到</span><select class="inp" id="cronDelivery" disabled aria-describedby="cronDeliveryHint"><option value="">仅保存在 Harbour</option>${editing?.delivery ? `<option value="__keep__" selected>${esc(editing.delivery.label || editing.delivery.channel.toUpperCase())}（保留当前目标）</option>` : ""}</select></label>
          <p class="field-hint" id="cronDeliveryHint" role="status">${isBuiltin ? "内建任务由系统代码执行，仅可修改名称、调度和时区，不使用 Agent 会话或渠道投递。" : "正在加载可投递的已知渠道会话…"}</p>
          <label class="field"><span>任务指令</span><textarea class="inp" id="cronInput" ${isBuiltin ? "disabled" : ""} placeholder="到点后，希望 Agent 做什么？" style="min-height:120px">${esc(editing?.input || "")}</textarea></label>
        </div>
        <div class="md-foot">
          <button class="btn ghost" id="cronModalCancel">取消</button>
          <button class="btn primary" id="cronModalSave">${editing ? "保存修改" : "创建任务（默认暂停）"}</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(overlay);
  if (isBuiltin) {
    for (const id of ["cronMode", "cronIdentity", "cronDelivery", "cronInput"]) overlay.querySelector(`#${id}`).closest("label").hidden = true;
    overlay.querySelector("#cronIdentityHint").hidden = true;
  }
  let saving = false, unregister = () => {};
  const close = () => { unregister(); overlay.remove(); if (returnFocus?.isConnected) returnFocus.focus(); };
  overlay.closeCronEditor = close;
  const deliverySelect = overlay.querySelector("#cronDelivery");
  const deliveryHint = overlay.querySelector("#cronDeliveryHint");
  let deliveryTargets = [];
  let originalDeliveryValue = editing?.delivery ? "__keep__" : "";
  const snapshot = () => JSON.stringify([
    ...["cronName", "cronAgent", "cronSchedule", "cronMode", "cronTimeZone", "cronIdentity", "cronInput"].map(id => overlay.querySelector(`#${id}`).value),
    deliverySelect.value === originalDeliveryValue ? "unchanged" : deliverySelect.value,
  ]);
  const baseline = snapshot();
  unregister = window.HarbourUnsavedChanges?.register("cron-editor", {
    label: "定时任务配置", isActive: () => overlay.isConnected, isDirty: () => snapshot() !== baseline,
    isBusy: () => saving, version: snapshot, discard: () => { close(); return true; },
  }) || (() => {});
  const requestClose = async () => {
    if (saving) return toast("正在保存，请稍候。");
    if (snapshot() !== baseline && !await harbourConfirm("尚有未保存的任务配置。", { title: "放弃本次修改？", confirmLabel: "放弃修改", tone: "warning" })) return;
    close();
  };
  const updateDeliveryHint = () => {
    const target = deliveryTargets.find((t) => t.sessionId === deliverySelect.value);
    deliveryHint.textContent = deliverySelect.value === "__keep__"
      ? "保留原投递目标；当前没有可重新选择的匹配会话。不会自动改发给其他联系人。"
      : target ? (target.available ? "执行成功后发送到此会话；发送失败会单独记录，不会重跑任务。" : "此目标当前不可用；原配置会保留，但不会改发到其他会话。")
      : "不向 QQ / Discord 发送；结果仍可在 Harbour 查看。";
  };
  deliverySelect.addEventListener("change", updateDeliveryHint);
  if (!isBuiltin) void api("/api/cron/delivery-targets").then((result) => {
    if (!overlay.isConnected) return;
    if (!Array.isArray(result?.targets)) throw new Error("渠道会话列表格式无效");
    deliveryTargets = result.targets.filter((t) => typeof t.sessionId === "string" && t.sessionId && ["qq", "discord"].includes(t.channel));
    const current = editing?.delivery && deliveryTargets.find((t) =>
      t.channel === editing.delivery.channel && t.accountKey === editing.delivery.accountKey &&
      t.scope === editing.delivery.scope && t.targetId === editing.delivery.targetId);
    originalDeliveryValue = current?.sessionId || (editing?.delivery ? "__keep__" : "");
    deliverySelect.innerHTML = `<option value="">仅保存在 Harbour</option>${editing?.delivery && !current ? `<option value="__keep__">${esc(editing.delivery.label || editing.delivery.channel.toUpperCase())}（保留当前目标）</option>` : ""}` +
      deliveryTargets.map((t) => `<option value="${esc(t.sessionId)}" ${t.available ? "" : "disabled"}>${esc(t.label || t.channel.toUpperCase())}${t.available ? "" : "（当前不可用）"}</option>`).join("");
    deliverySelect.value = originalDeliveryValue;
    deliverySelect.disabled = false;
    updateDeliveryHint();
    if (!deliveryTargets.length && !editing?.delivery) deliveryHint.textContent = "暂无可投递的渠道会话。请先通过已配置的 QQ / Discord 与 Harbour 建立可信会话，再来选择；当前仅保存在 Harbour。";
  }).catch((error) => {
    if (!overlay.isConnected) return;
    deliverySelect.disabled = false;
    deliveryHint.textContent = `无法加载渠道会话：${error.message || "请稍后再试"}。${editing?.delivery ? "未更改时保留原目标，也可明确改为仅保存在 Harbour。" : "当前仍可创建仅保存在 Harbour 的作业。"}`;
  });
  $("#cronModalClose").addEventListener("click", requestClose);
  $("#cronModalCancel").addEventListener("click", requestClose);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) void requestClose(); });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void requestClose(); }
    if (event.key === "Tab") {
      const nodes = [...overlay.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")].filter(node => node.getClientRects().length);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  });
  overlay.querySelector("#cronName").focus();
  $("#cronModalSave").addEventListener("click", async () => {
    if (saving) return;
    const body = {
      name: $("#cronName").value.trim(),
      schedule: $("#cronSchedule").value.trim(),
      timeZone: $("#cronTimeZone").value,
    };
    if (!isBuiltin) Object.assign(body, {
      agent: $("#cronAgent").value,
      input: $("#cronInput").value.trim(),
      sessionMode: $("#cronMode").value,
      executionIdentity: $("#cronIdentity").value,
    });
    if (!isBuiltin && !deliverySelect.disabled && deliverySelect.value !== originalDeliveryValue) {
      const target = deliveryTargets.find((t) => t.sessionId === deliverySelect.value);
      if (deliverySelect.value && (!target || !target.available)) return toast("请选择当前可用的投递目标，或仅保存在 Harbour。", true);
      body.deliverySessionId = deliverySelect.value || null;
    } else if (!editing) {
      body.deliverySessionId = deliverySelect.disabled ? null : deliverySelect.value || null;
    }
    if (!body.schedule) return toast("请填 CRON 表达式（如 0 9 * * *）", true);
    if (editing && body.timeZone !== originalTimeZone && !await harbourConfirm("更改执行时区会保留 Cron 表达式，但改变它对应的实际触发时间。", {
      title: "更改此作业的执行时区？", detail: `${originalTimeZone} → ${body.timeZone}`, confirmLabel: "更改并保存", tone: "warning",
    })) return;
    try {
      saving = true;
      overlay.querySelector("#cronModalSave").disabled = true;
      if (editing) { await api(`/api/cron/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) }); toast("cron 已更新"); }
      else { await api("/api/cron", { method: "POST", body: JSON.stringify(body) }); toast("任务已创建，当前暂停，可按需启用"); }
      close(); if (onSaved) onSaved(); else route();
    } catch (e) { toast(e.message, true); }
    finally { saving = false; overlay.querySelector("#cronModalSave").disabled = false; }
  });
}

// Execution and delivery are distinct outcomes; an older result must not hide a new failure.
function cronOutcomeHtml(job) {
  const execution = { queued: "等待执行", running: "执行中", completed: "执行完成", failed: "执行失败", interrupted: "执行已中断" };
  const delivery = { pending: "等待发送", sending: "正在发送", sent: "已发送", failed: "发送失败", unknown: "送达状态未知 · 请先核对，勿重复运行", none: "未发送" };
  const executionError = job.lastError ? `<span class="cron-outcome-error">${esc(job.lastError)}</span>` : "";
  const deliveryError = job.lastDeliveryError ? `<span class="cron-outcome-error">${esc(job.lastDeliveryError)}</span>` : "";
  const currentState = execution[job.lastStatus] || (job.lastError ? "执行失败" : job.lastResult ? "已有执行结果" : "尚未运行");
  return `<div class="cron-outcome"><span class="cron-outcome-line"><b>执行</b> ${esc(currentState)}</span>${executionError}${
    job.delivery || job.lastDeliveryStatus && job.lastDeliveryStatus !== "none"
      ? `<span class="cron-outcome-line"><b>发送</b> ${esc(delivery[job.lastDeliveryStatus] || "尚未发送")}${job.lastDeliveryAt ? ` · ${timeHtml(job.lastDeliveryAt, "short")}` : ""}</span>${deliveryError}` : deliveryError
  }${job.lastResult ? `<button class="btn-mini cron-result-link" data-cron-view="${esc(job.id)}">${job.lastError || ["queued", "running", "failed", "interrupted"].includes(job.lastStatus) ? "查看上次保留结果" : "查看结果"}</button>` : ""}</div>`;
}

PANELS.cron = {
  id: "cron",
  async render(root) {
    disposeCronPanel?.();
    disposeCronPanel = window.HarbourCron.mount(root, { api, esc, humanizeCron, timeHtml, scheduleTimeZone,
      outcomeHtml: cronOutcomeHtml, openEditor: openCronModal, confirm: harbourConfirm, toast,
      showResult: async job => {
        let body = job.lastResult || "";
        const match = /报告存档ID[:：]\s*(\S+)/.exec(body);
        if (match) {
          try { const report = await api(`/api/news/report?id=${encodeURIComponent(match[1])}`); if (report?.markdown) body = report.markdown; }
          catch { /* The persisted summary remains available if its report has expired. */ }
        }
        showMarkdownModal(job.name || job.id, body);
      },
    });
    await disposeCronPanel.ready;
  },
};

PANELS.channels = {
  id: "channels",
  async render(root) {
    // 配置大页挂到 body，避免 dashboard 的 transform / overflow 把 fixed 弹层裁进卡片。
    document.querySelector(".channel-page-shell[data-channel-portal]")?.remove();
    root.innerHTML = `
      <div class="panel-head"><h2>CHANNELS</h2><span class="sub">// 可插拔 · 点卡片进入渠道配置页</span></div>
      <div class="channels-grid">
        <div class="flip-card" data-ch="discord">
          <div class="flip-inner">
            <button class="flip-front" data-flip="discord" aria-haspopup="dialog" aria-controls="channelDiscordPage" aria-expanded="false">
              <span class="fc-icon">◈</span>
              <span class="fc-name">DISCORD</span>
              <span class="fc-status" id="discordFrontStatus">· · ·</span>
              <span class="fc-hint">点击展开 · 多 Bot / 人格绑定 / 白名单</span>
            </button>
          </div>
        </div>
        <div class="flip-card" data-ch="qq">
          <div class="flip-inner">
            <button class="flip-front" data-flip="qq" aria-haspopup="dialog" aria-controls="channelQQPage" aria-expanded="false">
              <span class="fc-icon">◈</span>
              <span class="fc-name">QQ</span>
              <span class="fc-status" id="qqFrontStatus">· · ·</span>
              <span class="fc-hint">官方多 Bot · Main 固定绑定 / OpenID 隔离</span>
            </button>
          </div>
        </div>
        <div class="flip-card" data-ch="wecom">
          <div class="flip-inner">
            <button class="flip-front" data-flip="wecom" aria-haspopup="dialog" aria-controls="channelWecomPage" aria-expanded="false">
              <span class="fc-icon">◈</span>
              <span class="fc-name">WECOM</span>
              <span class="fc-status muted">未实现</span>
              <span class="fc-hint">企业微信 · 仅走官方 API</span>
            </button>
          </div>
        </div>
      </div>`;

    const portal = document.createElement("div");
    portal.className = "channel-page-shell";
    portal.dataset.channelPortal = "";
    portal.setAttribute("aria-hidden", "true");
    portal.innerHTML = `
      <button class="channel-page-scrim" data-channel-page-close aria-label="关闭渠道配置"></button>
      <section class="channel-page" id="channelDiscordPage" data-channel-page="discord" role="dialog" aria-modal="true" aria-labelledby="channelDiscordTitle">
        <div class="channel-page-head">
          <div class="channel-page-heading">
            <span class="channel-page-kicker">CHANNEL / DISCORD</span>
            <h3 id="channelDiscordTitle">DISCORD 配置</h3>
          </div>
          <button class="btn-mini channel-page-close" data-channel-page-close>✕ 返回</button>
        </div>
        <div class="channel-page-body" id="discordCard"><div class="muted">加载中…</div></div>
      </section>
      <section class="channel-page" id="channelQQPage" data-channel-page="qq" role="dialog" aria-modal="true" aria-labelledby="channelQQTitle">
        <div class="channel-page-head">
          <div class="channel-page-heading">
            <span class="channel-page-kicker">CHANNEL / QQ OPEN PLATFORM</span>
            <h3 id="channelQQTitle">QQ 官方机器人配置</h3>
          </div>
          <button class="btn-mini channel-page-close" data-channel-page-close>✕ 返回</button>
        </div>
        <div class="channel-page-body" id="qqCard"><div class="muted">加载中…</div></div>
      </section>
      <section class="channel-page" id="channelWecomPage" data-channel-page="wecom" role="dialog" aria-modal="true" aria-labelledby="channelWecomTitle">
        <div class="channel-page-head">
          <div class="channel-page-heading">
            <span class="channel-page-kicker">CHANNEL / WECOM</span>
            <h3 id="channelWecomTitle">WECOM（企业微信）</h3>
          </div>
          <button class="btn-mini channel-page-close" data-channel-page-close>✕ 返回</button>
        </div>
        <div class="channel-page-body">
          <div class="channel-empty-state">
            <span class="fc-icon">◈</span>
            <b>官方渠道接入尚未实现</b>
            <p>仅走企业微信 / 公众号官方 API；不实现任何非官方微信协议。</p>
          </div>
        </div>
      </section>`;
    document.body.appendChild(portal);

    let activeTrigger = null;
    let closeTimer = null;
    const closePage = () => {
      if (!portal.classList.contains("open")) return;
      portal.classList.remove("entered");
      portal.classList.add("closing");
      activeTrigger?.closest(".flip-card")?.classList.add("closing");
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        portal.classList.remove("open", "closing");
        portal.setAttribute("aria-hidden", "true");
        portal.querySelectorAll(".channel-page.active").forEach((page) => {
          page.classList.remove("active");
          page.style.removeProperty("transform-origin");
        });
        activeTrigger?.closest(".flip-card")?.classList.remove("closing");
        activeTrigger?.setAttribute("aria-expanded", "false");
        activeTrigger?.focus({ preventScroll: true });
        activeTrigger = null;
      }, 420);
    };
    const openPage = (channel, trigger) => {
      clearTimeout(closeTimer);
      activeTrigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      const card = trigger.closest(".flip-card");
      const page = portal.querySelector(`[data-channel-page="${channel}"]`);
      if (!page) return;
      portal.querySelectorAll(".channel-page.active").forEach((item) => item.classList.remove("active"));
      page.classList.add("active");
      portal.classList.remove("closing", "entered");
      portal.classList.add("open");
      portal.setAttribute("aria-hidden", "false");

      // FLIP-style transform origin：大页从被点击卡片的中心位置展开 / 收回。
      const cardRect = card.getBoundingClientRect();
      const pageLeft = (window.innerWidth - page.offsetWidth) / 2;
      const pageTop = (window.innerHeight - page.offsetHeight) / 2;
      const originX = cardRect.left + cardRect.width / 2 - pageLeft;
      const originY = cardRect.top + cardRect.height / 2 - pageTop;
      page.style.transformOrigin = `${originX}px ${originY}px`;
      card.classList.add("opening");

      requestAnimationFrame(() => requestAnimationFrame(() => {
        portal.classList.add("entered");
        card.classList.remove("opening");
        page.querySelector("[data-channel-page-close]")?.focus({ preventScroll: true });
      }));
      if (channel === "discord" && !portal.dataset.discordLoaded) {
        portal.dataset.discordLoaded = "1";
        renderDiscordConfig();
      }
      if (channel === "qq" && !portal.dataset.qqLoaded) {
        portal.dataset.qqLoaded = "1";
        renderQQConfig();
      }
    };

    root.querySelectorAll("[data-flip]").forEach((btn) =>
      btn.addEventListener("click", () => openPage(btn.dataset.flip, btn)));
    portal.querySelectorAll("[data-channel-page-close]").forEach((btn) => btn.addEventListener("click", closePage));
    portal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePage();
        return;
      }
      if (event.key !== "Tab") return;
      const page = portal.querySelector(".channel-page.active");
      if (!page) return;
      const focusable = [...page.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((item) => item.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // 卡片状态：各渠道独立失败，不互相拖累。
    try {
      const d = await api("/api/channels/discord");
      const fs = $("#discordFrontStatus");
      if (fs) {
        const active = (d.bots || []).filter((bot) => bot.active).length;
        fs.innerHTML = d.configured ? `✔ ${active}/${d.configuredCount} 已连接` : "✖ 未配置 token";
      }
    } catch { /* ignore */ }
    try {
      const q = await api("/api/channels/qq");
      const fs = $("#qqFrontStatus");
      if (fs) {
        const active = (q.activeBotKeys || []).length;
        const awaitingOwner = (q.bots || []).filter((bot) => bot.active && Number(bot.persistedOwnerCount || 0) === 0).length;
        fs.innerHTML = q.configured
          ? `✔ ${active}/${q.configuredCount || 0} 已连接${awaitingOwner ? ` · ${awaitingOwner} 待绑定` : ""}`
          : "✖ 未配置";
      }
    } catch { /* ignore */ }
  },
};

// Discord 多 Bot：每个 botKey 绑定一个 agent；token 只写 .env，白名单对在线实例热生效。
async function renderDiscordConfig() {
  const box = $("#discordCard");
  if (!box) return;
  try {
    const d = await api("/api/channels/discord");
    const bots = d.bots || [];
    const agents = d.availableAgents || [];
    const botEditor = (bot) => `
      <section class="dc-bot-editor" data-dc-bot="${esc(bot.key)}">
        <div class="row dc-bot-head">
          <b>${esc(bot.label || bot.key)}</b><code>${esc(bot.key)}</code>
          <span class="muted" style="margin-left:auto">${bot.active ? "● 已连接" : bot.configured ? "◌ 待重启/连接失败" : "○ 未配 token"}</span>
          <button class="btn-mini" data-dc-delete="${esc(bot.key)}">删除</button>
        </div>
        <div class="dc-bot-grid">
          <label class="mc-field">显示名
            <input class="inp" data-dc-field="label" value="${esc(bot.label || "")}" placeholder="Elaina"></label>
          <label class="mc-field">Application ID
            <input class="inp" data-dc-field="applicationId" value="${esc(bot.applicationId || "")}" inputmode="numeric" placeholder="1473091771994083581"></label>
          <label class="mc-field">绑定 Agent
            <select class="inp" data-dc-field="agentName">
              ${agents.map((agent) => `<option value="${esc(agent)}" ${agent === bot.agentName ? "selected" : ""}>${esc(agent)}</option>`).join("")}
            </select></label>
          <label class="mc-field">Bot Token（留空不改；${esc(bot.tokenMask || "未设置")}）
            <input class="inp" data-dc-field="token" type="password" autocomplete="new-password" placeholder="留空保持不变"></label>
        </div>
        <label class="mc-field" style="margin-top:8px">白名单（作者 / 频道 ID，逗号分隔；空 = 谁都不放行）
          <textarea class="inp" data-dc-field="allowlist" rows="2" placeholder="123456789012345678">${esc(bot.allowlist || "")}</textarea></label>
        <div class="row" style="margin-top:7px">
          <button class="btn" data-dc-save="${esc(bot.key)}">保存此 Bot${bot.hotAllowlist ? "（白名单热生效）" : "（重启生效）"}</button>
        </div>
      </section>`;
    box.innerHTML = `
      <div class="row"><div class="kv"><span class="k">状态</span><span class="val">${d.configuredCount || 0} 个已配 token</span></div>
        <button class="btn" id="dcAddBot" style="margin-left:auto">＋ 新增 Bot</button></div>
      ${bots.map(botEditor).join("")}
      <div class="dc-global-config">
      <b>主动新闻投递</b>
      <label class="mc-field" style="margin-top:8px">发送 Bot
        <select class="inp" id="dcNewsBot"><option value="">自动（优先 default / 首个可用）</option>
          ${bots.map((bot) => `<option value="${esc(bot.key)}" ${bot.key === d.newsBotKey ? "selected" : ""}>${esc(bot.label || bot.key)} · ${esc(bot.key)}</option>`).join("")}
        </select></label>
      <label class="mc-field" style="margin-top:8px">AI 新闻投递频道 ID
        <input class="inp" id="dcAiCh" value="${esc(d.aiNewsChannelId)}" placeholder="频道 id（空=不发 Discord）"></label>
      <label class="mc-field" style="margin-top:8px">股票新闻投递频道 ID
        <input class="inp" id="dcStockCh" value="${esc(d.stockNewsChannelId)}" placeholder="频道 id（空=不发 Discord）"></label>
      <div class="row" style="margin-top:8px"><button class="btn" id="dcNewsSave">保存新闻投递配置（重启生效）</button></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:10px">Token 只写本机 .env；Application ID 不是密钥。新增/删除/身份变更需重启，在线 Bot 的白名单可热更新。</div>`;

    $("#dcAddBot").addEventListener("click", async () => {
      const rawKey = await harbourPrompt("使用小写字母、数字、下划线或短横线。", "", {
        title: "新增 Discord Bot", inputLabel: "Bot 标识", placeholder: "例如 elaina / aemeath",
      });
      if (rawKey == null || !rawKey.trim()) return;
      const key = rawKey.trim().toLowerCase();
      const suggested = agents.includes(`main-${key}`) ? `main-${key}` : (agents[0] || "");
      const agentName = await harbourPrompt("这个 Bot 收到消息后固定交给哪个 Main Agent？", suggested, {
        title: "绑定 Harbour Agent", inputLabel: "Agent 名称", placeholder: "例如 main-elaina",
      });
      if (agentName == null || !agentName.trim()) return;
      try {
        await api("/api/channels/discord", { method: "POST", body: JSON.stringify({ botKey: key, label: key, agentName: agentName.trim() }) });
        toast("Bot 配置已新增；填入 token 后重启生效");
        renderDiscordConfig();
      } catch (e) { toast(e.message, true); }
    });

    box.querySelectorAll("[data-dc-save]").forEach((button) => button.addEventListener("click", async () => {
      const editor = button.closest("[data-dc-bot]");
      const field = (name) => editor.querySelector(`[data-dc-field="${name}"]`).value;
      const body = {
        botKey: editor.dataset.dcBot,
        label: field("label"),
        applicationId: field("applicationId"),
        agentName: field("agentName"),
        token: field("token"),
        allowlist: field("allowlist"),
      };
      try {
        const r = await api("/api/channels/discord", { method: "POST", body: JSON.stringify(body) });
        toast(r.hot && !r.restartRequired ? "白名单已热生效" : "已写 .env —— 重启后完整生效");
        renderDiscordConfig();
      } catch (e) { toast(e.message, true); }
    }));

    box.querySelectorAll("[data-dc-delete]").forEach((button) => button.addEventListener("click", async () => {
      const key = button.dataset.dcDelete;
      if (!await harbourConfirm(`Discord Bot「${key}」的配置将被删除。`, {
        title: "删除 Discord Bot？", detail: "Token 会从 .env 清空；重启 Harbour 后该 Bot 将断开。", confirmLabel: "删除 Bot", tone: "danger",
      })) return;
      try {
        await api(`/api/channels/discord?botKey=${encodeURIComponent(key)}`, { method: "DELETE" });
        toast("Bot 配置已删除；重启后生效");
        renderDiscordConfig();
      } catch (e) { toast(e.message, true); }
    }));

    $("#dcNewsSave").addEventListener("click", async () => {
      try {
        await api("/api/channels/discord", { method: "POST", body: JSON.stringify({
          botKey: bots[0]?.key || "default",
          newsBotKey: $("#dcNewsBot").value,
          aiNewsChannelId: $("#dcAiCh").value,
          stockNewsChannelId: $("#dcStockCh").value,
        }) });
        toast("新闻投递配置已保存；重启后生效");
        renderDiscordConfig();
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}

// SETTINGS：Claude-Desktop 风——左侧竖排条目 + 右侧内容，一次显示一节。
let settingsSection = "appearance";
let disposeGoogleSettings = null;
PANELS.settings = {
  id: "settings",
  async render(root) {
    const s = await api("/api/state");
    root.innerHTML = `
      <div class="panel-head"><h2>SETTINGS</h2><span class="sub">// 外观 · 时区 · 语音 · Google · 模型管理 · 系统</span></div>
      <div class="settings-shell">
        <aside class="settings-nav" id="settingsNav">
          ${settingsNavItem("appearance", "🎨", "外观")}
          ${settingsNavItem("time", "◷", "日期与时区")}
          ${settingsNavItem("voice", "🎙", "语音")}
          ${settingsNavItem("messages", "≋", "消息与合并")}
          ${settingsNavItem("google", "G", "Google 集成")}
          ${settingsNavItem("devices", "⌘", "设备与执行环境")}
          ${settingsNavItem("models", "🧠", "模型管理")}
          ${settingsNavItem("config", "🗂", "配置字段")}
          ${settingsNavItem("system", "⚙", "系统")}
        </aside>
        <section class="settings-pane" id="settingsPane"></section>
      </div>`;
    root.querySelectorAll("[data-set-nav]").forEach((b) =>
      b.addEventListener("click", () => {
        settingsSection = b.dataset.setNav;
        root.querySelectorAll("[data-set-nav]").forEach((x) => x.classList.toggle("active", x.dataset.setNav === settingsSection));
        renderSettingsPane(s);
      })
    );
    renderSettingsPane(s);
  },
};

function settingsNavItem(id, ico, label) {
  return `<button class="settings-nav-item${settingsSection === id ? " active" : ""}" data-set-nav="${id}"><span class="sni-ico">${ico}</span>${label}</button>`;
}
function settingsHeadingHtml(title, icon, description = "") {
  return `<header class="settings-section-head"><span class="settings-section-icon" aria-hidden="true">${icon}</span><div><h3 class="settings-h">${title}</h3>${description ? `<p>${description}</p>` : ""}</div></header>`;
}
function renderSettingsPane(s) {
  disposeGoogleSettings?.(); disposeGoogleSettings = null;
  const pane = $("#settingsPane");
  if (!pane) return;
  if (settingsSection === "models") renderSettingsModels(pane, s);
  else if (settingsSection === "time") renderSettingsTime(pane);
  else if (settingsSection === "voice") renderSettingsVoice(pane);
  else if (settingsSection === "messages") window.HarbourChatIntake?.settings(pane, api, toast);
  else if (settingsSection === "google") disposeGoogleSettings = window.HarbourGoogleIntegrations.mount(pane, { api });
  else if (settingsSection === "devices") renderSettingsDevices(pane);
  else if (settingsSection === "config") renderSettingsConfig(pane);
  else if (settingsSection === "system") renderSettingsSystem(pane, s);
  else renderSettingsAppearance(pane);
}

function renderSettingsTime(pane) {
  pane.innerHTML = `
    <section class="time-settings" id="timeSettingsForm">
      <header class="time-settings-head"><span class="time-settings-mark" aria-hidden="true">◷</span><div><h3 class="settings-h">日期与时区</h3><p>Harbour 共用一只时钟，跨设备保持一致。</p></div></header>
      <div class="time-settings-clock"><span class="time-settings-eyebrow">HARBOUR LOCAL TIME</span><time id="timeSettingsNow"></time><b id="timeSettingsLabel"></b><code id="timeSettingsCurrent"></code></div>
      <label class="mc-field time-settings-field" for="timeSettingsZone">统一时区<select class="inp" id="timeSettingsZone" aria-describedby="timeSettingsHelp"></select></label>
      <p class="time-settings-help" id="timeSettingsHelp">纽约时间自动切换 EST / EDT；固定 EST 始终为 UTC−05:00，不切换夏令时。此设置同步到所有已打开的 Web / Electron 客户端，也用于 Agent 的当前时间。</p>
      <div class="time-settings-policy"><b>只换显示，不移动已有安排</b><p>聊天、历史、运行轨迹按统一时区显示。已有 Cron / Heartbeat 保持各自的执行时区和计划；新 Cron 默认采用此时区，之后独立固定。原始时间戳继续按 UTC 保存，运行时长与费用不变。</p><small id="timeSettingsLegacy"></small></div>
      <div class="time-settings-actions"><span id="timeSettingsStatus" role="status" aria-live="polite"></span><div class="time-settings-buttons"><button class="btn" id="timeSettingsRetry" type="button" hidden>重试连接</button><button class="btn primary" id="timeSettingsSave" type="button">保存并同步</button></div></div>
    </section>`;
  pane.querySelector("#timeSettingsZone").addEventListener("change", (event) => {
    timeSettingsState.draft = event.target.value;
    timeSettingsState.error = "";
    syncTimeSettingsForm();
  });
  pane.querySelector("#timeSettingsSave").addEventListener("click", saveTimeSettings);
  pane.querySelector("#timeSettingsRetry").addEventListener("click", () => { void loadTimeSettings(); });
  syncTimeSettingsForm();
  void loadTimeSettings();
}

// —— 外观 ——
function renderSettingsAppearance(pane) {
  const companionAgent = currentCompanionAgent();
  const companionTarget = companionTargetForAgent(companionAgent);
  const companionId = companionTarget?.petId || "";
  const companionName = companionTarget?.label || personaLabel(companionAgent);
  const desktopPetRow = window.harbourDesktop?.isElectron ? `
    <section class="settings-section">${settingsHeadingHtml("桌面体验", "✦", "当前角色的专属陪伴窗口。")}
    <div class="settings-section-body">
    <div class="set-row">
      <div class="set-row-main">
        <div class="set-row-title">${esc(companionName)} 桌面宠物</div>
        <div class="set-row-sub">当前角色的独立透明置顶窗口；只响应 ${esc(companionAgent)} 的 Web / Discord / QQ 运行、提问与完成状态。</div>
      </div>
      <div class="set-row-ctrl"><button class="btn ghost" id="desktopPetToggle" ${companionId ? "" : "disabled"}>${companionId ? "读取状态…" : "当前不是 Main 角色"}</button></div>
    </div>
    <div class="set-row"><div class="set-row-main"><div class="set-row-title">Harbour 悬浮助手</div>
      <div class="set-row-sub">屏幕边缘的快捷对话入口；悬停展开、拖动贴边，与桌宠独立开关。Ctrl / ⌘ + Shift + Space 唤起。</div></div>
      <div class="set-row-ctrl"><button class="btn ghost" id="desktopOrbToggle">读取状态…</button></div>
    </div></div></section>` : "";
  pane.innerHTML = `
    <section class="settings-section">${settingsHeadingHtml("外观主题", "◈", "选择属于你的 Harbour；切换即时生效并在本机记忆。")}
    <div class="settings-section-body"><div class="set-row appearance-row">
      <div class="set-row-main">
        <div class="set-row-title">主题风格</div>
        <div class="set-row-sub">风格决定界面语言，角色决定陪伴形象，配色点缀每一处细节。</div>
      </div>
      <div class="set-row-ctrl appearance-selects">
        <label>风格<select class="inp" id="setThemeCat"></select></label>
        <label>角色<select class="inp" id="setThemePersona"></select></label>
        <label>配色<select class="inp" id="setThemeVariant"></select></label>
      </div>
    </div></div></section>${desktopPetRow}`;
  wireThemeTriple($("#setThemeCat"), $("#setThemePersona"), $("#setThemeVariant"));
  syncThemeSelectors();
  const orbToggle = $("#desktopOrbToggle");
  if (orbToggle) {
    const syncOrb = async () => {
      if (!window.harbourDesktop.orbStatus) { orbToggle.textContent = "重启客户端以启用"; orbToggle.disabled = true; return; }
      const state = await window.harbourDesktop.orbStatus();
      orbToggle.dataset.enabled = String(state.enabled); orbToggle.textContent = state.enabled ? "隐藏悬浮球" : "开启悬浮球";
    };
    orbToggle.addEventListener("click", async () => {
      orbToggle.disabled = true;
      try { await window.harbourDesktop.setOrbEnabled(orbToggle.dataset.enabled !== "true"); await syncOrb(); }
      catch { orbToggle.textContent = "暂不可用，请重启客户端"; }
      finally { orbToggle.disabled = false; }
    });
    syncOrb().catch(() => { orbToggle.textContent = "请重启客户端"; orbToggle.disabled = true; });
  }
  const petToggle = $("#desktopPetToggle");
  if (petToggle && companionId) {
    const sync = async () => {
      const visible = await window.harbourDesktop.petVisible(companionId);
      petToggle.dataset.visible = visible ? "1" : "0";
      petToggle.textContent = visible ? "关闭桌宠" : "显示桌宠";
      petToggle.title = visible ? "释放桌宠窗口、模型和语音资源；不影响音乐与后台任务" : "重新加载并显示桌宠";
    };
    petToggle.addEventListener("click", async () => {
      petToggle.disabled = true;
      if (petToggle.dataset.visible === "1") await window.harbourDesktop.hidePet(companionId);
      else await window.harbourDesktop.showPet(companionId);
      await sync();
      petToggle.disabled = false;
    });
    sync().catch(() => { petToggle.textContent = "桌宠不可用"; petToggle.disabled = true; });
  }
}

// —— 语音：识别和合成都由 Harbour 后端转发；Electron 只录制、播放与驱动口型。——
let voiceSettingsTab = localStorage.getItem("harbour-voice-settings-tab") || "tts";
let ttsPreviewAudio = null;
let ttsPreviewUrl = "";

async function renderSettingsVoice(pane) {
  window.HarbourVoiceLibrary?.destroy();
  pane.innerHTML = `<div class="settings-loading">正在读取语音 Gateway…</div>`;
  let sttPayload, ttsPayload;
  try {
    [sttPayload, ttsPayload] = await Promise.all([api("/api/stt/config"), api("/api/tts/config")]);
  } catch (e) {
    pane.innerHTML = `<div class="empty">语音配置读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (settingsSection !== "voice" || pane !== $("#settingsPane")) return;
  pane.innerHTML = `
    <div class="voice-tabs" role="tablist" aria-label="语音设置">
      <button class="voice-tab" data-voice-tab="tts"><span>◖</span><b>语音合成</b><small>TTS · 让角色说话</small></button>
      <button class="voice-tab" data-voice-tab="stt"><span>◗</span><b>语音识别</b><small>STT · 听懂语音</small></button>
    </div>
    <section class="voice-pane" id="voiceTtsPane" data-voice-pane="tts"></section>
    <section class="voice-pane" id="voiceSttPane" data-voice-pane="stt"></section>`;
  const selectTab = (id) => {
    voiceSettingsTab = id === "stt" ? "stt" : "tts";
    localStorage.setItem("harbour-voice-settings-tab", voiceSettingsTab);
    pane.querySelectorAll("[data-voice-tab]").forEach((node) => node.classList.toggle("active", node.dataset.voiceTab === voiceSettingsTab));
    pane.querySelectorAll("[data-voice-pane]").forEach((node) => node.classList.toggle("active", node.dataset.voicePane === voiceSettingsTab));
  };
  pane.querySelectorAll("[data-voice-tab]").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.voiceTab)));
  renderTtsSettings($("#voiceTtsPane"), ttsPayload);
  window.HarbourVoiceLibrary.mount($("#ttsVoiceLibrary"), { config: ttsPayload.config || {}, providers: ttsPayload.providers || [],
    characters: ttsPayload.characters || [], request: requestVoiceChoice,
    save: value => api("/api/tts/voices", { method: "POST", body: JSON.stringify(value) }) });
  renderSttSettings($("#voiceSttPane"), sttPayload);
  selectTab(voiceSettingsTab);
}

function renderSttSettings(pane, payload) {
  const c = payload.config || {};
  const status = payload.status || {};
  const providers = status.providers || [];
  const statusClass = !c.enabled ? "off" : status.configured ? "ok" : "warn";
  const statusText = !c.enabled ? "已关闭" : status.configured ? `已连接配置 · ${providers.length} 个 Provider` : "等待配置 Provider";
  pane.innerHTML = `
    <div class="voice-settings-head">
      <div><h3 class="settings-h">语音识别</h3><p>QQ 原生 ASR 优先；Discord、Web 与 Electron 的其余语音统一走远端 OpenAI-compatible STT。</p></div>
      <span class="voice-status ${statusClass}"><i></i>${esc(statusText)}</span>
    </div>
    <div class="voice-note">Harbour 不会在本机、树莓派或 Electron 中启动 Python / PyTorch。转写完成后会先填入输入框，你可以修改，再决定是否发送。</div>
    <div class="set-row">
      <div class="set-row-main"><div class="set-row-title">启用 STT Gateway</div><div class="set-row-sub">关闭后仍会复用 QQ 官方事件自带的 ASR；其它纯语音会明确失败，不让 Main 猜内容。</div></div>
      <div class="set-row-ctrl"><label class="voice-toggle"><input id="sttEnabled" type="checkbox" ${c.enabled ? "checked" : ""}><span>启用</span></label></div>
    </div>
    <h3 class="settings-h voice-subhead">远端 Provider</h3>
    <div class="voice-field-grid">
      <label class="mc-field voice-wide">接口 URL
        <input class="inp" id="sttUrl" value="${esc(c.url || "")}" placeholder="https://stt.example.com/v1/audio/transcriptions">
        <small>可填服务根地址；Harbour 会自动补齐 /v1/audio/transcriptions。</small></label>
      <label class="mc-field">名称<input class="inp" id="sttProvider" value="${esc(c.provider || "primary")}" placeholder="primary"></label>
      <label class="mc-field">模型<input class="inp" id="sttModel" value="${esc(c.model || "sensevoice")}" placeholder="sensevoice"></label>
      <label class="mc-field">语言<input class="inp" id="sttLanguage" value="${esc(c.language || "auto")}" placeholder="auto / zh / ja"></label>
      <label class="mc-field voice-wide">鉴权 Headers（${c.headersConfigured ? "已配置；留空保持" : "未配置"}）
        <input class="inp" id="sttHeaders" type="password" autocomplete="new-password" placeholder="Authorization: Bearer ...">
        <label class="voice-clear"><input id="sttClearHeaders" type="checkbox"> 清除现有 Headers</label></label>
    </div>
    <details class="voice-advanced"><summary>限制与后备 Provider</summary>
      <div class="voice-limit-grid">
        <label class="mc-field">超时 ms<input class="inp" id="sttTimeout" type="number" min="1000" value="${Number(c.timeoutMs) || 120000}"></label>
        <label class="mc-field">最大 MB<input class="inp" id="sttMaxMb" type="number" min="1" value="${Number(c.maxAudioMb) || 25}"></label>
        <label class="mc-field">最大秒数<input class="inp" id="sttMaxSeconds" type="number" min="1" value="${Number(c.maxSeconds) || 300}"></label>
        <label class="mc-field">并发<input class="inp" id="sttConcurrency" type="number" min="1" value="${Number(c.maxConcurrency) || 2}"></label>
        <label class="mc-field">每人/分钟<input class="inp" id="sttRate" type="number" min="1" value="${Number(c.maxRequestsPerMinute) || 12}"></label>
      </div>
      <label class="mc-field">Fallback JSON（${c.fallbacksConfigured ? "已配置；留空保持" : "未配置"}）
        <textarea class="inp" id="sttFallbacks" rows="4" placeholder='[{"name":"backup","url":"https://...","model":"whisper-1"}]'></textarea></label>
      <label class="voice-clear"><input id="sttClearFallbacks" type="checkbox"> 清除现有 Fallback</label>
    </details>
    <div class="voice-actions">
      <button class="btn primary" id="sttSave">保存并热生效</button>
      <button class="btn ghost" id="sttTest">发送静音探针</button>
      <span class="muted" id="sttActionStatus">无需重启 Harbour</span>
    </div>`;
  $("#sttSave").addEventListener("click", async () => {
    const button = $("#sttSave");
    button.disabled = true;
    $("#sttActionStatus").textContent = "正在保存…";
    try {
      const headers = $("#sttHeaders").value.trim();
      const fallbacksJson = $("#sttFallbacks").value.trim();
      await api("/api/stt/config", { method: "POST", body: JSON.stringify({
        enabled: $("#sttEnabled").checked,
        url: $("#sttUrl").value,
        provider: $("#sttProvider").value,
        model: $("#sttModel").value,
        language: $("#sttLanguage").value,
        ...(headers ? { headers } : {}),
        clearHeaders: $("#sttClearHeaders").checked,
        ...(fallbacksJson ? { fallbacksJson } : {}),
        clearFallbacks: $("#sttClearFallbacks").checked,
        timeoutMs: Number($("#sttTimeout").value),
        maxAudioMb: Number($("#sttMaxMb").value),
        maxSeconds: Number($("#sttMaxSeconds").value),
        maxConcurrency: Number($("#sttConcurrency").value),
        maxRequestsPerMinute: Number($("#sttRate").value),
      }) });
      toast("STT 配置已保存并热生效");
      renderSettingsVoice($("#settingsPane"));
    } catch (e) {
      $("#sttActionStatus").textContent = e.message;
      toast(e.message, true);
      button.disabled = false;
    }
  });
  $("#sttTest").addEventListener("click", async () => {
    const button = $("#sttTest");
    button.disabled = true;
    $("#sttActionStatus").textContent = "正在调用远端 Provider…";
    try {
      const r = await api("/api/stt/test", { method: "POST", body: JSON.stringify({}) });
      $("#sttActionStatus").textContent = `可用 · ${r.provider} · ${formatRunDuration(r.processingMs || 0)}`;
      toast("STT 探针通过");
    } catch (e) {
      $("#sttActionStatus").textContent = `失败 · ${e.message}`;
      toast(e.message, true);
    } finally { button.disabled = false; }
  });
}

function renderTtsSettings(pane, payload) {
  const c = payload.config || {};
  const tencent = c.tencentFallback || {};
  const status = payload.status || {};
  const providers = payload.providers || [];
  const characters = payload.characters || [];
  const profiles = c.profiles || {};
  let selectedProvider = providers.find((item) => item.id === c.provider)
    || providers.find((item) => item.format === c.format)
    || providers[0];
  const statusClass = !c.enabled ? "off" : status.configured ? "ok" : "warn";
  const statusText = !c.enabled
    ? "已关闭"
    : status.configured
      ? `${status.provider || c.provider} · 远端已配置`
      : status.error ? `配置错误 · ${status.error}` : "等待配置远端 Provider";
  const profileCard = (character) => {
    const profile = profiles[character.id] || {};
    return `<article class="tts-profile-card" data-tts-profile="${esc(character.id)}">
      <div class="tts-profile-head">
        <span class="tts-profile-avatar">${esc(character.label.slice(0, 1))}</span>
        <div><b>${esc(character.label)}</b><small>${esc(character.agent)}</small></div>
        <span class="badge">独立声线</span>
      </div>
      <div class="tts-profile-grid">
        <label class="mc-field">Voice / Speaker<input class="inp" data-tts-field="voice" value="${esc(profile.voice || "")}" placeholder="elaina"></label>
        <label class="mc-field">模型覆盖<input class="inp" data-tts-field="model" value="${esc(profile.model || "")}" placeholder="留空沿用全局"></label>
        <label class="mc-field">语速<input class="inp" data-tts-field="speed" type="number" min="0.5" max="2" step="0.05" value="${Number(profile.speed) || 1}"></label>
      </div>
      <details class="tts-profile-advanced"><summary>参考音频 / 音色与风格参数</summary>
        <div class="tts-profile-grid">
          <label class="mc-field tts-wide">参考音频路径<input class="inp" data-tts-field="refAudioPath" value="${esc(profile.refAudioPath || "")}" placeholder="D:/Harbour/voices/${esc(character.id)}/reference.wav"><small>GPT-SoVITS 填推理机路径；MiMo VoiceClone 填 Harbour 后端机器上的路径。</small></label>
          <label class="mc-field tts-wide">参考音频原文<input class="inp" data-tts-field="promptText" value="${esc(profile.promptText || "")}" placeholder="必须与参考音频逐字一致"></label>
          <label class="mc-field">参考语言<input class="inp" data-tts-field="promptLang" value="${esc(profile.promptLang || "ja")}" placeholder="ja"></label>
          <label class="mc-field">输出语言<input class="inp" data-tts-field="textLang" value="${esc(profile.textLang || "auto")}" placeholder="auto"></label>
          <label class="mc-field tts-wide">风格提示<input class="inp" data-tts-field="stylePrompt" value="${esc(profile.stylePrompt || "")}" placeholder="gentle, composed"></label>
        </div>
      </details>
    </article>`;
  };

  pane.innerHTML = `
    <div class="voice-settings-head">
      <div><h3 class="settings-h">语音合成</h3><p>后端统一连接云端或远端 GPU；桌面端只播放、缓存命中提示和驱动口型。</p></div>
      <span class="voice-status ${statusClass}"><i></i>${esc(statusText)}</span>
    </div>
    <div class="voice-note">Provider 与角色音色彼此分离，同时保持 Harbour 的服务端边界：密钥、参考音频路径和上游 URL 不下发给桌宠。相同角色、声线和文本会命中本机用户数据缓存，不重复合成。</div>
    <div class="set-row">
      <div class="set-row-main"><div class="set-row-title">启用 TTS Gateway</div><div class="set-row-sub">关闭只影响发声；文字回复、任务状态、桌宠动画和聊天渠道不会中断。</div></div>
      <div class="set-row-ctrl"><label class="voice-toggle"><input id="ttsEnabled" type="checkbox" ${c.enabled ? "checked" : ""}><span>启用</span></label></div>
    </div>
    <h3 class="settings-h voice-subhead">腾讯云 · 通用备用</h3>
    <div class="voice-note">主服务失败时自动接替；跟随默认且主服务 URL 留空时直接使用。自动备用固定用智瑜（101001，精品中文女声），不会升级收费档位。手动音色选择可以使用腾讯其他档位，也可以选未来部署的角色专属声线。</div>
    <div class="set-row">
      <div class="set-row-main"><div class="set-row-title">启用腾讯云备用</div><div class="set-row-sub">${tencent.credentialsConfigured ? "密钥已保存（不回显）" : "等待填写 SecretId 和 SecretKey"} · 赠送额度是否有效以腾讯云资源包页面为准</div></div>
      <div class="set-row-ctrl"><label class="voice-toggle"><input id="ttsTencentEnabled" type="checkbox" ${tencent.enabled ? "checked" : ""}><span>备用</span></label></div>
    </div>
    <div class="voice-field-grid">
      <label class="mc-field">SecretId<input class="inp" id="ttsTencentId" type="password" autocomplete="new-password" placeholder="${tencent.credentialsConfigured ? "留空保持现有密钥" : "粘贴腾讯云 SecretId"}"></label>
      <label class="mc-field">SecretKey<input class="inp" id="ttsTencentKey" type="password" autocomplete="new-password" placeholder="${tencent.credentialsConfigured ? "留空保持现有密钥" : "粘贴腾讯云 SecretKey"}"></label>
      <label class="voice-clear"><input id="ttsTencentClear" type="checkbox"> 清除已保存的腾讯云密钥</label>
    </div>
    <details class="voice-advanced"><summary>第一次连接：密钥从哪里来？</summary>
      <p>在腾讯云访问管理中为 Harbour 创建仅供 API 调用的子用户，只授予 <code>tts:TextToVoice</code> 权限。创建 API 密钥后，将 SecretId 和 SecretKey 分别粘贴到上面，勾选备用，点击下方「保存并热生效」，再点「仅试听腾讯备用」。密钥只在创建时显示，请妥善保存，不要发进聊天。</p>
      <p><a href="https://console.cloud.tencent.com/cam" target="_blank" rel="noopener noreferrer">打开腾讯云访问管理</a> · <a href="https://console.cloud.tencent.com/tts/resourcebundle" target="_blank" rel="noopener noreferrer">查看赠送资源包</a>。仅试用赠送额度时，请在腾讯云保持后付费关闭；Harbour 无法代替平台确认剩余额度或账单。</p>
    </details>
    <section id="ttsVoiceLibrary"></section>
    <h3 class="settings-h voice-subhead">主 Provider（可选，原有声线保留）</h3>
    <div class="tts-provider-grid">
      ${providers.map((provider) => `<button class="tts-provider-card${provider.id === selectedProvider?.id ? " active" : ""}" data-tts-provider="${esc(provider.id)}" type="button">
        <img src="${esc(provider.icon)}" alt=""><span><b>${esc(provider.label)}</b><small>${esc(provider.description)}</small></span><i>${esc(provider.format)}</i>
      </button>`).join("")}
    </div>
    <div class="voice-field-grid tts-global-fields">
      <label class="mc-field voice-wide">接口 URL
        <input class="inp" id="ttsUrl" value="${esc(c.url || "")}" placeholder="https://tts.example.com/v1/audio/speech">
        <small>填完整合成端点；GPT-SoVITS 通常是 /tts，OpenAI-compatible 通常是 /v1/audio/speech。</small></label>
      <label class="mc-field">全局模型<input class="inp" id="ttsModel" value="${esc(c.model || "")}" placeholder="mimo-v2.5-tts-voicedesign / qwen-tts / tts-1"></label>
      <label class="mc-field">默认 Voice<input class="inp" id="ttsVoice" value="${esc(c.voice || "")}" placeholder="alloy / speaker-id"></label>
      <label class="mc-field">音频格式<input class="inp" id="ttsExt" value="${esc(c.ext || selectedProvider?.defaultExt || "wav")}" placeholder="wav / mp3"></label>
      <label class="mc-field voice-wide">鉴权 Headers（${c.headersConfigured ? "已配置；留空保持" : "未配置"}）
        <input class="inp" id="ttsHeaders" type="password" autocomplete="new-password" placeholder="Authorization: Bearer ...">
        <label class="voice-clear"><input id="ttsClearHeaders" type="checkbox"> 清除现有 Headers</label></label>
    </div>
    <details class="voice-advanced"><summary>超时、大小与缓存</summary>
      <div class="voice-limit-grid tts-limit-grid">
        <label class="mc-field">超时 ms<input class="inp" id="ttsTimeout" type="number" min="1000" value="${Number(c.timeoutMs) || 60000}"></label>
        <label class="mc-field">最大音频 MB<input class="inp" id="ttsMaxMb" type="number" min="1" value="${Number(c.maxAudioMb) || 25}"></label>
        <label class="mc-field">缓存上限 MB<input class="inp" id="ttsCacheMaxMb" type="number" min="16" value="${Number(c.cacheMaxMb) || 512}"></label>
        <label class="mc-field tts-cache-switch">本机缓存<label class="voice-toggle"><input id="ttsCacheEnabled" type="checkbox" ${c.cacheEnabled !== false ? "checked" : ""}><span>启用内容寻址缓存</span></label></label>
      </div>
    </details>
    <h3 class="settings-h voice-subhead">角色声线</h3>
    <div class="tts-profile-list">${characters.length ? characters.map(profileCard).join("") : `<div class="empty">尚无 main-* 角色</div>`}</div>
    <div class="tts-test-strip">
      <label class="mc-field">试听角色<select class="inp" id="ttsTestCompanion">${characters.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("")}</select></label>
      <label class="mc-field tts-test-text">试听文本<input class="inp" id="ttsTestText" value="今天也一起出发吧。"></label>
      <div class="tts-preview-actions">
        <button class="btn ghost" id="ttsTest" type="button">试听已保存配置</button>
        <button class="btn ghost" id="ttsTencentTest" type="button">仅试听腾讯备用</button>
      </div>
    </div>
    <div class="voice-actions">
      <button class="btn primary" id="ttsSave">保存并热生效</button>
      <span class="muted" id="ttsActionStatus">无需重启 Harbour；不会在本机启动模型</span>
    </div>`;

  const applyProvider = (id, fillDefaults = false) => {
    selectedProvider = providers.find((item) => item.id === id) || selectedProvider;
    pane.querySelectorAll("[data-tts-provider]").forEach((node) => node.classList.toggle("active", node.dataset.ttsProvider === selectedProvider?.id));
    if (fillDefaults && selectedProvider) {
      if (!$("#ttsModel").value.trim() && selectedProvider.defaultModel) $("#ttsModel").value = selectedProvider.defaultModel;
      if (!$("#ttsExt").value.trim() && selectedProvider.defaultExt) $("#ttsExt").value = selectedProvider.defaultExt;
      if (!$("#ttsUrl").value.trim() && selectedProvider.defaultUrl) $("#ttsUrl").value = selectedProvider.defaultUrl;
    }
  };
  pane.querySelectorAll("[data-tts-provider]").forEach((button) => button.addEventListener("click", () => applyProvider(button.dataset.ttsProvider, true)));

  $("#ttsSave").addEventListener("click", async () => {
    const button = $("#ttsSave");
    button.disabled = true;
    $("#ttsActionStatus").textContent = "正在保存…";
    try {
      const profilesOut = { ...profiles };
      pane.querySelectorAll("[data-tts-profile]").forEach((card) => {
        const value = {};
        card.querySelectorAll("[data-tts-field]").forEach((input) => {
          const raw = input.value.trim();
          if (input.dataset.ttsField === "speed") value.speed = Number(raw) || 1;
          else if (raw) value[input.dataset.ttsField] = raw;
        });
        profilesOut[card.dataset.ttsProfile] = value;
      });
      const headers = $("#ttsHeaders").value.trim();
      await api("/api/tts/config", { method: "POST", body: JSON.stringify({
        enabled: $("#ttsEnabled").checked,
        provider: selectedProvider?.id || c.provider || "custom-json",
        format: selectedProvider?.format || c.format || "json",
        url: $("#ttsUrl").value,
        model: $("#ttsModel").value,
        voice: $("#ttsVoice").value,
        ext: $("#ttsExt").value,
        ...(headers ? { headers } : {}),
        clearHeaders: $("#ttsClearHeaders").checked,
        timeoutMs: Number($("#ttsTimeout").value),
        maxAudioMb: Number($("#ttsMaxMb").value),
        cacheEnabled: $("#ttsCacheEnabled").checked,
        cacheMaxMb: Number($("#ttsCacheMaxMb").value),
        profiles: profilesOut,
        tencentFallback: {
          enabled: $("#ttsTencentEnabled").checked,
          secretId: $("#ttsTencentId").value.trim(),
          secretKey: $("#ttsTencentKey").value.trim(),
          clearCredentials: $("#ttsTencentClear").checked,
        },
      }) });
      $("#ttsTencentId").value = "";
      $("#ttsTencentKey").value = "";
      toast("TTS 配置已保存并热生效");
      renderSettingsVoice($("#settingsPane"));
    } catch (e) {
      $("#ttsActionStatus").textContent = e.message;
      toast(e.message, true);
      button.disabled = false;
    }
  });

  const previewTts = async (target) => {
    const buttons = [$("#ttsTest"), $("#ttsTencentTest")];
    buttons.forEach((button) => { button.disabled = true; });
    $("#ttsActionStatus").textContent = "正在请求远端语音…";
    try {
      const token = authToken();
      const response = await fetch("/api/tts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "x-harbour-token": token } : {}) },
        body: JSON.stringify({ target, companionId: $("#ttsTestCompanion").value, text: $("#ttsTestText").value }),
      });
      if (!response.ok) {
        const failed = await response.json().catch(() => ({}));
        if (response.status === 401) promptLogin();
        throw new Error(failed.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (ttsPreviewAudio) { ttsPreviewAudio.pause(); ttsPreviewAudio = null; }
      if (ttsPreviewUrl) URL.revokeObjectURL(ttsPreviewUrl);
      ttsPreviewUrl = URL.createObjectURL(blob);
      ttsPreviewAudio = new Audio(ttsPreviewUrl);
      const cache = response.headers.get("x-harbour-tts-cache") || "miss";
      ttsPreviewAudio.addEventListener("ended", () => {
        URL.revokeObjectURL(ttsPreviewUrl);
        ttsPreviewUrl = "";
        ttsPreviewAudio = null;
      }, { once: true });
      await ttsPreviewAudio.play();
      $("#ttsActionStatus").textContent = `正在播放 · ${response.headers.get("x-harbour-tts-provider") || "remote"} · cache ${cache}`;
    } catch (e) {
      $("#ttsActionStatus").textContent = `试听失败 · ${e.message}`;
      toast(e.message, true);
    } finally { buttons.forEach((button) => { button.disabled = false; }); }
  };
  $("#ttsTest").addEventListener("click", () => previewTts("gateway"));
  $("#ttsTencentTest").addEventListener("click", () => previewTts("tencent-fallback"));
}

// QQ 只接腾讯 QQ 开放平台官方 Bot；一个 botKey 固定绑定一个 Main，身份与 session 不跨应用复用。
async function renderQQConfig() {
  const box = $("#qqCard");
  if (!box) return;
  try {
    const q = await api("/api/channels/qq");
    const bots = q.bots || [];
    const agents = q.availableAgents || [];
    const botEditor = (bot) => {
      const awaitingOwner = bot.active && Number(bot.persistedOwnerCount || 0) === 0;
      const connectionStatus = bot.active
        ? awaitingOwner ? "● 已连接 · 待绑定" : "● 已连接"
        : bot.configured ? "◌ 待重启/连接失败" : "○ 未配置";
      return `
      <section class="dc-bot-editor qq-bot-editor" data-qq-bot="${esc(bot.key)}">
        <div class="row dc-bot-head">
          <b>${esc(bot.label || bot.key)}</b><code>${esc(bot.key)}</code>
          <span class="muted" style="margin-left:auto">${connectionStatus}</span>
          <button class="btn-mini danger" data-qq-delete="${esc(bot.key)}">删除</button>
        </div>
        ${awaitingOwner ? `<div class="channel-official-note"><b>Gateway 在线，但还不能聊天</b><span>当前没有主人 OpenID；绑定前的普通私聊不会进入 Agent，也不会创建 MAIN CHAT / HISTORY session。</span></div>` : ""}
        <div class="dc-bot-grid">
          <label class="mc-field">显示名
            <input class="inp" data-qq-field="label" value="${esc(bot.label || "QQ Bot")}" placeholder="Elaina · QQ"></label>
          <label class="mc-field">绑定 Agent
            <select class="inp" data-qq-field="agentName">${agents.map((agent) => `<option value="${esc(agent)}" ${agent === bot.agentName ? "selected" : ""}>${esc(agent)}</option>`).join("")}</select></label>
          <label class="mc-field">AppID
            <input class="inp" data-qq-field="appId" value="${esc(bot.appId || "")}" inputmode="numeric" placeholder="QQ 开放平台 AppID"></label>
          <label class="mc-field">AppSecret（留空不改；${esc(bot.appSecretMask || "未设置")}）
            <input class="inp" data-qq-field="appSecret" type="password" autocomplete="new-password" placeholder="留空保持不变"></label>
        </div>
        <label class="mc-field" style="margin-top:10px">使用白名单（sender/group openid，逗号分隔；主人绑定不受此项限制）
          <textarea class="inp" data-qq-field="allowlist" rows="2" placeholder="空 = 除配对命令外不放行其它用户">${esc(bot.allowlist || "")}</textarea></label>
        <div class="qq-toggle-grid">
          <label class="qq-check"><input type="checkbox" data-qq-field="requireMention" ${bot.requireMention ? "checked" : ""}> <span><b>群聊必须 @ 机器人</b><small>推荐开启；私聊始终可直接说话</small></span></label>
          <label class="qq-check"><input type="checkbox" data-qq-field="markdownSupport" ${bot.markdownSupport ? "checked" : ""}> <span><b>启用 QQ Markdown</b><small>仅在该机器人已获平台权限时开启</small></span></label>
        </div>
        <div class="dc-global-config qq-owner-config">
          <div class="row"><b>此 Bot 的主人身份</b><span class="pill" style="margin-left:auto">已识别 ${Number(bot.persistedOwnerCount || 0)} 个 OpenID</span></div>
          <p class="muted" style="font-size:13px;margin:8px 0 10px">设置一次性配对码并重启后，用你的 QQ 私聊这个机器人发送 <code>/bind 配对码</code>。OpenID 只属于当前 botKey，不会串到另一个角色。</p>
          <div class="dc-bot-grid">
            <label class="mc-field">一次性配对码（${bot.pairingConfigured ? "已设置；留空不改" : "尚未设置"}）
              <span class="field-inline"><input class="inp" data-qq-field="pairingCode" type="password" autocomplete="new-password" placeholder="至少 8 位"><button class="btn-mini" data-qq-generate="${esc(bot.key)}" type="button">随机生成</button></span></label>
            <label class="mc-field">手工主人 OpenID（可选，逗号分隔）
              <input class="inp" data-qq-field="ownerOpenids" value="${esc(bot.ownerOpenids || "")}" placeholder="通常留空，优先用配对流程"></label>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn" data-qq-save="${esc(bot.key)}">保存此 Bot${bot.hotAllowlist ? "（白名单热生效）" : "（重启生效）"}</button>
            <button class="btn ghost" data-qq-clear-pairing="${esc(bot.key)}" ${bot.pairingConfigured ? "" : "disabled"}>清除配对码</button>
          </div>
        </div>
      </section>`;
    };

    box.innerHTML = `
      <div class="row">
        <div class="kv"><span class="k">Gateway</span><span class="val">${q.configuredCount || 0} 个已配置 · ${(q.activeBotKeys || []).length} 个已连接</span></div>
        <button class="btn" id="qqAddBot" style="margin-left:auto">＋ 新增 Bot</button>
        <a class="btn ghost" href="${esc(q.platformUrl || "https://q.qq.com/")}" target="_blank" rel="noreferrer">打开 QQ 开放平台 ↗</a>
      </div>
      <div class="channel-official-note">
        <b>只使用官方 QQ Bot</b>
        <span>每个开放平台应用固定绑定一个 Main。AppSecret 只写本机 .env；数字 QQ 号和登录密码不会进入 Harbour。</span>
      </div>
      ${bots.map(botEditor).join("")}
      <div class="muted" style="font-size:12px;margin-top:10px">两个 Bot 各自维护 Gateway、OpenID 主人绑定、白名单和跨轮 session；任意一个连接失败不会拖垮另一个。凭据或身份改动需重启，在线时白名单可热生效。</div>`;

    $("#qqAddBot").addEventListener("click", async () => {
      const rawKey = await harbourPrompt("使用小写字母、数字、下划线或短横线。", "", {
        title: "新增 QQ Bot", inputLabel: "Bot 标识", placeholder: "例如 elaina / aemeath",
      });
      if (rawKey == null || !rawKey.trim()) return;
      const key = rawKey.trim().toLowerCase();
      const suggested = agents.includes(`main-${key}`) ? `main-${key}` : (agents[0] || "");
      const agentName = await harbourPrompt("这个 Bot 收到消息后固定交给哪个 Main Agent？", suggested, {
        title: "绑定 Harbour Agent", inputLabel: "Agent 名称", placeholder: "例如 main-elaina",
      });
      if (agentName == null || !agentName.trim()) return;
      try {
        await api("/api/channels/qq", { method: "POST", body: JSON.stringify({ botKey: key, label: key, agentName: agentName.trim() }) });
        toast("QQ Bot 配置已新增；填入 AppID/AppSecret 后重启生效");
        renderQQConfig();
      } catch (e) { toast(e.message, true); }
    });

    box.querySelectorAll("[data-qq-generate]").forEach((button) => button.addEventListener("click", () => {
      const editor = button.closest("[data-qq-bot]");
      const input = editor.querySelector('[data-qq-field="pairingCode"]');
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      input.value = `HB-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      input.type = "text";
    }));

    box.querySelectorAll("[data-qq-save]").forEach((button) => button.addEventListener("click", async () => {
      const editor = button.closest("[data-qq-bot]");
      const field = (name) => editor.querySelector(`[data-qq-field="${name}"]`);
      try {
        const r = await api("/api/channels/qq", { method: "POST", body: JSON.stringify({
          botKey: editor.dataset.qqBot,
          label: field("label").value,
          agentName: field("agentName").value,
          appId: field("appId").value,
          appSecret: field("appSecret").value,
          allowlist: field("allowlist").value,
          ownerOpenids: field("ownerOpenids").value,
          pairingCode: field("pairingCode").value,
          requireMention: field("requireMention").checked,
          markdownSupport: field("markdownSupport").checked,
        }) });
        toast(r.hot && !r.restartRequired ? "QQ 白名单已热生效" : "QQ Bot 配置已保存；重启 Harbour 后生效");
        renderQQConfig();
      } catch (e) { toast(e.message, true); }
    }));

    box.querySelectorAll("[data-qq-clear-pairing]").forEach((button) => button.addEventListener("click", async () => {
      const key = button.dataset.qqClearPairing;
      if (!await harbourConfirm(`QQ Bot「${key}」当前的一次性配对码将失效。`, {
        title: "清除配对码？", detail: "已经保存的主人 OpenID 绑定不会删除。", confirmLabel: "清除配对码", tone: "warning",
      })) return;
      try {
        await api("/api/channels/qq", { method: "POST", body: JSON.stringify({ botKey: key, clearPairingCode: true }) });
        toast("配对码已清除；已有主人绑定保留");
        renderQQConfig();
      } catch (e) { toast(e.message, true); }
    }));

    box.querySelectorAll("[data-qq-delete]").forEach((button) => button.addEventListener("click", async () => {
      const key = button.dataset.qqDelete;
      if (!await harbourConfirm(`QQ Bot「${key}」的配置将被删除。`, {
        title: "删除 QQ Bot？", detail: "AppSecret 会从 .env 清空；主人 OpenID 绑定记录仍会保留。重启 Harbour 后该 Bot 断开。", confirmLabel: "删除 Bot", tone: "danger",
      })) return;
      try {
        await api(`/api/channels/qq?botKey=${encodeURIComponent(key)}`, { method: "DELETE" });
        toast("QQ Bot 配置已删除；重启后断开");
        renderQQConfig();
      } catch (e) { toast(e.message, true); }
    }));
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}

// —— 模型管理：per-agent 默认 + API 连接/容灾 + 逐模型 effort/compact ——
function renderSettingsModels(pane, s) {
  pane.innerHTML = `
    <section class="settings-section">${settingsHeadingHtml("模型管理", "◉", "连接、运行默认与上下文策略，在这里统一管理。")}
    <div class="settings-section-body">
    <div class="set-row">
      <div class="set-row-main">
        <div class="set-row-title">MOCK 模式</div>
        <div class="set-row-sub">开启后使用本地测试剧本，不消耗模型额度；关闭后使用已配置的真实端点。</div>
      </div>
      <div class="set-row-ctrl"><div class="switch ${s.backends.mock ? "on" : ""}" id="mockSwitch" title="MOCK 模式"><span class="track"><span class="knob"></span></span></div></div>
    </div>
    <div class="settings-note">
      日常路由按 agent 精确绑定“API 连接 + 模型”，连接之间没有主次；Main Chat 手动选择只覆盖当前会话。
      下方“兼容默认 / 容灾 #”只服务尚未绑定精确模型的旧配置与端点故障切换，不代表日常优先级。
    </div></div></section>
    <section class="settings-section">${settingsHeadingHtml("运行时连接", "⌁", "查看连接状态、认证方式与已发现的模型。")}
    <div class="settings-section-body">
    <div class="model-architecture-note"><span><b>Runtime</b> Agent 循环</span><i>→</i><span><b>Protocol</b> 网络消息格式</span><i>→</i><span><b>Auth</b> 认证来源</span></div>
    <div id="modelConnections" class="model-connection-rail"><div class="muted">加载中…</div></div>
    </div></section>
    <section class="settings-section">${settingsHeadingHtml("Agent 默认模型 / Mode", "◎", "热生效 · 每条会话仍可单独选择模型与权限模式。")}
    <div class="settings-section-body">
    <div id="agentModelDefaults" class="agent-model-list"><div class="muted">加载中…</div></div>
    </div></section>
    <section class="settings-section">${settingsHeadingHtml("API 连接与容灾", "⇄", "连接改动需要重启服务；模型目录可独立刷新。")}
    <div class="settings-section-body">
    <div id="modelSlots"><div class="muted">加载中…</div></div>
    </div></section>
    <section class="settings-section">${settingsHeadingHtml("逐模型 · effort / 压缩触发线", "◴", "热生效 · 设置会用于下一轮请求的上下文预检。")}
    <div class="settings-section-body">
    <div id="modelCfgList" class="model-cfg-list"><div class="muted">加载中…</div></div>
    <div class="muted" style="font-size:12.5px;margin-top:10px">
      <b>effort</b>=思考力度（Claude 路径为 <b>off / low≈2K / medium≈8K / high≈16K</b> thinking 上限；Codex 使用模型原生档位）。
      未显式覆盖时 <b>main-* 默认 high</b>，其余 Agent 默认 medium。
      <b>压缩触发线覆盖</b>：此模型的数值优先于环境配置；留空移除此覆盖，采用环境配置或自动 80% 策略。
      自动限额的 Main 默认取<b>实际模型窗口 × 80%</b>；手动 Agent 默认取<b>指定限额与模型窗口较小值 × 80%</b>。
      模型窗口另外预留 <b>5% 给输出</b>，最终触发线不会超过有效输入安全上限。
      压缩预检会计入 system、工具与本轮输入；界面用量是已保存会话的估算，并非精确计数或工具循环实时用量。改动即存，下一轮预检生效，不立即发起压缩调用。
    </div></div></section>`;
  $("#mockSwitch").addEventListener("click", async () => {
    const next = !$("#mockSwitch").classList.contains("on");
    try {
      const r = await api("/api/mock", { method: "POST", body: JSON.stringify({ enabled: next }) });
      $("#mockSwitch").classList.toggle("on", r.mockMode); toast(`mock = ${r.mockMode ? "ON" : "OFF"}`);
    } catch (e) { toast(e.message, true); }
  });
  renderAgentModelDefaults();
  renderModelSlots();
  renderModelConfigs();
}

async function renderAgentModelDefaults() {
  const box = $("#agentModelDefaults");
  if (!box) return;
  try {
    const { agents = [], models = [] } = await api("/api/agent-defaults");
    const options = groupedModelOptionsHtml(models);
    box.innerHTML = agents.map((a) => {
      const manifest = models.find((m) => m.modelRef === a.manifestModelRef)?.model || a.manifestModelRef;
      return `<div class="agent-model-row">
        <div class="set-row-main"><div class="set-row-title mono">${esc(a.name)}</div><div class="set-row-sub">${esc(a.description || "—")}</div></div>
        <label class="mc-field">默认 API + 模型
          <select class="inp" data-agent-model="${esc(a.name)}">
            <option value="">CLAUDE.md · ${esc(manifest)}</option>${options}
          </select>
        </label>
        <label class="mc-field">默认 MODE
          <select class="inp" data-agent-mode="${esc(a.name)}">${permissionModeOverrideOptionsHtml(a.manifestPermissionMode)}</select>
        </label>
      </div>`;
    }).join("") || `<div class="muted">没有 agent。</div>`;
    box.querySelectorAll("[data-agent-model]").forEach((sel) => {
      const a = agents.find((x) => x.name === sel.dataset.agentModel);
      sel.value = a?.overrideModelRef || "";
      sel.addEventListener("change", () => saveAgentRuntimeDefault(sel.dataset.agentModel, { modelRef: sel.value || null }, renderAgentModelDefaults));
    });
    box.querySelectorAll("[data-agent-mode]").forEach((sel) => {
      const a = agents.find((x) => x.name === sel.dataset.agentMode);
      sel.value = a?.overridePermissionMode || "";
      sel.addEventListener("change", () => saveAgentRuntimeDefault(sel.dataset.agentMode, { permissionMode: sel.value || null }, renderAgentModelDefaults));
    });
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}

// N 个 API 连接槽：每槽是一把 key + 一个端点 + 多个模型；默认模型只决定 router 自动选择。
// Main Chat 会把所有槽的已启用模型展平成一个选择器，不把 key 和 model 拆成两栏。
function modelConnectionCardHtml(connection) {
  const ready = connection.runtimeId === "codex-app-server" ? connection.ready : connection.configured;
  const state = ready ? "ready" : connection.configured ? "warn" : "off";
  const stateText = ready ? "可用" : connection.configured ? "等待认证 / 探测" : "未配置";
  const accent = /^#[0-9a-f]{6}$/i.test(connection.providerAccent || "") ? connection.providerAccent : "#8b8190";
  const component = connection.component;
  const componentText = component ? `Codex ${component.version} · ${
    component.status === "current" || component.status === "updated" ? "已核对最新稳定版" :
    component.status === "failed" ? "升级未完成，沿用原版" : component.status === "skipped" ? "手动维护" : "待检查更新"}` : "";
  return `<article class="model-connection-card ${state}" style="--provider-accent:${accent}" ${connection.editable ? `data-connection-slot="${esc(connection.id)}"` : ""}>
    <div class="model-connection-top">
      <img src="${esc(connection.providerIcon || "/assets/providers/custom.svg")}" alt="" class="provider-icon">
      <div class="model-connection-name"><b>${esc(connection.providerLabel || connection.label)}</b><span>${esc(connection.label || connection.id)}</span></div>
      <span class="connection-state"><i></i>${esc(stateText)}</span>
    </div>
    <div class="model-connection-model mono">${esc(connection.model || "未发现模型")}</div>
    <div class="model-route-stack">
      <span title="${esc(connection.runtimeLabel || "Agent 循环由谁驱动")}"><small>RUNTIME</small>${esc(connection.runtimeLabel || "—")}</span>
      <span title="${esc(connection.transportLabel || "网络请求/消息格式")}"><small>PROTOCOL</small>${esc(connection.transportLabel || "—")}</span>
      <span title="${esc(connection.authLabel || "认证凭据来源")}"><small>AUTH</small>${esc(connection.authLabel || "—")}</span>
    </div>
    ${connection.runtimeId === "codex-app-server" ? `<footer class="model-catalog-footer"><div class="model-catalog-meta"><b>${(connection.models || []).filter((m) => m.enabled && m.available).length} 个可用模型</b>${componentText ? `<span title="${esc([component.message, component.checkedAt ? `检查于 ${formatDate(component.checkedAt)}` : ""].filter(Boolean).join(" · "))}">${esc(componentText)}</span>` : ""}<span>${connection.catalog?.updatedAt ? `目录更新于 ${timeHtml(connection.catalog.updatedAt)}` : "尚未刷新目录"}</span></div><button class="btn-mini" type="button" data-codex-catalog-refresh title="检查最新稳定版 Codex，验证后更新组件与模型目录；不打断当前任务">⟳ 更新组件与目录</button></footer>` : ""}
    ${component?.status === "failed" ? `<div class="model-connection-error">${esc(component.message || "组件升级失败，沿用原版")}</div>` : ""}
    ${connection.error ? `<div class="model-connection-error">${esc(connection.error)}</div>` : ""}
  </article>`;
}

async function renderModelSlots() {
  const box = $("#modelSlots");
  const overview = $("#modelConnections");
  if (!box) return;
  try {
    const { slots = [], connections = slots } = await api("/api/models/env");
    if (overview) {
      overview.innerHTML = connections.map(modelConnectionCardHtml).join("") || `<div class="muted">尚未配置模型连接。</div>`;
      overview.querySelector("[data-codex-catalog-refresh]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = "检查并更新中…";
        void refreshSlotModels("codex-harness");
      });
      overview.querySelectorAll("[data-connection-slot]").forEach((card) => card.addEventListener("click", () => {
        const target = document.querySelector(`.model-slot[data-slot-id="${card.dataset.connectionSlot}"]`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.classList.add("pulse-focus");
        setTimeout(() => target?.classList.remove("pulse-focus"), 900);
      }));
    }
    box.innerHTML = slots.map((sl) => `
      <div class="model-slot" data-slot-id="${esc(sl.id)}" style="--provider-accent:${/^#[0-9a-f]{6}$/i.test(sl.providerAccent || "") ? sl.providerAccent : "#8b8190"}">
        <div class="model-slot-head">
          <img src="${esc(sl.providerIcon || "/assets/providers/custom.svg")}" alt="" class="provider-icon">
          <div class="model-slot-title"><b>${esc(sl.label)}</b><span>${esc(sl.providerLabel || "Custom Endpoint")} · ${esc(sl.model)}</span></div>
          <div class="model-slot-badges">
            <span class="badge">${sl.primary ? "兼容默认" : "容灾 #" + sl.index}</span>
            <span class="badge ${sl.configured ? "" : "muted"}">${sl.configured ? "已配置" : "未配置"}</span>
          </div>
          ${sl.primary ? "" : `<div class="model-slot-actions"><button class="btn-mini" data-slot-primary="${esc(sl.id)}">设为兼容默认</button><button class="btn-mini" data-slot-del="${esc(sl.id)}">删除</button></div>`}
        </div>
        <div class="model-slot-route"><span>${esc(sl.runtimeLabel || "Claude SDK")}</span><i>→</i><span>${esc(sl.transportLabel || "Anthropic Messages")}</span><i>→</i><span>${esc(sl.authLabel || ".env")}</span></div>
        <details class="model-slot-advanced">
          <summary><span>连接详情与模型目录</span><small>${(sl.models || []).filter((m) => m.enabled && m.available).length} 个已启用模型 · id=${esc(sl.id)}</small></summary>
          <div class="model-slot-grid">
            <label class="mc-field">标签<input class="inp" data-f="label" value="${esc(sl.label)}"></label>
            <label class="mc-field">连接默认 / 容灾 model id${sl.models?.length
              ? `<select class="inp" data-f="model">${sl.models.map((m) => `<option value="${esc(m.id)}" ${m.id === sl.model ? "selected" : ""}>${esc(m.label || m.id)}${m.available ? "" : "（已下线）"}</option>`).join("")}</select>`
              : `<input class="inp" data-f="model" value="${esc(sl.model)}" placeholder="kimi-for-coding">`}</label>
            <label class="mc-field">Base URL<input class="inp" data-f="baseURL" value="${esc(sl.baseURL)}" placeholder="https://api.kimi.com/coding"></label>
            <label class="mc-field">密钥环境变量<input class="inp" data-f="keyEnv" value="${esc(sl.keyEnv)}" placeholder="ANTHROPIC_AUTH_TOKEN"></label>
            <label class="mc-field">认证风格
              <select class="inp" data-f="keyKind"><option value="auth" ${sl.keyKind === "auth" ? "selected" : ""}>Bearer（auth token）</option><option value="api" ${sl.keyKind === "api" ? "selected" : ""}>x-api-key</option></select></label>
            <label class="mc-field">密钥 <span class="muted">（留空不改；${esc(sl.keyMask || "未设置")}）</span><input class="inp" type="password" data-f="key" placeholder="留空保持不变"></label>
          </div>
          <div class="model-catalog-box">
            <div class="model-catalog-head"><b>Main Chat 可选模型</b><button class="btn-mini" data-slot-refresh="${esc(sl.id)}">刷新 /models</button><span>${sl.catalog?.updatedAt ? `更新于 ${timeHtml(sl.catalog.updatedAt)}` : "尚未刷新"}${sl.catalog?.error ? ` · ${esc(sl.catalog.error)}` : ""}</span></div>
            <div class="model-catalog-list">
              ${(sl.models || []).length ? sl.models.map((m) => `<label class="model-catalog-item ${m.available ? "" : "unavailable"}" title="${esc(m.id)}">
                <input type="checkbox" data-slot-model-toggle="${esc(sl.id)}" data-model-id="${esc(m.id)}" ${m.enabled ? "checked" : ""} ${m.id === sl.model || !m.available ? "disabled" : ""}>
                <span>${esc(m.label || m.id)}</span>${m.id === sl.model ? `<small>默认</small>` : ""}${m.available ? "" : `<small>已下线</small>`}
              </label>`).join("") : `<span class="muted">暂无目录；填写默认模型保存，或刷新 Provider 目录。</span>`}
            </div>
          </div>
          <div class="model-slot-save"><button class="btn" data-slot-save="${esc(sl.id)}">保存连接与默认模型（重启生效）</button></div>
        </details>
      </div>`).join("") + `
      <details class="model-slot model-slot-add">
        <summary><b>＋ 新增 Claude SDK 连接</b><span>追加到现有容灾链末尾</span></summary>
        <div class="model-slot-grid">
          <label class="mc-field">槽 id<input class="inp" id="newSlotId" placeholder="kimi2"></label>
          <label class="mc-field">标签<input class="inp" id="newSlotLabel" placeholder="第三端点"></label>
          <label class="mc-field">model id<input class="inp" id="newSlotModel" placeholder="kimi-k2.6"></label>
          <label class="mc-field">Base URL<input class="inp" id="newSlotUrl" placeholder="https://..."></label>
          <label class="mc-field">密钥环境变量<input class="inp" id="newSlotKeyEnv" placeholder="留空自动 MODEL_&lt;ID&gt;_AUTH_TOKEN"></label>
          <label class="mc-field">密钥<input class="inp" type="password" id="newSlotKey" placeholder="写入 .env"></label>
        </div>
        <div class="model-slot-save"><button class="btn primary" id="addSlot">新增连接（重启生效）</button></div>
      </details>`;
    box.querySelectorAll("[data-slot-save]").forEach((b) => b.addEventListener("click", () => saveModelSlot(b.dataset.slotSave)));
    box.querySelectorAll("[data-slot-refresh]").forEach((b) => b.addEventListener("click", () => refreshSlotModels(b.dataset.slotRefresh)));
    box.querySelectorAll("[data-slot-model-toggle]").forEach((el) => el.addEventListener("change", () => toggleSlotModel(el.dataset.slotModelToggle, el.dataset.modelId, el.checked)));
    box.querySelectorAll("[data-slot-primary]").forEach((b) => b.addEventListener("click", () => setPrimaryModelSlot(b.dataset.slotPrimary)));
    box.querySelectorAll("[data-slot-del]").forEach((b) => b.addEventListener("click", () => deleteModelSlot(b.dataset.slotDel)));
    $("#addSlot")?.addEventListener("click", addModelSlot);
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    if (overview) overview.innerHTML = `<div class="muted">连接概览加载失败。</div>`;
  }
}
async function saveModelSlot(id) {
  const card = document.querySelector(`.model-slot[data-slot-id="${id}"]`);
  if (!card) return;
  const f = (name) => card.querySelector(`[data-f="${name}"]`)?.value ?? "";
  const slot = { id, label: f("label").trim(), model: f("model").trim(), baseURL: f("baseURL").trim(), keyEnv: f("keyEnv").trim(), keyKind: f("keyKind") };
  const key = f("key");
  try {
    await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "upsert", slot, ...(key ? { key } : {}) }) });
    toast("已保存 —— 重启后端后生效");
    renderModelSlots();
  } catch (e) { toast(e.message, true); }
}
async function addModelSlot() {
  const id = $("#newSlotId").value.trim();
  if (!id) return toast("请填槽 id", true);
  const slot = { id, label: $("#newSlotLabel").value.trim() || id, model: $("#newSlotModel").value.trim() || "default", baseURL: $("#newSlotUrl").value.trim(), keyEnv: $("#newSlotKeyEnv").value.trim(), keyKind: "auth" };
  const key = $("#newSlotKey").value;
  try {
    await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "upsert", slot, ...(key ? { key } : {}) }) });
    toast("已新增槽 —— 重启后端后生效");
    renderModelSlots();
  } catch (e) { toast(e.message, true); }
}
async function deleteModelSlot(id) {
  if (!await harbourConfirm(`模型连接槽「${id}」将从配置中删除。`, {
    title: "删除模型连接？", detail: "此改动会在重启 Harbour 后生效。", confirmLabel: "删除连接", tone: "danger",
  })) return;
  try {
    await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "delete", id }) });
    toast("已删除槽 —— 重启后端后生效");
    renderModelSlots();
  } catch (e) { toast(e.message, true); }
}
async function setPrimaryModelSlot(id) {
  if (!await harbourConfirm(`模型槽「${id}」将成为兼容默认连接。`, {
    title: "切换兼容默认连接？", detail: "只影响旧别名与容灾入口，不会修改各 Agent 的精确默认模型；重启后生效。", confirmLabel: "设为默认", tone: "warning",
  })) return;
  try {
    const r = await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "set-primary", id }) });
    toast(r.restartRequired ? "兼容默认连接已切换 —— 重启 Harbour 后生效" : "该槽已经是兼容默认连接");
    renderModelSlots();
  } catch (e) { toast(e.message, true); }
}
async function refreshSlotModels(id) {
  try {
    const r = await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "refresh-models", id }) });
    const message = r.skipped ? "该端点没有可安全发现的模型目录，已保留手工配置" : `模型目录已刷新${r.added ? `，新增 ${r.added} 个` : ""}`;
    toast(r.warnings?.length ? `${message}；${r.warnings.join("；")}` : `${message}${r.component?.version ? ` · Codex ${r.component.version}` : ""}`, !!r.warnings?.length);
    await renderModelSlots();
    await renderModelConfigs();
    await fillChatModels();
  } catch (e) { toast(e.message, true); await renderModelSlots(); }
}
async function toggleSlotModel(id, modelId, enabled) {
  try {
    await api("/api/models/env", { method: "POST", body: JSON.stringify({ action: "set-model-enabled", id, modelId, enabled }) });
    await renderModelSlots();
    await renderModelConfigs();
    await fillChatModels();
  } catch (e) { toast(e.message, true); await renderModelSlots(); }
}

// —— 配置字段：data/config.json KV，可增删改（备忘 + agent 经 get_config 按需读）——
function renderSettingsConfig(pane) {
  pane.innerHTML = `
    <h3 class="settings-h">配置信息字段</h3>
    <div class="settings-note">
      通用键值备忘（如 <span class="mono">ssh_host</span>、<span class="mono">deploy_path</span>），存 data/config.json。
      <b>两用</b>：这里当备忘查看/改；agent 经受白名单约束的 <span class="mono">get_config(key)</span> 工具按需读（值不常驻上下文，要用需在 agent 的 tools 里声明 get_config）。
    </div>
    <div id="configList"><div class="muted">加载中…</div></div>
    <div class="config-add row" style="gap:8px;margin-top:14px">
      <input class="inp" id="cfgNewKey" placeholder="字段名（key）" style="flex:1">
      <input class="inp" id="cfgNewVal" placeholder="值（value）" style="flex:2">
      <button class="btn primary" id="cfgAdd">+ 添加</button>
    </div>`;
  renderConfigList();
  $("#cfgAdd").addEventListener("click", async () => {
    const key = $("#cfgNewKey").value.trim();
    if (!key) return toast("请填字段名", true);
    await saveConfigField(key, $("#cfgNewVal").value);
    $("#cfgNewKey").value = ""; $("#cfgNewVal").value = "";
  });
}
async function renderConfigList() {
  const box = $("#configList");
  if (!box) return;
  try {
    const { config } = await api("/api/config");
    const keys = Object.keys(config);
    if (!keys.length) { box.innerHTML = `<div class="muted">暂无字段。用下方表单添加第一条。</div>`; return; }
    box.innerHTML = keys.map((k) => `
      <div class="config-row">
        <span class="cfg-key mono">${esc(k)}</span>
        <input class="inp cfg-val" data-cfg-key="${esc(k)}" value="${esc(config[k])}">
        <button class="btn-mini" data-cfg-save="${esc(k)}">存</button>
        <button class="btn-mini" data-cfg-del="${esc(k)}">✕</button>
      </div>`).join("");
    box.querySelectorAll("[data-cfg-save]").forEach((b) =>
      b.addEventListener("click", () => saveConfigField(b.dataset.cfgSave, $(`[data-cfg-key="${b.dataset.cfgSave}"]`).value)));
    box.querySelectorAll("[data-cfg-del]").forEach((b) =>
      b.addEventListener("click", () => delConfigField(b.dataset.cfgDel)));
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}
async function saveConfigField(key, value) {
  try { await api("/api/config", { method: "POST", body: JSON.stringify({ key, value }) }); toast(`已存 ${key}`); renderConfigList(); }
  catch (e) { toast(e.message, true); }
}
async function delConfigField(key) {
  if (!await harbourConfirm(`配置字段「${key}」将被删除。`, {
    title: "删除配置字段？", confirmLabel: "删除", tone: "danger",
  })) return;
  try { await api(`/api/config?key=${encodeURIComponent(key)}`, { method: "DELETE" }); toast(`已删 ${key}`); renderConfigList(); }
  catch (e) { toast(e.message, true); }
}

// —— 系统：后端状态 + 能力控制 + 系统/会话（只读）+ 登出 ——
function renderSettingsSystem(pane, s) {
  const ctrl = s.control || {};
  const dot = (ok) => `<span class="stat-dot ${ok ? "ok" : "off"}"></span>`;
  pane.innerHTML = `
    <section class="settings-section">${settingsHeadingHtml("后端状态", "◉", "当前服务加载的连接状态；精确模型绑定请到“模型管理”查看。")}
    <div class="settings-section-body settings-status-grid">
    <div class="kv"><span class="k">主 API</span><span class="val">${dot(s.backends.claudeAgent && s.backends.claudeAgent.configured)}${s.backends.claudeAgent && s.backends.claudeAgent.configured ? esc((s.backends.claudeAgent.label || "") + " · " + (s.backends.claudeAgent.model || "configured")) : "未配置"}</span></div>
    <div class="kv"><span class="k">首个 fallback</span><span class="val">${dot(s.backends.fallback && s.backends.fallback.configured)}${s.backends.fallback && s.backends.fallback.configured ? esc((s.backends.fallback.label || "") + " · " + (s.backends.fallback.model || "configured")) : "未配置"}</span></div>
    <div class="kv"><span class="k">openrouter</span><span class="val">${dot(s.backends.openrouter.configured)}${s.backends.openrouter.configured ? "configured" : "no key"}</span></div>
    <div class="kv"><span class="k">claude-cli</span><span class="val">${dot(s.backends.claudeCli.enabled)}${s.backends.claudeCli.enabled ? "ENABLED ⚠" : "off"}</span></div>

    </div></section>
    <section class="settings-section">${settingsHeadingHtml("能力控制", "⌘", "隔离浏览器与本机桌面使用独立执行环境。")}
    <div class="settings-section-body">
    <div class="settings-caps">
      <div class="cap">
        <div class="cap-h">${dot(true)} 隔离浏览器 <span class="badge">browser_controller</span></div>
        <div class="kv"><span class="k">harness</span><span class="val mono">${esc(ctrl.browserHarnessBin || "browser-harness")}</span></div>
        <div class="kv"><span class="k">调试端口</span><span class="val mono">127.0.0.1:${esc(ctrl.chromeDebugPort ?? "9333")}</span></div>
        <div class="kv"><span class="k">headless</span><span class="val">${ctrl.chromeHeadless ? "ON" : "off（有头）"}</span></div>
        <div class="muted" style="font-size:12.5px">专用 Harbour Chrome + 独立 profile；绝不触碰主人日常 Chrome / 端口 9222。</div>
      </div>
      <div class="cap">
        <div class="cap-h">${dot(!!ctrl.desktopControl)} 桌面控制 <span class="badge">computer_user</span></div>
        <div class="kv"><span class="k">状态</span><span class="val">${ctrl.desktopControl ? "已启用 ⚠" : "默认全锁"}</span></div>
        <div class="muted" style="font-size:12.5px">真实鼠标/键盘；默认锁死，需 <span class="mono">ENABLE_DESKTOP_CONTROL</span> + 每步授权。Web 上的活优先派 browser_controller。</div>
      </div>
    </div>

    </div></section>
    <section class="settings-section">${settingsHeadingHtml("系统与会话", "▤", "服务概况、已挂载工具与当前客户端的访问状态。")}
    <div class="settings-section-body">
    <div class="settings-caps">
      <div>
        <div class="kv"><span class="k">name</span><span class="val">${esc(s.name)}</span></div>
        <div class="kv"><span class="k">uptime</span><span class="val">${fmtUptime(s.uptimeMs)}</span></div>
        <div class="kv"><span class="k">agents</span><span class="val">${s.agents.length}</span></div>
        <div class="kv"><span class="k">sessions</span><span class="val">${s.sessions && s.sessions.enabled ? (s.sessions.sessions + " 段 / " + s.sessions.keys + " key") : "未开启"}</span></div>
      </div>
      <div>
        <details class="settings-tools"><summary>已挂载工具 <span class="badge">${s.tools.length}</span></summary><div class="settings-tool-list">${s.tools.map((t) => `<code>${esc(t.name)}</code>`).join("")}</div></details>
        <div class="kv"><span class="k">访问令牌</span><span class="val">${authToken() ? "已保存（本浏览器）" : "未使用 / 本机直连"}</span></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost" id="logoutBtn">清除访问令牌并重载</button></div>
      </div>
    </div></div></section>`;
  const lo = $("#logoutBtn");
  if (lo) lo.addEventListener("click", () => { localStorage.removeItem("harbour-token"); toast("已清除令牌"); setTimeout(() => location.reload(), 400); });
}

// 逐模型配置卡：拉 /api/models 渲染 effort + 压缩触发线控件，改动即存。
async function renderModelConfigs() {
  const box = $("#modelCfgList");
  if (!box) return;
  try {
    const { models } = await api("/api/models");
    state.chat.models = (models || []).map((m) => m.modelRef);
    state.chat.modelRows = models || [];
    if (!models || !models.length) { box.innerHTML = `<div class="muted">没有配了 key 的模型。</div>`; return; }
    box.innerHTML = models.map((m) => {
      const cur = m.effort ?? "";
      const opt = (v, label) => `<option value="${v}" ${cur === v ? "selected" : ""}>${label}</option>`;
      const effortOptions = (m.effortOptions || []).map((entry) =>
        opt(entry.effort, entry.effort)).join("");
      const defaultLabel = m.defaultEffort ? `默认 · ${m.defaultEffort}` : "默认";
      return `
      <div class="model-cfg-row">
        <div class="mc-name">${esc(m.model)} ${m.capabilities?.includes("vision") ? `<span class="badge">VISION</span>` : ""} <span class="muted mono">${Math.round(m.contextWindow / 1000)}K window</span></div>
        <label class="mc-field">effort
          <select class="inp" data-mc-effort="${esc(m.modelRef)}">${opt("", defaultLabel)}${effortOptions}</select></label>
        <label class="mc-field">压缩覆盖 (tok) · 留空跟随
          <input class="inp" type="number" min="1000" step="1000" data-mc-compact="${esc(m.modelRef)}" title="设置数值：覆盖此模型的压缩触发线。留空：采用环境配置，否则自动按上下文策略的 80%；最终仍受有效输入安全线限制。" placeholder="自动参考 ${esc(fmtK(m.defaultCompactTokens))}" value="${esc(m.compactTokens ?? "")}"></label>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-mc-effort]").forEach((el) =>
      el.addEventListener("change", () => saveModelCfg(el.dataset.mcEffort, { effort: el.value || null })));
    box.querySelectorAll("[data-mc-compact]").forEach((el) =>
      el.addEventListener("change", () => saveModelCfg(el.dataset.mcCompact, { compactTokens: el.value === "" ? null : Number(el.value) })));
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}
async function saveModelCfg(modelRef, patch) {
  try { await api("/api/models", { method: "POST", body: JSON.stringify({ modelRef, ...patch }) }); toast("已保存"); }
  catch (e) { toast(e.message, true); }
}

// 聊天模型选择器：值仍是精确「API 连接/key 槽 + 模型」；视觉上按厂家分组、组内新→旧。
async function fillChatModels() {
  const sel = $("#chatModel");
  if (!sel) return;
  const requestedAgent = state.chat.agent;
  const requestedSession = state.chat.sessionId;
  const requestSeq = state.chat.modelCatalogRequestSeq = (state.chat.modelCatalogRequestSeq || 0) + 1;
  try {
    // 这一个接口同时给出模型目录与 per-agent 的 effective 默认值；避免只显示含糊的“自动”。
    const { models = [], agents = [] } = await api("/api/agent-defaults");
    if (requestSeq !== state.chat.modelCatalogRequestSeq || requestedAgent !== state.chat.agent || requestedSession !== state.chat.sessionId || sel !== $("#chatModel")) return;
    state.chat.models = models.map((m) => m.modelRef);
    state.chat.modelRows = models;
    const cur = state.chat.model || "";
    const agentDefault = agents.find((a) => a.name === state.chat.agent);
    const effectiveRef = agentDefault?.effectiveModelRef || agentDefault?.manifestModelRef || "";
    state.chat.effectiveModelRef = effectiveRef;
    const effectiveModel = models.find((m) => m.modelRef === effectiveRef);
    const effectiveLabel = effectiveModel?.modelLabel || effectiveModel?.model || effectiveRef || "自动路由";
    const effectiveFullLabel = effectiveModel?.model || effectiveLabel;
    state.chat.agentDefaultReasoningEffort = agentDefault?.defaultReasoningEffort || "medium";
    syncChatPermissionDefault(state.chat.agent, agentDefault?.effectivePermissionMode || "");
    const groups = new Map();
    for (const m of models) {
      const maker = modelMaker(m.modelName);
      if (!groups.has(maker)) groups.set(maker, []);
      groups.get(maker).push(m);
    }
    const groupedHtml = groupModelsByMaker([...groups.values()].flat().map((m) => m.modelName)).map(([maker]) => {
      const rows = (groups.get(maker) || []).sort((a, b) => modelFreshness(a.modelName, b.modelName));
      return `<optgroup label="${esc(maker)} · 新 → 旧">${rows.map((m) =>
        `<option value="${esc(m.modelRef)}">${m.capabilities?.includes("vision") ? "◉ " : ""}${esc(m.model)}</option>`).join("")}</optgroup>`;
    }).join("");
    sel.innerHTML = `<option value="" title="跟随 ${esc(state.chat.agent || "当前 Agent")}；当前默认：${esc(effectiveFullLabel)}">↳ ${esc(effectiveLabel)}</option>${groupedHtml}`;
    const stillAvailable = !cur || models.some((m) => m.modelRef === cur);
    if (!stillAvailable) sel.innerHTML += `<option value="${esc(cur)}">当前选择 · ${esc(cur)}（目录暂不可用）</option>`;
    sel.value = cur;
    fillChatEfforts({ preserveSelection: true });
    syncChatControlLocks();
    updateChatContextRing();
    window.HarbourStartupGate?.mark("models");
  } catch { window.HarbourStartupGate?.failed("data"); /* 已打开的聊天仍可使用原目录。 */ }
}

// Cron 与手动刷新共用后端目录；合并同批通知，不打断当前会话/正在运行的配置锁。
let modelCatalogRefreshTimer = null;
function scheduleModelCatalogReload() {
  if (modelCatalogRefreshTimer !== null) return;
  modelCatalogRefreshTimer = setTimeout(async () => {
    modelCatalogRefreshTimer = null;
    await fillChatModels();
    await refreshSessionList();
    // 设置页可能有未保存的连接表单；后台通知只刷新聊天选项，不重绘这些表单。
    // 设置页重新进入或主动点击刷新时，renderModelSlots / renderModelConfigs 会读取新目录。
  }, 250);
}

/** 当前会话的 Effort 选项严格跟随实际模型目录；Electron 与 Web 共用这一份 UI。 */
function effectiveChatDefaultEffort(row) {
  const options = row?.effortOptions || [];
  const preferred = row?.effort || state.chat.agentDefaultReasoningEffort || row?.defaultEffort || "medium";
  if (options.some((option) => option.effort === preferred)) return preferred;
  if (row?.defaultEffort && options.some((option) => option.effort === row.defaultEffort)) return row.defaultEffort;
  if (options.some((option) => option.effort === "medium")) return "medium";
  return options[0]?.effort || "";
}

function fillChatEfforts({ preserveSelection = false } = {}) {
  const sel = $("#chatEffort");
  if (!sel) return;
  const modelRef = state.chat.model || state.chat.effectiveModelRef || "";
  const row = state.chat.modelRows.find((model) => model.modelRef === modelRef);
  const options = row?.effortOptions || [];
  const effectiveDefault = effectiveChatDefaultEffort(row);
  const defaultLabel = effectiveDefault ? `↳ ${effectiveDefault}` : "↳ 模型默认";
  sel.innerHTML = `<option value="" title="跟随逐模型配置；未配置时跟随当前 Agent 的默认强度">${esc(defaultLabel)}</option>` +
    options.map((option) => `<option value="${esc(option.effort)}" title="${esc(option.description || option.effort)}">${esc(option.effort)}</option>`).join("");
  const current = state.chat.reasoningEffort || "";
  const supported = !current || options.some((option) => option.effort === current);
  if (!supported && preserveSelection) {
    sel.innerHTML += `<option value="${esc(current)}" disabled>${esc(current)}（目录暂不可用）</option>`;
  } else if (!supported) state.chat.reasoningEffort = "";
  sel.value = supported || preserveSelection ? current : "";
  sel.disabled = state.chat.running || !!state.chat.modelSaving || state.chat.readOnlyMirror || !row;
  syncChatRunPicker();
}

async function setChatModel(modelRef) {
  if (state.chat.running || state.chat.intakeRunning || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession || state.chat.readOnlyMirror || state.chat.inspection) {
    const select = $("#chatModel"); if (select) select.value = state.chat.model || "";
    toast("当前 Model 已锁定；请等待保存/运行完成，或回到可写会话再切换。", true); return false;
  }
  const previous = state.chat.model || "";
  const previousEffort = state.chat.reasoningEffort || "";
  state.chat.model = modelRef || "";
  if ($("#chatModel")) $("#chatModel").value = state.chat.model;
  fillChatEfforts();
  const sessionId = state.chat.sessionId;
  if (!sessionId) return true;
  const request = { sessionId, agent: state.chat.agent };
  state.chat.modelSaving = request;
  state.chat.detailRequestSeq = (state.chat.detailRequestSeq || 0) + 1;
  ++state.chat.sessionListRequestSeq; // Invalidate snapshots started before this selection.
  syncChatControlLocks();
  updateChatContextRing();
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ modelRef: state.chat.model || null }),
    });
    if (state.chat.sessionId !== sessionId || state.chat.agent !== request.agent) return;
    const local = state.chat.sessions.find((row) => row.id === sessionId);
    if (local) {
      const { messages, traces, times, durations, plan, ...summary } = session;
      Object.assign(local, summary);
    }
    state.chat.model = session.modelRef || "";
    if ($("#chatModel")) $("#chatModel").value = state.chat.model;
    state.chat.reasoningEffort = session.reasoningEffort || "";
    fillChatEfforts();
    toast(state.chat.model ? "本会话模型已切换" : "本会话已恢复自动模型");
    return true;
  } catch (e) {
    if (state.chat.sessionId !== sessionId || state.chat.agent !== request.agent) return;
    state.chat.model = previous;
    state.chat.reasoningEffort = previousEffort;
    const sel = $("#chatModel"); if (sel) sel.value = previous;
    fillChatEfforts();
    toast(e.message, true);
    return false;
  } finally {
    if (state.chat.modelSaving === request) state.chat.modelSaving = null;
    ++state.chat.sessionListRequestSeq;
    syncChatControlLocks();
    updateChatContextRing();
    void refreshSessionList();
  }
}

async function setChatReasoningEffort(reasoningEffort) {
  return setChatRunOverride("reasoningEffort", reasoningEffort);
}

async function setChatPermissionMode(permissionMode) {
  return setChatRunOverride("permissionMode", permissionMode);
}

// Immediate picker changes use the same exact-session lock as model changes.
async function setChatRunOverride(field, value) {
  const select = $(field === "reasoningEffort" ? "#chatEffort" : "#chatPermMode");
  if (state.chat.running || state.chat.intakeRunning || state.chat.modelSaving || state.chat.coworkSaving || state.chat.switchingMode || state.chat.switchingSession || state.chat.readOnlyMirror || state.chat.inspection) {
    if (select) select.value = state.chat[field] || "";
    toast("当前配置已锁定；请等待保存/运行完成，或回到可写会话再修改。", true); return false;
  }
  const previous = state.chat[field] || "";
  state.chat[field] = value || "";
  if (select) select.value = value || "";
  syncChatRunPicker();
  const sessionId = state.chat.sessionId;
  if (!sessionId) return true;
  const request = { sessionId, agent: state.chat.agent };
  state.chat.modelSaving = request;
  state.chat.detailRequestSeq = (state.chat.detailRequestSeq || 0) + 1;
  ++state.chat.sessionListRequestSeq;
  syncChatControlLocks();
  try {
    const { session } = await api(`/api/conversations/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ [field]: value || null }),
    });
    if (state.chat.sessionId !== sessionId || state.chat.agent !== request.agent) return false;
    state.chat[field] = session[field] || "";
    if (select?.isConnected) select.value = state.chat[field];
    fillChatEfforts({ preserveSelection: true });
    const local = state.chat.sessions.find(row => row.id === sessionId); if (local) local[field] = session[field];
    return true;
  } catch (e) {
    if (state.chat.sessionId !== sessionId || state.chat.agent !== request.agent) return false;
    state.chat[field] = previous;
    if (select?.isConnected) select.value = previous;
    fillChatEfforts({ preserveSelection: true }); toast(e.message, true); return false;
  } finally {
    if (state.chat.modelSaving === request) state.chat.modelSaving = null;
    ++state.chat.sessionListRequestSeq;
    syncChatControlLocks(); void refreshSessionList();
  }
}

/* ── WebSocket：实时日志 + loop trace ──────────────────────────────── */
function appendConnectivityTrace(trace, tag, text, agent) {
  if (!Array.isArray(trace)) return false;
  const previous = trace[trace.length - 1];
  if (previous?.tag === tag && previous?.text === text) return false;
  trace.push({ cls: tag === "ONLINE" ? "final" : "fallback", tag, text, agent, depth: 0 });
  if (trace.length > 400) trace.shift();
  return true;
}

function pendingChatMessage() {
  const message = state.chat.messages[state.chat.messages.length - 1];
  return message?.pending ? message : null;
}

function markRealtimeDisconnected() {
  const text = "与 Harbour 的实时轨迹连接中断；后台任务可能仍在执行，正在重连核验。";
  if (state.chat.running) {
    appendConnectivityTrace(state.chat.trace, "CONNECTION", text, state.runningAgent || state.chat.agent);
    const pending = pendingChatMessage();
    if (pending) pending.activity = "实时连接中断 · 正在重连核验…";
    updatePendingActivity();
    updatePendingTrace();
  }
  for (const run of Object.values(state.chat.channelRuns || {})) {
    if (!run || !["incoming", "running", "stopping"].includes(run.phase)) continue;
    appendConnectivityTrace(run.trace, "CONNECTION", text, run.agent);
    run.activity = run.stopping ? "中止收尾中 · 正在重连核验…" : "实时连接中断 · 正在重连核验…";
    updateChannelRunDom(run);
  }
}

function markRealtimeRestored(activeRunIds) {
  const text = "实时轨迹连接已恢复；已与后端活跃任务对账。";
  if (state.chat.running && state.chat.activeRunId && activeRunIds.has(state.chat.activeRunId)) {
    appendConnectivityTrace(state.chat.trace, "ONLINE", text, state.runningAgent || state.chat.agent);
    const pending = pendingChatMessage();
    if (pending) pending.activity = state.chat.stopping ? "正在中止并保存断点…" : "连接已恢复 · 继续执行…";
    updatePendingActivity();
    updatePendingTrace();
  }
  for (const run of Object.values(state.chat.channelRuns || {})) {
    if (!run || !activeRunIds.has(run.id)) continue;
    appendConnectivityTrace(run.trace, "ONLINE", text, run.agent);
    run.activity = run.stopping ? "正在中止并保存断点…"
      : run.stopPending ? "连接已恢复 · 正在核验中止请求…" : "连接已恢复 · 继续执行…";
    updateChannelRunDom(run);
  }
}

function rememberWsLog(raw, obj) {
  if (obj?.__harbour) return false;
  if (state.connection.seenLogs.has(raw)) return true;
  state.connection.seenLogs.add(raw);
  state.connection.seenLogOrder.push(raw);
  while (state.connection.seenLogOrder.length > 1200) {
    const oldest = state.connection.seenLogOrder.shift();
    if (oldest != null) state.connection.seenLogs.delete(oldest);
  }
  return false;
}

function reconcileActivitySnapshot(snapshot) {
  const activeRunIds = new Set(Array.isArray(snapshot?.activeRunIds)
    ? snapshot.activeRunIds.map((id) => String(id))
    : []);
  const nextEpoch = String(snapshot?.serverEpoch || "");
  const previousEpoch = state.connection.serverEpoch;
  const epochChanged = !!(previousEpoch && nextEpoch && previousEpoch !== nextEpoch);
  const reconnecting = state.connection.awaitingReconnectSnapshot;
  const staleSelectedSessions = new Set();

  // 渠道 run 的 complete/error 事件可能恰好发生在 WS 断线期间。快照是服务端真相：
  // 不在集合里的 incoming/running 卡必须删掉，否则它的 500ms UI ticker 会永远增长。
  for (const [runId, run] of Object.entries(state.chat.channelRuns || {})) {
    if (activeRunIds.has(runId)) continue;
    // A snapshot can precede POST admission, or arrive before its final HTTP
    // receipt. The exact local observer reconciles it; don't discard its STOP.
    if (run?.localChat?.running) continue;
    if (run?.sessionId === viewedChatSessionId()) staleSelectedSessions.add(run.sessionId);
    delete state.chat.channelRuns[runId];
  }

  if (reconnecting || epochChanged) markRealtimeRestored(activeRunIds);

  // Web/Electron 自己发起的 /api/run 由 fetch 持有；重连后若后端明确说它已不存在，
  // 立刻冻结视觉计时，再给正常 HTTP 收尾一个很短的竞态窗口。仍没收尾才中止本地 fetch，
  // 然后从 SessionStore 重新载入后端已经持久化的成功/中断记录。
  const localRunId = state.chat.activeRunId;
  if ((reconnecting || epochChanged) && state.chat.running && localRunId && !activeRunIds.has(localRunId)) {
    const pending = pendingChatMessage();
    const endedAt = Date.now();
    if (pending) {
      pending.runEndedAt ||= endedAt;
      pending.activity = epochChanged ? "Harbour 已重启 · 正在恢复保存记录…" : "后端运行已结束 · 正在同步记录…";
      updatePendingDuration(pending);
      updatePendingActivity();
    }
    stopVisualTimer(state.chat.durationTicker);
    state.chat.durationTicker = null;
    appendConnectivityTrace(
      state.chat.trace,
      "STATUS",
      epochChanged ? "检测到 Harbour 服务实例已重启；当前 run 已不在后端，停止幽灵计时并同步 checkpoint。" : "后端已不再报告当前 run；停止幽灵计时并同步已保存记录。",
      state.runningAgent || state.chat.agent
    );
    updatePendingTrace();
    if (state.chat.missingRunTimer) clearTimeout(state.chat.missingRunTimer);
    state.chat.missingRunTimer = window.setTimeout(() => {
      state.chat.missingRunTimer = null;
      if (!state.chat.running || state.chat.activeRunId !== localRunId) return;
      state.chat.abort?.abort(new Error("Harbour 重连后确认该运行已结束；正在同步已保存记录"));
    }, 1800);
  } else if (localRunId && activeRunIds.has(localRunId) && state.chat.missingRunTimer) {
    clearTimeout(state.chat.missingRunTimer);
    state.chat.missingRunTimer = null;
  }

  state.connection.serverEpoch = nextEpoch || previousEpoch;
  state.connection.awaitingReconnectSnapshot = false;
  for (const sessionId of staleSelectedSessions) {
    if (state.chat.inspection?.id === sessionId) void inspectChatSession(sessionId, true);
    else if (!state.chat.running) void loadConversationMessages(sessionId);
  }
  if (staleSelectedSessions.size) {
    void refreshSessionList();
    if (histView.agent) void refreshHistorySessions();
  }
}

function beginWsOutage() {
  window.HarbourStartupGate?.disconnected();
  if (!state.connection.disconnectedAt) {
    state.connection.disconnectedAt = Date.now();
    markRealtimeDisconnected();
  }
  state.connection.awaitingReconnectSnapshot = true;
}

function scheduleWsReconnect() {
  if (state.connection.reconnectTimer) return;
  state.connection.reconnectAttempt += 1;
  const attempt = state.connection.reconnectAttempt;
  const delay = Math.min(10000, 800 * (2 ** Math.min(4, Math.max(0, attempt - 1))));
  state.connection.reconnectTimer = window.setTimeout(() => {
    state.connection.reconnectTimer = null;
    connectWs();
  }, delay);
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const t = authToken();
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws${t ? "?token=" + encodeURIComponent(t) : ""}`);
  } catch {
    beginWsOutage();
    scheduleWsReconnect();
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    if (state.ws !== ws) return;
    const wasDisconnected = !!state.connection.disconnectedAt;
    state.connection.everOpened = true;
    state.connection.awaitingReconnectSnapshot ||= wasDisconnected;
    state.connection.disconnectedAt = 0;
    state.connection.reconnectAttempt = 0;
    if (state.connection.reconnectTimer) clearTimeout(state.connection.reconnectTimer);
    state.connection.reconnectTimer = null;
    // 每次连上/重连都补一次：断线那会儿的提问不会重推，只能主动拉。
    syncAsks();
    void loadTimeSettings();
    if ($("#chatSessionList")) void refreshSessionList();
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    beginWsOutage();
    scheduleWsReconnect();
  };
  ws.onmessage = (e) => {
    if (state.ws !== ws) return;
    const raw = String(e.data);
    let obj; try { obj = JSON.parse(raw); } catch { return; }
    if (obj?.__harbour === "session-deleted" && typeof obj.id === "string") {
      applyDeletedChatSession(obj.id);
      if ($("#histList")) void refreshHistorySessions();
      return;
    }
    if (obj?.__harbour === "session-read") {
      window.HarbourChatUnread?.observe(obj);
      updateSessionUnreadIndicators();
      return;
    }
    if (obj?.type === "time-settings:changed") { applyTimeSettingsPayload(obj.payload); return; }
    if (obj?.type === "goal:updated" || obj?.type === "goal:turn" || obj?.type === "goal:error") { handleChatGoalEvent(obj); return; }
    // ask 事件跟日志共用一条 /ws，先分流：它不是日志，别塞进终端。
    if (obj && obj.__harbour === "ask") { handleAskEvent(obj); return; }
    if (obj && obj.__harbour === "activity-snapshot") { reconcileActivitySnapshot(obj); window.HarbourStartupGate?.mark("live"); return; }
    if (obj && obj.__harbour === "channel-activity") {
      handleChannelActivity(obj);
      if (obj.agent === state.chat.agent) {
        if ($("#chatSessionList")) refreshSessionList();
      }
      // History 有自己独立的 persona 选择，不能再跟 Main Chat 当前 agent 绑死。
      if (obj.agent === histView.agent) refreshHistorySessions();
      return;
    }
    // reconnect 后 server 会回放 ring。相同 JSON 日志只处理一次，避免 Trace 行成倍增长。
    if (rememberWsLog(raw, obj)) return;
    if (obj.msg === "models:catalog-updated") scheduleModelCatalogReload();
    pushTraceEvent(obj);
  };
}

function syncDesktopPetQuick() {
  const button = $("#desktopPetQuick");
  if (!button) return null;
  const agent = currentCompanionAgent();
  const target = companionTargetForAgent(agent);
  button.hidden = !window.harbourDesktop?.isElectron || !target;
  button.dataset.petId = target?.petId || "";
  button.dataset.agent = agent;
  button.textContent = `桌面陪伴 · ${target?.label || personaLabel(agent)}`;
  button.title = target ? `显示或关闭 ${target.label} 桌宠` : "当前 Agent 没有桌宠";
  return target;
}

function initDesktopPetQuick() {
  const button = $("#desktopPetQuick");
  if (!button || !window.harbourDesktop?.isElectron) return;
  syncDesktopPetQuick();
  button.addEventListener("click", async () => {
    const target = syncDesktopPetQuick();
    if (!target) return;
    button.disabled = true;
    try {
      const visible = await window.harbourDesktop.petVisible(target.petId);
      const changed = visible
        ? await window.harbourDesktop.hidePet(target.petId)
        : await window.harbourDesktop.showPet(target.petId);
      if (changed === false) throw new Error("桌宠操作未完成，请重试");
      toast(visible ? `${target.label} 桌宠已关闭` : `${target.label} 独立桌宠窗口已打开`);
    } catch (error) {
      toast(error?.message || "桌宠操作失败", true);
    } finally {
      button.disabled = false;
      syncDesktopPetQuick();
    }
  });
}

/* ── 启动 ─────────────────────────────────────────────────────────── */
function stopVisualTimer(timer) { if (timer?.dispose) timer.dispose(); else clearInterval(timer); }
function visualPoll(work, delay, options) {
  if (window.HarbourVisualActivity) return window.HarbourVisualActivity.poll(work, delay, options);
  const timer = setInterval(() => { if (!document.hidden) void work(); }, delay);
  return { refresh: work, dispose: () => clearInterval(timer) };
}
function boot() {
  initTheme();
  initHarbourSelects();
  initTimeDisplayObserver();
  initMediaViewer();
  initFilePreview();
  window.HarbourFiles?.init({ api, token: authToken, withToken, toast, openMediaViewer });
  initImageContextMenu();
  initAvatar();
  initNav();
  initNavDrawer();
  initDesktopPetQuick();
  connectWs();
  visualPoll(() => {
    if (!document.hidden) for (const run of Object.values(state.chat.channelRuns || {})) updateChannelRunDom(run, { clockOnly: true });
  }, 500);
  const refreshVisualState = () => {
    if (document.hidden || window.HarbourVisualActivity?.isActive() === false) return;
    updatePendingTrace(); updatePendingActivity();
    for (const run of Object.values(state.chat.channelRuns || {})) updateChannelRunDom(run);
  };
  if (window.HarbourVisualActivity) window.HarbourVisualActivity.subscribe(refreshVisualState);
  else document.addEventListener("visibilitychange", refreshVisualState);
  void loadTimeSettings();
  visualPoll(syncTimeSettingsClock, 1000);
  void route().then(initDesktopConversationLinks);
}
boot();
