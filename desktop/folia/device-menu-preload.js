const { ipcRenderer } = require('electron');

// No bridge is exposed to this document, and no Harbour/player preload is loaded.
const send = message => ipcRenderer.send('folia-device-menu:event', message);
ipcRenderer.on('folia-device-menu:data', (_event, data) => {
  const options = document.getElementById('options');
  if (!options) return;
  for (const [key, value] of Object.entries(data.theme)) document.documentElement.style.setProperty(`--${key}`, value);
  options.replaceChildren();
  const buttons = [];
  for (const item of data.items) {
    const button = document.createElement('button');
    button.type = 'button'; button.disabled = item.disabled; button.dataset.value = item.value;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(item.selected));
    button.title = [item.label, item.description].filter(Boolean).join(' · ');
    const copy = document.createElement('span'); copy.className = 'copy';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = item.label;
    copy.append(label);
    if (item.description) {
      const description = document.createElement('span'); description.className = 'description'; description.textContent = item.description;
      copy.append(description);
    }
    const check = document.createElement('span'); check.className = 'check'; check.textContent = item.selected ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
    button.append(copy, check);
    button.addEventListener('click', () => { if (!button.disabled) send({ type: 'choose', value: item.value }); });
    options.append(button); buttons.push(button);
  }
  if (!buttons.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '暂无在线设备'; options.append(empty);
  }
  const enabled = buttons.filter(button => !button.disabled);
  (enabled.find(button => button.getAttribute('aria-selected') === 'true') || enabled[0])?.focus();
  const measure = () => {
    const menu = document.getElementById('menu');
    const style = getComputedStyle(menu);
    const height = options.scrollHeight + menu.querySelector('header').offsetHeight + menu.querySelector('footer').offsetHeight
      + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) + 5;
    send({ type: 'size', height: Math.ceil(height) });
  };
  requestAnimationFrame(measure);
  document.fonts.ready.then(measure);
});

window.addEventListener('keydown', event => {
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    send({ type: 'dismiss', reason: event.key === 'Escape' ? 'escape' : event.shiftKey ? 'shift-tab' : 'tab' });
    return;
  }
  const buttons = [...document.querySelectorAll('#options button:not(:disabled)')];
  if (!buttons.length) return;
  const at = buttons.indexOf(document.activeElement);
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else if (event.key === 'ArrowDown') next = (at + 1) % buttons.length;
  else if (event.key === 'ArrowUp') next = (at < 0 ? buttons.length : at) - 1;
  else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (at >= 0) buttons[at].click(); return; }
  if (next !== undefined) { event.preventDefault(); buttons[(next + buttons.length) % buttons.length].focus(); }
});
