// 项目全局常量集中管理,避免常量散落在各模块导致"同一业务规则"被重复定义。

const HUB_URL = 'https://hub.atk.pro/';
const HUB_ORIGIN = new URL(HUB_URL).origin;
// Hub 窗口独立 partition:一来与设备管理/悬浮窗的默认 session 隔离,避免外站 cookie/storage 污染主 UI;
// 二来窗口关闭后可精准 clearCache(),释放 hub 网页留下的 ~80-150MB Chromium 缓存。persist: 前缀保留登录态。
const HUB_SESSION_PARTITION = 'persist:atk-hub';

const OVERLAY_VARIANTS = {
  full: {
    width: 404,
    height: 392,
  },
  compact: {
    width: 80,
    height: 80,
  },
};

const MANAGER_MIN_HEIGHT = 560;

const TRAY_ICON_VERSION = 'v6';
const TRAY_ICON_SIZE = 70;
const TRAY_DIGIT_SEGMENTS = {
  0: ['a', 'b', 'c', 'd', 'e', 'f'],
  1: ['b', 'c'],
  2: ['a', 'b', 'd', 'e', 'g'],
  3: ['a', 'b', 'c', 'd', 'g'],
  4: ['b', 'c', 'f', 'g'],
  5: ['a', 'c', 'd', 'f', 'g'],
  6: ['a', 'c', 'd', 'e', 'f', 'g'],
  7: ['a', 'b', 'c'],
  8: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  9: ['a', 'b', 'c', 'd', 'f', 'g'],
  '-': ['g'],
  // 满电 100 用七段数码管的 "F"（Full）替代三位数,避免托盘缩到 16-20px 时挤成一团。
  F: ['a', 'e', 'f', 'g'],
};

const GENERIC_DEVICE_NAME_PATTERN = /wireless mouse|mouse|dongle|receiver|nano|hid|bluetooth|keyboard/i;

module.exports = {
  HUB_URL,
  HUB_ORIGIN,
  HUB_SESSION_PARTITION,
  OVERLAY_VARIANTS,
  MANAGER_MIN_HEIGHT,
  TRAY_ICON_VERSION,
  TRAY_ICON_SIZE,
  TRAY_DIGIT_SEGMENTS,
  GENERIC_DEVICE_NAME_PATTERN,
};
