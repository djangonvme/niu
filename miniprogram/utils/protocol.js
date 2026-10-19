const VOLTAGES = [
  { label: '48V 平台', code: '02' },
  { label: '60V 平台', code: '03' },
  { label: '72V 平台', code: '05' }
];

const CAPACITIES = [
  { label: '20 Ah', code: '01' },
  { label: '23 Ah', code: '02' },
  { label: '26 / 24 Ah', code: '03' },
  { label: '32 Ah', code: '05' },
  { label: '38 Ah', code: '06' },
  { label: '35 Ah', code: '08' },
  { label: '45 Ah', code: '0C' },
  { label: '48 Ah', code: '07' }
];

function buildCommand(voltageCode, capacityCode) {
  const voltage = VOLTAGES.find(item => item.code === voltageCode);
  const capacity = CAPACITIES.find(item => item.code === capacityCode);
  if (!voltage || !capacity) throw new Error('请选择有效的电压和容量');
  const packet = new Uint8Array([
    0x67, 0x84, 0x85, 0x59, 0x11, 0x12, 0x76, 0x99,
    0x61, 0x22, 0x92, 0x43, 0x23, 0x54, 0x45, 0x39,
    0x87, parseInt(voltageCode, 16), parseInt(capacityCode, 16), 0x26
  ]);
  return {
    value: packet.buffer,
    hex: Array.from(packet, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    summary: `${voltage.label} / ${capacity.label}`
  };
}

module.exports = { VOLTAGES, CAPACITIES, buildCommand };
