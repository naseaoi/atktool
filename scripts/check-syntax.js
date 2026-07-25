const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_DIRECTORIES = ['src', 'scripts', 'test'];

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function checkFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const isModule = /^\s*(?:import|export)\b/m.test(source);
  const result = isModule
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });

  if (result.status !== 0) {
    process.stderr.write(`${filePath}\n${result.stderr || result.stdout}`);
    return false;
  }

  return true;
}

const files = SOURCE_DIRECTORIES.flatMap((directory) => listJavaScriptFiles(path.resolve(directory)));
const failedFiles = files.filter((filePath) => !checkFile(filePath));

if (failedFiles.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax OK: ${files.length} JavaScript files\n`);
}
