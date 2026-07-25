const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLogFileWriter } = require('../src/utils/log-file-writer');

async function createTestDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atktool-log-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('log file writer preserves write order', async (t) => {
  const directory = await createTestDirectory(t);
  const writer = createLogFileWriter({
    directory,
    fileName: 'runtime.log',
    maxBytes: 1_024,
    maxArchives: 2,
  });

  await Promise.all([
    writer.write('first\n'),
    writer.write('second\n'),
    writer.write('third\n'),
  ]);

  const content = await fs.readFile(writer.filePath, 'utf8');
  assert.equal(content, 'first\nsecond\nthird\n');
});

test('log file writer rotates and prunes archives', async (t) => {
  const directory = await createTestDirectory(t);
  const writer = createLogFileWriter({
    directory,
    fileName: 'runtime.log',
    maxBytes: 12,
    maxArchives: 2,
  });

  await writer.write('11111111');
  await writer.write('22222222');
  await writer.write('33333333');
  await writer.write('44444444');

  const fileNames = await fs.readdir(directory);
  const archives = fileNames.filter((fileName) => fileName.startsWith('runtime.archive-'));
  assert.equal(archives.length, 2);
  assert.equal(await fs.readFile(writer.filePath, 'utf8'), '44444444');
});

test('log file writer validates its target boundary', () => {
  assert.throws(() => createLogFileWriter({
    directory: path.resolve('.'),
    fileName: '../runtime.log',
    maxBytes: 1,
    maxArchives: 1,
  }), /file name must not contain a path/);
});
