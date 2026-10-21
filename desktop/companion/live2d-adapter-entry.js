import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";

const DEFAULT_ACTIONS = Object.freeze({
  idle: { procedural: "idle" },
  incoming: { procedural: "greet" },
  waving: { procedural: "greet" },
  running: { procedural: "working" },
  working: { procedural: "working" },
  thinking: { procedural: "thinking" },
  waiting: { procedural: "waiting" },
  reconnecting: { procedural: "waiting" },
  dragging: { procedural: "dragging" },
  complete: { procedural: "celebrate" },
  review: { procedural: "happy" },
  error: { procedural: "worry" },
  failed: { procedural: "worry" },
  speaking: { procedural: "talk" },
  happy: { procedural: "happy" },
  shy: { procedural: "shy" },
  concerned: { procedural: "worry" },
  surprised: { procedural: "surprised" },
  curious: { procedural: "thinking" },
  focused: { procedural: "focused" },
  calm: { procedural: "idle" },
  tap: { procedural: "tap" },
  greet: { procedural: "greet" },
  work: { procedural: "working" },
  think: { procedural: "thinking" },
  question: { procedural: "waiting" },
  celebrate: { procedural: "celebrate" },
  worry: { procedural: "worry" },
  talk: { procedural: "talk" },
  listening: { procedural: "listening" },
  prepare: { procedural: "prepare" },
  study: { procedural: "study" },
  scribe: { procedural: "scribe" },
  scry: { procedural: "scry" },
  summon: { procedural: "summon" },
  conjure: { procedural: "conjure" },
  verify: { procedural: "verify" },
  plan: { procedural: "plan" },
  lookAround: { procedural: "lookAround" },
  drinkTea: { procedural: "drinkTea" },
  reset: { procedural: "idle" },
});

const GESTURE_DURATION = Object.freeze({
  idle: 0,
  working: 0,
  focused: 0,
  thinking: 0,
  waiting: 0,
  completeHold: 0,
  errorHold: 0,
  listening: 0,
  talk: 0,
  dragging: 0,
  running: 0,
  tap: 1800,
  greet: 1100,
  happy: 1200,
  shy: 1500,
  worry: 1400,
  surprised: 900,
  celebrate: 1600,
  prepare: 1100,
  summon: 1250,
  lookAround: 3200,
  drinkTea: 3800,
});

function motionIndexes(modelJson) {
  const groups = new Map();
  for (const [group, entries] of Object.entries(modelJson?.FileReferences?.Motions || {})) {
    const names = new Map();
    entries.forEach((entry, index) => {
      if (entry?.Name) names.set(entry.Name, { index, file: entry.File || "", expression: entry.Expression || "" });
    });
    groups.set(group, names);
  }
  return groups;
}

function setParameter(model, id, value) {
  if (!id) return;
  try {
    const core = model?.internalModel?.coreModel;
    if (typeof core?.setParameterValueById === "function") {
      core.setParameterValueById(id, value);
      return;
    }
    const index = core?.getParameterIndex?.(id);
    if (index >= 0) core?.setParameterValueByIndex?.(index, value);
  } catch { /* one missing parameter must never kill the renderer */ }
}

function getParameter(model, id) {
  if (!id) return 0;
  try {
    const core = model?.internalModel?.coreModel;
    if (typeof core?.getParameterValueById === "function") return Number(core.getParameterValueById(id)) || 0;
    const index = core?.getParameterIndex?.(id);
    if (index >= 0) return Number(core?.getParameterValueByIndex?.(index)) || 0;
  } catch { /* diagnostics must not affect rendering */ }
  return 0;
}

function addParameter(model, id, value, weight = 1) {
  if (!id || !Number.isFinite(value) || value === 0) return;
  try {
    const core = model?.internalModel?.coreModel;
    if (typeof core?.addParameterValueById === "function") {
      core.addParameterValueById(id, value, weight);
      return;
    }
    const index = core?.getParameterIndex?.(id);
    if (index >= 0) core?.addParameterValueByIndex?.(index, value, weight);
  } catch { /* optional parameters vary between character packs */ }
}

function mergeActions(actions) {
  // create() receives the flat manifest.visual.live2d.actions map, not its parent config.
  const custom = actions && typeof actions === "object" && !Array.isArray(actions) ? actions : {};
  return { ...DEFAULT_ACTIONS, ...custom };
}

function normalizedHotspots(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((item) => {
    const bounds = item?.bounds || {};
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{
      id: String(item.id || "hotspot").slice(0, 48),
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      width: Math.max(0, Math.min(1, width)),
      height: Math.max(0, Math.min(1, height)),
      action: String(item.action || "happy").slice(0, 48),
    }];
  });
}

function gestureWindow(phase, start, end) {
  if (phase <= start || phase >= end) return 0;
  const normalized = (phase - start) / (end - start);
  return Math.sin(Math.PI * normalized);
}

function smoothstep01(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function winkEyeEnvelope(elapsedMs) {
  // Match Cubism's native blink cadence. LSS swaps between separate closed-eye and upper-lid
  // art around the middle of ParamEyeLOpen; stretching that interval makes the swap look like
  // the eyelid opens backwards. Passing through it at the rig's intended 100/50/150ms cadence
  // reads as one normal blink instead of exposing the two source meshes.
  const start = 80;
  const closingEnd = start + 100;
  const closedEnd = closingEnd + 50;
  const openingEnd = closedEnd + 150;
  if (elapsedMs <= start || elapsedMs >= openingEnd) return 0;
  if (elapsedMs < closingEnd) return smoothstep01((elapsedMs - start) / 100);
  if (elapsedMs <= closedEnd) return 1;
  return 1 - smoothstep01((elapsedMs - closedEnd) / 150);
}

function winkBrowEnvelope(elapsedMs) {
  if (elapsedMs <= 80 || elapsedMs >= 760) return 0;
  if (elapsedMs < 180) return smoothstep01((elapsedMs - 80) / 100);
  if (elapsedMs <= 380) return 1;
  // The brow stays softly lowered until the native blink has completely reopened, then returns
  // on its own slow curve. It never changes sign and therefore cannot fake a second eye motion.
  return 1 - smoothstep01((elapsedMs - 380) / 380);
}

const READ_SCAN = [[0, -.24], [.12, -.24], [.44, .22], [.53, .22], [.64, -.24], [.75, -.24], [1, -.24]];
const SEARCH_SCAN = [[0, 0], [.14, -.42], [.31, -.42], [.56, .42], [.75, .42], [.9, 0], [1, 0]];
const THINK_LOOK = [[0, 0], [.18, .24], [.58, .24], [.8, 0], [1, 0]];

function cycleCurve(phase, points) {
  for (let index = 1; index < points.length; index += 1) {
    const [end, to] = points[index];
    if (phase <= end) {
      const [start, from] = points[index - 1];
      return from + (to - from) * smoothstep01((phase - start) / (end - start));
    }
  }
  return points[points.length - 1][1];
}

function blendOffsets(from, to, amount) {
  if (amount >= 1) return to;
  const output = { ...to };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    // Absolute eyelid/brow values belong to the topology-safe tap animation. Never stretch
    // its native wink cadence into a long crossfade or retain those overrides afterwards.
    if (key.endsWith("Value")) continue;
    output[key] = (from[key] || 0) + ((to[key] || 0) - (from[key] || 0)) * amount;
  }
  return output;
}

function gestureOffsets(name, elapsedMs) {
  const duration = GESTURE_DURATION[name] || 0;
  const phase = duration ? Math.min(1, elapsedMs / duration) : (elapsedMs % 4_000) / 4_000;
  const pulse = Math.sin(Math.PI * phase);
  const wave = Math.sin(Math.PI * 2 * phase);
  switch (name) {
    // A deterministic cute reaction: open smile -> one-eye wink -> slow, coordinated reopen.
    // It deliberately avoids every head and body-Y parameter because those can look like a
    // stretched neck on models whose deformer hierarchy couples vertical movement.
    case "tap": {
      const wink = winkEyeEnvelope(elapsedMs);
      const brow = winkBrowEnvelope(elapsedMs);
      return {
        bodyX: .45 * pulse,
        eyeX: -.08 * wink,
        // Final values isolate the click from automatic blinking and expression fades. The short
        // native cadence above is important: LSS cannot render a topology-safe slow-motion wink.
        eyeLOpenValue: 1 - wink,
        eyeROpenValue: 1,
        eyeLSmileValue: 0,
        eyeRSmileValue: 0,
        browLXValue: 0,
        browRXValue: 0,
        browLYValue: -.3 * brow,
        browRYValue: -.18 * brow,
        browLFormValue: 0,
        browRFormValue: 0,
        browLAngleValue: 0,
        browRAngleValue: 0,
        mouthOpen: 1.05 * gestureWindow(phase, .02, .82),
        mouthForm: .6 * pulse,
        cheek: 1 * pulse,
      };
    }
    case "greet": return { angleY: -2.2 * pulse, bodyY: 2.4 * pulse, eyeX: .25 * pulse };
    case "happy": return { angleY: -1.2 * pulse, bodyY: 2.2 * pulse };
    case "shy": return { angleX: -2.5 * pulse, angleY: -2 * pulse, angleZ: 1.2 * pulse, eyeY: -.2 * pulse };
    case "worry": return { angleX: 1.5 * wave * pulse, angleY: -.8 * pulse,
      eyeY: -.22 * pulse, browLY: -.16 * pulse, browRY: -.16 * pulse, mouthForm: -.4 * pulse };
    case "surprised": return { angleY: 3 * pulse, bodyY: 2.4 * pulse };
    case "celebrate": return { angleY: -1.5 * Math.abs(wave) * pulse,
      eyeLSmile: .4 * pulse, eyeRSmile: .4 * pulse, mouthForm: .5 * pulse, cheek: .15 * pulse };
    case "dragging":
    case "running": return { angleZ: 1.4 * wave, bodyX: 2.2 * wave };
    case "working":
    case "focused":
    case "study": {
      const readingPhase = (elapsedMs % 7_200) / 7_200;
      const scan = cycleCurve(readingPhase, READ_SCAN);
      return { angleY: -2.1, angleZ: -.5, bodyX: -.22, eyeX: scan, eyeY: -.34,
        browLY: -.07, browRY: -.07 };
    }
    case "thinking": {
      const look = cycleCurve((elapsedMs % 8_000) / 8_000, THINK_LOOK);
      return { angleX: look * 4, angleY: .9, angleZ: 1.25, eyeX: look, eyeY: .29,
        browLY: .1, browRY: -.05, mouthForm: -.1 };
    }
    case "waiting": return { angleZ: -.8, eyeY: .06, browLY: .2, browRY: .2,
      mouthForm: .12, bodyX: .1 * wave };
    case "completeHold": return { angleY: -.3, eyeLSmile: .35, eyeRSmile: .35,
      eyeLOpen: -.12, eyeROpen: -.12, mouthForm: .45, cheek: .12, bodyX: .16 * wave };
    case "errorHold": return { angleX: .8 * Math.sin(elapsedMs / 850), angleY: -.65,
      browLY: -.16, browRY: -.16, browLForm: -.25, browRForm: -.25,
      eyeY: -.12, mouthForm: -.4 };
    case "listening": return { angleZ: .75 * Math.sin(elapsedMs / 780),
      bodyX: .4 * Math.sin(elapsedMs / 780), eyeY: .04, mouthForm: .22 };
    case "talk": return { bodyY: .8 * Math.sin(Math.PI * 2 * phase) };
    case "prepare": return { angleY: -2.1 * smoothstep01(phase), eyeY: -.34 * smoothstep01(phase), bodyX: -.22 * pulse };
    case "scribe": return { angleY: -1.7, angleZ: -.7, bodyX: .28 * wave,
      eyeX: .16 * Math.sin(elapsedMs / 500), eyeY: -.3, browLY: -.1, browRY: -.1 };
    case "scry": {
      const search = cycleCurve((elapsedMs % 8_000) / 8_000, SEARCH_SCAN);
      return { angleX: search * 5, angleY: .4, eyeX: search, eyeY: .09, browLY: .07, browRY: .07 };
    }
    case "summon": return { angleY: 1.2 * pulse, bodyY: 1.3 * pulse, eyeY: .1 * pulse };
    case "conjure": return { angleY: .65 * wave, bodyY: .45 * Math.abs(wave), eyeX: .12 * wave, eyeY: .08 };
    case "verify": {
      const checkingPhase = (elapsedMs % 6_400) / 6_400;
      const nod = gestureWindow(checkingPhase, .64, .85);
      return { angleY: -.8 - 1.25 * nod, eyeX: cycleCurve(checkingPhase, SEARCH_SCAN) * .5,
        eyeY: -.17, browLY: -.08, browRY: -.08, mouthForm: .12 * nod };
    }
    case "plan": return { angleY: .5, angleZ: 1.1, eyeX: .18, eyeY: .22,
      browLY: .12, browRY: .02, bodyX: .12 * wave };
    case "lookAround": {
      const look = cycleCurve(phase, SEARCH_SCAN);
      return { angleX: look * 3, eyeX: look, eyeY: .06 * pulse, mouthForm: .12 * pulse };
    }
    case "drinkTea": return { angleY: -.6 * pulse, eyeY: -.1 * pulse,
      mouthForm: .25 * pulse, eyeLSmile: .1 * pulse, eyeRSmile: .1 * pulse };
    default: return {};
  }
}

function settledGesture(state) {
  if (state === "complete" || state === "review") return "completeHold";
  if (state === "error" || state === "failed") return "errorHold";
  if (state === "waiting" || state === "reconnecting") return "waiting";
  if (state === "thinking") return "thinking";
  if (state === "working" || state === "running" || state === "incoming" || state === "waving") return "working";
  if (state === "speaking") return "talk";
  if (state === "listening") return "listening";
  if (state === "dragging") return "dragging";
  return "idle";
}

async function create({ canvas, modelUrl, parameters = {}, actions = {}, interactions = {}, fit = {} }) {
  const app = new PIXI.Application({
    view: canvas,
    width: Math.max(1, canvas.clientWidth || canvas.width || 190),
    height: Math.max(1, canvas.clientHeight || canvas.height || 235),
    transparent: true,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    // capturePage uses Chromium's compositor; it does not need a retained WebGL buffer.
    preserveDrawingBuffer: false,
  });
  // A desktop companion must not follow a gaming monitor up to 144/240 fps.
  // Keep the same texture/DPR/antialiasing, with extra frames only for direct interaction.
  app.ticker.maxFPS = 30;
  const [model, modelJson] = await Promise.all([
    Live2DModel.from(modelUrl, { ticker: app.ticker, autoHitTest: false, autoFocus: false }),
    fetch(modelUrl).then((response) => {
      if (!response.ok) throw new Error(`Live2D model manifest HTTP ${response.status}`);
      return response.json();
    }),
  ]);
  const indexes = motionIndexes(modelJson);
  const semanticActions = mergeActions(actions);
  const mouthId = parameters.mouthOpen || "ParamMouthOpenY";
  const faceIds = {
    eyeLOpen: parameters.eyeLOpen || "ParamEyeLOpen",
    eyeROpen: parameters.eyeROpen || "ParamEyeROpen",
    eyeLSmile: parameters.eyeLSmile || "ParamEyeLSmile",
    eyeRSmile: parameters.eyeRSmile || "ParamEyeRSmile",
    browLX: parameters.browLX || "ParamBrowLX",
    browRX: parameters.browRX || "ParamBrowRX",
    browLY: parameters.browLY || "ParamBrowLY",
    browRY: parameters.browRY || "ParamBrowRY",
    browLForm: parameters.browLForm || "ParamBrowLForm",
    browRForm: parameters.browRForm || "ParamBrowRForm",
    browLAngle: parameters.browLAngle || "ParamBrowLAngle",
    browRAngle: parameters.browRAngle || "ParamBrowRAngle",
    mouthForm: parameters.mouthForm || "ParamMouthForm",
    cheek: parameters.cheek || "ParamCheek",
  };
  const hotspots = normalizedHotspots(interactions.hotspots);
  const gazeConfig = interactions.gaze && typeof interactions.gaze === "object" ? interactions.gaze : {};
  const gazeRadius = Math.max(1, Math.min(6, Number(gazeConfig.radius) || 2.2));
  const gazeReturnMs = Math.max(250, Math.min(5_000, Number(gazeConfig.returnAfterMs) || 1_200));
  const gazeStates = new Set(Array.isArray(gazeConfig.activeStates) && gazeConfig.activeStates.length
    ? gazeConfig.activeStates.map((value) => String(value))
    : ["idle", "listening", "speaking"]);
  const fallbackActions = Array.isArray(interactions.fallbackActions) && interactions.fallbackActions.length
    ? interactions.fallbackActions.map((value) => String(value)).slice(0, 8)
    : ["happy", "shy", "incoming"];
  const buttonAction = String(interactions.buttonAction || "tap").slice(0, 48);
  const idleActions = Array.isArray(interactions.idleActions)
    ? interactions.idleActions.map((value) => String(value)).slice(0, 8)
    : [];
  const allowModelIdleMotions = interactions.modelIdleMotions === true;
  const interactionDurationMs = Math.max(600, Math.min(4_000, Number(interactions.interactionDurationMs) || 1_450));
  let mouthOpen = 0;
  let currentState = "";
  let currentSignature = "";
  let currentStateSpec = null;
  let disposed = false;
  let paused = false;
  let idleTimer = null;
  let gazeReturnTimer = null;
  let lastFocusX = null;
  let lastFocusY = null;
  let interactionTimer = null;
  let interactionRevision = 0;
  let interactionActive = false;
  let gesture = { name: "idle", startedAt: performance.now() };
  let poseTransition = null;
  let desiredStateSpec = null;
  let desiredStateRevision = 0;
  let appliedStateRevision = 0;
  let statePump = Promise.resolve();
  let nativePump = Promise.resolve();
  let playRevision = 0;
  let idleVariationActive = false;
  let requestedExpression = null;
  let appliedExpression = null;
  let expressionRequests = 0;
  let lastRenderedPose = {};
  let lastRenderedFace = {};
  let lastRenderedOffsets = {};
  let renderedFrames = 0;
  let interactiveUntil = 0;

  function beginGesture(name) {
    const now = performance.now();
    // State events often change only their label/mood. Preserve the actual activity cadence.
    if (gesture.name === name) return;
    poseTransition = name === "tap" ? null : { from: { ...lastRenderedOffsets }, startedAt: now };
    gesture = { name, startedAt: now };
  }

  function syncFrameRate() {
    const interactive = interactionActive || currentState === "speaking" || currentState === "dragging"
      || mouthOpen > .01 || performance.now() < interactiveUntil;
    app.ticker.maxFPS = interactive ? 60 : 30;
  }

  // Some third-party models keep a large logical canvas or an offset drawing origin.
  // `model.width/height + anchor(.5)` can therefore report a healthy render while the
  // actual character sits almost completely below the viewport. Fit the model from its
  // real local bounds instead so every installed Cubism package is centred consistently.
  model.anchor.set(0, 0);
  app.stage.addChild(model);

  function visibleModelBounds() {
    const bounds = model.getLocalBounds();
    if (Number.isFinite(bounds?.width) && bounds.width > 0
      && Number.isFinite(bounds?.height) && bounds.height > 0) return bounds;
    return { x: 0, y: 0, width: Math.max(1, model.width), height: Math.max(1, model.height) };
  }

  function resize() {
    if (disposed) return;
    const width = Math.max(1, canvas.clientWidth || canvas.width || 190);
    const height = Math.max(1, canvas.clientHeight || canvas.height || 235);
    app.renderer.resize(width, height);
    model.scale.set(1);
    model.position.set(0, 0);
    const bounds = visibleModelBounds();
    const scaleFactor = Math.max(.5, Math.min(1.25, Number(fit.scale) || .94));
    const offsetX = Math.max(-.5, Math.min(.5, Number(fit.offsetX) || 0));
    const offsetY = Math.max(-.5, Math.min(.5, Number(fit.offsetY) || 0));
    const scale = Math.min(width / bounds.width, height / bounds.height) * scaleFactor;
    model.scale.set(scale);
    model.position.set(
      width * (.5 + offsetX) - (bounds.x + bounds.width / 2) * scale,
      height * (.5 + offsetY) - (bounds.y + bounds.height / 2) * scale,
    );
  }

  function focusCenter(instant = true, clearLastPoint = false) {
    clearTimeout(gazeReturnTimer);
    gazeReturnTimer = null;
    const controller = model.internalModel?.focusController;
    if (typeof controller?.focus === "function") {
      controller.focus(0, 0, instant);
      if (instant) {
        controller.vx = 0;
        controller.vy = 0;
      }
    }
    if (clearLastPoint) {
      lastFocusX = null;
      lastFocusY = null;
    }
  }

  function resetTrackedPose() {
    focusCenter(true, true);
    for (const id of [
      parameters.angleX || "ParamAngleX",
      parameters.angleY || "ParamAngleY",
      parameters.angleZ || "ParamAngleZ",
      parameters.bodyAngleX || "ParamBodyAngleX",
      parameters.bodyAngleY || "ParamBodyAngleY",
      parameters.bodyAngleZ || "ParamBodyAngleZ",
      parameters.eyeBallX || "ParamEyeBallX",
      parameters.eyeBallY || "ParamEyeBallY",
    ]) setParameter(model, id, 0);
  }

  function scheduleGazeReturn() {
    clearTimeout(gazeReturnTimer);
    gazeReturnTimer = window.setTimeout(() => {
      gazeReturnTimer = null;
      focusCenter(true);
    }, gazeReturnMs);
  }

  async function play(spec, { idleVariation = false } = {}) {
    if (!spec || disposed) return;
    idleVariationActive = idleVariation;
    // Procedural feedback must begin on the next render frame even if a model expression takes
    // time to load/fade. Otherwise a click can feel dead while awaiting the expression manager.
    if (spec.procedural) beginGesture(String(spec.procedural));
    const revision = ++playRevision;
    const applyExpression = async (name) => {
      requestedExpression = String(name);
      expressionRequests += 1;
      const result = await model.expression(name);
      if (!disposed && result !== false) appliedExpression = String(name);
    };
    // Serialize native expression loading as well as state changes. A delayed old expression
    // must finish before the latest one is applied, not overwrite it after an interaction.
    nativePump = nativePump.then(async () => {
      if (disposed || revision !== playRevision) return;
      try {
        if (Array.isArray(spec.motion) && spec.motion.length >= 2) {
          const [group, name] = spec.motion;
          const entry = indexes.get(group)?.get(name);
          if (entry?.file && Number.isInteger(entry.index)) await model.motion(group, entry.index);
          else if (entry?.expression) await applyExpression(entry.expression);
        }
        if (disposed || revision !== playRevision) return;
        if (spec.expression) await applyExpression(spec.expression);
      } catch (error) {
        if (!disposed) console.warn("[Harbour Live2D] action failed", spec, error);
      }
    });
    return nativePump;
  }

  function queueState(spec) {
    desiredStateSpec = spec;
    desiredStateRevision += 1;
    statePump = statePump.then(async () => {
      while (!disposed && !interactionActive && appliedStateRevision < desiredStateRevision) {
        const revision = desiredStateRevision;
        const latest = desiredStateSpec;
        await play(latest);
        appliedStateRevision = revision;
      }
    });
    return statePump;
  }

  async function playInteraction(spec) {
    if (disposed) return false;
    const revision = ++interactionRevision;
    clearTimeout(interactionTimer);
    interactionTimer = null;
    interactionActive = true;
    syncFrameRate();
    resetTrackedPose();
    // Repeated direct clicks are intentional reactions; unlike telemetry, they restart tap.
    gesture = { name: "", startedAt: performance.now() };
    await play(spec || semanticActions.happy);
    if (disposed || revision !== interactionRevision) return false;
    const proceduralDuration = GESTURE_DURATION[String(spec?.procedural || "")] || 0;
    const holdMs = Math.max(interactionDurationMs, proceduralDuration + 120);
    interactionTimer = window.setTimeout(() => {
      if (disposed || revision !== interactionRevision) return;
      interactionTimer = null;
      interactionActive = false;
      syncFrameRate();
      resetTrackedPose();
      void queueState(currentStateSpec || semanticActions.idle);
    }, holdMs);
    return true;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (disposed || paused) return;
    // Third-party packs often put head-tilt demonstrations in their idle group. Harbour only
    // plays those when a character profile explicitly opts in; otherwise the semantic idle
    // state remains stable and predictable.
    const idleMotions = allowModelIdleMotions ? (modelJson?.FileReferences?.Motions?.Tick3 || []) : [];
    if (!idleMotions.length && !idleActions.length) return;
    const delay = 16_000 + Math.floor(Math.random() * 14_000);
    idleTimer = window.setTimeout(async () => {
      idleTimer = null;
      if (!disposed && !paused && !interactionActive && (currentState === "idle" || !currentState)) {
        if (idleMotions.length) await model.motion("Tick3", Math.floor(Math.random() * idleMotions.length)).catch(() => {});
        else if (idleActions.length) {
          const action = idleActions[Math.floor(Math.random() * idleActions.length)];
          await play(semanticActions[action] || semanticActions.idle, { idleVariation: true });
        }
      }
      // This callback may have awaited a model fetch while pause/destroy ran.
      if (!disposed && !paused) scheduleIdle();
    }, delay);
  }

  resize();
  await model.motion("Start", 0).catch(() => {});
  const applyProceduralFrame = () => {
    if (disposed) return;
    renderedFrames += 1;
    syncFrameRate();
    const now = performance.now();
    const elapsed = now - gesture.startedAt;
    const duration = GESTURE_DURATION[gesture.name] || 0;
    if (duration && elapsed >= duration) {
      beginGesture(settledGesture(currentState));
      if (idleVariationActive) {
        idleVariationActive = false;
        // Finite idle acts may also enable a rig prop (e.g. the native tea-cup hand pose).
        // Restore the semantic expression as well as the procedural body pose afterwards.
        void queueState(currentStateSpec || semanticActions.idle);
      }
    }
    const targetOffsets = gestureOffsets(gesture.name, now - gesture.startedAt);
    const transition = poseTransition ? smoothstep01((now - poseTransition.startedAt) / 220) : 1;
    const offsets = poseTransition ? blendOffsets(poseTransition.from, targetOffsets, transition) : targetOffsets;
    if (transition >= 1) poseTransition = null;
    lastRenderedOffsets = { ...offsets };
    setParameter(model, mouthId, mouthOpen);
    if (Number.isFinite(offsets.eyeLOpenValue)) setParameter(model, faceIds.eyeLOpen, offsets.eyeLOpenValue);
    else addParameter(model, faceIds.eyeLOpen, offsets.eyeLOpen || 0);
    if (Number.isFinite(offsets.eyeROpenValue)) setParameter(model, faceIds.eyeROpen, offsets.eyeROpenValue);
    else addParameter(model, faceIds.eyeROpen, offsets.eyeROpen || 0);
    if (Number.isFinite(offsets.eyeLSmileValue)) setParameter(model, faceIds.eyeLSmile, offsets.eyeLSmileValue);
    else addParameter(model, faceIds.eyeLSmile, offsets.eyeLSmile || 0);
    if (Number.isFinite(offsets.eyeRSmileValue)) setParameter(model, faceIds.eyeRSmile, offsets.eyeRSmileValue);
    else addParameter(model, faceIds.eyeRSmile, offsets.eyeRSmile || 0);
    if (Number.isFinite(offsets.browLXValue)) setParameter(model, faceIds.browLX, offsets.browLXValue);
    if (Number.isFinite(offsets.browRXValue)) setParameter(model, faceIds.browRX, offsets.browRXValue);
    if (Number.isFinite(offsets.browLYValue)) setParameter(model, faceIds.browLY, offsets.browLYValue);
    else addParameter(model, faceIds.browLY, offsets.browLY || 0);
    if (Number.isFinite(offsets.browRYValue)) setParameter(model, faceIds.browRY, offsets.browRYValue);
    else addParameter(model, faceIds.browRY, offsets.browRY || 0);
    if (Number.isFinite(offsets.browLFormValue)) setParameter(model, faceIds.browLForm, offsets.browLFormValue);
    else addParameter(model, faceIds.browLForm, offsets.browLForm || 0);
    if (Number.isFinite(offsets.browRFormValue)) setParameter(model, faceIds.browRForm, offsets.browRFormValue);
    else addParameter(model, faceIds.browRForm, offsets.browRForm || 0);
    if (Number.isFinite(offsets.browLAngleValue)) setParameter(model, faceIds.browLAngle, offsets.browLAngleValue);
    if (Number.isFinite(offsets.browRAngleValue)) setParameter(model, faceIds.browRAngle, offsets.browRAngleValue);
    addParameter(model, mouthId, offsets.mouthOpen || 0);
    addParameter(model, faceIds.mouthForm, offsets.mouthForm || 0);
    addParameter(model, faceIds.cheek, offsets.cheek || 0);
    if (parameters.breath) setParameter(model, parameters.breath, .5 + .5 * Math.sin(now / 950));
    addParameter(model, parameters.angleX || "ParamAngleX", offsets.angleX || 0);
    addParameter(model, parameters.angleY || "ParamAngleY", offsets.angleY || 0);
    addParameter(model, parameters.angleZ || "ParamAngleZ", offsets.angleZ || 0);
    addParameter(model, parameters.bodyAngleX || "ParamBodyAngleX", offsets.bodyX || 0);
    addParameter(model, parameters.bodyAngleY || "ParamBodyAngleY", offsets.bodyY || 0);
    addParameter(model, parameters.eyeBallX || "ParamEyeBallX", offsets.eyeX || 0);
    addParameter(model, parameters.eyeBallY || "ParamEyeBallY", offsets.eyeY || 0);
    // Cubism restores its saved base parameters immediately after model.update(). Keep the
    // values that actually entered that render for diagnostics instead of reading the restored
    // values later and mistaking an invisible change for a visible animation.
    lastRenderedPose = {
      angleX: getParameter(model, parameters.angleX || "ParamAngleX"),
      angleY: getParameter(model, parameters.angleY || "ParamAngleY"),
      angleZ: getParameter(model, parameters.angleZ || "ParamAngleZ"),
      bodyAngleX: getParameter(model, parameters.bodyAngleX || "ParamBodyAngleX"),
      bodyAngleY: getParameter(model, parameters.bodyAngleY || "ParamBodyAngleY"),
      bodyAngleZ: getParameter(model, parameters.bodyAngleZ || "ParamBodyAngleZ"),
    };
    lastRenderedFace = {
      eyeLOpen: getParameter(model, faceIds.eyeLOpen),
      eyeROpen: getParameter(model, faceIds.eyeROpen),
      eyeLSmile: getParameter(model, faceIds.eyeLSmile),
      eyeRSmile: getParameter(model, faceIds.eyeRSmile),
      browLX: getParameter(model, faceIds.browLX),
      browRX: getParameter(model, faceIds.browRX),
      browLY: getParameter(model, faceIds.browLY),
      browRY: getParameter(model, faceIds.browRY),
      browLForm: getParameter(model, faceIds.browLForm),
      browRForm: getParameter(model, faceIds.browRForm),
      browLAngle: getParameter(model, faceIds.browLAngle),
      browRAngle: getParameter(model, faceIds.browRAngle),
      mouthOpen: getParameter(model, mouthId),
      mouthForm: getParameter(model, faceIds.mouthForm),
      cheek: getParameter(model, faceIds.cheek),
    };
  };
  // Applying on the normal Pixi ticker is too late: Cubism has already calculated its drawable
  // vertices and restores the saved parameters on the next frame. This hook is the supported
  // last point before coreModel.update(), so the face/body offsets become genuinely visible.
  model.internalModel?.on?.("beforeModelUpdate", applyProceduralFrame);
  scheduleIdle();

  return {
    setMouthOpen(value) {
      mouthOpen = Math.max(0, Math.min(1, Number(value) || 0));
      syncFrameRate();
    },
    async setState(state, detail = {}) {
      if (disposed) return;
      const normalized = String(state || "idle").replace(/-(?:left|right)$/, "");
      const mood = String(detail.mood || "");
      const action = String(detail.action || "");
      const signature = `${normalized}|${mood}|${action}`;
      const nextSpec = semanticActions[action] || semanticActions[normalized] || semanticActions[mood] || semanticActions.idle;
      // Repeated snapshots of the same semantic state are normal while a task is running.
      // They must not cancel a user interaction that has only just started.
      if (signature === currentSignature) return;
      const leavingDrag = currentState === "dragging" && normalized !== "dragging";
      currentState = normalized;
      syncFrameRate();
      currentSignature = signature;
      const sameSpec = nextSpec === currentStateSpec;
      currentStateSpec = nextSpec;
      // Real task/connection updates may arrive several times during a 1.5s click reaction.
      // Remember the latest semantic state, but let the user-visible reaction finish; its timer
      // will restore this newest state. Explicit reset/drag still cancels immediately.
      if (interactionActive) return;
      if (sameSpec) return;
      interactionRevision += 1;
      clearTimeout(interactionTimer);
      interactionTimer = null;
      resetTrackedPose();
      if (leavingDrag) {
        // Releasing the native window drag is an explicit pose reset, not a semantic crossfade.
        lastRenderedOffsets = {};
        poseTransition = null;
      }
      await queueState(nextSpec);
    },
    lookAt(point) {
      if (disposed || !point) return;
      const rect = canvas.getBoundingClientRect();
      const x = Number(point.x || 0) - rect.left;
      const y = Number(point.y || 0) - rect.top;
      if (lastFocusX != null && Math.hypot(x - lastFocusX, y - lastFocusY) < .75) return;
      lastFocusX = x;
      lastFocusY = y;
      const bounds = model.getBounds();
      const centreX = bounds.x + bounds.width / 2;
      const centreY = bounds.y + bounds.height / 2;
      const distance = Math.hypot(x - centreX, y - centreY);
      if ((currentState && !gazeStates.has(currentState)) || distance > Math.max(bounds.width, bounds.height) * gazeRadius) {
        focusCenter(true);
        return;
      }
      model.focus(x, y);
      interactiveUntil = performance.now() + gazeReturnMs;
      syncFrameRate();
      scheduleGazeReturn();
    },
    diagnostics() {
      const focus = model.internalModel?.focusController;
      const bounds = model.getBounds();
      return {
        rendering: { frames: renderedFrames, maxFPS: app.ticker.maxFPS, running: app.ticker.started },
        state: currentState,
        gesture: gesture.name,
        gestureElapsedMs: Math.max(0, performance.now() - gesture.startedAt),
        expression: { requested: requestedExpression, applied: appliedExpression, requests: expressionRequests },
        interactionActive,
        focus: focus ? {
          x: Number(focus.x || 0),
          y: Number(focus.y || 0),
          targetX: Number(focus.targetX || 0),
          targetY: Number(focus.targetY || 0),
        } : null,
        pose: { ...lastRenderedPose },
        face: { ...lastRenderedFace },
        proceduralOffsets: { ...lastRenderedOffsets },
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      };
    },
    async resetPose() {
      interactionRevision += 1;
      clearTimeout(interactionTimer);
      interactionTimer = null;
      interactionActive = false;
      resetTrackedPose();
      poseTransition = null;
      lastRenderedOffsets = {};
      gesture = { name: settledGesture(currentState), startedAt: performance.now() };
      await queueState(currentStateSpec || semanticActions.idle);
    },
    async interact(point) {
      if (!point) {
        return playInteraction(semanticActions[buttonAction] || semanticActions.tap || semanticActions.happy);
      }
      const rect = canvas.getBoundingClientRect();
      const x = point ? Number(point.x || 0) - rect.left : rect.width / 2;
      const y = point ? Number(point.y || 0) - rect.top : rect.height / 2;
      const displayBounds = model.getBounds();
      const normalizedX = displayBounds.width > 0 ? (x - displayBounds.x) / displayBounds.width : .5;
      const normalizedY = displayBounds.height > 0 ? (y - displayBounds.y) / displayBounds.height : .5;
      const hotspot = hotspots.find((item) => normalizedX >= item.x && normalizedX <= item.x + item.width
        && normalizedY >= item.y && normalizedY <= item.y + item.height);
      if (hotspot) {
        return playInteraction(semanticActions[hotspot.action] || semanticActions.happy);
      }
      const hitNames = model.hitTest(x, y) || [];
      const hitAreas = modelJson?.HitAreas || [];
      const area = hitAreas.find((item) => hitNames.includes(item.Name));
      if (area?.Motion) {
        const split = String(area.Motion).indexOf(":");
        const group = String(area.Motion).slice(0, split);
        const name = String(area.Motion).slice(split + 1);
        return playInteraction({ motion: [group, name], expression: name, procedural: "happy" });
      }
      const fallbackName = fallbackActions[Math.floor(Math.random() * fallbackActions.length)];
      return playInteraction(semanticActions[fallbackName] || semanticActions.happy);
    },
    resize,
    pause() {
      if (disposed) return;
      paused = true;
      clearTimeout(idleTimer);
      idleTimer = null;
      app.ticker.stop();
    },
    resume() {
      if (disposed) return;
      const wasPaused = paused;
      paused = false;
      app.render(); app.ticker.start();
      if (wasPaused) scheduleIdle();
    },
    destroy() {
      disposed = true;
      playRevision += 1;
      clearTimeout(idleTimer);
      clearTimeout(gazeReturnTimer);
      clearTimeout(interactionTimer);
      model.internalModel?.off?.("beforeModelUpdate", applyProceduralFrame);
      try { model.destroy(); } catch { /* ignore */ }
      try { app.destroy(false, { children: true, texture: true, baseTexture: true }); } catch { /* ignore */ }
    },
  };
}

window.HarbourCubismAdapter = { create };
