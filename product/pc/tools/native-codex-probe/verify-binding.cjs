'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AppServerClient } = require('../../codex-bridge');
const { verifyNativeThreadBinding } = require('./native-thread-binding');

const execFileAsync = promisify(execFile);

async function main() {
  const [threadId, processIdText, identityExe] = process.argv.slice(2);
  const processId = Number(processIdText);
  if (!threadId || !Number.isInteger(processId) || processId <= 0 || !identityExe) {
    throw Object.assign(new Error('usage: node verify-binding.cjs <thread-id> <Codex-window-process-id> <identity-exe>'), { code: 'usage' });
  }
  const client = new AppServerClient();
  try {
    if (!await client.start()) throw Object.assign(new Error('read-only app-server unavailable'), { code: 'app-server-unavailable' });
    const binding = await verifyNativeThreadBinding({
      threadId,
      client,
      inspect: async () => {
        const { stdout } = await execFileAsync(identityExe, [String(processId)], {
          windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
        });
        return JSON.parse(stdout);
      },
    });
    console.log(JSON.stringify({ verified: true, threadId: binding.threadId,
      processId: binding.processId, windowHandle: binding.windowHandle }));
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  console.error(error?.code || 'native-task-verification-failed');
  process.exitCode = 1;
});
