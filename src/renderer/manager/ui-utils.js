// 管理页用到的纯工具函数。无副作用、无 DOM 依赖。
export function formatTime(isoTime) {
  if (!isoTime) {
    return '--';
  }

  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

// waiting 态需要区分"待绑定/待连接",所以把是否已绑定作为参数显式传入。
export function getStatusLabel(status, bound) {
  switch (status) {
    case 'connected':
      return '直连成功';
    case 'waiting':
      return bound ? '待连接' : '待绑定';
    case 'unsupported':
      return '待适配';
    case 'error':
      return '异常';
    case 'authorizing':
      return '授权中';
    default:
      return '加载中';
  }
}

export function normalizeOverlayVariant(value) {
  return value === 'compact' ? 'compact' : 'full';
}
