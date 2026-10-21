// Same-server chat navigation is the only popup allowed into an authenticated
// Dashboard surface. Everything else keeps the existing external-link behavior.
function chatWindowUrl(value, baseUrl) {
  try {
    const url = new URL(value), base = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin || url.username || url.password ||
        url.pathname.replace(/\/+$/, '') !== base.pathname.replace(/\/+$/, '') || url.search || !url.hash.startsWith('#chat?')) return null;
    const params = new URLSearchParams(url.hash.slice(6));
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
    const session = params.get('session'), fresh = params.get('new'), agent = params.get('agent');
    if ((session && !validId(session)) || (agent && !validId(agent)) ||
        (fresh !== null && fresh !== '1') || (!!session === (fresh === '1')) ||
        (params.has('mode') && !['main', 'cowork'].includes(params.get('mode'))) ||
        [...params.keys()].some(key => !['session', 'new', 'agent', 'mode'].includes(key) || params.getAll(key).length !== 1)) return null;
    return url.href;
  } catch { return null; }
}
module.exports = { chatWindowUrl };
