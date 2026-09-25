'use strict';

const assert = require('node:assert/strict');
const {
  launchSharedCodexDesktop,
  powerShellErrorMessage,
  runPowerShell,
  sharedWebSocketUrl,
  stripTerminalFormatting,
} = require('../codex-handoff.js');

async function main() {
  const calls = [];
  const runCommand = async (_script, _state, action) => {
    calls.push(action);
    return action === 'Launch' || action === 'Restart'
      ? `${action} ok\nBATONA_SHARED_WS_URL=ws://127.0.0.1:45678`
      : `${action} ok`;
  };

  await assert.rejects(
    launchSharedCodexDesktop({
      scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: true,
      runCommand,
    }),
    error => error.code === 'codex-desktop-open',
  );
  await assert.rejects(
    launchSharedCodexDesktop({
      scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: null,
      runCommand,
    }),
    error => error.code === 'codex-status-unknown',
  );
  assert.deepEqual(calls, [], 'must not run handoff commands if Desktop is open or unknown');

  const result = await launchSharedCodexDesktop({
    scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: false,
    runCommand,
    stateExists: () => true,
  });
  assert.deepEqual(calls, ['Stop', 'Launch']);
  assert.match(result.output, /^Launch ok/);
  assert.equal(result.websocketUrl, 'ws://127.0.0.1:45678');

  calls.length = 0;
  await launchSharedCodexDesktop({
    scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: false,
    runCommand,
    stateExists: () => false,
  });
  assert.deepEqual(calls, ['Launch'], 'a first launch must not stop an untracked process');

  calls.length = 0;
  await launchSharedCodexDesktop({
    scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: true,
    restart: true, runCommand, stateExists: () => true,
  });
  assert.deepEqual(calls, ['Status', 'Restart'], 'confirmed restart must check for an existing shared connection before the guarded restart');

  calls.length = 0;
  const alreadyConnected = await launchSharedCodexDesktop({
    scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: true,
    restart: true, stateExists: () => true,
    runCommand: async (_script, _state, action) => {
      calls.push(action);
      if (action !== 'Status') throw new Error('Desktop must not be restarted');
      return 'Preflight OK: matching CLI; ws://127.0.0.1:45678.\nShared server: ready (PID 42).\nDesktop: connected (PID 43).';
    },
  });
  assert.deepEqual(calls, ['Status']);
  assert.equal(alreadyConnected.websocketUrl, 'ws://127.0.0.1:45678');

  calls.length = 0;
  const connectedAfterDiagnostic = await launchSharedCodexDesktop({
    scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: true,
    restart: true,
    runCommand: async (_script, _state, action) => {
      calls.push(action);
      if (action === 'Restart') throw new Error('Registration response error message: DEPRECATED_ENDPOINT');
      return 'Preflight OK: matching CLI; ws://127.0.0.1:45678.\nShared server: ready (PID 42).\nDesktop: connected (PID 43).';
    },
  });
  assert.deepEqual(calls, ['Restart', 'Status']);
  assert.equal(connectedAfterDiagnostic.websocketUrl, 'ws://127.0.0.1:45678');

  calls.length = 0;
  await assert.rejects(
    launchSharedCodexDesktop({
      scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: true,
      restart: true,
      runCommand: async (_script, _state, action) => {
        calls.push(action);
        if (action === 'Restart') throw new Error('restart failed');
        return 'Preflight OK: matching CLI; ws://127.0.0.1:45678.\nShared server: ready (PID 42).\nDesktop: not connected to shared server (PID 43).';
      },
    }),
    /restart failed/,
  );
  assert.deepEqual(calls, ['Restart', 'Status']);

  calls.length = 0;
  await assert.rejects(
    launchSharedCodexDesktop({
      scriptPath: 'handoff.ps1', statePath: 'state.json', codexDesktop: false,
      runCommand: async (_script, _state, action) => {
        calls.push(action);
        throw new Error('identity check failed');
      },
      stateExists: () => true,
    }),
    /identity check failed/,
  );
  assert.deepEqual(calls, ['Stop'], 'launch must stop if cleanup refuses an unsafe state');

  assert.equal(stripTerminalFormatting('\u001b[31;1mCodex\u001b[0m'), 'Codex');
  assert.equal(
    powerShellErrorMessage('\u001b[31;1mException: Port 45678 belongs to an unknown listener.\u001b[0m\r\nAt C:\\Temp\\handoff.ps1:80 char:3'),
    'Port 45678 belongs to an unknown listener.',
  );
  assert.equal(
    powerShellErrorMessage('Exception: C:\\Temp\\handoff.ps1:80\nLine |\n 80 | throw "port conflict"\n | ~~~~~\nPort 45678 belongs to an unknown listener.'),
    'Port 45678 belongs to an unknown listener.',
  );
  assert.equal(
    powerShellErrorMessage('Exception: C:\\Temp\\handoff.ps1:135\nLine |\n 135 | throw "close failed"\n     | ~~~~~~~~~~~~~~~~~~~~\n     | Codex Desktop is still running. Save work and retry.'),
    'Codex Desktop is still running. Save work and retry.',
  );
  assert.equal(
    sharedWebSocketUrl('launched\nBATONA_SHARED_WS_URL=ws://127.0.0.1:49152'),
    'ws://127.0.0.1:49152',
  );
  const invocation = [];
  const status = await runPowerShell('handoff.ps1', 'state.json', 'Status', (file, args, options, callback) => {
    invocation.push({ file, args, options });
    callback(null, 'Preflight OK', '');
  });
  assert.equal(status, 'Preflight OK');
  assert.equal(invocation[0].file, 'powershell.exe');
  assert.deepEqual(invocation[0].args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'handoff.ps1', '-StateFile', 'state.json', '-Status']);
  await assert.rejects(runPowerShell('handoff.ps1', 'state.json', 'Status', (_file, _args, _options, callback) => {
    callback(Object.assign(new Error('blocked'), { code: 1 }), '', 'PSSecurityException: about_Execution_Policies');
  }), (error) => error.code === 'codex-handoff-policy-blocked' && /系统策略/.test(error.message));
  await assert.rejects(
    runPowerShell('handoff.ps1', 'state.json', 'Restart', (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '');
    }),
    error => error.code === 'windows-powershell-missing' && /PowerShell 5\.1/.test(error.message),
  );
  await assert.rejects(
    runPowerShell('handoff.ps1', 'state.json', 'Restart', (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('Command failed'), { code: 1 }), '',
        '[38536:35220:0925/164146.713:ERROR:google_apis\\gcm\\engine\\registration_request.cc:291] Registration response error message: DEPRECATED_ENDPOINT');
    }),
    error => error.code === 'codex-handoff-failed'
      && /Codex 重启脚本执行失败/.test(error.message)
      && !/DEPRECATED_ENDPOINT/.test(error.message),
  );
  await assert.rejects(
    runPowerShell('handoff.ps1', 'state.json', 'Restart', (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('Command failed'), { code: 1 }),
        'Exception: Codex Desktop did not connect to the shared app-server.',
        '[38536:35220:0925/164146.713:ERROR:google_apis\\gcm\\engine\\registration_request.cc:291] Registration response error message: DEPRECATED_ENDPOINT');
    }),
    /Codex Desktop did not connect to the shared app-server/,
  );
  console.log('PASS: Codex handoff launch guards, cleanup order, and failure handling');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
