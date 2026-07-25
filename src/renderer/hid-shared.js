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
    return suspiciousTailMatch ? suspiciousTailMatch[1].trim() : normalized;
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

  function visitCollections(collections, visitor) {
    for (const collection of Array.isArray(collections) ? collections : []) {
      visitor(collection);
      visitCollections(collection.children, visitor);
    }
  }

  function inspectReportSupport(device, reportId) {
    let hasOutputReport = false;
    let hasFeatureReport = false;

    visitCollections(device?.collections, (collection) => {
      hasOutputReport ||= Array.isArray(collection.outputReports)
        && collection.outputReports.some((report) => report.reportId === reportId);
      hasFeatureReport ||= Array.isArray(collection.featureReports)
        && collection.featureReports.some((report) => report.reportId === reportId);
    });

    return { hasOutputReport, hasFeatureReport };
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

    const signatures = [];
    visitCollections(device.collections, (collection) => {
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

  function getDeviceKey(device) {
    if (!device) {
      return '';
    }

    return [
      device.vendorId,
      device.productId,
      getDeviceProductName(device),
      normalizeDeviceName(device.collectionSignature) || buildCollectionSignature(device),
    ].join(':');
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
    visitCollections(device.collections, (collection) => {
      hasMouse ||= collection.usage === 2;
      hasKeyboard ||= collection.usage === 6;
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

    if (/virtual multitouch/i.test(productName)) score -= 40;
    if (/ATK|VXE/i.test(productName)) score += 36;
    if (/mouse|鼠标|dongle|receiver|2\.4/i.test(productName)) score += 28;
    if (/nano/i.test(productName)) score += 10;
    if (/keyboard/i.test(productName)) score -= 18;
    if (protocolSupport.compx) score += 42;
    if (protocolSupport.hechi) score += 42;

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
    return sanitizeDeviceNameForDisplay(getDeviceProductName(device), device)
      || `未命名设备 ${formatHexId(device?.vendorId)}:${formatHexId(device?.productId)}`;
  }

  function sortChooserDevices(devices) {
    return [...devices].sort((left, right) => {
      const scoreDiff = getChooserDisplayScore(right) - getChooserDisplayScore(left);
      return scoreDiff || resolveChooserDeviceName(left).localeCompare(resolveChooserDeviceName(right), 'zh-CN');
    });
  }

  window.AtkHidShared = {
    normalizeDeviceName,
    getDeviceKey,
    isGenericDeviceName,
    formatHexId,
    supportsKnownBatteryProtocol,
    resolveChooserDeviceName,
    sortChooserDevices,
  };
})();
