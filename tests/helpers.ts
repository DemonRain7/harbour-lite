import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage.js';
export const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export async function fixture() {
  // A unique temporary directory, never the user's working data.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbour-lite-test-'));
  for (const name of ['agents', 'skills', 'web'])
    await fs.cp(path.join(project, name), path.join(root, name), { recursive: true });
  const store = new Store(root);
  await store.init();
  return {
    root,
    store,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
export async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for test condition');
}
