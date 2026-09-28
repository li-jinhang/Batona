// Exercise the actual Windows stop helper with test-owned listeners only.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stopDshProcesses } = require('../dsh-launcher');

(async () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../build/dsh-restart-test-'));
  const script = path.join(root, '@deepseek-ai/dsh/lib/bin.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'const net=require("net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>console.log(s.address().port));');
  for (const recognized of [false, true]) {
    const fixture = recognized ? script : path.join(root, 'unrelated.js');
    if (!recognized) fs.copyFileSync(script, fixture);
    const proc = spawn(process.execPath, [fixture, '--profile', 'web'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const port = await new Promise((resolve, reject) => { proc.once('error', reject); proc.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))); });
      if (!recognized) {
        await assert.rejects(stopDshProcesses({ port }));
        assert.equal(proc.exitCode, null, 'an unrelated listener must survive');
      } else {
        await stopDshProcesses({ port });
        if (proc.exitCode === null) await new Promise(resolve => proc.once('exit', resolve));
      }
    } finally { if (proc.exitCode === null) proc.kill(); }
  }
  console.log('PASS Windows DSH termination and unrelated-port protection (isolated processes)');
})().catch(error => { console.error(error); process.exitCode = 1; });
