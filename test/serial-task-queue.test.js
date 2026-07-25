const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerialTaskQueue } = require('../src/utils/serial-task-queue');

test('serial task queue runs tasks in arrival order', async () => {
  const enqueue = createSerialTaskQueue();
  const events = [];
  let releaseFirst = null;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const second = enqueue(async () => {
    events.push('second');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('serial task queue continues after a rejected task', async () => {
  const enqueue = createSerialTaskQueue();
  const failed = enqueue(async () => {
    throw new Error('expected');
  });
  const succeeded = enqueue(async () => 'ok');

  await assert.rejects(failed, /expected/);
  assert.equal(await succeeded, 'ok');
});
