const { BleClient } = require('../../utils/ble');
const { VOLTAGES, CAPACITIES, buildCommand } = require('../../utils/protocol');
const { formatTime, loadHistory, saveHistory, clearHistory } = require('../../utils/history');

const WRITE_LABELS = { writeNoResponse: '无回复写', write: '有回复写' };

Page({
  data: {
    voltageOptions: VOLTAGES, capacityOptions: CAPACITIES,
    voltageIndex: 2, capacityIndex: 6,
    commandSummary: '', commandHex: '',
    devices: [], deviceIndex: -1, selectedDeviceName: '尚未选择',
    selectedDeviceLabel: '请先扫描附近车辆',
    scanning: false, busy: false, sending: false, connected: false, canSend: false,
    status: '未连接，请扫描附近车辆。',
    channels: [], channelIndex: -1, channelLabel: '请选择命令写入通道',
    writeModes: [], writeModeIndex: -1, writeModeLabel: '请选择写入方式',
    showChannelChoice: false, showWriteModeChoice: false,
    detailsOpen: false, diagnosticsText: '连接后可查看服务和特征信息。',
    lastDeviceName: '暂无记录', lastConnectedAt: '—', hasHistory: false, historyHint: ''
  },

  onLoad() {
    this._alive = true;
    this._foreground = true;
    this._renderHistory(loadHistory(wx));
    this._updatePreview();
    this._client = new BleClient(wx, {
      onChange: state => this._renderBluetooth(state),
      onReady: device => {
        if (this._alive) this._renderHistory(saveHistory(wx, device));
      }
    });
  },

  onShow() {
    this._foreground = true;
    if (this._client) this._client.activate();
  },

  onHide() {
    this._foreground = false;
    if (this._client) this._client.suspend();
  },

  onUnload() {
    this._alive = false;
    if (this._client) this._client.destroy();
  },

  _renderHistory({ record, error }) {
    this.setData({
      hasHistory: !!record,
      lastDeviceName: record ? record.name : '暂无记录',
      lastConnectedAt: record ? formatTime(record.connectedAt) : '—',
      historyHint: error || (record ? '上次连接记录；本次使用请重新连接。' : '连接成功后会自动记录名称和时间。')
    });
  },

  _renderBluetooth(state) {
    if (!this._alive) return;
    const channel = state.channels[state.channelIndex];
    const modes = channel ? channel.modes.map(value => ({ value, label: WRITE_LABELS[value] })) : [];
    const deviceIndex = state.device ? state.devices.findIndex(device => device.deviceId === state.device.deviceId) : -1;
    const writeModeIndex = modes.findIndex(mode => mode.value === state.writeType);
    this.setData({
      devices: state.devices, deviceIndex,
      selectedDeviceName: state.device ? state.device.name : '尚未选择',
      selectedDeviceLabel: state.device ? (state.device.label || state.device.name) : '请扫描后选择车辆',
      scanning: state.scanning, busy: state.busy, sending: state.sending,
      connected: state.connected,
      canSend: this._foreground && state.ready && !state.busy && !state.scanning,
      status: state.status,
      channels: state.channels, channelIndex: state.channelIndex,
      channelLabel: channel ? channel.label : '请选择命令写入通道',
      writeModes: modes, writeModeIndex,
      writeModeLabel: WRITE_LABELS[state.writeType] || '请选择写入方式',
      showChannelChoice: state.connected && state.channels.length > 0,
      showWriteModeChoice: state.connected && modes.length > 0,
      diagnosticsText: state.diagnostics.length ? state.diagnostics.join('\n\n') : '连接后可查看服务和特征信息。'
    });
  },

  _updatePreview() {
    const command = buildCommand(VOLTAGES[this.data.voltageIndex].code, CAPACITIES[this.data.capacityIndex].code);
    this.setData({ commandSummary: command.summary, commandHex: command.hex });
    return command;
  },

  onVoltageChange(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    if (!VOLTAGES[index]) return;
    this.setData({ voltageIndex: index });
    this._updatePreview();
  },

  onCapacityChange(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    if (!CAPACITIES[index]) return;
    this.setData({ capacityIndex: index });
    this._updatePreview();
  },

  onScanTap() {
    if (this.data.busy) return;
    if (this.data.scanning) this._client.stopScan();
    else this._client.scan();
  },

  onDeviceChange(event) {
    const device = this.data.devices[Number(event.detail.value)];
    if (!device || this.data.busy) return;
    this._client.connect(device.deviceId);
  },

  onReconnectTap() {
    const device = this.data.devices[this.data.deviceIndex];
    if (device && !this.data.busy) this._client.connect(device.deviceId);
  },

  onChannelChange(event) {
    this._client.chooseChannel(Number(event.detail.value));
  },

  onWriteModeChange(event) {
    const mode = this.data.writeModes[Number(event.detail.value)];
    if (mode) this._client.chooseWriteType(mode.value);
  },

  onSendTap() {
    if (this.data.canSend) this._client.send(this._updatePreview());
  },

  async onClearHistoryTap() {
    if (this.data.busy) return;
    const done = await this._client.disconnect(true);
    if (!done || !this._alive) return;
    const error = clearHistory(wx);
    if (error) this._renderHistory({ ...loadHistory(wx), error });
    else this._renderHistory({ record: null, error: '' });
  },

  onDetailsTap() {
    this.setData({ detailsOpen: !this.data.detailsOpen });
  },

  onOpenSettingsTap() {
    wx.openSetting({ fail: () => this._showMessage('无法打开小程序权限设置，请从右上角菜单进入设置。') });
  },

  onOpenSystemSettingsTap() {
    if (typeof wx.openAppAuthorizeSetting === 'function') {
      wx.openAppAuthorizeSetting({ fail: () => this._showMessage('请在 iPhone 设置 → 隐私与安全性 → 蓝牙中检查微信权限。') });
    } else this._showMessage('请在 iPhone 设置 → 隐私与安全性 → 蓝牙中检查微信权限。');
  },

  onPrivacyTap() {
    wx.openPrivacyContract({ fail: () => this._showMessage('无法打开隐私指引，请确认小程序后台已配置蓝牙访问用途。') });
  },

  _showMessage(message) {
    if (this._alive) this.setData({ status: message });
  }
});
