'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') throw new Error('Native Codex control requires Windows');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
if (!fs.existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is unavailable');
const output = path.join(__dirname, '..', '..', 'build', 'native-codex-bound-sender.exe');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(compiler, [
  '/nologo', '/target:exe', `/out:${output}`,
  '/main:Batona.NativeCodexProbe.BoundSender',
  `/reference:${path.join(framework, 'WPF', 'UIAutomationClient.dll')}`,
  `/reference:${path.join(framework, 'WPF', 'UIAutomationTypes.dll')}`,
  `/reference:${path.join(framework, 'WPF', 'WindowsBase.dll')}`,
  path.join(__dirname, 'Identity.cs'), path.join(__dirname, 'BoundSender.cs'),
], { stdio: 'inherit', windowsHide: true });
console.log('Native Codex control built');
