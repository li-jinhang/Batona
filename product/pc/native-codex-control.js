'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { readNativeThreadExpectation } = require('./tools/native-codex-probe/native-thread-binding');

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
    const processId = await this.processId();
    const binding = await readNativeThreadExpectation({ threadId, client: this.appServer });
    let result;
    try { result = await this.invoke([
      operation, String(processId),
      Buffer.from(binding.title, 'utf8').toString('base64'),
      binding.lastUserHash, binding.lastAssistantHash,
      binding.titleHash, ...extra,
    ]); } catch (error) {
      if (['native-process-unverified', 'native-window-missing', 'native-session-mismatch'].includes(error.code))
        this.verifiedProcessId = null;
      throw error;
    }
    return result;
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

  async permissionMenu(threadId, open) {
    return this.boundInvoke(threadId, open ? 'open-permission' : 'close-permission');
  }

  async setPermission(threadId, profileId) {
    return this.boundInvoke(threadId, 'set-permission', [profileId]);
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
