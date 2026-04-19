const { EventEmitter } = require('node:events');

// HID 设备选择器当前待用户挑选的设备列表,广播给管理窗口渲染。

const emitter = new EventEmitter();

let pendingSelection = null;

function getPayload() {
  if (!pendingSelection) {
    return { open: false, devices: [] };
  }
  return {
    open: true,
    devices: Array.from(pendingSelection.deviceMap.values()),
  };
}

function set(deviceList) {
  pendingSelection = {
    deviceMap: new Map(deviceList.map((device) => [device.deviceId, device])),
  };
  emitter.emit('changed', getPayload());
}

function clear() {
  if (!pendingSelection) {
    return false;
  }
  pendingSelection = null;
  emitter.emit('changed', { open: false, devices: [] });
  return true;
}

function cancel() {
  return clear();
}

function hasDeviceId(deviceId) {
  return Boolean(pendingSelection && pendingSelection.deviceMap.has(deviceId));
}

function isActive() {
  return Boolean(pendingSelection);
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

module.exports = {
  set,
  clear,
  cancel,
  hasDeviceId,
  isActive,
  getPayload,
  on,
};
