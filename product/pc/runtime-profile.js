'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORTS = Object.freeze({ dsh: 3080, dir: 3081, codex: 3082 });
const CODEX_TEST_PORTS = Object.freeze({ dsh: 3180, dir: 3181, codex: 3182 });

function createRuntimeProfile(env = process.env) {
  const codexTest = env.BATONA_CODEX_TEST_PROFILE === '1';
  return Object.freeze({
    kind: codexTest ? 'codex-test' : 'standard',
    userDataDirectoryName: codexTest ? 'Batona PC Codex Test' : null,
    dshEnabled: !codexTest,
    ports: codexTest ? CODEX_TEST_PORTS : DEFAULT_PORTS,
  });
}

/** Must run before Electron is ready and before requestSingleInstanceLock(). */
function configureUserData(app, profile, fsImpl = fs, pathImpl = path) {
  if (!profile.userDataDirectoryName) return null;
  const userData = pathImpl.join(app.getPath('appData'), profile.userDataDirectoryName);
  fsImpl.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  return userData;
}

function getTunnelServices(profile, dshPort) {
  return [
    ...(profile.dshEnabled ? [{ name: 'dsh', localPort: dshPort || profile.ports.dsh }] : []),
    { name: 'dir', localPort: profile.ports.dir },
    { name: 'codex', localPort: profile.ports.codex },
  ];
}

module.exports = { createRuntimeProfile, configureUserData, getTunnelServices };
