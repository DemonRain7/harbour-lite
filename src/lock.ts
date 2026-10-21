import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Refuse a second process before it can mark a live run as interrupted. */
export async function acquireLock(data: string) {
  await fs.mkdir(data, { recursive: true });
  const file = path.join(data, 'server.lock');
  const value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, value, { flag: 'wx', mode: 0o600 });
      return async () => {
        if ((await fs.readFile(file, 'utf8').catch(() => '')) === value) await fs.unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: { pid?: number };
      try {
        existing = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        throw new Error('数据目录已有锁文件，请核对正在运行的进程。');
      }
      if (!Number.isInteger(existing.pid) || existing.pid! < 1)
        throw new Error('数据目录锁文件无效，请人工核对。');
      let dead = false;
      try {
        process.kill(existing.pid!, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (!dead) throw new Error('该数据目录已由另一个进程使用，未修改任何会话。');
      // This exact file belongs to a process that no longer exists; no directories are removed.
      await fs.unlink(file);
    }
  }
  throw new Error('无法获得数据目录锁');
}
