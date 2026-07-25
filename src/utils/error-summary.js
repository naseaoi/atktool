function normalizeErrorMessage(value) {
  if (value instanceof Error) {
    return value.message.trim();
  }

  return typeof value === 'string' ? value.trim() : '';
}

function summarizeErrors(values, options = {}) {
  const maxItems = Number.isSafeInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 4;
  const maxLength = Number.isSafeInteger(options.maxLength) && options.maxLength > 0 ? options.maxLength : 2_048;
  const messages = (Array.isArray(values) ? values : [])
    .map(normalizeErrorMessage)
    .filter(Boolean);
  const uniqueMessages = [...new Set(messages)];
  const selectedMessages = uniqueMessages.slice(0, maxItems);
  const omittedCount = Math.max(0, messages.length - selectedMessages.length);
  const suffix = omittedCount > 0 ? ` | 另有 ${omittedCount} 个候选错误` : '';
  const summary = `${selectedMessages.join(' | ')}${suffix}`;

  if (summary.length <= maxLength) {
    return summary;
  }

  const truncationMarker = '...<truncated>';
  if (maxLength <= truncationMarker.length) {
    return truncationMarker.slice(0, maxLength);
  }

  return `${summary.slice(0, Math.max(0, maxLength - truncationMarker.length))}${truncationMarker}`;
}

module.exports = {
  summarizeErrors,
};
