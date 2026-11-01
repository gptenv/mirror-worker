export function initializeWorkerStore() {
  globalThis.__testInitialized = (globalThis.__testInitialized || 0) + 1;
}
export function getOrCreateDeviceId() { return 'fixture-device'; }
