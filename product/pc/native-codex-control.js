'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { readNativeThreadExpectation, readNativeThreadTitleExpectation } = require('./tools/native-codex-probe/native-thread-binding');

const execFileAsync = promisify(execFile);

// Only the installed, Authenticode-valid OpenAI Codex package may be driven.
// No user text is interpolated into this PowerShell script.
const FIND_SIGNED_WINDOW = String.raw`
$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue
if (@($package).Count -ne 1) { exit 2 }
$expected = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$windows = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.Path -and
  [string]::Equals($_.Path, $expected, [StringComparison]::OrdinalIgnoreCase)
})
if ($windows.Count -ne 1) { exit 3 }
Import-Module (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $expected
if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notmatch 'CN="?OpenAI OpCo, LLC"?') { exit 4 }
[Console]::Out.WriteLine($windows[0].Id)
`;

function controlError(code) {
  return Object.assign(new Error(code), { code });
}

function isStaleProcessError(error) {
  return ['native-process-unverified', 'native-window-missing', 'native-session-mismatch'].includes(error?.code)
    || error?.code === 'native-control-failed:process-lookup:ArgumentException';
}

function nativeExecutable() {
  return process.resourcesPath && process.versions.electron && !process.defaultApp
    ? path.join(process.resourcesPath, 'native-codex-bound-sender.exe')
    : path.join(__dirname, 'build', 'native-codex-bound-sender.exe');
}

class NativeCodexControl {
  constructor({ appServer, executable = nativeExecutable(), locateWindow = locateSignedWindow, run = execFileAsync } = {}) {
    this.appServer = appServer;
    this.executable = executable;
    this.locateWindow = locateWindow;
    this.run = run;
    this.verifiedProcessId = null;
    this.locating = null;
    this.progressBindings = new Map();
  }

  async processId() {
    if (this.verifiedProcessId) return this.verifiedProcessId;
    if (!this.locating) {
      this.locating = this.locateWindow().then((processId) => {
        this.verifiedProcessId = processId;
        return processId;
      }).finally(() => { this.locating = null; });
    }
    return this.locating;
  }

  warm() { void this.processId().catch(() => {}); }

  async invoke(args) {
    if (!fs.existsSync(this.executable)) throw controlError('native-control-unavailable');
    try {
      const { stdout } = await this.run(this.executable, args, {
        windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      const code = String(error?.stderr || '').trim().split(/\r?\n/)[0];
      throw controlError(/^native-[a-z0-9:-]+$/i.test(code) ? code : 'native-control-failed');
    }
  }

  async boundInvoke(threadId, operation, extra = []) {
    const binding = operation === 'set-permission'
      ? await readNativeThreadTitleExpectation({ threadId, client: this.appServer })
      : await readNativeThreadExpectation({ threadId, client: this.appServer });
    const argsFor = (processId) => [
      operation, String(processId),
      Buffer.from(binding.title, 'utf8').toString('base64'),
      binding.lastUserHash || '-', binding.lastAssistantHash || '-',
      binding.titleHash, ...extra,
    ];
    try {
      return await this.invoke(argsFor(await this.processId()));
    } catch (error) {
      if (operation === 'set-permission' && error?.code === 'native-task-identity-mismatch') {
        // The set-permission binary reports this only before touching a UI
        // control. A title can briefly disappear while Desktop redraws its
        // permission dialog, so one delayed retry is safe and idempotent.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return this.invoke(argsFor(await this.processId()));
      }
      if (!isStaleProcessError(error)) throw error;
      // A cached Desktop PID can become invalid after Codex restarts. These
      // errors happen before the controller interacts with the UI, so retrying
      // once with a freshly verified signed window cannot duplicate a write.
      this.verifiedProcessId = null;
      try {
        return await this.invoke(argsFor(await this.processId()));
      } catch (retryError) {
        if (isStaleProcessError(retryError)) this.verifiedProcessId = null;
        throw retryError;
      }
    }
  }

  async send(threadId, text, profileId) {
    const result = await this.boundInvoke(threadId, 'send', [
      Buffer.from(text, 'utf8').toString('base64'), profileId || 'keep-current',
    ]);
    if (result?.accepted !== true) throw controlError('native-submit-unconfirmed');
    return result;
  }

  async setModel(threadId, { displayName, effortIndex, effortCount }) {
    const result = await this.boundInvoke(threadId, 'set-model', [
      Buffer.from(displayName, 'utf8').toString('base64'), String(effortIndex), String(effortCount),
    ]);
    if (result?.accepted !== true) throw controlError('native-model-unavailable');
    return result;
  }

  async renameWorkspace(currentTitle, newTitle) {
    const argsFor = (processId) => [
      'rename-workspace', String(processId),
      Buffer.from(currentTitle, 'utf8').toString('base64'),
      Buffer.from(newTitle, 'utf8').toString('base64'),
    ];
    try {
      const result = await this.invoke(argsFor(await this.processId()));
      if (result?.accepted !== true) throw controlError('native-workspace-rename-unconfirmed');
      return result;
    } catch (error) {
      if (!isStaleProcessError(error)) throw error;
      this.verifiedProcessId = null;
      try {
        const result = await this.invoke(argsFor(await this.processId()));
        if (result?.accepted !== true) throw controlError('native-workspace-rename-unconfirmed');
        return result;
      } catch (retryError) {
        if (isStaleProcessError(retryError)) this.verifiedProcessId = null;
        throw retryError;
      }
    }
  }

  async readProgress(threadId) {
    let entry = this.progressBindings.get(threadId);
    if (!entry || Date.now() - entry.checkedAt > 30_000) {
      const binding = await readNativeThreadTitleExpectation({ threadId, client: this.appServer });
      entry = { binding, checkedAt: Date.now() };
      this.progressBindings.set(threadId, entry);
    }
    const { title, titleHash } = entry.binding;
    return this.invoke(['status', String(await this.processId()),
      Buffer.from(title, 'utf8').toString('base64'), '-', '-', titleHash]);
  }

  async permissionMenu(threadId, open) {
    return this.boundInvoke(threadId, open ? 'open-permission' : 'close-permission');
  }

  async setPermission(threadId, profileId, confirmedFullAccess = false) {
    return this.boundInvoke(threadId, 'set-permission', [profileId, confirmedFullAccess ? 'confirmed' : 'unconfirmed']);
  }
}

async function locateSignedWindow() {
  if (process.platform !== 'win32') throw controlError('native-control-unavailable');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', FIND_SIGNED_WINDOW,
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 });
    const processId = Number(stdout.trim());
    if (!Number.isInteger(processId) || processId <= 0) throw controlError('native-process-unverified');
    return processId;
  } catch {
    throw controlError('native-process-unverified');
  }
}

module.exports = { NativeCodexControl, locateSignedWindow };
