import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const output = resolve('dist');
const iconDirectory = join(output, 'icons');
mkdirSync(iconDirectory, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([tag, body])));
  return Buffer.concat([length, tag, body, checksum]);
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function makeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const lines = [[145,340,333,152], [333,152,415,152], [415,152,415,234]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / scale, py = (y + 0.5) / scale;
    let color = [38, 59, 53, 255];
    if (Math.hypot(px - 150, py - 362) < 25) color = [199, 107, 54, 255];
    else if (lines.some(([x1,y1,x2,y2]) => pointSegmentDistance(px, py, x1, y1, x2, y2) < 18)) color = [247, 243, 234, 255];
    const index = (y * size + x) * 4;
    pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = color[3];
  }
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) pixels.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) writeFileSync(join(iconDirectory, `icon-${size}.png`), makeIcon(size));

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [relative(output, absolute).split(sep).join('/')];
  });
}

const shell = walk(output).filter(file => file !== 'sw.js').sort();
shell.push('index.html');
const urls = [...new Set(shell)].map(file => `./${file}`);
urls.push('./');
const fingerprint = [...new Set(shell)].map(file => `${file}:${createHash('sha256').update(readFileSync(join(output, file))).digest('hex')}`).join('\n');
const version = createHash('sha256').update(`${urls.join('\n')}\n${fingerprint}`).digest('hex').slice(0, 12);
const worker = `const CACHE = 'batona-pwa-shell-${version}';
const PREFIX = 'batona-pwa-shell-';
const BASE_URL = new URL('./', self.location).href;
const BASE_PATH = new URL(BASE_URL).pathname;
const SHELL = ${JSON.stringify(urls)}.map(url => new URL(url, self.location).href);
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH)) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/tunnel') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(BASE_URL, copy)); }
      return response;
    }).catch(async () => (await caches.match(BASE_URL)) || (await caches.match(new URL('index.html', BASE_URL))) || Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
self.addEventListener('push', event => {
  let category;
  try { category = event.data?.json()?.category; } catch { return; }
  const copy = {
    approval: ['Batona Link', '电脑上的操作正在等待你的批准。'],
    question: ['Batona Link', '电脑上的任务有一个问题需要你回答。'],
    completed: ['Batona Link', '电脑上的一轮任务已完成。'],
    failed: ['Batona Link', '电脑上的任务遇到问题，请打开查看。'],
  }[category];
  if (!copy) return;
  event.waitUntil(self.registration.showNotification(copy[0], { body: copy[1], icon: new URL('icons/icon-192.png', BASE_URL).href, badge: new URL('icons/icon-192.png', BASE_URL).href, tag: 'batona-' + category, data: { url: BASE_URL } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (client.url.startsWith(BASE_URL) && 'focus' in client) {
      await client.focus(); client.postMessage({ type: 'refresh-authoritative-state' }); return;
    }
    const client = await self.clients.openWindow(BASE_URL);
    client?.postMessage({ type: 'refresh-authoritative-state' });
  })());
});
`;
writeFileSync(join(output, 'sw.js'), worker);
