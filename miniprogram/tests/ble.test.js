const test = require('node:test');
const assert = require('node:assert/strict');
const { BleClient } = require('../utils/ble');
const { buildCommand } = require('../utils/protocol');
const { createFakeWx, SERVICE, CHARACTERISTIC } = require('./fake-wx');

function fixture(t, overrides = {}) {
  const api = createFakeWx();
  const records = [];
  const client = new BleClient(api, { onReady: device => records.push(device) }, {
    apiTimeoutMs: 100, connectTimeoutMs: 100, writeTimeoutMs: 30, scanDurationMs: 100000, ...overrides
  });
  client.activate();
  t.after(() => client.destroy());
  return { api, client, records };
}

async function discover(f) {
  assert.equal(await f.client.scan(), true);
  f.api.emitFound([
    { deviceId: 'vehicle-A', name: 'NIU link A', RSSI: -45 },
    { deviceId: 'vehicle-B', localName: 'NIU link B' }
  ]);
}

async function connected(t, overrides) {
  const f = fixture(t, overrides);
  await discover(f);
  assert.equal(await f.client.connect('vehicle-A'), true);
  assert.equal(f.client.state.ready, true);
  return f;
}

test('scan uses names without service filtering; merges IDs and preserves same-name vehicles', async t => {
  const f = fixture(t);
  await discover(f);
  f.api.emitFound([
    { deviceId: 'vehicle-A', name: 'NIU link A', RSSI: -30 },
    { deviceId: 'same-name', name: 'NIU link A' },
    { deviceId: 'unrelated', name: 'Headphones' },
    { deviceId: 'lowercase', localName: 'niu link C' }
  ]);
  assert.equal(f.client.state.devices.length, 4);
  assert.equal(f.client.state.devices[0].RSSI, -30);
  assert.equal(f.client.state.devices.filter(device => device.name === 'NIU link A').length, 2);
  const request = f.api.calls.find(call => call.name === 'startBluetoothDevicesDiscovery');
  assert.equal(request.services, undefined);
  assert.equal(await f.client.stopScan(), true);
  f.api.emitFound([{ deviceId: 'late', name: 'NIU link late' }]);
  assert.equal(f.client.state.devices.length, 4);
});

test('discovers services and characteristics before writing exactly the previewed 20 bytes', async t => {
  const f = await connected(t);
  assert.equal(f.records.length, 1);
  const command = buildCommand('03', '08');
  assert.equal(await f.client.send(command), true);
  const write = f.api.calls.find(call => call.name === 'writeBLECharacteristicValue');
  assert.equal(write.deviceId, 'vehicle-A');
  assert.equal(write.serviceId, SERVICE);
  assert.equal(write.characteristicId, CHARACTERISTIC);
  assert.equal(write.writeType, 'writeNoResponse');
  assert.deepEqual(Array.from(new Uint8Array(write.value)), command.hex.split(' ').map(byte => parseInt(byte, 16)));
  const names = f.api.calls.map(call => call.name);
  assert(names.indexOf('getBLEDeviceCharacteristics') < names.indexOf('writeBLECharacteristicValue'));
  assert.match(f.client.state.status, /仪表确认/);
});

test('multiple writable characteristics need explicit choice; changing mode changes the actual write', async t => {
  const f = fixture(t);
  f.api.characteristics[SERVICE].push({ uuid: 'second-command', properties: { write: true, writeDefault: true } });
  await discover(f);
  assert.equal(await f.client.connect('vehicle-A'), true);
  assert.equal(f.client.state.ready, false);
  assert.equal(f.records.length, 0);
  f.client.chooseChannel(1);
  assert.equal(f.client.state.writeType, 'write');
  assert.equal(f.records.length, 1);
  await f.client.send(buildCommand('05', '0C'));
  assert.equal(f.api.calls.find(call => call.name === 'writeBLECharacteristicValue').characteristicId, 'second-command');
});

test('a channel with unknown write capabilities requires an explicit mode', async t => {
  const f = fixture(t);
  f.api.characteristics[SERVICE][0].properties = { write: true };
  await discover(f);
  await f.client.connect('vehicle-A');
  assert.equal(f.client.state.channelIndex, 0);
  assert.equal(f.client.state.ready, false);
  f.client.chooseWriteType('write');
  assert.equal(f.client.state.ready, true);
  await f.client.send(buildCommand('02', '01'));
  assert.equal(f.api.calls.find(call => call.name === 'writeBLECharacteristicValue').writeType, 'write');
});

test('a writable service outside the configured candidates requires manual selection', async t => {
  const f = fixture(t);
  f.api.services = [{ uuid: 'custom-service' }];
  f.api.characteristics['custom-service'] = [{ uuid: 'custom-characteristic', properties: { writeDefault: true } }];
  await discover(f);
  await f.client.connect('vehicle-A');
  assert.equal(f.client.state.ready, false);
  f.client.chooseChannel(0);
  assert.equal(f.client.state.ready, true);
});

test('switches devices after closing the old connection and ignores old disconnect events', async t => {
  const f = await connected(t);
  await f.client.connect('vehicle-B');
  assert.equal(f.api.connections.has('vehicle-A'), false);
  assert.equal(f.client.state.device.deviceId, 'vehicle-B');
  assert.equal(f.client.state.ready, true);
  f.api.emitDisconnect('vehicle-A');
  assert.equal(f.client.state.ready, true);
  await f.client.send(buildCommand('05', '0C'));
  assert.equal(f.api.calls.find(call => call.name === 'writeBLECharacteristicValue').deviceId, 'vehicle-B');
});

test('disconnect immediately disables writes; reconnect enumerates services again', async t => {
  const f = await connected(t);
  f.api.emitDisconnect('vehicle-A');
  assert.equal(f.client.state.ready, false);
  assert.equal(await f.client.send(buildCommand('05', '0C')), false);
  assert.equal(f.api.calls.filter(call => call.name === 'writeBLECharacteristicValue').length, 0);
  await f.client.connect('vehicle-A');
  assert.equal(f.api.calls.filter(call => call.name === 'getBLEDeviceServices').length, 2);
  assert.equal(f.client.state.ready, true);
});

test('write lock prevents duplicate writes and configuration changes during a pending send', async t => {
  const f = await connected(t);
  let finish;
  let writes = 0;
  f.api.writeBLECharacteristicValue = options => { finish = options.success; writes += 1; };
  const pending = f.client.send(buildCommand('05', '0C'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.client.state.sending, true);
  assert.equal(await f.client.send(buildCommand('02', '01')), false);
  assert.equal(await f.client.connect('vehicle-B'), false);
  f.client.chooseWriteType('write');
  assert.equal(f.client.state.writeType, 'writeNoResponse');
  finish({});
  assert.equal(await pending, true);
  assert.equal(writes, 1);
  assert.equal(f.client.state.busy, false);
});

test('write timeout closes the connection, reports unknown outcome and never retries', async t => {
  const f = await connected(t, { writeTimeoutMs: 10 });
  let writes = 0;
  let lateCallback;
  f.api.writeBLECharacteristicValue = options => { writes += 1; lateCallback = options.success; };
  assert.equal(await f.client.send(buildCommand('05', '0C')), false);
  assert.match(f.client.state.status, /结果未知/);
  assert.equal(f.client.state.ready, false);
  assert.equal(f.api.connections.size, 0);
  lateCallback({});
  assert.match(f.client.state.status, /结果未知/);
  assert.equal(writes, 1);
});

test('a disconnect during writing cannot be overwritten by a late success', async t => {
  const f = await connected(t);
  let finish;
  f.api.writeBLECharacteristicValue = options => { finish = options.success; };
  const pending = f.client.send(buildCommand('05', '0C'));
  await Promise.resolve();
  await Promise.resolve();
  f.api.emitDisconnect('vehicle-A');
  finish({});
  await pending;
  assert.equal(f.client.state.ready, false);
  assert.match(f.client.state.status, /已断开/);
});

test('privacy denial and missing writable channels recover controls and do not record history', async t => {
  const f = fixture(t);
  const original = f.api.requirePrivacyAuthorize;
  f.api.requirePrivacyAuthorize = options => options.fail({ errMsg: 'requirePrivacyAuthorize:fail privacy denied' });
  assert.equal(await f.client.scan(), false);
  assert.match(f.client.state.status, /授权/);
  assert.equal(f.client.state.busy, false);
  f.api.requirePrivacyAuthorize = original;
  await discover(f);
  f.api.characteristics[SERVICE] = [];
  assert.equal(await f.client.connect('vehicle-A'), false);
  assert.match(f.client.state.status, /没有找到可写/);
  assert.equal(f.records.length, 0);
  assert.equal(f.api.connections.size, 0);
});

test('hiding during connection waits for late completion and releases the native connection', async t => {
  const f = fixture(t);
  await discover(f);
  let finish;
  f.api.createBLEConnection = options => { finish = () => { f.api.connections.add(options.deviceId); options.success({}); }; };
  const pending = f.client.connect('vehicle-A');
  while (!finish) await Promise.resolve();
  const closing = f.client.suspend();
  f.client.activate();
  assert.equal(await f.client.scan(), false);
  finish();
  await pending;
  await closing;
  assert.equal(f.api.connections.size, 0);
  assert.equal(f.client.state.ready, false);
  assert.equal(f.records.length, 0);
  assert.equal(f.client.state.busy, false);
  await f.client.scan();
  assert.equal(f.client.state.scanning, true);
});

test('scan timeout stops discovery and destruction unregisters all callbacks', async t => {
  const f = fixture(t, { scanDurationMs: 10 });
  await f.client.scan();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.client.state.scanning, false);
  assert.equal(f.api.listenerCount(), 3);
  await f.client.destroy();
  assert.equal(f.api.listenerCount(), 0);
});

test('a failed close cannot leave sending enabled or start a connection to a second vehicle', async t => {
  const f = await connected(t);
  f.api.closeBLEConnection = options => options.fail({ errCode: 10008 });
  assert.equal(await f.client.connect('vehicle-B'), false);
  assert.equal(f.client.state.ready, false);
  assert.match(f.client.state.status, /无法释放/);
  assert.equal(f.api.calls.filter(call => call.name === 'createBLEConnection').length, 1);
});

test('leaving during a write keeps an unknown outcome and requires reinitialization on reconnect', async t => {
  const f = await connected(t);
  let finish;
  f.api.writeBLECharacteristicValue = options => { finish = options.success; };
  const pending = f.client.send(buildCommand('05', '0C'));
  while (!finish) await Promise.resolve();
  const closing = f.client.suspend();
  finish({});
  await pending;
  await closing;
  assert.equal(f.api.adapterOpen, false);
  assert.match(f.client.state.status, /结果未知/);
  f.client.activate();
  assert.equal(await f.client.connect('vehicle-A'), true);
  assert.equal(f.api.adapterOpen, true);
  assert.equal(f.client.state.ready, true);
});
