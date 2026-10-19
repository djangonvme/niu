const SERVICE = '0000FFE0-0000-1000-8000-00805F9B34FB';
const CHARACTERISTIC = '0000FFE1-0000-1000-8000-00805F9B34FB';

function createFakeWx() {
  const events = { found: new Set(), connection: new Set(), adapter: new Set() };
  const api = {
    calls: [], storage: new Map(), connections: new Set(), adapterOpen: false,
    services: [{ uuid: SERVICE, isPrimary: true }],
    characteristics: { [SERVICE]: [{ uuid: CHARACTERISTIC, properties: { write: true, writeNoResponse: true, writeDefault: false } }] },
    emitFound(devices) { events.found.forEach(listener => listener({ devices })); },
    emitDisconnect(deviceId) { api.connections.delete(deviceId); events.connection.forEach(listener => listener({ deviceId, connected: false })); },
    emitAdapter(available) { events.adapter.forEach(listener => listener({ available })); },
    listenerCount() { return Object.values(events).reduce((sum, listeners) => sum + listeners.size, 0); },
    onBluetoothDeviceFound(listener) { events.found.add(listener); },
    offBluetoothDeviceFound(listener) { events.found.delete(listener); },
    onBLEConnectionStateChange(listener) { events.connection.add(listener); },
    offBLEConnectionStateChange(listener) { events.connection.delete(listener); },
    onBluetoothAdapterStateChange(listener) { events.adapter.add(listener); },
    offBluetoothAdapterStateChange(listener) { events.adapter.delete(listener); },
    getStorageSync(key) { return api.storage.get(key); },
    setStorageSync(key, value) { api.storage.set(key, value); },
    removeStorageSync(key) { api.storage.delete(key); }
  };
  const methods = {
    requirePrivacyAuthorize: () => ({}),
    openBluetoothAdapter: () => { api.adapterOpen = true; return {}; },
    startBluetoothDevicesDiscovery: () => {
      if (!api.adapterOpen) throw { errCode: 10000 };
      return {};
    },
    stopBluetoothDevicesDiscovery: () => ({}),
    createBLEConnection: options => {
      if (!api.adapterOpen) throw { errCode: 10000 };
      api.connections.add(options.deviceId); return {};
    },
    closeBLEConnection: options => { if (api.connections.has(options.deviceId)) api.emitDisconnect(options.deviceId); return {}; },
    closeBluetoothAdapter: () => { api.adapterOpen = false; [...api.connections].forEach(id => api.emitDisconnect(id)); return {}; },
    getBLEDeviceServices: () => ({ services: api.services }),
    getBLEDeviceCharacteristics: options => ({ characteristics: api.characteristics[options.serviceId] || [] }),
    writeBLECharacteristicValue: () => ({}),
    openSetting: () => ({}),
    openAppAuthorizeSetting: () => ({}),
    openPrivacyContract: () => ({})
  };
  for (const [name, handler] of Object.entries(methods)) {
    api[name] = options => {
      api.calls.push({ name, ...options });
      try { options.success(handler(options)); } catch (error) { options.fail(error); }
    };
  }
  return api;
}

module.exports = { createFakeWx, SERVICE, CHARACTERISTIC };
