const test = require('node:test');
const assert = require('node:assert/strict');
const { VOLTAGES, CAPACITIES, buildCommand } = require('../utils/protocol');
const { HISTORY_KEY, loadHistory, saveHistory, clearHistory, formatTime } = require('../utils/history');
const { createFakeWx } = require('./fake-wx');

test('all 24 configurations preserve the vehicle packet and HEX preview', () => {
  const prefix = [0x67, 0x84, 0x85, 0x59, 0x11, 0x12, 0x76, 0x99,
    0x61, 0x22, 0x92, 0x43, 0x23, 0x54, 0x45, 0x39, 0x87];
  assert.deepEqual(VOLTAGES.map(item => item.code), ['02', '03', '05']);
  assert.deepEqual(CAPACITIES.map(item => item.code), ['01', '02', '03', '05', '06', '08', '0C', '07']);
  for (const voltage of VOLTAGES) {
    for (const capacity of CAPACITIES) {
      const command = buildCommand(voltage.code, capacity.code);
      const expected = [...prefix, parseInt(voltage.code, 16), parseInt(capacity.code, 16), 0x26];
      assert.deepEqual(Array.from(new Uint8Array(command.value)), expected);
      assert.equal(command.hex, expected.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '));
      assert.equal(command.summary, `${voltage.label} / ${capacity.label}`);
    }
  }
  assert.throws(() => buildCommand('FF', '0C'));
  assert.throws(() => buildCommand('05', 'NaN'));
});

test('history persists across loads; only its own key is cleared', () => {
  const api = createFakeWx();
  assert.equal(loadHistory(api).record, null);
  const saved = saveHistory(api, { name: 'NIU link A', deviceId: 'vehicle-id' });
  assert.equal(saved.error, '');
  assert.deepEqual(loadHistory(api).record, saved.record);
  assert.match(formatTime(saved.record.connectedAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  api.storage.set('other-page', 'keep');
  assert.equal(clearHistory(api), '');
  assert.equal(api.storage.has(HISTORY_KEY), false);
  assert.equal(api.storage.get('other-page'), 'keep');
  api.storage.set(HISTORY_KEY, 'corrupt');
  assert.equal(loadHistory(api).record, null);
  assert.equal(formatTime('bad-date'), '时间未记录');
});

test('blocked storage reports a message without throwing', () => {
  const api = createFakeWx();
  for (const name of ['getStorageSync', 'setStorageSync', 'removeStorageSync']) {
    api[name] = () => { throw new Error('Storage blocked'); };
  }
  assert.match(loadHistory(api).error, /无法读取/);
  const saved = saveHistory(api, { name: 'NIU link A', deviceId: 'A' });
  assert.equal(saved.record.name, 'NIU link A');
  assert.match(saved.error, /无法保存/);
  assert.match(clearHistory(api), /失败/);
});
