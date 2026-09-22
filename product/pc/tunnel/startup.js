'use strict';
/** Initial UI deadline is not the lifetime of the reconnecting tunnel client. */
function awaitInitialConnection(client, timeoutMs = 12000) {
  return new Promise(resolve => {
    const done = value => {
      clearTimeout(timer);
      client.off('connected', connected);client.off('fatal', fatal);client.off('superseded', superseded);
      resolve(value);
    };
    const connected = () => done({ok:true});
    const fatal = info => done({ok:false,reason:info.message,code:info.code});
    const superseded = () => done({ok:false,reason:'superseded'});
    const timer = setTimeout(() => done({ok:false,reason:'handshake-timeout; reconnecting'}), timeoutMs);
    client.once('connected', connected);client.once('fatal', fatal);client.once('superseded', superseded);
  });
}
module.exports = {awaitInitialConnection};
