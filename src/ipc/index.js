const overlayIpc = require('./overlay-ipc');
const managerIpc = require('./manager-ipc');
const hubIpc = require('./hub-ipc');

function register() {
  overlayIpc.register();
  managerIpc.register();
  hubIpc.register();
}

module.exports = {
  register,
};
