import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlaylistUrl, sanitizeFolderName, randomSongFolderName } from './utils.js';

const jobs = new Map();
const outputRoot = process.env.YTDLP_OUTPUT_ROOT || path.resolve(process.cwd(), 'output');

function resolveDenoPath() {
  const fromEnv = process.env.DENO_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  return path.resolve(process.cwd(), 'runtime', 'deno', 'bin', exe);
}

async function ensureOutputRoot() {
  await fs.mkdir(outputRoot, { recursive: true });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function listDownloadedFiles(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function getPlaylistFolderName(url, denoPath) {
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--skip-download',
    '--ignore-errors',
    '--yes-playlist',
    '--js-runtimes',
    `deno:${denoPath}`,
    url
  ];

  const { stdout } = await runCommand('yt-dlp', args);
  const parsed = JSON.parse(stdout);
  return sanitizeFolderName(parsed.title || 'playlist');
}

function newJob(url) {
  const id = randomSongFolderName();
  const now = new Date().toISOString();
  const job = {
    id,
    url,
    isPlaylist: isPlaylistUrl(url),
    status: 'queued',
    error: null,
    folderName: null,
    outputDir: null,
    files: [],
    createdAt: now,
    updatedAt: now,
    command: null
  };

  jobs.set(id, job);
  return job;
}

async function executeJob(job) {
  const denoPath = resolveDenoPath();

  job.status = 'running';
  job.updatedAt = new Date().toISOString();

  const folderName = job.isPlaylist
    ? await getPlaylistFolderName(job.url, denoPath).catch(() => randomSongFolderName())
    : randomSongFolderName();

  job.folderName = folderName;
  job.outputDir = path.join(outputRoot, folderName);

  await fs.mkdir(job.outputDir, { recursive: true });

  const args = [
    '--ignore-errors',
    '--format',
    'bestaudio',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '160K',
    '--js-runtimes',
    `deno:${denoPath}`,
    '--output',
    path.join(job.outputDir, '%(title)s.%(ext)s')
  ];

  args.push(job.isPlaylist ? '--yes-playlist' : '--no-playlist');
  args.push(job.url);

  job.command = `yt-dlp ${args.map((value) => (value.includes(' ') ? `"${value}"` : value)).join(' ')}`;

  try {
    await runCommand('yt-dlp', args);
    job.files = await listDownloadedFiles(job.outputDir);
    job.status = 'completed';
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.files = await listDownloadedFiles(job.outputDir);
  }

  job.updatedAt = new Date().toISOString();
}

export async function createJob(url) {
  await ensureOutputRoot();
  const job = newJob(url);
  executeJob(job).catch((error) => {
    job.status = 'failed';
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
  });
  return job;
}

export function getJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id) {
  return jobs.get(id);
}

export function getFilePath(job, fileName) {
  return path.resolve(job.outputDir, fileName);
}

export function isFileInsideJobFolder(job, filePath) {
  const relative = path.relative(job.outputDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
