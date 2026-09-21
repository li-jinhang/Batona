/**
 * server/upgrade.ts — 全服务器唯一的 WebSocket upgrade 路由器
 *
 * 为什么必须集中：ws 库的 `WebSocketServer({ server, path })` 在 path 不匹配时
 * 会 `abortHandshake(socket, 400)` **并销毁 socket**（ws@8 源码 handleUpgrade）。
 * 同一 http server 上挂两个这样的实例时，先注册者会把后者的升级请求 400 掉，
 * 现象是"随机某个端点连不上"。因此所有 WSS 一律 `noServer: true`，
 * 由这里按 pathname 精确分发。
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeRoute {
  /** 精确匹配的路径（不做前缀匹配，避免 /ws/../tunnel 之类的歧义） */
  path: string;
  handle(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createUpgradeRouter(server: Server, routes: UpgradeRoute[]): void {
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const route = routes.find((r) => r.path === pathname);
    if (!route) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    route.handle(req, socket, head);
  });
}
