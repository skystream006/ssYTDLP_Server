import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const installRoot = path.resolve(projectRoot, 'runtime', 'yt-dlp');
const executablePath = path.join(installRoot, 'yt-dlp.exe');
const downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

await fs.mkdir(installRoot, { recursive: true });

if (await exists(executablePath)) {
  console.log(`yt-dlp runtime already installed at ${executablePath}`);
  process.exit(0);
}

const temporaryPath = `${executablePath}.download`;

try {
  console.log(`Downloading yt-dlp from ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await fs.writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await fs.rename(temporaryPath, executablePath);
  console.log(`yt-dlp runtime installed at ${executablePath}`);
} catch (error) {
  await fs.rm(temporaryPath, { force: true });
  throw error;
}