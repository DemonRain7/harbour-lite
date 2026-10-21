const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.resolve(__dirname, "../../web/app.js"), "utf8");
const styles = fs.readFileSync(path.resolve(__dirname, "../../web/styles.css"), "utf8");

assert.match(app, /function renderPlayableMedia\(kind, rawUrl, title = ""\)/);
assert.match(app, /function openMediaViewer\(\{ kind, url: rawUrl, title = "", origin = null \}\)/);
assert.match(app, /function openChatImageViewer\(image\)/);
assert.match(app, /function initMediaViewer\(\)/);
assert.match(app, /initMediaViewer\(\);/);

assert.match(app, /data-media-kind="image"/);
assert.match(app, /data-media-kind="\$\{kind\}" data-media-url="\$\{source\}"/);
assert.match(app, /renderPlayableMedia\("video", a\.url, a\.name\)/);
assert.match(app, /renderPlayableMedia\("audio", a\.url, a\.name\)/);
assert.match(app, /event\.preventDefault\(\);\s*\n\s*const image = imageLink\.querySelector/, "image clicks must not reach Electron's external-link handler");
assert.match(app, /openChatImageViewer\(image\);/);

assert.match(styles, /\.media-viewer\s*\{/);
assert.match(styles, /\.media-viewer-image\s*\{/);
assert.match(styles, /\.media-viewer-video\s*\{/);
assert.match(styles, /\.media-viewer-audio-card\s*\{/);
assert.match(styles, /\.att-media-open\s*\{/);
assert.match(styles, /z-index: 20000/);
assert.match(styles, /\.media-viewer-nav:disabled\s*\{/);
assert.match(styles, /\.media-viewer-counter\s*\{/);
assert.match(app, /data-media-viewer-action="previous"/);
assert.match(app, /data-media-viewer-action="next"/);
assert.match(app, /if \(next < 0 \|\| next >= gallery.items.length\) return;/, "gallery must stop at both boundaries");
assert.match(app, /releaseMediaViewerPlayback\(stage\)/, "switching must release the old video");
assert.match(app, /origin: image/);
assert.match(app, /origin: trigger/);
assert.match(styles, /\.media-viewer-content\.has-gallery \.media-viewer-stage/, "only multi-item galleries reserve arrow gutters");
assert.match(app, /class="media-viewer-content\$\{gallery\.items\.length > 1/);
assert.match(app, /title="下一个（→）" \$\{gallery\.items\.length > 1 \? "" : "hidden"\}/, "singletons hide unnecessary arrows");

function source(name) {
  const match = app.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing testable function ${name}`);
  return match[0];
}
const context = vm.createContext({ URL, location: new URL("http://harbour.local/"), document: { activeElement: null } });
vm.runInContext(["safeMediaViewerUrl", "chatImageSource", "collectSpaceMediaGallery", "collectMediaViewerGallery", "mountMediaViewer", "mediaViewerOwnsArrowKey", "mediaViewerFocusControls", "focusMediaViewerBoundary", "containMediaViewerFocus", "releaseMediaViewerPlayback"].map(source).join("\n"), context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const currentMessage = {}, laterMessage = {};
function scope() {
  return { media: [], querySelectorAll(selector) {
    assert.equal(selector, 'img.att-img, img.md-img-real, [data-media-kind="video"][data-media-url]');
    return this.media;
  } };
}
function media(container, kind, url, message = currentMessage, extra = {}) {
  const element = {
    tagName: kind === "image" ? "IMG" : "BUTTON", src: url, alt: kind === "image" ? "image title" : "",
    dataset: { mediaKind: kind, mediaUrl: url, ...(kind === "video" ? { mediaTitle: "video title" } : {}) },
    closest(selector) {
      if (selector === ".space-reader") return null;
      if (selector === "#chatStream, .hist-msgs") return container;
      if (selector === ".chat-msg") return message;
      if (selector === ".chat-trace, .chat-trace-live") return this.inTrace ? {} : null;
      throw new Error(`unexpected selector ${selector}`);
    },
    getClientRects() { return this.hidden ? [] : [{}]; },
    ...extra,
  };
  container?.media.push(element);
  return element;
}
const stream = scope();
const first = media(stream, "image", "/uploads/a.png?token=first");
const inlineDuplicate = media(stream, "image", "http://harbour.local/uploads/a.png?token=second");
const video = media(stream, "video", "/uploads/b.mp4");
media(stream, "image", "/uploads/hidden.png", currentMessage, { hidden: true });
media(stream, "image", "/uploads/trace.png", currentMessage, { inTrace: true });
media(stream, "image", "javascript:alert(1)");
media(stream, "image", "/uploads/a.png?token=later", laterMessage);
const history = scope();
const historyImage = media(history, "image", "/uploads/history.png");
const fallback = { kind: "image", url: "/uploads/fallback.png", title: "fallback" };
const gallery = context.collectMediaViewerGallery(first, fallback);
assert.deepEqual(plain(gallery.items).map((item) => item.kind), ["image", "video", "image"], "keep conversation order and separate-message occurrences");
assert.deepEqual(plain(gallery.items).map((item) => item.url), ["http://harbour.local/uploads/a.png?token=first", "http://harbour.local/uploads/b.mp4", "http://harbour.local/uploads/a.png?token=later"]);
assert.equal(gallery.index, 0);
assert.equal(context.collectMediaViewerGallery(inlineDuplicate, fallback).index, 0, "clicked attachment duplicate selects its first inline occurrence");
assert.equal(context.collectMediaViewerGallery(video, { kind: "video" }).index, 1);
assert.equal(context.collectMediaViewerGallery(historyImage, fallback).items.length, 1, "history cannot include Main Chat media");
assert.deepEqual(plain(context.collectMediaViewerGallery(null, fallback)), { items: [fallback], index: 0 }, "non-conversation callers stay standalone");
assert.deepEqual(plain(context.collectMediaViewerGallery(media(null, "image", "/detached.png"), fallback)), { items: [fallback], index: 0 });
const audio = { kind: "audio", url: "/uploads/voice.ogg" };
assert.deepEqual(plain(context.collectMediaViewerGallery(video, audio)), { items: [audio], index: 0 }, "audio remains standalone");
assert.equal(context.safeMediaViewerUrl("file:///private.png"), "");

// Spaces use the same viewer, but the gallery is confined to this work and retains page occurrences.
const reader = { pages: [], querySelectorAll(selector) {
  assert.equal(selector, "[data-space-zoom]");
  return this.pages;
} };
function spacePage(url, title, options = {}) {
  const image = options.noImage ? null : { alt: title, getAttribute: name => name === "src" ? url : null };
  const page = { querySelector: () => image, contains: node => image === node,
    closest(selector) { assert.equal(selector, ".space-reader"); return reader; }, ...options };
  reader.pages.push(page);
  return page;
}
const pageOne = spacePage("/api/spaces/files/one.png?token=owner", "Comic · 1");
const pageTwo = spacePage("/api/spaces/files/two.png?token=owner", "Comic · 2", { loading: "lazy" });
spacePage("/api/spaces/files/one.png?token=owner", "Comic · 3");
spacePage("javascript:alert(1)", "Unsafe");
spacePage("", "Empty");
spacePage("/missing.png", "Missing", { noImage: true });
const spaceGallery = context.collectMediaViewerGallery(pageTwo, fallback);
assert.deepEqual(plain(spaceGallery), { index: 1, items: [
  { kind: "image", url: "http://harbour.local/api/spaces/files/one.png?token=owner", title: "Comic · 1" },
  { kind: "image", url: "http://harbour.local/api/spaces/files/two.png?token=owner", title: "Comic · 2" },
  { kind: "image", url: "http://harbour.local/api/spaces/files/one.png?token=owner", title: "Comic · 3" },
] }, "original authenticated sources include lazy pages; duplicates are distinct comic pages");
assert.deepEqual(plain(context.collectSpaceMediaGallery({ closest: () => reader }, fallback)), { items: [fallback], index: 0 }, "an unrelated origin cannot pick an arbitrary comic page");
assert.equal(context.collectSpaceMediaGallery(pageOne, audio), null, "non-images do not enter the Spaces image gallery");

// Body z-index cannot overtake a native dialog: mount in its top layer and isolate the reader beneath.
const header = { inert: false }, existingInert = { inert: true };
const dialogHost = { children: [header, existingInert], appendChild(node) { this.child = node; } };
const bodyHost = { appendChild(node) { this.child = node; } };
context.document.body = bodyHost;
const nestedViewer = {};
const restore = context.mountMediaViewer(nestedViewer, { closest(selector) {
  assert.equal(selector, "dialog[open]"); return dialogHost;
} });
assert.equal(dialogHost.child, nestedViewer);
assert.equal(header.inert, true, "background reader controls must not compete for focus");
assert.equal(existingInert.inert, true);
restore();
assert.equal(header.inert, false, "closing restores the reader controls");
assert.equal(existingInert.inert, true, "pre-existing inert state is preserved");
const chatViewer = {};
context.mountMediaViewer(chatViewer, null)();
assert.equal(bodyHost.child, chatViewer, "the chat viewer keeps its original body-level host");
assert.match(source("closeMediaViewer"), /mediaViewerRestoreHost\?\.\(\);[\s\S]*mediaViewerReturnFocus\?\.focus/, "restore reader interaction before returning focus without scrolling");
const spaces = fs.readFileSync(path.resolve(__dirname, "../../web/spaces.js"), "utf8");
assert.match(spaces, /e\.defaultPrevented \|\| e\.target\.closest\?\.\('\.media-viewer'\)/, "viewer keyboard events must not close or trap the parent reader");
assert.match(spaces, /function closeReader\(\) \{\s*closeMediaViewer\(\);/);
assert.match(spaces, /const dispose = \(\) => \{ closeMediaViewer\(\);/, "navigation releases the nested viewer and global listeners");

const remote = scope();
const remoteImage = media(remote, "image", "https://media.example/image?token=one");
media(remote, "image", "https://media.example/image?token=two");
assert.equal(context.collectMediaViewerGallery(remoteImage, fallback).items.length, 2, "remote query parameters must retain their media identity");

const nativeTarget = { matches: () => true };
const viewerButton = { matches: () => false };
assert.equal(context.mediaViewerOwnsArrowKey({ target: viewerButton }), true);
assert.equal(context.mediaViewerOwnsArrowKey({ target: nativeTarget }), false);
assert.equal(context.mediaViewerOwnsArrowKey({ target: viewerButton, composedPath: () => [viewerButton, nativeTarget] }), false, "native media controls preserve seeking even across shadow boundaries");
for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "defaultPrevented"]) {
  assert.equal(context.mediaViewerOwnsArrowKey({ target: viewerButton, [modifier]: true }), false);
}
const playbackCalls = [];
context.releaseMediaViewerPlayback({ querySelectorAll(selector) {
  assert.equal(selector, "video, audio");
  return [{ pause() { playbackCalls.push("pause"); }, removeAttribute(name) { playbackCalls.push(`remove:${name}`); }, load() { playbackCalls.push("load"); } }];
} });
assert.deepEqual(playbackCalls, ["pause", "remove:src", "load"], "switch/close stop playback and free the previous source");

function focusControl(name, extra = {}) {
  return { name, hidden: false, getClientRects: () => [{}], focus() { context.document.activeElement = this; }, ...extra };
}
const firstControl = focusControl("zoom");
const closeControl = focusControl("close");
const lastControl = focusControl("next");
const focusViewer = { querySelectorAll(selector) {
  assert.equal(selector, "button:not([disabled]), video[controls], audio[controls]");
  return [focusControl("hidden", { hidden: true }), firstControl, closeControl, lastControl, focusControl("no-layout", { getClientRects: () => [] })];
} };
function tabEvent(extra = {}) {
  return { key: "Tab", prevented: false, preventDefault() { this.prevented = true; }, ...extra };
}
context.document.activeElement = lastControl;
const forwardTab = tabEvent();
assert.equal(context.containMediaViewerFocus(focusViewer, forwardTab), true);
assert.equal(forwardTab.prevented, true);
assert.equal(context.document.activeElement, firstControl, "Tab wraps inside the viewer");
const backwardTab = tabEvent({ shiftKey: true });
context.containMediaViewerFocus(focusViewer, backwardTab);
assert.equal(backwardTab.prevented, true);
assert.equal(context.document.activeElement, lastControl, "Shift+Tab wraps inside the viewer");
context.document.activeElement = closeControl;
const innerTab = tabEvent();
context.containMediaViewerFocus(focusViewer, innerTab);
assert.equal(innerTab.prevented, false, "ordinary inner focus traversal stays native");
context.document.activeElement = {};
context.containMediaViewerFocus(focusViewer, tabEvent());
assert.equal(context.document.activeElement, firstControl, "focus outside the modal is recovered on Tab");
assert.equal(context.containMediaViewerFocus(focusViewer, tabEvent({ ctrlKey: true })), false, "browser tab switching remains native");
assert.equal(context.containMediaViewerFocus(focusViewer, { key: "ArrowRight" }), false, "Tab containment does not consume video seeking keys");

for (const kind of ["video", "audio"]) {
  const nativeMedia = focusControl(kind, { matches: (selector) => selector === "video, audio" });
  const nativeViewer = { querySelectorAll: () => [closeControl, nativeMedia] };
  context.document.activeElement = nativeMedia;
  for (const shiftKey of [false, true]) {
    const nativeTab = tabEvent({ shiftKey, target: nativeMedia, composedPath: () => [{}, nativeMedia] });
    assert.equal(context.containMediaViewerFocus(nativeViewer, nativeTab), false, `${kind} shadow controls retain native Tab traversal`);
    assert.equal(nativeTab.prevented, false);
    assert.equal(context.document.activeElement, nativeMedia);
  }
  context.focusMediaViewerBoundary(nativeViewer, false);
  assert.equal(context.document.activeElement, closeControl, "end guard returns focus only after native controls are exited");
  context.focusMediaViewerBoundary(nativeViewer, true);
  assert.equal(context.document.activeElement, nativeMedia, "start guard returns reverse traversal to the last visible control");
}
assert.match(app, /data-media-focus-boundary="start" tabindex="0"/);
assert.match(app, /data-media-focus-boundary="end" tabindex="0"/);
assert.match(app, /viewer\.addEventListener\("focusin"/);
assert.match(styles, /\.media-viewer-focus-guard\s*\{[^}]*position: absolute/);

console.log("web media viewer tests passed");
