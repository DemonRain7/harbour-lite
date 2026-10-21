/* Local-backend voice presets; never put upstream credentials in browser storage. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let pickers = [];
  function destroy() { pickers.forEach(picker => picker.destroy()); pickers = []; }
  function mount(host, { config, providers, characters, request, save }) {
    destroy();
    const voices = (config.namedVoices || []).map(voice => ({ ...voice }));
    host.innerHTML = `<h3 class="settings-h voice-subhead">音色库与当前选择</h3>
      <p class="voice-note">聊天角色与发声音色分开。下方小喇叭与 Main Chat、悬浮球、语音通话共用选择；不会自动开启朗读或麦克风。腾讯三档使用各自额度，自动备用始终是精品智瑜。</p>
      <div class="voice-library-roles">${characters.map(c => `<div><b>${esc(c.label)}</b><span data-voice-role="${esc(c.id)}"></span></div>`).join('')}</div>
      <details class="voice-advanced"><summary>管理自定义声线 · Aemeath / Elaina / 其他服务</summary>
        <p class="muted">每个音色可连接独立云端或远端服务。先部署好服务再填地址；这里不会启动本机模型。单独保存，不改变上面的主服务与腾讯密钥。</p>
        <div class="voice-library-select"><select class="inp" data-field="preset" aria-label="编辑音色"></select><button class="btn ghost" type="button" data-action="new">添加音色</button></div>
        <div class="voice-field-grid">
          <label class="mc-field">名称<input class="inp" data-field="label"></label>
          <label class="mc-field">固定 ID<input class="inp" data-field="id" placeholder="例如 aemeath"></label>
          <label class="mc-field">Provider / 协议<select class="inp" data-field="provider">${providers.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></label>
          <label class="mc-field">服务地址<input class="inp" data-field="url" placeholder="https://你的服务/tts" autocomplete="off"></label>
          <label class="mc-field">模型<input class="inp" data-field="model"></label>
          <label class="mc-field">Voice / Speaker<input class="inp" data-field="voice"></label>
          <label class="mc-field">音频格式<select class="inp" data-field="ext">${['wav','mp3','ogg','webm','m4a','aac','flac'].map(ext => `<option>${ext}</option>`).join('')}</select></label>
          <label class="mc-field">鉴权 Headers<input class="inp" data-field="headers" type="password" autocomplete="new-password" placeholder="留空保持；只写入后端"></label>
          <label class="voice-clear"><input type="checkbox" data-field="clearHeaders">清除这条声线的 Headers</label>
        </div>
        <details class="voice-advanced"><summary>参考音频与风格参数（按服务需要填写）</summary><div class="voice-field-grid">
          <label class="mc-field">参考音频路径<input class="inp" data-field="refAudioPath"><small>GPT-SoVITS 为推理机路径；MiMo 为 Harbour 后端路径。</small></label>
          <label class="mc-field">参考音频原文<input class="inp" data-field="promptText"></label>
          <label class="mc-field">参考语言<input class="inp" data-field="promptLang"></label>
          <label class="mc-field">输出语言<input class="inp" data-field="textLang"></label>
          <label class="mc-field">风格提示<input class="inp" data-field="stylePrompt"></label>
          <label class="mc-field">语速<input class="inp" data-field="speed" type="number" min="0.5" max="2" step="0.05"></label>
        </div></details>
        <div class="voice-actions"><button class="btn primary" type="button" data-action="save">保存这条声线</button><span data-status role="status" class="muted"></span></div>
      </details>`;
    host.querySelectorAll('[data-voice-role]').forEach(el => pickers.push(new window.HarbourVoicePicker({ host: el,
      getCompanionId: () => el.dataset.voiceRole, request })));
    const field = key => host.querySelector(`[data-field="${key}"]`);
    const status = host.querySelector('[data-status]');
    const scalar = ['id','label','url','model','voice','ext','provider'];
    const profileKeys = ['refAudioPath','promptText','promptLang','textLang','stylePrompt','speed'];
    const renderOptions = selected => {
      field('preset').innerHTML = voices.map(v => `<option value="${esc(v.id)}">${esc(v.label)}${v.url ? '' : ' · 未配置'}</option>`).join('');
      if (selected) field('preset').value = selected;
    };
    const load = voice => {
      if (voice.provider && ![...field('provider').options].some(option => option.value === voice.provider)) {
        const option = document.createElement('option'); option.value = voice.provider; option.textContent = `${voice.provider} · ${voice.format}`;
        field('provider').append(option);
      }
      scalar.forEach(key => { field(key).value = voice[key] || (key === 'ext' ? 'wav' : key === 'provider' ? 'custom-json' : ''); });
      profileKeys.forEach(key => { field(key).value = voice.profile?.[key] ?? (key === 'speed' ? 1 : ''); });
      field('id').readOnly = !!voice.id; field('headers').value = ''; field('clearHeaders').checked = false;
      status.textContent = voice.headersConfigured ? '鉴权已保存（不回显）' : '地址留空为未配置，不能选用。';
    };
    renderOptions(); load(voices[0] || {});
    field('preset').onchange = () => load(voices.find(v => v.id === field('preset').value) || {});
    host.querySelector('[data-action="new"]').onclick = () => { load({}); field('preset').value = ''; field('label').focus(); };
    host.querySelector('[data-action="save"]').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      const value = Object.fromEntries(scalar.map(key => [key, field(key).value.trim()]));
      value.format = providers.find(p => p.id === value.provider)?.format || voices.find(v => v.id === value.id)?.format || 'json';
      value.profile = Object.fromEntries(profileKeys.filter(key => field(key).value.trim()).map(key => [key, key === 'speed' ? Number(field(key).value) : field(key).value.trim()]));
      value.headers = field('headers').value.trim(); value.clearHeaders = field('clearHeaders').checked;
      status.textContent = '正在保存…';
      try {
        await save(value);
        const index = voices.findIndex(v => v.id === value.id);
        const saved = { ...value, headersConfigured: !value.clearHeaders && (!!value.headers || voices[index]?.headersConfigured) };
        delete saved.headers; delete saved.clearHeaders;
        if (index < 0) voices.push(saved); else voices[index] = saved;
        field('headers').value = ''; field('clearHeaders').checked = false; field('id').readOnly = true;
        renderOptions(saved.id); status.textContent = '已保存。打开小喇叭菜单即可选用或试听。';
      } catch (error) { status.textContent = `保存失败：${error.message}`; }
      finally { button.disabled = false; }
    };
  }
  window.HarbourVoiceLibrary = { mount, destroy };
})();
