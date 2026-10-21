const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let tools;
const invoke = (id, tool, args) => send({ id, method: 'item/tool/call', params: {
  threadId: 'mcp-thread', turnId: 'mcp-turn', callId: id, tool, arguments: args,
} });
input.on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (method === 'initialize') return send({ id, result: { userAgent: 'mcp-test' } });
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt', planType: 'pro', email: null }, requiresOpenaiAuth: true } });
  if (method === 'thread/start') {
    tools = params.dynamicTools.map(item => item.name);
    return send({ id, result: { thread: { id: 'mcp-thread' }, model: params.model, modelProvider: 'openai', cwd: params.cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } } });
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'mcp-turn', status: 'inProgress', items: [] } } });
    return invoke('mcp-read', 'read_mcp', { server: 'exa' });
  }
  if (!method && ['mcp-read', 'mcp-search'].includes(id)) {
    send({ method: 'item/completed', params: { threadId: 'mcp-thread', turnId: 'mcp-turn', item: {
      id, type: 'dynamicToolCall', namespace: null, tool: id === 'mcp-read' ? 'read_mcp' : 'call_mcp', arguments: {},
      status: message.result?.success ? 'completed' : 'failed', success: message.result?.success, contentItems: message.result?.contentItems,
    } } });
    if (id === 'mcp-read') return invoke('mcp-search', 'call_mcp', { server: 'exa', tool: 'web_search_exa', arguments: { query: 'public TypeScript docs', objective: 'Find official documentation' } });
    return send({ method: 'turn/completed', params: { threadId: 'mcp-thread', turn: { id: 'mcp-turn', status: 'completed', items: [{
      id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ tools, receipt: message.result, flags: process.argv.slice(2) }),
    }] } } });
  }
  if (method && id !== undefined) send({ id, result: {} });
});
