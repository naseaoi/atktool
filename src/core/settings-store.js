const { EventEmitter } = require('node:events');
const { readSettings, writeSettings } = require('./store');

// 集中管理 settings 的读写。模块加载时即从磁盘读取,后续 update 通过事件广播。
// 所有业务模块订阅 'changed' 事件,无需互相 require,打破循环依赖。

const emitter = new EventEmitter();
emitter.setMaxListeners(32);

let settings = readSettings();

function get() {
  return settings;
}

function update(patch) {
  settings = {
    ...settings,
    ...patch,
  };
  writeSettings(settings);
  emitter.emit('changed', { settings, patch });
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

module.exports = {
  get,
  update,
  on,
};
