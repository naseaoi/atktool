const { HUB_ORIGIN } = require('../core/constants');
const { logInfo } = require('../utils/logger');

const configuredSessions = new WeakSet();

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getOrigin(value) {
  if (!value) {
    return '';
  }

  try {
    return new URL(value).origin;
  } catch (_error) {
    return '';
  }
}

function isHubOrigin(value) {
  return getOrigin(value) === HUB_ORIGIN;
}

function buildBrowserUserAgent(userAgent) {
  return normalizeName(userAgent)
    .replace(/\sElectron\/[^\s)]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function visitCollections(collections, visitor) {
  for (const collection of Array.isArray(collections) ? collections : []) {
    visitor(collection);
    visitCollections(collection.children, visitor);
  }
}

function getPreferredCollection(preferredBinding) {
  const parts = normalizeName(preferredBinding?.collectionSignature).split('/');
  const usagePage = parts[1] ? Number(parts[1]) : null;
  const usage = parts[2] ? Number(parts[2]) : null;

  return {
    usagePage: Number.isFinite(usagePage) ? usagePage : null,
    usage: Number.isFinite(usage) ? usage : null,
  };
}

function getDeviceScore(device, preferredBinding = null) {
  const deviceName = normalizeName(device?.name || device?.productName);
  const preferredName = normalizeName(preferredBinding?.productName);
  const preferredCollection = getPreferredCollection(preferredBinding);
  let score = 0;

  if (
    Number.isFinite(preferredBinding?.vendorId)
    && Number.isFinite(preferredBinding?.productId)
    && device?.vendorId === preferredBinding.vendorId
    && device?.productId === preferredBinding.productId
  ) {
    score += 1000;
  }

  if (preferredName && deviceName.toLowerCase() === preferredName.toLowerCase()) {
    score += 240;
  }

  if (/ATK|VXE|F1|X1|R1/i.test(deviceName)) {
    score += 120;
  }

  if (/mouse|鼠标|dongle|receiver|2\.4|wireless/i.test(deviceName)) {
    score += 80;
  }

  visitCollections(device?.collections, (collection) => {
    if (
      preferredCollection.usagePage !== null
      && preferredCollection.usage !== null
      && collection?.usagePage === preferredCollection.usagePage
      && collection?.usage === preferredCollection.usage
    ) {
      score += 320;
    }

    if (collection?.usage === 2) {
      score += 40;
    }

    if (collection?.usagePage >= 65280) {
      score += 30;
    }
  });

  return score;
}

function chooseHubHidDevice(deviceList, preferredBinding = null) {
  return (Array.isArray(deviceList) ? deviceList : [])
    .map((device, index) => ({
      device,
      index,
      score: getDeviceScore(device, preferredBinding),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.device || null;
}

function matchesPreferredDevice(device, preferredBinding = null) {
  return Boolean(
    Number.isFinite(preferredBinding?.vendorId)
    && Number.isFinite(preferredBinding?.productId)
    && device?.vendorId === preferredBinding.vendorId
    && device?.productId === preferredBinding.productId
  );
}

function configureHubWebHid(hubSession, getPreferredBinding = () => null) {
  if (!hubSession || configuredSessions.has(hubSession)) {
    return;
  }

  configuredSessions.add(hubSession);
  const grantedDeviceIds = new Set();

  hubSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== 'hid') {
      return false;
    }

    const origins = [
      getOrigin(requestingOrigin),
      getOrigin(details?.securityOrigin),
      getOrigin(details?.requestingUrl),
    ].filter(Boolean);

    return origins.length > 0 && origins.every((origin) => origin === HUB_ORIGIN);
  });

  hubSession.setDevicePermissionHandler((details) => {
    if (details?.deviceType !== 'hid' || !isHubOrigin(details.origin)) {
      return false;
    }

    return grantedDeviceIds.has(details.device?.deviceId)
      || matchesPreferredDevice(details.device, getPreferredBinding());
  });

  hubSession.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();

    const frameOrigin = getOrigin(details?.frame?.url);
    if (frameOrigin !== HUB_ORIGIN) {
      callback();
      return;
    }

    const selectedDevice = chooseHubHidDevice(details?.deviceList, getPreferredBinding());
    if (!selectedDevice?.deviceId) {
      callback();
      return;
    }

    grantedDeviceIds.add(selectedDevice.deviceId);
    callback(selectedDevice.deviceId);

    logInfo('官网同步已授权 WebHID 设备', {
      deviceName: normalizeName(selectedDevice.name || selectedDevice.productName),
      vendorId: selectedDevice.vendorId,
      productId: selectedDevice.productId,
    });
  });
}

module.exports = {
  buildBrowserUserAgent,
  chooseHubHidDevice,
  configureHubWebHid,
  isHubOrigin,
};
