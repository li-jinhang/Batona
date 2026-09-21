/**
 * TunnelClient lifecycle regressions.
 *
 * Run: node product/pc/test/tunnel-client.test.js
 */

'use strict';

const net = require('node:net');
const { TunnelClient } = require('../tunnel/client.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

async function stopDuringTlsHandshakeDoesNotCrash() {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address();
  const socketAccepted = new Promise((resolve) => server.once('connection', resolve));
  const client = new TunnelClient({
    host: '127.0.0.1',
    gwPort: port,
    token: 'test-token',
    services: () => [],
    tls: true,
  });

  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.once('uncaughtException', onUncaught);

  client.start();
  await socketAccepted;
  client.stop();
  await delay(100);
  process.removeListener('uncaughtException', onUncaught);
  await close(server);

  if (uncaught) throw uncaught;
}

stopDuringTlsHandshakeDoesNotCrash()
  .then(() => console.log('✔ stop during TLS handshake does not crash the process'))
  .catch((error) => {
    console.error(`✘ stop during TLS handshake: ${error.message}`);
    process.exitCode = 1;
  });
