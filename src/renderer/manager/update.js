import * as dom from './dom-refs.js';

function render(state) {
  dom.currentVersion.textContent = state.currentVersion;
  // 之前已发现的新版本在后续检查失败时仍然有效。
  const showUpdate = Boolean(state.latestVersion && !state.checking);
  dom.latestVersion.textContent = state.latestVersion ? `v${state.latestVersion}` : '';
  dom.updateButton.hidden = !showUpdate;
  dom.updateStatus.hidden = showUpdate;
  dom.updateStatus.textContent = state.checking ? '正在检查更新…'
    : state.error ? '检查更新失败' : state.checkedAt && !showUpdate ? '已是最新版本' : '';
  dom.updateStatus.title = state.error || '';
  dom.checkUpdateButton.disabled = state.checking;
}

function showError(error) {
  dom.settingsError.textContent = String(error.message || error);
  dom.settingsError.hidden = false;
}

export function initUpdate() {
  const api = window.atkManager;
  let receivedEvent = false;
  api.onUpdateStateChanged((state) => {
    receivedEvent = true;
    render(state);
  });
  api.getUpdateState().then((state) => {
    if (!receivedEvent) render(state);
  }).catch(showError);
  dom.checkUpdateButton.addEventListener('click', () => api.checkUpdate().catch(showError));
  dom.updateButton.addEventListener('click', () => api.openReleasePage().catch(showError));
  dom.repositoryButton.addEventListener('click', () => api.openRepository().catch(showError));
}
