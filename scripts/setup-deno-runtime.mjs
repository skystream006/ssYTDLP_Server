import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = process.cwd();
const installRoot = path.resolve(projectRoot, 'runtime', 'deno');
const denoBinary = process.platform === 'win32'
  ? path.join(installRoot, 'bin', 'deno.exe')
  : path.join(installRoot, 'bin', 'deno');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

await fs.mkdir(path.dirname(denoBinary), { recursive: true });

if (await exists(denoBinary)) {
  console.log(`Deno runtime already installed at ${denoBinary}`);
  process.exit(0);
}

if (process.platform === 'win32') {
  console.log('Run the following command in PowerShell to install Deno into the project runtime folder:');
  console.log(`$env:DENO_INSTALL='${installRoot}'; iwr https://deno.land/install.ps1 -useb | iex`);
  process.exit(1);
}

await run('sh', ['-c', 'curl -fsSL https://deno.land/install.sh | sh'], {
  env: { ...process.env, DENO_INSTALL: installRoot }
});

console.log(`Deno runtime installed at ${denoBinary}`);
