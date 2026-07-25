const fs = require('node:fs/promises');
const path = require('node:path');

function validateOptions({ directory, fileName, maxBytes, maxArchives }) {
  if (!path.isAbsolute(directory)) {
    throw new TypeError('log directory must be absolute');
  }

  if (!fileName || path.basename(fileName) !== fileName) {
    throw new TypeError('log file name must not contain a path');
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive integer');
  }

  if (!Number.isSafeInteger(maxArchives) || maxArchives < 0) {
    throw new TypeError('maxArchives must be a non-negative integer');
  }
}

function isMissingFileError(error) {
  return error?.code === 'ENOENT';
}

function createLogFileWriter(options) {
  const {
    directory,
    fileName,
    maxBytes,
    maxArchives,
    onError = () => {},
  } = options;

  validateOptions({ directory, fileName, maxBytes, maxArchives });

  const filePath = path.join(directory, fileName);
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  const archivePrefix = `${baseName}.archive-`;
  let archiveSequence = 0;
  let pendingWrite = Promise.resolve();

  function createArchivePath() {
    archiveSequence += 1;
    const archiveName = `${archivePrefix}${Date.now()}-${process.pid}-${archiveSequence}${extension}`;
    return path.join(directory, archiveName);
  }

  async function pruneArchives() {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const archives = entries
      .filter((entry) => entry.isFile()
        && entry.name.startsWith(archivePrefix)
        && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en'));

    const expiredArchives = archives.slice(maxArchives);
    await Promise.all(expiredArchives.map(async (archiveName) => {
      try {
        await fs.unlink(path.join(directory, archiveName));
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }));
  }

  async function rotateIfNeeded(incomingBytes) {
    let currentSize = 0;

    try {
      currentSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    if (currentSize === 0 || currentSize + incomingBytes <= maxBytes) {
      return;
    }

    if (maxArchives === 0) {
      await fs.truncate(filePath, 0);
      return;
    }

    try {
      await fs.rename(filePath, createArchivePath());
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await pruneArchives();
  }

  async function append(payload) {
    await fs.mkdir(directory, { recursive: true });
    await rotateIfNeeded(Buffer.byteLength(payload, 'utf8'));
    await fs.appendFile(filePath, payload, 'utf8');
  }

  function write(payload) {
    const normalizedPayload = String(payload);
    pendingWrite = pendingWrite
      .then(() => append(normalizedPayload))
      .catch((error) => {
        onError(error);
      });
    return pendingWrite;
  }

  return {
    filePath,
    write,
    flush() {
      return pendingWrite;
    },
  };
}

module.exports = {
  createLogFileWriter,
};
