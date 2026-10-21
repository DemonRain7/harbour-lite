import { canChat } from './client.js';

const COMPANY = Object.freeze({ waiting: '她在这里等你。', together: '她就在你身边。慢慢走也没关系。',
  following: '她正在跟上你。走慢一点，可以等一等她。', blocked: '前面暂时不好通过。靠近她，或换一条开阔的路。',
  'too-far': '你们离得有些远了，她会在原地等。可以从居民菜单去找她。' });

export function bindTownSocial({ social, residents, activity, world, signal, onOpen, onChange, onChat, onMenu, notice }) {
  const $ = id => document.getElementById(id), panel = $('social-panel');
  let id = '', rendered = '', companyRendered = '';
  const resident = value => residents.find(r => r.id === value);
  function close({ focus = true } = {}) {
    if (!id) return;
    id = ''; activity.interacting = ''; panel.hidden = true; onChange();
    if (focus && !document.hidden) $('scene').focus({ preventScroll: true });
  }
  function refresh() {
    const c = social.companion, behavior = c ? world()?.companionStatus(c.id) : null;
    const companyKey = JSON.stringify([c, behavior?.company]);
    if (companyKey !== companyRendered) {
      companyRendered = companyKey;
      $('company-controls').hidden = !c;
      if (c) {
        const name = resident(c.id).name;
        $('company-name').textContent = `正在和${name}同行`;
        $('company-status').textContent = c.mode === 'wait' ? COMPANY.waiting : COMPANY[behavior?.company] || COMPANY.following;
        $('company-wait').textContent = c.mode === 'wait' ? '继续散步' : '等我一下';
        $('company-toggle').textContent = `${name} · ${c.mode === 'wait' || ['blocked', 'too-far'].includes(behavior?.company) ? '等你' : '同行中'}`;
      }
    }
    $('company-toggle').hidden = !c || !!id || !$('chat').hidden || !$('settings-panel').hidden;
    if (!id) return;
    if (!world()?.canInteract(id)) { close({ focus: false }); return; }
    const view = social.view(id), key = JSON.stringify([id, view]);
    if (key === rendered) return;
    rendered = key;
    $('social-feedback').textContent = view.text || (view.companion ? COMPANY[behavior?.company] || COMPANY.following : '不急着说什么，也可以一起玩一会儿。');
    for (const button of panel.querySelectorAll('[data-social], [data-hand]')) button.disabled = view.busy;
    const chat = panel.querySelector('[data-social="chat"]');
    chat.hidden = !canChat(id);
    chat.disabled = false; // A local animation must not lock access to Main chat.
    const follow = panel.querySelector('[data-social="follow"]');
    follow.textContent = view.companion === 'wait' ? '↗ 继续散步' : view.companion ? '⌁ 等我一下' : '↗ 一起散步';
  }
  function open(value) {
    if (!resident(value) || !world()?.canInteract(value)) return;
    onOpen(); id = value; activity.interacting = id;
    const r = resident(id); $('social-name').textContent = r.name;
    $('social-avatar').replaceChildren();
    if (r.portrait) { const image = document.createElement('img'); image.src = r.portrait; image.alt = ''; $('social-avatar').append(image); }
    else $('social-avatar').textContent = r.name.slice(0, 1);
    panel.hidden = false; rendered = ''; onChange(); refresh();
    panel.focus({ preventScroll: true });
  }
  function act(action, choice, who = id) {
    if (!who) return;
    if (!['end', 'wait'].includes(action) && !world()?.canInteract(who)) { notice('先到她身边，再一起继续。'); return; }
    if (!social.act(who, action, choice)) return;
    refresh();
    if (['follow', 'resume'].includes(action)) { close(); notice(`${resident(who).name}会跟着你慢慢走。菜单里可以让她等候或结束同行。`); }
    if (action === 'end') notice('已结束同行。她会沿可通行的路回去，遇到障碍会先停留。');
  }
  for (const button of panel.querySelectorAll('[data-social]')) button.addEventListener('click', () => {
    const action = button.dataset.social;
    if (action === 'chat') { const who = id; close({ focus: false }); onChat(who); return; }
    if (action === 'follow' && social.companion?.id === id) act(social.companion.mode === 'wait' ? 'resume' : 'wait');
    else act(action);
  }, { signal });
  for (const button of panel.querySelectorAll('[data-hand]')) button.addEventListener('click', () => act('rps', button.dataset.hand), { signal });
  $('social-close').addEventListener('click', () => close(), { signal });
  $('company-toggle').addEventListener('click', onMenu, { signal });
  $('company-wait').addEventListener('click', () => { const c = social.companion; if (c) act(c.mode === 'wait' ? 'resume' : 'wait', null, c.id); }, { signal });
  $('company-end').addEventListener('click', () => { if (social.companion) act('end', null, social.companion.id); }, { signal });
  // Dismissal consumes its click: never also lock the mouse or turn the camera.
  document.addEventListener('pointerdown', e => { if (id && e.target === $('scene')) e.preventDefault(); }, { signal, capture: true });
  document.addEventListener('click', e => { if (id && e.target === $('scene')) { e.preventDefault(); e.stopImmediatePropagation(); close(); } }, { signal, capture: true });
  document.addEventListener('keydown', e => {
    if (id && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, { signal, capture: true });
  signal.addEventListener('abort', () => { id = ''; activity.interacting = ''; }, { once: true });
  return { open, close, refresh, isOpen: () => !!id };
}
