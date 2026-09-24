import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { backendIdAllowed, visibleBackendIds } from '../src/backend-policy.js';
import { newestSessionsFirst } from '../src/session-order.js';
import { HostedGateway } from '../../server/gateway/src/hosted/gateway.ts';

const require = createRequire(import.meta.url);
const { TunnelClient } = require('../../pc/tunnel/client.js');
const BASE_PATH = '/site-prefix/projects/dsh-link/pwa/';
const DIST = resolve('dist');
const TEMP = mkdtempSync(join(tmpdir(), 'batona-pwa-e2e-'));
const adminKey = randomBytes(32).toString('hex');
const delivery = [];
const publicKey = 'A'.repeat(87), privateKey = 'B'.repeat(43);
assert.deepEqual(visibleBackendIds([{ id: 'mock' }, { id: 'dsh' }, { id: 'codex' }, { id: 'claude' }]), ['dsh', 'codex']);
assert.deepEqual(visibleBackendIds([{ id: 'mock' }, { id: 'dsh' }], true), ['dsh', 'mock']);
assert.equal(backendIdAllowed('mock'), false);
assert.equal(backendIdAllowed('mock', true), true);
assert.deepEqual(newestSessionsFirst([
  { sessionId: 'older', updatedAt: 10 },
  { sessionId: 'newest', updatedAt: 30 },
  { sessionId: 'middle', updatedAt: 20 },
]).map(session => session.sessionId), ['newest', 'middle', 'older']);
const gateway = new HostedGateway({
  dataDir: TEMP,
  adminKey,
  vaultKey: randomBytes(32),
  webDir: '../server/gateway/web',
  mock: true,
  webPush: { subject: 'https://localhost/', publicKey, privateKey },
  pushSender: async (subscription, payload) => delivery.push({ endpoint: subscription.endpoint, payload }),
});
const gateways = await listen(gateway.server);
const directoryServer = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://local').searchParams.get('p') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path, roots: path ? [] : ['C:\\'], dirs: path ? [] : ['C:\\Projects'] }));
});
const directoryAddress = await listen(directoryServer);
const admin = await api('/api/admin/create', { remark: 'PWA browser fixture' }, adminKey);
const pc = await api('/api/access/login', { key: admin.key, deviceSecret: randomBytes(32).toString('hex'), name: 'Isolated test PC' });
const tunnel = new TunnelClient({
  host: '127.0.0.1', gwPort: gateways.port, token: pc.token, tls: false,
  services: () => [{ name: 'dir', localPort: directoryAddress.port }],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('PC tunnel did not connect')), 8000);
  tunnel.once('connected', () => { clearTimeout(timer); resolve(); });
  tunnel.once('error', error => { clearTimeout(timer); reject(error); });
  tunnel.start();
});

const oldPair = await api('/api/access/pair-open', {}, pc.token);
const oldDeviceSecret = randomBytes(32).toString('hex');
const oldRequest = await api('/api/access/pair-request', { code: oldPair.code, deviceSecret: oldDeviceSecret, name: 'Existing Android' });
const oldStatus = await api('/api/access/pair-status', { pairId: oldPair.pairId }, pc.token);
await api('/api/access/pair-confirm', { pairId: oldPair.pairId, requestId: oldStatus.pending.requestId, allow: true }, pc.token);
let replacementPair = await api('/api/access/pair-open', {}, pc.token);

const front = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: gateways.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: req.headers.host },
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
    return;
  }
  if (url.pathname === '/ws' || url.pathname === '/tunnel') {
    res.writeHead(426).end('upgrade required');
    return;
  }
  if (!url.pathname.startsWith(BASE_PATH)) { res.writeHead(404).end('not found'); return; }
  const relative = decodeURIComponent(url.pathname.slice(BASE_PATH.length));
  const file = resolve(DIST, relative || 'index.html');
  if (!file.startsWith(DIST + '\\') && file !== join(DIST, 'index.html')) { res.writeHead(404).end('not found'); return; }
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end('not found'); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes('assets\\') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'camera=(self), notifications=(self)',
  });
  res.end(body);
});
front.on('upgrade', (req, socket, head) => {
  const upstream = connect(gateways.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries({ ...req.headers, host: req.headers.host })) {
      if (Array.isArray(value)) lines.push(...value.map(entry => `${name}: ${entry}`));
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
const frontend = await listen(front);
const origin = `http://127.0.0.1:${frontend.port}`;
const browser = await chromium.launch({ headless: true });
let context;

try {
  const installContext = await browser.newContext({ userAgent: iphoneUserAgent() });
  await installContext.addInitScript(() => Object.defineProperty(navigator, 'standalone', { configurable: true, value: false }));
  const installPage = await installContext.newPage();
  await installPage.goto(origin + BASE_PATH);
  await installPage.getByRole('heading', { name: /先把工作台/ }).waitFor();
  assert.equal(await installPage.locator('#pair-code').count(), 0, 'Safari tab must install before pairing');
  assert.match(await installPage.locator('#app').innerText(), /添加到主屏幕/);
  await installContext.close();

  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3 });
  await context.grantPermissions(['notifications'], { origin });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    window.__sentFrames = [];
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(JSON.parse(String(data))); } catch { /* ignore non-JSON frames */ }
      return nativeSend.call(this, data);
    };
    window.__permissionChoice = 'granted';
    window.__fakePushSubscription = null;
    class FakeNotification {
      static permission = 'default';
      static async requestPermission() { this.permission = window.__permissionChoice; return this.permission; }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
      configurable: true,
      get() {
        return {
          getSubscription: async () => window.__fakePushSubscription,
          subscribe: async () => {
            window.__fakePushSubscription ??= {
              endpoint: 'https://web.push.apple.com/pwa-fixture-token',
              expirationTime: null,
              keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) },
              toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: this.keys }; },
              async unsubscribe() { window.__fakePushSubscription = null; return true; },
            };
            return window.__fakePushSubscription;
          },
        };
      },
    });
  });
  const page = await context.newPage();
  const outgoing = [];
  page.on('console', message => { if (message.type() === 'error') console.error('[browser]', message.text()); });
  page.on('pageerror', error => console.error('[browser-error]', error.message));
  page.on('websocket', socket => socket.on('framesent', payload => {
    try { outgoing.push(JSON.parse(String(payload))); } catch { /* ignore non-JSON frames */ }
  }));
  await page.goto(origin + BASE_PATH);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  const connectPolicy = policy.split(';').find(directive => directive.trim().startsWith('connect-src'));
  assert.match(connectPolicy, /wss:\/\/117\.72\.10\.87/);
  assert.doesNotMatch(connectPolicy, /(?:^|\s)wss?:(?:\s|$)/);
  await page.getByRole('heading', { name: /把这部手机/ }).waitFor();
  await page.locator('#pair-code').fill(replacementPair.code);
  await page.getByRole('button', { name: /申请配对/ }).click();
  await page.getByText(/已经绑定了另一部手机/).waitFor();

  await api('/api/access/unbind-phone', {}, pc.token);
  replacementPair = await api('/api/access/pair-open', {}, pc.token);
  await page.locator('#pair-code').fill(replacementPair.code);
  await page.getByRole('button', { name: /申请配对/ }).click();
  await page.waitForTimeout(500);
  if (!(await page.locator('#app').innerText()).includes('等待电脑批准')) throw new Error(`Pair retry did not start: ${(await page.locator('#app').innerText()).slice(0, 900)}`);
  await page.getByText(/等待电脑批准/).waitFor();
  const pending = await api('/api/access/pair-status', { pairId: replacementPair.pairId }, pc.token);
  assert.ok(pending.pending?.requestId, 'phone request should wait for explicit PC approval');
  await api('/api/access/pair-confirm', { pairId: replacementPair.pairId, requestId: pending.pending.requestId, allow: true }, pc.token);
  await page.getByRole('heading', { name: /工作还在继续/ }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'DSH' }).click();
  await page.getByText(/DSH 当前不可用/).waitFor();
  await page.getByRole('button', { name: 'Codex' }).click();
  await page.getByText(/Codex 当前不可用/).waitFor();
  await page.getByRole('button', { name: '模拟后端' }).click();
  await page.getByText('还没有工作区', { exact: true }).waitFor();

  await page.getByRole('button', { name: /添加工作区/ }).click();
  await page.getByLabel('当前路径').waitFor();
  await page.getByLabel('当前路径').fill('C:\\Projects\\Demo');
  await page.getByRole('button', { name: '登记此路径' }).click();
  await page.getByText('Demo', { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /在这里新建会话/ }).click();
  await page.getByLabel(/发送文字请求/).waitFor();
  await page.locator('details.settings-panel').locator('summary').click();
  await page.locator('#model-select').selectOption({ label: 'Mock Reasoner · high' });
  await page.getByText('模型设置已同步到电脑').waitFor();

  await page.evaluate(() => { window.__permissionChoice = 'denied'; });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('button', { name: '开启通知' }).click();
  await page.locator('#app .notice[role="status"]').waitFor();
  assert.match(await page.locator('#app .notice[role="status"]').innerText(), /通知权限已关闭/);
  assert.ok(await page.getByRole('heading', { name: /工作还在继续/ }).count(), 'permission denial must not block session use');
  await page.evaluate(() => { window.__permissionChoice = 'granted'; Notification.permission = 'default'; });
  await page.getByRole('button', { name: '开启通知' }).click();
  await page.locator('#app .notice.success').waitFor({ timeout: 10000 });

  await page.getByRole('button', { name: /在这里新建会话/ }).click();
  await page.getByLabel(/发送文字请求/).waitFor();
  await page.locator('#message-input').fill('敏感内容 DO-NOT-PUSH');
  await page.getByRole('button', { name: '发送请求' }).click();
  await page.getByRole('heading', { name: /等待批准/ }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '允许一次' }).click();
  await page.getByText('任务完成！').waitFor({ timeout: 10000 });
  await page.locator('#message-input').fill('[ask]');
  await page.getByRole('button', { name: '发送请求' }).click();
  await page.getByRole('heading', { name: /需要你的回答/ }).waitFor({ timeout: 10000 });
  await page.getByLabel(/快速/).check();
  await page.getByRole('button', { name: '提交回答' }).click();
  await page.getByText(/已收到你的选择/).waitFor({ timeout: 10000 });

  await waitUntil(() => delivery.some(item => JSON.parse(item.payload).category === 'approval') && delivery.some(item => JSON.parse(item.payload).category === 'completed'));
  const categories = delivery.map(item => {
    const payload = JSON.parse(item.payload);
    assert.deepEqual(Object.keys(payload), ['category']);
    assert.equal(item.payload.includes('DO-NOT-PUSH'), false);
    return payload.category;
  });
  assert.ok(categories.includes('approval'));
  assert.ok(categories.includes('completed'));
  assert.ok(categories.includes('question'));

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  const serviceWorker = context.serviceWorkers().find(worker => worker.url().endsWith('/sw.js'));
  assert.ok(serviceWorker, 'PWA service worker must control the installed app');
  const notification = await serviceWorker.evaluate(async () => {
    const shown = [];
    Object.defineProperty(self.registration, 'showNotification', { configurable: true, value: async (title, options) => shown.push({ title, body: options.body, data: options.data }) });
    Object.defineProperty(self.registration, 'getNotifications', { configurable: true, value: async () => shown });
    const waits = [];
    const event = new Event('push');
    Object.defineProperty(event, 'data', { value: { json: () => ({ category: 'approval' }) } });
    event.waitUntil = promise => waits.push(promise);
    self.dispatchEvent(event);
    await Promise.all(waits);
    const items = await self.registration.getNotifications();
    return items.map(item => ({ title: item.title, body: item.body, data: item.data }));
  });
  assert.equal(notification[0]?.title, 'Batona Link');
  assert.match(notification[0]?.body ?? '', /等待你的批准/);
  assert.equal(JSON.stringify(notification).includes('DO-NOT-PUSH'), false);
  const refreshCount = await page.evaluate(() => window.__sentFrames.filter(frame => frame.method === 'session.list').length);
  const clientsFound = await serviceWorker.evaluate(async () => {
    const actualClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    Object.defineProperty(self.clients, 'matchAll', { configurable: true, value: async () => actualClients.map(client => ({
      url: client.url,
      focus: async () => {},
      postMessage: message => client.postMessage(message),
    })) });
    const waits = [];
    const notification = { data: { url: new URL('./', self.location).href }, close() {} };
    const event = new Event('notificationclick');
    Object.defineProperty(event, 'notification', { value: notification });
    event.waitUntil = promise => waits.push(promise);
    self.dispatchEvent(event);
    await Promise.all(waits);
    return actualClients.map(client => client.url);
  });
  assert.ok(clientsFound.some(url => url.startsWith(origin + BASE_PATH)), 'notification click should target the installed PWA client');
  await page.waitForFunction(count => window.__sentFrames.filter(frame => frame.method === 'session.list').length > count, refreshCount);

  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: /处于离线状态/ }).waitFor();
  assert.equal(await page.locator('#message-input').count(), 0, 'offline shell must not show cached session controls');
  assert.match(await page.locator('#app').innerText(), /只缓存应用界面/);
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('heading', { name: /工作还在继续/ }).waitFor({ timeout: 15000 });

  await page.locator('details.settings-panel').locator('summary').click();
  await page.getByRole('button', { name: '退出此手机' }).click();
  await page.getByRole('heading', { name: '退出这部手机？' }).waitFor();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('heading', { name: /把这部手机/ }).waitFor();

  const nextPair = await api('/api/access/pair-open', {}, pc.token);
  const clearedPushState = page.waitForResponse(response => response.url().endsWith('/api/access/push-key') && response.request().method() === 'POST');
  await page.locator('#pair-code').fill(nextPair.code);
  await page.getByRole('button', { name: /申请配对/ }).click();
  await page.getByText(/等待电脑批准/).waitFor();
  const nextPending = await api('/api/access/pair-status', { pairId: nextPair.pairId }, pc.token);
  await api('/api/access/pair-confirm', { pairId: nextPair.pairId, requestId: nextPending.pending.requestId, allow: true }, pc.token);
  await page.getByRole('heading', { name: /工作还在继续/ }).waitFor({ timeout: 15000 });
  const pushStateResponse = await clearedPushState;
  assert.equal((await pushStateResponse.json()).subscribed, false, 'sign-out must clear the server push subscription');

  console.log('PASS PWA browser E2E: install gate, occupied phone slot, PC-approved pairing, backend separation, workspace/session actions, permission recovery, generic push, notification click refresh, shell-only offline, sign-out cleanup');
} finally {
  await context?.close();
  await browser.close();
  tunnel.stop();
  for (const server of [front, directoryServer]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await gateway.close();
  rmSync(TEMP, { recursive: true, force: true });
}

async function api(path, body = {}, token = '') {
  const response = await fetch(`http://127.0.0.1:${gateways.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`${path} failed (${response.status}): ${result.error}`);
  return result;
}

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address;
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for browser fixture state');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function iphoneUserAgent() {
  return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
}
