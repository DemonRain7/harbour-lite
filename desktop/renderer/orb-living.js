/* Small local illustration effects. One paused SVG clock; no rendering loop,
 * image re-generation, backend traffic or native-window movement. */
window.OrbHairMotion = class OrbHairMotion {
  constructor() {
    const ns = "http://www.w3.org/2000/svg";
    this.clock = document.createElementNS(ns, "svg");
    this.clock.id = "hairMotionClock"; this.clock.classList.add("symbols"); this.clock.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(ns, "defs"); this.clock.append(defs);
    // Full orb only: edge-hidden art uses rigid CSS breathing, no hair filter.
    // A protected face region pins eyes, nose and mouth.
    const faces = { orb: [50, 47, 32, 30] };
    for (const [name, [cx, cy, rx, ry]] of Object.entries(faces)) {
      const size = 56;
      const filter = document.createElementNS(ns, "filter"); filter.id = `hair-${name}`;
      for (const [key, value] of Object.entries({ x: "-5%", y: "-5%", width: "110%", height: "110%", "color-interpolation-filters": "sRGB" })) filter.setAttribute(key, value);
      const node = (tag, attributes, parent = filter) => {
        const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, v); parent.append(e); return e;
      };
      node("feTurbulence", { type: "fractalNoise", baseFrequency: ".019 .035", numOctaves: "1", seed: "7", result: "breeze" });
      // Keep the field entirely native SVG (no nested image fetch or mask
      // decode). Softly subtract a generous facial region from the lower hair.
      node("feFlood", { "flood-color": "white", x: 0, y: size * .3, width: size, height: size * .7, result: "lowerHair" });
      node("feFlood", { "flood-color": "white", x: size * (cx - rx) / 100, y: size * (cy - ry) / 100, width: size * rx / 50, height: size * ry / 50, result: "face" });
      node("feComposite", { in: "lowerHair", in2: "face", operator: "out", result: "hairEdges" });
      node("feGaussianBlur", { in: "hairEdges", stdDeviation: "3", result: "hairMask" });
      const warp = node("feDisplacementMap", { in: "SourceGraphic", in2: "breeze", scale: "0", xChannelSelector: "R", yChannelSelector: "G", result: "movingHair" });
      node("animate", { attributeName: "scale", values: "0;4;-1.2;0", keyTimes: "0;.42;.76;1", dur: "6.4s", calcMode: "spline", keySplines: ".4 0 .6 1;.4 0 .6 1;.4 0 .6 1", repeatCount: "indefinite" }, warp);
      node("feComposite", { in: "movingHair", in2: "hairMask", operator: "in", result: "hair" });
      node("feComposite", { in: "SourceGraphic", in2: "hairMask", operator: "out", result: "stillFace" });
      node("feComposite", { in: "hair", in2: "stillFace", operator: "arithmetic", k2: "1", k3: "1" });
      defs.append(filter);
    }
    document.body.append(this.clock); this.clock.pauseAnimations(); this.active = false;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced.addEventListener("change", () => this.setEnabled(this.requested));
  }
  setEnabled(requested) {
    this.requested = !!requested;
    const active = this.requested && !this.reduced.matches;
    if (active === this.active) return;
    this.active = active;
    if (active) this.clock.unpauseAnimations();
    else { this.clock.pauseAnimations(); this.clock.setCurrentTime(0); }
  }
};

window.OrbPortrait = class OrbPortrait {
  constructor({ cache, onReady }) {
    this.cache = cache; this.onReady = onReady;
    this.layer = document.getElementById("orbExpression");
    this.previous = document.getElementById("orbExpressionPrevious");
    this.blink = document.getElementById("orbBlink");
    this.art = document.getElementById("orbArt");
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced.addEventListener("change", () => { if (this.reduced.matches) this.finishTransition(); });
  }
  finishTransition() { this.fade?.cancel(); this.fade = null; this.previous.hidden = true; }
  paint(active, expression, animate) {
    const url = active?.expressionAtlas, persona = active?.agentName;
    if (url && !this.cache.has(url)) {
      const image = new Image(), asset = { ready: false, settled: false, image }; this.cache.set(url, asset);
      image.onload = () => { asset.settled = true; asset.ready = image.naturalWidth > 0 && Math.abs(image.naturalWidth / 3 - image.naturalHeight / 2) < 1; this.onReady(); };
      image.onerror = () => { asset.settled = true; this.onReady(); }; image.src = url;
    }
    const asset = this.cache.get(url), samePersona = this.layer.dataset.persona === persona;
    if (!asset?.ready) {
      // Keep the existing same-persona frame while loading; never flash a
      // differently cropped static avatar or retain another persona's face.
      if (!samePersona || !url || asset?.settled) { this.layer.hidden = this.blink.hidden = true; this.finishTransition(); }
      this.art.dataset.ready = String(!this.layer.hidden); return;
    }
    const key = `${persona}:${url}:${expression.mood}`;
    if (key !== this.key) {
      const canFade = animate && samePersona && !this.layer.hidden && !this.reduced.matches;
      this.finishTransition();
      if (canFade) {
        this.previous.style.backgroundImage = this.layer.style.backgroundImage;
        this.previous.style.backgroundPosition = this.layer.style.backgroundPosition;
        this.previous.hidden = false;
      }
      this.layer.style.backgroundImage = `url(${JSON.stringify(url)})`;
      this.layer.style.backgroundPosition = expression.position;
      Object.assign(this.layer.dataset, { source: url, persona, frame: expression.mood });
      this.layer.hidden = false;
      this.blink.style.backgroundImage = this.layer.style.backgroundImage;
      this.blink.hidden = false;
      this.key = key;
      if (canFade) {
        const fade = this.fade = this.previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-out" });
        fade.onfinish = () => { if (this.fade === fade) { this.previous.hidden = true; this.fade = null; } };
      }
    }
    this.layer.hidden = this.blink.hidden = false;
    this.art.dataset.ready = "true";
    if (!animate) this.finishTransition();
  }
};
