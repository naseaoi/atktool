const test = require('node:test');
const assert = require('node:assert/strict');
const { alphaBounds, renderAppIcon } = require('../scripts/generate-app-icon');

test('app icon covers the full square instead of only the first rows', () => {
  const bounds = alphaBounds(renderAppIcon());
  assert.deepEqual(bounds, { minX: 18, minY: 18, maxX: 493, maxY: 493 });
});
