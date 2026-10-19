const defaults = require('./config');

function sameUUID(a, b) {
  return String(a).toUpperCase() === String(b).toUpperCase();
}

function shortUUID(uuid) {
  return String(uuid).replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i, '$1');
}

function displayName(device) {
  return device.name || device.localName || `未命名蓝牙 (${device.deviceId.slice(-6)})`;
}

function writeModes(properties) {
  const modes = [];
  if (properties.writeNoResponse) modes.push('writeNoResponse');
  if (properties.writeDefault) modes.push('write');
  return modes;
}

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function describeError(error) {
  if (error.code === 'CANCELLED') return '';
  if (error.code === 'WRITE_TIMEOUT') return '发送超时，结果未知。请查看仪表确认，重新连接后再操作。';
  if (error.state === 3) return '微信没有系统蓝牙权限，请在 iPhone 设置中允许微信访问蓝牙。';
  const messages = {
    10000: '蓝牙尚未初始化，请重新扫描。',
    10001: '蓝牙不可用，请检查蓝牙开关及微信的系统蓝牙权限。',
    10002: '找不到车辆，请靠近车辆后重新扫描。',
    10003: '连接失败，请检查车辆供电以及是否被其他程序连接。',
    10004: '未找到蓝牙服务，请重新连接。',
    10005: '未找到蓝牙特征，请重新连接。',
    10006: '车辆蓝牙已断开，请重新连接。',
    10007: '车辆不支持该写入方式，请检查通道和写入方式。',
    10008: '蓝牙系统错误，请断开其他连接后重试。',
    10012: '连接超时，请靠近车辆并重新连接。'
  };
  if (messages[error.errCode]) return messages[error.errCode];
  const message = error.errMsg || error.message || '操作失败，请重试。';
  if (/privacy|authorize|auth deny|auth denied/i.test(message)) {
    return '尚未获得隐私或蓝牙授权。请同意隐私指引，并在权限设置中允许访问蓝牙。';
  }
  return message;
}

class BleClient {
  constructor(api, callbacks = {}, config = {}) {
    this.api = api;
    this.callbacks = callbacks;
    this.config = { ...defaults, ...config };
    this._active = false;
    this._disposed = false;
    this._version = 0;
    this._devices = new Map();
    this._work = null;
    this._closing = null;
    this._scanTimer = null;
    this._readyRecorded = false;
    this._closedDevices = new Set();
    this.state = {
      devices: [], device: null, channels: [], channelIndex: -1,
      writeType: '', connected: false, scanning: false,
      busy: false, sending: false, ready: false,
      status: '未连接，请扫描附近车辆。', diagnostics: []
    };
    this._onFound = result => this._found(result);
    this._onConnection = result => {
      if (!this._active || !this.state.device || this._closedDevices.has(result.deviceId) ||
          result.deviceId !== this.state.device.deviceId || result.connected) return;
      this._version += 1;
      this._readyRecorded = false;
      this._set({ connected: false, ready: false, channels: [], channelIndex: -1, writeType: '',
        status: '车辆蓝牙已断开，请重新选择车辆或扫描连接。' });
    };
    this._onAdapter = result => {
      if (!result.available && this._active) {
        this._version += 1;
        this._clearScanTimer();
        this._set({ connected: false, ready: false, scanning: false, channels: [],
          channelIndex: -1, writeType: '', status: '蓝牙不可用，请检查蓝牙开关和权限后重新扫描。' });
      }
    };
    for (const [name, listener] of [
      ['onBluetoothDeviceFound', this._onFound],
      ['onBLEConnectionStateChange', this._onConnection],
      ['onBluetoothAdapterStateChange', this._onAdapter]
    ]) {
      if (typeof api[name] === 'function') api[name](listener);
    }
  }

  _set(change) {
    Object.assign(this.state, change);
    if (!this._disposed && this.callbacks.onChange) this.callbacks.onChange({ ...this.state });
  }

  activate() {
    if (this._disposed) return;
    this._active = true;
    this._set({});
  }

  _ensure(version) {
    if (!this._active || this._disposed || version !== this._version) {
      throw failure('操作已取消', 'CANCELLED');
    }
  }

  _call(name, options = {}, timeoutMs = this.config.apiTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof this.api[name] !== 'function') {
        reject(failure('当前微信不支持所需接口，请升级微信并使用较新的小程序基础库。', 'UNSUPPORTED'));
        return;
      }
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        settled = true;
        timedOut = true;
        reject(failure(`${name} 操作超时，请重试。`, 'TIMEOUT'));
      }, timeoutMs);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      try {
        this.api[name]({ ...options,
          success: result => {
            // 原生连接成功可能晚于超时；不能让它遗留成页面不知道的连接。
            if (settled && timedOut && name === 'createBLEConnection') {
              const current = this.state.device;
              if (!current || current.deviceId !== options.deviceId || !this.state.connected) {
                this._quiet('closeBLEConnection', { deviceId: options.deviceId });
              }
            }
            if (settled && timedOut && name === 'openBluetoothAdapter' && !this._active) {
              this._quiet('closeBluetoothAdapter');
            }
            finish(resolve, result || {});
          },
          fail: error => finish(reject, error || failure('蓝牙操作失败', 'FAILED'))
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async _quiet(name, options = {}) {
    try { await this._call(name, options, Math.min(this.config.apiTimeoutMs, 2000)); } catch (error) {
      // 释放资源时，设备已断开或适配器未初始化也允许继续清理。
    }
  }

  _run(task, sending = false) {
    if (!this._active || this._disposed || this.state.busy || this._closing) return Promise.resolve(false);
    const version = ++this._version;
    this._set({ busy: true, sending });
    const work = (async () => {
      try {
        await task(version);
        return true;
      } catch (error) {
        if (version === this._version && this._active) {
          const status = describeError(error);
          if (status) this._set({ status });
        }
        return false;
      } finally {
        if (this._work === work) {
          this._work = null;
          if (!this._closing) this._set({ busy: false, sending: false });
        }
      }
    })();
    this._work = work;
    return work;
  }

  _clearScanTimer() {
    clearTimeout(this._scanTimer);
    this._scanTimer = null;
  }

  async _stopScan() {
    const scanning = this.state.scanning;
    this._clearScanTimer();
    this._set({ scanning: false });
    if (scanning) await this._quiet('stopBluetoothDevicesDiscovery');
  }

  async _prepare(version) {
    await this._call('requirePrivacyAuthorize', {}, 60000);
    this._ensure(version);
    await this._call('openBluetoothAdapter', { mode: 'central' });
    this._ensure(version);
  }

  stopScan() {
    return this._run(async version => {
      await this._stopScan();
      this._ensure(version);
      this._set({ status: this.state.connected ? '扫描已停止，车辆连接保留。' : '扫描已停止，请选择车辆或重新扫描。' });
    });
  }

  scan() {
    return this._run(async version => {
      await this._stopScan();
      this._set({ status: '正在准备蓝牙，请允许查找和连接车辆。' });
      await this._prepare(version);
      this._devices.clear();
      if (this.state.device) this._devices.set(this.state.device.deviceId, this.state.device);
      // 先标记扫描状态，避免首个发现回调先于 success 时丢失设备。
      this._set({ scanning: true, devices: Array.from(this._devices.values()), status: '正在扫描附近的 NIU 车辆…' });
      try {
        // 不用服务 UUID 过滤广播；部分车辆没有在广播包中带上命令服务。
        await this._call('startBluetoothDevicesDiscovery', { allowDuplicatesKey: true, interval: 500 });
        this._ensure(version);
      } catch (error) {
        if (version === this._version) this._set({ scanning: false });
        await this._quiet('stopBluetoothDevicesDiscovery');
        throw error;
      }
      this._scanTimer = setTimeout(() => this.stopScan(), this.config.scanDurationMs);
    });
  }

  _found(result) {
    if (!this._active || !this.state.scanning) return;
    for (const device of result.devices || []) {
      if (!device.deviceId) continue;
      const previous = this._devices.get(device.deviceId) || {};
      const name = device.name || device.localName || previous.name || '';
      if (!/^niu/i.test(name)) continue;
      const entry = { ...previous, deviceId: device.deviceId, name };
      if (typeof device.RSSI === 'number') entry.RSSI = device.RSSI;
      entry.name = displayName(entry);
      entry.label = `${entry.name} · ${entry.deviceId.slice(-6)}`;
      this._devices.set(entry.deviceId, entry);
    }
    this._set({ devices: Array.from(this._devices.values()) });
  }

  async _releaseDevice() {
    const device = this.state.device;
    if (device) this._closedDevices.add(device.deviceId);
    this._readyRecorded = false;
    this._set({ connected: false, ready: false, channelIndex: -1, channels: [], writeType: '' });
    if (device) await this._quiet('closeBLEConnection', { deviceId: device.deviceId });
  }

  connect(deviceId) {
    return this._run(async version => {
      const device = this._devices.get(deviceId);
      if (!device) throw failure('请先扫描并选择车辆。', 'NO_DEVICE');
      await this._stopScan();
      this._ensure(version);
      // 先解除当前设备，旧设备的断线回调不应中断新设备的连接。
      const oldDevice = this.state.device;
      this._set({ device: null, connected: false, ready: false, channels: [], channelIndex: -1, writeType: '' });
      if (oldDevice) {
        try { await this._call('closeBLEConnection', { deviceId: oldDevice.deviceId }); } catch (error) {
          if (![10000, 10002, 10006].includes(error.errCode)) {
            throw failure('无法释放上一次蓝牙连接，请离开页面后重新进入。', 'CLOSE_FAILED');
          }
        }
      }
      this._ensure(version);
      this._readyRecorded = false;
      this._closedDevices.delete(deviceId);
      this._set({ device, connected: false, ready: false, channels: [], channelIndex: -1,
        writeType: '', diagnostics: [], status: `正在连接 ${device.name}…` });
      try {
        // onHide 会关闭适配器；从前台“重连”也必须重新初始化。
        await this._prepare(version);
        await this._call('createBLEConnection', { deviceId, timeout: this.config.connectTimeoutMs }, this.config.connectTimeoutMs + 1000);
        this._ensure(version);
        this._set({ connected: true, status: '正在获取车辆的蓝牙服务…' });
        const result = await this._call('getBLEDeviceServices', { deviceId });
        this._ensure(version);
        const channels = [];
        const diagnostics = [];
        for (const service of result.services || []) {
          let response;
          try {
            response = await this._call('getBLEDeviceCharacteristics', { deviceId, serviceId: service.uuid });
          } catch (error) {
            this._ensure(version);
            // 一个服务不可访问时，继续查找其他服务。
            diagnostics.push(`${service.uuid}：${describeError(error)}`);
            continue;
          }
          this._ensure(version);
          for (const characteristic of response.characteristics || []) {
            const properties = characteristic.properties || {};
            const modes = writeModes(properties);
            diagnostics.push(`${service.uuid} / ${characteristic.uuid}\n${JSON.stringify(properties)}`);
            if (!modes.length && !properties.write) continue;
            if (this.config.characteristicUUID && !sameUUID(characteristic.uuid, this.config.characteristicUUID)) continue;
            channels.push({
              serviceId: service.uuid, characteristicId: characteristic.uuid,
              label: `${shortUUID(service.uuid)} / ${shortUUID(characteristic.uuid)}`,
              preferred: this.config.serviceUUIDs.some(uuid => sameUUID(uuid, service.uuid)),
              modes: modes.length ? modes : ['writeNoResponse', 'write'],
              modeKnown: modes.length > 0
            });
          }
        }
        this._ensure(version);
        this._set({ channels, diagnostics });
        if (!channels.length) throw failure('车辆已连接，但没有找到可写命令通道。请查看连接详情。', 'NO_CHANNEL');
        const preferred = channels.map((channel, index) => ({ channel, index })).filter(item => item.channel.preferred);
        const automatic = preferred.length === 1 ? preferred[0] :
          (this.config.characteristicUUID && channels.length === 1 ? { channel: channels[0], index: 0 } : null);
        if (automatic) this._chooseChannel(automatic.index);
        else this._set({ status: '车辆已连接，请选择命令写入通道。' });
      } catch (error) {
        if (version === this._version) await this._releaseDevice();
        else await this._quiet('closeBLEConnection', { deviceId });
        throw error;
      }
    });
  }

  _chooseChannel(index) {
    const channel = this.state.channels[index];
    if (!channel || !this.state.connected) return;
    this._set({ channelIndex: index, writeType: channel.modeKnown ? channel.modes[0] : '' });
    this._updateReady();
  }

  chooseChannel(index) {
    if (this.state.busy || !this._active) return;
    this._chooseChannel(index);
  }

  chooseWriteType(writeType) {
    const channel = this.state.channels[this.state.channelIndex];
    if (this.state.busy || !this._active || !channel || !channel.modes.includes(writeType)) return;
    this._set({ writeType });
    this._updateReady();
  }

  _updateReady() {
    const ready = this.state.connected && this.state.channelIndex >= 0 && !!this.state.writeType;
    this._set({ ready, status: ready ? `${this.state.device.name} 已连接，可以发送指令。` : '请为命令通道选择写入方式。' });
    if (ready && !this._readyRecorded) {
      this._readyRecorded = true;
      if (this.callbacks.onReady) this.callbacks.onReady({ ...this.state.device });
    }
  }

  send(command) {
    return this._run(async version => {
      if (!this.state.ready || !this.state.connected) throw failure('请先连接车辆并选择可用的命令通道。', 'NOT_READY');
      if (!command || !(command.value instanceof ArrayBuffer) || command.value.byteLength !== 20) {
        throw failure('命令必须是 20 字节二进制数据。', 'INVALID_PACKET');
      }
      await this._stopScan();
      this._ensure(version);
      const device = this.state.device;
      const channel = this.state.channels[this.state.channelIndex];
      const value = command.value.slice(0);
      const writeType = this.state.writeType;
      this._set({ status: `正在向 ${device.name} 发送：${command.summary}…` });
      try {
        await this._call('writeBLECharacteristicValue', {
          deviceId: device.deviceId, serviceId: channel.serviceId,
          characteristicId: channel.characteristicId, writeType, value
        }, this.config.writeTimeoutMs);
        this._ensure(version);
        this._set({ status: `已向 ${device.name} 写入 ${command.summary}。请查看车辆仪表确认。` });
      } catch (error) {
        if (version !== this._version) throw error;
        if (error.code === 'TIMEOUT' || error.errCode === 10006) {
          await this._releaseDevice();
          if (error.code === 'TIMEOUT') throw failure('写入超时', 'WRITE_TIMEOUT');
        }
        throw error;
      }
    }, true);
  }

  disconnect(clearDevices = false) {
    return this._run(async version => {
      await this._stopScan();
      this._ensure(version);
      const device = this.state.device;
      this._set({ device: null });
      if (device) await this._quiet('closeBLEConnection', { deviceId: device.deviceId });
      this._ensure(version);
      if (clearDevices) this._devices.clear();
      this._readyRecorded = false;
      this._set({ device: null, devices: Array.from(this._devices.values()), connected: false,
        channels: [], channelIndex: -1, writeType: '', ready: false, diagnostics: [], status: '已断开连接。' });
    });
  }

  suspend() {
    this._active = false;
    this._version += 1;
    this._clearScanTimer();
    if (this._closing) return this._closing;
    const pending = this._work;
    const device = this.state.device;
    const wasSending = this.state.sending;
    this._readyRecorded = false;
    this._set({ busy: true, sending: false, connected: false, ready: false, scanning: false,
      channels: [], channelIndex: -1, writeType: '', status: wasSending
        ? '发送过程中已离开页面，结果未知。请先查看车辆仪表，再重新连接。'
        : '连接已暂停，请重新选择车辆或扫描连接。' });
    // 等待被取消的操作退出后再次关闭适配器，避免后台连接回调恢复旧状态。
    this._closing = (async () => {
      await this._quiet('stopBluetoothDevicesDiscovery');
      if (device) await this._quiet('closeBLEConnection', { deviceId: device.deviceId });
      if (pending) await pending;
      await this._quiet('closeBluetoothAdapter');
      this._closing = null;
      this._set({ busy: false, sending: false });
    })();
    return this._closing;
  }

  destroy() {
    this._disposed = true;
    for (const [name, listener] of [
      ['offBluetoothDeviceFound', this._onFound],
      ['offBLEConnectionStateChange', this._onConnection],
      ['offBluetoothAdapterStateChange', this._onAdapter]
    ]) {
      if (typeof this.api[name] === 'function') this.api[name](listener);
    }
    return this.suspend();
  }
}

module.exports = { BleClient, describeError, writeModes, shortUUID };
