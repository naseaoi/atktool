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

const STATUS_CHIPS = {
  connected: { text: '已连接', icon: 'dot', kind: 'tone' },
  unsupported: { text: '待适配', icon: 'alert', kind: 'warn' },
  error: { text: '读取异常', icon: 'alert', kind: 'error' },
  authorizing: { text: '授权中', icon: 'dot', kind: 'neutral' },
  loading: { text: '连接中', icon: 'dot', kind: 'neutral' },
};

// waiting 态需要区分"待绑定/待连接"，所以把是否已绑定作为参数显式传入。
export function getStatusChip(status, bound) {
  if (status === 'waiting') {
    return { text: bound ? '待连接' : '待绑定', icon: 'dot', kind: 'neutral' };
  }
  return STATUS_CHIPS[status] || STATUS_CHIPS.loading;
}

export function normalizeOverlayVariant(value) {
  return value === 'compact' ? 'compact' : 'full';
}
