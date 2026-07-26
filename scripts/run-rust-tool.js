const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readUserEnvironment(name) {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const result = spawnSync(
    'reg.exe',
    ['query', 'HKCU\\Environment', '/v', name],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    return undefined;
  }

  const linePattern = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'mi');
  return result.stdout.match(linePattern)?.[1]?.trim();
}

function resolveRustEnvironment() {
  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const cargoHomes = [process.env.CARGO_HOME, readUserEnvironment('CARGO_HOME')]
    .filter(Boolean);
  const rustupHomes = [process.env.RUSTUP_HOME, readUserEnvironment('RUSTUP_HOME')]
    .filter(Boolean);
  const cargoHome = cargoHomes.find((home) => fs.existsSync(path.join(home, 'bin', cargoName)))
    || cargoHomes[0];
  const rustupHome = rustupHomes.find((home) => fs.existsSync(home)) || rustupHomes[0];
  const environment = { ...process.env };
  const currentPath = Object.entries(environment)
    .find(([name]) => name.toLowerCase() === 'path')?.[1];

  for (const name of Object.keys(environment)) {
    if (['path', 'cargo_home', 'rustup_home'].includes(name.toLowerCase())) {
      delete environment[name];
    }
  }

  if (cargoHome) {
    environment.CARGO_HOME = cargoHome;
    environment.PATH = [path.join(cargoHome, 'bin'), currentPath]
      .filter(Boolean)
      .join(path.delimiter);
  } else if (currentPath) {
    environment.PATH = currentPath;
  }
  if (rustupHome) {
    environment.RUSTUP_HOME = rustupHome;
  }

  return { cargoHome, environment };
}

function resolveTool(tool, cargoHome) {
  if (tool === 'tauri') {
    return {
      command: process.execPath,
      arguments: [path.resolve('node_modules/@tauri-apps/cli/tauri.js')],
    };
  }

  if (tool === 'cargo') {
    const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
    const configuredCargo = cargoHome && path.join(cargoHome, 'bin', cargoName);
    return {
      command: configuredCargo && fs.existsSync(configuredCargo) ? configuredCargo : cargoName,
      arguments: [],
    };
  }

  throw new Error(`Unsupported Rust tool: ${tool || '(missing)'}`);
}

const [tool, ...toolArguments] = process.argv.slice(2);
const { cargoHome, environment } = resolveRustEnvironment();
const resolvedTool = resolveTool(tool, cargoHome);
const result = spawnSync(
  resolvedTool.command,
  [...resolvedTool.arguments, ...toolArguments],
  { env: environment, stdio: 'inherit', windowsHide: false },
);

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
