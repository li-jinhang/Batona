const DATABASE = 'batona-ios-pwa';
const STORE = 'credentials';
const KEY = 'phone';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function transact(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let request;
      try { request = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error ?? new Error('Credential storage failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Credential storage was interrupted'));
    });
  } finally { db.close(); }
}

export const credentialStore = {
  read: () => transact('readonly', store => store.get(KEY)),
  write: value => transact('readwrite', store => store.put(value, KEY)),
  clearAuthorization: async () => {
    const current = await credentialStore.read();
    if (current?.deviceSecret) return credentialStore.write({ deviceSecret: current.deviceSecret });
    return transact('readwrite', store => store.delete(KEY));
  },
};
