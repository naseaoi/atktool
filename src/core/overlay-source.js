const { EventEmitter } = require('node:events');

// 标识当前悬浮窗数据由谁来填充:'manager'(本地 HID 直连) 或 'hub'(官网同步)。
// 切到 hub 时:hub-window 负责显示、native-hid runtime 暂停。
// 切回 manager 时:native-hid runtime 恢复、hub-window 销毁。

const emitter = new EventEmitter();

let current = 'manager';

function get() {
  return current;
}

function set(source) {
  const next = source === 'hub' ? 'hub' : 'manager';
  if (current === next) {
    return;
  }
  current = next;
  emitter.emit('changed', current);
}

// 切到 manager 并延时一小段,留时间给订阅方(hub-window 销毁、runtime resume)。
async function activateStable() {
  set('manager');
  await new Promise((resolve) => setTimeout(resolve, 220));
  return true;
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

module.exports = {
  get,
  set,
  activateStable,
  on,
};
