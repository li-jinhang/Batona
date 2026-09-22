'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-test-')));
const out = path.resolve(__dirname, '../../../output/ui-implementation');
fs.mkdirSync(out, { recursive: true });
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-fixture-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await run(code)) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error('Timed out: ' + code);
  };
  try {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    await waitFor(`document.getElementById('tunnel-status').textContent==='已连接'`);
    assert.equal(await run(`document.querySelectorAll('.nav-item').length`), 3);
    assert.equal(await run(`document.getElementById('pair-code').textContent`), '');
    await run(`document.querySelector('[data-detail="codex"]').click()`);
    assert.match(
      await run(`document.getElementById('detail-body').textContent`),
      /不代表账号认证通过/,
    );
    await run(`document.getElementById('btn-detail-close').click()`);
    for (const width of [1180, 960, 480]) {
      win.setSize(width, 800);
      await new Promise((r) => setTimeout(r, 180));
      assert.equal(
        await run(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        `Overflow at ${width}`,
      );
      if (width === 1180)
        fs.writeFileSync(
          path.join(out, 'pc-overview.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
      if (width === 480)
        fs.writeFileSync(
          path.join(out, 'pc-narrow.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
    }
    win.setSize(1180, 800);
    await run(`document.querySelector('.nav-item[data-page="logs"]').click()`);
    await waitFor(`document.querySelectorAll('#full-logs .log-row').length===3`);
    await run(
      `document.getElementById('log-filter').value='Codex';document.getElementById('log-filter').dispatchEvent(new Event('input'))`,
    );
    assert.equal(await run(`document.querySelectorAll('#full-logs .log-row').length`), 1);
    await run(
      `document.querySelector('.nav-item[data-page="overview"]').click();document.getElementById('btn-pair-open').click()`,
    );
    await waitFor(`document.getElementById('pair-dialog').open`);
    await run(
      `document.getElementById('pair-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))`,
    );
    await waitFor(`window.uiFixture.calls().includes('pair-close')`);
    assert.equal(await run(`document.getElementById('pair-code').textContent`), '');
    await run(`document.getElementById('btn-pair-open').click()`);
    await waitFor(`!document.getElementById('btn-pair-allow').hidden`);
    await run(`document.getElementById('btn-pair-allow').click()`);
    await waitFor(`document.getElementById('pair-pending').textContent.includes('配对成功')`);
    assert.equal(await run(`document.getElementById('pair-code').textContent`), '');
    await run(`window.uiFixture.revoke()`);
    await waitFor(`!document.getElementById('view-bind').classList.contains('hidden')`);
    assert.equal(await run(`document.getElementById('pair-dialog').open`), false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'pc-login.png'), (await win.webContents.capturePage()).toPNG());
    console.log(
      'PASS: renderer navigation, responsive layout, logs, pairing close/approval and revoked access',
    );
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
