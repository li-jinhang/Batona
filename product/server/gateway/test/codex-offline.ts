/**
 * 回归：Codex PC 不在线是常态运行状态，不能令整个网关启动失败。
 * 此处不启动监听端口，以稳定复现“隧道尚未连入”的最小场景。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { createCodexAdapter } from '../src/adapter/codex/adapter.ts';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function main(): Promise<void> {
  const port = await unusedPort();
  const registry = await AdapterRegistry.assemble(
    { codex: createCodexAdapter },
    { codex: { enabled: true, cfg: { baseUrl: `http://127.0.0.1:${port}` } } },
  );
  const codex = registry.require('codex');
  await assert.rejects(codex.listSessions(), (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'codex-offline',
  );
  await codex.dispose?.();
  console.log('[codex-offline] gateway remains available while PC is offline');
}

void main();
