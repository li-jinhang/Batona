export const PRODUCT_BACKENDS = ['dsh', 'codex'];

export function backendIdAllowed(id, includeTestBackend = false) {
  return PRODUCT_BACKENDS.includes(id) || (includeTestBackend && id === 'mock');
}

export function visibleBackendIds(adapters, includeTestBackend = false) {
  const advertised = new Set(Array.isArray(adapters) ? adapters.map(adapter => adapter?.id) : []);
  return [
    ...PRODUCT_BACKENDS.filter(id => advertised.has(id)),
    ...(includeTestBackend && advertised.has('mock') ? ['mock'] : []),
  ];
}
