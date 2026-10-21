// Hidden Electron renderer. Isolated fixture, no production sessions/music/QQ/model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harbour-input-ui-'));
app.setPath('userData', scratch); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const wait = ms => new Promise(r => setTimeout(r, ms));
const configs = [{ width: 1100, theme: 'premium-champagne', cat: 'premium' }, { width: 1100, theme: 'anime-wisteria', cat: 'anime' }, { width: 420, theme: 'anime-wisteria', cat: 'anime' }, { width: 1100, theme: 'anime-stardust', cat: 'anime' }];
function assertInside(rect, viewport, label) {
  assert.ok(rect.width > 200 && rect.height > 100, `${label} must be visibly sized`);
  assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
    `${label} must fit viewport: ${JSON.stringify({ rect, viewport })}`);
}
async function run() {
  await app.whenReady();
  let css = ['themes.css', 'styles.css', 'chat-intake.css'].map(f => fs.readFileSync(path.join(root, 'web', f), 'utf8')).join('\n').replace(/@import[^;]+;/g, '');
  const script = fs.readFileSync(path.join(root, 'web/chat-intake.js'), 'utf8');
  const output = path.join(root, 'assets/reports/message-intake'); fs.mkdirSync(output, { recursive: true });
  for (const config of configs) {
    const win = new BrowserWindow({ width: config.width, height: 800, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const click = async selector => {
      assert.equal(await evaluate(selector => !!document.querySelector(selector), selector), true, `missing control ${selector}`);
      await evaluate(selector => document.querySelector(selector).click(), selector); await wait(30);
    };
    const poll = () => evaluate(() => window.poll());
    const popupHidden = () => evaluate(() => document.getElementById('chatIntakePopover').hidden);
    const modeHidden = () => evaluate(() => document.getElementById('chatInputModePopover').hidden);
    const modeLayout = () => evaluate(() => {
      const menu = document.getElementById('chatInputModePopover'), rect = menu.getBoundingClientRect();
      const lastLine = menu.querySelector('p:last-child').getBoundingClientRect();
      return { rect: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, bodyPortal: menu.parentElement === document.body,
        topHit: menu.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 10)),
        bottomHit: menu.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 10)),
        scrollable: menu.scrollHeight > menu.clientHeight, lastLineVisible: lastLine.bottom <= rect.bottom && lastLine.top >= rect.top,
        anchor: document.querySelector('.input-mode-menu summary').getBoundingClientRect().toJSON(),
        expanded: document.querySelector('.input-mode-menu summary').getAttribute('aria-expanded') };
    });
    const writes = () => evaluate(() => calls.filter(([, options]) => options).map(([url, options]) => ({ url, ...JSON.parse(options.body) })));
    const draft = () => evaluate(() => document.getElementById('draft').value);
    const capture = async suffix => {
      win.webContents.invalidate(); await wait(100);
      fs.writeFileSync(path.join(output, `${config.theme}-${config.width}-${suffix}.png`), (await win.webContents.capturePage()).toPNG());
    };
    try {
      // Reproduce a clipped/transformed composer: both portals must escape it.
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><body data-theme-cat="${config.cat}" data-theme="${config.theme}"><main style="position:absolute;inset:24px;display:flex;flex-direction:column;justify-content:end"><div id="composer" style="overflow:hidden;transform:translateZ(0)"><div id="chatInputStatus" class="chat-input-status" hidden></div><textarea id="draft" class="inp" style="display:block;width:100%;height:96px;min-height:96px;padding:12px;margin:8px 0">UNSENT_DRAFT</textarea><div class="chat-compose-actions" style="display:flex;align-items:center;justify-content:end;gap:8px"><div id="chatInputMode"></div><button class="btn ghost chat-stop-control" id="chatStop">停止</button><button class="btn primary" id="chatSend">发送</button></div></div></main>`));
      await win.webContents.executeJavaScript(script);
      await evaluate(() => {
        window.calls = []; window.sessionId = null; window.updates = []; window.toasts = []; window.localRun = true;
        const local = new Map(); Object.defineProperty(window, 'localStorage', { value: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value) } });
        window.pollTimers = new Map(); window.nextTimer = 0; window.globalListeners = [];
        // Deterministic polling avoids slow waits and tests timer/listener disposal.
        window.setTimeout = (callback, delay) => { const id = ++nextTimer; pollTimers.set(id, { callback, delay }); return id; };
        window.clearTimeout = id => pollTimers.delete(id);
        for (const target of [window, document]) {
          const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
          target.addEventListener = (type, listener, options) => { globalListeners.push({ target, type, listener }); return add(type, listener, options); };
          target.removeEventListener = (type, listener, options) => {
            globalListeners = globalListeners.filter(item => item.target !== target || item.type !== type || item.listener !== listener);
            return remove(type, listener, options);
          };
        }
        window.poll = async () => {
          if (pollTimers.size !== 1) throw new Error(`Expected one poll timer, found ${pollTimers.size}`);
          const [id, timer] = pollTimers.entries().next().value; pollTimers.delete(id); await timer.callback();
        };
        const record = (id, state, extra = {}) => ({ id, state, mode: 'steer', updatedAt: 1, messages: [{ input: `${id} fixture message` }], ...extra });
        window.fixture = { revision: 1, mode: 'steer', busy: true, records: [
          record('waiting', 'waiting', { messages: [{ input: '<img src=x onerror=alert(1)>', attachments: [{ kind: 'image', name: 'one.png' }] }, { input: 'Second queued message' }] }),
          record('collecting', 'collecting'), record('sending', 'sending'), record('accepted', 'accepted'), record('running', 'running'),
          record('paused', 'paused', { output: 'Saved paused response <script>fixtureOnly()</script>' }),
          record('unknown', 'unknown', { error: '<img src=x onerror=alert(2)> unknown receipt' }),
          record('completed', 'completed', { delivery: 'unknown', output: 'Saved final response <img src=x onerror=alert(3)>' }),
          record('delivered', 'completed', { delivery: 'delivered' }),
        ] };
        window.mountFixture = () => HarbourChatIntake.mount({
          api: async (url, options) => {
            calls.push([url, options]);
            if (options) {
              const payload = JSON.parse(options.body); fixture.mode = payload.mode || fixture.mode;
              if (['withdraw', 'steer'].includes(payload.action)) {
                if (window.rejectMutation) { const error = new Error('消息已交给运行处理'); error.status = 409; throw error; }
                const original = fixture.records.find(r => r.id === payload.id);
                if (payload.action === 'withdraw') fixture.records = fixture.records.filter(r => r.id !== payload.id);
                else { original.mode = 'steer'; original.canSteer = false; original.revision++; }
                fixture.revision++;
                const result = { ok: true, id: payload.id, state: payload.action === 'withdraw' ? 'withdrawn' : 'waiting', mode: original?.mode || 'queue', messages: original?.messages || window.lastWithdrawal.messages };
                window.lastWithdrawal = result;
                if (window.holdMutation) return new Promise(resolve => { window.resolveMutation = () => resolve(result); });
                if (window.loseMutationResponse) { window.loseMutationResponse = false; throw new Error('fixture response lost'); }
                return result;
              }
              return { ok: true };
            }
            if (window.holdNextRead) { window.holdNextRead = false; return new Promise(resolve => { window.resolveRead = resolve; }); }
            if (window.returnUnchanged) return { revision: fixture.revision, mode: fixture.mode, busy: fixture.busy, unchanged: true };
            return JSON.parse(JSON.stringify(fixture));
          }, session: () => sessionId, localRunning: () => localRun, changed: value => updates.push(value),
          reload: async () => {
            if (window.holdNextReload) { window.holdNextReload = false; await new Promise(resolve => { window.resolveReload = resolve; }); }
          }, toast: (...args) => toasts.push(args),
          canEdit: () => !document.getElementById('draft').value.trim(),
          restoreDraft: (draft, id) => {
            window.restoreCalls ||= []; restoreCalls.push({ draft, id });
            if (window.refuseRestore || sessionId !== id || document.getElementById('draft').value.trim()) return false;
            document.getElementById('draft').value = draft.text; window.restoredAttachments = draft.attachments; return true;
          },
          mediaUrl: () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#e6d2f0"/><path d="M8 24 16 8l8 16Z" fill="#9884bc"/></svg>'),
        });
        window.disposeFixture = mountFixture();
      });
      assert.equal(await evaluate(() => pollTimers.size), 1, 'initial null session must keep polling');
      await evaluate(() => { sessionId = 'fixture'; }); await poll();
      assert.equal(await evaluate(() => document.getElementById('chatInputStatus').hidden), false);
      const contract = await evaluate(() => {
        const status = document.getElementById('chatInputStatus'), trigger = status.querySelector('.intake-status-trigger'), popup = document.getElementById('chatIntakePopover');
        return { tag: trigger?.tagName, text: trigger?.textContent, expanded: trigger?.getAttribute('aria-expanded'), controls: trigger?.getAttribute('aria-controls'),
          bodyPortal: popup?.parentElement === document.body, popupClass: popup?.classList.contains('intake-popover'), role: popup?.getAttribute('role'), modal: popup?.getAttribute('aria-modal'),
          hidden: popup?.hidden, inlineItems: status.querySelectorAll('.intake-items').length, close: !!popup?.querySelector('[data-intake-close]'),
          chevron: !!trigger?.querySelector('[aria-hidden="true"]'), articles: popup?.querySelectorAll('.intake-items article').length };
      });
      assert.equal(contract.tag, 'BUTTON'); assert.match(contract.text, /消息状态\s*·\s*9\s*条/); assert.match(contract.text, /查看/);
      assert.equal(contract.chevron, true, 'trigger must have a visual affordance');
      assert.equal(contract.expanded, 'false'); assert.equal(contract.controls, 'chatIntakePopover');
      assert.equal(contract.bodyPortal, true); assert.equal(contract.popupClass, true); assert.equal(contract.role, 'dialog'); assert.equal(contract.modal, 'false');
      assert.equal(contract.hidden, true); assert.equal(contract.inlineItems, 0); assert.equal(contract.close, true); assert.equal(contract.articles, 8);
      const layoutBefore = await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON()));
      await click('.intake-status-trigger');
      assert.equal(await popupHidden(), false);
      assert.equal(await evaluate(() => document.querySelector('.intake-status-trigger').getAttribute('aria-expanded')), 'true');
      assert.match(await evaluate(() => document.querySelector('.intake-status-trigger').textContent), /收起/);
      assert.deepEqual(await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON())), layoutBefore, 'opening a portal must not move or shrink composer controls');
      const visual = await evaluate(() => {
        const popup = document.getElementById('chatIntakePopover'), rect = popup.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
        return { rect: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, onTop: popup.contains(hit), text: popup.textContent,
          imageCount: popup.querySelectorAll('img, script').length, position: getComputedStyle(popup).position };
      });
      assertInside(visual.rect, visual.viewport, 'status popover'); assert.equal(visual.position, 'fixed'); assert.equal(visual.onTop, true, 'portal must escape clipped composer stacking context');
      for (const state of ['等待', '处理中', '已暂停', '待核对']) assert.ok(visual.text.includes(state), `must distinguish ${state} state`);
      assert.equal(visual.imageCount, 0, 'message/error/output HTML must remain escaped'); assert.ok(visual.text.includes('<img src=x onerror=alert(1)>'));
      assert.equal(await draft(), 'UNSENT_DRAFT'); assert.deepEqual(await writes(), [], 'viewing records must not acknowledge, resend or resume');
      await capture('status-popover');

      await evaluate(() => {
        const detail = document.querySelector('#chatIntakePopover .intake-items details'); detail.open = true; window.openDetailText = detail.querySelector('summary').textContent;
        const items = document.querySelector('#chatIntakePopover .intake-items'); items.scrollTop = 90; window.savedScroll = items.scrollTop; window.returnUnchanged = true;
      });
      assert.ok(await evaluate(() => savedScroll > 0), 'fixture must overflow to exercise scroll preservation');
      await poll(); assert.equal(await popupHidden(), false);
      assert.equal(await evaluate(() => document.querySelector('#chatIntakePopover .intake-items').scrollTop), await evaluate(() => savedScroll));
      assert.equal(await evaluate(() => [...document.querySelectorAll('#chatIntakePopover details')].some(detail => detail.open && detail.querySelector('summary').textContent === openDetailText)), true, 'unchanged poll preserves nested details');
      await evaluate(() => { returnUnchanged = false; });
      await click('.intake-status-trigger'); assert.equal(await popupHidden(), true);
      await click('.intake-status-trigger'); await click('[data-intake-close]');
      assert.equal(await popupHidden(), true); assert.equal(await evaluate(() => document.activeElement.matches('.intake-status-trigger')), true, 'close button returns focus');
      await click('.intake-status-trigger');
      await evaluate(() => { document.querySelector('[data-intake-close]').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(await popupHidden(), true); assert.equal(await evaluate(() => document.activeElement.matches('.intake-status-trigger')), true, 'Escape returns focus');
      await click('.intake-status-trigger');
      await evaluate(() => document.querySelector('#chatIntakePopover .intake-items article').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      assert.equal(await popupHidden(), false, 'inside pointerdown must not close');
      await evaluate(() => document.getElementById('draft').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      assert.equal(await popupHidden(), true, 'outside pointerdown closes');

      await click('.intake-status-trigger'); await click('.input-mode-menu summary');
      assert.equal(await popupHidden(), true, 'opening mode menu closes status');
      assert.equal(await evaluate(() => document.querySelector('.input-mode-menu').open), true);
      await click('.intake-status-trigger');
      assert.equal(await evaluate(() => document.querySelector('.input-mode-menu').open), false, 'opening status closes mode menu');
      assert.equal(await modeHidden(), true, 'closing mode menu must also hide its portal');
      assert.deepEqual(await writes(), [], 'all view/close paths are read-only');
      // Keep the transform/overflow repro enabled. The old test removed it here,
      // masking the real composer clipping regression shown by the user.
      await evaluate(() => { document.getElementById('composer').style.containerType = 'inline-size'; });
      const modeLayoutBefore = await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON()));
      await click('.input-mode-menu summary');
      const menu = await modeLayout();
      assertInside(menu.rect, menu.viewport, 'mode menu');
      assert.equal(menu.bodyPortal, true); assert.equal(menu.topHit, true); assert.equal(menu.bottomHit, true, 'entire menu must escape composer clipping');
      assert.equal(menu.lastLineVisible, true, 'temporary-mode and goal help must not be cropped');
      assert.equal(menu.expanded, 'true'); assert.ok(menu.rect.bottom <= menu.anchor.top - 7, 'bottom composer menu opens upwards');
      assert.deepEqual(await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON())), modeLayoutBefore, 'mode portal must not reflow composer');
      await evaluate(() => document.querySelector('[data-input-mode="queue"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      assert.equal(await modeHidden(), false, 'portal options are inside, not outside-click targets');
      await click('[data-input-mode="queue"]');
      assert.equal(await evaluate(() => document.querySelector('.input-mode-menu summary span').textContent), '排队');
      assert.equal(await evaluate(() => HarbourChatIntake.get().mode), 'queue', 'sending immediately after mode selection uses the confirmed new mode');
      assert.equal(await modeHidden(), true); assert.equal(await evaluate(() => document.activeElement.matches('.input-mode-menu summary')), true);
      assert.deepEqual(await writes(), [{ url: '/api/conversations/fixture/inputs', mode: 'queue' }]);
      await click('.input-mode-menu summary'); await capture('verified');
      // Resize and zoom while open. In a short viewport every line must remain
      // reachable by scrolling, with the menu itself wholly inside the viewport.
      const originalSize = win.getContentSize();
      // Keep the trigger onscreen as the viewport shrinks; the expanded queue
      // is now real content above it, unlike the old one-line status summary.
      await evaluate(() => { document.querySelector('main').style.top = 'unset'; });
      win.setContentSize(config.width, 310); win.webContents.setZoomFactor(1.25); await wait(120);
      const shortMenu = await modeLayout(); assertInside(shortMenu.rect, shortMenu.viewport, 'zoomed short mode menu');
      assert.equal(shortMenu.scrollable, true); assert.equal(shortMenu.topHit, true); assert.equal(shortMenu.bottomHit, true);
      await evaluate(() => { const menu = document.getElementById('chatInputModePopover'); menu.scrollTop = menu.scrollHeight; }); await wait(50);
      assert.equal((await modeLayout()).lastLineVisible, true, 'last help line can be scrolled into view');
      await capture('mode-short-zoom');
      win.webContents.setZoomFactor(1); win.setContentSize(...originalSize);
      await evaluate(() => { document.querySelector('main').style.top = '24px'; }); await wait(120);
      assertInside((await modeLayout()).rect, (await modeLayout()).viewport, 'restored mode menu');
      // Moving the composer via page scroll must re-anchor without a resize.
      await evaluate(() => { document.querySelector('.intake-queue').style.display = 'none'; document.querySelector('main').style.top = '4px'; document.querySelector('main').style.bottom = 'unset'; document.dispatchEvent(new Event('scroll')); }); await wait(80);
      const topMenu = await modeLayout(); assertInside(topMenu.rect, topMenu.viewport, 'top-anchored mode menu');
      assert.ok(topMenu.rect.top >= topMenu.anchor.bottom + 7, 'near the top it opens below when that side has more space');
      await evaluate(() => { document.querySelector('.intake-queue').style.display = ''; document.querySelector('main').style.top = '24px'; document.querySelector('main').style.bottom = '24px'; document.dispatchEvent(new Event('scroll')); }); await wait(80);
      // Body portals retain keyboard navigation from the composer trigger.
      await evaluate(() => { const trigger = document.querySelector('.input-mode-menu summary'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
      assert.equal(await evaluate(() => document.activeElement.dataset.inputMode), 'queue');
      await evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })));
      assert.equal(await evaluate(() => document.activeElement.dataset.inputMode), 'steer');
      await evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
      assert.equal(await modeHidden(), true); assert.equal(await evaluate(() => document.activeElement.matches('.input-mode-menu summary')), true);
      await click('.input-mode-menu summary');
      await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(await evaluate(() => document.querySelector('.input-mode-menu').open), false);
      assert.equal(await modeHidden(), true); assert.equal(await evaluate(() => document.querySelector('.input-mode-menu summary').getAttribute('aria-expanded')), 'false');
      await click('.input-mode-menu summary');
      await evaluate(() => document.getElementById('draft').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      assert.equal(await modeHidden(), true, 'outside pointerdown closes mode portal');
      await click('.input-mode-menu summary');
      // A never-shown offscreen window does not dispatch focusin automatically.
      await evaluate(() => { const draft = document.getElementById('draft'); draft.focus(); draft.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
      assert.equal(await modeHidden(), true, 'tabbing/focusing away closes mode portal');

      // Recovery must still use explicit buttons and the exact receipt ID.
      await click('.intake-status-trigger');
      await evaluate(() => document.querySelector('[data-input-action="acknowledge"][data-id="unknown"]').closest('details').open = true);
      await click('[data-input-action="acknowledge"][data-id="unknown"]');
      await evaluate(() => document.querySelector('[data-input-action="resend"][data-id="completed"]').closest('details').open = true);
      await click('[data-input-action="resend"][data-id="completed"]');
      await click('[data-input-resume]');
      assert.deepEqual(await writes(), [
        { url: '/api/conversations/fixture/inputs', mode: 'queue' },
        { url: '/api/conversations/fixture/inputs', action: 'acknowledge', id: 'unknown', confirmUnknown: true },
        { url: '/api/conversations/fixture/inputs', action: 'resend', id: 'completed', confirmUnknown: true },
        { url: '/api/conversations/fixture/inputs', action: 'resume' },
      ]);
      assert.equal(await draft(), 'UNSENT_DRAFT');

      // Hold the next session's response: old receipts must hide before it resolves.
      await evaluate(() => { sessionId = 'next-session'; holdNextRead = true; window.pendingPoll = poll(); });
      assert.equal(await popupHidden(), true, 'session change closes old popup immediately');
      assert.equal(await evaluate(() => document.getElementById('chatInputStatus').hidden), true, 'stale session summary hides while loading');
      await evaluate(async () => { fixture = { revision: 2, mode: 'steer', busy: false, records: [] }; resolveRead(JSON.parse(JSON.stringify(fixture))); await pendingPoll; });
      assert.equal(await evaluate(() => document.getElementById('chatInputStatus').hidden), true);
      assert.equal(await evaluate(() => document.querySelectorAll('#chatIntakePopover .intake-items article').length), 0, 'empty session clears old records');
      await click('.input-mode-menu summary');
      await evaluate(() => { fixture.readOnly = true; }); await poll();
      assert.equal(await modeHidden(), true, 'switching to a read-only mirror closes the mode portal');
      await evaluate(() => { fixture.readOnly = false; }); await poll(); await click('.input-mode-menu summary');
      await evaluate(() => { sessionId = 'another-session'; }); await poll();
      assert.equal(await modeHidden(), true, 'session change closes mode portal without submitting a mode');
      await evaluate(() => { fixture.records = [{ id: 'only', state: 'completed', delivery: 'unknown', mode: 'steer', updatedAt: 2, messages: [{ input: 'New session receipt' }], output: 'Short saved reply.\nSecond saved line.' }]; fixture.revision++; });
      await poll(); await click('.intake-status-trigger');
      // A short popup must move upwards as its own details grow, even if neither
      // the viewport nor the composer resizes (the saturated-list case cannot catch this).
      const singleLayout = await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON()));
      const singleBefore = await evaluate(() => ({ rect: document.getElementById('chatIntakePopover').getBoundingClientRect().toJSON(), maxHeight: parseFloat(document.getElementById('chatIntakePopover').style.maxHeight) }));
      assert.ok(singleBefore.rect.height < singleBefore.maxHeight - 30, 'single-record fixture starts below max height');
      let previousHeight = singleBefore.rect.height;
      const writesBeforeExpand = await writes();
      for (const section of ['reply', 'actions']) {
        await click(`[data-intake-section="${section}"] > summary`); await wait(80);
        const expanded = await evaluate(() => ({ rect: document.getElementById('chatIntakePopover').getBoundingClientRect().toJSON(), composerTop: document.getElementById('composer').getBoundingClientRect().top, viewport: { width: innerWidth, height: innerHeight } }));
        assert.ok(expanded.rect.height > previousHeight + 5, `opening ${section} must actually enlarge the short popup`);
        assert.ok(expanded.rect.bottom <= expanded.composerTop - 16 + 1, `${section} expansion must remain above the composer drag area: ${JSON.stringify(expanded)}`);
        assertInside(expanded.rect, expanded.viewport, `single-record ${section}`);
        assert.deepEqual(await evaluate(() => ['composer', 'draft', 'chatSend', 'chatStop'].map(id => document.getElementById(id).getBoundingClientRect().toJSON())), singleLayout, `${section} expansion must not move input geometry`);
        previousHeight = expanded.rect.height;
      }
      assert.deepEqual(await writes(), writesBeforeExpand, 'expanding saved replies/recovery details is read-only');
      await capture('single-expanded');
      await evaluate(() => { fixture.records = []; fixture.revision++; }); await poll();
      assert.equal(await popupHidden(), true, 'no pending records closes popup');
      assert.equal(await evaluate(() => document.getElementById('chatInputStatus').hidden), true);
      await evaluate(() => { fixture.records = [{ id: 'last', state: 'paused', mode: 'steer', updatedAt: 3, messages: [{ input: 'Last receipt' }] }]; fixture.revision++; });
      await poll(); await click('.intake-status-trigger');
      await evaluate(() => { sessionId = null; }); await poll();
      assert.equal(await popupHidden(), true, 'leaving session closes popup');
      assert.equal(await evaluate(() => document.getElementById('chatInputStatus').hidden), true);
      assert.equal(await draft(), 'UNSENT_DRAFT');
      await evaluate(() => { sessionId = 'next-session'; }); await poll(); await click('.intake-status-trigger');

      await evaluate(() => { fixture.recoveryError = 'Fixture recovery error <img src=x>'; }); await poll();
      await click('.intake-status-trigger'); await poll();
      assert.equal(await popupHidden(), false, 'an identical recovery error poll keeps its popup open');
      assert.equal(await evaluate(() => document.querySelectorAll('#chatIntakePopover .intake-error').length), 1, 'identical recovery errors do not duplicate content');
      assert.equal(await evaluate(() => document.querySelectorAll('#chatIntakePopover img').length), 0);
      await evaluate(() => { delete fixture.recoveryError; }); await poll();

      // Compact queue: real row controls, attachment restoration and a safe edit
      // recovery after an unknown response. These are isolated local HTTP stubs.
      await evaluate(() => {
        window.rowFixture = (id, extra = {}) => ({ id, mode: 'queue', state: 'waiting', updatedAt: 4, revision: 1, canWithdraw: true, canSteer: true,
          messages: [{ input: '把这张图调整为正方形，保留原来的颜色与细节，然后看看有没有更自然的布局。' }], ...extra });
        fixture.records = [rowFixture('edit-image', { messages: [{ input: '这张图的构图想改一下，保持其他细节。', attachments: [{ kind: 'image', url: '/uploads/square.png', name: 'square.png' }] }] }),
          rowFixture('promote'), rowFixture('delete-row'), rowFixture('steer-row', { mode: 'steer', canSteer: false }),
          rowFixture('already-sent', { state: 'accepted', canWithdraw: false, canSteer: false })]; fixture.revision++;
        document.getElementById('draft').value = '';
      }); await poll();
      if (!await popupHidden()) await click('.intake-status-trigger');
      await capture('compact-queue');
      const queueLayout = await evaluate(() => {
        const row = document.querySelector('.intake-row'), text = row.querySelector('.intake-row-text');
        return { height: row.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth,
          mask: getComputedStyle(text).maskImage, ellipsis: getComputedStyle(text).textOverflow,
          images: document.querySelectorAll('.intake-thumb').length, dangerousActions: document.querySelectorAll('[data-id="already-sent"] [data-queue-action="edit"], [data-id="already-sent"] [data-queue-action="delete"]').length };
      });
      assert.ok(queueLayout.height <= 48); assert.equal(queueLayout.overflow, false);
      assert.match(queueLayout.mask, /linear-gradient/); assert.notEqual(queueLayout.ellipsis, 'ellipsis');
      assert.equal(queueLayout.images, 1); assert.equal(queueLayout.dangerousActions, 0);
      const restoresBefore = await evaluate(() => (window.restoreCalls || []).length);
      await click('[data-queue-action="edit"][data-id="edit-image"]');
      assert.equal(await draft(), '/queue 这张图的构图想改一下，保持其他细节。');
      assert.deepEqual(await evaluate(() => restoredAttachments), [{ kind: 'image', url: '/uploads/square.png', name: 'square.png' }]);
      assert.equal(await evaluate(() => restoreCalls.length), restoresBefore + 1);
      assert.equal(await evaluate(() => document.querySelector('.intake-row[data-id="edit-image"]')), null);
      assert.equal(await evaluate(() => JSON.parse(localStorage.getItem('harbour-input-edit-recovery-v1')).length), 0);
      assert.equal(await evaluate(() => calls.filter(([, o]) => o?.method === 'POST').length), 0, 'editing must never auto-send');
      await click('[data-queue-action="steer"][data-id="promote"]');
      assert.equal(await evaluate(() => fixture.records.find(r => r.id === 'promote').mode), 'steer');
      assert.equal(await evaluate(() => fixture.mode), 'steer', 'row promotion cannot change session default');
      await click('[data-queue-action="delete"][data-id="delete-row"]');
      assert.equal(await evaluate(() => fixture.records.some(r => r.id === 'delete-row')), false);
      assert.equal(await draft(), '/queue 这张图的构图想改一下，保持其他细节。', 'deleting another row preserves draft');

      await evaluate(() => { fixture.records = [rowFixture('offline')]; fixture.revision++; document.getElementById('draft').value = ''; loseMutationResponse = true; }); await poll();
      await click('[data-queue-action="edit"][data-id="offline"]');
      assert.equal(await draft(), '', 'lost confirmation must not claim successful withdrawal');
      assert.match(await evaluate(() => document.querySelector('.intake-recovery').textContent), /核对撤回/);
      // Simulate a full view remount with browser-local recovery still available.
      await evaluate(() => { disposeFixture(); disposeFixture = mountFixture(); }); await wait(40);
      await click('[data-recover-id="offline"]');
      assert.match(await draft(), /^\/queue /);
      const retries = await evaluate(() => calls.filter(([, o]) => o && JSON.parse(o.body).id === 'offline').map(([, o]) => JSON.parse(o.body)));
      assert.equal(retries.length, 2); assert.deepEqual(retries[0], retries[1], 'lost receipt is retried with exact ID and revision');

      await evaluate(() => { fixture.records = [rowFixture('session-race')]; fixture.revision++; document.getElementById('draft').value = ''; holdMutation = true; window.editSessionId = sessionId; }); await poll();
      await click('[data-queue-action="edit"][data-id="session-race"]');
      await evaluate(() => { sessionId = 'other-view'; document.getElementById('draft').value = 'OTHER_SESSION_DRAFT'; disposeFixture(); disposeFixture = mountFixture(); }); await wait(35);
      await evaluate(() => { holdMutation = false; resolveMutation(); }); await wait(35);
      assert.equal(await draft(), 'OTHER_SESSION_DRAFT');
      assert.equal(await evaluate(() => restoreCalls.at(-1).id === editSessionId), true, 'late response is pinned to original session');
      await evaluate(() => { sessionId = editSessionId; document.getElementById('draft').value = ''; }); await poll();
      await click('[data-recover-id="session-race"]'); assert.match(await draft(), /^\/queue /);

      await evaluate(() => { fixture.records = [rowFixture('draft-race')]; fixture.revision++; document.getElementById('draft').value = ''; holdMutation = true; }); await poll();
      await click('[data-queue-action="edit"][data-id="draft-race"]');
      await evaluate(() => { document.getElementById('draft').value = 'NEW_DRAFT_TYPED_WHILE_WITHDRAWING'; holdMutation = false; resolveMutation(); }); await wait(40);
      assert.equal(await draft(), 'NEW_DRAFT_TYPED_WHILE_WITHDRAWING');
      assert.match(await evaluate(() => document.querySelector('.intake-recovery').textContent), /继续编辑/);
      const writesBeforeRecover = (await writes()).length;
      await evaluate(() => { document.getElementById('draft').value = ''; }); await click('[data-recover-id="draft-race"]');
      assert.equal((await writes()).length, writesBeforeRecover, 'confirmed recovery never repeats a write');
      assert.match(await draft(), /^\/queue /);

      await evaluate(() => { fixture.records = [rowFixture('server-race')]; fixture.revision++; document.getElementById('draft').value = ''; rejectMutation = true; }); await poll();
      await click('[data-queue-action="edit"][data-id="server-race"]');
      assert.equal(await draft(), ''); assert.equal(await evaluate(() => fixture.records.length), 1);
      assert.equal(await evaluate(() => JSON.parse(localStorage.getItem('harbour-input-edit-recovery-v1')).length), 0);
      await evaluate(() => { rejectMutation = false; toasts = []; document.getElementById('draft').value = 'UNSENT_DRAFT'; });
      if (await popupHidden()) await click('.intake-status-trigger');

      // reload() may outlive a session switch or the whole view. Its completion
      // must not emit stale changed(busy) into the next session/view.
      const updatesBeforeSwitch = await evaluate(() => updates.length);
      await evaluate(() => { localRun = false; holdNextReload = true; fixture.records[0].updatedAt++; window.pendingReloadPoll = poll(); });
      assert.equal(await evaluate(() => typeof resolveReload), 'function', 'fixture reached deferred reload');
      assert.equal(await evaluate(() => updates.length), updatesBeforeSwitch);
      await evaluate(async () => { sessionId = 'post-reload-session'; resolveReload(); await pendingReloadPoll; });
      assert.equal(await evaluate(() => updates.length), updatesBeforeSwitch, 'late reload from old session cannot invoke changed');
      await evaluate(() => { localRun = true; }); await poll();
      if (await popupHidden()) await click('.intake-status-trigger');
      const updatesBeforeDispose = await evaluate(() => updates.length);
      await evaluate(() => { localRun = false; holdNextReload = true; fixture.records[0].updatedAt++; window.pendingReloadPoll = poll(); });
      assert.equal(await evaluate(() => updates.length), updatesBeforeDispose);
      const callsBeforeDispose = await evaluate(() => calls.length);
      await evaluate(async () => { disposeFixture(); resolveReload(); await pendingReloadPoll; });
      assert.equal(await evaluate(() => updates.length), updatesBeforeDispose, 'late reload after dispose cannot invoke changed');
      assert.equal(await evaluate(() => document.getElementById('chatIntakePopover')), null, 'dispose removes body portal');
      assert.equal(await evaluate(() => document.getElementById('chatInputModePopover')), null, 'dispose removes mode portal');
      assert.equal(await evaluate(() => pollTimers.size), 0, 'dispose removes timer');
      assert.equal(await evaluate(() => globalListeners.length), 0, 'dispose removes document/window listeners');
      await evaluate(() => { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new Event('resize')); });
      assert.equal(await evaluate(() => calls.length), callsBeforeDispose, 'disposed listeners cannot issue requests');
      assert.equal(await evaluate(() => HarbourChatIntake.get()), undefined); assert.equal(await draft(), 'UNSENT_DRAFT');
      assert.deepEqual(await evaluate(() => toasts), []);
      console.log(`PASS message UI ${config.cat} ${config.width}: both portals escape clipping, resize/zoom/scroll bounds, keyboard, no reflow, poll/session lifecycle, explicit recovery, cleanup, escaped input, draft preserved`);
    } finally { win.destroy(); }
  }
}
run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
