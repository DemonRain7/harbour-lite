import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, project, waitFor } from '../tests/helpers.js';

const requireDesktop = createRequire(path.join(project, 'desktop', 'package.json'));
const executablePath = requireDesktop('electron') as string;
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const fixtureData = await fixture();
let application;
try {
  application = await electron.launch({
    executablePath,
    args: [path.join(project, 'desktop/main.cjs'), '--disable-gpu'],
    env: {
      ...process.env,
      HARBOUR_LITE_TEST_HIDDEN: '1',
      HARBOUR_LITE_DESKTOP_PORT: String(port),
      HARBOUR_LITE_DATA: fixtureData.store.data,
      HARBOUR_LITE_TOKEN: '',
    },
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await page.locator('#agent-select option[value="assistant"]').waitFor({ state: 'attached' });
  await page.locator('#splash').waitFor({ state: 'hidden' });
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isVisible(),
    ),
    false,
  );
  assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
  await page.locator('#message').fill('桌面离线演示');
  await page.locator('#send').click();
  await page.getByText('你好，欢迎来到 Harbour Lite。', { exact: false }).waitFor();
  console.log(
    'Desktop passed: hidden isolated Electron window, private test data/port, no Node access in renderer, offline round trip.',
  );
} finally {
  if (application) await application.close();
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
      return false;
    } catch {
      return true;
    }
  }, 5000);
  await fixtureData.cleanup();
}
