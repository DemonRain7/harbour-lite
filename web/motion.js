/* ═══════════════════════════════════════════════════════════════════
   Harbour 动效层 MOTION v1 —— 纯新增文件，不改 app.js 任何一行。
   挂载：index.html 在 app.js 之后
     <script src="/motion.js"></script>
   做法：app.js 的顶层函数声明是全局绑定，这里按名包装（applyTheme /
   setHero / renderChatMessages / PANELS.chat.render），原逻辑原样调用；
   app.js 不在（独立预览）时各钩子静默跳过。
   性能与降级：canvas DPR≤2、~30fps、页面隐藏 cancelAnimationFrame、
   prefers-reduced-motion 时 canvas 只画一帧静态（CSS 侧由 motion.css 兜）。
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";
  function hbInit() {
  if (window.__hbMotionInit) return;   // 双挂载/重入只跑一次
  window.__hbMotionInit = true;
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => REDUCE.matches;
  const escFn = typeof esc === "function" ? esc :
    (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ── ② 主题三层交接：旧底色软纱盖住硬切，再溶掉 ─────────────────── */
  const veil = document.createElement("div");
  veil.className = "hb-theme-veil";
  document.body.appendChild(veil);
  let veilTimer = 0, veilExitTimer = 0, veilRaf = 0;
  /** 退出遮蔽态。幂等——rAF 与时间兜底谁先到都走这里，另一条腿被取消。 */
  function veilExit() {
    if (veilRaf) { cancelAnimationFrame(veilRaf); veilRaf = 0; }
    clearTimeout(veilExitTimer); veilExitTimer = 0;
    veil.classList.add("fading");
    veil.classList.remove("on");
    clearTimeout(veilTimer);
    veilTimer = setTimeout(() => veil.classList.remove("fading"), 700);
  }
  function withVeil(apply) {
    if (reduced()) { apply(); return; }
    const oldBg = getComputedStyle(document.body).backgroundColor;
    clearTimeout(veilTimer);
    clearTimeout(veilExitTimer);
    if (veilRaf) { cancelAnimationFrame(veilRaf); veilRaf = 0; }
    veil.style.background = oldBg;
    veil.classList.remove("fading");
    veil.classList.add("on");
    void veil.offsetWidth;                    // 初始态落定再切
    try {
      apply();
    } finally {
      // 出口必须有两条腿，且【无论 apply 成败都要 arm】——换主题函数万一抛异常，
      // 软纱也绝不能卡在 on 全屏盖住 UI。rAF 是正常路径（下一帧淡出，动画好看）；
      // setTimeout 是唯一【基于时间】的安全网：后台标签页 rAF 根本不触发，只靠 rAF
      // 软纱会以旧底色无限期全屏盖死。兜底放进 rAF 回调内部＝没有兜底，勿再挪回去。
      veilRaf = requestAnimationFrame(() => { veilRaf = 0; veilExit(); });
      veilExitTimer = setTimeout(veilExit, 120);
    }
  }
  if (typeof applyTheme === "function") {
    const _applyTheme = applyTheme;
    window.applyTheme = function (catId, personaId, variantId) {
      const d = document.body.dataset;
      const changed = d.themeCat !== catId || d.themePersona !== personaId || d.theme !== variantId;
      if (changed) withVeil(() => _applyTheme(catId, personaId, variantId));
      else _applyTheme(catId, personaId, variantId);
      bgSync();
      refreshMarqueeText();
    };
  }

  /* ── ② 立绘交接：淡出 → 原函数换图（含缺图 fallback）→ 载入后淡入 ── */
  if (!window.HarbourChatHero && typeof setHero === "function" && typeof activePersona === "function") {
    const _setHero = setHero;
    window.setHero = function (variantId) {
      const img = document.querySelector(".harbour-hero");
      if (!img || reduced()) return _setHero(variantId);
      const persona = activePersona();
      const next = (persona && persona.hero && (persona.hero[variantId] || Object.values(persona.hero)[0])) || null;
      if (!next || img.getAttribute("src") === next) return _setHero(variantId); // 图没变：不动
      img.classList.add("hb-heroswap");
      setTimeout(() => {
        _setHero(variantId);
        const back = () => img.classList.remove("hb-heroswap");
        if (img.complete && img.naturalWidth) back();
        else { img.addEventListener("load", back, { once: true }); setTimeout(back, 900); } // 兜底
      }, 260);
    };
  }

  /* ── ③④ 消息进场 —— 重渲染陷阱（app.js:906）的对策 ──
     消息流每次整体重建，不能给气泡类无条件加动画。这里在重渲染完成后，
     按「条数增量」只给最后新增的 1–3 条打 .hb-in（一次性标记，历史不重播）；
     会话 id 变了（切会话/新建/载入历史）则整流一次轻淡入。 */
  if (typeof renderChatMessages === "function" && typeof state !== "undefined") {
    const _render = renderChatMessages;
    let lastCount = -1, lastSession = "__init__", wasPending = false;
    window.renderChatMessages = function () {
      _render();
      const stream = document.querySelector("#chatStream");
      const msgs = (state.chat && state.chat.messages) || [];
      const n = msgs.length;
      // 光看条数会漏掉用户真正等的那一条：app.js 是把「思考中」占位气泡
      // 【原地 mutate】成真答案（pending.content = res.answer），不 push，数组长度不变。
      // 所以额外追踪 pending→resolved 这个沿，补播那条回复。
      const hasPending = msgs.some((m) => m && m.pending);
      const resolved = wasPending && !hasPending;
      const sessionChanged = state.chat.sessionId !== lastSession;
      if (stream && !reduced()) {
        if (sessionChanged && lastSession !== "__init__") {
          stream.classList.remove("hb-swap"); void stream.offsetWidth; stream.classList.add("hb-swap");
        } else if (lastCount >= 0) {
          // 新增条数 +（回复落地则再算 1 条，覆盖「答案 + 压缩提示」同轮到达）。
          const take = Math.max(0, n - lastCount) + (resolved ? 1 : 0);
          if (take > 0 && take <= 3) {
            const rows = stream.querySelectorAll(".chat-msg, .chat-notice");
            for (let i = Math.max(0, rows.length - take); i < rows.length; i++) {
              const row = rows[i];
              if (!row) continue;
              row.classList.remove("hb-in"); void row.offsetWidth; row.classList.add("hb-in");
            }
          }
        }
      }
      lastCount = n; lastSession = state.chat.sessionId; wasPending = hasPending;
    };
  }

  /* ── ⑥ 跑马灯：MAIN CHAT 对话卡顶缘（in-flow 首子元素，不遮挡不吃点击）──
     只放角色的经典台词（原作），不混运行时状态——AGENTS/MODEL/UPTIME 在 DASHBOARD
     里本来就有，放这里既抢戏又把台词冲淡。因此本函数不打 /api/state，纯同步。 */
  const MQ_LINES = {
    elaina: [
      "✦ 说起来，这个故事的主人公是谁呢？——没错，就是我。",   // [原作] 招牌口头禅
      "✦ 灰之魔女，伊蕾娜。",                                  // [原作] 自我介绍
      "✦ 自认为为他人好而做的事，并不一定正确。",              // [原作] 全篇母题
      "✦ 你绝不是只身一人，我一直在你身边。",                  // [原作]
      "✦ 魔女之旅，出发。",                                    // [原作]
    ],
    aemeath: [
      "✦ 但愿我会让你感到骄傲，但愿我没有让你失望。",          // [原作] 角色简介同款
      "✦ 我想留在大家身边，从过去，一同迈向明天。",            // [原作]
      "✦ 不是英雄拯救世界，而是世界拯救英雄。",                // [原作] 3.3 主题句
      "✦ 别……难过……",                                       // [原作] 3.1 名场面
    ],
  };
  let mqEl = null;
  /** 选跑马灯台词的 persona：优先主题角色层；若是 neutral（premium 无角色）等
     不在册的，回退到当前 chat 里选的 agent；再不行默认 elaina。 */
  function mqPersona() {
    const p = document.body.dataset.themePersona;
    if (p && MQ_LINES[p]) return p;
    const agent = (typeof state !== "undefined" && state.chat && state.chat.agent) || "";
    const m = /^main-(.+)$/.exec(agent);
    return (m && MQ_LINES[m[1]]) ? m[1] : "elaina";
  }
  function marqueeSegs() {
    const segs = [...(MQ_LINES[mqPersona()] || [])];
    return segs.length ? segs : ["✦ HARBOUR // CONTROL"];
  }
  function fillMarquee(segs) {
    if (!mqEl || !mqEl.isConnected) return;
    const html = segs.map((t) => `<span>${escFn(t)}</span>`).join("");
    mqEl.querySelectorAll(".hb-marquee-seg").forEach((seg) => { seg.innerHTML = html; });
  }
  function mountMarquee() {
    const wb = document.querySelector(".chat-workbench");
    if (!wb) return;
    const existing = wb.querySelector(".hb-marquee");
    if (existing) { mqEl = existing; refreshMarqueeText(); return; }
    mqEl = document.createElement("div");
    mqEl.className = "hb-marquee";
    mqEl.setAttribute("aria-hidden", "true");
    mqEl.innerHTML = `<div class="hb-marquee-track"><div class="hb-marquee-seg"></div><div class="hb-marquee-seg hb-copy"></div></div>`;
    wb.insertBefore(mqEl, wb.firstChild);
    fillMarquee(marqueeSegs());
  }
  function refreshMarqueeText() {
    if (mqEl && mqEl.isConnected) fillMarquee(marqueeSegs());
  }
  if (typeof PANELS !== "undefined" && PANELS && PANELS.chat && typeof PANELS.chat.render === "function") {
    const _chatRender = PANELS.chat.render;
    PANELS.chat.render = async function (root) { await _chatRender.call(this, root); mountMarquee(); };
  }

  /* ── ⑦ 动态背景（canvas 双模式；elaina 走 motion.css 的纯 CSS 光斑）──
     premium「放映机浮尘」：金/银雾微尘沿光路缓慢斜升，缓慢明灭。
     aemeath「上升的光絮」：金/粉/青细小光点自下而上，轻微摇曳 + 明灭。 */
  const canvas = document.createElement("canvas");
  canvas.id = "hbBgCanvas";
  const glow = document.createElement("div");
  glow.id = "hbBgGlow";
  document.body.insertBefore(canvas, document.body.firstChild);
  document.body.insertBefore(glow, canvas);
  const ctx = canvas.getContext("2d");
  let parts = [], raf = 0, mode = null, W = 0, H = 0, last = 0, palette = [];

  function toRGB(c) {
    c = (c || "").trim();
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
    m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
    m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { const p = m[1].split(",").map(parseFloat); return [p[0], p[1], p[2]]; }
    return null;
  }
  function colorOf(name, fb) {
    const raw = getComputedStyle(document.body).getPropertyValue(name);
    return toRGB(raw) || (typeof resolveColor === "function" ? toRGB(resolveColor(raw, "")) : null) || fb;
  }
  function bgMode() {
    const cat = document.body.dataset.themeCat, per = document.body.dataset.themePersona;
    if (cat === "premium") return "dust";
    if (cat === "anime" && per === "aemeath") return "motes";
    return null;
  }
  function readPalette() {
    palette = mode === "dust"
      ? [{ c: colorOf("--accent", [226, 194, 133]), w: .75 }, { c: colorOf("--accent-2", [159, 176, 196]), w: .25 }]
      : [{ c: colorOf("--warn", [226, 154, 54]), w: .34 }, { c: colorOf("--accent", [239, 95, 154]), w: .33 }, { c: colorOf("--accent-2", [69, 181, 216]), w: .33 }];
  }
  function pick() {
    let r = Math.random(), acc = 0;
    for (const p of palette) { acc += p.w; if (r <= acc) return p.c; }
    return palette[0].c;
  }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // 坑5：DPR 上限 2
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function newPart() {
    const dust = mode === "dust";
    return {
      x: Math.random() * W, y: Math.random() * H,
      r: dust ? .6 + Math.random() * 1.4 : .9 + Math.random() * 1.5,
      a: dust ? .05 + Math.random() * .11 : .16 + Math.random() * .3,
      vx: dust ? .04 + Math.random() * .09 : 0,
      vy: dust ? -(.02 + Math.random() * .05) : -(.05 + Math.random() * .12),
      ph: Math.random() * Math.PI * 2,
      sway: dust ? 0 : .3 + Math.random() * .5,
      c: pick(),
    };
  }
  function seed() {
    const n = Math.max(24, Math.min(64, Math.round((W * H) / (mode === "dust" ? 26000 : 30000))));
    parts = Array.from({ length: n }, newPart);
  }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x > W + 8) p.x = -8;
      if (p.y < -8) p.y = H + 8;
      const tw = .55 + .45 * Math.sin(t / 1600 + p.ph);   // 缓慢明灭
      const x = p.x + (p.sway ? Math.sin(t / 2400 + p.ph) * 8 * p.sway : 0);
      ctx.beginPath();
      ctx.arc(x, p.y, p.r, 0, 6.2832);
      ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${(p.a * tw).toFixed(3)})`;
      ctx.fill();
    }
  }
  function tick(t) {
    if (window.HarbourVisualActivity?.isActive() === false) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
    if (t - last < 28) return;                 // ~30fps 足够（坑5：省一半 CPU）
    last = t;
    draw(t);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function bgSync() {
    const m = bgMode();
    stopLoop();
    if (!m) { mode = null; canvas.style.display = "none"; return; }
    canvas.style.display = "";
    const remode = m !== mode;
    mode = m;
    resize();
    readPalette();
    if (remode || !parts.length) seed();
    else parts.forEach((p) => { p.c = pick(); });          // 只换变体：重取配色即可
    if (reduced()) { draw(0); return; }                     // 坑4：canvas 自行降级为一帧静态
    if (document.visibilityState === "visible" && window.HarbourVisualActivity?.isActive() !== false) { last = 0; raf = requestAnimationFrame(tick); }
  }
  addEventListener("resize", () => { if (mode) { resize(); seed(); if (reduced()) draw(0); } });
  const syncBackgroundActivity = () => {
    if (!mode || reduced()) return;
    if (document.visibilityState === "hidden" || window.HarbourVisualActivity?.isActive() === false) stopLoop();
    else if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
  };
  document.addEventListener("visibilitychange", syncBackgroundActivity);
  window.HarbourVisualActivity?.subscribe(syncBackgroundActivity);
  if (REDUCE.addEventListener) REDUCE.addEventListener("change", bgSync);

  /* ── 启动 ── */
  window.HarbourMotion = { mountMarquee, refreshMarqueeText, bgSync, withVeil };
  bgSync();
  mountMarquee();
  setTimeout(mountMarquee, 700);    // boot 的首次 route() 是异步的，晚两拍兜底
  setTimeout(mountMarquee, 2200);
  }
  if (document.body) hbInit();
  else document.addEventListener("DOMContentLoaded", hbInit, { once: true });
})();
