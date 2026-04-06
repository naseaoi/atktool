(() => {
  const COMPX_REPORT_ID = 8;
  const HECHI_REPORT_ID = 11;

  function normalizeDeviceName(name) {
    return typeof name === 'string' ? name.trim() : '';
  }

  function getDeviceProductName(device) {
    return normalizeDeviceName(device?.productName || device?.name);
  }

  function formatHexId(value) {
    if (!Number.isFinite(value)) {
      return '----';
    }

    return value.toString(16).toUpperCase().padStart(4, '0');
  }

  function sanitizeDeviceNameForDisplay(name, fallbackDevice = null) {
    const normalized = normalizeDeviceName(name)
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\uFFFD/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return `HID 设备 ${formatHexId(fallbackDevice?.vendorId)}:${formatHexId(fallbackDevice?.productId)}`;
    }

    const suspiciousTailMatch = normalized.match(/^([\x20-\x7E]{6,}?)([\u0080-\uFFFF])\2{2,}[\u0080-\uFFFF0-9\s-]*$/);
    if (suspiciousTailMatch) {
      return suspiciousTailMatch[1].trim();
    }

    return normalized;
  }

  function isGenericDeviceName(name) {
    const normalized = normalizeDeviceName(name);
    if (!normalized) {
      return true;
    }

    if (/ATK|VXE/i.test(normalized)) {
      return false;
    }

    return /wireless mouse|mouse|dongle|receiver|nano|hid|bluetooth|keyboard/i.test(normalized);
  }

  function normalizeCollectionSignature(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function visitCollections(collections, visitor) {
    for (const collection of Array.isArray(collections) ? collections : []) {
      visitor(collection);
      visitCollections(collection.children, visitor);
    }
  }

  function collectionHasReportId(reports, reportId) {
    return Array.isArray(reports) && reports.some((report) => report.reportId === reportId);
  }

  function inspectReportSupport(device, reportId) {
    // 先看设备描述符里是否声明了目标 reportId，避免对明显不匹配的接口反复试探。
    let hasOutputReport = false;
    let hasFeatureReport = false;
    let sawOutputDescriptor = false;
    let sawFeatureDescriptor = false;

    visitCollections(device?.collections, (collection) => {
      if (Array.isArray(collection.outputReports)) {
        sawOutputDescriptor = true;
        if (collectionHasReportId(collection.outputReports, reportId)) {
          hasOutputReport = true;
        }
      }

      if (Array.isArray(collection.featureReports)) {
        sawFeatureDescriptor = true;
        if (collectionHasReportId(collection.featureReports, reportId)) {
          hasFeatureReport = true;
        }
      }
    });

    return {
      hasOutputReport,
      hasFeatureReport,
      hasDescriptor: sawOutputDescriptor || sawFeatureDescriptor,
    };
  }

  function getReportTransports(device, reportId) {
    const support = inspectReportSupport(device, reportId);

    if (!support.hasOutputReport && !support.hasFeatureReport && !support.hasDescriptor) {
      return ['output', 'feature'];
    }

    const transports = [];
    if (support.hasOutputReport) {
      transports.push('output');
    }
    if (support.hasFeatureReport) {
      transports.push('feature');
    }

    return transports;
  }

  function buildCollectionSignature(device) {
    if (!Array.isArray(device?.collections) || device.collections.length === 0) {
      return [
        Number.isFinite(device?.interface) ? device.interface : '',
        Number.isFinite(device?.usagePage) ? device.usagePage : '',
        Number.isFinite(device?.usage) ? device.usage : '',
        Number.isFinite(device?.release) ? device.release : '',
        normalizeDeviceName(device?.serialNumber),
      ].join('/');
    }

    // 同一接收器可能暴露多个同名 HID 接口，这里把结构压成签名便于稳定记忆。
    const signatures = [];

    visitCollections(device?.collections, (collection) => {
      const inputReports = Array.isArray(collection.inputReports)
        ? collection.inputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
        : '';
      const outputReports = Array.isArray(collection.outputReports)
        ? collection.outputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
        : '';
      const featureReports = Array.isArray(collection.featureReports)
        ? collection.featureReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
        : '';

      signatures.push([
        collection.usagePage ?? '',
        collection.usage ?? '',
        inputReports,
        outputReports,
        featureReports,
      ].join('/'));
    });

    return signatures.sort().join('|');
  }

  function simplifyDevice(device) {
    return {
      vendorId: device.vendorId,
      productId: device.productId,
      productName: getDeviceProductName(device),
      collectionSignature: normalizeCollectionSignature(device.collectionSignature) || buildCollectionSignature(device),
    };
  }

  function getLooseDeviceKey(device) {
    if (!device) {
      return '';
    }

    return [device.vendorId, device.productId, getDeviceProductName(device)].join(':');
  }

  function getDeviceKey(device) {
    if (!device) {
      return '';
    }

    return [
      device.vendorId,
      device.productId,
      getDeviceProductName(device),
      normalizeCollectionSignature(device.collectionSignature) || buildCollectionSignature(device),
    ].join(':');
  }

  function getDeviceMatchLevel(left, right) {
    const exactLeft = getDeviceKey(left);
    const exactRight = getDeviceKey(right);

    if (exactLeft && exactLeft === exactRight) {
      return 2;
    }

    const looseLeft = getLooseDeviceKey(left);
    const looseRight = getLooseDeviceKey(right);

    if (looseLeft && looseLeft === looseRight) {
      return 1;
    }

    return 0;
  }

  function pickPreferredDevice(devices, preferredCandidate = null) {
    const preferredKey = getDeviceKey(preferredCandidate);
    if (!preferredKey) {
      return null;
    }

    return devices.find((device) => getDeviceKey(device) === preferredKey) || null;
  }

  function pickLooseMatchedDevices(devices, preferredCandidate = null) {
    const preferredKey = getLooseDeviceKey(preferredCandidate);
    if (!preferredKey) {
      return [];
    }

    return devices.filter((device) => getLooseDeviceKey(device) === preferredKey);
  }

  function getCollectionFlags(device) {
    if (!Array.isArray(device?.collections) || device.collections.length === 0) {
      return {
        hasMouse: device?.usage === 2,
        hasKeyboard: device?.usage === 6,
      };
    }

    let hasMouse = false;
    let hasKeyboard = false;

    visitCollections(device?.collections, (collection) => {
      if (collection.usage === 2) {
        hasMouse = true;
      }

      if (collection.usage === 6) {
        hasKeyboard = true;
      }
    });

    return { hasMouse, hasKeyboard };
  }

  function supportsKnownBatteryProtocol(device) {
    if (device?.protocolSupport && typeof device.protocolSupport === 'object') {
      return {
        compx: Boolean(device.protocolSupport.compx),
        hechi: Boolean(device.protocolSupport.hechi),
      };
    }

    const compxSupport = inspectReportSupport(device, COMPX_REPORT_ID);
    const hechiSupport = inspectReportSupport(device, HECHI_REPORT_ID);

    return {
      compx: compxSupport.hasOutputReport || compxSupport.hasFeatureReport,
      hechi: hechiSupport.hasOutputReport || hechiSupport.hasFeatureReport,
    };
  }

  function getChooserDisplayScore(device) {
    const productName = getDeviceProductName(device);
    const { hasMouse, hasKeyboard } = getCollectionFlags(device);
    const protocolSupport = supportsKnownBatteryProtocol(device);
    let score = 0;

    if (/virtual multitouch/i.test(productName)) {
      score -= 40;
    }

    if (/ATK|VXE/i.test(productName)) {
      score += 36;
    }

    if (/mouse|鼠标|dongle|receiver|2\.4/i.test(productName)) {
      score += 28;
    }

    if (/nano/i.test(productName)) {
      score += 10;
    }

    if (/keyboard/i.test(productName)) {
      score -= 18;
    }

    if (protocolSupport.compx) {
      score += 42;
    }

    if (protocolSupport.hechi) {
      score += 42;
    }

    if (hasMouse && !hasKeyboard) {
      score += 18;
    } else if (hasMouse && hasKeyboard) {
      score += 2;
    } else if (hasKeyboard) {
      score -= 10;
    }

    score += Number.isFinite(device?.matchLevel) ? device.matchLevel * 120 : 0;
    return score;
  }

  function resolveChooserDeviceName(device) {
    const normalized = sanitizeDeviceNameForDisplay(getDeviceProductName(device), device);
    if (normalized) {
      return normalized;
    }

    return `未命名设备 ${formatHexId(device?.vendorId)}:${formatHexId(device?.productId)}`;
  }

  function sortChooserDevices(devices) {
    return [...devices].sort((left, right) => {
      const scoreDiff = getChooserDisplayScore(right) - getChooserDisplayScore(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return resolveChooserDeviceName(left).localeCompare(resolveChooserDeviceName(right), 'zh-CN');
    });
  }

  function mergeUniqueDevices(...deviceLists) {
    const deviceMap = new Map();

    for (const deviceList of deviceLists) {
      for (const device of Array.isArray(deviceList) ? deviceList : []) {
        const key = getDeviceKey(device) || `${device?.vendorId}:${device?.productId}:${getDeviceProductName(device)}`;
        if (key) {
          deviceMap.set(key, device);
        }
      }
    }

    return Array.from(deviceMap.values());
  }

  function chooseDevice(devices) {
    if (!Array.isArray(devices) || devices.length === 0) {
      return null;
    }

    return [...devices]
      .map((device) => ({ device, score: getChooserDisplayScore(device) }))
      .sort((left, right) => right.score - left.score)[0]?.device || null;
  }

  function resolveAuthorizedDevice(devices, requestedBinding = null) {
    const exactMatch = pickPreferredDevice(devices, requestedBinding);
    const exactProtocolSupport = exactMatch ? supportsKnownBatteryProtocol(exactMatch) : { compx: false, hechi: false };

    // 用户手动选的是某个物理设备时，优先挑出真正暴露电量协议的 HID 接口，避免误绑通用接口。
    if (exactMatch && (exactProtocolSupport.compx || exactProtocolSupport.hechi)) {
      return exactMatch;
    }

    const looseMatches = pickLooseMatchedDevices(devices, requestedBinding);
    const supportedLooseMatch = chooseDevice(
      looseMatches.filter((device) => {
        const protocolSupport = supportsKnownBatteryProtocol(device);
        return protocolSupport.compx || protocolSupport.hechi;
      })
    );

    if (supportedLooseMatch) {
      return supportedLooseMatch;
    }

    if (exactMatch) {
      return exactMatch;
    }

    if (looseMatches.length > 0) {
      return chooseDevice(looseMatches);
    }

    if (devices.length === 1) {
      return devices[0];
    }

    return chooseDevice(devices);
  }

  window.AtkHidShared = {
    COMPX_REPORT_ID,
    HECHI_REPORT_ID,
    normalizeDeviceName,
    getDeviceProductName,
    formatHexId,
    sanitizeDeviceNameForDisplay,
    isGenericDeviceName,
    normalizeCollectionSignature,
    visitCollections,
    inspectReportSupport,
    getReportTransports,
    buildCollectionSignature,
    simplifyDevice,
    getLooseDeviceKey,
    getDeviceKey,
    getDeviceMatchLevel,
    pickPreferredDevice,
    pickLooseMatchedDevices,
    getCollectionFlags,
    supportsKnownBatteryProtocol,
    getChooserDisplayScore,
    sortChooserDevices,
    resolveChooserDeviceName,
    mergeUniqueDevices,
    chooseDevice,
    resolveAuthorizedDevice,
  };
})();
