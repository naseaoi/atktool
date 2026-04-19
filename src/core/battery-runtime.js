// NativeBatteryRuntime 单例容器:所有模块共享同一个 runtime 实例。
// main.js 在 boot 时 set(runtime),其他模块通过 get() 访问,避免跨模块传 runtime 引用。

let instance = null;

function set(runtime) {
  instance = runtime || null;
}

function get() {
  return instance;
}

module.exports = {
  set,
  get,
};
