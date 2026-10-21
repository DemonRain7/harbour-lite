import { RESIDENTS, canChat, sessionKey, displayMessage, TownChat, request } from './client.js';
import { createTownScene } from './scene.js';
import { bindPresentation } from './presentation.js';
import { MAPS, initialMap, mapFor } from './maps.js';
import { createTownVisibility } from './visibility.js';
import { readGraphicsSettings, frameRateFor } from './graphics-settings.js';
import { bindTownSettings } from './settings-panel.js';
import { TownSocial } from './social-state.js';
import { bindTownSocial } from './social-panel.js';

const $ = id => document.getElementById(id);
const lifetime = new AbortController();
const visibility = createTownVisibility({ signal: lifetime.signal, document, native: !!window.harbourTownHost });
const chat = new TownChat();
const activity = { selected: '', busy: '', replies: Object.create(null), greetings: Object.create(null) };
let storage;
try { storage = localStorage; } catch { /* no persistence available */ }
const map = initialMap(location.search, storage);
const social = new TownSocial(map.residents); activity.social = social;
const mapPoses = {};
const residentFor = id => map.residents.find(r => r.id === id);
const TRANSFER = 'harbour-town-map-transfer';
let world = null, selected = null, nearby = null, historyRevision = 0, pendingSend = null, destroyed = false, noticeTimer = null, askTimer = null;
let sound = false, paused = false, hostVisible = true, hoverLook = true, transferring = false, pendingRestore = null;
const drafts = new Map();
const modelStates = new Map();
let socialPanel;
const settingsPanel = bindTownSettings({ signal: lifetime.signal, onOpenChange(open) { if (open) socialPanel?.close({ focus: false }); syncMovement(); updateInteraction(); socialPanel?.refresh(); } });
socialPanel = bindTownSocial({ social, residents: map.residents, activity, world: () => world, signal: lifetime.signal,
  onOpen() { settingsPanel.close({ returnFocus: false }); if (!$('chat').hidden) closeChat(); },
  onChange() { syncMovement(); updateInteraction(); }, onChat: openChat, notice,
  onMenu() { settingsPanel.open(); document.getElementById('tab-residents').click(); },
});
function syncMovement() { if (!destroyed) world?.freeze(settingsPanel.isOpen() || socialPanel?.isOpen() || !$('chat').hidden); }
$('map').value = map.id;
$('scene').setAttribute('aria-label', `${map.name}三维场景，WASD 行走，鼠标靠边持续转向，点击锁定鼠标，Esc 释放`);
document.title = `Harbour · ${map.name}`;
$('current-map-name').textContent = map.name;
document.querySelector('.loading h2').textContent = map.arrival;
try {
  const saved = JSON.parse(sessionStorage.getItem(TRANSFER) || 'null'); sessionStorage.removeItem(TRANSFER);
  if (saved?.mapId === map.id && Date.now() - saved.at < 600000) pendingRestore = saved;
} catch { /* stale or inaccessible transfer never blocks map loading */ }
function modelState(state) {
  modelStates.set(state.id, state);
  $('model-options').replaceChildren();
  const loaded = [...modelStates.values()].filter(s => s.type === 'mmd');
  $('model-credit').textContent = loaded.length ? loaded.map(s => s.credit).join(' · ') : '轻量占位形象 · 未载入本机模型';
  for (const resident of RESIDENTS) {
    const current = modelStates.get(resident.id); if (!current) continue;
    const section = document.createElement('div'); section.className = 'model-option';
    const label = document.createElement('label'); label.textContent = resident.name; section.append(label);
    if (current.type === 'mmd' && current.variants.length > 1) {
      const select = document.createElement('select'); select.setAttribute('aria-label', `${resident.name}${resident.variantLabel || '服装'}`);
      for (const variant of current.variants) { const option = document.createElement('option'); option.value = variant.id; option.textContent = variant.name; select.append(option); }
      select.value = current.variant; label.append(select);
      select.addEventListener('change', async () => {
        if (!world) { select.value = current.variant; return; }
        select.disabled = true;
        try { await world.setOutfit(resident.id, select.value); notice(`${resident.name}的${resident.variantLabel || '服装'}已切换。`); }
        catch (error) { if (!destroyed) { select.value = current.variant; notice(`换装未完成，保留原装：${error.message}`); } }
        finally { select.disabled = false; }
      });
    }
    if (current.hosieryOptions?.length) {
      const select = document.createElement('select'); select.setAttribute('aria-label', `${resident.name}丝袜`);
      for (const style of current.hosieryOptions) { const option = document.createElement('option'); option.value = style.id; option.textContent = style.name; select.append(option); }
      select.value = current.hosiery; section.append(select);
      select.addEventListener('change', () => {
        if (!world) { select.value = current.hosiery; return; }
        try { world.setHosiery(resident.id, select.value); notice(`${resident.name}的丝袜已切换。`); }
        catch (error) { select.value = current.hosiery; notice(`丝袜未能切换：${error.message}`); }
      });
    }
    const info = document.createElement('small'); info.textContent = current.type === 'mmd'
      ? (current.textures?.mode === 'source' ? current.textures.fallback
        ? `${current.textures.fallback} 张贴图沿用优化版` : '原尺寸贴图' : '')
      : `暂用占位形象：${current.error}`;
    if (info.textContent) section.append(info);
    $('model-options').append(section);
  }
  if (loaded.length) {
    $('motion-credit').textContent = loaded.some(s => s.motionLibrary?.startsWith('Quaternius'))
      ? '动作来源：Quaternius / Gonzalo Furnier · CC0。上身轻量适配，配合本地小步走、脚底落点、招手与表情。'
      : '扩展动作未载入，使用本地小步走、脚底落点与互动预设。';
  }
}
let { qualityName, frameRate } = readGraphicsSettings(storage);
$('quality').value = qualityName;
$('fps').value = String(frameRate);
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000); }
function status(text, error = false) { $('chat-status').textContent = text; $('chat-status').classList.toggle('error', error); }
function saveDraft() { if (selected) drafts.set(selected.id, $('message').value); }
function dirty() { saveDraft(); return chat.busy || [...drafts.values()].some(text => text.trim()); }
function message(role, text, name) {
  const node = document.createElement('div'); node.className = `bubble ${role === 'user' ? 'user' : 'assistant'}`;
  const label = document.createElement('span'); label.className = 'bubble-label'; label.textContent = role === 'user' ? '你' : name;
  node.append(label, document.createTextNode(text)); $('messages').append(node);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function empty(text) { const node = document.createElement('p'); node.className = 'empty-chat'; node.textContent = text; $('messages').replaceChildren(node); }
function syncBusy() {
  $('send').disabled = chat.busy; $('stop').hidden = !chat.busy; $('quality').disabled = chat.busy; $('map').disabled = chat.busy;
  $('message').disabled = chat.busy; activity.busy = chat.active?.id || '';
}
function updateInteraction() { $('interact').hidden = !nearby || !$('chat').hidden || settingsPanel.isOpen() || socialPanel?.isOpen(); if (nearby) $('interact').textContent = `E · 和${nearby.name}互动`; }
async function openChat(id) {
  if (!world) return;
  socialPanel.close({ focus: false });
  settingsPanel.close({ returnFocus: false });
  if (!canChat(id)) {
    activity.greetings[id] = (activity.greetings[id] || 0) + 1;
    notice(`${residentFor(id).name}会向你招手。目前是小镇访客，尚未配置独立聊天 Agent。`);
    return;
  }
  if (chat.busy && chat.active.id !== id) { notice('她还在处理这条消息，先等回复或点“停止”。'); return; }
  saveDraft();
  selected = residentFor(id); activity.selected = id;
  world.freeze(true); document.exitPointerLock?.();
  $('chat').hidden = false; document.body.classList.add('chat-open'); updateInteraction();
  $('chat-avatar').src = selected.portrait; $('chat-name').textContent = selected.name; $('chat-place').textContent = world.residentPlace(id);
  $('message').value = drafts.get(id) || '';
  const revision = ++historyRevision;
  if (chat.busy) { syncBusy(); return; }
  status(''); empty('正在找回你们在小镇里的对话…');
  $('send').disabled = true;
  try {
    const messages = await chat.history(id);
    if (destroyed || revision !== historyRevision) return;
    $('messages').replaceChildren();
    if (!messages.length) empty(`她就在这里。\n打个招呼，或者聊聊今天发生的事。`);
    else messages.slice(-60).forEach(m => message(m.role, displayMessage(m), selected.name));
  } catch (error) { if (revision === historyRevision) { empty('暂时没能读取历史。'); status(error.message, true); } }
  finally { if (!destroyed && revision === historyRevision) { syncBusy(); if (!settingsPanel.isOpen() && hostVisible && !document.hidden) $('message').focus({ preventScroll: true }); } }
}
function closeChat() {
  saveDraft(); ++historyRevision; activity.selected = ''; $('chat').hidden = true;
  document.body.classList.remove('chat-open'); syncMovement(); updateInteraction(); if (!settingsPanel.isOpen() && hostVisible && !document.hidden) $('scene').focus({ preventScroll: true });
}
map.residents.forEach(resident => {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'resident'; button.dataset.resident = resident.id;
  const img = document.createElement(resident.portrait ? 'img' : 'span');
  if (resident.portrait) { img.src = resident.portrait; img.alt = ''; }
  else { img.className = 'resident-monogram'; img.textContent = resident.name.slice(0, 1); img.setAttribute('aria-hidden', 'true'); }
  const body = document.createElement('span'), name = document.createElement('strong'), sub = document.createElement('small');
  name.textContent = resident.name; sub.textContent = resident.subtitle; body.append(name, sub);
  const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '↗'; button.append(img, body, arrow);
  button.addEventListener('click', () => {
    if (!world) return;
    if (chat.busy && chat.active.id !== resident.id) { notice('请先等当前回复或停止。'); return; }
    settingsPanel.close({ returnFocus: false });
    closeChat();
    if (!world.focus(resident.id)) notice('附近暂时没有合适的落脚点，等她走开一点再试。');
  });
  $('resident-list').append(button);
});
$('interact').addEventListener('click', () => { if (nearby) socialPanel.open(nearby.id); });
$('chat-close').addEventListener('click', closeChat);
$('message').addEventListener('input', saveDraft);
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('chat').hidden) closeChat(); });

// The Dashboard already displays permission questions. Standalone preview uses
// only its own pending questions; no approval is automatic or inferred from text.
let hosted = false;
try { hosted = parent !== window && !!parent.HarbourTownUI; } catch { /* no parent bridge */ }
async function pollOwnAsk() {
  if (hosted || !chat.busy || destroyed) return;
  try {
    const { asks } = await request('/api/asks');
    const own = (asks || []).filter(ask => ask.sessionKey === sessionKey(chat.active.id));
    for (const ask of own) {
      if (document.querySelector(`[data-ask="${CSS.escape(ask.id)}"]`)) continue;
      const box = document.createElement('div'); box.className = 'bubble'; box.dataset.ask = ask.id;
      const text = document.createElement('p'); text.textContent = ask.question; box.append(text);
      for (const option of ask.options || []) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = option.label;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await request(`/api/asks/${encodeURIComponent(ask.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: option.value }) }); box.remove(); }
          catch (error) { status(error.message, true); button.disabled = false; }
        }); box.append(button);
      }
      $('messages').append(box);
    }
  } catch { /* final run response remains authoritative */ }
  if (chat.busy && !destroyed) askTimer = setTimeout(pollOwnAsk, 4000);
}
async function send() {
  if (!selected || chat.busy) return;
  const text = $('message').value.trim(); if (!text) return;
  const resident = selected;
  ++historyRevision;
  $('messages').querySelector('.empty-chat')?.remove();
  message('user', text, resident.name);
  drafts.set(resident.id, ''); $('message').value = '';
  status(`${resident.name}正在处理你的消息…`);
  const result = chat.send(resident.id, text, world?.residentPlace(resident.id), social.context(resident.id, world?.companionStatus(resident.id)?.company)); syncBusy();
  if (!hosted) askTimer = setTimeout(pollOwnAsk, 1200);
  try {
    const response = await result;
    if (destroyed) return;
    message('assistant', response.answer || '本轮已结束，未返回文字。可在 History 查看记录。', resident.name);
    if (response.answer) activity.replies[resident.id] = (activity.replies[resident.id] || 0) + 1;
    status('已保存到你们的小镇会话。');
  } catch (error) {
    if (destroyed) return;
    status(error.code === 'RUN_ABORTED' ? '本轮已停止，已完成的进度仍保存在 Harbour。' : `${error.message}\n未自动重发。重新打开对话可核对已保存记录。`, error.code !== 'RUN_ABORTED');
  } finally { clearTimeout(askTimer); askTimer = null; syncBusy(); if (!$('chat').hidden && !settingsPanel.isOpen() && hostVisible && !document.hidden) $('message').focus({ preventScroll: true }); }
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); if (!chat.busy) pendingSend = send(); });
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try { await chat.stop(); if (chat.busy) status('正在停止，等待本轮结算…'); }
  catch (error) { status(`停止尚未确认：${error.message}`, true); }
  finally { $('stop').disabled = false; }
});
$('sound').addEventListener('click', async () => {
  if (!world) return;
  const next = !sound;
  $('sound').disabled = true;
  try { await world.sound(next); sound = next; $('sound').textContent = `环境音 · ${sound ? '开' : '关'}`; $('sound').setAttribute('aria-pressed', String(sound)); }
  catch (error) { notice(error.message || '浏览器暂未允许环境音，请再点击一次。'); }
  finally { $('sound').disabled = false; }
});
$('pause').addEventListener('click', () => {
  paused = !paused; world?.pause(paused); $('pause').textContent = paused ? '继续散步' : '暂停画面'; $('pause').setAttribute('aria-pressed', String(paused));
});
$('look').addEventListener('click', () => {
  hoverLook = !hoverLook; world?.setHoverLook(hoverLook);
  $('look').textContent = `环顾 · ${hoverLook ? '开' : '关'}`; $('look').setAttribute('aria-pressed', String(hoverLook));
});
$('daytime').addEventListener('click', () => {
  if (world?.cycleTime) $('daytime').textContent = `时光 · ${world.cycleTime()}`;
});
function syncDaytime() {
  if (world?.cycleTime) $('daytime').textContent = `时光 · ${world.status().timeOfDay < .25 ? '白昼' : world.status().timeOfDay < .75 ? '黄昏' : '夜晚'}`;
}
// A map owns module-level textures, generated atlases, GPU targets and audio.
// Navigating only this Town document releases that entire realm; the Dashboard,
// native WebContents and original Main sessions remain the same. Transfer drafts
// before navigation, and never leave a live run behind.
function changeMap(id, override) {
  if (!Object.hasOwn(MAPS, id) || chat.busy) { $('map').value = map.id; notice('请先等当前回复结束或停止，再切换地图。'); return false; }
  const value = override || snapshot();
  mapPoses[map.id] = world?.status();
  const transfer = { ...value, mapId: id, mapPoses: { ...mapPoses, ...value.mapPoses }, pose: (value.mapId || map.id) === id ? value.pose : value.mapPoses?.[id] || mapPoses[id],
    social: id === map.id ? value.social : { ...value.social, gesture: null }, at: Date.now() };
  try {
    sessionStorage.setItem(TRANSFER, JSON.stringify(transfer));
    if (window.harbourTownHost) localStorage.setItem('harbour-town-map', id);
  }
  catch { $('map').value = map.id; notice('浏览器禁止暂存草稿，未切换地图。请先允许本机存储。'); return false; }
  transferring = true;
  world?.freeze(true); destroy();
  // Native host trusts one exact document URL. Reload that URL, don't expand
  // its IPC/origin boundary with map query parameters or arbitrary navigation.
  if (window.harbourTownHost) location.reload();
  else { const url = new URL(location.href); url.searchParams.set('map', id); location.replace(url.href); }
  return true;
}
$('map').addEventListener('change', () => { if ($('map').value !== map.id) changeMap($('map').value); });
$('quality').addEventListener('change', () => {
  if (chat.busy) { $('quality').value = qualityName; notice('请先完成对话，再切换画质。'); return; }
  try { localStorage.setItem('harbour-town-quality', $('quality').value); } catch { /* private mode */ }
  changeMap(map.id);
});
$('fps').addEventListener('change', () => {
  frameRate = frameRateFor($('fps').value, frameRate);
  try { storage?.setItem('harbour-town-fps', String(frameRate)); } catch { /* active scene still changes */ }
  world?.setFrameRate(frameRate);
  notice(`帧率上限已设为 ${frameRate}；画质不变，实际帧率取决于设备。`);
});

async function discard({ keepDrafts = false } = {}) {
  if (chat.busy) {
    await chat.stop();
    await Promise.race([pendingSend, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (chat.busy) { status('停止尚未确认，请稍后再离开。', true); return false; }
  }
  if (!keepDrafts) { drafts.clear(); $('message').value = ''; } return true;
}
function destroy() {
  if (destroyed) return; destroyed = true; ++historyRevision;
  clearTimeout(noticeTimer); clearTimeout(askTimer); lifetime.abort(); world?.destroy();
}
function snapshot() {
  saveDraft(); const pose = world?.status();
  const outfits = Object.fromEntries((pose?.models || []).filter(m => m.type === 'mmd').map(m => [m.id, m.variant]));
  const hosiery = Object.fromEntries((pose?.models || []).filter(m => m.hosieryOptions?.length).map(m => [m.id, m.hosiery]));
  return { mapId: map.id, mapPoses, pose, outfits, hosiery, social: social.snapshot(), drafts: [...drafts], selected: selected?.id, chatOpen: !$('chat').hidden, paused, hoverLook };
}
async function restore(value) {
  if (!value) return;
  if (!world) { pendingRestore = value; return; }
  if (chat.busy) return;
  if (value.mapId && mapFor(value.mapId).id !== map.id) { changeMap(mapFor(value.mapId).id, value); return; }
  for (const id of Object.keys(MAPS)) if (value.mapPoses?.[id]) mapPoses[id] = value.mapPoses[id];
  world.restorePose(value.pose);
  world.restoreResidents(value.pose?.models);
  social.restore(value.social);
  socialPanel.close({ focus: false }); socialPanel.refresh();
  syncDaytime();
  for (const [id, text] of value.drafts || []) if (RESIDENTS.some(r => r.id === id) && canChat(id) && typeof text === 'string') drafts.set(id, text.slice(0, 8000));
  hoverLook = value.hoverLook !== false; world.setHoverLook(hoverLook);
  $('look').textContent = `环顾 · ${hoverLook ? '开' : '关'}`; $('look').setAttribute('aria-pressed', String(hoverLook));
  paused = value.paused === true; world.pause(paused); $('pause').textContent = paused ? '继续散步' : '暂停画面'; $('pause').setAttribute('aria-pressed', String(paused));
  for (const model of world.status().models) {
    const hosiery = value.hosiery?.[model.id];
    if (model.hosieryOptions?.some(option => option.id === hosiery)) {
      try { world.setHosiery(model.id, hosiery); }
      catch (error) { if (!destroyed) notice(`丝袜未能恢复：${error.message}`); }
    }
    const variant = value.outfits?.[model.id];
    if (model.type !== 'mmd' || typeof variant !== 'string' || variant === model.variant) continue;
    if (!model.variants.some(v => v.id === variant)) { notice('此前选择的服装在本机已不可用，保留原装。'); continue; }
    try { await world.setOutfit(model.id, variant); }
    catch (error) { if (!destroyed) notice(`服装未能恢复，保留原装：${error.message}`); }
  }
  if (value.chatOpen && RESIDENTS.some(r => r.id === value.selected) && canChat(value.selected)) await openChat(value.selected);
  else if (!$('chat').hidden) closeChat();
}
window.HarbourTown = { dirty, discard, destroy, snapshot, restore,
  isTransferring: () => transferring,
  prepareTransfer() { transferring = true; },
  setVisible(value) { hostVisible = value; if (!value) { settingsPanel.close({ returnFocus: false }); socialPanel.close({ focus: false }); } visibility.setVisible(value); },
  status: () => ({ ...world?.status(), social: social.snapshot(), hidden: visibility.hidden(), busy: chat.busy, selected: selected?.id, ready: !!world && !destroyed && $('loading').hidden }),
};
bindPresentation(window.HarbourTown, notice, lifetime.signal);
window.addEventListener('pagehide', destroy, { once: true });
window.addEventListener('beforeunload', event => { if (!transferring && dirty()) { event.preventDefault(); event.returnValue = ''; } });

try {
  world = await createTownScene({ canvas: $('scene'), mapId: map.id, qualityName, frameRate, activity, signal: lifetime.signal, visibility,
    progress(value, label) { $('progress').value = value; $('load-label').textContent = label; },
    onNear(resident) { nearby = resident; updateInteraction(); }, onInteract: id => socialPanel.open(id), onSocial: () => socialPanel.refresh(),
    onModelState: modelState,
    onLookState({ locked, released, unavailable }) {
      document.body.classList.toggle('pointer-locked', locked);
      $('look-hint').textContent = locked ? '鼠标已锁定 · 自由环顾　Alt / Esc 释放鼠标　E 交谈'
        : released ? '鼠标已释放 · 可以操作界面 · 点击场景继续环顾'
        : '移到左右边缘持续转向 · 点击场景锁定鼠标 · Alt / Esc 释放';
      if (unavailable) notice('当前窗口未允许锁定鼠标；仍可把光标移到场景左右边缘持续转向。');
    },
    onError(error) { notice(`场景已暂停：${error.message}`); },
  });
  world.pause(paused); world.setHoverLook(hoverLook);
  syncMovement();
  $('daytime').hidden = !world.cycleTime;
  syncDaytime();
  try { storage?.setItem('harbour-town-map', map.id); } catch { /* session remains usable */ }
  if (pendingRestore) { const value = pendingRestore; pendingRestore = null; await restore(value); }
  $('loading').hidden = true; if (hostVisible && $('chat').hidden) $('scene').focus({ preventScroll: true });
} catch (error) {
  if (!destroyed) {
    $('load-label').textContent = '场景暂未载入';
    $('loading').querySelector('.load-note').textContent = error.message;
    const retry = document.createElement('button'); retry.textContent = '用省电画质重试';
    retry.onclick = () => { try { localStorage.setItem('harbour-town-quality', 'low'); } catch {} location.reload(); };
    $('loading').firstElementChild.append(retry);
    if (map.id !== 'station') {
      const back = document.createElement('button'); back.textContent = '返回樱花车站';
      back.onclick = () => changeMap('station'); $('loading').firstElementChild.append(back);
    }
  }
}
