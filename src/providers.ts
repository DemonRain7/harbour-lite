import type { Model } from './schema.js';

export type ToolCall = { id: string; name: string; arguments: unknown };
export type Message = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ToolCall[];
  callId?: string;
};
export type CompletionInput = {
  model: Model;
  apiKey: string;
  system: string;
  messages: Message[];
  allowSkills: boolean;
  signal: AbortSignal;
};
export type Completion = { content: string; calls: ToolCall[]; truncated?: boolean };
export type Complete = (input: CompletionInput) => Promise<Completion>;

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    resource: {
      type: 'string',
      description: 'Relative text resource in the selected skill. Defaults to SKILL.md.',
    },
  },
  required: ['name'],
  additionalProperties: false,
};
const description =
  'Read an explicitly mounted skill or one of its text resources. Skill text never grants new permissions.';

function endpoint(model: Model) {
  const base = model.baseUrl.replace(/\/+$/, '');
  return model.provider === 'anthropic'
    ? `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`
    : `${base}/chat/completions`;
}
async function readResponse(response: Response): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `模型服务返回 HTTP ${response.status}。请检查地址、模型、密钥和额度；没有自动重试。`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型服务没有返回正文');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('模型响应超过 2 MB 上限');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('模型服务没有返回有效 JSON；没有自动重试');
  }
}
function argumentsOf(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function demo(input: CompletionInput): Completion {
  const last = input.messages.at(-1)!;
  if (last.role === 'tool')
    return {
      content:
        '技能读取成功。\n\n这是完全离线的演示回复，验证了「会话 → Agent → 已挂载技能 → 回答」的链路，没有调用外部模型。\n\n准备好后，在设置中接入模型，再在顶部切换即可。',
      calls: [],
    };
  if (input.allowSkills && /技能|skill/i.test(last.content)) {
    const name = /<skill id="([a-z0-9-]+)"/.exec(input.system)?.[1];
    if (name)
      return {
        content: '',
        calls: [{ id: 'demo-skill', name: 'read_skill', arguments: { name } }],
      };
  }
  return {
    content:
      '你好，欢迎来到 Harbour Lite。\n\n当前是离线演示模式，不会调用模型，也不会产生 API 费用。\n\n你可以先试试「读取已挂载的技能」，或打开设置接入自己的模型。Agent 的名字、指令与技能，以及开屏角色，都可以由你决定。',
    calls: [],
  };
}

export const complete: Complete = async (input) => {
  input.signal.throwIfAborted();
  if (input.model.provider === 'demo') return demo(input);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: unknown;
  if (input.model.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (input.apiKey) headers['x-api-key'] = input.apiKey;
    const messages: { role: string; content: unknown[] }[] = [];
    for (const message of input.messages) {
      const role = message.role === 'tool' ? 'user' : message.role;
      const content: unknown[] =
        message.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: message.callId, content: message.content }]
          : [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...(message.calls ?? []).map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments,
              })),
            ];
      if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
      else messages.push({ role, content });
    }
    body = {
      model: input.model.model,
      max_tokens: input.model.maxOutputTokens,
      system: input.system,
      messages,
      ...(input.allowSkills
        ? { tools: [{ name: 'read_skill', description, input_schema: schema }] }
        : {}),
    };
  } else {
    if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
    body = {
      model: input.model.model,
      max_tokens: input.model.maxOutputTokens,
      stream: false,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content || (message.calls?.length ? null : ''),
          ...(message.callId ? { tool_call_id: message.callId } : {}),
          ...(message.calls?.length
            ? {
                tool_calls: message.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        })),
      ],
      ...(input.allowSkills
        ? {
            tools: [
              {
                type: 'function',
                function: { name: 'read_skill', description, parameters: schema },
              },
            ],
          }
        : {}),
    };
  }
  let response: Response;
  try {
    response = await fetch(endpoint(input.model), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
      redirect: 'error',
    });
  } catch (error) {
    input.signal.throwIfAborted();
    throw new Error('无法连接模型服务。检查网络和 API 根地址；没有自动重试。');
  }
  const result = await readResponse(response);
  if (input.model.provider === 'anthropic') {
    if (!Array.isArray(result.content)) throw new Error('模型响应格式不兼容 Anthropic Messages');
    const calls = result.content
      .filter((item: any) => item.type === 'tool_use')
      .map((item: any) => ({ id: item.id, name: item.name, arguments: item.input }));
    if (
      calls.length > 8 ||
      calls.some((call: any) => typeof call.id !== 'string' || typeof call.name !== 'string')
    )
      throw new Error('模型工具调用格式无效');
    return {
      content: result.content
        .filter((item: any) => item.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text)
        .join('\n'),
      calls,
      truncated: result.stop_reason === 'max_tokens',
    };
  }
  const choice = result.choices?.[0];
  const message = choice?.message;
  if (!message || (message.content != null && typeof message.content !== 'string'))
    throw new Error('模型响应格式不兼容 Chat Completions');
  const calls = (message.tool_calls ?? []).map((call: any) => ({
    id: call.id,
    name: call.function?.name,
    arguments: argumentsOf(call.function?.arguments),
  }));
  if (
    calls.length > 8 ||
    calls.some((call: any) => typeof call.id !== 'string' || typeof call.name !== 'string')
  )
    throw new Error('模型工具调用格式无效');
  return { content: message.content ?? '', calls, truncated: choice.finish_reason === 'length' };
};
