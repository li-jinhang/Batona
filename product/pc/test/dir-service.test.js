'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { DirectoryService } = require('../dir-service.js');

function reserveLoopbackPort() {
  const server = http.createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function testPortConflictDoesNotCrash() {
  const owner = await reserveLoopbackPort();
  const port = owner.address().port;
  const logs = [];
  const service = new DirectoryService({ port, listDir: () => ({ path: '', roots: [] }), log: (line) => logs.push(line) });
  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.once('uncaughtException', onUncaught);
  try {
    assert.equal(await service.start(), false, '端口被占用时启动应失败，而非假装成功');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(uncaught, null, 'EADDRINUSE 不得成为未捕获异常');
    assert.match(logs.join('\n'), /EADDRINUSE/);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    await service.stop();
    await new Promise((resolve) => owner.close(resolve));
  }
}

async function testConcurrentStartsReuseOneServer() {
  const service = new DirectoryService({ port: 0, listDir: () => ({ path: '', roots: [] }) });
  try {
    const [first, second] = await Promise.all([service.start(), service.start()]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.ok(service.server?.listening, '并发启动应复用同一个监听服务');
  } finally {
    await service.stop();
  }
}

(async () => {
  await testPortConflictDoesNotCrash();
  console.log('✔ 端口冲突不会令主进程崩溃');
  await testConcurrentStartsReuseOneServer();
  console.log('✔ 并发启动只创建一个目录服务');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
