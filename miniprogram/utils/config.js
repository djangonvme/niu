// 首次适配会在这些服务中查找命令通道；UUID 比较不区分大小写。
// 如果车辆有多个可写特征，页面会要求选择，不按枚举顺序猜测。
module.exports = {
  serviceUUIDs: [
    '0000FFE0-0000-1000-8000-00805F9B34FB',
    '0000FF00-0000-1000-8000-00805F9B34FB'
  ],
  // 真机确认后可填写特征 UUID；仍会在每次连接中重新枚举和匹配。
  characteristicUUID: '',
  scanDurationMs: 10000,
  connectTimeoutMs: 10000,
  apiTimeoutMs: 10000,
  writeTimeoutMs: 8000
};
