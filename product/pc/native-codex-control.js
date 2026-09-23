'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { verifyNativeThreadBinding } = require('./tools/native-codex-probe/native-thread-binding');

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
  }

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

  async send(threadId, text, profileId) {
    const processId = await this.locateWindow();
    const binding = await verifyNativeThreadBinding({
      threadId,
      client: this.appServer,
      inspect: (title) => this.invoke(['inspect', String(processId), Buffer.from(title, 'utf8').toString('base64')]),
    });
    const result = await this.invoke([
      'send', String(binding.processId), binding.windowHandle,
      Buffer.from(binding.title, 'utf8').toString('base64'),
      binding.lastUserHash, binding.lastAssistantHash,
      Buffer.from(text, 'utf8').toString('base64'), binding.titleHash, profileId,
    ]);
    if (result?.accepted !== true) throw controlError('native-submit-unconfirmed');
    return result;
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
