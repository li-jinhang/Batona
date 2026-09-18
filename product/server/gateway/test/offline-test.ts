/**
 * test/offline-test.ts — 后端离线健壮性测试
 * 网关在 DSH 后端不可达（ECONNREFUSED）时必须保持运行并自动重连，绝不崩溃。
 * 运行：node test/offline-test.ts
 */

import { DshRemoteMux } from '../src/adapter/dsh/streams.ts';

let reconnects = 0;
let crashed = false;
process.on('uncaughtException', () => { crashed = true; });

// 9 端口无服务，必现 ECONNREFUSED（HTTP 与 WS 均不可达）
const mux = new DshRemoteMux(
  'http://127.0.0.1:9',
  { getCookie: () => null, onUnauthorized: async () => {} },
  {
    onStateChange: (s) => {
      console.log(`[offline-test] state: ${s}`);
      if (s === 'reconnecting') reconnects++;
    },
  },
);

mux.start();
// 注册一条逻辑流：离线时 open 只入队，重连后才会真正下发
mux.open('workspace/follow', {}, { name: 'workspace/follow', onItem: () => {} });

const stop = setInterval(() => {
  if (reconnects > 0) {
    clearInterval(stop);
    void mux.stop().then(() => {
      if (!crashed) {
        console.log('[offline-test] PASS: 后端离线不崩溃，自动重连');
        process.exit(0);
      } else {
        console.log('[offline-test] FAIL: 进程崩溃');
        process.exit(1);
      }
    });
  }
}, 200);
// 观察窗口：断开后应至少看到一次 reconnecting 状态
setTimeout(() => {
  if (reconnects === 0) {
    void mux.stop().then(() => {
      console.log('[offline-test] FAIL: 未观察到重连');
      process.exit(1);
    });
  }
}, 20000);
