import { z } from 'zod';

export const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
export const ModelSchema = z
  .object({
    id: Id,
    label: z.string().trim().min(1).max(80),
    provider: z.enum(['demo', 'openai-compatible', 'anthropic']),
    baseUrl: z.string().max(500).default(''),
    model: z.string().max(120).default(''),
    maxOutputTokens: z.number().int().min(128).max(32768).default(2048),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'demo') return;
    try {
      const url = new URL(value.baseUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: '使用 HTTPS API 根地址；本机服务可使用 HTTP。不要在地址中放密钥。',
      });
    }
    if (!value.model.trim())
      ctx.addIssue({ code: 'custom', path: ['model'], message: '请填写模型 ID' });
  });
export type Model = z.infer<typeof ModelSchema>;
export const AgentSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(300).default(''),
    model: Id.default('demo'),
    maxSteps: z.number().int().min(1).max(32).default(8),
    skills: z.array(Id).max(20).default([]),
    tools: z
      .array(z.enum(['read_skill']))
      .max(1)
      .default(['read_skill']),
    prompt: z.string().trim().min(1).max(24000),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;
export const AppearanceSchema = z
  .object({
    enabled: z.boolean(),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().max(120),
    image: z
      .string()
      .regex(/^[a-f0-9]{64}\.webp$/)
      .nullable(),
  })
  .strict();
export type Appearance = z.infer<typeof AppearanceSchema>;
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: string;
};
export type Session = {
  id: string;
  agentId: string;
  modelId: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
  pendingRun?: string;
};
export type Trace = { at: string; kind: string; detail: string };
export type Run = {
  id: string;
  sessionId: string;
  requestId: string;
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';
  trace: Trace[];
  output?: string;
  error?: string;
  createdAt: string;
};
export const demoModel: Model = {
  id: 'demo',
  label: '离线演示',
  provider: 'demo',
  baseUrl: '',
  model: '',
  maxOutputTokens: 2048,
};
export const defaultAppearance: Appearance = {
  enabled: true,
  title: '给你的 AI 一个工作台',
  subtitle: '从一个想法开始，慢慢变成你自己的助手。',
  image: null,
};
