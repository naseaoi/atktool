const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeErrors } = require('../src/utils/error-summary');

test('error summary deduplicates and counts omitted candidates', () => {
  assert.equal(
    summarizeErrors(['timeout', 'timeout', 'denied', 'offline'], { maxItems: 2 }),
    'timeout | denied | 另有 2 个候选错误'
  );
});

test('error summary enforces its maximum length', () => {
  const summary = summarizeErrors(['a'.repeat(100)], { maxLength: 32 });
  assert.equal(summary.length, 32);
  assert.match(summary, /<truncated>$/);
  assert.equal(summarizeErrors(['too long'], { maxLength: 3 }), '...');
});
