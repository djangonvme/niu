const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createFakeWx } = require('./fake-wx');
const { HISTORY_KEY } = require('../utils/history');

function createPage(api) {
  const filename = path.resolve(__dirname, '../pages/index/index.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value; }, wx: api, require: createRequire(filename)
  }, { filename });
  const page = { ...definition, data: structuredClone(definition.data), setData(change) { Object.assign(this.data, change); } };
  page.onLoad();
  page.onShow();
  return page;
}

test('page shows history, selected name, live command preview and the actual send result', async t => {
  const api = createFakeWx();
  api.storage.set(HISTORY_KEY, { name: 'NIU 上次车辆', deviceId: 'old-id', connectedAt: '2026-10-19T03:00:00.000Z' });
  const page = createPage(api);
  t.after(async () => { page.onUnload(); await page._client._closing; });
  assert.equal(page.data.lastDeviceName, 'NIU 上次车辆');
  assert.equal(page.data.canSend, false);
  assert.match(page.data.commandHex, /87 05 0C 26$/);
  page.onVoltageChange({ detail: { value: '0' } });
  page.onCapacityChange({ detail: { value: '7' } });
  assert.match(page.data.commandHex, /87 02 07 26$/);
  page.onScanTap();
  await page._client._work;
  api.emitFound([{ deviceId: 'vehicle-A', name: 'NIU link A' }]);
  page.onDeviceChange({ detail: { value: '0' } });
  await page._client._work;
  assert.equal(page.data.selectedDeviceName, 'NIU link A');
  assert.equal(page.data.lastDeviceName, 'NIU link A');
  assert.equal(page.data.canSend, true);
  page.onSendTap();
  page.onVoltageChange({ detail: { value: '2' } });
  assert.equal(page.data.voltageIndex, 0);
  await page._client._work;
  const write = api.calls.find(call => call.name === 'writeBLECharacteristicValue');
  assert.equal(new Uint8Array(write.value)[17], 0x02);
  assert.equal(new Uint8Array(write.value)[18], 0x07);
  assert.match(page.data.status, /仪表确认/);
  page.onHide();
  assert.equal(page.data.canSend, false);
  await page._client._closing;
  page.onShow();
  assert.equal(page.data.canSend, false);
  page.onReconnectTap();
  await page._client._work;
  assert.equal(page.data.canSend, true);
  await page.onClearHistoryTap();
  assert.equal(page.data.lastDeviceName, '暂无记录');
  assert.equal(page.data.selectedDeviceName, '尚未选择');
  assert.equal(page.data.canSend, false);
});

test('page binds all WXML handlers and project configuration references real files', () => {
  const api = createFakeWx();
  const page = createPage(api);
  page.onUnload();
  const root = path.resolve(__dirname, '..');
  const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  for (const match of wxml.matchAll(/bind(?:tap|change)="([^"]+)"/g)) assert.equal(typeof page[match[1]], 'function');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  for (const file of app.pages) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) assert(fs.existsSync(path.join(root, `${file}.${extension}`)));
  }
  assert(wxml.indexOf('{{commandHex}}') < wxml.indexOf('bindtap="onSendTap"'));
});
