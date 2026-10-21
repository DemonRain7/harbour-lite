const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { CompanionStateStore, inferMood } = require("../companion/companion-state");
const { MusicStore } = require("../companion/music-store");
const { QQMusicBridge, parseBridgeOutput } = require("../companion/qqmusic-bridge");
const { StickerStore } = require("../companion/sticker-store");
const { CharacterStore } = require("../companion/character-store");
const { createPetDragState } = require("../companion/pet-drag-state");
const { buildPetCatalog, normalizePetDefinition, resolvePetDefinitions } = require("../companion/pet-catalog");
const {
  buildDesktopLaunchArguments,
  parseDesktopLaunchIntent,
  quoteWindowsArgument,
} = require("../companion/launch-intent");

async function main() {
  assert.deepEqual(normalizePetDefinition("new-witch"), {
    id: "new-witch",
    agentName: "main-new-witch",
    displayName: "New Witch",
  });
  assert.deepEqual(normalizePetDefinition({ id: "star", agentName: "main-aemeath", displayName: "Star" }), {
    id: "star",
    agentName: "main-aemeath",
    displayName: "Star",
  });
  assert.equal(normalizePetDefinition("../bad"), null);
  assert.deepEqual(resolvePetDefinitions(["elaina", "elaina", "future-main"]).map((pet) => pet.id), ["elaina", "future-main"]);
  assert.equal(buildPetCatalog(["future-main"])["future-main"].agentName, "main-future-main");
  assert.deepEqual(parseDesktopLaunchIntent(["electron", ".", "--harbour-show-pet=elaina"]), {
    kind: "pet",
    petId: "elaina",
  });
  assert.deepEqual(parseDesktopLaunchIntent(["Harbour.exe", "--harbour-open-dashboard"]), { kind: "dashboard" });
  assert.deepEqual(parseDesktopLaunchIntent(["Harbour.exe"]), { kind: "default" });
  assert.equal(quoteWindowsArgument("D:\\Harbour App\\desktop"), '"D:\\Harbour App\\desktop"');
  assert.equal(buildDesktopLaunchArguments({
    isPackaged: false,
    appDirectory: "D:\\Harbour App\\desktop",
    flags: ["--harbour-show-pet=elaina"],
  }), '"D:\\Harbour App\\desktop" --harbour-show-pet=elaina');

  const dragDirections = [];
  const dragActive = [];
  let dragSettled = 0;
  const dragState = createPetDragState({
    settleMs: 25,
    directionThreshold: 3,
    onDirection: (direction) => dragDirections.push(direction),
    onActiveChange: (active) => dragActive.push(active),
    onSettled: () => { dragSettled += 1; },
  });
  dragState.begin({ x: 100, y: 100 });
  dragState.move({ x: 101, y: 100 }); // Windows 的 1px 原生窗口抖动不能改变方向。
  dragState.move({ x: 104, y: 100 });
  dragState.move({ x: 103, y: 100 });
  dragState.move({ x: 99, y: 100 });
  assert.deepEqual(dragDirections.filter(Boolean), ["right", "left"]);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(dragState.active, false, "缺少 Windows moved 事件时也必须自动释放拖动态");
  assert.equal(dragDirections.at(-1), null, "拖动结束必须显式清除最后一个方向");
  assert.deepEqual(dragActive, [true, false]);
  assert.equal(dragSettled, 1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-companion-test-"));
  const previousLocal = process.env.LOCALAPPDATA;
  const previousCharacters = process.env.HARBOUR_CHARACTER_HOME;
  process.env.LOCALAPPDATA = root;
  process.env.HARBOUR_CHARACTER_HOME = path.join(root, "Harbour", "characters");
  const app = { isPackaged: false, getPath: () => root };
  try {
    assert.equal(inferMood("好耶，任务完成啦！"), "happy");
    assert.equal(inferMood("抱歉，失败了"), "sad");

    const stickers = new StickerStore(app);
    const state = new CompanionStateStore({ matcher: (id, text, mood) => stickers.match(id, text, mood) });
    state.consume({ __harbour: "channel-activity", phase: "running", agent: "main-elaina", runId: "run-1" });
    assert.equal(state.snapshot().characters.elaina.status, "working");
    state.consume({ msg: "loop:thinking", agent: "main-elaina", runId: "run-1" });
    assert.equal(state.snapshot().characters.elaina.status, "thinking");
    state.consume({ __harbour: "activity-snapshot", activeRunIds: [] });
    assert.equal(state.snapshot().characters.elaina.status, "idle", "a reconnect snapshot must clear stale task state");
    state.consume({ msg: "loop:thinking", agent: "main-elaina", runId: "run-1" });
    assert.equal(state.snapshot().characters.elaina.status, "idle", "replayed historical thinking must not animate the pet");
    state.consume({ __harbour: "channel-activity", phase: "running", agent: "main-elaina", runId: "run-a" });
    state.consume({ __harbour: "channel-activity", phase: "running", agent: "main-elaina", runId: "run-b" });
    state.consume({ __harbour: "channel-activity", phase: "complete", agent: "main-elaina", runId: "run-a" });
    assert.equal(state.snapshot().characters.elaina.status, "working", "one completed run must not override another active run");
    state.consume({ __harbour: "channel-activity", phase: "complete", agent: "main-elaina", runId: "run-b" });
    assert.equal(state.snapshot().characters.elaina.status, "complete");
    state.consume({ __harbour: "companion:utterance", agent: "main-elaina", companionId: "elaina", text: "好耶，已经完成啦！" });
    const elaina = state.snapshot().characters.elaina;
    assert.equal(elaina.mood, "happy");
    assert.equal(elaina.action, "celebrate");
    assert.match(elaina.sticker.url, /^harbour-sticker:\/\//);
    assert.equal(state.snapshot().characters.aemeath, undefined);

    state.consume({ __harbour: "channel-activity", phase: "running", agent: "main-elaina", runId: "shared-run" });
    state.consume({ __harbour: "channel-activity", phase: "running", agent: "main-aemeath", runId: "shared-run" });
    state.consume({ __harbour: "channel-activity", phase: "complete", agent: "main-elaina", runId: "shared-run" });
    const parallel = state.snapshot().characters;
    assert.equal(parallel.elaina.status, "complete");
    assert.equal(parallel.aemeath.status, "working", "Elaina completion must not stop Aemeath's active task");
    state.consume({
      __harbour: "companion:utterance",
      agent: "main-aemeath",
      companionId: "aemeath",
      runId: "shared-run",
      text: "今天也有在好好当救世主吗？",
    });
    const afterAemeathSpeech = state.snapshot().characters;
    assert.equal(afterAemeathSpeech.aemeath.status, "speaking");
    assert.equal(afterAemeathSpeech.elaina.status, "complete", "Aemeath speech must not mutate Elaina state");
    state.consume({
      __harbour: "companion:utterance",
      agent: "main-aemeath",
      companionId: "elaina",
      runId: "malformed-run",
      text: "mismatched routing must be ignored",
    });
    assert.equal(state.snapshot().characters.elaina.status, "complete", "mismatched agent/pet events must fail closed");
    state.dispose();

    const petCoreSandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "..", "..", "web", "pet-core.js"), "utf8"), petCoreSandbox);
    const deriveFeedback = petCoreSandbox.window.HarbourPetCore.deriveFeedback;
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在思考", updatedAt: 1 }] }).state, "thinking");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在使用 opencli_browser", updatedAt: 1 }] }).state, "working");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在使用 opencli_browser", updatedAt: 1 }] }).action, "scry");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在使用 read_skill", updatedAt: 1 }] }).action, "study");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在使用 bash", updatedAt: 1 }] }).action, "scribe");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在使用 spawn_subagent", updatedAt: 1 }] }).action, "summon");
    assert.equal(deriveFeedback({ activities: [{ status: "running", detail: "正在核验工具结果", updatedAt: 1 }] }).action, "verify");
    assert.equal(deriveFeedback({ asks: [{ status: "waiting", updatedAt: 1 }] }).state, "waiting");
    assert.equal(deriveFeedback({ companion: { status: "speaking", action: "talk" } }).state, "speaking");

    const source = path.join(root, "source.mp3");
    fs.writeFileSync(source, Buffer.from("ID3-local-test"));
    const music = new MusicStore(app);
    assert.equal(music.getProvider(), "folia", "fresh clients default to the full Folia player");
    assert.equal(music.setProvider("local"), "local");
    assert.equal(new MusicStore(app).getProvider(), "local", "explicit legacy local-player choice remains available");
    assert.equal(music.setProvider("qqmusic"), "qqmusic");
    assert.equal(new MusicStore(app).getProvider(), "qqmusic", "music provider must persist on the Electron client");
    assert.equal(music.setProvider("folia"), "folia");
    assert.equal(new MusicStore(app).getProvider(), "folia", "Folia is also persisted, not a per-platform fallback");
    assert.throws(() => music.setProvider("private-api"), /不支持的音乐来源/);
    const [track] = music.importFiles([source]);
    assert.ok(track?.id);
    assert.equal(track.title, "source");
    assert.equal("file" in track, false);
    assert.ok(music.resolve(track.id));
    assert.equal(music.remove(track.id), true);
    assert.equal(parseBridgeOutput("ignored\n{\"ok\":true,\"provider\":\"qqmusic\"}\n").provider, "qqmusic");
    const qqBridge = new QQMusicBridge({
      platform: "win32",
      baseDir: path.resolve(__dirname, "..", "companion"),
      run: async (_script, action) => ({ ok: true, provider: "qqmusic", action }),
    });
    assert.equal((await qqBridge.status()).action, "status");

    const characters = new CharacterStore(app, {
      elaina: { id: "elaina", agentName: "main-elaina", displayName: "Elaina" },
    });
    assert.equal(characters.appearance().alwaysOnTop, true, "desktop pets should default to always-on-top");
    characters.setAppearance({ alwaysOnTop: false });
    assert.equal(characters.appearance().alwaysOnTop, false, "always-on-top must persist locally");
    assert.equal(characters.appearance().followDashboard, true, "a focused appearance patch must preserve unrelated settings");
    characters.ensureCharacter({ id: "elaina", agentName: "main-elaina", displayName: "Elaina" });
    const character = characters.readCharacter("elaina");
    assert.equal(character.manifest.visual.preferred, "pixel");
    assert.equal(character.manifest.visual.live2d.available, false);
    assert.equal(character.manifest.visual.live2d.enabled, false);
    assert.match(character.manifest.visual.live2d.assetLabel, /尚未安装/);
    assert.ok(fs.existsSync(path.join(characters.characterDir("elaina"), "live2d", "harbour-cubism-adapter.js")));
    assert.equal(fs.existsSync(path.join(characters.characterDir("elaina"), "CYRENE-PREVIEW-LICENSE.md")), false);
    const localLicense = JSON.parse(fs.readFileSync(path.join(characters.characterDir("elaina"), "license.json"), "utf8"));
    assert.equal(localLicense.status, "user-supplied-assets-required");
    const localManifestPath = path.join(characters.characterDir("elaina"), "manifest.json");
    const localManifest = JSON.parse(fs.readFileSync(localManifestPath, "utf8"));
    localManifest.visual.live2d = {
      ...localManifest.visual.live2d,
      packageId: "elaina-lss",
      behaviorVersion: 0,
      actions: { shy: { expression: "f09", procedural: "shy" } },
      interactions: { modelIdleMotions: true },
    };
    fs.writeFileSync(localManifestPath, `${JSON.stringify(localManifest, null, 2)}\n`, "utf8");
    const syncedCharacter = characters.readCharacter("elaina");
    assert.ok(syncedCharacter.manifest.visual.live2d.behaviorVersion >= 4, "installed character behavior must follow the bundled profile revision");
    assert.equal(syncedCharacter.manifest.visual.live2d.propStyle, "none");
    assert.equal(syncedCharacter.manifest.visual.live2d.actions.shy.expression, "f00");
    assert.equal(syncedCharacter.manifest.visual.live2d.interactions.modelIdleMotions, false);
    assert.equal(syncedCharacter.manifest.visual.live2d.parameters.browLY, "ParamBrowLY");
    characters.setVisualMode("elaina", "live2d");
    const unavailable = characters.readCharacter("elaina").manifest.visual;
    assert.equal(unavailable.preferred, "live2d");
    assert.equal(unavailable.live2d.enabled, false, "missing local assets must retain the pixel fallback");

    const desktopMain = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
    assert.match(desktopMain, /app\.setUserTasks\(/, "Windows taskbar menu must expose pet recovery actions");
    assert.match(desktopMain, /handleDesktopLaunch\(commandLine\)/, "a taskbar action must reach the existing instance");
    assert.match(desktopMain, /appUserModelId: "dev\.rain\.harbour"/, "pinned source shortcuts must share the running app identity");
    assert.match(desktopMain, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
    assert.match(desktopMain, /state\.lastCursorX !== local\.x \|\| state\.lastCursorY !== local\.y/, "stationary cursor polling must not pin Live2D gaze away from centre");
    assert.match(desktopMain, /createPetDragState/, "native drag must use the self-releasing visual state controller");
    assert.match(desktopMain, /isLoopbackUrl\(cfg\.url\) && !!backendRoot/, "a repository shortcut targeting localhost must start its backend by default");
    assert.match(desktopMain, /backend-offline\.html/, "a failed dashboard navigation must render a themed recovery screen instead of a black window");
    assert.match(desktopMain, /--harbour-pets=/,
      "the Dashboard must receive the configured Main-to-pet catalog for future custom roles");
    assert.ok(fs.existsSync(path.resolve(__dirname, "..", "renderer", "backend-offline.html")));
    assert.match(desktopMain, /const PET_ALWAYS_ON_TOP_LEVEL = "screen-saver"/,
      "fullscreen companions need Electron's strongest supported topmost layer");
    assert.match(desktopMain, /win\.setAlwaysOnTop\(true, PET_ALWAYS_ON_TOP_LEVEL\)/);
    assert.match(desktopMain, /win\.setFocusable\(false\)/,
      "a topmost pet must not take focus away from a fullscreen game");
    assert.match(desktopMain, /win\.moveTop\(\)/,
      "drag and focus transitions must be able to restore pet Z-order without focusing it");
    assert.match(desktopMain, /schedulePetTopmostRestore\(pet\.id\)/,
      "native drag completion must restore the topmost layer");
    assert.match(desktopMain, /cancelPetSpeechRequests\(target\.id\)/,
      "stopping one companion must not cancel another companion's TTS request");
    assert.match(desktopMain, /visibleOnFullScreen: true/);
    assert.doesNotMatch(desktopMain, /\.setShape\(/, "pet click-through must not clip the visible window");
    const petRenderer = fs.readFileSync(path.resolve(__dirname, "..", "..", "web", "desktop-pet.js"), "utf8");
    assert.ok(
      petRenderer.indexOf("Pixi reads canvas.clientWidth") < petRenderer.indexOf("HarbourLive2D.createHost"),
      "Live2D footprint must be established before Pixi initialises",
    );
    assert.ok(fs.existsSync(path.resolve(__dirname, "..", "..", "web", "assets", "pets", "elaina", "spritesheet.webp")));
    const lssProfile = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "companion", "profiles", "elaina-lss.json"), "utf8"));
    assert.equal(lssProfile.packageId, "elaina-lss");
    assert.equal(lssProfile.visual.runtime, "live2d/live2dcubismcore.min.js");
    assert.ok(lssProfile.visual.behaviorVersion >= 10);
    assert.equal(lssProfile.visual.propStyle, "none", "LSS must use actual rig expressions, not floating magic props");
    assert.equal(Object.keys(lssProfile.visual.expressions).length, 14);
    assert.ok(lssProfile.visual.interactions.hotspots.length >= 3);
    assert.equal(lssProfile.visual.interactions.hotspots.find((item) => item.id === "face")?.action, "tap");
    assert.equal(lssProfile.visual.actions.working.expression, "f00", "task feedback must not use the tilted f12 expression");
    assert.equal(lssProfile.visual.actions.scribe.procedural, "scribe");
    assert.equal(lssProfile.visual.actions.scry.procedural, "scry");
    assert.equal(lssProfile.visual.actions.tap.procedural, "tap");
    assert.equal(lssProfile.visual.actions.tap.expression, undefined,
      "the deterministic wink must not cross-fade a second expression track");
    assert.equal(lssProfile.visual.parameters.eyeLOpen, "ParamEyeLOpen");
    assert.equal(lssProfile.visual.parameters.browLX, "ParamBrowLX");
    assert.equal(lssProfile.visual.parameters.browRX, "ParamBrowRX");
    assert.equal(lssProfile.visual.parameters.browLY, "ParamBrowLY");
    assert.equal(lssProfile.visual.parameters.browLForm, "ParamBrowLForm");
    assert.equal(lssProfile.visual.parameters.eyeROpen, "ParamEyeROpen");
    assert.equal(lssProfile.visual.parameters.mouthForm, "ParamMouthForm");
    assert.equal(lssProfile.visual.parameters.cheek, "ParamCheek");
    assert.equal(lssProfile.visual.interactions.buttonAction, "tap");
    assert.equal(lssProfile.visual.actions.shy.expression, "f00", "tap feedback must not retain the tilted f09 expression");
    assert.equal(lssProfile.visual.actions.conjure.expression, "f00", "long image tasks must not retain the tilted f07 expression");
    assert.deepEqual(lssProfile.visual.interactions.idleActions, ["drinkTea", "lookAround"],
      "idle variety must be limited to the reviewed, finite non-tilted gestures");
    assert.equal(lssProfile.visual.actions.drinkTea.expression, "f13", "tea uses the model's real hand/cup expression");
    assert.equal(lssProfile.visual.actions.drinkTea.procedural, "drinkTea");
    assert.equal(lssProfile.visual.actions.lookAround.expression, "f00");
    assert.equal(lssProfile.visual.actions.surprised.expression, "f10", "brief hair-touch reactions use the actual non-tilted surprise face");
    assert.equal(lssProfile.visual.actions.speaking.expression, "f00", "speaking must not implicitly hold the tea expression");
    assert.equal(lssProfile.visual.interactions.modelIdleMotions, false, "third-party model idle motions must be opt-in");
    assert.ok(lssProfile.visual.interactions.gaze.radius > 1 && lssProfile.visual.interactions.gaze.radius <= 1.5);
    assert.ok(lssProfile.visual.interactions.gaze.returnAfterMs <= 1500);
    const petHtml = fs.readFileSync(path.resolve(__dirname, "..", "..", "web", "desktop-pet.html"), "utf8");
    const petCss = fs.readFileSync(path.resolve(__dirname, "..", "..", "web", "desktop-pet.css"), "utf8");
    assert.match(petHtml, /id="petInteractionZone"/, "the Live2D body must expose a reliable click hotspot outside Electron's drag region");
    assert.doesNotMatch(petHtml, /pet-magic-(?:book|quill)/, "a static cup-holding model must not fake a hand-held book or quill overlay");
    assert.match(petRenderer, /runPetInteraction/, "model taps and the interaction control must share one feedback path");
    assert.ok(
      petRenderer.indexOf('host.dataset.interactionState = "pending"') < petRenderer.indexOf("await live2dHost.interact(point)"),
      "desktop interaction feedback must appear before awaiting the Live2D adapter",
    );
    assert.match(petRenderer, /dataset\.propStyle/, "character profiles must explicitly select their supported prop treatment");
    assert.match(petCss, /\.desktop-pet-stage[\s\S]*-webkit-app-region:\s*drag/, "the proven native body-drag path must remain enabled");
    assert.match(petCss, /\.desktop-pet-interaction-zone[\s\S]*-webkit-app-region:\s*no-drag/, "the model tap hotspot must receive pointer events");

    console.log("desktop companion runtime tests passed");
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
    if (previousCharacters === undefined) delete process.env.HARBOUR_CHARACTER_HOME; else process.env.HARBOUR_CHARACTER_HOME = previousCharacters;
    if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
