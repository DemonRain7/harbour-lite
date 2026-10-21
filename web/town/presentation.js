// Only a narrow host bridge is used. Town never receives Dashboard desktop tools.
export function bindPresentation(town, notice, signal) {
  const native = window.harbourTownHost;
  const popout = document.getElementById('popout'), fullscreen = document.getElementById('fullscreen');
  let parentHost, openerHost, state;
  try { if (parent !== window) parentHost = parent.HarbourTownUI; } catch {}
  try { openerHost = opener?.HarbourTownUI; } catch {}
  function sync(next) {
    if (next) { state = next; town.setVisible(next.visible); }
    const full = native ? !!state?.fullscreen : !!document.fullscreenElement;
    fullscreen.textContent = full ? '退出全屏 ⛶' : '全屏 ⛶'; fullscreen.setAttribute('aria-pressed', String(full));
    popout.textContent = (native && state?.mode === 'window') || openerHost ? '嵌回此页 ↙' : '独立窗口 ↗';
    popout.hidden = !native && !parentHost && !openerHost;
    const unavailable = parentHost?.popoutUnavailableReason?.();
    popout.title = unavailable || '';
    if (unavailable) popout.textContent = '独立窗口 · 需重启';
  }
  if (native) {
    let receivedState = false;
    const off = native.onState(next => { receivedState = true; sync(next); }); signal.addEventListener('abort', off, { once: true });
    // A slow initial snapshot must not override a newer pop-out/hide event.
    native.status().then(next => { if (!receivedState && !signal.aborted) sync(next); }).catch(error => { if (!signal.aborted) notice(error.message); });
    let approved = false;
    native.onBeforeClose(async ({ phase }) => {
      if (phase === 'cancel') { approved = false; document.body.inert = false; return true; }
      if (phase === 'commit') {
        // Another window can still cancel application quit. Stop approved work,
        // but leave drafts intact until the native window really unloads.
        const allow = !town.dirty() || (approved && await town.discard({ keepDrafts: true }));
        approved = false; document.body.inert = false; return allow;
      }
      if (!town.dirty()) return true;
      approved = await confirmClose();
      if (!approved) return false;
      if (phase === 'check') { document.body.inert = true; return true; }
      return town.discard();
    });
  } else if (parentHost) town.setVisible(parentHost.isVisible());
  else if (openerHost) town.restore(openerHost.takeTransfer());
  fullscreen.addEventListener('click', async () => {
    try {
      if (native) await native.fullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) { notice(`暂时无法全屏：${error.message}`); }
  }, { signal });
  document.addEventListener('fullscreenchange', () => sync(), { signal });
  popout.addEventListener('click', async () => {
    try {
      if (native) { if (state?.mode === 'window') await native.dock(); else await native.popout(); }
      else if (openerHost) {
        if (town.status().busy) { notice('请先等待对话完成或停止，再嵌回。'); return; }
        openerHost.returnFromPopup(town.snapshot()); town.prepareTransfer(); opener.focus(); window.close();
      } else if (!parentHost?.popout()) notice(town.status().busy ? '浏览器版请先等待对话完成或停止，再打开独立窗口。' : '请允许此站点弹出小镇窗口。');
    } catch (error) { notice(error.message); }
  }, { signal });
  // A normal popup close also returns its last camera/draft state to the live iframe.
  if (openerHost) window.addEventListener('pagehide', () => { try { if (!town.isTransferring?.()) openerHost.returnFromPopup(town.snapshot()); } catch {} }, { once: true });
  sync();
}

function confirmClose() {
  const dialog = document.createElement('dialog'); dialog.className = 'town-close-dialog';
  const heading = document.createElement('h2'); heading.id = 'town-close-heading'; heading.textContent = '要离开小镇吗？';
  dialog.setAttribute('aria-labelledby', heading.id);
  const note = document.createElement('p'); note.textContent = '还有未发送的草稿或进行中的对话。离开会丢弃草稿，并先停止这次对话。';
  const stay = document.createElement('button'); stay.textContent = '留在小镇'; stay.autofocus = true; stay.dataset.stay = '';
  const leave = document.createElement('button'); leave.textContent = '停止并离开'; leave.dataset.leave = '';
  const actions = document.createElement('div'); actions.append(stay, leave); dialog.append(heading, note, actions); document.body.append(dialog);
  return new Promise(resolve => {
    const done = value => { dialog.close(); dialog.remove(); resolve(value); };
    stay.onclick = () => done(false); leave.onclick = () => done(true);
    dialog.addEventListener('cancel', event => { event.preventDefault(); done(false); }, { once: true });
    dialog.showModal();
  });
}
