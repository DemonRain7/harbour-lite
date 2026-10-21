// The town is another view of Harbour, not another agent runtime.
export const RESIDENTS = Object.freeze([
  Object.freeze({ id: 'main-elaina', name: '伊蕾娜', subtitle: '咖啡厅里 · 灰之魔女', place: '春色咖啡厅内', portrait: '/assets/elaina-avatar.png', x: 11.5, z: 6.8, groundHint: .42115, patrol: { x0: 9.4, x1: 16.3, z0: 4.2, z1: 13.1 }, color: '#b6a0e5' }),
  Object.freeze({ id: 'main-aemeath', name: '爱弥斯', subtitle: '咖啡厅里 · 众光航标', place: '春色咖啡厅内', portrait: '/assets/aemeath-avatar.jpg', x: 13.3, z: 6.8, groundHint: .42115, patrol: { x0: 9.4, x1: 16.3, z0: 4.2, z1: 13.1 }, color: '#ed9ac1' }),
  Object.freeze({ id: 'chisa', name: '千咲', subtitle: '咖啡厅里 · 小镇访客', place: '春色咖啡厅内', portrait: null, chatEnabled: false, variantLabel: '模型版本', x: 13.3, z: 12, groundHint: .42115, patrol: { x0: 9.4, x1: 16.3, z0: 4.2, z1: 13.1 }, color: '#bd7180' }),
]);
export function residentFor(id) {
  const resident = RESIDENTS.find(item => item.id === id);
  if (!resident) throw new Error('未知的小镇居民');
  return resident;
}
export const canChat = id => residentFor(id).chatEnabled !== false;
export const sessionKey = id => {
  if (!canChat(id)) throw new Error('这位访客尚未配置独立聊天 Agent。');
  return `web:town:${residentFor(id).id}`;
};
const CONTEXT_PREFIX = '【Harbour 小镇 · 虚拟场景：';
export function displayMessage(message) {
  const content = typeof message.content === 'string' ? message.content : '';
  if (message.role !== 'user' || !content.startsWith(CONTEXT_PREFIX)) return content;
  const end = content.indexOf('】\n');
  return end < 0 ? content : content.slice(end + 2);
}
export async function request(path, options = {}) {
  let token = '';
  try { token = localStorage.getItem('harbour-token') || ''; } catch { /* same-origin loopback remains available */ }
  const response = await fetch(path, {
    ...options, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-harbour-token': token } : {}), ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(response.status === 401 ? '请先在 Harbour 主界面完成登录，再返回小镇。' : body.error || body.reason || `请求失败（${response.status}）`);
    error.status = response.status; error.code = body.code;
    throw error;
  }
  return body;
}

export class TownChat {
  constructor(api = request, idFactory = () => crypto.randomUUID()) {
    this.api = api; this.idFactory = idFactory;
    this.sessions = new Map(); this.loading = new Map(); this.active = null;
  }
  get busy() { return this.active !== null; }
  validate(session, id) {
    if (!session?.id || session.key !== sessionKey(id) || session.agentName !== id || session.channel !== 'web') {
      throw new Error('小镇会话归属不匹配，未发送消息。');
    }
    return session;
  }
  async history(id) {
    if (this.loading.has(id)) return this.loading.get(id);
    const load = this.loadHistory(id);
    this.loading.set(id, load);
    try { return await load; } finally { this.loading.delete(id); }
  }
  async loadHistory(id) {
    const key = sessionKey(id);
    const listing = await this.api(`/api/conversations?key=${encodeURIComponent(key)}`);
    if (listing.enabled === false) throw new Error('后端未启用持久会话；请先在设置里开启。');
    const saved = this.sessions.get(id);
    const candidate = saved?.id || listing.activeId;
    if (!candidate) return [];
    const { session } = await this.api(`/api/conversations/${encodeURIComponent(candidate)}`);
    this.sessions.set(id, this.validate(session, id));
    return (session.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
  }
  async ensureSession(id) {
    sessionKey(id); // Reject non-agent visitors even if a caller pre-populated the cache.
    if (!this.sessions.has(id)) await this.history(id);
    if (!this.sessions.has(id)) {
      const { session } = await this.api('/api/conversations/new', {
        method: 'POST', body: JSON.stringify({ key: sessionKey(id), channel: 'web', agentName: id }),
      });
      this.sessions.set(id, this.validate(session, id));
    }
    return this.sessions.get(id);
  }
  async send(id, text, place, activityContext = '') {
    const resident = residentFor(id);
    sessionKey(id);
    const input = String(text).trim();
    if (!input || input.length > 8000) throw new Error('请填写 1–8000 字的消息。');
    if (this.busy) throw new Error('上一条还在处理，请等回复或先停止。');
    const turn = { id, runId: this.idFactory(), submitted: false, stopping: false };
    this.active = turn;
    try {
      const session = await this.ensureSession(id);
      if (turn.stopping) throw new Error('本轮已取消，尚未交给模型。');
      turn.submitted = true;
      return await this.api('/api/run', { method: 'POST', body: JSON.stringify({
        agent: id, runId: turn.runId, session: { id: session.id, key: sessionKey(id), channel: 'web' },
        input: `${CONTEXT_PREFIX}${place || resident.place}；用户正在与你当面交谈。这是虚拟位置，不是现实定位。${activityContext ? `本地互动记录（动作预设，不是你此前说过的话）：${String(activityContext).replace(/[\r\n【】]/g, ' ').slice(0, 350)}。` : ''}】\n${input}`,
      }) });
    } finally { if (this.active === turn) this.active = null; }
  }
  async stop() {
    const turn = this.active;
    if (!turn) return;
    turn.stopping = true;
    if (!turn.submitted) return;
    try { await this.api(`/api/runs/${encodeURIComponent(turn.runId)}/abort`, { method: 'POST' }); }
    catch (error) { if (error.status !== 404) { turn.stopping = false; throw error; } }
    // Do not clear active here: the original response is the settlement boundary.
  }
}
