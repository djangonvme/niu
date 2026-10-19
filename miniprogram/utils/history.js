const HISTORY_KEY = 'niu_last_connection';

function formatTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '时间未记录';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function loadHistory(api) {
  try {
    const record = api.getStorageSync(HISTORY_KEY);
    return { record: record && typeof record.name === 'string' && record.name ? record : null, error: '' };
  } catch (error) {
    return { record: null, error: '无法读取连接记录，本次仍可正常连接。' };
  }
}

function saveHistory(api, device) {
  const record = { name: device.name, deviceId: device.deviceId, connectedAt: new Date().toISOString() };
  try {
    api.setStorageSync(HISTORY_KEY, record);
    return { record, error: '' };
  } catch (error) {
    return { record, error: '本次已连接，但记录无法保存，下次打开可能无法保留。' };
  }
}

function clearHistory(api) {
  try {
    api.removeStorageSync(HISTORY_KEY);
    return '';
  } catch (error) {
    return '连接记录清除失败，请稍后重试。';
  }
}

module.exports = { HISTORY_KEY, formatTime, loadHistory, saveHistory, clearHistory };
