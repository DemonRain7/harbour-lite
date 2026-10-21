import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { document, serialize } from './frontmatter.js';
import { parse as parseEnv } from 'dotenv';
import {
  AgentSchema,
  AppearanceSchema,
  ModelSchema,
  defaultAppearance,
  demoModel,
  Id,
  type Agent,
  type Appearance,
  type Model,
  type Session,
} from './schema.js';

export async function atomicWrite(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 });
    // Windows can briefly deny replacement while a reader/antivirus holds the file.
    // Retry only this atomic local rename, never a model request or a whole run.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        if (
          attempt >= 8 ||
          !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 12 * (attempt + 1)));
      }
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
export class Store {
  readonly data: string;
  private changes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    dataDirectory = 'data',
  ) {
    this.data = path.resolve(root, dataDirectory);
  }
  async init() {
    for (const directory of ['sessions', 'runs', 'agents', 'skills', 'appearance'])
      await fs.mkdir(path.join(this.data, directory), { recursive: true });
    for (const file of await fs.readdir(path.join(this.data, 'runs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const run = await this.readRun(file.slice(0, -5));
      if (run?.status === 'running')
        await this.writeRun({
          ...run,
          id: file.slice(0, -5),
          status: 'interrupted',
          error: '服务已重启；未自动重试',
        });
    }
    for (const session of await this.sessions()) {
      if (!session.pendingRun) continue;
      const runId = session.pendingRun;
      delete session.pendingRun;
      session.messages.push({
        role: 'assistant',
        content: '服务上次退出时任务尚未完成。请核对结果后再决定是否重试；系统不会自动重复请求。',
        status: 'interrupted',
        createdAt: new Date().toISOString(),
      });
      await this.saveSession(session);
      await this.writeRun({
        ...(await this.readRun(runId)),
        id: runId,
        sessionId: session.id,
        status: 'interrupted',
        error: '服务已重启；未自动重试',
      });
    }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.changes.then(operation);
    this.changes = pending.catch(() => {});
    return pending;
  }
  async models(): Promise<Model[]> {
    const custom = await readJson<Model[]>(path.join(this.data, 'models.json'), []);
    return [
      demoModel,
      ...custom.map((model) => ModelSchema.parse(model)).filter((model) => model.id !== 'demo'),
    ];
  }
  keyName(id: string) {
    return `HARBOUR_LITE_KEY_${Id.parse(id).replaceAll('-', '_').toUpperCase()}`;
  }
  async secret(id: string) {
    const name = this.keyName(id);
    let values: Record<string, string> = {};
    try {
      values = parseEnv(await fs.readFile(path.join(this.root, '.env')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return values[name] ?? process.env[name] ?? '';
  }
  async saveModel(input: unknown, apiKey?: string) {
    const model = ModelSchema.parse(input);
    if (model.id === 'demo' || model.provider === 'demo') throw new Error('离线演示模型不可覆盖');
    if (apiKey !== undefined && (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)))
      throw new Error('密钥格式不正确');
    return this.exclusive(async () => {
      if (apiKey !== undefined && apiKey !== '') {
        const file = path.join(this.root, '.env');
        let text = '';
        try {
          text = await fs.readFile(file, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        const name = this.keyName(model.id);
        text = text
          .split(/\r?\n/)
          .filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))
          .join('\n');
        // dotenv supports single-quoted values; quotes/backslashes in API keys are not accepted.
        if (/["'\\]/.test(apiKey)) throw new Error('密钥包含不支持的字符');
        await atomicWrite(file, `${text.trimEnd()}\n${name}='${apiKey}'\n`);
      }
      const models = (await this.models()).filter((item) => !['demo', model.id].includes(item.id));
      models.push(model);
      await atomicWrite(path.join(this.data, 'models.json'), JSON.stringify(models, null, 2));
      return model;
    });
  }
  async appearance(): Promise<Appearance> {
    return AppearanceSchema.parse(
      await readJson(path.join(this.data, 'appearance.json'), defaultAppearance),
    );
  }
  async saveAppearance(value: unknown) {
    const appearance = AppearanceSchema.parse(value);
    if (appearance.image) await fs.access(path.join(this.data, 'appearance', appearance.image));
    await atomicWrite(path.join(this.data, 'appearance.json'), JSON.stringify(appearance, null, 2));
    return appearance;
  }
  private async folders(root: string) {
    try {
      return (await fs.readdir(root, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && Id.safeParse(item.name).success)
        .map((item) => item.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  async agents(): Promise<Agent[]> {
    const agents = new Map<string, Agent>();
    for (const base of [path.join(this.root, 'agents'), path.join(this.data, 'agents')]) {
      for (const id of await this.folders(base)) {
        const raw = document(await this.safeRead(base, `${id}/CLAUDE.md`));
        agents.set(id, AgentSchema.parse({ ...raw.data, id, prompt: raw.content }));
      }
    }
    return [...agents.values()];
  }
  async saveAgent(input: unknown) {
    const agent = AgentSchema.parse(input);
    if (!(await this.models()).some((model) => model.id === agent.model))
      throw new Error('请选择已配置的模型');
    const installed = await this.skills();
    if (agent.skills.some((id) => !installed.some((skill) => skill.id === id)))
      throw new Error('挂载的技能不存在');
    const { id, prompt, ...metadata } = agent;
    await atomicWrite(path.join(this.data, 'agents', id, 'CLAUDE.md'), serialize(metadata, prompt));
    return agent;
  }
  async skills() {
    const skills = new Map<string, { id: string; description: string; base: string }>();
    for (const base of [path.join(this.root, 'skills'), path.join(this.data, 'skills')]) {
      for (const id of await this.folders(base)) {
        const raw = document(await this.safeRead(base, `${id}/SKILL.md`));
        if (raw.data.name !== id || typeof raw.data.description !== 'string')
          throw new Error(`技能 ${id} 的 name / description 无效`);
        skills.set(id, { id, description: raw.data.description.slice(0, 1000), base });
      }
    }
    return [...skills.values()];
  }
  async skill(agent: Agent, name: string, resource = 'SKILL.md') {
    if (!agent.skills.includes(name) || !agent.tools.includes('read_skill'))
      throw new Error('该技能未授权给当前 Agent');
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(resource) ||
      resource.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/\.(md|txt|json)$/i.test(resource)
    )
      throw new Error('仅可读取技能包内的文本资源');
    const skill = (await this.skills()).find((item) => item.id === name);
    if (!skill) throw new Error('技能不存在');
    return this.safeRead(path.join(skill.base, name), resource);
  }
  private async safeRead(base: string, relative: string) {
    const realBase = await fs.realpath(base);
    const file = await fs.realpath(path.resolve(base, relative));
    const inside = path.relative(realBase, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('文件路径越界');
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('文本文件过大或不可读取');
    return fs.readFile(file, 'utf8');
  }
  async sessions(): Promise<Session[]> {
    const files = await fs.readdir(path.join(this.data, 'sessions')).catch(() => [] as string[]);
    return (
      await Promise.all(
        files
          .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
          .map((file) => readJson<Session | null>(path.join(this.data, 'sessions', file), null)),
      )
    )
      .filter((item): item is Session => !!item)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private sessionFile(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('会话 ID 无效');
    return path.join(this.data, 'sessions', `${id}.json`);
  }
  async session(id: string): Promise<Session> {
    const session = await readJson<Session | null>(this.sessionFile(id), null);
    if (!session) throw new Error('会话不存在');
    return session;
  }
  async saveSession(session: Session) {
    await atomicWrite(this.sessionFile(session.id), JSON.stringify(session));
  }
  async removeSession(id: string) {
    const sessionFile = this.sessionFile(id);
    for (const file of await fs.readdir(path.join(this.data, 'runs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      if ((await this.readRun(file.slice(0, -5)))?.sessionId === id)
        await fs.unlink(path.join(this.data, 'runs', file));
    }
    await fs.unlink(sessionFile);
  }
  async writeRun<T extends { id: string }>(run: T) {
    if (!/^[a-f0-9-]{36}$/.test(run.id)) throw new Error('运行 ID 无效');
    await atomicWrite(path.join(this.data, 'runs', `${run.id}.json`), JSON.stringify(run));
  }
  async readRun(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('运行 ID 无效');
    return readJson<Record<string, unknown> | null>(
      path.join(this.data, 'runs', `${id}.json`),
      null,
    );
  }
}
