const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const iconPaths = {
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  up: 'M12 19V5m-6 6 6-6 6 6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  stop: 'M7 7h10v10H7Z',
  chat: 'M5 4h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-5 3V5a1 1 0 0 1 1-1Z',
  agents:
    'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20v-2a5 5 0 0 1 10 0v2M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 5 4v2',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  connect: 'm10 7 3-3a5 5 0 0 1 7 7l-3 3M7 10l-3 3a5 5 0 0 0 7 7l3-3m-6-1 8-8',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Zm-4 9 3 3 5-6',
  image: 'M4 4h16v16H4ZM4 16l5-5 4 4 3-3 4 4M15 7h.01',
  panel: 'M3 4h18v16H3Zm5 0v16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
  copy: 'M9 9h11v11H9ZM15 5V3H3v12h2',
};
function icon(name) {
  const element = document.createElement('i');
  element.dataset.icon = name;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name] || iconPaths.spark);
  svg.append(path);
  element.append(svg);
  return element;
}
$$('i[data-icon]').forEach((element) => element.replaceWith(icon(element.dataset.icon)));
const state = {
  bootstrap: null,
  sessions: [],
  current: null,
  run: null,
  pendingDelete: null,
  picture: null,
  pictureUrl: null,
  polling: false,
};
let toastTimer,
  splashTimer,
  navigation = 0,
  lastPoll = 0;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 5000);
}
async function api(url, { method = 'GET', body } = {}) {
  const token = sessionStorage.getItem('harbour-lite-token');
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (response.status === 401) {
    if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
  }
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
  return data;
}
function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}
function fillSelect(select, values, selected) {
  select.replaceChildren(...values.map((item) => option(item.id, item.label || item.name)));
  if (values.some((item) => item.id === selected)) select.value = selected;
}
async function bootstrap() {
  const currentAgent = $('#agent-select').value,
    currentModel = $('#model-select').value;
  state.bootstrap = await api('/api/bootstrap');
  fillSelect(
    $('#agent-select'),
    state.bootstrap.agents,
    state.current?.agentId || currentAgent || 'assistant',
  );
  fillSelect(
    $('#model-select'),
    state.bootstrap.models,
    state.current?.modelId || currentModel || 'demo',
  );
  fillSelect($('#agent-form').elements.model, state.bootstrap.models);
  updateMode();
}
function updateMode() {
  const model = state.bootstrap?.models.find((item) => item.id === $('#model-select').value);
  $('#composer-mode').textContent =
    model?.provider === 'demo'
      ? '离线演示 · 不产生 API 费用'
      : `${model?.label || '在线模型'} · 按服务商规则计费`;
}
async function listSessions() {
  state.sessions = await api('/api/sessions');
  $('#session-count').textContent = state.sessions.length;
  const container = $('#sessions');
  container.replaceChildren();
  if (!state.sessions.length) {
    const p = document.createElement('p');
    p.className = 'rail-empty';
    p.textContent = '还没有对话。\n你的下一个想法，就从这里开始。';
    container.append(p);
  }
  for (const session of state.sessions) {
    const row = document.createElement('div');
    row.className = `session-row${session.id === state.current?.id ? ' active' : ''}`;
    const button = document.createElement('button');
    button.className = 'session-open';
    button.title = session.title;
    const text = document.createElement('span');
    text.textContent = session.title;
    button.append(icon(session.pendingRun ? 'spark' : 'chat'), text);
    button.onclick = () => openSession(session.id).catch((error) => toast(error.message));
    const remove = document.createElement('button');
    remove.className = 'session-delete';
    remove.title = '删除对话';
    remove.setAttribute('aria-label', `删除对话：${session.title}`);
    remove.append(icon('trash'));
    remove.onclick = () => {
      state.pendingDelete = session.id;
      $('#confirm-dialog').showModal();
    };
    row.append(button, remove);
    container.append(row);
  }
}
function renderMessages(scroll = false) {
  $('#welcome').hidden = !!state.current?.messages.length;
  const container = $('#messages');
  container.replaceChildren();
  for (const message of state.current?.messages || []) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status ? ' error' : ''}`;
    if (message.role === 'assistant') {
      const name = document.createElement('div');
      name.className = 'message-name';
      const logo = document.createElement('img');
      logo.src = '/favicon.svg';
      logo.alt = '';
      name.append(
        logo,
        document.createTextNode(
          state.bootstrap.agents.find((agent) => agent.id === state.current.agentId)?.name ||
            'Agent',
        ),
      );
      article.append(name);
    }
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = message.content;
    article.append(content);
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copy = document.createElement('button');
    copy.className = 'icon-button';
    copy.title = '复制消息';
    copy.setAttribute('aria-label', '复制消息');
    copy.append(icon('copy'));
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        toast('已复制');
      } catch {
        toast('浏览器未允许复制，请手动选择文字。');
      }
    };
    actions.append(copy);
    article.append(actions);
    container.append(article);
  }
  renderRun();
  if (scroll)
    requestAnimationFrame(() => {
      $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
    });
}
function renderRun() {
  const running = !!state.current?.pendingRun;
  $('#send').hidden = running;
  $('#stop-run').hidden = !running;
  $('#run-hint').textContent = running ? '正在处理 · 可以切到其他会话，任务会继续' : '';
  const run = state.run;
  $('#run-details').hidden = !run;
  if (run) {
    $('#run-summary').textContent =
      run.status === 'running'
        ? '正在运行 · 查看进度'
        : `任务${run.status === 'completed' ? '完成' : '已停止'} · 查看记录`;
    $('#run-trace').replaceChildren(
      ...(run.trace || []).map((event) => {
        const li = document.createElement('li');
        li.textContent = event.detail;
        return li;
      }),
    );
  }
}
function resetChat({ keepModel = true } = {}) {
  navigation++;
  state.current = null;
  state.run = null;
  if (!keepModel)
    $('#model-select').value =
      state.bootstrap.agents.find((agent) => agent.id === $('#agent-select').value)?.model ||
      'demo';
  updateMode();
  renderMessages();
  void listSessions().catch((error) => toast(error.message));
  closeSidebar();
  $('#message').focus();
}
async function openSession(id, knownRunId) {
  const ticket = ++navigation;
  const session = await api(`/api/sessions/${id}`);
  if (ticket !== navigation) return;
  state.current = session;
  state.run = null;
  $('#agent-select').value = session.agentId;
  $('#model-select').value = session.modelId;
  if (session.pendingRun || knownRunId) {
    const run = await api(`/api/runs/${session.pendingRun || knownRunId}`);
    if (ticket !== navigation) return;
    state.run = run;
  }
  updateMode();
  renderMessages(true);
  await listSessions();
  closeSidebar();
}
$('#new-chat').onclick = () => resetChat();
$('#agent-select').onchange = () => resetChat({ keepModel: false });
$('#model-select').onchange = () => {
  if (state.current) {
    resetChat();
    toast('已切换模型，将使用新会话。');
  } else updateMode();
};
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').hidden = true;
}
$('#toggle-sidebar').onclick = () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#sidebar-backdrop').hidden = !open;
};
$('#sidebar-backdrop').onclick = closeSidebar;
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSidebar();
});
$('#composer').onsubmit = async (event) => {
  event.preventDefault();
  const content = $('#message').value.trim();
  if (!content || state.current?.pendingRun || $('#send').disabled) return;
  const ticket = navigation;
  $('#send').disabled = true;
  try {
    const session =
      state.current ||
      (await api('/api/sessions', {
        method: 'POST',
        body: { agentId: $('#agent-select').value, modelId: $('#model-select').value },
      }));
    const id = session.id;
    const receipt = await api(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: { content, requestId: crypto.randomUUID() },
    });
    if (ticket === navigation) {
      $('#message').value = '';
      await openSession(id, receipt.id);
    } else await listSessions();
  } catch (error) {
    toast(`${error.message} 如发送状态不确定，先重新打开会话核对。`);
    await listSessions().catch(() => {});
  } finally {
    $('#send').disabled = false;
  }
};
$('#message').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
};
$('#stop-run').onclick = async () => {
  try {
    if (state.current?.pendingRun)
      await api(`/api/runs/${state.current.pendingRun}/stop`, { method: 'POST', body: {} });
  } catch (error) {
    toast(error.message);
  }
};
$('#cancel-delete').onclick = () => $('#confirm-dialog').close();
$('#confirm-delete').onclick = async () => {
  try {
    await api(`/api/sessions/${state.pendingDelete}`, { method: 'DELETE' });
    if (state.current?.id === state.pendingDelete) resetChat();
    await listSessions();
    $('#confirm-dialog').close();
  } catch (error) {
    toast(error.message);
  }
};
$$('[data-prompt]').forEach((button) => {
  button.onclick = () => {
    $('#message').value = button.dataset.prompt;
    $('#message').focus();
  };
});
$$('[data-action="models"]').forEach((button) => {
  button.onclick = () => openSettings('models');
});

function tab(name) {
  $$('[data-section]').forEach((section) => {
    section.hidden = section.dataset.section !== name;
  });
  $$('[data-tab]').forEach((button) =>
    button.classList.toggle('active', button.dataset.tab === name),
  );
}
async function openSettings(name) {
  try {
    await bootstrap();
    renderModelList();
    renderAgentList();
    editModel();
    editAgent(state.bootstrap.agents.find((agent) => agent.id === $('#agent-select').value));
    await editAppearance();
    tab(name);
    $('#settings-dialog').showModal();
  } catch (error) {
    toast(error.message);
  }
}
$('#open-settings').onclick = () => openSettings('models');
$('#open-agents').onclick = () => openSettings('agents');
$$('[data-tab]').forEach((button) => {
  button.onclick = () => tab(button.dataset.tab);
});
$$('[data-close]').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});
function formStatus(form, text, error = false) {
  const el = form.querySelector('.form-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}
function setValues(form, values) {
  for (const [key, value] of Object.entries(values))
    if (form.elements[key] && typeof value !== 'object') form.elements[key].value = value;
}
function renderModelList() {
  const list = $('#model-list');
  list.replaceChildren();
  for (const model of state.bootstrap.models) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = model.id;
    button.textContent = model.label;
    const small = document.createElement('small');
    small.textContent =
      model.provider === 'demo'
        ? '内置 · 无需配置'
        : `${model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} · ${model.hasKey ? '已保存密钥' : '未设密钥'}`;
    button.append(small);
    button.onclick = () => {
      if (model.provider === 'demo') {
        toast('离线演示不需要配置。可添加自己的模型连接。');
        return;
      }
      editModel(model);
    };
    list.append(button);
  }
}
function editModel(model) {
  const form = $('#model-form');
  form.reset();
  form.elements.id.readOnly = !!model;
  formStatus(form, '');
  if (model) setValues(form, model);
  form.elements.apiKey.value = '';
  $$('#model-list button').forEach((button) =>
    button.classList.toggle('active', button.dataset.id === model?.id),
  );
}
$('#add-model').onclick = () => editModel();
$('#model-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    data = Object.fromEntries(new FormData(form));
  const apiKey = data.apiKey;
  delete data.apiKey;
  data.maxOutputTokens = Number(data.maxOutputTokens);
  try {
    await api('/api/models', { method: 'PUT', body: { model: data, apiKey } });
    form.elements.apiKey.value = '';
    await bootstrap();
    renderModelList();
    formStatus(form, '已保存。可在对话顶部选择。');
  } catch (error) {
    formStatus(form, error.message, true);
  }
};
function renderAgentList() {
  const list = $('#agent-list');
  list.replaceChildren();
  for (const agent of state.bootstrap.agents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = agent.id;
    button.textContent = agent.name;
    const small = document.createElement('small');
    small.textContent = agent.id;
    button.append(small);
    button.onclick = () => editAgent(agent);
    list.append(button);
  }
}
function editAgent(agent) {
  const form = $('#agent-form');
  form.reset();
  form.elements.id.readOnly = !!agent;
  formStatus(form, '');
  if (agent) setValues(form, agent);
  form.elements.readSkills.checked = agent ? agent.tools.includes('read_skill') : true;
  $('#agent-skills').replaceChildren(
    ...state.bootstrap.skills.map((skill) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'skills';
      input.value = skill.id;
      input.checked = !!agent?.skills.includes(skill.id);
      label.title = skill.description;
      label.append(input, document.createTextNode(skill.id));
      return label;
    }),
  );
  $$('#agent-list button').forEach((button) =>
    button.classList.toggle('active', button.dataset.id === agent?.id),
  );
}
$('#add-agent').onclick = () => editAgent();
$('#agent-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    values = new FormData(form),
    data = Object.fromEntries(values);
  data.skills = values.getAll('skills');
  data.tools = form.elements.readSkills.checked ? ['read_skill'] : [];
  delete data.readSkills;
  data.maxSteps = Number(data.maxSteps);
  try {
    await api('/api/agents', { method: 'PUT', body: data });
    await bootstrap();
    renderAgentList();
    formStatus(form, '已保存；新任务使用新配置。');
  } catch (error) {
    formStatus(form, error.message, true);
  }
};
async function pictureUrl(name) {
  if (!name) return null;
  const token = sessionStorage.getItem('harbour-lite-token');
  const response = await fetch(`/api/appearance/image/${name}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('角色图片读取失败');
  return URL.createObjectURL(await response.blob());
}
async function loadPicture(name) {
  if (state.pictureUrl) URL.revokeObjectURL(state.pictureUrl);
  state.pictureUrl = await pictureUrl(name);
  for (const id of ['#appearance-image', '#splash-image']) {
    $(id).hidden = !state.pictureUrl;
    if (state.pictureUrl) $(id).src = state.pictureUrl;
    else $(id).removeAttribute('src');
  }
  $('.preview-symbol').hidden = !!state.pictureUrl;
  $('.splash-symbol').hidden = !!state.pictureUrl;
}
async function editAppearance() {
  const a = state.bootstrap.appearance,
    form = $('#appearance-form');
  setValues(form, a);
  form.elements.enabled.checked = a.enabled;
  state.picture = a.image;
  formStatus(form, '');
  await loadPicture(a.image);
  previewAppearance();
}
function previewAppearance() {
  const form = $('#appearance-form');
  $('#appearance-title').textContent = form.elements.title.value;
  $('#appearance-subtitle').textContent = form.elements.subtitle.value;
}
$('#appearance-form').oninput = previewAppearance;
$('#image-upload').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast('请选择小于 2 MB 的图片');
    event.target.value = '';
    return;
  }
  try {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await api('/api/appearance/image', { method: 'POST', body: { image } });
    state.picture = result.image;
    await loadPicture(result.image);
    formStatus($('#appearance-form'), '图片已上传，保存外观后生效。');
  } catch (error) {
    formStatus($('#appearance-form'), error.message, true);
  }
  event.target.value = '';
};
$('#remove-image').onclick = async () => {
  state.picture = null;
  await loadPicture(null);
  formStatus($('#appearance-form'), '保存后将使用默认图形。');
};
$('#appearance-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const appearance = {
      enabled: form.elements.enabled.checked,
      title: form.elements.title.value,
      subtitle: form.elements.subtitle.value,
      image: state.picture,
    };
    await api('/api/appearance', { method: 'PUT', body: appearance });
    state.bootstrap.appearance = appearance;
    formStatus(form, '已保存。');
  } catch (error) {
    formStatus(form, error.message, true);
  }
};
function splash(appearance, auto = false) {
  clearTimeout(splashTimer);
  $('#splash-title').textContent = appearance.title;
  $('#splash-subtitle').textContent = appearance.subtitle;
  $('#splash').hidden = false;
  if (auto)
    splashTimer = setTimeout(
      () => {
        $('#splash').hidden = true;
      },
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 500 : 1400,
    );
}
$('#skip-splash').onclick = () => {
  clearTimeout(splashTimer);
  $('#splash').hidden = true;
};
$('#preview-splash').onclick = async () => {
  await loadPicture(state.bootstrap.appearance.image);
  splash(state.bootstrap.appearance);
};
$('#appearance-try').onclick = () => {
  const form = $('#appearance-form');
  $('#settings-dialog').close();
  splash({ title: form.elements.title.value, subtitle: form.elements.subtitle.value });
};
$('#auth-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('#auth-form').onsubmit = async (event) => {
  event.preventDefault();
  sessionStorage.setItem('harbour-lite-token', event.currentTarget.elements.token.value);
  try {
    await start();
    $('#auth-dialog').close();
    event.currentTarget.reset();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  }
};
async function start() {
  await bootstrap();
  await listSessions();
  await loadPicture(state.bootstrap.appearance.image);
  if (state.bootstrap.appearance.enabled) splash(state.bootstrap.appearance, true);
}
async function poll() {
  if (state.polling || document.hidden || !state.bootstrap) return;
  if (
    !state.sessions.some((session) => session.pendingRun) &&
    !state.current?.pendingRun &&
    Date.now() - lastPoll < 15000
  )
    return;
  lastPoll = Date.now();
  state.polling = true;
  try {
    if (state.current?.pendingRun) {
      const sessionId = state.current.id,
        runId = state.current.pendingRun;
      const run = await api(`/api/runs/${runId}`);
      if (state.current?.id === sessionId) {
        state.run = run;
        renderRun();
        if (run.status !== 'running') {
          const session = await api(`/api/sessions/${sessionId}`);
          if (state.current?.id === sessionId) {
            state.current = session;
            renderMessages(true);
          }
        }
      }
    }
    await listSessions();
  } catch {
    /* Read-only polling resumes when the connection returns; never resubmit a model request. */
  } finally {
    state.polling = false;
  }
}
setInterval(poll, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
});
void start().catch((error) => toast(error.message));
