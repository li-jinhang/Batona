'use strict';

const http = require('node:http');

/**
 * 仅绑定回环地址的目录浏览服务。
 *
 * listen() 的 EADDRINUSE 是异步 error 事件，不能靠调用点的 try/catch 捕获。
 * 因此 start() 始终兑现布尔结果：端口冲突时返回 false 并保留可诊断日志，绝不让
 * Electron 主进程因为未监听的 error 事件崩溃。
 */
class DirectoryService {
  constructor({ host = '127.0.0.1', port = 3081, listDir, log = () => {} }) {
    this.host = host;
    this.port = port;
    this.listDir = listDir;
    this.log = log;
    this.server = null;
    this.starting = null;
  }

  start() {
    if (this.server) return this.starting || Promise.resolve(true);

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/list') {
          const data = this.listDir(url.searchParams.get('p') || '');
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: true, ...data }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });

    this.server = server;
    this.starting = new Promise((resolve) => {
      const failStart = (error) => {
        if (this.server === server) this.server = null;
        this.starting = null;
        this.log(`目录服务启动失败（${this.host}:${this.port}）：${error.message}`);
        resolve(false);
      };

      server.once('error', failStart);
      server.listen(this.port, this.host, () => {
        server.off('error', failStart);
        server.on('error', (error) => this.log(`目录服务运行异常：${error.message}`));
        this.starting = null;
        this.log(`目录服务就绪 http://${this.host}:${this.port}`);
        resolve(true);
      });
    });
    return this.starting;
  }

  stop() {
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }
}

module.exports = { DirectoryService };
