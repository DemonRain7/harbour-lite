// Isolated Chromium/DOM regression: no real backend, model, clipboard or visible window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const section = (from, to) => {
  const start = app.indexOf(from), end = app.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `fixture source: ${from}`);
  return app.slice(start, end);
};
const uploadSource = section('function fileToDataUrl(', 'async function queueWebTranscription(')
  + section('async function handleFilesPicked(', '// 录音：');
const renderSource = section('function renderChatAttachments(', 'function mediaDisplayName(');
const imageSource = section('function copyableChatImage(', 'async function fetchChatImageBlob(');
const bindings = section('    $("#chatAttach").addEventListener("click"', '    $("#chatMic").addEventListener(');
const hint = app.match(/<div class="chat-drop-hint"[^]*?<\/div>/)?.[0];
assert.ok(hint);
assert.ok(index.indexOf('src="/chat-drop.js"') >= 0 && index.indexOf('src="/chat-drop.js"') < index.indexOf('src="/app.js"'));
assert.match(app, /disposeChatDrop\?\.\(\); disposeChatDrop = null;/);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
const profileBase = path.join(root, 'data/runtime/test-fixtures/chat-drop');

test('Main Chat attachment drops share the paste/picker upload path', { timeout: 60000 }, async t => {
  fs.mkdirSync(profileBase, { recursive: true });
  const profile = fs.mkdtempSync(path.join(profileBase, 'profile-'));
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined),
    args: ['--disable-gpu', '--disable-background-networking'],
    env: { ...process.env, TEMP: profile, TMP: profile, TMPDIR: profile },
    viewport: { width: 1180, height: 760 }, reducedMotion: 'reduce',
  });
  t.after(async () => {
    await browser.close();
    assert.ok(path.resolve(profile).startsWith(profileBase + path.sep));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body data-theme="anime-wisteria" data-theme-cat="anime"><main class="preview">
    <h2>附件拖拽测试</h2><div id="outside"><a class="att-img-link" href="/uploads/original.png"><img id="historyImage" class="md-img-real" alt="旧图" src="data:image/png;base64,${png}"></a></div>
    <div class="chat-compose">${hint}<div id="chatAttachments"></div><div id="chatSpeechStatus" hidden></div>
      <div class="chat-compose-row"><textarea class="inp" id="chatInput" aria-label="消息">保留这段草稿</textarea></div>
      <div class="chat-toolbar"><button id="chatAttach" class="btn ghost icon">＋</button><button id="chatSend" class="btn primary">发送</button></div>
      <input type="file" id="chatFile" multiple hidden></div></main></body></html>`;
  await browser.route('**/*', route => route.request().url() === 'http://harbour-drag.test/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  const page = browser.pages()[0], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://harbour-drag.test/');
  for (const file of ['themes.css', 'styles.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'web', file), 'utf8') });
  await page.addStyleTag({ content: 'html,body{overflow:auto;min-height:100vh;height:auto}.preview{max-width:900px;margin:48px auto;padding:24px}#outside{height:150px}#historyImage{width:48px;height:48px;border:1px solid var(--border)}.chat-toolbar{justify-content:space-between}@media(max-width:600px){.preview{margin:8px;padding:8px}}' });
  assert.equal(await page.locator('.chat-drop-hint span').textContent(), '松开以添加图片或文件');
  await page.evaluate(png => {
    window.$ = selector => document.querySelector(selector);
    window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.HarbourTime = { format: () => '2026-10-22' };
    window.withToken = url => url + (url.includes('?') ? '&' : '?') + 'token=fixture-only';
    window.messages = []; window.uploads = []; window.fetches = [];
    window.toast = (message, error = false) => messages.push({ message, error });
    window.queueWebTranscription = async () => {};
    window.resetFixture = () => {
      window.state = { chat: { attachments: [], pendingUploads: 0, sttControllers: new Map() } };
      messages.length = 0; uploads.length = 0; fetches.length = 0;
      window.uploadPending = [];
      window.fetchMode = ''; window.rejectUploadNames = [];
      $('#chatInput').value = '保留这段草稿';
    };
    resetFixture();
    window.fixtureBytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    window.api = async (url, options) => {
      if (url !== '/api/upload' || options.method !== 'POST') throw new Error('Unexpected API');
      const body = JSON.parse(options.body); uploads.push(body);
      uploadPending.push(state.chat.pendingUploads);
      if (rejectUploadNames.includes(body.name)) throw new Error('模拟上传失败');
      return { attachment: { name: body.name, mime: body.mime, kind: body.mime.startsWith('image/') ? 'image' : 'file', url: '/uploads/' + uploads.length + '.png' } };
    };
    window.fetch = async (url, options) => {
      fetches.push({ url: String(url), credentials: options.credentials, referrerPolicy: options.referrerPolicy, redirect: options.redirect });
      if (fetchMode === 'cors') throw new TypeError('Failed to fetch');
      if (fetchMode === 'abort') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
      if (fetchMode === 'deferred') await new Promise(resolve => { window.resolveImageFetch = resolve; });
      const headers = { 'content-type': fetchMode === 'html' ? 'text/html' : 'image/png' };
      if (fetchMode === 'large-header') headers['content-length'] = 26 * 1024 * 1024;
      const body = fetchMode === 'large-body' ? new Uint8Array(26 * 1024 * 1024) : fetchMode === 'empty' ? null : fixtureBytes;
      return new Response(body, { status: fetchMode === 'missing' ? 404 : 200, headers });
    };
    window.transferFiles = names => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([fixtureBytes], name, { type: name.endsWith('.txt') ? 'text/plain' : 'image/png' }));
      return transfer;
    };
    window.dragEvent = (type, transfer, target = $('#chatInput'), relatedTarget = null) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, relatedTarget });
      target.dispatchEvent(event);
      return { prevented: event.defaultPrevented, pending: state.chat.pendingUploads, disabled: $('#chatSend').disabled };
    };
    // Any accidental clipboard use must fail rather than touching the user's clipboard.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get() { throw new Error('Clipboard must not be accessed'); } });
  }, png);
  await page.addScriptTag({ content: imageSource + renderSource + uploadSource });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'web/chat-drop.js'), 'utf8') });
  await page.addScriptTag({ content: 'let disposeChatDrop;\n' + bindings });
  const reset = () => page.evaluate(() => { resetFixture(); renderChatAttachments(); });
  const idle = () => page.waitForFunction(() => state.chat.pendingUploads === 0);
  const snapshot = () => page.evaluate(() => ({ uploads, fetches, messages, attachments: state.chat.attachments, pending: state.chat.pendingUploads, draft: $('#chatInput').value }));

  await t.test('multi-file drop reserves the draft immediately and uploads each file once', async () => {
    const immediate = await page.evaluate(() => dragEvent('drop', transferFiles(['portrait.png', 'notes.txt'])));
    assert.deepEqual(immediate, { prevented: true, pending: 2, disabled: true });
    await idle();
    const result = await snapshot();
    assert.deepEqual(result.uploads.map(x => x.name), ['portrait.png', 'notes.txt']);
    assert.ok(result.uploads[0].dataBase64.endsWith(png));
    assert.equal(result.attachments.length, 2);
    assert.equal(result.draft, '保留这段草稿');
    assert.equal(await page.locator('.att-chip:not(.att-uploading)').count(), 2);
    assert.equal(await page.locator('#chatSend').isDisabled(), false);
  });

  await t.test('paste, file picker and items-only payload remain supported', async () => {
    await reset();
    await page.evaluate(() => $('#chatInput').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transferFiles(['image.png']) })));
    await idle();
    await page.locator('#chatFile').setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await idle();
    await page.evaluate(() => handleFilesPicked(chatClipboardFiles({ files: [], items: [{ kind: 'file', getAsFile: () => new File([fixtureBytes], 'items.png', { type: 'image/png' }) }] })));
    assert.deepEqual((await snapshot()).uploads.map(x => x.name), ['clipboard-2026-10-22.png', 'picked.png', 'items.png']);
    assert.equal(await page.locator('#chatFile').inputValue(), '');
  });

  await t.test('text drops/pastes stay native; misplaced files cannot navigate away', async () => {
    await reset();
    const result = await page.evaluate(() => {
      const text = new DataTransfer(); text.setData('text/plain', '普通文字'); text.setData('text/html', '<b>普通文字</b>');
      const drop = dragEvent('drop', text).prevented;
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: text }); $('#chatInput').dispatchEvent(paste);
      return { drop, paste: paste.defaultPrevented, outside: dragEvent('drop', transferFiles(['misplaced.png']), $('#outside')).prevented };
    });
    assert.deepEqual(result, { drop: false, paste: false, outside: true });
    assert.equal((await snapshot()).uploads.length, 0);
    assert.equal(page.url(), 'http://harbour-drag.test/');
  });

  await t.test('native pointer drag of a historical image uploads original bytes with local authentication', async () => {
    await reset();
    await page.locator('#historyImage').dragTo(page.locator('#chatInput'));
    await page.waitForFunction(() => uploads.length === 1 && state.chat.pendingUploads === 0);
    const result = await snapshot();
    assert.deepEqual(result.fetches, [{ url: '/uploads/original.png?token=fixture-only', credentials: 'same-origin', referrerPolicy: 'no-referrer', redirect: 'error' }]);
    assert.equal(result.uploads[0].dataBase64, `data:image/png;base64,${png}`);
    assert.deepEqual(await page.evaluate(() => uploadPending), [1], 'URL reading hands off one pending slot, not two');
    assert.equal(result.draft, '保留这段草稿');
  });

  await t.test('external image HTML stays inert; remote fetch carries no Harbour token or credentials', async () => {
    await reset();
    const result = await page.evaluate(() => {
      window.fetchMode = 'deferred';
      const data = new DataTransfer(); data.setData('text/html', '<script>window.executed = true</script><img src="https://example.test/art.png" onerror="window.executed = true">');
      return dragEvent('drop', data);
    });
    assert.deepEqual(result, { prevented: true, pending: 1, disabled: true });
    assert.equal(await page.evaluate(() => window.executed), undefined);
    assert.equal(await page.locator('img').count(), 1, 'dropped HTML never inserted');
    await page.evaluate(() => resolveImageFetch()); await idle();
    assert.deepEqual((await snapshot()).fetches, [{ url: 'https://example.test/art.png', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' }]);
    assert.equal((await snapshot()).attachments.length, 1);
  });

  await t.test('read-only mirrors, inspection and switching/sending reject every upload entry', async () => {
    for (const flag of ['readOnlyMirror', 'inspection', 'switchingSession', 'switchingMode', 'inputSending', 'inputRequest']) {
      await reset();
      await page.evaluate(flag => { state.chat[flag] = true; dragEvent('drop', transferFiles(['blocked.png'])); }, flag);
      await page.evaluate(() => handleFilesPicked([new File([fixtureBytes], 'picker.png', { type: 'image/png' })]));
      await page.evaluate(() => $('#chatInput').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transferFiles(['paste.png']) })));
      assert.equal((await snapshot()).uploads.length, 0, flag);
      assert.equal((await snapshot()).pending, 0, flag);
      assert.equal((await snapshot()).messages.length, 3, flag);
    }
    await reset();
    await page.evaluate(() => { state.chat.running = true; dragEvent('drop', transferFiles(['queued.png'])); });
    await idle();
    assert.equal((await snapshot()).attachments.length, 1, 'a running task still allows a draft for the next message');
  });

  await t.test('failures and oversized/non-image responses release the pending lock without fake attachments', async () => {
    for (const mode of ['cors', 'missing', 'html', 'large-header', 'large-body', 'empty', 'abort']) {
      await reset();
      await page.evaluate(mode => {
        window.fetchMode = mode;
        const originalTimeout = window.setTimeout;
        if (mode === 'abort') window.setTimeout = (fn, delay) => originalTimeout(fn, delay === 20000 ? 10 : delay);
        const data = new DataTransfer(); data.setData('text/uri-list', 'https://example.test/photo.png'); dragEvent('drop', data);
        window.setTimeout = originalTimeout;
      }, mode);
      await page.waitForFunction(() => state.chat.pendingUploads === 0 && messages.some(message => message.error));
      const result = await snapshot();
      assert.equal(result.uploads.length, 0, mode);
      assert.equal(result.attachments.length, 0, mode);
      assert.equal(await page.locator('#chatSend').isDisabled(), false, mode);
    }
    await reset();
    await page.evaluate(() => { rejectUploadNames.push('bad.png'); dragEvent('drop', transferFiles(['bad.png', 'good.png'])); });
    await idle();
    assert.deepEqual((await snapshot()).attachments.map(x => x.name), ['good.png'], 'one failed file does not lose the others');
  });

  await t.test('folders, local paths and same-origin non-upload URLs cannot be imported', async () => {
    await reset();
    await page.evaluate(() => {
      const data = transferFiles(['folder']);
      const original = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = () => ({ isDirectory: true });
      try { dragEvent('drop', data); } finally { DataTransferItem.prototype.webkitGetAsEntry = original; }
    });
    assert.equal((await snapshot()).uploads.length, 0);
    assert.match((await snapshot()).messages[0].message, /文件夹/);
    for (const url of ['file:///C:/private.png', '/api/settings/private.png', 'javascript:alert(1)']) {
      await reset();
      await page.evaluate(url => { const data = new DataTransfer(); data.setData('text/html', `<img src="${url}">`); dragEvent('drop', data); }, url);
      await page.waitForFunction(() => messages.some(message => message.error));
      assert.equal((await snapshot()).fetches.length, 0, url);
    }
  });

  await t.test('hover hint clears on nested exits/cancel and fits desktop/mobile themes', async () => {
    await reset();
    const state = await page.evaluate(() => {
      const composer = $('.chat-compose'), input = $('#chatInput'), data = transferFiles(['hover.png']);
      dragEvent('dragenter', data, composer);
      dragEvent('dragenter', data, input);
      dragEvent('dragleave', data, composer, input);
      const inside = composer.classList.contains('is-drag-over');
      dragEvent('dragleave', data, input, $('#outside'));
      return { inside, outside: composer.classList.contains('is-drag-over') };
    });
    assert.deepEqual(state, { inside: true, outside: false });
    const output = path.join(profileBase, 'previews'); fs.mkdirSync(output, { recursive: true });
    for (const [theme, category, width] of [['anime-wisteria', 'anime', 1180], ['premium-tungsten', 'premium', 1180], ['anime-wisteria', 'anime', 390]]) {
      await page.setViewportSize({ width, height: 760 });
      await page.evaluate(({ theme, category }) => {
        document.body.dataset.theme = theme; document.body.dataset.themeCat = category;
        dragEvent('dragover', transferFiles(['hover.png']));
      }, { theme, category });
      const bounds = await page.locator('.chat-drop-hint').boundingBox(), composer = await page.locator('.chat-compose').boundingBox();
      assert.ok(bounds.x >= composer.x && bounds.x + bounds.width <= composer.x + composer.width + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await page.locator('.chat-drop-hint').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
      await page.evaluate(() => dragEvent('dragend', new DataTransfer()));
      assert.equal(await page.locator('.chat-drop-hint').isVisible(), false);
    }
    console.log('Isolated drag/drop previews: ' + output);
  });

  await t.test('unmount removes document drop guards and pending UI listeners', async () => {
    await reset();
    await page.evaluate(() => { dragEvent('dragover', transferFiles(['hover.png'])); disposeChatDrop(); });
    assert.equal(await page.locator('.chat-drop-hint').isVisible(), false);
    const event = await page.evaluate(() => dragEvent('drop', transferFiles(['unmounted.png'])));
    assert.equal(event.prevented, false);
    assert.equal((await snapshot()).uploads.length, 0);
    assert.deepEqual(errors, []);
  });
});
