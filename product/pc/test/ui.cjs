'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-test-')));
const out = process.env.BATONA_PC_UI_TEST_OUTPUT
  ? path.resolve(process.env.BATONA_PC_UI_TEST_OUTPUT)
  : path.resolve(__dirname, '../../../output/ui-implementation');
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
    assert.equal(await run(`document.body.textContent.includes('查看详情')`), false);
    assert.equal(await run(`document.body.textContent.includes('查看限制说明')`), false);
    assert.equal(await run(`document.body.textContent.includes('原生桌面会话通过 Codex 输入框和菜单操作')`), false);
    assert.equal(await run(`document.getElementById('dsh-badge').textContent`), '远程就绪');
    assert.equal(await run(`document.getElementById('codex-badge').textContent`), '远程就绪');
    assert.equal(await run(`document.getElementById('codex-auth').textContent`), '已登录');
    assert.equal(await run(`document.getElementById('dsh-hint').hidden`), true);
    assert.equal(await run(`document.getElementById('codex-hint').hidden`), true);
    assert.equal(await run(`document.body.textContent.includes('隧道与网关已连接，可从手机访问')`), false);
    assert.equal(await run(`document.getElementById('btn-pair-open').textContent`), '显示配对信息');
    assert.equal(await run(`document.querySelector('.pairing #btn-pair-copy')`), null);
    await waitFor(`[...document.querySelectorAll('.backend-logo img')].length === 2 &&
      [...document.querySelectorAll('.backend-logo img')].every((image) => image.complete && image.naturalWidth > 0)`);
    await run(`window.uiFixture.setTunnel(false);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='等待连接'`);
    await run(`window.uiFixture.setTunnel(true);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='远程就绪'`);
    await run(`document.querySelector('.backend-card[data-detail="dsh"] .backend-logo').click()`);
    assert.equal(await run(`document.getElementById('detail-title').textContent`), 'DSH · 服务详情');
    assert.equal(await run(`document.getElementById('btn-dsh-open').disabled`), false);
    await run(`document.getElementById('btn-dsh-open').click()`);
    assert.equal(await run(`window.uiFixture.calls().includes('dsh-open')`), true);
    await run(`window.uiFixture.setDshRunning(false);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('btn-dsh-open').disabled`);
    assert.equal(await run(`document.getElementById('btn-dsh-start').disabled`), false);
    await run(`document.getElementById('btn-dsh-start').click()`);
    await waitFor(`!document.getElementById('btn-dsh-open').disabled`);
    assert.equal(await run(`window.uiFixture.calls().includes('dsh-start')`), true);
    await run(`document.getElementById('btn-detail-close').click()`);
    await run(`document.querySelector('.backend-card[data-detail="codex"] .backend-content').click()`);
    assert.match(await run(`document.getElementById('detail-body').textContent`), /登录状态：已登录/);
    await run(`window.uiFixture.setCodexAuth('signed-out');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-auth').textContent==='未登录'`);
    await run(`window.uiFixture.setCodexAuth('not-required');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-auth').textContent==='无需登录'`);
    await run(`window.uiFixture.setCodexAuth('unknown');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-auth').textContent==='状态未知'`);
    await run(`window.uiFixture.setCodexAuth('signed-in');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-auth').textContent==='已登录'`);
    assert.equal(await run(`!document.getElementById('codex-control-panel').hidden`), true);
    assert.equal(await run(`document.querySelectorAll('[data-control-mode]').length`), 2);
    assert.equal(await run(`document.querySelector('.control-option').dataset.controlMode`), 'shared');
    assert.match(await run(`document.querySelector('[data-control-mode="shared"]').textContent`), /共享连接（推荐）.*更快速，版本鲁棒性差/s);
    assert.match(await run(`document.querySelector('[data-control-mode="interface"]').textContent`), /协议更迭时的平替方案/);
    assert.equal(await run(`document.querySelector('[data-control-mode="interface"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await run(`document.body.textContent.includes('共享连接启动')`), false);
    assert.equal(await run(`document.getElementById('codex-badge').classList.contains('good')`), true);
    assert.equal(await run(`window.uiFixture.calls().some(call => call.startsWith('codex-control:'))`), false);
    await run(`window.uiFixture.setCodexTransport('shared-readonly');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.querySelector('[data-control-mode="shared"]').getAttribute('aria-pressed')==='true'`);
    assert.match(await run(`document.getElementById('detail-body').textContent`), /当前连接只读/);
    assert.equal(await run(`document.getElementById('codex-badge').textContent`), '远程就绪');
    await run(`window.uiFixture.setCodexTransport('shared-write');document.getElementById('btn-refresh').click()`);
    await waitFor(`!document.getElementById('detail-body').textContent.includes('当前连接只读')`);
    assert.equal(await run(`document.getElementById('codex-badge').textContent`), '远程就绪');
    assert.equal(await run(`document.getElementById('codex-badge').classList.contains('good')`), true);
    await run(`window.uiFixture.setSharedAttached(false);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='等待连接'`);
    await run(`document.querySelector('[data-control-mode="shared"]').click()`);
    assert.equal(await run(`document.getElementById('codex-restart-dialog').open`), true);
    await run(`document.getElementById('btn-codex-restart-cancel').click();window.uiFixture.setSharedAttached(true);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='远程就绪'`);
    await run(`window.uiFixture.setCodexBridge(false);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='未连接'`);
    assert.equal(await run(`document.getElementById('codex-badge').classList.contains('neutral')`), true);
    assert.match(await run(`document.getElementById('detail-body').textContent`), /本地桥接：未连接/);
    await run(`window.uiFixture.setCodexBridge(true);window.uiFixture.setCodexTransport('stdio-native-ui');document.getElementById('btn-refresh').click()`);
    await waitFor(`document.querySelector('[data-control-mode="interface"]').getAttribute('aria-pressed')==='true'`);
    assert.equal(await run(`document.getElementById('codex-badge').textContent`), '远程就绪');
    assert.equal(await run(`document.body.textContent.includes('原生桌面会话通过 Codex 输入框和菜单操作')`), false);
    await run(`document.getElementById('btn-detail-close').click();document.querySelector('.backend-card[data-detail="codex"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    assert.equal(await run(`document.getElementById('detail-dialog').open`), true);
    await run(`document.querySelector('[data-control-mode="shared"]').click()`);
    assert.equal(await run(`document.getElementById('codex-restart-dialog').open`), true);
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(await run(`document.getElementById('codex-restart-dialog').matches(':modal')`), true);
    assert.equal(await run(`!!document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('#codex-restart-dialog')`), true);
    assert.equal(await run(`window.uiFixture.calls().includes('codex-control:shared')`), false);
    await run(`document.getElementById('btn-codex-restart-cancel').click()`);
    assert.equal(await run(`document.getElementById('codex-restart-dialog').open`), false);
    assert.equal(await run(`document.querySelector('[data-control-mode="interface"]').getAttribute('aria-pressed')`), 'true');
    await run(`window.uiFixture.setCodexControlFailure(true);document.querySelector('[data-control-mode="shared"]').click();document.getElementById('btn-codex-restart-confirm').click()`);
    await waitFor(`!document.getElementById('codex-restart-error').hidden`);
    assert.equal(await run(`document.querySelector('[data-control-mode="interface"]').getAttribute('aria-pressed')`), 'true');
    await run(`document.getElementById('btn-codex-restart-cancel').click();window.uiFixture.setCodexControlFailure(false);document.querySelector('[data-control-mode="shared"]').click();document.getElementById('btn-codex-restart-confirm').click()`);
    await waitFor(`document.querySelector('[data-control-mode="shared"]').getAttribute('aria-pressed')==='true'`);
    assert.equal(await run(`document.getElementById('codex-restart-dialog').open`), false);
    await run(`document.querySelector('[data-control-mode="interface"]').click()`);
    await waitFor(`document.querySelector('[data-control-mode="interface"]').getAttribute('aria-pressed')==='true'`);
    assert.equal(await run(`window.uiFixture.calls().includes('codex-control:interface')`), true);
    fs.writeFileSync(
      path.join(out, 'pc-codex-detail.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await run(`window.uiFixture.setCodexDesktop(false);document.getElementById('btn-refresh').click()`);
    await waitFor(`document.getElementById('codex-badge').textContent==='未运行'`);
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
    assert.equal(await run(`document.querySelector('#pair-dialog #btn-pair-copy') !== null`), true);
    assert.equal(await run(`document.getElementById('btn-pair-copy').hidden`), false);
    fs.writeFileSync(path.join(out, 'pc-pair-info.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.getElementById('btn-pair-copy').click()`);
    await waitFor(`document.getElementById('toast').textContent.includes('配对码已复制')`);
    assert.equal(await run(`window.uiFixture.calls().includes('pair-copy-code')`), true);
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
